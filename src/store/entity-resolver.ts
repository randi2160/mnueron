// ─────────────────────────────────────────────────────────────────────────────
// P2.3 — Local SQLite entity resolution.
//
// Mirrors the hosted resolver (ai-boilerplate-pro/src/lib/entity-resolver.ts)
// but with one strategic change: where the hosted impl uses pg_trgm for
// fuzzy match, the local impl uses EMBEDDING SIMILARITY via sqlite-vec.
// We have @xenova/transformers running locally anyway, so the embedding is
// "free" (no API call). Embeddings are also more semantically robust than
// trigrams — "JS" and "JavaScript" cluster as the same entity by embedding
// where pg_trgm would treat them as totally different strings.
//
// Resolution pipeline:
//   1. Exact lowercase-name match (instant short-circuit, similarity = 1.0).
//   2. Embedding vector search: top-K candidates by cosine.
//   3. similarity ≥ HIGH (0.85) and matching type → reuse the canonical.
//   4. similarity in [AMBIGUOUS_LOW, HIGH) → batch LLM tiebreak via Haiku.
//   5. Otherwise → create a new canonical entity.
//
// Why same-type gating: a "person" named "John" should not merge with a
// "project" called "John". This mirrors the hosted impl's WHERE clause.
//
// Fail-open: every error path returns null/empty for that specific entity.
// The memory save still succeeds. Resolution can be re-run later via
// `mnueron entities backfill`.
// ─────────────────────────────────────────────────────────────────────────────

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { embed } from './embeddings.js';
import type { ExtractedEntity } from './entity-extractor.js';

/** Cosine ≥ this on type-match → auto-resolve to the candidate. */
const HIGH_CONFIDENCE_THRESHOLD = 0.85;
/** Cosine ≥ this but below HIGH → ambiguous, send to LLM tiebreak. */
const AMBIGUOUS_THRESHOLD = 0.65;
/** Top-K candidates considered per entity. */
const TIEBREAK_MAX_CANDIDATES = 3;
const ANTHROPIC_MODEL = 'claude-haiku-4-5';
const TIMEOUT_MS = 30000;

export interface ResolvedEntity {
  /** The canonical entity ID this surface form was resolved to. */
  canonical_id: string;
  /** Confidence (similarity score, or 1.0 for exact / new). */
  confidence: number;
  /** True if a fresh canonical row was created for this entity. */
  created: boolean;
}

export interface ResolveOptions {
  /** BYOK Anthropic key for LLM tiebreak. If absent + no env var, ambiguous
   *  cases fall through to "create new" (graceful degradation). */
  anthropicKey?: string;
  /** Whether to consult the LLM at all. Defaults to true. Set false to keep
   *  resolution fully deterministic (e.g., bulk backfill). */
  allowLLMTiebreak?: boolean;
}

interface EntityRow {
  id: string;
  display_name: string;
  entity_type: string;
  aliases_json: string;
  mention_count: number;
  first_seen_at: number;
  last_seen_at: number;
}

interface CandidateMatch {
  entity: EntityRow;
  similarity: number;
}

/**
 * Resolve every entity in `extracted` against the canonical entity store.
 * Returns the resolutions in the same order as `extracted`. Also writes
 * memory_entities edges and bumps mention bookkeeping.
 *
 * Pass the `vecAvailable` flag honestly — if sqlite-vec wasn't loaded at
 * provider startup, we skip the embedding stage and only do exact-name match.
 */
