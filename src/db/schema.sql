-- Users of this service. There are no passwords: sign-in is Google OAuth only.
-- `email` is the address the user first signed in with; additional Google
-- accounts they connect (see `accounts`) also work as sign-in identities.
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  name       TEXT,
  is_admin   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_login INTEGER
);

-- Who is permitted to create an account by signing in. Without this anyone on
-- the internet could register, since the service is on a public URL.
CREATE TABLE IF NOT EXISTS allowed_logins (
  email      TEXT PRIMARY KEY,
  added_by   TEXT,
  created_at INTEGER NOT NULL
);

-- Web UI cookie sessions.
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Bearer tokens used by MCP clients (Claude Code, Claude Desktop, ...).
-- Only the hash is stored; the plaintext key is shown once at creation.
CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  key_prefix   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);

-- Connected mailboxes, one row per address per user.
-- provider: 'google' | 'microsoft'  -- which service hosts this mailbox
-- status:   'active' | 'needs_reauth'
CREATE TABLE IF NOT EXISTS accounts (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email                 TEXT NOT NULL,
  provider              TEXT NOT NULL DEFAULT 'google',
  -- The provider's stable id for the account: Google's `sub`, Microsoft's `oid`.
  provider_sub          TEXT,
  display_name          TEXT,
  refresh_token_enc     TEXT,
  access_token_enc      TEXT,
  access_token_expires  INTEGER,
  scopes                TEXT NOT NULL DEFAULT '',
  status                TEXT NOT NULL DEFAULT 'active',
  last_error            TEXT,
  last_ok_at            INTEGER,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  UNIQUE(user_id, email)
);
CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);
-- Lets a sign-in resolve to the owner of an already-connected mailbox.
CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email);

-- Staged files waiting to be attached to an outgoing mail.
CREATE TABLE IF NOT EXISTS uploads (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename    TEXT NOT NULL,
  mime_type   TEXT NOT NULL,
  size_bytes  INTEGER,
  path        TEXT NOT NULL,
  uploaded_at INTEGER,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_uploads_user ON uploads(user_id);

-- Append-only record of interesting actions, for debugging and accountability.
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT,
  account_id TEXT,
  action     TEXT NOT NULL,
  detail     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
