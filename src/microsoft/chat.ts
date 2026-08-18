import type {
  ChatApi,
  ChatAttachmentRef,
  ChatMessageSummary,
  ChatParticipant,
  ChatSummary,
  OutgoingChatMessage,
} from '../chat/types.js';
import { htmlToText } from '../html.js';
import { ServiceError } from '../serviceError.js';
import type { Graph } from './graph.js';

interface GraphConversationMember {
  '@odata.type'?: string;
  id?: string;
  displayName?: string | null;
  email?: string | null;
  userId?: string | null;
  tenantId?: string | null;
}

interface GraphChat {
  id: string;
  topic?: string | null;
  chatType?: string | null;
  createdDateTime?: string | null;
  lastUpdatedDateTime?: string | null;
  webUrl?: string | null;
  members?: GraphConversationMember[] | null;
  lastMessagePreview?: {
    body?: { content?: string | null; contentType?: string | null } | null;
    createdDateTime?: string | null;
    from?: GraphIdentitySet | null;
  } | null;
}

interface GraphIdentitySet {
  user?: { displayName?: string | null; id?: string | null; tenantId?: string | null } | null;
  application?: { displayName?: string | null } | null;
  device?: { displayName?: string | null } | null;
}

interface GraphChatMessage {
  id: string;
  chatId?: string | null;
  messageType?: string | null;
  createdDateTime?: string | null;
  lastEditedDateTime?: string | null;
  deletedDateTime?: string | null;
  from?: GraphIdentitySet | null;
  body?: { contentType?: string | null; content?: string | null } | null;
  attachments?: Array<{
    id?: string;
    name?: string | null;
    contentType?: string | null;
    contentUrl?: string | null;
  }> | null;
  mentions?: Array<{ mentionText?: string | null }> | null;
  eventDetail?: unknown;
}

const CHAT_SELECT = 'id,topic,chatType,createdDateTime,lastUpdatedDateTime,webUrl';

function isAadMember(member: GraphConversationMember): boolean {
  return (member['@odata.type'] ?? '').includes('aadUserConversationMember');
}

/**
 * Whether a chat participant is outside the account's organisation.
 *
 * Unknowns count as outside. That is the whole point of the flag: it exists so
 * an agent knows to ask before a reply leaves the organisation, and a flag that
 * defaults to "safe" when it cannot tell would fail exactly when it matters.
 */
function isExternalMember(
  member: GraphConversationMember,
  homeTenant: string | null,
): boolean {
  // Apps, bots and anonymous meeting participants are not directory users, and
  // none of them is inside the organisation.
  if (!isAadMember(member)) return true;
  if (homeTenant === null || !member.tenantId) return true;
  return member.tenantId !== homeTenant;
}