export async function resolveEntitiesForMemory(
  db: Database.Database,
  memoryId: string,
  extracted: ExtractedEntity[],
  vecAvailable: boolean,
  opts: ResolveOptions = {},
): Promise<Array<ResolvedEntity | null>> {
  if (extracted.length === 0) return [];

  const resolutions: Array<ResolvedEntity | null> = new Array(extracted.length).fill(null);
  const ambiguousIdxs: number[] = [];
  const ambiguousCandidates: CandidateMatch[][] = [];

  for (let i = 0; i < extracted.length; i++) {
    const ent = extracted[i];
    if (!ent.name) continue;

    // Stage 1 — exact match short-circuit.
    const exact = findExactMatch(db, ent.name, ent.type);
    if (exact) {
      resolutions[i] = { canonical_id: exact.id, confidence: 1.0, created: false };
      continue;
    }

    // Stage 2 — embedding similarity (only if sqlite-vec is loaded).
    if (vecAvailable) {
      const candidates = await findEmbeddingCandidates(db, ent);
      const top = candidates[0];
      if (top && top.similarity >= HIGH_CONFIDENCE_THRESHOLD) {
        resolutions[i] = {
          canonical_id: top.entity.id,
          confidence: top.similarity,
          created: false,
        };
        continue;
      }
      if (top && top.similarity >= AMBIGUOUS_THRESHOLD) {
        ambiguousIdxs.push(i);
        ambiguousCandidates.push(candidates);
        continue;
      }
    }
    // Stage 5 deferred — we collect un-resolved ones and create new
    // canonicals after the LLM tiebreak step decides what's truly new.
  }

  // Stage 4 — LLM tiebreak for ambiguous batch.
  const wantsLLM = opts.allowLLMTiebreak !== false;
  if (wantsLLM && ambiguousIdxs.length > 0) {
    const decisions = await tiebreakWithLLM(
      ambiguousIdxs.map((idx, k) => ({
        entity: extracted[idx],
        candidates: ambiguousCandidates[k],
      })),
      opts.anthropicKey,
    );
    for (let k = 0; k < ambiguousIdxs.length; k++) {
      const decision = decisions[k];
      const idx = ambiguousIdxs[k];
      if (decision && decision !== 'new') {
        const matched = ambiguousCandidates[k].find((c) => c.entity.id === decision);
        if (matched) {
          resolutions[idx] = {
            canonical_id: matched.entity.id,
            confidence: matched.similarity,
            created: false,
          };
        }
      }
    }
  }

  // Stage 5 — create new canonicals for anything still null.
  for (let i = 0; i < extracted.length; i++) {
    if (resolutions[i] !== null) continue;
    if (!extracted[i].name) continue;
    try {
      const created = await createCanonicalEntity(db, extracted[i], vecAvailable);
      resolutions[i] = { canonical_id: created.id, confidence: 1.0, created: true };
    } catch (e) {
      console.warn(
        '[mnueron/entity-resolver] createCanonical failed for',
        extracted[i].name,
        ':',
        e instanceof Error ? e.message : e,
      );
    }
  }

  // Stage 6 — bookkeeping: bump mention_count, last_seen_at, and add new
  // surface forms to aliases (for reused entities only — created ones
  // already start with their name as the lone alias).
  bumpReusedEntities(db, extracted, resolutions);

  // Stage 7 — insert memory_entities edges in one batch.
  linkMemoryToEntities(db, memoryId, extracted, resolutions);

  return resolutions;
}

// ── Match strategies ────────────────────────────────────────────────────────

/** O(1) exact (case-insensitive) name match within type. Returns null if none. */
function findExactMatch(
  db: Database.Database,
  name: string,
  type: string,
): EntityRow | null {
  const row = db
    .prepare<[string, string]>(
      `SELECT id, display_name, entity_type, aliases_json,
              mention_count, first_seen_at, last_seen_at
         FROM entities
        WHERE lower(display_name) = lower(?)
          AND entity_type = ?
        LIMIT 1`,
    )
    .get(name, type) as EntityRow | undefined;
  return row ?? null;
}

/**
 * Top-K embedding candidates. Embeds `name :: context` (context disambiguates
 * homonyms — "Apple the company" vs "Apple the fruit") and vector-searches
 * the entities_vec table.
 *
 * Type-filters the results post-vector-search rather than pre-filtering at
 * SQL level — sqlite-vec doesn't support WHERE on indexed columns yet, so
 * we ask for a wider K and filter in JS.
 */
async function findEmbeddingCandidates(
  db: Database.Database,
  entity: ExtractedEntity,
): Promise<CandidateMatch[]> {
  const probe = `${entity.name}${entity.context ? ' :: ' + entity.context : ''}`;
  const vec = await embed(probe);
  if (!vec) return [];

  // K=10 buffer so type-filter still leaves enough candidates.
  const rows = db
    .prepare<[Buffer, number]>(
      `SELECT entities_vec.entity_id AS id,
              entities_vec.distance   AS distance,
              e.display_name, e.entity_type, e.aliases_json,
              e.mention_count, e.first_seen_at, e.last_seen_at
         FROM entities_vec
         JOIN entities e ON e.id = entities_vec.entity_id
        WHERE embedding MATCH ?
          AND k = ?
        ORDER BY distance ASC`,
    )
    .all(Buffer.from(vec.buffer), 10) as Array<{
      id: string;
      distance: number;
      display_name: string;
      entity_type: string;
      aliases_json: string;
      mention_count: number;
      first_seen_at: number;
      last_seen_at: number;
    }>;

  // sqlite-vec returns L2 distance for float vectors. Convert to a
  // similarity in [0, 1] for parity with the hosted resolver's cosine
  // similarity. The normalized embeddings we use mean
  //   cosine ≈ 1 - distance²/2
  // and we clamp to [0, 1].
  const matches: CandidateMatch[] = rows
    .filter((r) => r.entity_type === entity.type)
    .map((r) => ({
      entity: {
        id: r.id,
        display_name: r.display_name,
        entity_type: r.entity_type,
        aliases_json: r.aliases_json,
        mention_count: r.mention_count,
        first_seen_at: r.first_seen_at,
        last_seen_at: r.last_seen_at,
      },
      similarity: clamp(1 - (r.distance * r.distance) / 2, 0, 1),
    }));
  return matches.slice(0, TIEBREAK_MAX_CANDIDATES);
}

