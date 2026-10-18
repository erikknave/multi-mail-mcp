import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { User } from '../../db/repo.js';
import type { OutgoingChatAttachment } from '../../chat/types.js';
import { ReauthRequiredError } from '../../oauth/errors.js';
import { hasCapability, providerSupports } from '../../oauth/capabilities.js';
import { capabilityLabel, PROVIDERS } from '../../providers.js';
import {
  chatApi,
  getReadyUpload,
  listAccounts,
  resolveAccount,
  resolveAccounts,
  ServiceError,
  splitByCapability,
} from '../../service.js';
import { guard, ok, partial, type AccountProblem } from '../reply.js';

/**
 * Short on purpose, and repeated on purpose.
 *
 * These tools are only registered when a chat-capable account is connected
 * (Microsoft or Slack), so the long explanation that used to live here is no
 * longer earning its context: a user with no such account never sees these
 * tools at all. What remains is for the mixed case, where the model still has
 * to pick the right account.
 */
const CHAT_ACCOUNTS = 'Chat-capable accounts only — check `capabilities` in list_accounts.';

const accountArg = z
  .string()
  .optional()
  .describe(
    'Account address whose chats to use. Omit when only one chat-capable account ' +
      'is connected.',
  );

/** Explains an empty result caused by there being no chat-capable account at all. */
function noChatAccountsMessage(user: User): string {
  const all = listAccounts(user);
  if (all.length === 0) return 'No accounts are connected yet.';

  const chatProviders = PROVIDERS.filter((p) => providerSupports(p, 'chat')).map((p) =>
    capabilityLabel(p, 'chat'),
  );

  return (
    'None of the connected accounts can use chat. Connected: ' +
    `${all.map((a) => `${a.email} (${a.provider})`).join(', ')}. ` +
    `Chat needs a ${chatProviders.join(' or ')} account — the user can connect one from the ` +
    'dashboard. Do not report this as "no chats found": nothing was searched.'
  );
}

