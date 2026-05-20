import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as sqliteVec from 'sqlite-vec';
import { embed, embedBatch, EMBEDDING_DIM, preload } from './embeddings.js';
import { chunkContent, shouldChunk, DEFAULT_CHUNK_THRESHOLD } from './chunking.js';
import { extractEntities, shouldExtractEntities } from './entity-extractor.js';
import { redact } from './redactor.js';
import type {
  Provider, Memory, SaveMemoryInput, SearchInput, ListInput, NamespaceInfo,
  MemoryFilters, BulkSearchInput, BulkSearchResult, UpdateMemoryInput,
} from './provider.js';

/**
 * Build a SQL fragment + params for the shared filter shape used by
 * search() and list(). Returns clauses joined by AND (always at least
 * `1=1` so callers can append `${...}` after `WHERE`).
 *
 * The `m.` prefix is hard-coded — callers must alias their memories table
 * as `m` for these clauses to bind. (The whole local store uses one table
 * named `memories`, but the search path joins, so consistent aliasing is
 * what keeps this reusable.)
 */
function buildFilterFragment(f: MemoryFilters, alias = 'm'): { sql: string; params: unknown[] } {
  const parts: string[] = ['1=1'];
  const params: unknown[] = [];
  const a = alias ? `${alias}.` : '';
  if (f.namespace) { parts.push(`${a}namespace = ?`); params.push(f.namespace); }
  if (f.created_after  != null) { parts.push(`${a}created_at >= ?`); params.push(f.created_after); }
  if (f.created_before != null) { parts.push(`${a}created_at <= ?`); params.push(f.created_before); }
  if (f.updated_after  != null) { parts.push(`${a}updated_at >= ?`); params.push(f.updated_after); }
  if (f.updated_before != null) { parts.push(`${a}updated_at <= ?`); params.push(f.updated_before); }

  // metadata_filter: SQLite has no native @> operator, but we can match
  // every top-level k=v pair via json_extract. We only support strings,
  // numbers, and booleans on the RHS — nested objects are not supported
  // in this minimal port. Matches what most callers actually use.
  if (f.metadata_filter && typeof f.metadata_filter === 'object') {
    for (const [k, v] of Object.entries(f.metadata_filter)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        parts.push(`json_extract(${a}metadata, '$.' || ?) = ?`);
        params.push(k, v);
      }
    }
  }
  return { sql: parts.join(' AND '), params };
}

/**
 * Run pre-save transforms in fixed order:
 *   1. Redact secrets — never store API keys / JWTs / etc.
 *   2. (Later) plugin processors can hook here.
 * Returns the (possibly modified) input. Metadata is augmented with
 * `redacted_count` and `redacted_kinds` when redaction fired.
 */
function preSaveTransform(input: SaveMemoryInput): SaveMemoryInput {
  const r = redact(input.content);
  if (r.count === 0) return input;
  return {
    ...input,
    content: r.content,
    metadata: {
      ...(input.metadata ?? {}),
      redacted_count: r.count,
      redacted_kinds: r.kinds,
    },
  };
}

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
 * Pull a human-readable title out of a memory's content. Used by
 * `listThreads` to label conversations in the dashboard.
 * Strategy: prefer the first `# Heading`, then the first non-empty line,
 * then a sentence-aware truncation at 100 chars.
 */
