// ─────────────────────────────────────────────────────────────────────────────
// P5 — Self-revising memory loop (phase 5a: detection only).
//
// Background scan that finds likely-duplicate memories and surfaces them as
// proposals the user can act on. NO automatic writes — phase 5a is purely
// observational. Phase 5b (LLM-proposed merges) and 5c (auto-merge on
// high-confidence cases) layer on top later.
//
// Detection method: embedding cosine similarity between every pair of
// memories within a sliding window. We don't N² across the whole store —
// that would melt. Instead:
//
//   1. Walk memories sorted by created_at DESC.
//   2. For each memory M, vector-search the top-K nearest neighbors.
//   3. Filter to candidates with cosine >= DUPLICATE_THRESHOLD.
//   4. Emit one `ConsolidationProposal` per (M, neighbor) pair the
//      reviewer hasn't already seen or actioned.
//
// State persists in `consolidation_proposals`:
//   - status: 'pending' | 'approved' | 'rejected'
//   - kind:   'duplicate' (5a) | 'contradiction' (5b) | 'stale' (5b)
//   - score:  similarity that triggered the proposal
// Action history per proposal is its own table so we can audit who/when
// in a multi-user (hosted) context. The local store keeps it simple.
//
// Safety: phase 5a never deletes or mutates memories. The only mutation
// is INSERTs into consolidation_proposals.
// ─────────────────────────────────────────────────────────────────────────────

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

/** Cosine threshold for emitting a duplicate proposal. Tuned conservative —
 *  we'd rather miss some duplicates than swamp the user with false positives. */
const DUPLICATE_THRESHOLD = 0.92;
/** Top-K neighbors examined per memory. Larger = catches more duplicates,
 *  smaller = faster scan. K=5 covers ~all real-world duplicates per sampling. */
const NEIGHBORS_PER_MEMORY = 5;
/** Default cap on how many memories to scan per invocation. */
const DEFAULT_SCAN_LIMIT = 200;

export type ProposalKind = 'duplicate' | 'contradiction' | 'stale';
export type ProposalStatus = 'pending' | 'approved' | 'rejected';

export interface ConsolidationProposal {
  id: string;
  kind: ProposalKind;
  memory_a_id: string;
  memory_b_id: string;
  /** Similarity score (or other relevance metric) that triggered this. */
  score: number;
  status: ProposalStatus;
  /** Optional human-readable note (e.g., for contradictions: "valid_from differs"). */
  note: string | null;
  proposed_at: number;
  reviewed_at: number | null;
}

