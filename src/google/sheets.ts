import { google, type sheets_v4 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';

export function sheetsFor(auth: OAuth2Client): sheets_v4.Sheets {
  return google.sheets({ version: 'v4', auth });
}

/* ------------------------------------------------------------------ *
 * A1 notation
 * ------------------------------------------------------------------ */

/** Column letters to a zero-based index: A → 0, Z → 25, AA → 26. */
export function columnToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

export function indexToColumn(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export interface ParsedA1 {
  /** Tab name if the range named one, e.g. "Jul 2026" from "'Jul 2026'!A1:C5". */
  tabName: string | null;
  startRowIndex?: number;
  endRowIndex?: number;
  startColumnIndex?: number;
  endColumnIndex?: number;
}

/**
 * Parses A1 notation into the half-open, zero-based indices the Sheets API's
 * GridRange wants. Getting this wrong shifts formatting by a row or column
 * without any error, so the edge cases are handled explicitly:
 *
 *   Sheet1!B2:D10   rows 1..10, columns 1..4
 *   B2              a single cell
 *   A:C             whole columns, rows unbounded
 *   2:5             whole rows, columns unbounded
 *   Sheet1          the entire tab
 */
export function parseA1(range: string): ParsedA1 {
  const input = range.trim();
  if (input === '') return { tabName: null };

  let tabName: string | null = null;
  let rest = input;

  if (input.startsWith("'")) {
    // Quoted tab name: scan to the closing quote, where '' is an escaped quote.
    let i = 1;
    let name = '';
    for (; i < input.length; i++) {
      if (input[i] === "'") {
        if (input[i + 1] === "'") { name += "'"; i++; continue; }
        break;
      }
      name += input[i];
    }
    if (i >= input.length) throw new Error(`Unterminated tab name in "${range}".`);
    tabName = name;
    rest = input.slice(i + 1);
    if (rest.startsWith('!')) rest = rest.slice(1);
    else if (rest !== '') throw new Error(`Could not understand the range "${range}".`);
  } else {
    // Unquoted: the FIRST '!' separates tab from cells. Using the last one would
    // let trailing junk be swallowed into the tab name instead of rejected.
    const bang = input.indexOf('!');
    if (bang !== -1) {
      tabName = input.slice(0, bang).trim();
      rest = input.slice(bang + 1).trim();
    }
  }

  if (rest === '') return { tabName };

  const cell = /^([A-Za-z]*)(\d*)$/;
  const parts = rest.split(':');
  if (parts.length > 2) throw new Error(`Could not understand the range "${range}".`);

  // An unqualified single token is ambiguous: "A1" is a cell, but "Log" and
  // "Sheet1" are tab names. Only a realistic cell reference — at most three
  // column letters followed by digits — is read as a cell; anything else is a
  // name. Without this, "Log" silently becomes column 8508.
  if (tabName === null && parts.length === 1) {
    const single = cell.exec(rest);
    const looksLikeCell = single && (single[1] ?? '').length <= 3 && (single[2] ?? '') !== '';
    if (!looksLikeCell) return { tabName: rest };
  }

  const start = cell.exec(parts[0] ?? '');
  const end = parts[1] === undefined ? start : cell.exec(parts[1]);

  if (!start || !end || (parts[0] === '' ) || (parts[1] !== undefined && parts[1] === '')) {
    // A bare unquoted string that is not a cell reference is a tab name —
    // "Jun 2026" means the whole tab, not a malformed cell.
    if (tabName === null) return { tabName: input };
    throw new Error(`Could not understand the range "${range}".`);
  }

  const out: ParsedA1 = { tabName };
  const startCol = start[1] ?? '';
  const endCol = end[1] ?? '';
  const startRow = start[2] ?? '';
  const endRow = end[2] ?? '';

  if (startCol) out.startColumnIndex = columnToIndex(startCol);
  if (endCol) out.endColumnIndex = columnToIndex(endCol) + 1;
  if (startRow) out.startRowIndex = Number(startRow) - 1;
  if (endRow) out.endRowIndex = Number(endRow);

  return out;
}

/* ------------------------------------------------------------------ *
 * Spreadsheet structure
 * ------------------------------------------------------------------ */

export interface TabInfo {
  sheetId: number;
  title: string;
  index: number;
  rowCount: number;
  columnCount: number;
  frozenRowCount: number;
  frozenColumnCount: number;
  hidden: boolean;
}

export interface SpreadsheetInfo {
  spreadsheetId: string;
  title: string;
  locale: string | null;
  timeZone: string | null;
  url: string | null;
  tabs: TabInfo[];
}

export async function getSpreadsheet(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
): Promise<SpreadsheetInfo> {
  const res = await sheets.spreadsheets.get({
    spreadsheetId,
    fields:
      'spreadsheetId, spreadsheetUrl, properties(title,locale,timeZone), ' +
      'sheets.properties(sheetId,title,index,hidden,gridProperties)',
  });

  return {
    spreadsheetId: res.data.spreadsheetId ?? spreadsheetId,
    title: res.data.properties?.title ?? '(untitled)',
    locale: res.data.properties?.locale ?? null,
    timeZone: res.data.properties?.timeZone ?? null,
    url: res.data.spreadsheetUrl ?? null,
    tabs: (res.data.sheets ?? []).map((s) => ({
      sheetId: s.properties?.sheetId ?? 0,
      title: s.properties?.title ?? '',
      index: s.properties?.index ?? 0,
      rowCount: s.properties?.gridProperties?.rowCount ?? 0,
      columnCount: s.properties?.gridProperties?.columnCount ?? 0,
      frozenRowCount: s.properties?.gridProperties?.frozenRowCount ?? 0,
      frozenColumnCount: s.properties?.gridProperties?.frozenColumnCount ?? 0,
      hidden: s.properties?.hidden ?? false,
    })),
  };
}

/** Finds a tab by name or numeric id, so callers can use whichever they have. */
export function findTab(info: SpreadsheetInfo, tab: string | number): TabInfo {
  const found =
    typeof tab === 'number'
      ? info.tabs.find((t) => t.sheetId === tab)
      : info.tabs.find((t) => t.title === tab) ??
        info.tabs.find((t) => t.title.toLowerCase() === String(tab).toLowerCase());

  if (!found) {
    throw new Error(
      `"${tab}" is not a tab in "${info.title}". Available: ${info.tabs.map((t) => t.title).join(', ')}.`,
    );
  }
  return found;
}

async function batch(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  requests: sheets_v4.Schema$Request[],
): Promise<sheets_v4.Schema$BatchUpdateSpreadsheetResponse> {
  const res = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests },
  });
  return res.data;
}

