import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as sqliteVec from 'sqlite-vec';
import { embed, embedBatch, EMBEDDING_DIM, preload } from './embeddings.js';
import type {
  Provider, Memory, SaveMemoryInput, SearchInput, ListInput, NamespaceInfo,
} from './provider.js';

// Stop words dropped from FTS5 queries before they hit the index. We keep
// this list small and English-only on purpose — every word we drop is a
// word a user can't search for, so this is a precision/recall trade.
const FTS_STOP_WORDS = new Set([
  'a','an','the','is','are','was','were','be','been','being',
  'of','to','in','on','at','for','with','by','from','about','as','into','over','under','through','during',
  'and','or','but','if','then','else','so','than',
  'do','does','did','done','doing','have','has','had','having',
  'what','how','why','when','where','who','which','whose','whom',
  'this','that','these','those','there','here',
  'i','me','my','mine','you','your','yours','he','him','his','she','her','hers','it','its','we','us','our','they','them','their','theirs',
  'can','could','should','would','may','might','must','will','shall',
  'not','no','yes','some','any','all','each','every','either','neither',
]);

/**
 * Translate a natural-language query into an FTS5 MATCH expression.
 * - strips FTS5 control characters
 * - lowercases
 * - drops stop words and 1-character tokens
 * - prefix-matches each surviving token (`token*`) so "stores" matches "stored"
 * - ORs the tokens — any one is enough, BM25 ranks multi-hit rows higher
 */
