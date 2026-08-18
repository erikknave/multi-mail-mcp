import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Capability } from '../config.js';
import type { User } from '../db/repo.js';
import { capabilitiesOf } from '../oauth/capabilities.js';
import { listAccounts } from '../service.js';
import { registerAccountTools } from './tools/accounts.js';
import { registerMailTools } from './tools/mail.js';
import { registerCalendarTools } from './tools/calendar.js';
import { registerChatTools } from './tools/chat.js';
import { registerDriveTools } from './tools/drive.js';
import { registerSheetsTools } from './tools/sheets.js';
import { registerDocsTools } from './tools/docs.js';
import { registerFileTools } from './tools/files.js';

/** What the connected mailboxes can do, pooled across all of them. */
function availableCapabilities(user: User): Set<Capability> {
  return new Set(listAccounts(user).flatMap(capabilitiesOf));
}

function instructionsFor(available: Set<Capability>): string {
  const surfaces: string[] = [];
  if (available.has('gmail')) surfaces.push('mail');
  if (available.has('calendar')) surfaces.push('calendars');
  if (available.has('drive')) surfaces.push('Google Drive, Sheets and Docs');
  if (available.has('chat')) surfaces.push('Teams chat');

  if (surfaces.length === 0) {
    return (
      'Access to the signed-in user\'s mailboxes — except that none are connected yet, so ' +
      'there is nothing to work with and only the account tools are available.\n\n' +
      'Call `list_accounts` to confirm, then tell the user to open the web UI and connect a ' +
      'Google or Microsoft mailbox. The rest of the tools appear once one exists: mail and ' +
      'calendar for either provider, Drive/Sheets/Docs for Google, Teams chat for Microsoft.'
    );
  }

  return (
    `Access to one or more mailboxes belonging to the signed-in user, hosted by Google ` +
    `(Gmail, Calendar, Drive) or Microsoft (Outlook mail, calendar, Teams chat). ` +
    `Currently available: ${surfaces.join(', ')}.\n\n` +
    'Start with `list_accounts` to see which mailboxes exist, which provider each is on, ' +
    'what its `capabilities` are, and whether any need re-authentication. Most tools take ' +
    'an optional `account` argument naming the mailbox address; omit it only when exactly ' +
    'one mailbox could serve the request.\n\n' +
    'The tool list reflects the mailboxes connected right now — Drive and Sheets tools ' +
    'exist only while a Google mailbox is connected, Teams chat only while a Microsoft one ' +
    'is. Connecting a mailbox mid-session may need the client to reconnect before the new ' +
    'tools appear.\n\n' +
    'Mail and calendar work identically for both providers: the same Gmail query syntax, ' +
    'the same label names, the same RRULE recurrence strings. Microsoft mailboxes translate ' +
    'these into folders, categories and Outlook patterns behind the scenes. Where something ' +
    'genuinely has no equivalent the response says so — a `queryNotes` entry on search, a ' +
    '`notes` entry on a calendar write — rather than quietly doing something else.\n\n' +
    'A tool called against a mailbox whose provider does not offer it answers NOT ' +
    'AVAILABLE. That is not a permission problem: no link is given because no consent ' +
    'screen would fix it. Check `capabilities` and use a mailbox that has what you need.\n\n' +
    'Mail search returns compact summaries without bodies — call `get_message` or ' +
    '`get_thread` for the full text. Drive search uses Drive query syntax, which is not ' +
    "Gmail's; see the search_drive description.\n\n" +
    'Spreadsheets and Google Docs must be edited with their own tools. Never use ' +
    'write_drive_file on one: it replaces the entire file, destroying every other tab of a ' +
    'workbook. Use write_sheet_range and append_to_doc instead, and duplicate_sheet_tab to ' +
    'copy a tab with its formatting intact.\n\n' +
    'Results that span several accounts carry an `incomplete` flag. When it is true, some ' +
    'account could not be read: say so rather than reporting the result as complete, and ' +
    'never conclude that something is absent from a mailbox you could not reach.\n\n' +
    'If a tool reports that an account needs re-authentication it will include a URL. Give ' +
    'that URL to the user, ask them to open it and sign in, then retry.'
  );
}

/**
 * One McpServer per request, bound to the authenticated user. Tools close over
 * that user, so a tool can never reach another user's mailboxes regardless of
 * what arguments the model passes.
 *
 * Only the tools the user's mailboxes can actually use are registered. A tool
 * that could only ever answer "not available for this account" is not worth the
 * context it costs to describe, and a shorter list is one the model chooses
 * from more accurately. Since the endpoint is stateless, the list is recomputed
 * on every request and follows the connected mailboxes without any cache to
 * invalidate.
 */
export function buildMcpServer(user: User): McpServer {
  const available = availableCapabilities(user);

  const server = new McpServer(
    { name: 'multi-mail-mcp', version: '0.1.0' },
    { instructions: instructionsFor(available) },
  );

  // Always registered: these are how an agent finds out what exists and what to
  // do about a mailbox that needs attention — including when none is connected.
  registerAccountTools(server, user);

  if (available.has('gmail')) {
    registerMailTools(server, user);
    // Staging uploads only ever feeds outgoing mail attachments.
    registerFileTools(server, user);
  }
  if (available.has('calendar')) registerCalendarTools(server, user);
  if (available.has('drive')) {
    registerDriveTools(server, user);
    registerSheetsTools(server, user);
    registerDocsTools(server, user);
  }
  if (available.has('chat')) registerChatTools(server, user);

  return server;
}