/**
 * Copies a tab within the same spreadsheet, keeping formatting, formulas,
 * conditional formatting, column widths and frozen rows. This is the only way
 * to duplicate a tab: writing the file through Drive would replace the whole
 * workbook and destroy every other tab.
 */
export async function duplicateTab(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sourceSheetId: number,
  newTitle: string,
  insertIndex?: number,
): Promise<TabInfo> {
  const res = await batch(sheets, spreadsheetId, [
    {
      duplicateSheet: {
        sourceSheetId,
        newSheetName: newTitle,
        ...(insertIndex !== undefined ? { insertSheetIndex: insertIndex } : {}),
      },
    },
  ]);

  const props = res.replies?.[0]?.duplicateSheet?.properties;
  return {
    sheetId: props?.sheetId ?? 0,
    title: props?.title ?? newTitle,
    index: props?.index ?? 0,
    rowCount: props?.gridProperties?.rowCount ?? 0,
    columnCount: props?.gridProperties?.columnCount ?? 0,
    frozenRowCount: props?.gridProperties?.frozenRowCount ?? 0,
    frozenColumnCount: props?.gridProperties?.frozenColumnCount ?? 0,
    hidden: props?.hidden ?? false,
  };
}

export async function addTab(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  title: string,
  opts: { rows?: number; columns?: number; index?: number } = {},
): Promise<TabInfo> {
  const res = await batch(sheets, spreadsheetId, [
    {
      addSheet: {
        properties: {
          title,
          ...(opts.index !== undefined ? { index: opts.index } : {}),
          gridProperties: {
            rowCount: opts.rows ?? 1000,
            columnCount: opts.columns ?? 26,
          },
        },
      },
    },
  ]);

  const props = res.replies?.[0]?.addSheet?.properties;
  return {
    sheetId: props?.sheetId ?? 0,
    title: props?.title ?? title,
    index: props?.index ?? 0,
    rowCount: props?.gridProperties?.rowCount ?? 0,
    columnCount: props?.gridProperties?.columnCount ?? 0,
    frozenRowCount: 0,
    frozenColumnCount: 0,
    hidden: false,
  };
}

export async function renameTab(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetId: number,
  newTitle: string,
): Promise<void> {
  await batch(sheets, spreadsheetId, [
    {
      updateSheetProperties: {
        properties: { sheetId, title: newTitle },
        fields: 'title',
      },
    },
  ]);
}

export async function deleteTab(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetId: number,
): Promise<void> {
  await batch(sheets, spreadsheetId, [{ deleteSheet: { sheetId } }]);
}