/** Schema bootstrap. Idempotent. Called from local.ts migrate(). */
export function ensureConsolidationSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS consolidation_proposals (
      id            TEXT PRIMARY KEY,
      kind          TEXT NOT NULL,
      memory_a_id   TEXT NOT NULL,
      memory_b_id   TEXT NOT NULL,
      score         REAL NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      note          TEXT,
      proposed_at   INTEGER NOT NULL,
      reviewed_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_proposals_status
      ON consolidation_proposals(status, proposed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_proposals_memory_a
      ON consolidation_proposals(memory_a_id);
    CREATE INDEX IF NOT EXISTS idx_proposals_memory_b
      ON consolidation_proposals(memory_b_id);
    -- Stop a duplicate proposal from being re-created on every scan.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_proposals_pair_kind
      ON consolidation_proposals(memory_a_id, memory_b_id, kind);
  `);
}

export interface ScanOptions {
  /** Cap number of memories examined. */
  limit?: number;
  /** Min cosine to emit. Default 0.92. */
  threshold?: number;
  /** Only scan within this namespace. */
  namespace?: string;
}

export interface ScanResult {
  scanned: number;
  proposalsCreated: number;
  proposalsAlreadyKnown: number;
}

/**
 * Phase 5a — pure detection pass. Walks memories in reverse chronological
 * order, vector-searches top-K neighbors per memory, and inserts
 * 'duplicate' proposals for any pair with similarity ≥ threshold.
 *
 * Idempotent via the (memory_a_id, memory_b_id, kind) unique index — if a
 * proposal already exists it's silently retained (counted as
 * `proposalsAlreadyKnown`).
 *
 * Returns counts so the CLI can print a one-line summary.
 */
export async function detectDuplicates(
  db: Database.Database,
  vecAvailable: boolean,
  opts: ScanOptions = {},
): Promise<ScanResult> {
  if (!vecAvailable) {
    // Without vectors we have no similarity signal — bail.
    return { scanned: 0, proposalsCreated: 0, proposalsAlreadyKnown: 0 };
  }
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_SCAN_LIMIT, 5000));
  const threshold = clamp01(opts.threshold ?? DUPLICATE_THRESHOLD);

  // Pull seed memories. We need their stored embedding bytes from the vec
  // table so we can use them as the search probe.
  const seedRows = (
    opts.namespace
      ? db.prepare(
          `SELECT m.id, m.namespace
             FROM memories m
            WHERE m.namespace = ?
            ORDER BY m.created_at DESC
            LIMIT ?`,
        ).all(opts.namespace, limit)
      : db.prepare(
          `SELECT m.id, m.namespace
             FROM memories m
            ORDER BY m.created_at DESC
            LIMIT ?`,
        ).all(limit)
  ) as Array<{ id: string; namespace: string }>;

  const insert = db.prepare<[
    string, ProposalKind, string, string, number, ProposalStatus, string | null, number,
  ]>(
    `INSERT INTO consolidation_proposals
       (id, kind, memory_a_id, memory_b_id, score, status, note, proposed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(memory_a_id, memory_b_id, kind) DO NOTHING`,
  );
  const now = Date.now();

  let scanned = 0;
  let proposalsCreated = 0;
  let proposalsAlreadyKnown = 0;

  for (const seed of seedRows) {
    scanned += 1;

    // Read this seed's embedding from memories_vec.
    const row = db
      .prepare(`SELECT embedding FROM memories_vec WHERE memory_id = ?`)
      .get(seed.id) as { embedding?: Buffer } | undefined;
    if (!row?.embedding) continue;

    // Top-K nearest neighbors (excluding the seed itself).
    const neighbors = db
      .prepare<[Buffer, number]>(
        `SELECT memory_id, distance
           FROM memories_vec
          WHERE embedding MATCH ?
            AND k = ?
          ORDER BY distance ASC`,
      )
      .all(row.embedding, NEIGHBORS_PER_MEMORY + 1) as Array<{
        memory_id: string;
        distance: number;
      }>;

    for (const n of neighbors) {
      if (n.memory_id === seed.id) continue; // skip self
      const sim = clamp01(1 - (n.distance * n.distance) / 2);
      if (sim < threshold) continue;

      // Canonicalize the pair: lower id first, so (A, B) and (B, A) collapse.
      const [a, b] = seed.id < n.memory_id ? [seed.id, n.memory_id] : [n.memory_id, seed.id];

      const before = db
        .prepare(
          `SELECT 1 FROM consolidation_proposals
            WHERE memory_a_id = ? AND memory_b_id = ? AND kind = 'duplicate' LIMIT 1`,
        )
        .get(a, b);
      if (before) {
        proposalsAlreadyKnown += 1;
        continue;
      }
      insert.run(
        randomUUID(),
        'duplicate',
        a,
        b,
        sim,
        'pending',
        null,
        now,
      );
      proposalsCreated += 1;
    }
  }

  return { scanned, proposalsCreated, proposalsAlreadyKnown };
}

export interface ProposalListOptions {
  status?: ProposalStatus;
  kind?: ProposalKind;
  limit?: number;
  offset?: number;
}

export function listProposals(
  db: Database.Database,
  opts: ProposalListOptions = {},
): ConsolidationProposal[] {
  const parts: string[] = ['1=1'];
  const params: unknown[] = [];
  if (opts.status) { parts.push('status = ?'); params.push(opts.status); }
  if (opts.kind)   { parts.push('kind   = ?'); params.push(opts.kind);   }
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
  const offset = Math.max(0, opts.offset ?? 0);
  return db
    .prepare(
      `SELECT * FROM consolidation_proposals
        WHERE ${parts.join(' AND ')}
        ORDER BY proposed_at DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as ConsolidationProposal[];
}

export function reviewProposal(
  db: Database.Database,
  id: string,
  decision: 'approved' | 'rejected',
): ConsolidationProposal | null {
  db.prepare(
    `UPDATE consolidation_proposals SET status = ?, reviewed_at = ? WHERE id = ?`,
  ).run(decision, Date.now(), id);
  return (db
    .prepare(`SELECT * FROM consolidation_proposals WHERE id = ?`)
    .get(id) as ConsolidationProposal | undefined) ?? null;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
