import { google, type docs_v1 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { ServiceError } from '../serviceError.js';
import {
  appendPlan,
  buildInsertRequests,
  findMatches,
  findObject,
  flattenTabs,
  tabObjects,
  type EmbeddedObjectInfo,
  indexedText,
  listParagraphs,
  noMatchHints,
  normalizeDeletes,
  paragraphDeleteRanges,
  paragraphsIn,
  tabText,
  type Block,
  type DeleteRange,
  type ParagraphInfo,
  type TabInfo,
  type TextMatch,
} from './docsModel.js';
import { hexToColor } from './sheets.js';

export function docsFor(auth: OAuth2Client): docs_v1.Docs {
  return google.docs({ version: 'v1', auth });
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

/**
 * Always with includeTabsContent: without it the API returns only the first
 * tab, silently, and anything in another tab looks absent.
 */
export async function getDocument(
  docs: docs_v1.Docs,
  documentId: string,
): Promise<docs_v1.Schema$Document> {
  const res = await docs.documents.get({ documentId, includeTabsContent: true });
  return res.data;
}

export function describeTabs(tabs: TabInfo[]) {
  return tabs.map((t) => ({
    tabId: t.tabId,
    title: t.title,
    index: t.index,
    depth: t.depth,
    ...(t.parentTabId ? { parentTabId: t.parentTabId } : {}),
    characterCount: tabText(t).length,
    ...objectCounts(t),
  }));
}

function objectCounts(t: TabInfo) {
  const objects = tabObjects(t);
  const images = objects.filter((o) => o.kind === 'image').length;
  const drawings = objects.filter((o) => o.kind === 'drawing').length;
  return { ...(images ? { images } : {}), ...(drawings ? { drawings } : {}) };
}

/* ------------------------------------------------------------------ *
 * Images
 * ------------------------------------------------------------------ */

/** Beyond this the image is refused rather than sent: ~5 MB once base64-encoded. */
export const MAX_IMAGE_BYTES = 3_750_000;

export interface DocImage {
  tabId: string;
  tabTitle: string;
  object: EmbeddedObjectInfo;
  mimeType: string;
  bytes: number;
  data: Buffer;
  /** Crop as stored in the document; the bytes are the uncropped original. */
  crop?: docs_v1.Schema$CropProperties;
}

/**
 * The bytes of an image in a Doc. contentUri is a short-lived URL tied to the
 * requesting account, so it is fetched here, server-side, with that account's
 * credentials, and never handed out. Drawings have no contentUri: the Docs API
 * does not expose them as images at all.
 */
export async function fetchDocImage(
  docs: docs_v1.Docs,
  auth: OAuth2Client,
  documentId: string,
  objectId: string,
  tabId?: string,
): Promise<DocImage> {
  const doc = await getDocument(docs, documentId);
  const tabs = flattenTabs(doc);
  const scope = tabId ? [pickTab(tabs, tabId)] : tabs;
  const found = findObject(scope, objectId);
  if (!found) {
    const known = scope.flatMap((t) => tabObjects(t).map((o) => o.objectId));
    throw new ServiceError(
      `No image or drawing "${objectId}" in ${tabId ? 'that tab' : 'this document'}. ` +
        (known.length
          ? `Object ids there: ${known.slice(0, 20).join(', ')}${known.length > 20 ? ', …' : ''}.`
          : 'It contains no images or drawings.') +
        ' Ids appear in read_doc placeholders such as [image: kix.…].',
    );
  }
  const info = tabObjects(found.tab).find((o) => o.objectId === objectId)!;
  if (info.kind === 'drawing') {
    throw new ServiceError(
      `"${objectId}" is a drawing (Insert → Drawing), not an image. The Docs API does not ` +
        'expose drawings as pictures, so it cannot be fetched here. To see it, export the ' +
        'document as PDF with get_drive_download_url (exportAs "application/pdf") and look at ' +
        'the page.',
    );
  }
  const uri = found.embedded?.imageProperties?.contentUri;
  if (!uri) {
    throw new ServiceError(
      `"${objectId}" has no image data Google will hand out (kind: ${info.kind}). Export the ` +
        'document as PDF with get_drive_download_url to see it.',
    );
  }
  const res = await auth.request<ArrayBuffer>({ url: uri, responseType: 'arraybuffer' });
  const data = Buffer.from(res.data);
  const mimeType = String(res.headers?.['content-type'] ?? 'image/png').split(';')[0]!.trim();
  if (data.length > MAX_IMAGE_BYTES) {
    throw new ServiceError(
      `The image is ${Math.round(data.length / 1024)} kB, over the ${Math.round(MAX_IMAGE_BYTES / 1024)} kB ` +
        'this tool returns. Export the document as PDF with get_drive_download_url instead.',
    );
  }
  const crop = found.embedded?.imageProperties?.cropProperties;
  const cropped = crop && Object.values(crop).some((v) => typeof v === 'number' && v !== 0);
  return {
    tabId: found.tab.tabId,
    tabTitle: found.tab.title,
    object: info,
    mimeType,
    bytes: data.length,
    data,
    ...(cropped ? { crop } : {}),
  };
}

/** The named tab, or the first one. An unknown id lists the real ones. */
export function pickTab(tabs: TabInfo[], tabId?: string): TabInfo {
  if (!tabId) return tabs[0]!;
  const tab = tabs.find((t) => t.tabId === tabId);
  if (!tab) {
    throw new ServiceError(
      `This document has no tab "${tabId}". Its tabs are: ` +
        tabs.map((t) => `${t.tabId} ("${t.title}")`).join(', ') +
        '.',
    );
  }
  return tab;
}

/* ------------------------------------------------------------------ *
 * Writing, with the revision guard
 * ------------------------------------------------------------------ */

export interface WriteResult {
  revisionId: string | null;
  replies: docs_v1.Schema$Response[];
}

function isRevisionMismatch(err: unknown): boolean {
  return /does not match the latest revision/i.test((err as { message?: string })?.message ?? '');
}

function staleError(required: string): ServiceError {
  return new ServiceError(
    `REVISION MISMATCH — the document has changed since revision ${required}, so nothing ` +
      'was written. Someone else (or another edit of yours) got there first. Call read_doc ' +
      'again, check that your change still makes sense against the current text, then ' +
      'retry with the new revisionId.',
  );
}

export async function batch(
  docs: docs_v1.Docs,
  documentId: string,
  requests: docs_v1.Schema$Request[],
  requiredRevisionId?: string,
): Promise<WriteResult> {
  try {
    const res = await docs.documents.batchUpdate({
      documentId,
      requestBody: {
        requests,
        ...(requiredRevisionId ? { writeControl: { requiredRevisionId } } : {}),
      },
    });
    return {
      revisionId: res.data.writeControl?.requiredRevisionId ?? null,
      replies: res.data.replies ?? [],
    };
  } catch (err) {
    if (requiredRevisionId && isRevisionMismatch(err)) throw staleError(requiredRevisionId);
    throw err;
  }
}

/**
 * Read, compute index-based requests, write — with the write pinned to the
 * revision that was read. Indices computed from a document that has since
 * changed would land in the wrong place, which is worse than failing. If the
 * caller supplied no revision of their own, a lost race is retried once on a
 * fresh read; if they did, it is reported, because their intent was based on
 * text that is no longer there.
 */
async function readModifyWrite<T>(
  docs: docs_v1.Docs,
  documentId: string,
  requiredRevisionId: string | undefined,
  plan: (doc: docs_v1.Schema$Document) => { requests: docs_v1.Schema$Request[]; result: T },
): Promise<T & { revisionId: string | null }> {
  for (let attempt = 0; ; attempt++) {
    const doc = await getDocument(docs, documentId);
    if (requiredRevisionId && doc.revisionId !== requiredRevisionId) {
      throw staleError(requiredRevisionId);
    }
    const { requests, result } = plan(doc);
    try {
      const written = await batch(docs, documentId, requests, doc.revisionId ?? undefined);
      return { ...result, revisionId: written.revisionId };
    } catch (err) {
      const raced = err instanceof ServiceError && err.message.startsWith('REVISION MISMATCH');
      if (raced && !requiredRevisionId && attempt === 0) continue;
      throw err;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Locating text
 * ------------------------------------------------------------------ */

export interface Located {
  tab: TabInfo;
  match: TextMatch;
  paragraphs: ParagraphInfo[];
  all: ParagraphInfo[];
}

export interface LocateOptions {
  tabId?: string;
  matchCase?: boolean;
  /** 1-based; required when the text occurs more than once, unless `all`. */
  occurrence?: number;
  all?: boolean;
}

function snippet(p: ParagraphInfo | undefined): string {
  const t = (p?.text ?? '').replace(/\n$/, '').replace(/\v/g, ' ');
  return t.length > 80 ? `${t.slice(0, 77)}...` : t;
}

/**
 * Finds text in one tab or all of them. Exact first; only if that finds
 * nothing, again treating look-alike characters as equal (curly vs straight
 * quotes, … vs ..., dashes, non-breaking spaces, soft vs hard line breaks) —
 * flagged as `loose` so the caller can see what actually matched.
 */
export function locate(
  doc: docs_v1.Schema$Document,
  needle: string,
  opts: LocateOptions,
): { found: Located[]; loose: boolean; total: number } {
  const tabs = flattenTabs(doc);
  const scope = opts.tabId ? [pickTab(tabs, opts.tabId)] : tabs;

  const search = (loose: boolean): Located[] =>
    scope.flatMap((tab) => {
      const all = listParagraphs(tab);
      const hay = indexedText(all);
      return findMatches(hay, needle, { matchCase: opts.matchCase, loose }).map((match) => ({
        tab,
        match,
        paragraphs: paragraphsIn(all, match.startIndex, match.endIndex),
        all,
      }));
    });

  let loose = false;
  let found = search(false);
  if (found.length === 0) {
    found = search(true);
    loose = found.length > 0;
  }

  const where = opts.tabId ? 'in that tab' : 'in any tab';
  if (found.length === 0) {
    const hints = noMatchHints(needle);
    throw new ServiceError(
      `"${needle}" was not found ${where}, not even ignoring quote, dash and ellipsis ` +
        `variants. Nothing was changed.${hints.length ? ` ${hints.join(' ')}` : ''}`,
    );
  }

  const total = found.length;
  if (opts.all) return { found, loose, total };
  if (opts.occurrence) {
    const one = found[opts.occurrence - 1];
    if (!one) {
      throw new ServiceError(
        `Only ${total} occurrence(s) of "${needle}" exist ${where}; occurrence ` +
          `${opts.occurrence} does not. Nothing was changed.`,
      );
    }
    return { found: [one], loose, total };
  }
  if (total > 1) {
    const list = found
      .slice(0, 6)
      .map((f, i) => `${i + 1}) [${f.tab.title}] "${snippet(f.paragraphs[0])}"`)
      .join('; ');
    throw new ServiceError(
      `AMBIGUOUS — "${needle}" occurs ${total} times ${where}: ${list}${total > 6 ? '; …' : ''}. ` +
        'Nothing was changed. Pass occurrence (1-based, in document order), a longer ' +
        'search text, a tabId, or all: true.',
    );
  }
  return { found, loose, total };
}

function describeMatch(l: Located) {
  return {
    tabId: l.tab.tabId,
    tabTitle: l.tab.title,
    startIndex: l.match.startIndex,
    endIndex: l.match.endIndex,
    matchedText: l.match.text,
  };
}

/* ------------------------------------------------------------------ *
 * Operations
 * ------------------------------------------------------------------ */

export interface WriteOptions {
  tabId?: string;
  requiredRevisionId?: string;
}

export async function appendBlocks(
  docs: docs_v1.Docs,
  documentId: string,
  blocks: Block[],
  opts: WriteOptions,
) {
  return readModifyWrite(docs, documentId, opts.requiredRevisionId, (doc) => {
    const tab = pickTab(flattenTabs(doc), opts.tabId);
    const plan = appendPlan(listParagraphs(tab), tab.tabId || undefined);
    const built = buildInsertRequests(blocks, plan);
    return {
      requests: built.requests,
      result: { tabId: tab.tabId, tabTitle: tab.title, paragraphsAdded: built.paragraphs },
    };
  });
}

export async function insertAtAnchor(
  docs: docs_v1.Docs,
  documentId: string,
  anchor: string,
  blocks: Block[],
  opts: WriteOptions &
    Omit<LocateOptions, 'all'> & { position: 'after' | 'before'; inheritStyle?: boolean },
) {
  return readModifyWrite(docs, documentId, opts.requiredRevisionId, (doc) => {
    const { found, loose, total } = locate(doc, anchor, { ...opts, all: false });
    const hit = found[0]!;
    const tabId = hit.tab.tabId || undefined;
    // An anchor spanning paragraphs: insert after the last one it touches, or
    // before the first.
    const para =
      opts.position === 'after' ? hit.paragraphs[hit.paragraphs.length - 1]! : hit.paragraphs[0]!;
    const plan =
      opts.position === 'after'
        ? { index: para.endIndex - 1, prefix: '\n' as const, suffix: '' as const, tabId }
        : { index: para.startIndex, prefix: '' as const, suffix: '\n' as const, tabId };
    const built = buildInsertRequests(blocks, { ...plan, inheritStyle: opts.inheritStyle });
    return {
      requests: built.requests,
      result: {
        anchor: { ...describeMatch(hit), paragraph: snippet(para), occurrencesOfAnchor: total },
        ...(loose ? { matchedLoosely: true } : {}),
        paragraphsAdded: built.paragraphs,
      },
    };
  });
}

export async function deleteText(
  docs: docs_v1.Docs,
  documentId: string,
  find: string,
  opts: WriteOptions & LocateOptions & { mode: 'paragraph' | 'text' },
) {
  return readModifyWrite(docs, documentId, opts.requiredRevisionId, (doc) => {
    const { found, loose, total } = locate(doc, find, opts);
    const requests: docs_v1.Schema$Request[] = [];
    const deleted: Array<{ tabTitle: string; text: string }> = [];
    let leftEmpty = 0;

    // Grouped per tab: deleting in one tab never shifts another tab's indices.
    const byTab = new Map<TabInfo, Located[]>();
    for (const f of found) byTab.set(f.tab, [...(byTab.get(f.tab) ?? []), f]);

    for (const [tab, hits] of byTab) {
      let ranges: DeleteRange[];
      if (opts.mode === 'paragraph') {
        const selected = [
          ...new Map(hits.flatMap((h) => h.paragraphs).map((p) => [p.startIndex, p])).values(),
        ];
        const computed = paragraphDeleteRanges(selected, hits[0]!.all);
        leftEmpty += computed.filter((r) => r.leavesEmptyParagraph).length;
        ranges = computed;
        for (const p of selected) deleted.push({ tabTitle: tab.title, text: snippet(p) });
      } else {
        ranges = hits.map((h) => ({ startIndex: h.match.startIndex, endIndex: h.match.endIndex }));
        for (const h of hits) deleted.push({ tabTitle: tab.title, text: h.match.text });
      }
      for (const r of normalizeDeletes(ranges)) {
        requests.push({
          deleteContentRange: {
            range: {
              startIndex: r.startIndex,
              endIndex: r.endIndex,
              ...(tab.tabId ? { tabId: tab.tabId } : {}),
            },
          },
        });
      }
    }

    return {
      requests,
      result: {
        occurrencesFound: total,
        deleted,
        ...(loose ? { matchedLoosely: true } : {}),
        ...(leftEmpty
          ? {
              note:
                `${leftEmpty} paragraph(s) were emptied rather than removed: the API cannot ` +
                'remove the only paragraph of a table cell or document, or the line right ' +
                'before a table.',
            }
          : {}),
      },
    };
  });
}

export interface TextFormat {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  /** Hex, e.g. #d93025. Empty string clears it. */
  color?: string;
  /** Hex background, e.g. #fff475. Empty string clears it. */
  highlight?: string;
}

export function textStyleFor(f: TextFormat): { textStyle: docs_v1.Schema$TextStyle; fields: string } {
  const textStyle: docs_v1.Schema$TextStyle = {};
  const fields: string[] = [];
  for (const key of ['bold', 'italic', 'underline', 'strikethrough'] as const) {
    if (f[key] !== undefined) {
      textStyle[key] = f[key];
      fields.push(key);
    }
  }
  const colour = (hex: string) => ({ color: { rgbColor: hexToColor(hex) } });
  if (f.color !== undefined) {
    if (f.color) textStyle.foregroundColor = colour(f.color);
    fields.push('foregroundColor');
  }
  if (f.highlight !== undefined) {
    if (f.highlight) textStyle.backgroundColor = colour(f.highlight);
    fields.push('backgroundColor');
  }
  return { textStyle, fields: fields.join(',') };
}

export async function formatText(
  docs: docs_v1.Docs,
  documentId: string,
  find: string,
  format: TextFormat,
  opts: WriteOptions & LocateOptions,
) {
  const { textStyle, fields } = textStyleFor(format);
  if (!fields) throw new ServiceError('No formatting was given — set at least one property.');
  return readModifyWrite(docs, documentId, opts.requiredRevisionId, (doc) => {
    const { found, loose, total } = locate(doc, find, opts);
    return {
      requests: found.map((f) => ({
        updateTextStyle: {
          range: {
            startIndex: f.match.startIndex,
            endIndex: f.match.endIndex,
            ...(f.tab.tabId ? { tabId: f.tab.tabId } : {}),
          },
          textStyle,
          fields,
        },
      })),
      result: {
        occurrencesFound: total,
        formatted: found.map(describeMatch),
        ...(loose ? { matchedLoosely: true } : {}),
      },
    };
  });
}

export async function replaceText(
  docs: docs_v1.Docs,
  documentId: string,
  find: string,
  replace: string,
  matchCase: boolean,
  opts: WriteOptions,
): Promise<{ occurrencesChanged: number; revisionId: string | null }> {
  const res = await batch(
    docs,
    documentId,
    [
      {
        replaceAllText: {
          containsText: { text: find, matchCase },
          replaceText: replace,
          // Without tabsCriteria the replacement runs in every tab.
          ...(opts.tabId ? { tabsCriteria: { tabIds: [opts.tabId] } } : {}),
        },
      },
    ],
    opts.requiredRevisionId,
  );
  return {
    occurrencesChanged: res.replies[0]?.replaceAllText?.occurrencesChanged ?? 0,
    revisionId: res.revisionId,
  };
}

export async function addTab(
  docs: docs_v1.Docs,
  documentId: string,
  opts: { title?: string; parentTabId?: string; index?: number; requiredRevisionId?: string },
): Promise<{ tabId: string; title: string; index: number | null; revisionId: string | null }> {
  // addDocumentTab postdates the googleapis typings this project pins, hence the cast.
  const request = {
    addDocumentTab: {
      tabProperties: {
        ...(opts.title ? { title: opts.title } : {}),
        ...(opts.parentTabId ? { parentTabId: opts.parentTabId } : {}),
        ...(opts.index !== undefined ? { index: opts.index } : {}),
      },
    },
  } as docs_v1.Schema$Request;
  const res = await batch(docs, documentId, [request], opts.requiredRevisionId);
  const reply = (
    res.replies[0] as { addDocumentTab?: { tabProperties?: docs_v1.Schema$TabProperties } }
  )?.addDocumentTab?.tabProperties;
  if (!reply?.tabId) throw new Error('Google did not return the new tab id');
  return {
    tabId: reply.tabId,
    title: reply.title ?? opts.title ?? '',
    index: reply.index ?? null,
    revisionId: res.revisionId,
  };
}

/** Fills a tab that was just created and so holds one empty paragraph. */
export async function fillNewTab(
  docs: docs_v1.Docs,
  documentId: string,
  tabId: string,
  blocks: Block[],
): Promise<string | null> {
  const built = buildInsertRequests(blocks, { index: 1, prefix: '', suffix: '', tabId });
  return (await batch(docs, documentId, built.requests)).revisionId;
}

export async function createDoc(
  docs: docs_v1.Docs,
  title: string,
  blocks?: Block[],
): Promise<{ documentId: string; title: string; revisionId: string | null }> {
  const created = await docs.documents.create({ requestBody: { title } });
  const documentId = created.data.documentId;
  if (!documentId) throw new Error('Google did not return a document id');

  let revisionId = created.data.revisionId ?? null;
  if (blocks && blocks.length > 0) {
    // A new document is a single empty paragraph: fill it.
    const built = buildInsertRequests(blocks, { index: 1, prefix: '', suffix: '' });
    revisionId = (await batch(docs, documentId, built.requests)).revisionId;
  }
  return { documentId, title: created.data.title ?? title, revisionId };
}
