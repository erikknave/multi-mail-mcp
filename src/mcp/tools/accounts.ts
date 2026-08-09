import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { User } from '../../db/repo.js';
import { buildReauthUrl, ReauthRequiredError } from '../../google/oauth.js';
import { getProfile } from '../../google/gmail.js';
import { accountStatus, gmailClient, listAccounts, resolveAccount } from '../../service.js';
import { guard, ok } from '../reply.js';

export function registerAccountTools(server: McpServer, user: User): void {
  server.registerTool(
    'list_accounts',
    {
      title: 'List connected mailboxes',
      description:
        'Lists every Google account connected for the current user. Call this first when you ' +
        'do not know which mailboxes exist.\n\n' +
        'By default `status` is the LAST KNOWN state, recorded at the previous real call — ' +
        'an account can read "active" and still fail, because a Google grant can be revoked ' +
        'at any moment without telling us. Pass verify:true to make a real call per mailbox ' +
        'and get the true current state. Do that before relying on the answer for anything ' +
        'that matters, such as reporting that a mailbox contains nothing.\n\n' +
        'Any mailbox needing attention includes a reauthUrl to hand to the user.',
      inputSchema: {
        verify: z
          .boolean()
          .default(false)
          .describe(
            'Make a live call per mailbox to confirm the credentials really work. ' +
              'Slower (one API round trip each) but authoritative.',
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ verify }) =>
      guard(async () => {
        const all = listAccounts(user);

        if (all.length === 0) {
          return ok({
            user: user.email,
            accountCount: 0,
            accounts: [],
            hint: 'No mailboxes connected yet. The user must connect one in the web UI.',
          });
        }

        if (!verify) {
          return ok({
            user: user.email,
            accountCount: all.length,
            statusIs: 'last-known',
            statusCaveat:
              'These statuses are cached from the last real call, not checked just now. ' +
              'A mailbox shown as "active" may still fail. Call again with verify:true for ' +
              'the authoritative state.',
            accounts: all.map(accountStatus),
          });
        }

        const verified = await Promise.all(
          all.map(async (acc) => {
            const base = accountStatus(acc);
            try {
              const gmail = await gmailClient(acc);
              const profile = await getProfile(gmail);
              return {
                ...base,
                status: 'active',
                verified: true,
                usable: true,
                messagesTotal: profile.messagesTotal,
              };
            } catch (err) {
              if (err instanceof ReauthRequiredError) {
                return {
                  ...base,
                  status: 'needs_reauth',
                  verified: true,
                  usable: false,
                  error: err.reason,
                  reauthUrl: err.reauthUrl,
                };
              }
              return {
                ...base,
                verified: true,
                usable: false,
                error: (err as Error).message,
              };
            }
          }),
        );

        const unusable = verified.filter((a) => !a.usable);

        return ok({
          user: user.email,
          accountCount: all.length,
          statusIs: 'verified-just-now',
          usableCount: verified.length - unusable.length,
          ...(unusable.length
            ? {
                warning:
                  `${unusable.length} of ${verified.length} mailboxes cannot currently be ` +
                  `read: ${unusable.map((a) => a.email).join(', ')}. Anything you report ` +
                  `about mail or calendars will be incomplete until these are fixed.`,
              }
            : {}),
          accounts: verified,
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
