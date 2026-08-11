import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { User } from '../../db/repo.js';
import { appendHeading, appendText, createDoc, readDoc, replaceText } from '../../google/docs.js';
import { docsClient, resolveAccount, ServiceError } from '../../service.js';
import { guard, ok } from '../reply.js';

const accountArg = z
  .string()
  .optional()
  .describe('Account owning the document. Omit when only one account is connected.');

const docArg = z
  .string()
  .describe('Document id — the long id in the Docs URL, or from search_drive.');

export function registerDocsTools(server: McpServer, user: User): void {
  server.registerTool(
    'read_doc',
    {
      title: 'Read a Google Doc',
      description:
        'Returns the plain text of a Google Doc, including text inside tables. Formatting ' +
        'is not represented — use get_drive_download_url if the user needs the styled file.',
      inputSchema: {
        documentId: docArg,
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
    async ({ documentId, maxChars, account }) =>
      guard(async () => {
        const acc = resolveAccount(user, account);
        const docs = await docsClient(acc);
        const doc = await readDoc(docs, documentId);

        const truncated = doc.text.length > maxChars;
        return ok({
          account: acc.email,
          documentId: doc.documentId,
          title: doc.title,
          characterCount: doc.text.length,
          contentTruncated: truncated,
          content: truncated
            ? `${doc.text.slice(0, maxChars)}\n\n[...truncated, ${doc.text.length - maxChars} more characters]`
            : doc.text,
        });
      }),
  );

  server.registerTool(
    'append_to_doc',
    {
      title: 'Append text to a Google Doc',
      description:
        'Adds text to the end of a document, leaving everything already there intact. This ' +
        'is the correct way to add to a Doc — write_drive_file would replace the whole file. ' +
        'Include a leading newline if you want to start a new paragraph.',
      inputSchema: {
        documentId: docArg,
        text: z.string().describe('Text to append.'),
        account: accountArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ documentId, text, account }) =>
      guard(async () => {
        if (text === '') throw new ServiceError('No text was supplied.');
        const acc = resolveAccount(user, account);
        const docs = await docsClient(acc);
        const written = await appendText(docs, documentId, text);
        return ok({ appended: true, account: acc.email, documentId, charactersAdded: written });
      }),
  );

  server.registerTool(
    'append_doc_heading',
    {
      title: 'Append a heading to a Google Doc',
      description:
        'Adds a properly styled heading at the end of the document, so the result uses real ' +
        'Google Docs heading styles and appears in the outline — not just bold text.',
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
        account: accountArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ documentId, text, level, account }) =>
      guard(async () => {
        const acc = resolveAccount(user, account);
        const docs = await docsClient(acc);
        await appendHeading(docs, documentId, text, level as 1 | 2 | 3 | 4 | 5 | 6);
        return ok({ appended: true, account: acc.email, documentId, heading: text, level });
      }),
  );

  server.registerTool(
    'replace_doc_text',
    {
      title: 'Find and replace in a Google Doc',
      description:
        'Replaces every occurrence of a string throughout the document, including inside ' +
        'tables and headers. Useful for filling placeholders in a template. Reports how ' +
        'many occurrences changed, so zero tells you the text was not found.',
      inputSchema: {
        documentId: docArg,
        find: z.string().describe('Text to search for.'),
        replace: z.string().describe('Replacement text. Empty string deletes the matches.'),
        matchCase: z.boolean().default(true).describe('Match letter case exactly.'),
        account: accountArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ documentId, find, replace, matchCase, account }) =>
      guard(async () => {
        if (find === '') throw new ServiceError('The text to find cannot be empty.');
        const acc = resolveAccount(user, account);
        const docs = await docsClient(acc);
        const changed = await replaceText(docs, documentId, find, replace, matchCase);
        return ok({
          account: acc.email,
          documentId,
          occurrencesChanged: changed,
          ...(changed === 0
            ? { note: `"${find}" does not appear in the document; nothing was changed.` }
            : {}),
        });
      }),
  );

  server.registerTool(
    'create_doc',
    {
      title: 'Create a Google Doc',
      description:
        'Creates a new document in the account\'s Drive, optionally with starting text. ' +
        'Use update_drive_file afterwards to move it into a folder.',
      inputSchema: {
        title: z.string().describe('Document title.'),
        text: z.string().optional().describe('Initial body text.'),
        account: accountArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ title, text, account }) =>
      guard(async () => {
        const acc = resolveAccount(user, account);
        const docs = await docsClient(acc);
        const doc = await createDoc(docs, title, text);
        return ok({
          created: true,
          account: acc.email,
          documentId: doc.documentId,
          title: doc.title,
          url: `https://docs.google.com/document/d/${doc.documentId}/edit`,
        });
      }),
  );
}