function buildFtsQuery(raw: string): string {
  const cleaned = raw.replace(/["()*:^~]/g, ' ').toLowerCase().trim();
  if (!cleaned) return '';
  const tokens = cleaned
    .split(/\s+/)
    .map(t => t.replace(/^[^a-z0-9_]+|[^a-z0-9_]+$/g, ''))
    .filter(t => t.length >= 2 && !FTS_STOP_WORDS.has(t));
  if (tokens.length === 0) return '';
  return tokens.map(t => `${t}*`).join(' OR ');
}

// Reciprocal-rank-fusion constant. 60 is the value the literature uses and
// is what both Elasticsearch and our hosted-backend already use.
const RRF_K = 60;

/**
 * Local SQLite provider. Uses FTS5 for keyword search (ships with SQLite)
 * and sqlite-vec + Transformers.js for local vector search. Search is
 * hybrid: BM25 keyword + cosine vector, blended via reciprocal-rank fusion.
 * Everything runs offline; no external API calls.
 */
export class LocalProvider implements Provider {
  private db: Database.Database;
  private vecAvailable = false;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    // Load sqlite-vec as a SQLite extension. If anything goes wrong we
    // continue without vector support — FTS5 still works.
    try {
      sqliteVec.load(this.db);
      this.vecAvailable = true;
    } catch (e) {
      process.stderr.write(
        `[mnueron] sqlite-vec failed to load — semantic search disabled. ${(e as Error).message}\n`,
      );
      this.vecAvailable = false;
    }

    this.migrate();

    // Warm the embedding model in the background — the first query will
    // hit it; nice if it's already there.
    preload();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id          TEXT PRIMARY KEY,
        namespace   TEXT NOT NULL DEFAULT 'default',
        content     TEXT NOT NULL,
        tags_json   TEXT NOT NULL DEFAULT '[]',
        source      TEXT NOT NULL DEFAULT 'manual',
        source_ref  TEXT,
        meta_json   TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memories_namespace
        ON memories(namespace);
      CREATE INDEX IF NOT EXISTS idx_memories_created
        ON memories(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_source
        ON memories(source);
      CREATE INDEX IF NOT EXISTS idx_memories_source_ref
        ON memories(source_ref);

      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
      USING fts5(content, tags, namespace UNINDEXED, content_id UNINDEXED);

      -- Keep FTS in sync. We do this manually rather than via triggers so
      -- the FTS row's content column holds raw text (FTS can't reach
      -- inside JSON for tags otherwise).
    `);

    if (this.vecAvailable) {
      // vec0 virtual table. Each row carries the memory_id as an auxiliary
      // column so we can JOIN back to memories without managing rowids.
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec
        USING vec0(
          memory_id TEXT PRIMARY KEY,
          embedding float[${EMBEDDING_DIM}]
        );
      `);
    }
  }

  // ─── write path ──────────────────────────────────────────────────────────

  async save(input: SaveMemoryInput): Promise<Memory> {
    const now = Date.now();
    const id = randomUUID();
    const ns = input.namespace ?? 'default';
    const tags = input.tags ?? [];

    // Generate the embedding outside the transaction since it's async.
    // Failure here is non-fatal — we just skip the vec insert.
    const vector = this.vecAvailable ? await embed(input.content) : null;

    const tx = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO memories (id, namespace, content, tags_json, source, source_ref, meta_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, ns, input.content, JSON.stringify(tags),
        input.source ?? 'manual',
        input.source_ref ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        now, now,
      );
      this.db.prepare(`
        INSERT INTO memories_fts (content, tags, namespace, content_id)
        VALUES (?, ?, ?, ?)
      `).run(input.content, tags.join(' '), ns, id);

      if (vector && this.vecAvailable) {
        this.db.prepare(`
          INSERT INTO memories_vec (memory_id, embedding) VALUES (?, ?)
        `).run(id, Buffer.from(vector.buffer));
      }
    });
    tx();

    return this.rowToMemory({
      id, namespace: ns, content: input.content,
      tags_json: JSON.stringify(tags),
      source: input.source ?? 'manual',
      source_ref: input.source_ref ?? null,
      meta_json: input.metadata ? JSON.stringify(input.metadata) : null,
      created_at: now, updated_at: now,
    });
  }

  async bulkSave(inputs: SaveMemoryInput[]) {
    let saved = 0, errors = 0;

    // Pre-compute embeddings for the whole batch in one go — much faster
    // than calling embed() N times because Transformers.js batches the
    // forward pass.
    const vectors = this.vecAvailable
      ? await embedBatch(inputs.map(i => i.content))
      : inputs.map(() => null);

    const insertMem = this.db.prepare(`
      INSERT INTO memories (id, namespace, content, tags_json, source, source_ref, meta_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = this.db.prepare(`
      INSERT INTO memories_fts (content, tags, namespace, content_id)
      VALUES (?, ?, ?, ?)
    `);
    const insertVec = this.vecAvailable
      ? this.db.prepare(`INSERT INTO memories_vec (memory_id, embedding) VALUES (?, ?)`)
      : null;

    const tx = this.db.transaction((items: SaveMemoryInput[]) => {
      for (let i = 0; i < items.length; i++) {
        const input = items[i];
        try {
          const id = randomUUID();
          const now = Date.now();
          const ns = input.namespace ?? 'default';
          const tags = input.tags ?? [];
          insertMem.run(
            id, ns, input.content, JSON.stringify(tags),
            input.source ?? 'manual',
            input.source_ref ?? null,
            input.metadata ? JSON.stringify(input.metadata) : null,
            now, now,
          );
          insertFts.run(input.content, tags.join(' '), ns, id);
          const vec = vectors[i];
          if (vec && insertVec) {
            insertVec.run(id, Buffer.from(vec.buffer));
          }
          saved++;
        } catch (e) {
          errors++;
        }
      }
    });
    tx(inputs);
    return { saved, errors };
  }

  // ─── read path: hybrid keyword + vector with RRF ─────────────────────────

  async search(input: SearchInput): Promise<Memory[]> {
    const k = input.k ?? 10;

    // FTS5 leg
    const safeQuery = buildFtsQuery(input.query);
    const ftsRanks = new Map<string, number>();   // id → 1-based rank
    if (safeQuery) {
      let sql = `
        SELECT m.id
        FROM memories_fts f
        JOIN memories m ON m.id = f.content_id
        WHERE memories_fts MATCH ?
      `;
      const params: unknown[] = [safeQuery];
      if (input.namespace) { sql += ` AND m.namespace = ?`; params.push(input.namespace); }
      sql += ` ORDER BY bm25(memories_fts) LIMIT 50`;
      const rows = this.db.prepare(sql).all(...params) as any[];
      rows.forEach((r, i) => ftsRanks.set(r.id, i + 1));
    }

    // Vector leg.
    //
    // sqlite-vec requires the k value to be expressed *inside* the WHERE
    // clause as `AND k = ?` — a plain SQL LIMIT is not enough. We also
    // can't JOIN into the same statement without confusing the vec0
    // planner. So: run the bare KNN query first, then filter by namespace
    // in a second SELECT against the regular memories table.
    const vecRanks = new Map<string, number>();
    if (this.vecAvailable && input.query.trim()) {
      const qvec = await embed(input.query);
      if (qvec) {
        try {
          const rows = this.db.prepare(`
            SELECT memory_id AS id, distance
            FROM memories_vec
            WHERE embedding MATCH ?
              AND k = ?
            ORDER BY distance
          `).all(Buffer.from(qvec.buffer), 50) as Array<{ id: string; distance: number }>;

          let candidates = rows.map(r => r.id);

          // Namespace filter (after the KNN — sqlite-vec doesn't let us
          // attach this inside the vec0 query).
          if (input.namespace && candidates.length > 0) {
            const placeholders = candidates.map(() => '?').join(',');
            const allowed = this.db.prepare(
              `SELECT id FROM memories WHERE namespace = ? AND id IN (${placeholders})`,
            ).all(input.namespace, ...candidates) as Array<{ id: string }>;
            const allowedSet = new Set(allowed.map(a => a.id));
            candidates = candidates.filter(id => allowedSet.has(id));
          }

          candidates.forEach((id, i) => vecRanks.set(id, i + 1));
        } catch (e) {
          // sqlite-vec may not be loaded or syntax mismatch — log and skip.
          process.stderr.write(`[mnueron] vector search skipped: ${(e as Error).message}\n`);
        }
      }
    }

    // Fuse via Reciprocal Rank Fusion.
    const fused = new Map<string, number>();
    for (const [id, r] of ftsRanks) {
      fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + r));
    }
    for (const [id, r] of vecRanks) {
      fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + r));
    }

    if (fused.size === 0) return [];

    const sorted = [...fused.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, k);

    const placeholders = sorted.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT * FROM memories WHERE id IN (${placeholders})`,
    ).all(...sorted.map(s => s[0])) as any[];

    const byId = new Map(rows.map(r => [r.id, r]));
    let memories = sorted
      .map(([id, score]) => {
        const row = byId.get(id);
        return row ? this.rowToMemory(row, score) : null;
      })
      .filter((m): m is Memory => m !== null);

    if (input.tags && input.tags.length > 0) {
      const wanted = new Set(input.tags);
      memories = memories.filter(m => m.tags.some(t => wanted.has(t)));
    }
    return memories;
  }

  async list(input: ListInput): Promise<Memory[]> {
    let sql = `SELECT * FROM memories WHERE 1=1`;
    const params: unknown[] = [];
    if (input.namespace) {
      sql += ` AND namespace = ?`;
      params.push(input.namespace);
    }
    if (input.before) {
      sql += ` AND created_at < ?`;
      params.push(input.before);
    }
    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(input.limit ?? 50);

    const rows = this.db.prepare(sql).all(...params) as any[];
    let memories = rows.map(r => this.rowToMemory(r));

    if (input.tags && input.tags.length > 0) {
      const wanted = new Set(input.tags);
      memories = memories.filter(m => m.tags.some(t => wanted.has(t)));
    }
    return memories;
  }

  async get(id: string): Promise<Memory | null> {
    const row = this.db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as any;
    return row ? this.rowToMemory(row) : null;
  }

  async delete(id: string): Promise<boolean> {
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM memories_fts WHERE content_id = ?`).run(id);
      if (this.vecAvailable) {
        this.db.prepare(`DELETE FROM memories_vec WHERE memory_id = ?`).run(id);
      }
      const r = this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
      return r.changes > 0;
    });
    return tx() as boolean;
  }

  async namespaces(): Promise<NamespaceInfo[]> {
    const rows = this.db.prepare(`
      SELECT namespace AS name,
             COUNT(*) AS count,
             MAX(updated_at) AS last_updated
      FROM memories
      GROUP BY namespace
      ORDER BY last_updated DESC
    `).all() as any[];
    return rows.map(r => ({
      name: r.name,
      count: r.count,
      last_updated: r.last_updated ?? 0,
    }));
  }

  async close() {
    this.db.close();
  }

  // ─── helpers used by CLI / maintenance ───────────────────────────────────

  /**
   * Count of memories that don't have a vector yet. Used by the CLI to
   * decide whether `mnueron rebuild-embeddings` should run.
   *
   * Implementation note: sqlite-vec's vec0 virtual table doesn't support
   * LEFT JOIN with IS NULL predicates the way a normal table would (its
   * xBestIndex implementation rejects the plan). We use a NOT IN subquery
   * against memories_vec, which vec0 does handle.
   */
  countMissingEmbeddings(): number {
    if (!this.vecAvailable) return 0;
    const r = this.db.prepare(`
      SELECT COUNT(*) AS c
      FROM memories
      WHERE id NOT IN (SELECT memory_id FROM memories_vec)
    `).get() as any;
    return r?.c ?? 0;
  }

  /**
   * Generate embeddings for every memory that doesn't have one. Run once
   * after upgrading from a pre-vector version. Streams progress through
   * the callback so the CLI can show a progress bar.
   */
  async rebuildEmbeddings(
    onProgress?: (done: number, total: number, current?: string) => void,
  ): Promise<{ updated: number; skipped: number; errors: number }> {
    if (!this.vecAvailable) return { updated: 0, skipped: 0, errors: 0 };

    const rows = this.db.prepare(`
      SELECT id, content
      FROM memories
      WHERE id NOT IN (SELECT memory_id FROM memories_vec)
      ORDER BY created_at ASC
    `).all() as Array<{ id: string; content: string }>;

    const total = rows.length;
    let updated = 0, skipped = 0, errors = 0;

    // Embed in batches of 16 for throughput without spiking memory.
    const BATCH = 16;
    const insertVec = this.db.prepare(`
      INSERT OR REPLACE INTO memories_vec (memory_id, embedding) VALUES (?, ?)
    `);

    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const vecs = await embedBatch(chunk.map(r => r.content));
      const tx = this.db.transaction(() => {
        for (let j = 0; j < chunk.length; j++) {
          const vec = vecs[j];
          if (!vec) { skipped++; continue; }
          try {
            insertVec.run(chunk[j].id, Buffer.from(vec.buffer));
            updated++;
          } catch {
            errors++;
          }
        }
      });
      tx();
      onProgress?.(Math.min(i + BATCH, total), total, chunk[chunk.length - 1]?.content?.slice(0, 60));
    }
    return { updated, skipped, errors };
  }

  /**
   * Look up by source_ref — used by importers and the dashboard's upsert
   * endpoint to avoid double-saving the same chat.
   */
  findBySourceRef(sourceRef: string, namespace?: string): Memory | null {
    let sql = `SELECT * FROM memories WHERE source_ref = ?`;
    const params: unknown[] = [sourceRef];
    if (namespace) { sql += ` AND namespace = ?`; params.push(namespace); }
    sql += ` LIMIT 1`;
    const row = this.db.prepare(sql).get(...params) as any;
    return row ? this.rowToMemory(row) : null;
  }

  private rowToMemory(row: any, score?: number): Memory {
    return {
      id: row.id,
      namespace: row.namespace,
      content: row.content,
      tags: JSON.parse(row.tags_json ?? '[]'),
      source: row.source,
      source_ref: row.source_ref ?? undefined,
      metadata: row.meta_json ? JSON.parse(row.meta_json) : undefined,
      score,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
