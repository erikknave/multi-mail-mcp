import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { User } from '../../db/repo.js';
import {
  addTab,
  appendBlocks,
  createDoc,
  deleteText,
  describeTabs,
  fillNewTab,
  formatText,
  getDocument,
  insertAtAnchor,
  pickTab,
  replaceText,
} from '../../google/docs.js';
import {
  flattenTabs,
  listParagraphs,
  parseMarkdownLite,
  parsePlain,
  tabText,
  type Block,
} from '../../google/docsModel.js';
import { addComment, listComments, replyToComment } from '../../google/comments.js';
import { docsClient, driveClient, resolveAccount, ServiceError } from '../../service.js';
import { guard, ok } from '../reply.js';

const accountArg = z
  .string()
  .optional()
  .describe('Account owning the document. Omit when only one account is connected.');

const docArg = z
  .string()
  .describe('Document id — the long id in the Docs URL, or from search_drive.');

const tabArg = z
  .string()
  .optional()
  .describe('Tab id (from list_doc_tabs / read_doc). Omit for the first tab.');

const searchTabArg = z
  .string()
  .optional()
  .describe('Tab id to search in. Omit to search every tab.');

const revisionArg = z
  .string()
  .optional()
  .describe(
    'revisionId from your last read. If the document has changed since, nothing is ' +
      'written and you are told to re-read.',
  );

const textArg = z
  .string()
  .describe(
    'Text. With format "markdown" (default): one line = one paragraph, # headings, ' +
      '- bullets, 1. numbered, **bold**, *italic*, ~~strike~~, [link](url); a line ' +
      'ending in \\ continues after a soft line break.',
  );

const formatArg = z
  .enum(['markdown', 'plain'])
  .default('markdown')
  .describe('"plain" inserts every line literally as its own paragraph, blank lines included.');

const occurrenceArg = z
  .number()
  .int()
  .min(1)
  .optional()
  .describe('Which occurrence (1-based, document order) when the text appears more than once.');

const matchCaseArg = z.boolean().default(true).describe('Match letter case exactly.');

function blocksFrom(text: string, format: 'markdown' | 'plain'): Block[] {
  if (text.trim() === '') throw new ServiceError('No text was supplied.');
  const blocks = format === 'plain' ? parsePlain(text) : parseMarkdownLite(text);
  if (blocks.length === 0) throw new ServiceError('No text was supplied.');
  return blocks;
}

function docUrl(documentId: string, tabId?: string): string {
  return `https://docs.google.com/document/d/${documentId}/edit${tabId ? `?tab=${tabId}` : ''}`;
}

/** A bad hex colour is the caller's mistake, not a Google API failure. */
async function asServiceError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Error && /hex colour/.test(err.message)) throw new ServiceError(err.message);
    throw err;
  }
}