function extractTitle(content: string): string {
  if (!content) return '(empty)';
  const trimmed = content.trim();
  // Markdown H1 / H2 anywhere near the top
  const hMatch = trimmed.slice(0, 600).match(/^#{1,3}\s+(.+)$/m);
  if (hMatch) return hMatch[1].trim().slice(0, 100);
  // Strip role-header markdown if present
  const firstLine = trimmed.split(/\r?\n/).map(s => s.trim()).find(Boolean) ?? trimmed;
  const noRole = firstLine.replace(/^\*\*(?:User|Assistant|Claude|ChatGPT|Gemini|System|Human):\*\*\s*/i, '');
  if (noRole.length <= 100) return noRole;
  // Otherwise: cut at sentence boundary near 100 chars
  const cut = noRole.slice(0, 100);
  const lastDot = cut.lastIndexOf('. ');
  return (lastDot > 40 ? cut.slice(0, lastDot + 1) : cut).trim() + '…';
}

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
    // 1. Redact secrets BEFORE chunking — so partial secret tokens at chunk
    //    boundaries can't slip through. Single source of truth for what
    //    hits SQLite.
    const transformed = preSaveTransform(input);

    // 2. P1 — entity extraction. SECURITY-CRITICAL: capture and strip BYOK
    //    keys from metadata BEFORE the gate check, mirroring the hosted
    //    backend's ordering. Short-content saves with BYOK keys still get
    //    keys scrubbed even when extraction is skipped.
    const meta = (transformed.metadata as Record<string, unknown> | undefined) ?? {};
    const byokAnthropic = typeof meta.byok_anthropic_key === 'string'
      ? (meta.byok_anthropic_key as string) : undefined;
    const byokOpenAI = typeof meta.byok_openai_key === 'string'
      ? (meta.byok_openai_key as string) : undefined;
    if (byokAnthropic) delete meta.byok_anthropic_key;
    if (byokOpenAI) delete meta.byok_openai_key;
    transformed.metadata = meta;

    if (shouldExtractEntities(transformed.content.length, transformed.metadata)) {
      // Explicit opt-in (metadata.extract_entities or BYOK) bypasses the
      // 200-char min-length floor. Otherwise (env-var default path) the
      // floor still applies as a guardrail against burning money on
      // one-liner autosaves.
      const meta = transformed.metadata as Record<string, unknown> | undefined;
      const explicit =
        meta?.extract_entities === true ||
        (typeof byokAnthropic === 'string' && byokAnthropic.length > 0) ||
        (typeof byokOpenAI === 'string' && byokOpenAI.length > 0);
      const entities = await extractEntities(transformed.content, {
        anthropicKey: byokAnthropic,
        openaiKey: byokOpenAI,
        ...(explicit ? { minChars: 1 } : {}),
      });
      if (entities.length > 0) {
        transformed.metadata = { ...(transformed.metadata ?? {}), entities };
      }
    }

    // 3. Long content gets auto-chunked into multiple memories. Each chunk
    //    becomes a searchable atomic memory; the original conversation is
    //    linkable via `parent_ref` (= source_ref + chunk_index in metadata).
    if (shouldChunk(transformed.content)) {
      const result = await this.saveChunked(transformed);
      return result.first;
    }
    return this.saveOne(transformed);
  }

  /** Save a single, non-chunked memory. The common path. */
  private async saveOne(input: SaveMemoryInput): Promise<Memory> {
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

  /**
   * Split long content into chunks and save each as a separate memory.
   * Each chunk carries metadata.parent_ref + chunk_index so the agent
   * (or the dashboard) can reassemble the original thread.
   */
  private async saveChunked(input: SaveMemoryInput): Promise<{ first: Memory; count: number }> {
    const chunks = chunkContent(input.content);
    if (chunks.length === 0) return { first: await this.saveOne(input), count: 1 };
    if (chunks.length === 1) return { first: await this.saveOne(input), count: 1 };

    // The parent reference: prefer the caller's source_ref if present, else
    // generate a stable id so siblings can find each other.
    const parentRef = input.source_ref ?? `chunked:${randomUUID()}`;
    const total = chunks.length;
    const baseTags = input.tags ?? [];

    const saves = chunks.map((c, i) => ({
      content: c.content,
      namespace: input.namespace,
      tags: [...baseTags, 'chunk', ...(c.role ? [`role:${c.role}`] : [])],
      source: input.source ?? 'manual',
      source_ref: parentRef,
      metadata: {
        ...(input.metadata ?? {}),
        parent_ref: parentRef,
        chunk_index: i,
        chunk_count: total,
        ...(c.role ? { role: c.role } : {}),
      },
    }));

    const result = await this.bulkSaveOne(saves);
    if (result.length === 0) {
      // Shouldn't happen, but fall back gracefully.
      return { first: await this.saveOne(input), count: 1 };
    }
    return { first: result[0], count: result.length };
  }

  /** Internal: bulkSave-like path that returns Memory[] rather than counts. */
  private async bulkSaveOne(inputs: SaveMemoryInput[]): Promise<Memory[]> {
    const vectors = this.vecAvailable ? await embedBatch(inputs.map(i => i.content)) : inputs.map(() => null);
    const out: Memory[] = [];
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
        const id = randomUUID();
        const now = Date.now();
        const ns = input.namespace ?? 'default';
        const tags = input.tags ?? [];
        const metaJson = input.metadata ? JSON.stringify(input.metadata) : null;
        insertMem.run(
          id, ns, input.content, JSON.stringify(tags),
          input.source ?? 'manual',
          input.source_ref ?? null,
          metaJson,
          now, now,
        );
        insertFts.run(input.content, tags.join(' '), ns, id);
        const vec = vectors[i];
        if (vec && insertVec) {
          insertVec.run(id, Buffer.from(vec.buffer));
        }
        out.push(this.rowToMemory({
          id, namespace: ns, content: input.content,
          tags_json: JSON.stringify(tags),
          source: input.source ?? 'manual',
          source_ref: input.source_ref ?? null,
          meta_json: metaJson,
          created_at: now, updated_at: now,
        }));
      }
    });
    tx(inputs);
    return out;
  }

  async bulkSave(inputs: SaveMemoryInput[]) {
    let saved = 0, errors = 0;

    // 1. Redact secrets up front, same as save().
    const redactedInputs = inputs.map(preSaveTransform);

    // 2. Expand long inputs into per-chunk memories before we save. A backfill
    // of 50 chats where each is 100KB becomes ~500 small memories,
    // searchable independently. The original conversation is linkable via
    // metadata.parent_ref.
    const expanded: SaveMemoryInput[] = [];
    for (const input of redactedInputs) {
      if (shouldChunk(input.content)) {
        const chunks = chunkContent(input.content);
        if (chunks.length > 1) {
          const parentRef = input.source_ref ?? `chunked:${randomUUID()}`;
          const baseTags = input.tags ?? [];
          for (let i = 0; i < chunks.length; i++) {
            const c = chunks[i];
            expanded.push({
              content: c.content,
              namespace: input.namespace,
              tags: [...baseTags, 'chunk', ...(c.role ? [`role:${c.role}`] : [])],
              source: input.source ?? 'manual',
              source_ref: parentRef,
              metadata: {
                ...(input.metadata ?? {}),
                parent_ref: parentRef,
                chunk_index: i,
                chunk_count: chunks.length,
                ...(c.role ? { role: c.role } : {}),
              },
            });
          }
          continue;
        }
      }
      expanded.push(input);
    }

    // Pre-compute embeddings for the whole (expanded) batch in one go —
    // much faster than calling embed() N times because Transformers.js
    // batches the forward pass.
    const vectors = this.vecAvailable
      ? await embedBatch(expanded.map(i => i.content))
      : expanded.map(() => null);

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
    tx(expanded);
    return { saved, errors };
  }

  // ─── read path: hybrid keyword + vector with RRF ─────────────────────────

  async search(input: SearchInput): Promise<Memory[]> {
    const k = input.k ?? 10;

    // FTS5 leg — now honors all MemoryFilters (date range + metadata filter).
    const safeQuery = buildFtsQuery(input.query);
    const ftsRanks = new Map<string, number>();   // id → 1-based rank
    if (safeQuery) {
      const filter = buildFilterFragment(input, 'm');
      let sql = `
        SELECT m.id
        FROM memories_fts f
        JOIN memories m ON m.id = f.content_id
        WHERE memories_fts MATCH ?
          AND ${filter.sql}
      `;
      const params: unknown[] = [safeQuery, ...filter.params];
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
    // v0.2.1 + v0.2.4: full filter support via shared helper.
    // Note: 'm' alias is omitted here because list() doesn't join other
    // tables, so we pass alias = '' to skip the prefix.
    const filter = buildFilterFragment(input, '');
    let sql = `SELECT * FROM memories WHERE ${filter.sql}`;
    const params: unknown[] = [...filter.params];

    // Keep legacy `before` cursor working for older SDK callers.
    if (input.before) {
      sql += ` AND created_at < ?`;
      params.push(input.before);
    }
    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(input.limit ?? 50);
    if (input.offset && input.offset > 0) {
      sql += ` OFFSET ?`;
      params.push(input.offset);
    }

    const rows = this.db.prepare(sql).all(...params) as any[];
    let memories = rows.map(r => this.rowToMemory(r));

    if (input.tags && input.tags.length > 0) {
      const wanted = new Set(input.tags);
      memories = memories.filter(m => m.tags.some(t => wanted.has(t)));
    }
    return memories;
  }

  /**
   * v0.2.3 — bulk search: same scope, multiple queries, one call.
   * SQLite is single-threaded; the only saving here is the function-call
   * overhead. The hosted version's savings are larger (one HTTP RTT). For
   * API parity, exposed under the same Provider method either way.
   */
  async bulkSearch(input: BulkSearchInput): Promise<BulkSearchResult[]> {
    const k = input.k ?? 5;
    const out: BulkSearchResult[] = [];
    for (const q of input.queries) {
      const hits = await this.search({
        query: q, k,
        namespace: input.namespace,
        tags: input.tags,
        created_after:  input.created_after,
        created_before: input.created_before,
        updated_after:  input.updated_after,
        updated_before: input.updated_before,
        metadata_filter: input.metadata_filter,
      });
      out.push({ query: q, hits });
    }
    return out;
  }

  /**
   * v0.2.2 — partial update. Re-runs redaction + chunking-aware embed for
   * the content path. Logs change to metadata.history so the same audit
   * trail works against local and hosted.
   *
   * Returns the updated Memory or null if id wasn't found.
   */
  async update(id: string, patch: UpdateMemoryInput): Promise<Memory | null> {
    const existing = this.db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as any;
    if (!existing) return null;

    // Build merged metadata + history entry
    const priorMeta: Record<string, unknown> =
      typeof existing.metadata === 'string'
        ? (JSON.parse(existing.metadata || '{}') as Record<string, unknown>)
        : (existing.metadata ?? {});
    const merged: Record<string, unknown> = { ...priorMeta };
    if (patch.metadata && typeof patch.metadata === 'object') {
      for (const [k, v] of Object.entries(patch.metadata)) {
        if (v === null) delete merged[k]; else merged[k] = v;
      }
    }

    const nextContent =
      patch.content != null ? redact(patch.content).content : existing.content;
    const contentChanged = nextContent !== existing.content;
    if (contentChanged) {
      const history = Array.isArray(merged.history)
        ? (merged.history as unknown[]).slice(0)
        : [];
      history.push({
        at: Date.now(),
        prev_content_len: typeof existing.content === 'string' ? existing.content.length : 0,
      });
      merged.history = history;
    }

    const nextNs   = patch.namespace ?? existing.namespace;
    const nextTags = patch.tags      ?? JSON.parse(existing.tags ?? '[]');
    const now = Date.now();

    this.db.prepare(
      `UPDATE memories
          SET content   = ?,
              namespace = ?,
              tags      = ?,
              metadata  = ?,
              updated_at = ?
        WHERE id = ?`,
    ).run(
      nextContent,
      nextNs,
      JSON.stringify(nextTags),
      JSON.stringify(merged),
      now,
      id,
    );

    // If content changed, re-index FTS + (optionally) re-embed.
    if (contentChanged) {
      this.db.prepare(`DELETE FROM memories_fts WHERE content_id = ?`).run(id);
      this.db.prepare(
        `INSERT INTO memories_fts (content_id, content) VALUES (?, ?)`,
      ).run(id, nextContent);

      if (this.vecAvailable) {
        try {
          const v = await embed(nextContent);
          if (v) {
            this.db.prepare(`DELETE FROM memories_vec WHERE memory_id = ?`).run(id);
            this.db.prepare(
              `INSERT INTO memories_vec (memory_id, embedding) VALUES (?, ?)`,
            ).run(id, Buffer.from(v.buffer));
          }
        } catch (e) {
          process.stderr.write(`[mnueron] re-embed on update failed: ${(e as Error).message}\n`);
        }
      }
    }

    const fresh = this.db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as any;
    return fresh ? this.rowToMemory(fresh) : null;
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

  /**
   * Return every chunk of a thread (i.e. every memory whose
   * metadata.parent_ref matches), ordered by chunk_index. Used by
   * `memory_get_thread` so agents can reassemble a long conversation
   * after finding one relevant turn via memory_recall.
   *
   * `parentRef` can be either the literal parent_ref value or any chunk's
   * memory id (we look up parent_ref from that chunk's metadata first).
   */
  findThread(parentRef: string): Memory[] {
    // If the caller passed a memory id, resolve to its parent_ref first.
    let ref = parentRef;
    const maybeChild = this.db.prepare(`SELECT meta_json FROM memories WHERE id = ?`).get(parentRef) as any;
    if (maybeChild?.meta_json) {
      try {
        const meta = JSON.parse(maybeChild.meta_json);
        if (typeof meta?.parent_ref === 'string') ref = meta.parent_ref;
      } catch { /* ignore */ }
    }
    // Now fetch every memory whose metadata.parent_ref equals ref.
    // JSON field path syntax: json_extract(meta_json, '$.parent_ref')
    const rows = this.db.prepare(`
      SELECT *
      FROM memories
      WHERE json_extract(meta_json, '$.parent_ref') = ?
      ORDER BY COALESCE(json_extract(meta_json, '$.chunk_index'), 0) ASC, created_at ASC
    `).all(ref) as any[];
    // Also try a fallback against source_ref for memories chunked via
    // source_ref-as-parent_ref (this is the common case for backfills).
    if (rows.length === 0) {
      const alt = this.db.prepare(`
        SELECT *
        FROM memories
        WHERE source_ref = ?
        ORDER BY COALESCE(json_extract(meta_json, '$.chunk_index'), 0) ASC, created_at ASC
      `).all(ref) as any[];
      return alt.map(r => this.rowToMemory(r));
    }
    return rows.map(r => this.rowToMemory(r));
  }

  /**
   * List "threads" — distinct conversations as represented by their
   * parent_ref. Each row in the output represents a conversation that the
   * dashboard can render collapsed (one row = one conversation, expandable
   * into per-turn chunks).
   *
   * Returns: { parent_ref, namespace, count, first_at, last_at, title }
   * — `title` is the content preview of the lowest-chunk_index member
   * (usually the human-readable header at the top of a transcript).
   */
  listThreads(opts: { namespace?: string; limit?: number; offset?: number } = {}): Array<{
    parent_ref: string;
    namespace: string;
    count: number;
    first_at: number;
    last_at: number;
    title: string;
    has_chunks: boolean;
  }> {
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    // We use COALESCE(parent_ref-from-metadata, id) as the bucket key so
    // standalone (non-chunked) memories show up as single-row threads too.
    const sql = `
      WITH grouped AS (
        SELECT
          COALESCE(json_extract(meta_json, '$.parent_ref'), id) AS pref,
          namespace,
          COUNT(*)                  AS cnt,
          MIN(created_at)           AS first_at,
          MAX(updated_at)           AS last_at,
          SUM(CASE WHEN json_extract(meta_json, '$.chunk_index') IS NOT NULL THEN 1 ELSE 0 END) AS chunked_n
        FROM memories
        ${opts.namespace ? 'WHERE namespace = ?' : ''}
        GROUP BY pref, namespace
      )
      SELECT
        g.pref AS parent_ref,
        g.namespace,
        g.cnt   AS count,
        g.first_at,
        g.last_at,
        g.chunked_n > 0 AS has_chunks,
        (
          SELECT m.content
          FROM memories m
          WHERE COALESCE(json_extract(m.meta_json, '$.parent_ref'), m.id) = g.pref
            AND m.namespace = g.namespace
          ORDER BY COALESCE(json_extract(m.meta_json, '$.chunk_index'), 0) ASC, m.created_at ASC
          LIMIT 1
        ) AS title_source
      FROM grouped g
      ORDER BY g.last_at DESC
      LIMIT ? OFFSET ?
    `;
    const params: unknown[] = opts.namespace ? [opts.namespace, limit, offset] : [limit, offset];
    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map(r => ({
      parent_ref: r.parent_ref,
      namespace: r.namespace,
      count: r.count,
      first_at: r.first_at ?? 0,
      last_at: r.last_at ?? 0,
      title: extractTitle(r.title_source ?? ''),
      has_chunks: !!r.has_chunks,
    }));
  }

  /**
   * Find memories whose content exceeds `threshold` chars — i.e. ones that
   * predate chunking. Used by `mnueron rechunk` to backfill the new shape.
   */
  findOversizedMemories(threshold = DEFAULT_CHUNK_THRESHOLD): Array<{ id: string; content: string; namespace: string; tags_json: string; source: string; source_ref: string | null; meta_json: string | null; created_at: number; }> {
    return this.db.prepare(`
      SELECT id, content, namespace, tags_json, source, source_ref, meta_json, created_at
      FROM memories
      WHERE LENGTH(content) > ?
        AND (
          meta_json IS NULL
          OR json_extract(meta_json, '$.chunk_index') IS NULL
        )
      ORDER BY LENGTH(content) DESC
    `).all(threshold) as any[];
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