export function registerChatTools(server: McpServer, user: User): void {
  /* ---------------------------------------------------------------- *
   * List
   * ---------------------------------------------------------------- */

  server.registerTool(
    'list_chats',
    {
      title: 'List chats',
      description:
        `Lists recent chat conversations, most recently active first, with their participants ` +
        `and a preview of the last message. Reading and posting both need a chatId from here; ` +
        `start_chat creates one with someone not in the list.\n\n` +
        `Teams shows the chats the account belongs to. Slack shows channels, DMs and group ` +
        `DMs — a channel's name is its identity and it carries no participant list.\n\n` +
        `\`isExternal\` marks a conversation containing anyone outside the account's ` +
        `organisation — on Teams a guest or federated participant, on Slack a Slack Connect ` +
        `conversation. Check it before replying, since an answer there leaves the ` +
        `organisation.\n\n${CHAT_ACCOUNTS}`,
      inputSchema: {
        accounts: z
          .array(z.string())
          .optional()
          .describe(
            'Account addresses to look in. Omit to use every chat-capable account; any others ' +
              'are then reported under skippedAccounts rather than failing.',
          ),
        limit: z.number().int().min(1).max(50).default(20).describe('Max chats per account.'),
        nameContains: z
          .string()
          .optional()
          .describe(
            'Filter to chats whose topic or participant names contain this text. Applied ' +
              'after fetching — neither Teams nor Slack offers server-side chat search.',
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ accounts, limit, nameContains }) =>
      guard(async () => {
        // The capability hint settles the address a Slack account shares with
        // a mailbox: naming "erik@…" for chats means the Slack row.
        const requested = resolveAccounts(user, accounts, { capability: 'chat' });

        // An explicitly named Google mailbox is a mistake worth reporting; an
        // unfiltered "list my chats" is not, so it narrows and says that it did.
        if (accounts?.length) {
          for (const account of requested) {
            // Throws UnsupportedForProviderError with the precise reason.
            await chatApi(account);
          }
        }

        const { capable, skipped } = splitByCapability(requested, 'chat');
        if (capable.length === 0) {
          return ok({
            chatCount: 0,
            searched: [],
            skippedAccounts: skipped,
            warning: noChatAccountsMessage(user),
          });
        }

        const needle = nameContains?.toLowerCase();

        const perAccount = await Promise.all(
          capable.map(async (acc) => {
            try {
              const api = await chatApi(acc);
              const chats = await api.listChats(limit);
              const filtered = needle
                ? chats.filter((chat) =>
                    `${chat.topic ?? ''} ${chat.participants.map((p) => p.displayName).join(' ')}`
                      .toLowerCase()
                      .includes(needle),
                  )
                : chats;
              return { account: acc.email, ok: true as const, chats: filtered };
            } catch (err) {
              if (err instanceof ReauthRequiredError) {
                return {
                  account: acc.email,
                  ok: false as const,
                  error: 'needs_reauth',
                  reauthUrl: err.reauthUrl,
                  chats: [],
                };
              }
              return {
                account: acc.email,
                ok: false as const,
                error: (err as Error).message,
                chats: [],
              };
            }
          }),
        );

        const merged = perAccount
          .flatMap((r) => r.chats.map((c) => ({ account: r.account, ...c })))
          .sort((a, b) => (b.lastUpdated ?? '').localeCompare(a.lastUpdated ?? ''));

        const problems: AccountProblem[] = perAccount
          .filter((r) => !r.ok)
          .map((f) => ({
            account: f.account,
            error: f.error ?? 'unknown error',
            ...('reauthUrl' in f && f.reauthUrl ? { reauthUrl: f.reauthUrl } : {}),
          }));

        return partial(
          {
            searched: capable.map((a) => a.email),
            ...(skipped.length ? { skippedAccounts: skipped } : {}),
            chatCount: merged.length,
            chats: merged,
          },
          problems,
          'chats',
        );
      }),
  );

  /* ---------------------------------------------------------------- *
   * Read
   * ---------------------------------------------------------------- */

  server.registerTool(
    'read_chat',
    {
      title: 'Read a chat',
      description:
        `Reads the most recent messages in one chat, oldest first so the exchange reads in ` +
        `order. Bodies arrive as text — Teams HTML is converted, Slack keeps its mrkdwn — and ` +
        `@-mentions are listed as written. System events (someone added, chat renamed, ` +
        `channel joined) are included and flagged \`isSystemEvent\`.\n\n` +
        `On Slack, thread replies are flattened in after their parent: each reply carries ` +
        `\`inThreadOf\`, the parent carries \`replyCount\`, and \`threadTruncated\` says when ` +
        `more replies exist than were fetched.\n\n` +
        `Attachments come back as a name and a link only: the file lives in the sender's ` +
        `OneDrive or SharePoint (Teams) or behind Slack's permalink, and this server holds no ` +
        `file permissions for either, so hand the url to the user.\n\n${CHAT_ACCOUNTS}`,
      inputSchema: {
        chatId: z.string().describe('Chat id, from list_chats.'),
        account: accountArg,
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(30)
          .describe('How many of the most recent messages to fetch.'),
        maxBodyChars: z
          .number()
          .int()
          .min(200)
          .max(20000)
          .default(2000)
          .describe('Truncate each message body beyond this many characters.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ chatId, account, limit, maxBodyChars }) =>
      guard(async () => {
        const acc = resolveChatAccount(user, account);
        const api = await chatApi(acc);

        const [chat, messages] = await Promise.all([
          api.getChat(chatId),
          api.listMessages(chatId, limit),
        ]);

        return ok({
          account: acc.email,
          chat: {
            id: chat.id,
            topic: chat.topic,
            chatType: chat.chatType,
            isExternal: chat.isExternal,
            externalParticipants: chat.externalParticipants,
            participants: chat.participants,
            webUrl: chat.webUrl,
          },
          ...(chat.isExternal
            ? {
                externalWarning:
                  'This chat includes people outside the organisation ' +
                  `(${chat.externalParticipants.join(', ')}). Anything sent here leaves it — ` +
                  'confirm the content with the user before replying. Participants whose ' +
                  'organisation could not be determined are listed here too, so check the ' +
                  'names rather than assuming the worst.',
              }
            : {}),
          messageCount: messages.length,
          messages: messages.map((m) => ({
            ...m,
            bodyText:
              m.bodyText.length > maxBodyChars
                ? `${m.bodyText.slice(0, maxBodyChars)}\n\n[...truncated]`
                : m.bodyText,
          })),
        });
      }),
  );

  /* ---------------------------------------------------------------- *
   * Start
   * ---------------------------------------------------------------- */

  server.registerTool(
    'start_chat',
    {
      title: 'Start a chat',
      description:
        `Creates a chat with one or more people, named by email address, and returns its ` +
        `chatId. Use it when the person has no chat in list_chats yet.\n\n` +
        `Nobody is notified: an empty chat is invisible to the others until the first ` +
        `send_chat_message.\n\n` +
        `One other person makes a one-to-one chat, several make a group. Asking for a ` +
        `one-to-one chat that exists returns that conversation with its history and sets ` +
        `\`alreadyExisted\` — creating a second is not possible on either provider. Whether ` +
        `a topic can be named, and how large a group may be, differs; a refusal says exactly ` +
        `what the provider allows. You are added automatically.\n\n${CHAT_ACCOUNTS}`,
      inputSchema: {
        participants: z
          .array(z.string())
          .min(1)
          .describe(
            'Email addresses to chat with. Your own address is added automatically and does ' +
              'not need to be listed.',
          ),
        topic: z
          .string()
          .optional()
          .describe(
            'Name for a group chat. Teams allows it for group chats only; Slack names its ' +
              'group DMs itself and refuses a topic.',
          ),
        account: accountArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ participants, topic, account }) =>
      guard(async () => {
        const acc = resolveChatAccount(user, account);
        const api = await chatApi(acc);

        const { chat, alreadyExisted } = await api.createChat(participants, topic);

        return ok({
          created: !alreadyExisted,
          alreadyExisted,
          account: acc.email,
          chatId: chat.id,
          chatType: chat.chatType,
          topic: chat.topic,
          participants: chat.participants,
          isExternal: chat.isExternal,
          ...(chat.isExternal ? { externalParticipants: chat.externalParticipants } : {}),
          nextStep:
            'Nobody has been notified yet. Post the first message with send_chat_message ' +
            'using this chatId.',
          ...(alreadyExisted
            ? {
                note:
                  'This one-to-one chat already existed, so no new chat was created and its ' +
                  'history is intact. Read it with read_chat before replying.',
              }
            : {}),
        });
      }),
  );

  /* ---------------------------------------------------------------- *
   * Send
   * ---------------------------------------------------------------- */

  server.registerTool(
    'send_chat_message',
    {
      title: 'Post to a chat',
      description:
        `Posts to an existing chat as the connected account. Immediate and visible to ` +
        `everyone in it, with no draft state and no unsend — confirm the wording with the ` +
        `user first, and check \`isExternal\` for whether it leaves the organisation. Use ` +
        `start_chat for someone you have not messaged before.\n\n` +
        `\`body\` is plain text by default; \`isHtml\` works on Teams only, since Slack ` +
        `messages are mrkdwn. \`threadTs\` replies into a Slack thread — the parent ` +
        `message's id from read_chat; Teams chats have no threads.\n\n` +
        `To send a file or image (Slack only): create_upload_url, have the file PUT there, ` +
        `then pass the uploadId here — it posts as one message with \`body\` as its text. ` +
        `Teams chats cannot take uploads from this server.\n\n${CHAT_ACCOUNTS}`,
      inputSchema: {
        chatId: z.string().describe('Chat id, from list_chats.'),
        body: z
          .string()
          .default('')
          .describe(
            'Message text. Plain text unless isHtml is set. May be empty when uploadIds ' +
              'carry the message.',
          ),
        isHtml: z
          .boolean()
          .default(false)
          .describe(
            'Send as HTML, for links and simple formatting. Teams only — Slack messages are ' +
              'mrkdwn and refuse HTML.',
          ),
        threadTs: z
          .string()
          .optional()
          .describe(
            'Reply into a thread instead of the conversation: the parent message id from ' +
              'read_chat. Slack only.',
          ),
        uploadIds: z
          .array(z.string())
          .optional()
          .describe(
            'Ids from create_upload_url whose files have already been uploaded. ' +
              'Slack only — Teams refuses them.',
          ),
        account: accountArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ chatId, body, isHtml, threadTs, uploadIds, account }) =>
      guard(async () => {
        if (!body.trim() && !uploadIds?.length) {
          throw new ServiceError('Give a body, uploadIds, or both — there is nothing to send.');
        }

        const attachments: OutgoingChatAttachment[] = await Promise.all(
          (uploadIds ?? []).map(async (id) => {
            const upload = getReadyUpload(user, id);
            return {
              filename: upload.filename,
              mimeType: upload.mime_type,
              content: await readFile(upload.path),
            };
          }),
        );

        const acc = resolveChatAccount(user, account);
        const api = await chatApi(acc);

        // Fetched before posting so the result can state where the message went,
        // and whether it left the organisation.
        const chat = await api.getChat(chatId);
        const sent = await api.sendMessage(chatId, {
          body,
          isHtml,
          ...(threadTs ? { threadParentId: threadTs } : {}),
          ...(attachments.length ? { attachments } : {}),
        });

        return ok({
          sent: true,
          account: acc.email,
          chatId,
          messageId: sent.id,
          createdAt: sent.createdAt,
          ...(attachments.length
            ? { filesSent: attachments.map((a) => a.filename) }
            : {}),
          chatTopic: chat.topic,
          recipients: chat.participants.filter((p) => !p.isSelf).map((p) => p.displayName),
          wentExternal: chat.isExternal,
        });
      }),
  );

  /**
   * Picks the account for a single-chat operation.
   *
   * With no address given and several accounts connected, resolveAccount
   * refuses to guess — but for a chat tool the non-chat ones were never
   * candidates, so it narrows to the chat-capable accounts first and only asks
   * the caller to choose when the choice is real.
   *
   * A named address can now belong to more than one account: a Slack
   * membership shares its email with a mailbox. For a chat tool the
   * chat-capable row is the one that was meant.
   */
  function resolveChatAccount(forUser: User, email?: string) {
    if (email) {
      const normalized = email.toLowerCase().trim();
      const capable = listAccounts(forUser).filter(
        (a) => a.email === normalized && hasCapability(a, 'chat'),
      );
      if (capable.length > 1) {
        throw new ServiceError(
          `"${email}" is connected as more than one chat-capable account ` +
            `(${capable.map((a) => a.provider).join(' and ')}), so the address alone does not ` +
            'say which is meant. Disconnect one of them from the dashboard.',
        );
      }
      return resolveAccount(forUser, email, { capability: 'chat' });
    }

    const { capable } = splitByCapability(listAccounts(forUser), 'chat');
    if (capable.length === 1) return capable[0]!;
    if (capable.length === 0) throw new ServiceError(noChatAccountsMessage(forUser));

    throw new ServiceError(
      `Several chat-capable accounts are connected (${capable.map((a) => a.email).join(', ')}). ` +
        'Specify which one with the "account" argument.',
    );
  }
}
