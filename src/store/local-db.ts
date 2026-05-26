/**
 * Small helper to open a raw SQLite handle on the local memories.db.
 *
 * Used by Terminal Copilot commands (runbook capture / explain-error)
 * that need direct table access without going through the full
 * LocalProvider machinery (which initializes embeddings, BM25, etc).
 *
 * Reusing the same `better-sqlite3` constructor LocalProvider uses, so
 * any pragma/migration LocalProvider applies on first open also applies
 * here when LocalProvider runs in the same process.
 */

import Database from 'better-sqlite3';
import { ensureProceduralSchema } from './procedural.js';

let cached: { path: string; db: Database.Database } | null = null;

/**
 * Open (or return the cached handle to) the local SQLite file.
 *
 * Cached per-path: most processes only open one DB, but tests can call
 * with different paths and get isolated handles.
 *
 * Side-effect: calls `ensureProceduralSchema` so the Terminal Copilot
 * columns are guaranteed present before any caller reads/writes the
 * `procedural_memories` table.
 */
export function openLocalDb(dbPath: string): Database.Database {
  if (cached && cached.path === dbPath) return cached.db;
  const db = new Database(dbPath);
  ensureProceduralSchema(db);
  cached = { path: dbPath, db };
  return db;
}