export async function reorderTab(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetId: number,
  newIndex: number,
): Promise<void> {
  await batch(sheets, spreadsheetId, [
    {
      updateSheetProperties: {
        properties: { sheetId, index: newIndex },
        fields: 'index',
      },
    },
  ]);
}

export async function setFrozenRows(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetId: number,
  frozenRowCount: number,
  frozenColumnCount?: number,
): Promise<void> {
  await batch(sheets, spreadsheetId, [
    {
      updateSheetProperties: {
        properties: {
          sheetId,
          gridProperties: {
            frozenRowCount,
            ...(frozenColumnCount !== undefined ? { frozenColumnCount } : {}),
          },
        },
        fields:
          'gridProperties.frozenRowCount' +
          (frozenColumnCount !== undefined ? ',gridProperties.frozenColumnCount' : ''),
      },
    },
  ]);
}

export async function autoResizeColumns(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetId: number,
  startColumnIndex: number,
  endColumnIndex: number,
): Promise<void> {
  await batch(sheets, spreadsheetId, [
    {
      autoResizeDimensions: {
        dimensions: { sheetId, dimension: 'COLUMNS', startIndex: startColumnIndex, endIndex: endColumnIndex },
      },
    },
  ]);
}

/* ------------------------------------------------------------------ *
 * Values
 * ------------------------------------------------------------------ */

export type CellValue = string | number | boolean | null;

export async function readRange(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  range: string,
  opts: { formulas?: boolean; unformatted?: boolean } = {},
): Promise<{ range: string; values: CellValue[][] }> {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
    valueRenderOption: opts.formulas
      ? 'FORMULA'
      : opts.unformatted
        ? 'UNFORMATTED_VALUE'
        : 'FORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING',
  });
  return {
    range: res.data.range ?? range,
    values: (res.data.values ?? []) as CellValue[][],
  };
}

/**
 * Writes values into a range, leaving every other cell — and every other tab —
 * untouched. This is the surgical alternative to replacing the file through
 * Drive, which would wipe the whole workbook.
 */
export async function writeRange(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  range: string,
  values: CellValue[][],
  raw: boolean,
): Promise<{ updatedCells: number; updatedRange: string }> {
  const res = await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    // USER_ENTERED makes "=SUM(A1:A5)" a formula and "2026-07-01" a date, which
    // is what a caller writing a spreadsheet almost always means.
    valueInputOption: raw ? 'RAW' : 'USER_ENTERED',
    requestBody: { values },
  });
  return {
    updatedCells: res.data.updatedCells ?? 0,
    updatedRange: res.data.updatedRange ?? range,
  };
}

export async function appendRows(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  range: string,
  values: CellValue[][],
  raw: boolean,
): Promise<{ updatedRange: string; updatedRows: number }> {
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: raw ? 'RAW' : 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
  return {
    updatedRange: res.data.updates?.updatedRange ?? range,
    updatedRows: res.data.updates?.updatedRows ?? 0,
  };
}

export async function clearRange(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  range: string,
): Promise<string> {
  const res = await sheets.spreadsheets.values.clear({ spreadsheetId, range });
  return res.data.clearedRange ?? range;
}

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

/** "#1a73e8" or "1a73e8" to the 0..1 floats the API expects. */
export function hexToColor(hex: string): sheets_v4.Schema$Color {
  const clean = hex.replace(/^#/, '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) {
    throw new Error(`"${hex}" is not a six-digit hex colour, e.g. #1a73e8.`);
  }
  return {
    red: parseInt(clean.slice(0, 2), 16) / 255,
    green: parseInt(clean.slice(2, 4), 16) / 255,
    blue: parseInt(clean.slice(4, 6), 16) / 255,
  };
}

export interface CellFormatting {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  fontSize?: number;
  textColor?: string;
  backgroundColor?: string;
  horizontalAlignment?: 'LEFT' | 'CENTER' | 'RIGHT';
  verticalAlignment?: 'TOP' | 'MIDDLE' | 'BOTTOM';
  wrapText?: boolean;
  numberFormat?: { type: 'TEXT' | 'NUMBER' | 'PERCENT' | 'CURRENCY' | 'DATE' | 'TIME' | 'DATE_TIME'; pattern?: string };
  border?: boolean;
}

/**
 * Applies formatting to a range.
 *
 * The `fields` mask is built from exactly the properties supplied, so an
 * unspecified property is left alone rather than reset to its default — the
 * usual way naive formatting code silently strips existing styling.
 */
