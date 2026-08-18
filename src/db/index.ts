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
}

migrate();

export function now(): number {
  return Math.floor(Date.now() / 1000);
}
