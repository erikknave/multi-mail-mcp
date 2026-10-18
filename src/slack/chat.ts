import type {
  ChatApi,
  ChatAttachmentRef,
  ChatMessageSummary,
  ChatParticipant,
  ChatSummary,
  OutgoingChatMessage,
} from '../chat/types.js';
import { ServiceError } from '../serviceError.js';
import type { SlackWeb } from './web.js';

interface SlackConversation {
  id: string;
  name?: string;
  is_im?: boolean;
  is_mpim?: boolean;
  is_channel?: boolean;
  is_group?: boolean;
  /** A Slack Connect conversation, shared with an outside organisation. */
  is_ext_shared?: boolean;
  /** The other member, present on im conversations. */
  user?: string;
  created?: number;
  /** Channels and mpims carry `updated`; ims do not. Unix seconds. */
  updated?: number;
}

interface SlackFile {
  name?: string;
  mimetype?: string | null;
  permalink?: string | null;
}

interface SlackMessage {
  /** Slack's message id: seconds.microseconds since the epoch, as a string. */
  ts: string;
  /** Set when this message is a thread parent or a reply inside one. */
  thread_ts?: string;
  reply_count?: number;
  text?: string;
  user?: string;
  bot_id?: string;
  /** The display name a bot posted under, when it set one. */
  username?: string;
  subtype?: string;
  edited?: { ts?: string };
  files?: SlackFile[];
}

interface SlackUser {
  id: string;
  real_name?: string | null;
  profile?: { display_name?: string | null; email?: string | null; real_name?: string | null };
}

/** Per-thread ceiling on fetched replies; parents say when more exist. */
const REPLY_CAP = 20;

/** Slack caps a group DM at 9 participants; the connected account takes one. */
const MAX_OTHER_PARTICIPANTS = 7;

/** Subtypes that carry real content rather than narrating channel events. */
const CONTENT_SUBTYPES = new Set(['file_share', 'bot_message', 'thread_broadcast']);

function tsToIso(ts: string): string {
  return new Date(Number(ts) * 1000).toISOString();
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.slice(0, 200) ?? '';
}

/** Runs tasks with a fixed number in flight, for Slack's per-method rate tiers. */
async function pooled<T>(items: T[], width: number, task: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(width, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++]!;
      await task(item);
    }
  });
  await Promise.all(workers);
}

