import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { User } from '../../db/repo.js';
import { ReauthRequiredError } from '../../oauth/errors.js';
import {
  chatApi,
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
 * These tools are only registered when a Microsoft mailbox is connected, so the
 * long explanation that used to live here is no longer earning its context: a
 * user with no Microsoft mailbox never sees these tools at all. What remains is
 * for the mixed case, where the model still has to pick the right mailbox.
 */
const MICROSOFT_ONLY = 'Microsoft mailboxes only — check `capabilities` in list_accounts.';

const accountArg = z
  .string()
  .optional()
  .describe(
    'Microsoft mailbox address whose chats to use. Omit when only one Microsoft mailbox ' +
      'is connected.',
  );

/** Explains an empty result caused by there being no Microsoft mailbox at all. */
function noChatAccountsMessage(user: User): string {
  const all = listAccounts(user);
  if (all.length === 0) return 'No mailboxes are connected yet.';

  return (
    'None of the connected mailboxes can use Teams chat. Connected: ' +
    `${all.map((a) => `${a.email} (${a.provider})`).join(', ')}. ` +
    'Teams chat needs a Microsoft mailbox — the user can connect one from the dashboard. ' +
    'Do not report this as "no chats found": nothing was searched.'
  );
}

export function registerChatTools(server: McpServer, user: User): void {
  /* ---------------------------------------------------------------- *
   * List
   * ---------------------------------------------------------------- */

  server.registerTool(
    'list_chats',
    {
      title: 'List Teams chats',
      description:
        `Lists recent Teams chats, most recently active first, with their participants and a ` +
        `preview of the last message. Reading and posting both need a chatId from here; ` +
        `start_chat creates one with someone not in the list.\n\n` +
        `\`isExternal\` marks a chat containing anyone outside the account's organisation, ` +
        `and each participant carries the same flag — check it before replying, since an ` +
        `answer there leaves the organisation.\n\n` +
        `Chats in another organisation's tenant that this account is only a guest in are not ` +
        `reachable and will not appear.\n\n${MICROSOFT_ONLY}`,
      inputSchema: {
        accounts: z
          .array(z.string())
          .optional()
          .describe(
            'Mailbox addresses to look in. Omit to use every Microsoft mailbox; any Google ' +
              'mailboxes are then reported under skippedAccounts rather than failing.',
          ),
        limit: z.number().int().min(1).max(50).default(20).describe('Max chats per account.'),
        nameContains: z
          .string()
          .optional()
          .describe(
            'Filter to chats whose topic or participant names contain this text. Applied ' +
              'after fetching — Teams has no server-side chat search.',
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ accounts, limit, nameContains }) =>
      guard(async () => {
        const requested = resolveAccounts(user, accounts);

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
      title: 'Read a Teams chat',
      description:
        `Reads the most recent messages in one Teams chat, oldest first so the exchange reads ` +
        `in order. Bodies are converted from HTML to text and @-mentions are listed as ` +
        `written. System events (someone added, chat renamed, call ended) are included and ` +
        `flagged \`isSystemEvent\`.\n\n` +
        `Attachments come back as a name and a link only: the file lives in the sender's ` +
        `OneDrive or SharePoint and this server holds no file permissions for Microsoft ` +
        `accounts, so hand the url to the user.\n\n${MICROSOFT_ONLY}`,
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
      title: 'Start a Teams chat',
      description:
        `Creates a Teams chat with one or more people, named by email address, and returns ` +
        `its chatId. Use it when the person has no chat in list_chats yet.\n\n` +
        `Nobody is notified: an empty chat is invisible to the others until the first ` +
        `send_chat_message.\n\n` +
        `One other person makes a one-to-one chat, and Teams allows only one per pair — ` +
        `asking for one that exists returns that conversation with its history and sets ` +
        `\`alreadyExisted\`. Several people make a group chat, where calling twice really ` +
        `does create two. You are added automatically.\n\n${MICROSOFT_ONLY}`,
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
            'Name for a group chat. Not allowed for a one-to-one chat, which Teams names ' +
              'after the other person.',
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
      title: 'Post to a Teams chat',
      description:
        `Posts to an existing Teams chat as the connected account. Immediate and visible to ` +
        `everyone in it, with no draft state and no unsend — confirm the wording with the ` +
        `user first, and check \`isExternal\` for whether it leaves the organisation. Use ` +
        `start_chat for someone you have not messaged before.\n\n${MICROSOFT_ONLY}`,
      inputSchema: {
        chatId: z.string().describe('Chat id, from list_chats.'),
        body: z.string().min(1).describe('Message text. Plain text unless isHtml is set.'),
        isHtml: z
          .boolean()
          .default(false)
          .describe('Send as HTML, for links and simple formatting. Plain text otherwise.'),
        account: accountArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ chatId, body, isHtml, account }) =>
      guard(async () => {
        const acc = resolveChatAccount(user, account);
        const api = await chatApi(acc);

        // Fetched before posting so the result can state where the message went,
        // and whether it left the organisation.
        const chat = await api.getChat(chatId);
        const sent = await api.sendMessage(chatId, { body, isHtml });

        return ok({
          sent: true,
          account: acc.email,
          chatId,
          messageId: sent.id,
          createdAt: sent.createdAt,
          chatTopic: chat.topic,
          recipients: chat.participants.filter((p) => !p.isSelf).map((p) => p.displayName),
          wentExternal: chat.isExternal,
        });
      }),
  );

  /**
   * Picks the mailbox for a single-chat operation.
   *
   * With no address given and several mailboxes connected, resolveAccount
   * refuses to guess — but for a chat tool the Google ones were never
   * candidates, so it narrows to the Microsoft mailboxes first and only asks the
   * caller to choose when the choice is real.
   */
  function resolveChatAccount(forUser: User, email?: string) {
    if (email) return resolveAccount(forUser, email);

    const { capable } = splitByCapability(listAccounts(forUser), 'chat');
    if (capable.length === 1) return capable[0]!;
    if (capable.length === 0) throw new ServiceError(noChatAccountsMessage(forUser));

    throw new ServiceError(
      `Several Microsoft mailboxes are connected (${capable.map((a) => a.email).join(', ')}). ` +
        'Specify which one with the "account" argument.',
    );
  }
}