export async function formatRange(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  gridRange: sheets_v4.Schema$GridRange,
  fmt: CellFormatting,
): Promise<void> {
  const textFormat: sheets_v4.Schema$TextFormat = {};
  const textFields: string[] = [];
  if (fmt.bold !== undefined) { textFormat.bold = fmt.bold; textFields.push('bold'); }
  if (fmt.italic !== undefined) { textFormat.italic = fmt.italic; textFields.push('italic'); }
  if (fmt.strikethrough !== undefined) { textFormat.strikethrough = fmt.strikethrough; textFields.push('strikethrough'); }
  if (fmt.fontSize !== undefined) { textFormat.fontSize = fmt.fontSize; textFields.push('fontSize'); }
  if (fmt.textColor !== undefined) { textFormat.foregroundColor = hexToColor(fmt.textColor); textFields.push('foregroundColor'); }

  const cellFormat: sheets_v4.Schema$CellFormat = {};
  const fields: string[] = [];

  if (textFields.length) {
    cellFormat.textFormat = textFormat;
    fields.push(...textFields.map((f) => `userEnteredFormat.textFormat.${f}`));
  }
  if (fmt.backgroundColor !== undefined) {
    cellFormat.backgroundColor = hexToColor(fmt.backgroundColor);
    fields.push('userEnteredFormat.backgroundColor');
  }
  if (fmt.horizontalAlignment !== undefined) {
    cellFormat.horizontalAlignment = fmt.horizontalAlignment;
    fields.push('userEnteredFormat.horizontalAlignment');
  }
  if (fmt.verticalAlignment !== undefined) {
    cellFormat.verticalAlignment = fmt.verticalAlignment;
    fields.push('userEnteredFormat.verticalAlignment');
  }
  if (fmt.wrapText !== undefined) {
    cellFormat.wrapStrategy = fmt.wrapText ? 'WRAP' : 'OVERFLOW_CELL';
    fields.push('userEnteredFormat.wrapStrategy');
  }
  if (fmt.numberFormat !== undefined) {
    cellFormat.numberFormat = {
      type: fmt.numberFormat.type,
      ...(fmt.numberFormat.pattern ? { pattern: fmt.numberFormat.pattern } : {}),
    };
    fields.push('userEnteredFormat.numberFormat');
  }

  const requests: sheets_v4.Schema$Request[] = [];

  if (fields.length) {
    requests.push({
      repeatCell: { range: gridRange, cell: { userEnteredFormat: cellFormat }, fields: fields.join(',') },
    });
  }

  if (fmt.border) {
    const line: sheets_v4.Schema$Border = { style: 'SOLID', width: 1 };
    requests.push({
      updateBorders: {
        range: gridRange,
        top: line,
        bottom: line,
        left: line,
        right: line,
        innerHorizontal: line,
        innerVertical: line,
      },
    });
  }

  if (requests.length === 0) {
    throw new Error('No formatting was specified.');
  }

  await batch(sheets, spreadsheetId, requests);
}

export async function mergeCells(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  gridRange: sheets_v4.Schema$GridRange,
  unmerge: boolean,
): Promise<void> {
  await batch(sheets, spreadsheetId, [
    unmerge
      ? { unmergeCells: { range: gridRange } }
      : { mergeCells: { range: gridRange, mergeType: 'MERGE_ALL' } },
  ]);
}

/* ------------------------------------------------------------------ *
 * Creation
 * ------------------------------------------------------------------ */

export async function createSpreadsheet(
  sheets: sheets_v4.Sheets,
  title: string,
  tabTitles: string[],
): Promise<SpreadsheetInfo> {
  const res = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title },
      ...(tabTitles.length
        ? { sheets: tabTitles.map((t) => ({ properties: { title: t } })) }
        : {}),
    },
    fields:
      'spreadsheetId, spreadsheetUrl, properties(title,locale,timeZone), ' +
      'sheets.properties(sheetId,title,index,hidden,gridProperties)',
  });

  return {
    spreadsheetId: res.data.spreadsheetId ?? '',
    title: res.data.properties?.title ?? title,
    locale: res.data.properties?.locale ?? null,
    timeZone: res.data.properties?.timeZone ?? null,
    url: res.data.spreadsheetUrl ?? null,
    tabs: (res.data.sheets ?? []).map((s) => ({
      sheetId: s.properties?.sheetId ?? 0,
      title: s.properties?.title ?? '',
      index: s.properties?.index ?? 0,
      rowCount: s.properties?.gridProperties?.rowCount ?? 0,
      columnCount: s.properties?.gridProperties?.columnCount ?? 0,
      frozenRowCount: 0,
      frozenColumnCount: 0,
      hidden: false,
    })),
  };
}