export function slackChatApi(web: SlackWeb, accountEmail: string): ChatApi {
  const userCache = new Map<string, ChatParticipant | null>();

  /**
   * Resolves a member id to a participant. Slack names arrive through this one
   * path — senders, DM counterparts, @-mentions — so one cache serves all of
   * them and a failed lookup degrades to a placeholder rather than taking the
   * whole list down with it.
   */
  async function participantFor(userId: string): Promise<ChatParticipant | null> {
    if (userCache.has(userId)) return userCache.get(userId) ?? null;

    let participant: ChatParticipant | null = null;
    try {
      const info = await web.get<{ ok?: boolean; user?: SlackUser }>('users.info', { user: userId });
      if (info.ok && info.user) {
        const u = info.user;
        const displayName = u.real_name || u.profile?.display_name || u.profile?.real_name || '(unknown user)';
        const email = u.profile?.email ?? null;
        participant = {
          displayName,
          email,
          isSelf: !!email && email.toLowerCase() === accountEmail.toLowerCase(),
          // Everyone reached through this token is in the connected account's
          // workspace; Slack Connect externalness is flagged on the
          // conversation instead, where Slack actually reports it.
          isExternal: false,
        };
      }
    } catch {
      // Leave the placeholder; the cache remembers the miss so we do not ask
      // again for the same unknown member within this api instance.
    }
    userCache.set(userId, participant);
    return participant;
  }

  async function conversationParticipants(conv: SlackConversation): Promise<ChatParticipant[]> {
    if (conv.is_im && conv.user) {
      const other = await participantFor(conv.user);
      return other ? [other] : [];
    }
    if (conv.is_mpim) {
      const members = await web.getAll<string>('conversations.members', { channel: conv.id }, 50, 'members');
      const resolved = await Promise.all(members.map(participantFor));
      return resolved.filter((p): p is ChatParticipant => p !== null);
    }
    // Channels: the name is the identity and everyone in the workspace may be
    // in one, so a member list would be an unbounded fan-out for no decision
    // the agent needs to make. Documented in the tool description, not dropped
    // silently.
    return [];
  }

  function toChatSummary(
    conv: SlackConversation,
    participants: ChatParticipant[],
    preview: string | null,
    lastUpdated: string | null,
  ): ChatSummary {
    return {
      id: conv.id,
      // An mpim's machine name ("mpdm-erik--anna--1") is noise; its members
      // are its identity. ims are never named at all.
      topic: conv.is_im || conv.is_mpim ? null : (conv.name ?? null),
      chatType: conv.is_im ? 'oneOnOne' : conv.is_mpim ? 'group' : 'channel',
      lastUpdated,
      // Slack conversations carry no URL in their payloads, and DMs have no
      // permalink at all; handing one over is not something v1 can do honestly.
      webUrl: null,
      participants,
      // is_ext_shared is Slack Connect: the conversation is shared with an
      // outside organisation. Which organisations cannot be named without
      // member calls we deliberately do not make; the flag alone still makes
      // an agent pause before saying something internal.
      isExternal: !!conv.is_ext_shared,
      externalParticipants: [],
      lastMessagePreview: preview,
    };
  }

  /**
   * One history message, for a preview and an honest lastUpdated. Conversations
   * sort by it afterwards, because Slack's own ordering of conversations.list
   * is relevance-shaped, not recency-shaped. A failed probe degrades that one
   * conversation to its metadata timestamp — it never fails the listing.
   */
  async function probeConversation(conv: SlackConversation): Promise<{
    preview: string | null;
    lastUpdated: string | null;
  }> {
    const fallback =
      (conv.updated ? new Date(conv.updated * 1000).toISOString() : null) ??
      (conv.created ? new Date(conv.created * 1000).toISOString() : null);

    try {
      const history = await web.get<{ messages?: SlackMessage[] }>('conversations.history', {
        channel: conv.id,
        limit: 1,
      });
      const latest = history.messages?.[0];
      if (!latest) return { preview: null, lastUpdated: fallback };
      return {
        preview: latest.text ? firstLine(latest.text) : null,
        lastUpdated: tsToIso(latest.ts),
      };
    } catch {
      return { preview: null, lastUpdated: fallback };
    }
  }

  async function buildSummary(conv: SlackConversation): Promise<ChatSummary> {
    const [participants, probe] = await Promise.all([
      conversationParticipants(conv),
      probeConversation(conv),
    ]);
    return toChatSummary(conv, participants, probe.preview, probe.lastUpdated);
  }

  async function senderOf(msg: SlackMessage): Promise<{ name: string; email: string | null }> {
    if (msg.user) {
      const participant = await participantFor(msg.user);
      if (participant) return { name: participant.displayName, email: participant.email };
      return { name: '(unknown sender)', email: null };
    }
    if (msg.bot_id) {
      // No bots:read scope by design; the name the bot posted under, when it
      // set one, is all there is to show.
      return { name: msg.username ? `${msg.username} (app)` : '(app)', email: null };
    }
    return { name: '(system)', email: null };
  }

  /** Resolves <@U…> references in a body to names the reader recognises. */
  async function mentionsOf(msg: SlackMessage): Promise<string[]> {
    // The capture group always participates when the pattern matches.
    const ids = [...(msg.text ?? '').matchAll(/<@([A-Z0-9]+)>/g)].map((m) => m[1]!);
    const unique = [...new Set(ids)];
    return Promise.all(
      unique.map(async (id) => {
        const participant = await participantFor(id);
        return participant?.displayName ?? id;
      }),
    );
  }

  function attachmentsOf(msg: SlackMessage): ChatAttachmentRef[] {
    // Permalinks only, no files:read: like Teams attachments, these are links
    // to hand to the user, not bytes this server streams.
    return (msg.files ?? []).map((f) => ({
      name: f.name ?? 'file',
      contentType: f.mimetype ?? null,
      url: f.permalink ?? null,
    }));
  }

  async function toMessageSummary(msg: SlackMessage, chatId: string): Promise<ChatMessageSummary> {
    const sender = await senderOf(msg);
    return {
      id: msg.ts,
      chatId,
      from: sender.name,
      fromEmail: sender.email,
      createdAt: tsToIso(msg.ts),
      lastEditedAt: msg.edited?.ts ? tsToIso(msg.edited.ts) : null,
      // Slack bodies are mrkdwn, which reads as prose on its own.
      bodyText: (msg.text ?? '').trim(),
      bodyIsHtmlFallback: false,
      mentions: await mentionsOf(msg),
      attachments: attachmentsOf(msg),
      // Slack does not return deleted messages from history at all, so there
      // is no way for this to be true — recorded here so nobody hunts for the
      // missing branch.
      isDeleted: false,
      // channel_join and friends narrate the channel rather than saying
      // anything; kept, but flagged, exactly as Teams system events are.
      isSystemEvent: !!msg.subtype && !CONTENT_SUBTYPES.has(msg.subtype),
    };
  }

  /**
   * Sends a message that carries files, as Slack wants it done since the 2024
   * deprecation of files.upload: reserve a presigned URL per file
   * (files.getUploadURLExternal, which is what needs files:write), POST the
   * bytes there, then files.completeUploadExternal shares them into the
   * conversation with the body as the accompanying comment — one message, not
   * a text message plus loose files.
   */
  async function sendWithFiles(
    chatId: string,
    message: OutgoingChatMessage,
    files: NonNullable<OutgoingChatMessage['attachments']>,
  ): Promise<{ id: string; createdAt: string }> {
    const handles: Array<{ id: string; title: string }> = [];

    for (const file of files) {
      const slot = await web.get<{ ok?: boolean; upload_url?: string; file_id?: string }>(
        'files.getUploadURLExternal',
        { filename: file.filename, length: file.content.length },
      );
      if (!slot.upload_url || !slot.file_id) {
        throw new ServiceError(`Slack returned no upload slot for ${file.filename}.`);
      }

      // The presigned URL is not a Web API method: no auth header, no ok-body
      // envelope — a plain POST of the bytes, judged by HTTP status alone.
      const put = await fetch(slot.upload_url, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: new Uint8Array(file.content),
      });
      if (!put.ok) {
        throw new ServiceError(
          `Uploading ${file.filename} to Slack failed with HTTP ${put.status}.`,
        );
      }

      handles.push({ id: slot.file_id, title: file.filename });
    }

    // Floor for the fallback below: the share's ts can only be later than
    // this. Generous skew, since Slack stamps with its clock, not ours.
    const notBefore = Date.now() / 1000 - 30;

    const completed = await web.post<{
      ok?: boolean;
      files?: Array<{
        id?: string;
        shares?: Record<string, Record<string, Array<{ ts?: string }>>>;
      }>;
    }>('files.completeUploadExternal', {
      files: handles,
      channel_id: chatId,
      ...(message.body.trim() ? { initial_comment: message.body } : {}),
      ...(message.threadParentId ? { thread_ts: message.threadParentId } : {}),
    });

    // The share lands as a message, but its ts is buried (and often not yet
    // present — verified live) in shares.{public|private}.{channel}[0].ts.
    let ts = (completed.files ?? [])
      .flatMap((f) => Object.values(f.shares ?? {}))
      .flatMap((byChannel) => byChannel[chatId] ?? [])
      .map((share) => share.ts)
      .find((value): value is string => !!value);

    // Fallback: read the newest message back. The share takes a moment to
    // appear in history (verified live: the first read returned the PREVIOUS
    // message), so poll briefly and accept only a ts from after this send —
    // handing back some older message's id would be worse than handing back
    // none. Best effort throughout: an empty id still means "sent".
    for (let attempt = 0; !ts && attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 600));
      try {
        const history = await web.get<{ messages?: SlackMessage[] }>('conversations.history', {
          channel: chatId,
          limit: 1,
        });
        const latest = history.messages?.[0]?.ts;
        if (latest && Number(latest) >= notBefore) ts = latest;
      } catch {
        break; // the upload already succeeded; reporting it matters more than the id
      }
    }

    return { id: ts ?? '', createdAt: ts ? tsToIso(ts) : '' };
  }

  return {
    provider: 'slack',
    accountEmail,

    async listChats(limit) {
      // types must always be passed: Slack's default is public channels only,
      // which would quietly hide every DM.
      const conversations = await web.getAll<SlackConversation>(
        'conversations.list',
        { types: 'public_channel,private_channel,im,mpim', exclude_archived: true, limit: 200 },
        limit,
        'channels',
      );

      const summaries: ChatSummary[] = [];
      await pooled(conversations, 4, async (conv) => {
        summaries.push(await buildSummary(conv));
      });

      return summaries.sort((a, b) =>
        (b.lastUpdated ?? '').localeCompare(a.lastUpdated ?? ''),
      );
    },

    async createChat(participantEmails, topic) {
      const others = [
        ...new Set(
          participantEmails
            .map((email) => email.trim().toLowerCase())
            .filter((email) => email && email !== accountEmail.toLowerCase()),
        ),
      ];

      if (others.length === 0) {
        throw new ServiceError(
          'Name at least one other person to start a chat with. A chat with only yourself ' +
            'is not something Slack offers.',
        );
      }

      if (topic) {
        throw new ServiceError(
          'Slack names group DMs itself; a topic cannot be set. Create it without a topic, ' +
            'or rename it in Slack.',
        );
      }

      if (others.length > MAX_OTHER_PARTICIPANTS) {
        throw new ServiceError(
          `Slack caps a group DM at ${MAX_OTHER_PARTICIPANTS + 1} people including you; ` +
            `${others.length} others were named.`,
        );
      }

      const ids: string[] = [];
      for (const email of others) {
        const lookup = await web.get<{ ok?: boolean; user?: { id?: string }; error?: string }>(
          'users.lookupByEmail',
          { email },
        );
        if (!lookup.ok || !lookup.user?.id) {
          throw new ServiceError(
            `No Slack member with the address ${email} exists in this workspace.`,
          );
        }
        ids.push(lookup.user.id);
      }

      const opened = await web.post<{
        ok?: boolean;
        no_op?: boolean;
        already_open?: boolean;
        channel?: SlackConversation;
      }>('conversations.open', { users: ids.join(','), return_im: true });

      if (!opened.channel) {
        throw new ServiceError('Slack opened the conversation but returned no channel.');
      }

      return {
        chat: await buildSummary(opened.channel),
        // conversations.open is idempotent: asking for a DM (or group DM)
        // that exists returns it rather than making a second — no pre-check
        // needed, unlike Teams group chats.
        alreadyExisted: !!(opened.no_op || opened.already_open),
      };
    },

    async getChat(chatId) {
      const info = await web.get<{ ok?: boolean; channel?: SlackConversation }>(
        'conversations.info',
        { channel: chatId },
      );
      if (!info.ok || !info.channel) {
        throw new ServiceError(`Slack has no conversation ${chatId}.`);
      }
      return buildSummary(info.channel);
    },

    async listMessages(chatId, limit) {
      const history = await web.getAll<SlackMessage>(
        'conversations.history',
        { channel: chatId, limit: Math.min(limit, 200) },
        limit,
        'messages',
      );

      // Slack returns newest-first; presenting them is the other way round, so
      // an exchange reads in order.
      const oldestFirst = [...history].reverse();

      const out: ChatMessageSummary[] = [];
      for (const msg of oldestFirst) {
        const summary = await toMessageSummary(msg, chatId);

        const isThreadParent = msg.thread_ts === msg.ts;
        if (isThreadParent && (msg.reply_count ?? 0) > 0) {
          // History shows only the parent; the replies live behind
          // conversations.replies. Leaving them out would be a silent hole in
          // what read_chat claims to show, so they are fetched and flattened
          // in place, and truncation is said out loud on the parent.
          const replies = await web.getAll<SlackMessage>(
            'conversations.replies',
            { channel: chatId, ts: msg.ts, limit: REPLY_CAP },
            REPLY_CAP + 1,
            'messages',
          );
          const actual = replies.filter((r) => r.ts !== msg.ts);
          summary.replyCount = msg.reply_count;
          if (actual.length < (msg.reply_count ?? 0)) summary.threadTruncated = true;
          out.push(summary);
          for (const reply of actual) {
            const replySummary = await toMessageSummary(reply, chatId);
            replySummary.inThreadOf = msg.ts;
            out.push(replySummary);
          }
        } else {
          out.push(summary);
        }
      }

      return out;
    },

    async sendMessage(chatId, message: OutgoingChatMessage) {
      const files = message.attachments ?? [];

      if (!message.body.trim() && files.length === 0) {
        throw new ServiceError('Refusing to post an empty chat message.');
      }

      if (message.isHtml) {
        throw new ServiceError(
          'Slack messages are mrkdwn, not HTML — converting would silently drop link targets ' +
            'and formatting. Send the body as plain text or mrkdwn instead.',
        );
      }

      if (files.length > 0) {
        return sendWithFiles(chatId, message, files);
      }

      // A user token posts as the member who authorised it; there is no
      // as_user to pass (that is legacy-apps-only).
      const sent = await web.post<{ ok?: boolean; ts?: string }>('chat.postMessage', {
        channel: chatId,
        text: message.body,
        ...(message.threadParentId ? { thread_ts: message.threadParentId } : {}),
      });

      return { id: sent.ts ?? '', createdAt: sent.ts ? tsToIso(sent.ts) : '' };
    },
  };
}
