import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Account, User } from '../../db/repo.js';
import {
  createDraft,
  getFullMessage,
  getThread,
  listLabels,
  modifyMessage,
  modifyThread,
  searchMessages,
  sendMessage,
  type OutgoingAttachment,
  type ParsedMessage,
} from '../../google/gmail.js';
import { ReauthRequiredError } from '../../google/oauth.js';
import {
  buildDownloadUrl,
  getReadyUpload,
  gmailClient,
  resolveAccount,
  resolveAccounts,
  ServiceError,
} from '../../service.js';
import { guard, ok } from '../reply.js';

const accountArg = z
  .string()
  .optional()
  .describe('Mailbox address to act on. Omit when only one mailbox is connected.');

/** Truncates long bodies so a single message can't swallow the context window. */
function clampBody(body: string, maxChars: number): { body: string; truncated: boolean } {
  if (body.length <= maxChars) return { body, truncated: false };
  return {
    body: `${body.slice(0, maxChars)}\n\n[...truncated, ${body.length - maxChars} more characters]`,
    truncated: true,
  };
}

function presentMessage(
  user: User,
  account: Account,
  msg: ParsedMessage,
  maxBodyChars: number,
): Record<string, unknown> {
  const { body, truncated } = clampBody(msg.bodyText, maxBodyChars);
  return {
    account: account.email,
    id: msg.id,
    threadId: msg.threadId,
    from: msg.from,
    to: msg.to,
    cc: msg.cc || undefined,
    subject: msg.subject,
    date: msg.date,
    labelIds: msg.labelIds,
    body,
    bodyTruncated: truncated,
    bodyFromHtml: msg.bodyIsHtmlFallback || undefined,
    // Message-ID / References are what a caller needs to reply in-thread.
    messageIdHeader: msg.messageIdHeader,
    references: msg.references,
    attachments: msg.attachments.map((a) => ({
      attachmentId: a.attachmentId,
      filename: a.filename,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      downloadUrl: buildDownloadUrl({
        user,
        account,
        messageId: msg.id,
        attachmentId: a.attachmentId,
        filename: a.filename,
        mimeType: a.mimeType,
      }).url,
    })),
  };
}

