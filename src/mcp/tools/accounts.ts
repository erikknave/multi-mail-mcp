import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { User } from '../../db/repo.js';
import { buildReauthUrl } from '../../google/oauth.js';
import { getProfile } from '../../google/gmail.js';
import { accountStatus, gmailClient, listAccounts, resolveAccount } from '../../service.js';
import { guard, ok } from '../reply.js';

export function registerAccountTools(server: McpServer, user: User): void {
  server.registerTool(
    'list_accounts',
    {
      title: 'List connected mailboxes',
      description:
        'Lists every Google account connected for the current user, with its health status. ' +
        'Call this first when you do not know which mailboxes exist. Any account whose ' +
        'status is "needs_reauth" includes a reauthUrl to hand to the user.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      guard(async () => {
        const all = listAccounts(user);
        return ok({
          user: user.email,
          accountCount: all.length,
          accounts: all.map(accountStatus),
          ...(all.length === 0
            ? { hint: 'No mailboxes connected yet. The user must connect one in the web UI.' }
            : {}),
        });
      }),
  );

  server.registerTool(
    'get_reauth_url',
    {
      title: 'Get a re-authentication link',
      description:
        'Produces a link the user can open to renew Google access for a mailbox. ' +
        'Use this when a mailbox is reported as needing re-authentication, or proactively ' +
        'if calls against it are failing. The link is valid for 24 hours.',
      inputSchema: {
        account: z
          .string()
          .optional()
          .describe('Mailbox address. Omit when only one mailbox is connected.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ account }) =>
      guard(async () => {
        const acc = resolveAccount(user, account);
        return ok({
          account: acc.email,
          status: acc.status,
          reauthUrl: buildReauthUrl(acc),
          instructions:
            `Give this URL to the user. They must open it, sign in as ${acc.email}, ` +
            'and approve access. Then retry the original call.',
        });
      }),
  );

  server.registerTool(
    'check_account',
    {
      title: 'Verify a mailbox works',
      description:
        'Makes a real call to Gmail to confirm the stored credentials still work. ' +
        'Useful before starting a long sequence of operations, or to confirm a user ' +
        'has finished re-authenticating.',
      inputSchema: {
        account: z
          .string()
          .optional()
          .describe('Mailbox address. Omit when only one mailbox is connected.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ account }) =>
      guard(async () => {
        const acc = resolveAccount(user, account);
        const gmail = await gmailClient(acc);
        const profile = await getProfile(gmail);
        return ok({
          account: acc.email,
          working: true,
          gmailAddress: profile.emailAddress,
          messagesTotal: profile.messagesTotal,
          threadsTotal: profile.threadsTotal,
        });
      }),
  );
}
