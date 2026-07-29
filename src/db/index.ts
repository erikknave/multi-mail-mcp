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

export function now(): number {
  return Math.floor(Date.now() / 1000);
}
