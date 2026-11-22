/**
 * Pure logic for Google Docs: walking tabs, locating text, computing what to
 * delete and turning a small Markdown subset into batchUpdate requests.
 *
 * Nothing here talks to Google, so all of it is unit-tested. Every index is a
 * Docs index — UTF-16 code units, the same unit JavaScript strings use — which
 * is what lets a string offset be used as a document position directly.
 */
import type { docs_v1 } from 'googleapis';

/* ------------------------------------------------------------------ *
 * Tabs
 * ------------------------------------------------------------------ */

export interface TabInfo {
  tabId: string;
  title: string;
  /** Position among its siblings. */
  index: number;
  /** 0 for a top-level tab, 1 for a child tab, and so on. */
  depth: number;
  parentTabId: string | null;
  body: docs_v1.Schema$Body | undefined;
  lists: Record<string, docs_v1.Schema$List> | undefined;
}

/**
 * Every tab in document order, children directly after their parent. Without
 * `includeTabsContent` the API returns only the first tab's body in the legacy
 * `body` field — which is how read_doc used to miss every other tab — so a
 * document fetched without it is presented as a single tab.
 */
export function flattenTabs(doc: docs_v1.Schema$Document): TabInfo[] {
  const out: TabInfo[] = [];
  const walk = (tabs: docs_v1.Schema$Tab[] | undefined, depth: number, parent: string | null) => {
    for (const tab of tabs ?? []) {
      const p = tab.tabProperties ?? {};
      const tabId = p.tabId ?? '';
      out.push({
        tabId,
        title: p.title ?? '(untitled tab)',
        index: p.index ?? 0,
        depth,
        parentTabId: p.parentTabId ?? parent,
        body: tab.documentTab?.body,
        lists: tab.documentTab?.lists ?? undefined,
      });
      walk(tab.childTabs, depth + 1, tabId);
    }
  };
  walk(doc.tabs, 0, null);

  if (out.length === 0) {
    out.push({
      tabId: '',
      title: doc.title ?? '(untitled)',
      index: 0,
      depth: 0,
      parentTabId: null,
      body: doc.body,
      lists: doc.lists ?? undefined,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Paragraphs and text
 * ------------------------------------------------------------------ */

export interface ParagraphInfo {
  startIndex: number;
  endIndex: number;
  /** Including the trailing newline; non-text elements appear as U+FFFC. */
  text: string;
  style: string;
  /** Set when the paragraph is a list item. */
  list?: { listId: string; nestingLevel: number; ordered: boolean };
  /**
   * The body, or one table cell. A paragraph's final newline may only be
   * deleted if another paragraph follows it in the same container.
   */
  container: string;
  /** What comes directly after this paragraph in its container, if anything. */
  next: 'paragraph' | 'table' | 'other' | null;
}

/** Stands in for anything that occupies an index but is not text: images, chips, breaks. */
export const OBJECT_CHAR = '\uFFFC';

function paragraphText(p: docs_v1.Schema$Paragraph): string {
  let s = '';
  for (const el of p.elements ?? []) {
    if (el.textRun?.content != null) {
      s += el.textRun.content;
    } else {
      const len = (el.endIndex ?? 0) - (el.startIndex ?? 0);
      s += OBJECT_CHAR.repeat(Math.max(0, len));
    }
  }
  return s;
}

function isOrdered(
  lists: Record<string, docs_v1.Schema$List> | undefined,
  listId: string,
  level: number,
): boolean {
  const nl = lists?.[listId]?.listProperties?.nestingLevels?.[level];
  // Bulleted levels carry a glyphSymbol; numbered ones a glyphType such as DECIMAL.
  return !!nl?.glyphType && nl.glyphType !== 'GLYPH_TYPE_UNSPECIFIED' && nl.glyphType !== 'NONE';
}

export function listParagraphs(tab: Pick<TabInfo, 'body' | 'lists'>): ParagraphInfo[] {
  const out: ParagraphInfo[] = [];
  let cellCounter = 0;

  const walk = (content: docs_v1.Schema$StructuralElement[] | undefined, container: string) => {
    const elements = content ?? [];
    elements.forEach((el, i) => {
      if (el.paragraph) {
        const after = elements[i + 1];
        const bullet = el.paragraph.bullet;
        const level = bullet?.nestingLevel ?? 0;
        out.push({
          startIndex: el.startIndex ?? 0,
          endIndex: el.endIndex ?? 0,
          text: paragraphText(el.paragraph),
          style: el.paragraph.paragraphStyle?.namedStyleType ?? 'NORMAL_TEXT',
          ...(bullet?.listId
            ? {
                list: {
                  listId: bullet.listId,
                  nestingLevel: level,
                  ordered: isOrdered(tab.lists, bullet.listId, level),
                },
              }
            : {}),
          container,
          next: !after ? null : after.paragraph ? 'paragraph' : after.table ? 'table' : 'other',
        });
      }
      for (const row of el.table?.tableRows ?? []) {
        for (const cell of row.tableCells ?? []) {
          walk(cell.content, `cell${cellCounter++}`);
        }
      }
    });
  };
  walk(tab.body?.content, 'body');
  return out;
}

/** Plain text of a tab, tables included. */
export function tabText(tab: Pick<TabInfo, 'body' | 'lists'>): string {
  return listParagraphs(tab)
    .map((p) => p.text)
    .join('');
}

/**
 * A string in which position i holds the character at document index i, with
 * U+0000 wherever no text lives (structural markers around tables, the section
 * break at 0). A match in this string *is* a document range, and no match can
 * run across a table boundary by accident.
 */
export function indexedText(paragraphs: ParagraphInfo[]): string {
  const end = paragraphs.reduce((m, p) => Math.max(m, p.endIndex), 0);
  const chars = new Array<string>(end).fill('\u0000');
  for (const p of paragraphs) {
    for (let i = 0; i < p.text.length && p.startIndex + i < end; i++) {
      chars[p.startIndex + i] = p.text[i]!;
    }
  }
  return chars.join('');
}

/* ------------------------------------------------------------------ *
 * Finding text
 * ------------------------------------------------------------------ */

export interface TextMatch {
  startIndex: number;
  endIndex: number;
  /** What the document actually contains there. */
  text: string;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Characters that look alike but differ, which is where most "0 matches" for
 * visibly present text comes from: Docs autocorrects quotes, dashes and "..."
 * as you type, and a soft line break is \v where the reader saw a newline.
 */
function looseRegexSource(needle: string): string {
  let out = '';
  for (let i = 0; i < needle.length; i++) {
    const c = needle[i]!;
    if (needle.startsWith('...', i)) {
      out += '(?:\\.\\.\\.|…)';
      i += 2;
    } else if (c === '…') out += '(?:\\.\\.\\.|…)';
    else if ("'’‘".includes(c)) out += "['’‘]";
    else if ('"“”„'.includes(c)) out += '["“”„]';
    else if ('-–—'.includes(c)) out += '[-–—]';
    else if (c === ' ' || c === '\u00a0') out += '[ \\u00a0]';
    else if (c === '\n' || c === '\v') out += '[\\n\\v]';
    else out += escapeRegex(c);
  }
  return out;
}

export function findMatches(
  haystack: string,
  needle: string,
  opts: { matchCase?: boolean; loose?: boolean } = {},
): TextMatch[] {
  if (needle === '') return [];
  const source = opts.loose ? looseRegexSource(needle) : escapeRegex(needle);
  const re = new RegExp(source, opts.matchCase === false ? 'gi' : 'g');
  const out: TextMatch[] = [];
  for (const m of haystack.matchAll(re)) {
    out.push({ startIndex: m.index!, endIndex: m.index! + m[0].length, text: m[0] });
  }
  return out;
}

/** The paragraph containing a document index. */
export function paragraphAt(paragraphs: ParagraphInfo[], index: number): ParagraphInfo | undefined {
  return paragraphs.find((p) => index >= p.startIndex && index < p.endIndex);
}

/** Every paragraph a range touches, in document order. */
export function paragraphsIn(paragraphs: ParagraphInfo[], start: number, end: number): ParagraphInfo[] {
  return paragraphs.filter((p) => p.startIndex < end && p.endIndex > start);
}

/**
 * Why a search for visible text can come up empty, as a hint for the caller.
 * Returned only when nothing matched.
 */
export function noMatchHints(needle: string): string[] {
  const hints: string[] = [];
  if (/^\s*(\d+[.)]|[-*•])\s/m.test(needle)) {
    hints.push(
      'List numbers and bullets are formatting, not text: drop "1. " or "- " from the search.',
    );
  }
  if (/ {2}\n|\\[*_#\-.]/.test(needle)) {
    hints.push(
      'The text looks copied from a Markdown export (trailing double spaces or backslash ' +
        'escapes), which the document itself does not contain. Copy it from read_doc instead.',
    );
  }
  if (/[\n]/.test(needle)) {
    hints.push(
      'The search spans a line break. Search for a shorter piece within one paragraph.',
    );
  }
  return hints;
}

/* ------------------------------------------------------------------ *
 * Deleting
 * ------------------------------------------------------------------ */

export interface DeleteRange {
  startIndex: number;
  endIndex: number;
}

/**
 * The range that removes a paragraph entirely, so no empty paragraph or empty
 * list item is left behind.
 *
 * Normally that is the paragraph including its newline. But the last
 * paragraph of the body or of a table cell owns a newline the API will not
 * delete, and the newline right before a table cannot be deleted either — in
 * those cases the paragraph is joined onto the one before it instead, by
 * deleting that one's newline plus this one's text.
 */
export function paragraphDeleteRanges(
  selected: ParagraphInfo[],
  paragraphs: ParagraphInfo[],
): Array<DeleteRange & { leavesEmptyParagraph: boolean }> {
  const chosen = new Set(selected.map((p) => p.startIndex));
  const out: Array<DeleteRange & { leavesEmptyParagraph: boolean }> = [];

  // Adjacent selected paragraphs are removed as one block, so deleting the
  // last two paragraphs of a cell cannot leave one of them behind as an empty line.
  let k = 0;
  while (k < paragraphs.length) {
    const first = paragraphs[k]!;
    if (!chosen.has(first.startIndex)) {
      k++;
      continue;
    }
    let last = first;
    while (
      k + 1 < paragraphs.length &&
      chosen.has(paragraphs[k + 1]!.startIndex) &&
      paragraphs[k + 1]!.container === last.container &&
      paragraphs[k + 1]!.startIndex === last.endIndex
    ) {
      last = paragraphs[++k]!;
    }
    k++;

    if (last.next === 'paragraph') {
      out.push({ startIndex: first.startIndex, endIndex: last.endIndex, leavesEmptyParagraph: false });
      continue;
    }
    const prev = paragraphs.find(
      (q) => q.container === first.container && q.endIndex === first.startIndex,
    );
    if (prev && last.next === null) {
      out.push({ startIndex: prev.endIndex - 1, endIndex: last.endIndex - 1, leavesEmptyParagraph: false });
    } else {
      // Only paragraphs in their cell or body, or followed by a table: empty them.
      out.push({ startIndex: first.startIndex, endIndex: last.endIndex - 1, leavesEmptyParagraph: true });
    }
  }
  return out;
}

/**
 * Merges overlapping ranges and orders them last-first, so deleting one never
 * shifts the indices of another still to be deleted.
 */
export function normalizeDeletes(ranges: DeleteRange[]): DeleteRange[] {
  const sorted = ranges
    .filter((r) => r.endIndex > r.startIndex)
    .sort((a, b) => a.startIndex - b.startIndex);
  const merged: DeleteRange[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.startIndex <= last.endIndex) last.endIndex = Math.max(last.endIndex, r.endIndex);
    else merged.push({ ...r });
  }
  return merged.reverse();
}

/* ------------------------------------------------------------------ *
 * Markdown-lite
 * ------------------------------------------------------------------ */

export interface InlineSpan {
  start: number;
  end: number;
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  link?: string;
}

export type BlockKind = 'normal' | 'heading' | 'bullet' | 'numbered';

export interface Block {
  kind: BlockKind;
  /** Heading level 1–6, for kind 'heading'. */
  level?: number;
  /** List nesting, 0-based, for list kinds. */
  nesting?: number;
  text: string;
  spans: InlineSpan[];
}

/**
 * `**bold**`, `*italic*` / `_italic_`, `~~strike~~`, `[text](url)`, and `\`
 * to escape a marker. Markers only count when they hug a word, so "5 * 3" and
 * snake_case stay as written.
 */
export function parseInline(src: string): { text: string; spans: InlineSpan[] } {
  let text = '';
  const spans: InlineSpan[] = [];
  let i = 0;

  const closing = (marker: string, from: number): number => {
    let j = src.indexOf(marker, from);
    while (j !== -1) {
      // In "***" closing both **bold** and a nested *italic*, the bold marker
      // is the last two characters of the run.
      while (src[j + marker.length] === marker[0]) j++;
      if (src[j - 1] !== ' ' && src[j - 1] !== '\\') return j;
      j = src.indexOf(marker, j + 1);
    }
    return -1;
  };

  while (i < src.length) {
    const c = src[i]!;
    if (c === '\\' && i + 1 < src.length && /[*_~\[\]\\#()`-]/.test(src[i + 1]!)) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    const tryMarker = (marker: string, apply: Omit<InlineSpan, 'start' | 'end'>): boolean => {
      if (!src.startsWith(marker, i)) return false;
      const after = src[i + marker.length];
      if (!after || after === ' ') return false;
      // `_` inside a word (snake_case) is not emphasis.
      if (marker === '_' && i > 0 && /\w/.test(src[i - 1]!)) return false;
      const j = closing(marker, i + marker.length);
      if (j === -1 || j === i + marker.length) return false;
      if (marker === '_' && j + 1 < src.length && /\w/.test(src[j + 1]!)) return false;
      const inner = parseInline(src.slice(i + marker.length, j));
      const start = text.length;
      text += inner.text;
      spans.push({ start, end: text.length, ...apply });
      for (const s of inner.spans) spans.push({ ...s, start: s.start + start, end: s.end + start });
      i = j + marker.length;
      return true;
    };

    if (tryMarker('**', { bold: true })) continue;
    if (tryMarker('~~', { strikethrough: true })) continue;
    if (tryMarker('*', { italic: true })) continue;
    if (tryMarker('_', { italic: true })) continue;

    if (c === '[') {
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(src.slice(i));
      if (m) {
        const inner = parseInline(m[1]!);
        const start = text.length;
        text += inner.text;
        spans.push({ start, end: text.length, link: m[2]! });
        for (const s of inner.spans) spans.push({ ...s, start: s.start + start, end: s.end + start });
        i += m[0].length;
        continue;
      }
    }
    text += c;
    i++;
  }
  return { text, spans };
}

/**
 * One line, one paragraph. Blank lines only separate blocks and are dropped,
 * as in Markdown. A line ending in `\` continues on the next line after a soft
 * line break (\v), which stays inside the same paragraph or list item; a raw
 * \v in the input does the same.
 */
export function parseMarkdownLite(input: string): Block[] {
  const raw = input.replace(/\r\n?/g, '\n').split('\n');
  const lines: string[] = [];
  for (let k = 0; k < raw.length; k++) {
    let line = raw[k]!;
    while (/(?<!\\)\\$/.test(line) && k + 1 < raw.length) {
      line = `${line.slice(0, -1)}\v${raw[++k]!.trimStart()}`;
    }
    lines.push(line);
  }

  const blocks: Block[] = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^([ \t]*)[-*+]\s+(.*)$/.exec(line);
    const numbered = /^([ \t]*)\d+[.)]\s+(.*)$/.exec(line);
    const nesting = (indent: string) =>
      Math.min(8, Math.floor(indent.replace(/\t/g, '  ').length / 2));

    let block: Omit<Block, 'text' | 'spans'>;
    let body: string;
    if (heading) {
      block = { kind: 'heading', level: heading[1]!.length };
      body = heading[2]!;
    } else if (bullet) {
      block = { kind: 'bullet', nesting: nesting(bullet[1]!) };
      body = bullet[2]!;
    } else if (numbered) {
      block = { kind: 'numbered', nesting: nesting(numbered[1]!) };
      body = numbered[2]!;
    } else {
      block = { kind: 'normal' };
      body = line;
    }
    blocks.push({ ...block, ...parseInline(body) });
  }
  return blocks;
}

/** Plain mode: every line is a paragraph exactly as written, blank ones included. */
export function parsePlain(input: string): Block[] {
  return input
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((text) => ({ kind: 'normal' as const, text, spans: [] }));
}

/* ------------------------------------------------------------------ *
 * Blocks → batchUpdate requests
 * ------------------------------------------------------------------ */

export interface InsertPlan {
  /** Document index to insert at. */
  index: number;
  /** Text placed before the new paragraphs — "\n" when splitting off an existing paragraph's end. */
  prefix: '' | '\n';
  /** Text placed after them — "\n" when inserting in front of an existing paragraph. */
  suffix: '' | '\n';
  tabId?: string;
  /**
   * Leave paragraph style and list membership as inherited from the anchor,
   * e.g. to add another item to the list the anchor belongs to.
   */
  inheritStyle?: boolean;
}

export const TEXT_STYLE_RESET =
  'bold,italic,underline,strikethrough,link,backgroundColor,foregroundColor';

/**
 * Inserting text makes it inherit its surroundings: split off the end of a
 * numbered-list item and every new line becomes a list item, renumbering what
 * follows. So unless the caller wants that, the new paragraphs are explicitly
 * reset to plain NORMAL_TEXT — bullets removed, the indent that removing a
 * bullet leaves behind cleared, character formatting cleared — and only then
 * given the formatting the input asked for.
 *
 * List bullets are created last and last-first: createParagraphBullets eats
 * the leading tabs that encode nesting, which shifts every later index.
 */
export function buildInsertRequests(
  blocks: Block[],
  plan: InsertPlan,
): { requests: docs_v1.Schema$Request[]; insertedLength: number; paragraphs: number } {
  if (blocks.length === 0) throw new Error('Nothing to insert.');
  const tab = plan.tabId ? { tabId: plan.tabId } : {};
  const range = (startIndex: number, endIndex: number) => ({ startIndex, endIndex, ...tab });

  const paraText = blocks.map((b) =>
    (b.kind === 'bullet' || b.kind === 'numbered') && !plan.inheritStyle
      ? '\t'.repeat(b.nesting ?? 0) + b.text
      : b.text,
  );
  const body = paraText.join('\n');
  const inserted = plan.prefix + body + plan.suffix;
  const first = plan.index + plan.prefix.length;
  // Covers the new paragraphs including the newline that ends the last of them.
  const allEnd = first + body.length + 1;

  const requests: docs_v1.Schema$Request[] = [
    { insertText: { location: { index: plan.index, ...tab }, text: inserted } },
  ];

  if (!plan.inheritStyle) {
    if (body.length > 0) {
      requests.push({
        updateTextStyle: { range: range(first, first + body.length), textStyle: {}, fields: TEXT_STYLE_RESET },
      });
    }
    requests.push({ deleteParagraphBullets: { range: range(first, allEnd) } });
    requests.push({
      updateParagraphStyle: {
        range: range(first, allEnd),
        paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
        fields: 'namedStyleType,indentStart,indentFirstLine',
      },
    });
  }

  const starts: number[] = [];
  let pos = first;
  for (const t of paraText) {
    starts.push(pos);
    pos += t.length + 1;
  }

  blocks.forEach((b, k) => {
    const s = starts[k]!;
    const textStart = s + (paraText[k]!.length - b.text.length);
    if (b.kind === 'heading' && !plan.inheritStyle) {
      requests.push({
        updateParagraphStyle: {
          range: range(s, s + paraText[k]!.length + 1),
          paragraphStyle: { namedStyleType: `HEADING_${b.level ?? 1}` },
          fields: 'namedStyleType',
        },
      });
    }
    for (const span of b.spans) {
      if (span.end <= span.start) continue;
      const textStyle: docs_v1.Schema$TextStyle = {};
      const fields: string[] = [];
      if (span.bold) (textStyle.bold = true), fields.push('bold');
      if (span.italic) (textStyle.italic = true), fields.push('italic');
      if (span.strikethrough) (textStyle.strikethrough = true), fields.push('strikethrough');
      if (span.link) (textStyle.link = { url: span.link }), fields.push('link');
      requests.push({
        updateTextStyle: {
          range: range(textStart + span.start, textStart + span.end),
          textStyle,
          fields: fields.join(','),
        },
      });
    }
  });

  if (!plan.inheritStyle) {
    // Consecutive items of one kind form one list.
    const runs: Array<{ kind: 'bullet' | 'numbered'; from: number; to: number }> = [];
    blocks.forEach((b, k) => {
      if (b.kind !== 'bullet' && b.kind !== 'numbered') return;
      const last = runs[runs.length - 1];
      if (last && last.kind === b.kind && last.to === k - 1) last.to = k;
      else runs.push({ kind: b.kind, from: k, to: k });
    });
    for (const run of runs.reverse()) {
      requests.push({
        createParagraphBullets: {
          range: range(starts[run.from]!, starts[run.to]! + paraText[run.to]!.length + 1),
          bulletPreset:
            run.kind === 'numbered' ? 'NUMBERED_DECIMAL_ALPHA_ROMAN' : 'BULLET_DISC_CIRCLE_SQUARE',
        },
      });
    }
  }

  return { requests, insertedLength: inserted.length, paragraphs: blocks.length };
}

/**
 * Where an append goes. Text always starts a paragraph of its own: inserting
 * before the final newline of a non-empty last paragraph would otherwise glue
 * the text onto it — and an appended heading would restyle that paragraph,
 * which is the bug append_doc_heading used to have. An empty last paragraph
 * is filled instead, so repeated appends do not leave gaps.
 */
export function appendPlan(paragraphs: ParagraphInfo[], tabId?: string): InsertPlan {
  const body = paragraphs.filter((p) => p.container === 'body');
  const last = body[body.length - 1];
  if (!last) return { index: 1, prefix: '', suffix: '', ...(tabId ? { tabId } : {}) };
  const empty = last.text === '\n';
  return {
    index: last.endIndex - 1,
    prefix: empty ? '' : '\n',
    suffix: '',
    ...(tabId ? { tabId } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Exports
 * ------------------------------------------------------------------ */

/**
 * Google's Markdown and HTML exports inline every image as a base64 data URI;
 * one screenshot was 62k characters, which pushed the actual text past the
 * truncation limit. Each is replaced with a short placeholder naming its size.
 */
export function stripDataUris(text: string): { text: string; removed: number; removedChars: number } {
  let removed = 0;
  let removedChars = 0;
  const out = text.replace(
    /data:([a-z]+\/[a-z0-9.+-]+);base64,[A-Za-z0-9+/=]+/gi,
    (m, mime: string) => {
      removed++;
      removedChars += m.length;
      const kb = Math.round((m.length * 3) / 4 / 1024);
      return `[image removed: ${mime}, ~${kb} kB]`;
    },
  );
  return { text: out, removed, removedChars };
}