export function registerMailTools(server: McpServer, user: User): void {
  /* ---------------------------------------------------------------- *
   * Search
   * ---------------------------------------------------------------- */

  server.registerTool(
    'search_messages',
    {
      title: 'Search mail',
      description:
        'Searches mail across one or several connected mailboxes using Gmail query syntax ' +
        '(e.g. `from:anna@example.com after:2026/01/01 has:attachment`, `is:unread in:inbox`, ' +
        '`subject:"invoice" -label:spam`). Returns compact summaries sorted newest first, ' +
        'without message bodies — follow up with get_message or get_thread for full text ' +
        'and attachment details. To find mail with attachments, put `has:attachment` in the ' +
        'query rather than filtering the results.',
      inputSchema: {
        query: z
          .string()
          .describe('Gmail search query. Use an empty string to list recent mail.'),
        accounts: z
          .array(z.string())
          .optional()
          .describe('Mailbox addresses to search. Omit to search all connected mailboxes.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(20)
          .describe('Maximum results per mailbox.'),
        includeSpamTrash: z.boolean().default(false).describe('Include Spam and Trash.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, accounts, limit, includeSpamTrash }) =>
      guard(async () => {
        const targets = resolveAccounts(user, accounts);

        const perAccount = await Promise.all(
          targets.map(async (acc) => {
            try {
              const gmail = await gmailClient(acc);
              const results = await searchMessages(gmail, query, limit, includeSpamTrash);
              return { account: acc.email, ok: true as const, results };
            } catch (err) {
              // One dead mailbox must not sink a multi-account search: report it
              // inline so the agent can still use the accounts that do work.
              if (err instanceof ReauthRequiredError) {
                return {
                  account: acc.email,
                  ok: false as const,
                  error: 'needs_reauth',
                  reauthUrl: err.reauthUrl,
                  results: [],
                };
              }
              return {
                account: acc.email,
                ok: false as const,
                error: (err as Error).message,
                results: [],
              };
            }
          }),
        );

        const merged = perAccount
          .flatMap((r) => r.results.map((m) => ({ account: r.account, ...m })))
          .sort((a, b) => b.internalDate - a.internalDate);

        const failures = perAccount.filter((r) => !r.ok);

        return ok({
          query,
          searchedAccounts: targets.map((a) => a.email),
          totalResults: merged.length,
          messages: merged,
          ...(failures.length
            ? {
                accountsWithProblems: failures.map((f) => ({
                  account: f.account,
                  error: f.error,
                  ...('reauthUrl' in f ? { reauthUrl: f.reauthUrl } : {}),
                })),
              }
            : {}),
        });
      }),
  );

  /* ---------------------------------------------------------------- *
   * Read
   * ---------------------------------------------------------------- */

  server.registerTool(
    'get_message',
    {
      title: 'Read one message',
      description:
        'Fetches a single message with its full body and attachment list. Each attachment ' +
        'comes with a time-limited downloadUrl that can be given to the user or fetched directly.',
      inputSchema: {
        messageId: z.string().describe('Gmail message id, from search_messages.'),
        account: accountArg,
        maxBodyChars: z
          .number()
          .int()
          .min(500)
          .max(200000)
          .default(20000)
          .describe('Truncate the body beyond this many characters.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ messageId, account, maxBodyChars }) =>
      guard(async () => {
        const acc = resolveAccount(user, account);
        const gmail = await gmailClient(acc);
        const msg = await getFullMessage(gmail, messageId);
        return ok(presentMessage(user, acc, msg, maxBodyChars));
      }),
  );

  server.registerTool(
    'get_thread',
    {
      title: 'Read a conversation',
      description:
        'Fetches every message in a conversation, oldest first, with bodies and attachments. ' +
        'Prefer this over repeated get_message calls when you need the context of an exchange.',
      inputSchema: {
        threadId: z.string().describe('Gmail thread id, from search_messages.'),
        account: accountArg,
        maxBodyChars: z
          .number()
          .int()
          .min(500)
          .max(200000)
          .default(8000)
          .describe('Truncate each message body beyond this many characters.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ threadId, account, maxBodyChars }) =>
      guard(async () => {
        const acc = resolveAccount(user, account);
        const gmail = await gmailClient(acc);
        const thread = await getThread(gmail, threadId);
        return ok({
          account: acc.email,
          threadId: thread.threadId,
          messageCount: thread.messages.length,
          messages: thread.messages.map((m) => presentMessage(user, acc, m, maxBodyChars)),
        });
      }),
  );

  server.registerTool(
    'list_labels',
    {
      title: 'List labels',
      description:
        'Lists the labels available in a mailbox, with their ids. Label ids are what ' +
        'modify_labels expects (system labels like INBOX, UNREAD, STARRED use their name as id).',
      inputSchema: { account: accountArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ account }) =>
      guard(async () => {
        const acc = resolveAccount(user, account);
        const gmail = await gmailClient(acc);
        return ok({ account: acc.email, labels: await listLabels(gmail) });
      }),
  );

  /* ---------------------------------------------------------------- *
   * Attachments
   * ---------------------------------------------------------------- */

  server.registerTool(
    'get_attachment_url',
    {
      title: 'Get a download link for an attachment',
      description:
        'Produces a time-limited direct download URL for one attachment. Use the attachmentId ' +
        'from get_message or get_thread. The URL streams the file from Gmail on demand — ' +
        'nothing is stored on the server.',
      inputSchema: {
        messageId: z.string().describe('Gmail message id the attachment belongs to.'),
        attachmentId: z.string().describe('Attachment id, from get_message or get_thread.'),
        filename: z.string().describe('Filename to serve the download as.'),
        mimeType: z.string().default('application/octet-stream').describe('Content type.'),
        account: accountArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ messageId, attachmentId, filename, mimeType, account }) =>
      guard(async () => {
        const acc = resolveAccount(user, account);
        const { url, expiresAt } = buildDownloadUrl({
          user,
          account: acc,
          messageId,
          attachmentId,
          filename,
          mimeType,
        });
        return ok({ account: acc.email, filename, downloadUrl: url, expiresAt });
      }),
  );

  /* ---------------------------------------------------------------- *
   * Modify
   * ---------------------------------------------------------------- */

  server.registerTool(
    'modify_labels',
    {
      title: 'Change labels on a message or thread',
      description:
        'Adds and removes labels. Covers the common operations: archive (remove INBOX), ' +
        'mark read (remove UNREAD), mark unread (add UNREAD), star (add STARRED), ' +
        'move to trash (add TRASH). Nothing is permanently deleted.',
      inputSchema: {
        messageId: z.string().optional().describe('Message to modify. Give this or threadId.'),
        threadId: z
          .string()
          .optional()
          .describe('Thread to modify — applies to every message in it.'),
        addLabelIds: z.array(z.string()).default([]).describe('Label ids to add.'),
        removeLabelIds: z.array(z.string()).default([]).describe('Label ids to remove.'),
        account: accountArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ messageId, threadId, addLabelIds, removeLabelIds, account }) =>
      guard(async () => {
        if (!messageId && !threadId) {
          throw new ServiceError('Give either messageId or threadId.');
        }
        if (addLabelIds.length === 0 && removeLabelIds.length === 0) {
          throw new ServiceError('Nothing to do: both addLabelIds and removeLabelIds are empty.');
        }

        const acc = resolveAccount(user, account);
        const gmail = await gmailClient(acc);

        if (threadId) {
          await modifyThread(gmail, threadId, addLabelIds, removeLabelIds);
          return ok({ account: acc.email, threadId, addLabelIds, removeLabelIds, applied: true });
        }

        const labels = await modifyMessage(gmail, messageId!, addLabelIds, removeLabelIds);
        return ok({ account: acc.email, messageId, labelIds: labels, applied: true });
      }),
  );

  /* ---------------------------------------------------------------- *
   * Compose
   * ---------------------------------------------------------------- */

  const composeSchema = {
    to: z.array(z.string()).min(1).describe('Recipient addresses.'),
    subject: z.string().describe('Subject line.'),
    body: z.string().describe('Plain text body.'),
    cc: z.array(z.string()).optional().describe('Cc addresses.'),
    bcc: z.array(z.string()).optional().describe('Bcc addresses.'),
    bodyHtml: z
      .string()
      .optional()
      .describe('Optional HTML body, sent alongside the plain text alternative.'),
    uploadIds: z
      .array(z.string())
      .optional()
      .describe('Ids from create_upload_url whose files have already been uploaded.'),
    threadId: z
      .string()
      .optional()
      .describe('Thread to attach this message to, when replying.'),
    inReplyTo: z
      .string()
      .optional()
      .describe('Message-ID header of the message being replied to (from get_message).'),
    references: z
      .string()
      .optional()
      .describe('References header value, for correct threading in other mail clients.'),
    account: accountArg,
  };

  async function collectAttachments(uploadIds: string[] | undefined): Promise<OutgoingAttachment[]> {
    if (!uploadIds?.length) return [];
    return Promise.all(
      uploadIds.map(async (id) => {
        const upload = getReadyUpload(user, id);
        return {
          filename: upload.filename,
          mimeType: upload.mime_type,
          content: await readFile(upload.path),
        };
      }),
    );
  }

  server.registerTool(
    'send_message',
    {
      title: 'Send an email',
      description:
        'Sends an email from one of the connected mailboxes. To attach files, first call ' +
        'create_upload_url, have the file PUT to that URL, then pass the uploadId here. ' +
        'To reply within a thread, pass threadId plus the inReplyTo and references values ' +
        'from get_message. This sends immediately — use create_draft if the user should review first.',
      inputSchema: composeSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const acc = resolveAccount(user, args.account);
        const gmail = await gmailClient(acc);
        const attachments = await collectAttachments(args.uploadIds);

        const result = await sendMessage(
          gmail,
          {
            from: acc.display_name ? `${acc.display_name} <${acc.email}>` : acc.email,
            to: args.to,
            cc: args.cc,
            bcc: args.bcc,
            subject: args.subject,
            bodyText: args.body,
            bodyHtml: args.bodyHtml,
            attachments,
            inReplyTo: args.inReplyTo,
            references: args.references,
          },
          args.threadId,
        );

        return ok({
          sent: true,
          account: acc.email,
          messageId: result.id,
          threadId: result.threadId,
          to: args.to,
          subject: args.subject,
          attachmentCount: attachments.length,
        });
      }),
  );

  server.registerTool(
    'create_draft',
    {
      title: 'Create a draft email',
      description:
        'Creates a draft in the mailbox instead of sending. Takes the same arguments as ' +
        'send_message. Prefer this when the user should read the message before it goes out.',
      inputSchema: composeSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const acc = resolveAccount(user, args.account);
        const gmail = await gmailClient(acc);
        const attachments = await collectAttachments(args.uploadIds);

        const result = await createDraft(
          gmail,
          {
            from: acc.display_name ? `${acc.display_name} <${acc.email}>` : acc.email,
            to: args.to,
            cc: args.cc,
            bcc: args.bcc,
            subject: args.subject,
            bodyText: args.body,
            bodyHtml: args.bodyHtml,
            attachments,
            inReplyTo: args.inReplyTo,
            references: args.references,
          },
          args.threadId,
        );

        return ok({
          draftCreated: true,
          account: acc.email,
          draftId: result.draftId,
          messageId: result.messageId,
          to: args.to,
          subject: args.subject,
          attachmentCount: attachments.length,
        });
      }),
  );
}