export function registerDocsTools(server: McpServer, user: User): void {
  /* ---------------------------------------------------------------- *
   * Reading
   * ---------------------------------------------------------------- */

  server.registerTool(
    'read_doc',
    {
      title: 'Read a Google Doc',
      description:
        'Returns the plain text of a Google Doc — every tab, each under a "=== Tab: … ===" ' +
        'header, tables included — plus the tab list and revisionId. List numbers and ' +
        'bullets are not part of the text. structure: true returns paragraphs with style, ' +
        'list membership and index range instead.',
      inputSchema: {
        documentId: docArg,
        tabId: z.string().optional().describe('Read only this tab. Omit for all tabs.'),
        structure: z
          .boolean()
          .default(false)
          .describe('Return paragraphs (text, style, list, startIndex/endIndex) instead of one text.'),
        maxChars: z
          .number()
          .int()
          .min(500)
          .max(500000)
          .default(50000)
          .describe('Truncate beyond this many characters.'),
        account: accountArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ documentId, tabId, structure, maxChars, account }) =>
      guard(async () => {
        const acc = resolveAccount(user, account);
        const docs = await docsClient(acc);
        const doc = await getDocument(docs, documentId);
        const tabs = flattenTabs(doc);
        const selected = tabId ? [pickTab(tabs, tabId)] : tabs;
        const base = {
          account: acc.email,
          documentId,
          title: doc.title ?? '(untitled)',
          revisionId: doc.revisionId ?? null,
          tabs: describeTabs(tabs),
        };

        if (structure) {
          let budget = maxChars;
          let truncated = false;
          const out = selected.map((t) => {
            const paragraphs = [];
            for (const p of listParagraphs(t)) {
              if (budget <= 0) {
                truncated = true;
                break;
              }
              budget -= p.text.length;
              paragraphs.push({
                startIndex: p.startIndex,
                endIndex: p.endIndex,
                style: p.style,
                ...(p.list ? { list: p.list } : {}),
                ...(p.container !== 'body' ? { inTable: true } : {}),
                text: p.text.replace(/\n$/, ''),
              });
            }
            return { tabId: t.tabId, title: t.title, paragraphs };
          });
          return ok({ ...base, contentTruncated: truncated, content: out });
        }

        const text =
          tabs.length === 1
            ? tabText(selected[0]!)
            : selected
                .map((t) => `=== Tab: ${t.title} (tabId ${t.tabId}) ===\n${tabText(t)}`)
                .join('\n');
        const truncated = text.length > maxChars;
        return ok({
          ...base,
          characterCount: text.length,
          contentTruncated: truncated,
          content: truncated
            ? `${text.slice(0, maxChars)}\n\n[...truncated, ${text.length - maxChars} more characters]`
            : text,
        });
      }),
  );

  server.registerTool(
    'list_doc_tabs',
    {
      title: 'List the tabs of a Google Doc',
      description: "Lists a document's tabs: id, title, position, nesting depth and size.",
      inputSchema: { documentId: docArg, account: accountArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ documentId, account }) =>
      guard(async () => {
        const acc = resolveAccount(user, account);
        const docs = await docsClient(acc);
        const doc = await getDocument(docs, documentId);
        return ok({
          account: acc.email,
          documentId,
          title: doc.title ?? '(untitled)',
          revisionId: doc.revisionId ?? null,
          tabs: describeTabs(flattenTabs(doc)),
        });
      }),
  );

  /* ---------------------------------------------------------------- *
   * Writing
   * ---------------------------------------------------------------- */

  server.registerTool(
    'append_to_doc',
    {
      title: 'Append to a Google Doc',
      description:
        'Adds paragraphs at the end of a tab, leaving everything already there intact. The ' +
        'text always starts a new paragraph. The correct way to add to a Doc — ' +
        'write_drive_file would replace the whole file.',
      inputSchema: {
        documentId: docArg,
        text: textArg,
        format: formatArg,
        tabId: tabArg,
        requiredRevisionId: revisionArg,
        account: accountArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ documentId, text, format, tabId, requiredRevisionId, account }) =>
      guard(async () => {
        const blocks = blocksFrom(text, format);
        const acc = resolveAccount(user, account);
        const docs = await docsClient(acc);
        const res = await appendBlocks(docs, documentId, blocks, { tabId, requiredRevisionId });
        return ok({ appended: true, account: acc.email, documentId, ...res });
      }),
  );

  server.registerTool(
    'append_doc_heading',
    {
      title: 'Append a heading to a Google Doc',
      description:
        'Adds a real heading (it appears in the outline) as a new paragraph at the end of a tab.',
      inputSchema: {
        documentId: docArg,
        text: z.string().describe('Heading text.'),
        level: z
          .number()
          .int()
          .min(1)
          .max(6)
          .default(1)
          .describe('Heading level, 1 being the most prominent.'),
        tabId: tabArg,
        requiredRevisionId: revisionArg,
        account: accountArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ documentId, text, level, tabId, requiredRevisionId, account }) =>
      guard(async () => {
        if (text.trim() === '') throw new ServiceError('No heading text was supplied.');
        if (/\n/.test(text)) {
          throw new ServiceError('A heading is one line; it cannot contain a newline.');
        }
        const acc = resolveAccount(user, account);
        const docs = await docsClient(acc);
        const blocks: Block[] = [{ kind: 'heading', level, text, spans: [] }];
        const res = await appendBlocks(docs, documentId, blocks, { tabId, requiredRevisionId });
        return ok({ appended: true, account: acc.email, documentId, heading: text, level, ...res });
      }),
  );

  server.registerTool(
    'insert_doc_text',
    {
      title: 'Insert paragraphs next to existing text in a Google Doc',
      description:
        'Inserts new paragraphs directly after (or before) the paragraph containing `anchor`. ' +
        'New paragraphs are plain NORMAL_TEXT — not list items, even inside a list — unless ' +
        'the text uses list/heading syntax or inheritStyle is true. Fails without changing ' +
        'anything if the anchor is missing or occurs more than once (reports the count).',
      inputSchema: {
        documentId: docArg,
        anchor: z
          .string()
          .describe('Text identifying the paragraph — a distinctive piece of it is enough.'),
        text: textArg,
        position: z.enum(['after', 'before']).default('after'),
        format: formatArg,
        inheritStyle: z
          .boolean()
          .default(false)
          .describe(
            "Keep the anchor paragraph's style and list membership, e.g. to add an item to " +
              'the same numbered list. Block syntax (#, -, 1.) is then not applied.',
          ),
        occurrence: occurrenceArg,
        matchCase: matchCaseArg,
        tabId: searchTabArg,
        requiredRevisionId: revisionArg,
        account: accountArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        if (args.anchor === '') throw new ServiceError('The anchor text cannot be empty.');
        const blocks = blocksFrom(args.text, args.format);
        const acc = resolveAccount(user, args.account);
        const docs = await docsClient(acc);
        const res = await insertAtAnchor(docs, args.documentId, args.anchor, blocks, {
          position: args.position,
          inheritStyle: args.inheritStyle,
          occurrence: args.occurrence,
          matchCase: args.matchCase,
          tabId: args.tabId,
          requiredRevisionId: args.requiredRevisionId,
        });
        return ok({ inserted: true, account: acc.email, documentId: args.documentId, ...res });
      }),
  );

  server.registerTool(
    'delete_doc_text',
    {
      title: 'Delete text or paragraphs from a Google Doc',
      description:
        'mode "paragraph" (default) removes every paragraph the text touches, newline ' +
        'included, so no empty line or empty list item is left. mode "text" removes just ' +
        'the matched characters. Refuses an ambiguous match unless occurrence or all is ' +
        'given. Reports what was deleted.',
      inputSchema: {
        documentId: docArg,
        find: z.string().describe('Text to locate.'),
        mode: z.enum(['paragraph', 'text']).default('paragraph'),
        all: z.boolean().default(false).describe('Delete every occurrence.'),
        occurrence: occurrenceArg,
        matchCase: matchCaseArg,
        tabId: searchTabArg,
        requiredRevisionId: revisionArg,
        account: accountArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        if (args.find === '') throw new ServiceError('The text to find cannot be empty.');
        const acc = resolveAccount(user, args.account);
        const docs = await docsClient(acc);
        const res = await deleteText(docs, args.documentId, args.find, {
          mode: args.mode,
          all: args.all,
          occurrence: args.occurrence,
          matchCase: args.matchCase,
          tabId: args.tabId,
          requiredRevisionId: args.requiredRevisionId,
        });
        return ok({ account: acc.email, documentId: args.documentId, ...res });
      }),
  );

  server.registerTool(
    'replace_doc_text',
    {
      title: 'Find and replace in a Google Doc',
      description:
        'Replaces every occurrence of a string, in all tabs unless tabId is given, tables ' +
        'included. Best for short in-paragraph edits and template placeholders; to add or ' +
        'remove whole paragraphs use insert_doc_text / delete_doc_text instead. Reports how ' +
        'many occurrences changed.',
      inputSchema: {
        documentId: docArg,
        find: z.string().describe('Text to search for.'),
        replace: z.string().describe('Replacement text. Empty string deletes the matches.'),
        matchCase: matchCaseArg,
        tabId: z.string().optional().describe('Limit to this tab. Omit for all tabs.'),
        requiredRevisionId: revisionArg,
        account: accountArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ documentId, find, replace, matchCase, tabId, requiredRevisionId, account }) =>
      guard(async () => {
        if (find === '') throw new ServiceError('The text to find cannot be empty.');
        const acc = resolveAccount(user, account);
        const docs = await docsClient(acc);
        const res = await replaceText(docs, documentId, find, replace, matchCase, {
          tabId,
          requiredRevisionId,
        });

        const notes: string[] = [];
        if (res.occurrencesChanged === 0) {
          notes.push(
            `"${find}" does not appear in the document; nothing was changed. List numbers and ` +
              "bullets are not text, and text copied from read_drive_file's Markdown carries " +
              'escapes and trailing spaces the document does not have — copy from read_doc. ' +
              'insert_doc_text / delete_doc_text also tolerate quote, dash and "…" variants.',
          );
        }
        if (/\n/.test(find) || /\n/.test(replace)) {
          notes.push(
            'The text contains a newline, i.e. a paragraph break. Every paragraph a ' +
              'replacement creates inherits the style of the one it starts in — inside a list ' +
              'each line becomes a list item. Prefer insert_doc_text / delete_doc_text for ' +
              'paragraphs, or \\v for a line break within a paragraph.',
          );
        }
        if (replace === '' && res.occurrencesChanged > 0) {
          notes.push(
            'Replacing with "" removes characters only; a paragraph emptied this way stays ' +
              'as an empty line or list item. delete_doc_text removes the paragraph itself.',
          );
        }
        return ok({
          account: acc.email,
          documentId,
          occurrencesChanged: res.occurrencesChanged,
          revisionId: res.revisionId,
          ...(notes.length ? { notes } : {}),
        });
      }),
  );

  server.registerTool(
    'format_doc_text',
    {
      title: 'Format existing text in a Google Doc',
      description:
        'Sets bold, italic, underline, strikethrough, text colour or highlight on existing ' +
        'text. Strikethrough plus a colour is a clear way to show a correction. Refuses an ' +
        'ambiguous match unless occurrence or all is given.',
      inputSchema: {
        documentId: docArg,
        find: z.string().describe('Text to format.'),
        bold: z.boolean().optional(),
        italic: z.boolean().optional(),
        underline: z.boolean().optional(),
        strikethrough: z.boolean().optional(),
        color: z.string().optional().describe('Text colour as hex, e.g. "#d93025". "" resets.'),
        highlight: z
          .string()
          .optional()
          .describe('Background as hex, e.g. "#fff475". "" removes.'),
        all: z.boolean().default(false).describe('Format every occurrence.'),
        occurrence: occurrenceArg,
        matchCase: matchCaseArg,
        tabId: searchTabArg,
        requiredRevisionId: revisionArg,
        account: accountArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        if (args.find === '') throw new ServiceError('The text to find cannot be empty.');
        const acc = resolveAccount(user, args.account);
        const docs = await docsClient(acc);
        const res = await asServiceError(() =>
          formatText(
            docs,
            args.documentId,
            args.find,
            {
              bold: args.bold,
              italic: args.italic,
              underline: args.underline,
              strikethrough: args.strikethrough,
              color: args.color,
              highlight: args.highlight,
            },
            {
              all: args.all,
              occurrence: args.occurrence,
              matchCase: args.matchCase,
              tabId: args.tabId,
              requiredRevisionId: args.requiredRevisionId,
            },
          ),
        );
        return ok({ account: acc.email, documentId: args.documentId, ...res });
      }),
  );

  server.registerTool(
    'create_doc_tab',
    {
      title: 'Add a tab to a Google Doc',
      description: 'Creates a new tab, optionally nested under another and with initial text.',
      inputSchema: {
        documentId: docArg,
        title: z.string().optional().describe('Tab title.'),
        parentTabId: z.string().optional().describe('Make it a child of this tab.'),
        index: z.number().int().min(0).optional().describe('Position among its siblings.'),
        text: textArg.optional(),
        format: formatArg,
        requiredRevisionId: revisionArg,
        account: accountArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ documentId, title, parentTabId, index, text, format, requiredRevisionId, account }) =>
      guard(async () => {
        const blocks = text ? blocksFrom(text, format) : null;
        const acc = resolveAccount(user, account);
        const docs = await docsClient(acc);
        const tab = await addTab(docs, documentId, { title, parentTabId, index, requiredRevisionId });
        const revisionId = blocks
          ? await fillNewTab(docs, documentId, tab.tabId, blocks)
          : tab.revisionId;
        return ok({
          created: true,
          account: acc.email,
          documentId,
          tabId: tab.tabId,
          title: tab.title,
          index: tab.index,
          revisionId,
          url: docUrl(documentId, tab.tabId),
        });
      }),
  );

  server.registerTool(
    'create_doc',
    {
      title: 'Create a Google Doc',
      description:
        "Creates a new document in the account's Drive, optionally with starting text. " +
        'Use update_drive_file afterwards to move it into a folder.',
      inputSchema: {
        title: z.string().describe('Document title.'),
        text: textArg.optional(),
        format: formatArg,
        account: accountArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ title, text, format, account }) =>
      guard(async () => {
        const blocks = text ? blocksFrom(text, format) : undefined;
        const acc = resolveAccount(user, account);
        const docs = await docsClient(acc);
        const doc = await createDoc(docs, title, blocks);
        return ok({
          created: true,
          account: acc.email,
          documentId: doc.documentId,
          title: doc.title,
          revisionId: doc.revisionId,
          url: docUrl(doc.documentId),
        });
      }),
  );

  /* ---------------------------------------------------------------- *
   * Comments
   * ---------------------------------------------------------------- */

  server.registerTool(
    'list_doc_comments',
    {
      title: 'List comments on a Google Doc',
      description:
        'Lists comments with their replies, author, quoted text and resolved state. Works ' +
        'for any Drive file that supports comments.',
      inputSchema: {
        documentId: docArg,
        includeResolved: z.boolean().default(false).describe('Include resolved comments.'),
        limit: z.number().int().min(1).max(500).default(100),
        account: accountArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ documentId, includeResolved, limit, account }) =>
      guard(async () => {
        const acc = resolveAccount(user, account);
        const drive = await driveClient(acc);
        const { comments, more } = await listComments(drive, documentId, includeResolved, limit);
        return ok({
          account: acc.email,
          documentId,
          count: comments.length,
          ...(more ? { moreAvailable: true } : {}),
          comments,
        });
      }),
  );

  server.registerTool(
    'add_doc_comment',
    {
      title: 'Comment on a Google Doc',
      description:
        "Adds a comment. Google's API cannot attach it to a text range: it appears as a " +
        'document-level comment and nothing in the text is highlighted. quotedText is shown ' +
        'with the comment as a quote, so name the passage there. To mark text visibly, ' +
        'combine with format_doc_text (e.g. highlight).',
      inputSchema: {
        documentId: docArg,
        content: z.string().describe('Comment text.'),
        quotedText: z.string().optional().describe('The passage the comment is about.'),
        account: accountArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ documentId, content, quotedText, account }) =>
      guard(async () => {
        if (content.trim() === '') throw new ServiceError('The comment cannot be empty.');
        const acc = resolveAccount(user, account);
        const drive = await driveClient(acc);
        const comment = await addComment(drive, documentId, content, quotedText);
        return ok({ created: true, account: acc.email, documentId, comment });
      }),
  );

  server.registerTool(
    'reply_to_doc_comment',
    {
      title: 'Reply to a comment on a Google Doc',
      description: 'Replies to a comment thread, optionally resolving it in the same step.',
      inputSchema: {
        documentId: docArg,
        commentId: z.string().describe('From list_doc_comments.'),
        content: z.string().describe('Reply text.'),
        resolve: z.boolean().default(false).describe('Also mark the thread resolved.'),
        account: accountArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ documentId, commentId, content, resolve, account }) =>
      guard(async () => {
        if (content.trim() === '') throw new ServiceError('The reply cannot be empty.');
        const acc = resolveAccount(user, account);
        const drive = await driveClient(acc);
        const reply = await replyToComment(
          drive,
          documentId,
          commentId,
          content,
          resolve ? 'resolve' : undefined,
        );
        return ok({ replied: true, account: acc.email, documentId, commentId, ...reply });
      }),
  );

  server.registerTool(
    'resolve_doc_comment',
    {
      title: 'Resolve or reopen a comment on a Google Doc',
      description: 'Marks a comment thread resolved (or reopens it), with an optional closing note.',
      inputSchema: {
        documentId: docArg,
        commentId: z.string().describe('From list_doc_comments.'),
        note: z.string().optional().describe('Optional reply posted with the change.'),
        reopen: z.boolean().default(false).describe('Reopen a resolved thread instead.'),
        account: accountArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ documentId, commentId, note, reopen, account }) =>
      guard(async () => {
        const acc = resolveAccount(user, account);
        const drive = await driveClient(acc);
        const action = reopen ? 'reopen' : 'resolve';
        const reply = await replyToComment(drive, documentId, commentId, note ?? '', action);
        return ok({
          [reopen ? 'reopened' : 'resolved']: true,
          account: acc.email,
          documentId,
          commentId,
          ...reply,
        });
      }),
  );
}
