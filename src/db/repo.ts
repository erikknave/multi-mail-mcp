import { db, now } from './index.js';
import { randomId } from '../crypto.js';

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export interface User {
  id: string;
  email: string;
  name: string | null;
  is_admin: number;
  created_at: number;
  last_login: number | null;
}

export interface Session {
  id: string;
  user_id: string;
  created_at: number;
  expires_at: number;
}

export interface ApiKey {
  id: string;
  user_id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  created_at: number;
  last_used_at: number | null;
}

export type AccountStatus = 'active' | 'needs_reauth';

export interface Account {
  id: string;
  user_id: string;
  email: string;
  google_sub: string | null;
  display_name: string | null;
  refresh_token_enc: string | null;
  access_token_enc: string | null;
  access_token_expires: number | null;
  scopes: string;
  status: AccountStatus;
  last_error: string | null;
  last_ok_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface Upload {
  id: string;
  user_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number | null;
  path: string;
  uploaded_at: number | null;
  expires_at: number;
  created_at: number;
}

/* ------------------------------------------------------------------ *
 * Users
 * ------------------------------------------------------------------ */

export const users = {
  create(email: string, name: string | null, isAdmin: boolean): User {
    const id = randomId();
    const ts = now();
    db.prepare(
      `INSERT INTO users (id, email, name, is_admin, created_at, last_login)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, email.toLowerCase().trim(), name, isAdmin ? 1 : 0, ts, ts);
    return this.byId(id)!;
  },

  byId(id: string): User | undefined {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
  },

  byEmail(email: string): User | undefined {
    return db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim()) as
      | User
      | undefined;
  },

  all(): User[] {
    return db.prepare('SELECT * FROM users ORDER BY created_at').all() as User[];
  },

  count(): number {
    return (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  },

  touchLogin(id: string): void {
    db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(now(), id);
  },

  setAdmin(id: string, isAdmin: boolean): void {
    db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, id);
  },

  delete(id: string): void {
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  },
};

/* ------------------------------------------------------------------ *
 * Login allowlist
 * ------------------------------------------------------------------ */

export interface AllowedLogin {
  email: string;
  added_by: string | null;
  created_at: number;
}

export const allowedLogins = {
  add(email: string, addedBy: string | null): void {
    db.prepare(
      'INSERT OR IGNORE INTO allowed_logins (email, added_by, created_at) VALUES (?, ?, ?)',
    ).run(email.toLowerCase().trim(), addedBy, now());
  },

  has(email: string): boolean {
    const row = db
      .prepare('SELECT email FROM allowed_logins WHERE email = ?')
      .get(email.toLowerCase().trim());
    return !!row;
  },

  all(): AllowedLogin[] {
    return db.prepare('SELECT * FROM allowed_logins ORDER BY email').all() as AllowedLogin[];
  },

  remove(email: string): void {
    db.prepare('DELETE FROM allowed_logins WHERE email = ?').run(email.toLowerCase().trim());
  },
};

/* ------------------------------------------------------------------ *
 * Sessions
 * ------------------------------------------------------------------ */

const SESSION_TTL = 30 * 24 * 3600;

export const sessions = {
  create(userId: string): Session {
    const id = randomId(32);
    const ts = now();
    db.prepare(
      'INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    ).run(id, userId, ts, ts + SESSION_TTL);
    return { id, user_id: userId, created_at: ts, expires_at: ts + SESSION_TTL };
  },

  get(id: string): Session | undefined {
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Session | undefined;
    if (!row) return undefined;
    if (row.expires_at < now()) {
      this.delete(id);
      return undefined;
    }
    return row;
  },

  delete(id: string): void {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  },

  purgeExpired(): void {
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
  },
};

/* ------------------------------------------------------------------ *
 * API keys
 * ------------------------------------------------------------------ */

export const apiKeys = {
  /** Returns the row plus the plaintext key, which is never recoverable afterwards. */
  create(userId: string, name: string, keyHash: string, keyPrefix: string): ApiKey {
    const id = randomId();
    db.prepare(
      `INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, userId, name, keyHash, keyPrefix, now());
    return db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as ApiKey;
  },

  byHash(keyHash: string): ApiKey | undefined {
    return db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(keyHash) as
      | ApiKey
      | undefined;
  },

  forUser(userId: string): ApiKey[] {
    return db
      .prepare('SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC')
      .all(userId) as ApiKey[];
  },

  touch(id: string): void {
    db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now(), id);
  },

  delete(id: string, userId: string): void {
    db.prepare('DELETE FROM api_keys WHERE id = ? AND user_id = ?').run(id, userId);
  },
};

/* ------------------------------------------------------------------ *
 * Accounts
 * ------------------------------------------------------------------ */