// ── Mutations ───────────────────────────────────────────────────────────────

async function createCanonicalEntity(
  db: Database.Database,
  entity: ExtractedEntity,
  vecAvailable: boolean,
): Promise<{ id: string }> {
  const id = randomUUID();
  const now = Date.now();
  db.prepare<[string, string, string, string, number, number]>(
    `INSERT INTO entities
       (id, display_name, entity_type, aliases_json, mention_count, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
  ).run(id, entity.name, entity.type, JSON.stringify([entity.name]), now, now);

  if (vecAvailable) {
    const probe = `${entity.name}${entity.context ? ' :: ' + entity.context : ''}`;
    const vec = await embed(probe);
    if (vec) {
      db.prepare<[string, Buffer]>(
        `INSERT INTO entities_vec (entity_id, embedding) VALUES (?, ?)`,
      ).run(id, Buffer.from(vec.buffer));
    }
  }
  return { id };
}

/** Bump mention_count + last_seen_at; add surface_form to aliases if new. */
function bumpReusedEntities(
  db: Database.Database,
  extracted: ExtractedEntity[],
  resolutions: Array<ResolvedEntity | null>,
): void {
  const now = Date.now();
  const update = db.prepare<[number, string, string, string]>(
    `UPDATE entities
        SET mention_count = mention_count + 1,
            last_seen_at  = ?,
            aliases_json  = (
              SELECT json_group_array(DISTINCT value)
                FROM (
                  SELECT value FROM json_each(aliases_json)
                  UNION ALL
                  SELECT ?
                )
            )
      WHERE id = ?
        AND entity_type = ?`,
  );

  const tx = db.transaction(() => {
    for (let i = 0; i < extracted.length; i++) {
      const r = resolutions[i];
      if (!r || r.created) continue; // only bump reused, not freshly created
      update.run(now, extracted[i].name, r.canonical_id, extracted[i].type);
    }
  });
  tx();
}

function linkMemoryToEntities(
  db: Database.Database,
  memoryId: string,
  extracted: ExtractedEntity[],
  resolutions: Array<ResolvedEntity | null>,
): void {
  const stmt = db.prepare<[string, string, string, number]>(
    `INSERT INTO memory_entities (memory_id, entity_id, surface_form, confidence)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(memory_id, entity_id) DO UPDATE SET
       confidence = MAX(memory_entities.confidence, excluded.confidence)`,
  );
  const tx = db.transaction(() => {
    for (let i = 0; i < extracted.length; i++) {
      const r = resolutions[i];
      if (!r) continue;
      stmt.run(memoryId, r.canonical_id, extracted[i].name, r.confidence);
    }
  });
  tx();
}

// ── LLM tiebreak ────────────────────────────────────────────────────────────

interface AmbiguousCase {
  entity: ExtractedEntity;
  candidates: CandidateMatch[];
}

/**
 * Batch tiebreak — one Haiku call decides every ambiguous case in a memory.
 *
 * The output is an array parallel to `cases`. Each element is either a
 * canonical_id string (the entity matched candidate at that index) OR
 * the literal string `"new"` meaning "create a fresh canonical."
 *
 * On any error path (missing key, HTTP failure, parse failure), we return
 * all-"new" — the safer default (worst case: a few duplicate canonicals
 * the user can merge later via `mnueron entities merge`).
 */
async function tiebreakWithLLM(
  cases: AmbiguousCase[],
  byokKey: string | undefined,
): Promise<Array<string | 'new'>> {
  // Provider precedence mirrors entity-extractor.ts so users with only
  // OPENAI_API_KEY (and no Anthropic) get a working tiebreak instead of
  // falling through to all-"new". BYOK key (always Anthropic in this
  // build) wins; then env Anthropic; then env OpenAI; then bail.
  const anthropicKey = byokKey || process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!anthropicKey && !openaiKey) return cases.map(() => 'new');

  const numbered = cases
    .map((c, i) => {
      const cands = c.candidates
        .map((cand, j) => {
          let aliases: string[] = [];
          try { aliases = JSON.parse(cand.entity.aliases_json); } catch { /* */ }
          return `    [${j}] ${cand.entity.display_name} (${cand.entity.entity_type}, aliases: ${aliases.slice(0, 4).join(', ')})`;
        })
        .join('\n');
      const ctx = c.entity.context ? `\n  context: ${c.entity.context}` : '';
      return `Case ${i}:\n  New mention: "${c.entity.name}" (${c.entity.type})${ctx}\n  Candidates:\n${cands}`;
    })
    .join('\n\n');

  const system =
    'You disambiguate entity mentions for a memory store. For each Case, ' +
    'decide whether the new mention refers to one of the listed Candidates ' +
    'or is a brand new entity. Reply with strict JSON.\n\n' +
    'Schema: { "decisions": [{"case": <int>, "match": <int|"new">}, ...] }\n' +
    'For each case, set "match" to the candidate index (0, 1, 2) if same entity, ' +
    'or "new" if none match. Be conservative — only merge when confident.';

  if (anthropicKey) {
    const result = await tiebreakViaAnthropic(numbered, system, anthropicKey, cases);
    if (result) return result;
  }
  if (openaiKey) {
    const result = await tiebreakViaOpenAI(numbered, system, openaiKey, cases);
    if (result) return result;
  }
  return cases.map(() => 'new');
}

async function tiebreakViaAnthropic(
  numbered: string, system: string, apiKey: string, cases: AmbiguousCase[],
): Promise<Array<string | 'new'> | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 800,
        temperature: 0.0,
        system,
        messages: [{ role: 'user', content: numbered }],
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = (data.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    return parseDecisions(text, cases);
  } catch (e) {
    console.warn(
      '[mnueron/entity-resolver/anthropic] tiebreak failed:',
      e instanceof Error ? e.message : e,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function tiebreakViaOpenAI(
  numbered: string, system: string, apiKey: string, cases: AmbiguousCase[],
): Promise<Array<string | 'new'> | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 800,
        temperature: 0.0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: numbered },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return parseDecisions(data.choices?.[0]?.message?.content ?? '', cases);
  } catch (e) {
    console.warn(
      '[mnueron/entity-resolver/openai] tiebreak failed:',
      e instanceof Error ? e.message : e,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseDecisions(
  raw: string,
  cases: AmbiguousCase[],
): Array<string | 'new'> {
  const out: Array<string | 'new'> = cases.map(() => 'new');
  let s = raw.trim();
  if (s.startsWith('```')) s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = s.search(/[\[{]/);
  if (start > 0) s = s.slice(start);

  try {
    const parsed = JSON.parse(s) as {
      decisions?: Array<{ case?: number; match?: number | string }>;
    };
    for (const d of parsed.decisions ?? []) {
      if (typeof d.case !== 'number') continue;
      if (d.case < 0 || d.case >= cases.length) continue;
      const m = d.match;
      if (m === 'new' || m == null) {
        out[d.case] = 'new';
      } else if (
        typeof m === 'number' &&
        m >= 0 &&
        m < cases[d.case].candidates.length
      ) {
        out[d.case] = cases[d.case].candidates[m].entity.id;
      }
    }
  } catch {
    // Stay on default — all "new".
  }
  return out;
}

// ── Utility ─────────────────────────────────────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}
y({
        model: 'gpt-4o-mini',
        max_tokens: 800,
        temperature: 0.0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: numbered },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return parseDecisions(data.choices?.[0]?.message?.content ?? '', cases);
  } catch (e) {
    console.warn(
      '[mnueron/entity-resolver/openai] tiebreak failed:',
      e instanceof Error ? e.message : e,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseDecisions(
  raw: string,
  cases: AmbiguousCase[],
): Array<string | 'new'> {
  const out: Array<string | 'new'> = cases.map(() => 'new');
  let s = raw.trim();
  if (s.startsWith('```')) s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = s.search(/[\[{]/);
  if (start > 0) s = s.slice(start);

  try {
    const parsed = JSON.parse(s) as {
      decisions?: Array<{ case?: number; match?: number | string }>;
    };
    for (const d of parsed.decisions ?? []) {
      if (typeof d.case !== 'number') continue;
      if (d.case < 0 || d.case >= cases.length) continue;
      const m = d.match;
      if (m === 'new' || m == null) {
        out[d.case] = 'new';
      } else if (
        typeof m === 'number' &&
        m >= 0 &&
        m < cases[d.case].candidates.length
      ) {
        out[d.case] = cases[d.case].candidates[m].entity.id;
      }
    }
  } catch {
    // Stay on default — all "new".
  }
  return out;
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}
─────────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}
