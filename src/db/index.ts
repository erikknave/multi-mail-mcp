import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const here = dirname(fileURLToPath(import.meta.url));

mkdirSync(config.dataDir, { recursive: true });
mkdirSync(join(config.dataDir, 'uploads'), { recursive: true });

export const db = new Database(join(config.dataDir, 'multi-mail.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// schema.sql is copied next to the compiled JS by the build step; when running
// through tsx it sits in src/db/ instead. Both resolve to `here`.
const schema = readFileSync(join(here, 'schema.sql'), 'utf8');
db.exec(schema);

/**
 * Schema changes for databases created before a column existed.
 *
 * schema.sql only ever runs as CREATE TABLE IF NOT EXISTS, so it does nothing
 * for an existing database. Each step here is guarded by an inspection of the
 * live table, which makes running them on every start harmless.
 */
function migrate(): void {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(accounts)').all() as Array<{ name: string }>).map((c) => c.name),
  );

  // Multi-provider support: `google_sub` became `provider_sub` when Microsoft
  // mailboxes arrived, since the column now holds whichever id the provider
  // issues. Existing rows are all Google, which is what the default records.
  if (columns.has('google_sub') && !columns.has('provider_sub')) {
    db.exec('ALTER TABLE accounts RENAME COLUMN google_sub TO provider_sub');
  }
  if (!columns.has('provider')) {
    db.exec("ALTER TABLE accounts ADD COLUMN provider TEXT NOT NULL DEFAULT 'google'");
  }

  // Slack made the address identify an account per provider rather than per
  // user: a Slack membership shares its email with a mailbox, so
  // UNIQUE(user_id, email) would block it. UNIQUE is a table constraint, so
  // widening it means rebuilding the table. The old constraint is strictly
  // narrower than the new one — the copy below cannot fail on existing data.
  // Detection reads the index list rather than parsing the CREATE text: what
  // matters is what SQLite actually enforces.
  const uniqueIndexColumns: string[][] = (
    db.prepare('PRAGMA index_list(accounts)').all() as Array<{ name: string; unique: number }>
  )
    .filter((i) => i.unique === 1)
    .map((i) =>
      (db.prepare(`PRAGMA index_info("${i.name}")`).all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    );
  if (!uniqueIndexColumns.some((cols) => cols.join(',') === 'user_id,provider,email')) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE accounts_new (
          id                    TEXT PRIMARY KEY,
          user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          email                 TEXT NOT NULL,
          provider              TEXT NOT NULL DEFAULT 'google',
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
          UNIQUE(user_id, provider, email)
        )`);
      db.exec(`
        INSERT INTO accounts_new
          (id, user_id, email, provider, provider_sub, display_name, refresh_token_enc,
           access_token_enc, access_token_expires, scopes, status, last_error, last_ok_at,
           created_at, updated_at)
        SELECT id, user_id, email, provider, provider_sub, display_name, refresh_token_enc,
           access_token_enc, access_token_expires, scopes, status, last_error, last_ok_at,
           created_at, updated_at
        FROM accounts`);
      db.exec('DROP TABLE accounts');
      db.exec('ALTER TABLE accounts_new RENAME TO accounts');
      db.exec('CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email)');
    })();
  }
}

migrate();

export function now(): number {
  return Math.floor(Date.now() / 1000);
}
