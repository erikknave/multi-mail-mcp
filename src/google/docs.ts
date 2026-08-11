import { google, type docs_v1 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';

export function docsFor(auth: OAuth2Client): docs_v1.Docs {
  return google.docs({ version: 'v1', auth });
}

export interface DocInfo {
  documentId: string;
  title: string;
  /** Character index one past the last content element. */
  endIndex: number;
  text: string;
}

function extractText(body: docs_v1.Schema$Body | undefined): string {
  let out = '';
  for (const element of body?.content ?? []) {
    for (const run of element.paragraph?.elements ?? []) {
      out += run.textRun?.content ?? '';
    }
    // Table cells hold their own nested paragraphs.
    for (const row of element.table?.tableRows ?? []) {
      for (const cell of row.tableCells ?? []) {
        for (const cellElement of cell.content ?? []) {
          for (const run of cellElement.paragraph?.elements ?? []) {
            out += run.textRun?.content ?? '';
          }
        }
      }
    }
  }
  return out;
}

/**
 * The last content element's endIndex points just past the document's final
 * newline. Inserting there is rejected, so text must go one index earlier —
 * the single most common way Docs API insertions fail.
 */
function insertionIndex(doc: docs_v1.Schema$Document): number {
  const content = doc.body?.content ?? [];
  const last = content[content.length - 1];
  const end = last?.endIndex ?? 1;
  return Math.max(1, end - 1);
}

export async function readDoc(docs: docs_v1.Docs, documentId: string): Promise<DocInfo> {
  const res = await docs.documents.get({ documentId });
  const content = res.data.body?.content ?? [];
  return {
    documentId: res.data.documentId ?? documentId,
    title: res.data.title ?? '(untitled)',
    endIndex: content[content.length - 1]?.endIndex ?? 1,
    text: extractText(res.data.body),
  };
}

export async function appendText(
  docs: docs_v1.Docs,
  documentId: string,
  text: string,
): Promise<number> {
  const doc = await docs.documents.get({ documentId, fields: 'body.content.endIndex' });
  const index = insertionIndex(doc.data);

  await docs.documents.batchUpdate({
    documentId,
    requestBody: { requests: [{ insertText: { location: { index }, text } }] },
  });
  return text.length;
}

export async function replaceText(
  docs: docs_v1.Docs,
  documentId: string,
  find: string,
  replace: string,
  matchCase: boolean,
): Promise<number> {
  const res = await docs.documents.batchUpdate({
    documentId,
    requestBody: {
      requests: [{ replaceAllText: { containsText: { text: find, matchCase }, replaceText: replace } }],
    },
  });
  return res.data.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0;
}

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

/**
 * Appends a heading. The text and its paragraph style are applied in one batch
 * so the document is never briefly left with an unstyled paragraph.
 */
export async function appendHeading(
  docs: docs_v1.Docs,
  documentId: string,
  text: string,
  level: HeadingLevel,
): Promise<void> {
  const doc = await docs.documents.get({ documentId, fields: 'body.content.endIndex' });
  const index = insertionIndex(doc.data);
  const withNewline = `${text}\n`;

  await docs.documents.batchUpdate({
    documentId,
    requestBody: {
      requests: [
        { insertText: { location: { index }, text: withNewline } },
        {
          updateParagraphStyle: {
            range: { startIndex: index, endIndex: index + withNewline.length },
            paragraphStyle: { namedStyleType: `HEADING_${level}` },
            fields: 'namedStyleType',
          },
        },
      ],
    },
  });
}

export async function createDoc(
  docs: docs_v1.Docs,
  title: string,
  initialText?: string,
): Promise<DocInfo> {
  const created = await docs.documents.create({ requestBody: { title } });
  const documentId = created.data.documentId;
  if (!documentId) throw new Error('Google did not return a document id');

  if (initialText) {
    await docs.documents.batchUpdate({
      documentId,
      requestBody: { requests: [{ insertText: { location: { index: 1 }, text: initialText } }] },
    });
  }

  return readDoc(docs, documentId);
}
