import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { config } from './config.js';
import { hashApiKey, safeEqual } from './crypto.js';
import { accounts, allowedLogins, apiKeys, audit, sessions, users, type User } from './db/repo.js';

export const SESSION_COOKIE = 'mmcp_session';

/** Seeds ALLOWED_LOGIN_EMAILS into the database. The table wins from then on. */
export function seedAllowedLogins(): void {
  for (const email of config.allowedLoginEmails) {
    allowedLogins.add(email, null);
  }
}

export type LoginOutcome =
  | { ok: true; user: User; created: boolean; via: 'primary' | 'linked-mailbox' | 'allowlist' }
  | { ok: false; reason: string };

/**
 * Decides which user a successful Google sign-in belongs to.
 *
 * The middle case is the important one: if you sign in with an address that is
 * already connected as a mailbox on some user, you get logged into *that* user.
 * That is what makes all of a person's addresses work as ways into one account
 * instead of spawning a separate user per address.
 */
export function resolveLogin(email: string, name: string | null): LoginOutcome {
  const normalized = email.toLowerCase().trim();

  const primary = users.byEmail(normalized);
  if (primary) {
    users.touchLogin(primary.id);
    return { ok: true, user: primary, created: false, via: 'primary' };
  }

  const asMailbox = accounts.byEmailAnyUser(normalized);
  if (asMailbox) {
    const owner = users.byId(asMailbox.user_id);
    if (owner) {
      users.touchLogin(owner.id);
      return { ok: true, user: owner, created: false, via: 'linked-mailbox' };
    }
  }

  if (allowedLogins.has(normalized)) {
    // The very first user to sign in administers the service.
    const isFirst = users.count() === 0;
    const user = users.create(normalized, name, isFirst);
    audit('user.created', { userId: user.id, detail: `${normalized}${isFirst ? ' (admin)' : ''}` });
    return { ok: true, user, created: true, via: 'allowlist' };
  }

  return {
    ok: false,
    reason:
      `${normalized} is not permitted to sign in. Ask an administrator to add the address ` +
      `to the allowed list, or connect it as a mailbox on an existing account.`,
  };
}

/* ------------------------------------------------------------------ *
 * Web sessions
 * ------------------------------------------------------------------ */

export function startSession(c: Context, user: User): void {
  const session = sessions.create(user.id);
  setCookie(c, SESSION_COOKIE, session.id, {
    httpOnly: true,
    sameSite: 'Lax',
    // The tunnel terminates TLS, so the browser always sees https.
    secure: config.publicBaseUrl.startsWith('https://'),
    path: '/',
    maxAge: session.expires_at - Math.floor(Date.now() / 1000),
  });
}

export function endSession(c: Context): void {
  const id = getCookie(c, SESSION_COOKIE);
  if (id) sessions.delete(id);
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

export function currentUser(c: Context): User | null {
  const id = getCookie(c, SESSION_COOKIE);
  if (!id) return null;
  const session = sessions.get(id);
  if (!session) return null;
  return users.byId(session.user_id) ?? null;
}

/* ------------------------------------------------------------------ *
 * MCP client authentication (bearer API key)
 * ------------------------------------------------------------------ */

/**
 * Resolves an `Authorization: Bearer <key>` header to a user.
 * Lookup is by SHA-256 of the key, so the plaintext is never stored.
 */
export function authenticateApiKey(authorizationHeader: string | undefined): User | null {
  if (!authorizationHeader) return null;

  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  if (!match) return null;
  const presented = match[1]!.trim();
  if (!presented) return null;

  const record = apiKeys.byHash(hashApiKey(presented));
  if (!record) return null;
  // Re-verify in constant time; byHash already matched, this guards against
  // any future change that makes the lookup non-exact.
  if (!safeEqual(record.key_hash, hashApiKey(presented))) return null;

  apiKeys.touch(record.id);
  return users.byId(record.user_id) ?? null;
}
