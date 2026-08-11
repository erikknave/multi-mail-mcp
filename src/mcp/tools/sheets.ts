import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { User } from '../../db/repo.js';
import {
  addTab,
  appendRows,
  autoResizeColumns,
  clearRange,
  createSpreadsheet,
  deleteTab,
  duplicateTab,
  findTab,
  formatRange,
  getSpreadsheet,
  mergeCells,
  parseA1,
  readRange,
  renameTab,
  reorderTab,
  setFrozenRows,
  writeRange,
  type CellValue,
} from '../../google/sheets.js';
import { resolveAccount, ServiceError, sheetsClient } from '../../service.js';
import { guard, ok } from '../reply.js';

const accountArg = z
  .string()
  .optional()
  .describe('Account owning the spreadsheet. Omit when only one account is connected.');

const spreadsheetArg = z
  .string()
  .describe('Spreadsheet id — the long id in the Drive URL, or from search_drive.');

const tabArg = z
  .string()
  .describe('Tab name (e.g. "Jun 2026") or its numeric sheetId, from list_sheet_tabs.');

/** Tabs can be addressed by name or id; accept whichever the caller has. */
function asTabRef(tab: string): string | number {
  return /^\d+$/.test(tab) ? Number(tab) : tab;
}

/** Cell values arrive as JSON scalars; a nested array would corrupt the write. */
const cellValues = z
  .array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])))
  .describe('Rows of cell values, outer array = rows, inner = columns.');

