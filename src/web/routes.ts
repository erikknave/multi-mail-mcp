import { Hono } from 'hono';
import { config } from '../config.js';
import { generateApiKey } from '../crypto.js';
import { allowedLogins, apiKeys, accounts, audit, users } from '../db/repo.js';
import { currentUser, endSession } from '../auth.js';
import { buildConsentUrl } from '../google/oauth.js';
import { consentUrlFor } from '../oauth/consent.js';
import { microsoftEnabled } from '../microsoft/oauth.js';
import { isProvider } from '../providers.js';
import { accountStatus, listAccounts } from '../service.js';
import { adminPage, dashboardPage, landingPage, messagePage } from './views.js';

export const webRoutes = new Hono();

/* ------------------------------------------------------------------ *
 * Dashboard
 * ------------------------------------------------------------------ */

webRoutes.get('/', (c) => {
  const user = currentUser(c);
  if (!user) {
    const error = c.req.query('error');
    return c.html(landingPage(error ?? undefined));
  }

  const message = c.req.query('ok')
    ? ({ kind: 'ok', text: c.req.query('ok')! } as const)
    : c.req.query('error')
      ? ({ kind: 'err', text: c.req.query('error')! } as const)
      : undefined;

  return c.html(
    dashboardPage({
      user,
      accounts: listAccounts(user).map(accountStatus),
      keys: apiKeys.forUser(user.id),
      newKey: c.req.query('key') ?? undefined,
      mcpUrl: `${config.publicBaseUrl}/mcp`,
      microsoftAvailable: microsoftEnabled(),
      message,
    }),
  );
});

/* ------------------------------------------------------------------ *
 * Sign in / out
 * ------------------------------------------------------------------ */

webRoutes.get('/login', (c) => {
  const existing = currentUser(c);
  if (existing) return c.redirect('/');
  // uid is empty: the callback works out which user this is from the returned
  // email address, since sign-in and account-connection share one flow.
  return c.redirect(buildConsentUrl({ userId: '', returnTo: '/' }));
});

webRoutes.get('/logout', (c) => {
  endSession(c);
  return c.redirect('/');
});

/* ------------------------------------------------------------------ *
 * Mailboxes
 * ------------------------------------------------------------------ */

webRoutes.get('/accounts/connect', (c) => {
  const user = currentUser(c);
  if (!user) return c.redirect('/');

  // Google stays the default so the original link keeps working unchanged.
  const requested = c.req.query('provider') ?? 'google';
  if (!isProvider(requested)) return c.redirect('/?error=Unknown+provider');
  if (requested === 'microsoft' && !microsoftEnabled()) {
    return c.redirect('/?error=Microsoft+accounts+are+not+configured+on+this+server');
  }

  return c.redirect(consentUrlFor(requested, { userId: user.id, returnTo: '/' }));
});

webRoutes.get('/accounts/reauth', (c) => {
  const user = currentUser(c);
  if (!user) return c.redirect('/');

  const email = c.req.query('email');
  if (!email) return c.redirect('/?error=No+mailbox+specified');

  const account = accounts.byUserAndEmail(user.id, email);
  if (!account) return c.redirect('/?error=Unknown+mailbox');

  return c.redirect(
    consentUrlFor(account.provider, {
      userId: user.id,
      expectEmail: account.email,
      returnTo: '/',
    }),
  );
});

webRoutes.post('/accounts/disconnect', async (c) => {
  const user = currentUser(c);
  if (!user) return c.redirect('/');

  const form = await c.req.formData();
  const email = String(form.get('email') ?? '');
  const account = accounts.byUserAndEmail(user.id, email);
  if (!account) return c.redirect('/?error=Unknown+mailbox');

  accounts.delete(account.id, user.id);
  audit('account.disconnected', { userId: user.id, accountId: account.id, detail: account.email });
  return c.redirect(`/?ok=${encodeURIComponent(`${account.email} disconnected.`)}`);
});

/* ------------------------------------------------------------------ *
 * API keys
 * ------------------------------------------------------------------ */

webRoutes.post('/keys', async (c) => {
  const user = currentUser(c);
  if (!user) return c.redirect('/');

  const form = await c.req.formData();
  // Naming a key is useful but not worth blocking on — fall back to a number so
  // the list stays distinguishable when someone just clicks the button.
  const name =
    String(form.get('name') ?? '').trim().slice(0, 60) ||
    `Key ${apiKeys.forUser(user.id).length + 1}`;

  const { key, hash, prefix } = generateApiKey();
  apiKeys.create(user.id, name, hash, prefix);
  audit('apikey.created', { userId: user.id, detail: name });

  // The plaintext travels once, in the redirect, and is shown then discarded.
  return c.redirect(`/?key=${encodeURIComponent(key)}`);
});

webRoutes.post('/keys/delete', async (c) => {
  const user = currentUser(c);
  if (!user) return c.redirect('/');

  const form = await c.req.formData();
  const id = String(form.get('id') ?? '');
  apiKeys.delete(id, user.id);
  audit('apikey.revoked', { userId: user.id, detail: id });

  return c.redirect('/?ok=Key+revoked.');
});

/* ------------------------------------------------------------------ *
 * Admin
 * ------------------------------------------------------------------ */

webRoutes.get('/admin', (c) => {
  const user = currentUser(c);
  if (!user) return c.redirect('/');
  if (!user.is_admin) {
    return c.html(messagePage('Not allowed', 'Administrators only', 'You are not an administrator.', 'err'), 403);
  }

  const message = c.req.query('ok')
    ? ({ kind: 'ok', text: c.req.query('ok')! } as const)
    : c.req.query('error')
      ? ({ kind: 'err', text: c.req.query('error')! } as const)
      : undefined;

  return c.html(adminPage({ user, allowed: allowedLogins.all(), users: users.all(), message }));
});

webRoutes.post('/admin/allowed', async (c) => {
  const user = currentUser(c);
  if (!user?.is_admin) return c.redirect('/');

  const form = await c.req.formData();
  const email = String(form.get('email') ?? '').trim().toLowerCase();
  if (!email.includes('@')) return c.redirect('/admin?error=That+is+not+an+email+address');

  allowedLogins.add(email, user.id);
  audit('allowlist.added', { userId: user.id, detail: email });
  return c.redirect(`/admin?ok=${encodeURIComponent(`${email} may now sign in.`)}`);
});

webRoutes.post('/admin/allowed/remove', async (c) => {
  const user = currentUser(c);
  if (!user?.is_admin) return c.redirect('/');

  const form = await c.req.formData();
  const email = String(form.get('email') ?? '').trim().toLowerCase();
  allowedLogins.remove(email);
  audit('allowlist.removed', { userId: user.id, detail: email });
  return c.redirect(`/admin?ok=${encodeURIComponent(`${email} removed from the allowlist.`)}`);
});

/* ------------------------------------------------------------------ *
 * Health
 * ------------------------------------------------------------------ */

webRoutes.get('/healthz', (c) => c.json({ ok: true, service: 'multi-mail-mcp' }));