export const accounts = {
  upsert(params: {
    userId: string;
    email: string;
    googleSub: string | null;
    displayName: string | null;
    refreshTokenEnc: string | null;
    accessTokenEnc: string | null;
    accessTokenExpires: number | null;
    scopes: string;
  }): Account {
    const email = params.email.toLowerCase().trim();
    const existing = this.byUserAndEmail(params.userId, email);
    const ts = now();

    if (existing) {
      db.prepare(
        `UPDATE accounts SET
           google_sub = ?, display_name = ?,
           refresh_token_enc = COALESCE(?, refresh_token_enc),
           access_token_enc = ?, access_token_expires = ?,
           scopes = ?, status = 'active', last_error = NULL, last_ok_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        params.googleSub,
        params.displayName,
        params.refreshTokenEnc,
        params.accessTokenEnc,
        params.accessTokenExpires,
        params.scopes,
        ts,
        ts,
        existing.id,
      );
      return this.byId(existing.id)!;
    }

    const id = randomId();
    db.prepare(
      `INSERT INTO accounts
         (id, user_id, email, google_sub, display_name, refresh_token_enc, access_token_enc,
          access_token_expires, scopes, status, last_error, last_ok_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?)`,
    ).run(
      id,
      params.userId,
      email,
      params.googleSub,
      params.displayName,
      params.refreshTokenEnc,
      params.accessTokenEnc,
      params.accessTokenExpires,
      params.scopes,
      ts,
      ts,
      ts,
    );
    return this.byId(id)!;
  },

  byId(id: string): Account | undefined {
    return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Account | undefined;
  },

  byUserAndEmail(userId: string, email: string): Account | undefined {
    return db
      .prepare('SELECT * FROM accounts WHERE user_id = ? AND email = ?')
      .get(userId, email.toLowerCase().trim()) as Account | undefined;
  },

  forUser(userId: string): Account[] {
    return db
      .prepare('SELECT * FROM accounts WHERE user_id = ? ORDER BY email')
      .all(userId) as Account[];
  },

  /**
   * Any user who has this address connected as a mailbox. Used at sign-in so
   * that logging in with a secondary address lands you in the same user account
   * rather than creating a duplicate one.
   */
  byEmailAnyUser(email: string): Account | undefined {
    return db
      .prepare('SELECT * FROM accounts WHERE email = ? ORDER BY created_at LIMIT 1')
      .get(email.toLowerCase().trim()) as Account | undefined;
  },

  updateAccessToken(id: string, accessTokenEnc: string, expiresAt: number): void {
    db.prepare(
      `UPDATE accounts SET access_token_enc = ?, access_token_expires = ?,
         status = 'active', last_error = NULL, last_ok_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(accessTokenEnc, expiresAt, now(), now(), id);
  },

  markNeedsReauth(id: string, error: string): void {
    db.prepare(
      `UPDATE accounts SET status = 'needs_reauth', last_error = ?,
         access_token_enc = NULL, access_token_expires = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(error.slice(0, 500), now(), id);
  },

  delete(id: string, userId: string): void {
    db.prepare('DELETE FROM accounts WHERE id = ? AND user_id = ?').run(id, userId);
  },
};

/* ------------------------------------------------------------------ *
 * Uploads
 * ------------------------------------------------------------------ */

export const uploads = {
  create(params: {
    userId: string;
    filename: string;
    mimeType: string;
    path: string;
    expiresAt: number;
  }): Upload {
    const id = randomId();
    db.prepare(
      `INSERT INTO uploads (id, user_id, filename, mime_type, size_bytes, path, uploaded_at, expires_at, created_at)
       VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?)`,
    ).run(id, params.userId, params.filename, params.mimeType, params.path, params.expiresAt, now());
    return this.byId(id)!;
  },

  byId(id: string): Upload | undefined {
    return db.prepare('SELECT * FROM uploads WHERE id = ?').get(id) as Upload | undefined;
  },

  markUploaded(id: string, sizeBytes: number): void {
    db.prepare('UPDATE uploads SET size_bytes = ?, uploaded_at = ? WHERE id = ?').run(
      sizeBytes,
      now(),
      id,
    );
  },

  forUser(userId: string): Upload[] {
    return db
      .prepare('SELECT * FROM uploads WHERE user_id = ? ORDER BY created_at DESC')
      .all(userId) as Upload[];
  },

  expired(): Upload[] {
    return db.prepare('SELECT * FROM uploads WHERE expires_at < ?').all(now()) as Upload[];
  },

  delete(id: string): void {
    db.prepare('DELETE FROM uploads WHERE id = ?').run(id);
  },
};

/* ------------------------------------------------------------------ *
 * Audit log
 * ------------------------------------------------------------------ */

export function audit(
  action: string,
  opts: { userId?: string | null; accountId?: string | null; detail?: string | null } = {},
): void {
  db.prepare(
    'INSERT INTO audit_log (user_id, account_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(opts.userId ?? null, opts.accountId ?? null, action, opts.detail?.slice(0, 1000) ?? null, now());
}

export function recentAudit(limit = 50): Array<{
  id: number;
  user_id: string | null;
  account_id: string | null;
  action: string;
  detail: string | null;
  created_at: number;
}> {
  return db
    .prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?')
    .all(limit) as ReturnType<typeof recentAudit>;
}