export function registerSheetsTools(server: McpServer, user: User): void {
  /* ---------------------------------------------------------------- *
   * Structure
   * ---------------------------------------------------------------- */

  server.registerTool(
    'list_sheet_tabs',
    {
      title: 'List the tabs in a spreadsheet',
      description:
        'Shows every tab with its name, numeric sheetId, position, size and frozen rows. ' +
        'Call this first — most other spreadsheet tools need the tab name or sheetId, and ' +
        'it is the only way to see what a workbook actually contains.',
      inputSchema: { spreadsheetId: spreadsheetArg, account: accountArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ spreadsheetId, account }) =>
      guard(async () => {
        const acc = resolveAccount(user, account);
        const sheets = await sheetsClient(acc);
        const info = await getSpreadsheet(sheets, spreadsheetId);
        return ok({ account: acc.email, ...info, tabCount: info.tabs.length });
      }),
  );

  server.registerTool(
    'duplicate_sheet_tab',
    {
      title: 'Duplicate a tab, keeping its formatting',
      description:
        'Copies a tab within the same spreadsheet under a new name, preserving everything: ' +
        'formatting, formulas, conditional formatting, column widths, frozen rows and data ' +
        'validation. This is the right way to start a new month from last month\'s tab.\n\n' +
        'Note that formulas referring to cells inside the tab follow the copy, so a ' +
        'duplicated tab computes from its own data — but any values you do not overwrite ' +
        'are still last period\'s. Overwrite them with write_sheet_range afterwards.',
      inputSchema: {
        spreadsheetId: spreadsheetArg,
        sourceTab: tabArg.describe('Tab to copy from, by name or sheetId.'),
        newName: z.string().describe('Name for the new tab, e.g. "Jul 2026".'),
        position: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Zero-based position for the copy. Defaults to just after the source.'),
        account: accountArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ spreadsheetId, sourceTab, newName, position, account }) =>
      guard(async () => {
        const acc = resolveAccount(user, account);
        const sheets = await sheetsClient(acc);
        const info = await getSpreadsheet(sheets, spreadsheetId);

        if (info.tabs.some((t) => t.title === newName)) {
          throw new ServiceError(
            `"${newName}" already exists in "${info.title}". Pick another name, or rename ` +
              'the existing tab first.',
          );
        }

        const source = findTab(info, asTabRef(sourceTab));
        const created = await duplicateTab(
          sheets,
          spreadsheetId,
          source.sheetId,
          newName,
          position,
        );

        return ok({
          duplicated: true,
          account: acc.email,
          from: { title: source.title, sheetId: source.sheetId },
          newTab: created,
          note:
            'Formatting and formulas were copied. Any values carried over from the source ' +
            'are still the old ones — overwrite them with write_sheet_range.',
        });
      }),
  );

  server.registerTool(
    'add_sheet_tab',
    {
      title: 'Add a blank tab',
      description:
        'Creates an empty tab. Use duplicate_sheet_tab instead when you want to keep an ' +
        'existing tab\'s formatting.',
      inputSchema: {
        spreadsheetId: spreadsheetArg,
        name: z.string().describe('Name for the new tab.'),
        rows: z.number().int().min(1).max(10000).default(1000).describe('Row count.'),
        columns: z.number().int().min(1).max(500).default(26).describe('Column count.'),
        position: z.number().int().min(0).optional().describe('Zero-based position.'),
        account: accountArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ spreadsheetId, name, rows, columns, position, account }) =>
      guard(async () => {
        const acc = resolveAccount(user, account);
        const sheets = await sheetsClient(acc);
        const tab = await addTab(sheets, spreadsheetId, name, { rows, columns, index: position });
        return ok({ created: true, account: acc.email, tab });
      }),
  );

  server.registerTool(
    'rename_sheet_tab',
    {
      title: 'Rename a tab',
      description: 'Changes a tab\'s name. Formulas referring to it are updated by Google automatically.',
      inputSchema: {
        spreadsheetId: spreadsheetArg,
        tab: tabArg,
        newName: z.string().describe('New name.'),
        account: accountArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ spreadsheetId, tab, newName, account }) =>
      guard(async () => {
        const acc = resolveAccount(user, account);
        const sheets = await sheetsClient(acc);
        const info = await getSpreadsheet(sheets, spreadsheetId);
        const target = findTab(info, asTabRef(tab));
        await renameTab(sheets, spreadsheetId, target.sheetId, newName);
        return ok({ renamed: true, account: acc.email, from: target.title, to: newName });
      }),
  );

  server.registerTool(
    'delete_sheet_tab',
    {
      title: 'Delete a tab',
      description:
        'Removes a tab and everything on it. Unlike Drive files this does NOT go to a bin — ' +
        'it is gone, recoverable only through the spreadsheet\'s own version history. ' +
        'Confirm with the user before calling it.',
      inputSchema: { spreadsheetId: spreadsheetArg, tab: tabArg, account: accountArg },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ spreadsheetId, tab, account }) =>
      guard(async () => {
        const acc = resolveAccount(user, account);
        const sheets = await sheetsClient(acc);
        const info = await getSpreadsheet(sheets, spreadsheetId);

        if (info.tabs.length === 1) {
          throw new ServiceError('A spreadsheet must keep at least one tab.');
        }

        const target = findTab(info, asTabRef(tab));
        await deleteTab(sheets, spreadsheetId, target.sheetId);
        return ok({
          deleted: true,
          account: acc.email,
          tab: target.title,
          note: 'Recoverable only via File > Version history in the Sheets interface.',
        });
      }),
  );

  server.registerTool(
    'reorder_sheet_tab',
    {
      title: 'Move a tab to a different position',
      description: 'Changes where a tab sits in the tab strip. Position 0 is leftmost.',
      inputSchema: {
        spreadsheetId: spreadsheetArg,
        tab: tabArg,
        position: z.number().int().min(0).describe('New zero-based position.'),
        account: accountArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ spreadsheetId, tab, position, account }) =>
      guard(async () => {
        const acc = resolveAccount(user, account);
        const sheets = await sheetsClient(acc);
        const info = await getSpreadsheet(sheets, spreadsheetId);
        const target = findTab(info, asTabRef(tab));
        await reorderTab(sheets, spreadsheetId, target.sheetId, position);
        return ok({ moved: true, account: acc.email, tab: target.title, position });
      }),
  );

  /* ---------------------------------------------------------------- *
   * Values
   * ---------------------------------------------------------------- */

  server.registerTool(
    'read_sheet_range',
    {
      title: 'Read cells from a spreadsheet',
      description:
        'Reads a range in A1 notation, e.g. "Jun 2026!A1:F40". Omit the range part to read ' +
        'the whole tab ("Jun 2026"). Returns rows of values; trailing empty cells are not ' +
        'padded, so rows can differ in length.',
      inputSchema: {
        spreadsheetId: spreadsheetArg,
        range: z.string().describe('A1 range, e.g. "Jun 2026!A1:F40" or just "Jun 2026".'),
        formulas: z
          .boolean()
          .default(false)
          .describe('Return the underlying formulas rather than their computed values.'),
        unformatted: z
          .boolean()
          .default(false)
          .describe('Return raw numbers instead of display strings (useful for arithmetic).'),
        account: accountArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ spreadsheetId, range, formulas, unformatted, account }) =>
      guard(async () => {
        const acc = resolveAccount(user, account);
        const sheets = await sheetsClient(acc);
        const result = await readRange(sheets, spreadsheetId, range, { formulas, unformatted });
        return ok({
          account: acc.email,
          spreadsheetId,
          ...result,
          rowCount: result.values.length,
        });
      }),
  );

  server.registerTool(
    'write_sheet_range',
    {
      title: 'Write cells into a spreadsheet',
      description:
        'Writes values into a range, leaving every other cell and every other tab untouched. ' +
        'This is the correct way to edit a spreadsheet — never use write_drive_file on one, ' +
        'which replaces the entire workbook and destroys all other tabs.\n\n' +
        'Values are interpreted as a person typing them would expect: "=SUM(B2:B10)" becomes ' +
        'a formula and "2026-07-01" becomes a date. Set raw:true to store them literally.',
      inputSchema: {
        spreadsheetId: spreadsheetArg,
        range: z
          .string()
          .describe('A1 range where the values start, e.g. "Jul 2026!A2". Sized by the data.'),
        values: cellValues,
        raw: z
          .boolean()
          .default(false)
          .describe('Store values literally instead of parsing formulas and dates.'),
        account: accountArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ spreadsheetId, range, values, raw, account }) =>
      guard(async () => {
        if (values.length === 0) throw new ServiceError('No values were supplied.');
        const acc = resolveAccount(user, account);
        const sheets = await sheetsClient(acc);
        const result = await writeRange(
          sheets,
          spreadsheetId,
          range,
          values as CellValue[][],
          raw,
        );
        return ok({ written: true, account: acc.email, ...result });
      }),
  );

  server.registerTool(
    'append_sheet_rows',
    {
      title: 'Append rows to a spreadsheet',
      description:
        'Adds rows after the last row that already has data, so you do not have to work out ' +
        'where the table ends. Give the tab name as the range, e.g. "Log".',
      inputSchema: {
        spreadsheetId: spreadsheetArg,
        range: z.string().describe('Tab name, or a range identifying the table, e.g. "Log!A:D".'),
        values: cellValues,
        raw: z.boolean().default(false).describe('Store values literally.'),
        account: accountArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ spreadsheetId, range, values, raw, account }) =>
      guard(async () => {
        if (values.length === 0) throw new ServiceError('No values were supplied.');
        const acc = resolveAccount(user, account);
        const sheets = await sheetsClient(acc);
        const result = await appendRows(
          sheets,
          spreadsheetId,
          range,
          values as CellValue[][],
          raw,
        );
        return ok({ appended: true, account: acc.email, ...result });
      }),
  );

  server.registerTool(
    'clear_sheet_range',
    {
      title: 'Clear cell contents',
      description:
        'Empties the values in a range while leaving formatting in place — the right way to ' +
        'blank out a duplicated tab before filling in the new period.',
      inputSchema: {
        spreadsheetId: spreadsheetArg,
        range: z.string().describe('A1 range to clear, e.g. "Jul 2026!B2:F40".'),
        account: accountArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ spreadsheetId, range, account }) =>
      guard(async () => {
        const acc = resolveAccount(user, account);
        const sheets = await sheetsClient(acc);
        const cleared = await clearRange(sheets, spreadsheetId, range);
        return ok({
          cleared: true,
          account: acc.email,
          range: cleared,
          note: 'Formatting was kept; only the values were removed.',
        });
      }),
  );

  /* ---------------------------------------------------------------- *
   * Formatting
   * ---------------------------------------------------------------- */

  server.registerTool(
    'format_sheet_range',
    {
      title: 'Format cells',
      description:
        'Applies formatting to a range. Only the properties you give are changed — anything ' +
        'you leave out keeps its current styling rather than being reset.\n\n' +
        'Colours are hex strings such as "#1a73e8". For dates and money use numberFormat, ' +
        'e.g. {type:"DATE", pattern:"yyyy-mm-dd"} or {type:"CURRENCY", pattern:"#,##0.00 kr"}.',
      inputSchema: {
        spreadsheetId: spreadsheetArg,
        range: z.string().describe('A1 range, e.g. "Jul 2026!A1:F1".'),
        bold: z.boolean().optional().describe('Bold text.'),
        italic: z.boolean().optional().describe('Italic text.'),
        strikethrough: z.boolean().optional().describe('Struck-through text.'),
        fontSize: z.number().int().min(6).max(72).optional().describe('Font size in points.'),
        textColor: z.string().optional().describe('Text colour as hex, e.g. "#ffffff".'),
        backgroundColor: z.string().optional().describe('Cell fill as hex, e.g. "#1a73e8".'),
        horizontalAlignment: z.enum(['LEFT', 'CENTER', 'RIGHT']).optional(),
        verticalAlignment: z.enum(['TOP', 'MIDDLE', 'BOTTOM']).optional(),
        wrapText: z.boolean().optional().describe('Wrap long text inside the cell.'),
        numberFormat: z
          .object({
            type: z.enum(['TEXT', 'NUMBER', 'PERCENT', 'CURRENCY', 'DATE', 'TIME', 'DATE_TIME']),
            pattern: z.string().optional().describe('Format pattern, e.g. "yyyy-mm-dd".'),
          })
          .optional()
          .describe('How values should be displayed.'),
        border: z.boolean().optional().describe('Draw solid borders around and between cells.'),
        account: accountArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const acc = resolveAccount(user, args.account);
        const sheets = await sheetsClient(acc);
        const info = await getSpreadsheet(sheets, args.spreadsheetId);

        const parsed = parseA1(args.range);
        if (!parsed.tabName) {
          throw new ServiceError(
            `The range "${args.range}" does not name a tab. Formatting needs one, ` +
              'e.g. "Jul 2026!A1:F1".',
          );
        }
        const tab = findTab(info, parsed.tabName);

        await formatRange(
          sheets,
          args.spreadsheetId,
          {
            sheetId: tab.sheetId,
            ...(parsed.startRowIndex !== undefined ? { startRowIndex: parsed.startRowIndex } : {}),
            ...(parsed.endRowIndex !== undefined ? { endRowIndex: parsed.endRowIndex } : {}),
            ...(parsed.startColumnIndex !== undefined
              ? { startColumnIndex: parsed.startColumnIndex }
              : {}),
            ...(parsed.endColumnIndex !== undefined
              ? { endColumnIndex: parsed.endColumnIndex }
              : {}),
          },
          {
            bold: args.bold,
            italic: args.italic,
            strikethrough: args.strikethrough,
            fontSize: args.fontSize,
            textColor: args.textColor,
            backgroundColor: args.backgroundColor,
            horizontalAlignment: args.horizontalAlignment,
            verticalAlignment: args.verticalAlignment,
            wrapText: args.wrapText,
            numberFormat: args.numberFormat,
            border: args.border,
          },
        );

        return ok({ formatted: true, account: acc.email, range: args.range, tab: tab.title });
      }),
  );

  server.registerTool(
    'auto_resize_sheet_columns',
    {
      title: 'Fit column widths to their contents',
      description:
        'Widens or narrows columns so their contents fit. The quickest way to make a ' +
        'generated sheet look deliberate rather than truncated.',
      inputSchema: {
        spreadsheetId: spreadsheetArg,
        tab: tabArg,
        firstColumn: z.string().default('A').describe('First column letter, e.g. "A".'),
        lastColumn: z.string().default('Z').describe('Last column letter, e.g. "F".'),
        account: accountArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ spreadsheetId, tab, firstColumn, lastColumn, account }) =>
      guard(async () => {
        const acc = resolveAccount(user, account);
        const sheets = await sheetsClient(acc);
        const info = await getSpreadsheet(sheets, spreadsheetId);
        const target = findTab(info, asTabRef(tab));

        const start = parseA1(`${firstColumn}1`).startColumnIndex ?? 0;
        const end = (parseA1(`${lastColumn}1`).startColumnIndex ?? 25) + 1;

        await autoResizeColumns(sheets, spreadsheetId, target.sheetId, start, end);
        return ok({ resized: true, account: acc.email, tab: target.title, firstColumn, lastColumn });
      }),
  );

  server.registerTool(
    'set_sheet_layout',
    {
      title: 'Freeze rows or merge cells',
      description:
        'Two layout touches that make a sheet readable: freezing header rows so they stay ' +
        'visible when scrolling, and merging cells for a title bar across columns.',
      inputSchema: {
        spreadsheetId: spreadsheetArg,
        tab: tabArg,
        freezeRows: z.number().int().min(0).max(50).optional().describe('Header rows to freeze.'),
        freezeColumns: z.number().int().min(0).max(20).optional().describe('Columns to freeze.'),
        mergeRange: z
          .string()
          .optional()
          .describe('A1 range to merge into one cell, e.g. "Jul 2026!A1:F1".'),
        unmerge: z.boolean().default(false).describe('Split mergeRange apart instead of merging.'),
        account: accountArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ spreadsheetId, tab, freezeRows, freezeColumns, mergeRange, unmerge, account }) =>
      guard(async () => {
        if (freezeRows === undefined && freezeColumns === undefined && !mergeRange) {
          throw new ServiceError('Nothing to do: give freezeRows, freezeColumns or mergeRange.');
        }

        const acc = resolveAccount(user, account);
        const sheets = await sheetsClient(acc);
        const info = await getSpreadsheet(sheets, spreadsheetId);
        const target = findTab(info, asTabRef(tab));
        const done: string[] = [];

        if (freezeRows !== undefined || freezeColumns !== undefined) {
          await setFrozenRows(
            sheets,
            spreadsheetId,
            target.sheetId,
            freezeRows ?? target.frozenRowCount,
            freezeColumns,
          );
          done.push('froze');
        }

        if (mergeRange) {
          const parsed = parseA1(mergeRange);
          const mergeTab = parsed.tabName ? findTab(info, parsed.tabName) : target;
          await mergeCells(
            sheets,
            spreadsheetId,
            {
              sheetId: mergeTab.sheetId,
              ...(parsed.startRowIndex !== undefined ? { startRowIndex: parsed.startRowIndex } : {}),
              ...(parsed.endRowIndex !== undefined ? { endRowIndex: parsed.endRowIndex } : {}),
              ...(parsed.startColumnIndex !== undefined
                ? { startColumnIndex: parsed.startColumnIndex }
                : {}),
              ...(parsed.endColumnIndex !== undefined
                ? { endColumnIndex: parsed.endColumnIndex }
                : {}),
            },
            unmerge,
          );
          done.push(unmerge ? 'unmerged' : 'merged');
        }

        return ok({ account: acc.email, tab: target.title, applied: done });
      }),
  );

  /* ---------------------------------------------------------------- *
   * Creation
   * ---------------------------------------------------------------- */

  server.registerTool(
    'create_spreadsheet',
    {
      title: 'Create a spreadsheet',
      description:
        'Creates a new spreadsheet in the account\'s Drive, optionally with named tabs. ' +
        'Use update_drive_file afterwards to move it into a folder.',
      inputSchema: {
        title: z.string().describe('Spreadsheet name.'),
        tabs: z
          .array(z.string())
          .optional()
          .describe('Names for the initial tabs. Defaults to a single "Sheet1".'),
        account: accountArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ title, tabs, account }) =>
      guard(async () => {
        const acc = resolveAccount(user, account);
        const sheets = await sheetsClient(acc);
        const info = await createSpreadsheet(sheets, title, tabs ?? []);
        return ok({ created: true, account: acc.email, ...info });
      }),
  );
}
