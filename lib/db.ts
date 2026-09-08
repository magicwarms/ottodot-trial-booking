import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type DB = Database.Database;

const SCHEMA = join(process.cwd(), 'db', 'schema.sql');

/**
 * Open a connection and apply the PRAGMAs the concurrency design depends on.
 *
 * WAL + busy_timeout are not tuning knobs here, they are load-bearing:
 * `BEGIN IMMEDIATE` (see lib/booking.ts) takes SQLite's write lock, and a
 * competing writer must wait for it rather than fail instantly with SQLITE_BUSY.
 */
export function connect(file: string): DB {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

/** Fresh database with the schema applied. Used by seed and by every test. */
export function createSchema(file: string): DB {
  const db = connect(file);
  db.exec(readFileSync(SCHEMA, 'utf8'));
  return db;
}

export const DB_FILE = process.env.DB_FILE ?? join(process.cwd(), 'trial-booking.db');

// Next dev server hot-reloads modules; without this we would leak a new SQLite
// handle (and a new WAL reader) on every edit.
const g = globalThis as unknown as { __ottodotDb?: DB };

export function getDb(): DB {
  if (!g.__ottodotDb) g.__ottodotDb = connect(DB_FILE);
  return g.__ottodotDb;
}
