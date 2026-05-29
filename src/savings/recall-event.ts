/**
 * Recall-event capture — logs every search() call so the savings
 * dashboard can show "tokens saved" / "dollars saved" / "IDE crashes
 * avoided" running totals.
 *
 * Capture happens inline in LocalProvider.search() (and the hosted
 * equivalent in `server/`). Two design rules:
 *
 *   1. **Fail-open.** A bad insert here must never break recall. Wrap
 *      the write in try/catch and warn — the user got their answer,
 *      that's what matters.
 *   2. **Privacy-safe.** We never store the raw query text in the
 *      database — only its sha256 hash (first 16 hex chars) for
 *      de-dupe. Tokens / namespaces / model IDs are fine because
 *      they're already in the memories table.
 *
 * The table is created idempotently from LocalProvider.migrate() so no
 * separate migration runner is needed.
 */

import { createHash, randomUUID } from 'node:crypto';
import { getModelPricing, wouldHaveExceededContext } from './pricing.js';

export interface RecallEventInput {
  /** Namespace the recall ran in (or null if global). */
  namespace?: string | null;
  /** The raw query string — hashed before storage. */
  query?: string;
  /** Total tokens in the memories returned to the caller. */
  tokens_returned: number;
  /** Total tokens in the namespace at recall time (sum-of-all-content). */
  tokens_baseline_namespace: number;
  /** Model ID the caller intends to use (passed via search input metadata). */
  model_id?: string | null;
  /** Which client called us (cursor / claude-desktop / openclaw / etc.). */
  client?: string | null;
}

export interface RecallEventRow {
  id: string;
  created_at: number;
  namespace: string | null;
  query_hash: string;
  tokens_returned: number;
  tokens_baseline_namespace: number;
  /** min(baseline_namespace, model_context_limit) — the realistic baseline. */
  tokens_baseline_capped: number;
  model_id: string | null;
  context_limit: number;
  client: string | null;
}

/** SQL DDL — kept here so the savings module owns its own schema. */
export const RECALL_EVENTS_DDL = `
  CREATE TABLE IF NOT EXISTS recall_events (
    id                         TEXT PRIMARY KEY,
    created_at                 INTEGER NOT NULL,
    namespace                  TEXT,
    query_hash                 TEXT NOT NULL,
    tokens_returned            INTEGER NOT NULL,
    tokens_baseline_namespace  INTEGER NOT NULL,
    tokens_baseline_capped     INTEGER NOT NULL,
    model_id                   TEXT,
    context_limit              INTEGER NOT NULL,
    client                     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_recall_events_created_at
    ON recall_events(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_recall_events_namespace
    ON recall_events(namespace);
  CREATE INDEX IF NOT EXISTS idx_recall_events_client
    ON recall_events(client);
`;

function hashQuery(query: string | undefined): string {
  if (!query) return '';
  return createHash('sha256').update(query).digest('hex').slice(0, 16);
}

/**
 * Build a RecallEventRow from raw inputs. Pure function — no DB access,
 * easy to unit-test. Caller persists it via the prepared insert.
 */
export function buildRecallEvent(input: RecallEventInput): RecallEventRow {
  const pricing = getModelPricing(input.model_id);
  const capped = Math.min(input.tokens_baseline_namespace, pricing.context_limit);
  return {
    id: randomUUID(),
    created_at: Date.now(),
    namespace: input.namespace ?? null,
    query_hash: hashQuery(input.query),
    tokens_returned: Math.max(0, Math.round(input.tokens_returned)),
    tokens_baseline_namespace: Math.max(0, Math.round(input.tokens_baseline_namespace)),
    tokens_baseline_capped: Math.max(0, Math.round(capped)),
    model_id: input.model_id ?? null,
    context_limit: pricing.context_limit,
    client: input.client ?? null,
  };
}

/**
 * True when this recall avoided an IDE crash / context-overflow. Used by
 * the dashboard summary to count "crashes avoided" — one of the most
 * visceral product metrics mnueron can show.
 */
export function eventAvoidedContextOverflow(row: RecallEventRow): boolean {
  return wouldHaveExceededContext(row.tokens_baseline_namespace, row.model_id);
}

/** Rough token count — same heuristic used elsewhere in mnueron (~4 chars/token). */
export function approximateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
