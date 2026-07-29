import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { User } from '../db/repo.js';
import { registerAccountTools } from './tools/accounts.js';
import { registerMailTools } from './tools/mail.js';
import { registerCalendarTools } from './tools/calendar.js';
import { registerFileTools } from './tools/files.js';

/**
 * One McpServer per request, bound to the authenticated user. Tools close over
 * that user, so a tool can never reach another user's mailboxes regardless of
 * what arguments the model passes.
 */
export function buildMcpServer(user: User): McpServer {
  const server = new McpServer(
    { name: 'multi-mail-mcp', version: '0.1.0' },
    {
      instructions:
        'Access to one or more Google (Gmail + Calendar) accounts belonging to the ' +
        'signed-in user.\n\n' +
        'Start with `list_accounts` to see which mailboxes exist and whether any need ' +
        're-authentication. Most tools take an optional `account` argument naming the ' +
        'mailbox address; omit it only when exactly one mailbox is connected.\n\n' +
        'Mail search uses Gmail query syntax (for example `from:anna after:2026/01/01 ' +
        'has:attachment`). Search returns compact summaries without bodies — call ' +
        '`get_message` or `get_thread` for the full text.\n\n' +
        'If a tool reports that an account needs re-authentication it will include a ' +
        'URL. Give that URL to the user, ask them to open it and sign in, then retry.',
    },
  );

  registerAccountTools(server, user);
  registerMailTools(server, user);
  registerCalendarTools(server, user);
  registerFileTools(server, user);

  return server;
}