export function microsoftChatApi(graph: Graph, accountEmail: string): ChatApi {
  /**
   * Turns Graph's members into participants, working out who is external.
   *
   * The account's own tenant is not stored anywhere, so it is derived from the
   * member that is us: whichever tenant we are in is the inside, and a member
   * from any other tenant is a guest or a federated contact. That avoids having
   * to keep a tenant id in the database just to answer this question.
   */
  function toParticipants(members: GraphConversationMember[]): ChatParticipant[] {
    const self = members.find(
      (m) => (m.email ?? '').toLowerCase() === accountEmail.toLowerCase(),
    );
    const homeTenant = self?.tenantId ?? null;

    return members.map((member) => {
      const email = member.email ?? null;
      const isSelf = (email ?? '').toLowerCase() === accountEmail.toLowerCase();
      return {
        displayName: member.displayName ?? email ?? '(unknown participant)',
        email,
        isExternal: isSelf ? false : isExternalMember(member, homeTenant),
        isSelf,
      };
    });
  }

  function toChatSummary(chat: GraphChat): ChatSummary {
    const participants = toParticipants(chat.members ?? []);
    const preview = chat.lastMessagePreview?.body;
    const previewText = preview?.content
      ? ((preview.contentType ?? '').toLowerCase() === 'html'
          ? htmlToText(preview.content)
          : preview.content
        )
          .split('\n')[0]
          ?.slice(0, 200) ?? null
      : null;

    return {
      id: chat.id,
      topic: chat.topic ?? null,
      chatType: chat.chatType ?? 'unknown',
      lastUpdated: chat.lastUpdatedDateTime ?? chat.createdDateTime ?? null,
      webUrl: chat.webUrl ?? null,
      participants,
      isExternal: participants.some((p) => p.isExternal),
      externalParticipants: participants
        .filter((p) => p.isExternal)
        .map((p) => (p.email ? `${p.displayName} <${p.email}>` : p.displayName)),
      lastMessagePreview: previewText,
    };
  }

  function senderOf(from: GraphIdentitySet | null | undefined): {
    name: string;
    email: string | null;
  } {
    if (from?.user) {
      return { name: from.user.displayName ?? '(unknown sender)', email: null };
    }
    if (from?.application) {
      return { name: `${from.application.displayName ?? 'app'} (app)`, email: null };
    }
    return { name: '(system)', email: null };
  }

  function toMessageSummary(msg: GraphChatMessage, chatId: string): ChatMessageSummary {
    const isHtml = (msg.body?.contentType ?? '').toLowerCase() === 'html';
    const raw = msg.body?.content ?? '';
    const sender = senderOf(msg.from);

    const attachments: ChatAttachmentRef[] = (msg.attachments ?? []).map((a) => ({
      name: a.name ?? 'attachment',
      contentType: a.contentType ?? null,
      url: a.contentUrl ?? null,
    }));

    return {
      id: msg.id,
      chatId: msg.chatId ?? chatId,
      from: sender.name,
      fromEmail: sender.email,
      createdAt: msg.createdDateTime ?? '',
      lastEditedAt: msg.lastEditedDateTime ?? null,
      bodyText: isHtml ? htmlToText(raw) : raw.trim(),
      bodyIsHtmlFallback: isHtml,
      mentions: (msg.mentions ?? [])
        .map((m) => m.mentionText ?? '')
        .filter((text): text is string => text.length > 0),
      attachments,
      isDeleted: !!msg.deletedDateTime,
      // systemEventMessage covers "X added Y", renames and call summaries. They
      // are noise in a conversation but removing them would hide why a stranger
      // suddenly appears in it.
      isSystemEvent: (msg.messageType ?? 'message') !== 'message',
    };
  }

  return {
    provider: 'microsoft',
    accountEmail,

    async listChats(limit) {
      // members and lastMessagePreview are expanded here because both are needed
      // to make a chat recognisable, and neither is available on the chat itself.
      const chats = await graph.getAll<GraphChat>(
        `/me/chats?$select=${CHAT_SELECT}&$expand=members,lastMessagePreview&$top=${Math.min(limit, 50)}`,
        limit,
      );

      return chats
        .map(toChatSummary)
        .sort((a, b) => (b.lastUpdated ?? '').localeCompare(a.lastUpdated ?? ''))
        .slice(0, limit);
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
            'is not something Teams offers.',
        );
      }

      const oneOnOne = others.length === 1;

      if (oneOnOne && topic) {
        throw new ServiceError(
          'A one-to-one chat cannot be given a topic; Teams names it after the other person. ' +
            'Add a second participant if you want a named group chat.',
        );
      }

      const member = (email: string) => ({
        '@odata.type': '#microsoft.graph.aadUserConversationMember',
        roles: ['owner'],
        'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${email}')`,
      });

      const existingBefore = oneOnOne
        ? (await this.listChats(50)).find(
            (chat) =>
              chat.chatType === 'oneOnOne' &&
              chat.participants.some((p) => !p.isSelf && p.email?.toLowerCase() === others[0]),
          )
        : undefined;

      const created = await graph.post<GraphChat>('/chats', {
        chatType: oneOnOne ? 'oneOnOne' : 'group',
        ...(topic ? { topic } : {}),
        members: [member(accountEmail), ...others.map(member)],
      });

      return {
        chat: await this.getChat(created.id),
        // Teams allows exactly one one-to-one chat per pair, so asking for one
        // that exists hands back the existing conversation with its history
        // rather than making a second. Group chats have no such rule: every
        // call really does make another one.
        alreadyExisted: !!existingBefore && existingBefore.id === created.id,
      };
    },

    async getChat(chatId) {
      const chat = await graph.get<GraphChat>(
        `/chats/${encodeURIComponent(chatId)}?$select=${CHAT_SELECT}&$expand=members,lastMessagePreview`,
      );
      return toChatSummary(chat);
    },

    async listMessages(chatId, limit) {
      // Graph returns chat messages newest-first, which is what we want to page
      // through; presenting them is the other way round, so an exchange reads.
      const messages = await graph.getAll<GraphChatMessage>(
        `/chats/${encodeURIComponent(chatId)}/messages?$top=${Math.min(limit, 50)}`,
        limit,
      );

      return messages
        .map((m) => toMessageSummary(m, chatId))
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    },

    async sendMessage(chatId, message: OutgoingChatMessage) {
      if (!message.body.trim()) {
        throw new ServiceError('Refusing to post an empty chat message.');
      }

      const sent = await graph.post<GraphChatMessage>(
        `/chats/${encodeURIComponent(chatId)}/messages`,
        {
          body: message.isHtml
            ? { contentType: 'html', content: message.body }
            : { contentType: 'text', content: message.body },
        },
      );

      return { id: sent.id, createdAt: sent.createdDateTime ?? '' };
    },
  };
}
