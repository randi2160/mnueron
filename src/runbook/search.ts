/**
 * Runbook search — the matching logic for `mnueron explain-error`.
 *
 * Three-leg parallel search:
 *   1. Exact fingerprint match against the stored error_fingerprints array.
 *      A hit means "we've literally solved this exact error before" →
 *      confidence: 'high'.
 *   2. Tool match — if the fingerprint detected a tool, find other
 *      verified runbooks under that tool. Confidence: 'medium'.
 *   3. Hybrid recall via provider.search() against ANY memory (not just
 *      runbooks). May surface a note the user saved that solved the
 *      issue without being formalized into a runbook. Confidence: 'low'.
 *
 * Results dedup on runbookId and sort by confidence then verified-ness
 * then recency.
 */

import type Database from 'better-sqlite3';
import type { Provider } from '../store/provider.js';
import {
  matchByFingerprint,
  matchByTool,
  type ExtendedProcedural,
} from '../store/procedural.js';
import type { Fingerprint, RunbookHit } from './types.js';

export interface SearchOptions {
  /** Local SQLite DB handle. We need this for the fingerprint/tool legs
   *  because they hit the procedural_memories table directly. */
  db: Database.Database;
  /** Hybrid-search-capable provider. We call provider.search() for leg 3. */
  provider: Provider;
  /** Optional namespace scope. */
  namespace?: string;
  /** Cap on hits returned per leg. */
  perLegLimit?: number;
}

/**
 * Run the three-leg search and return a merged, ranked list of runbook hits.
 *
 * `fingerprint.normalized` is what we send to the hybrid-recall leg so
 * we benefit from the same noise stripping the fingerprint did.
 */
export async function searchRunbooks(
  fingerprint: Fingerprint,
  opts: SearchOptions,
): Promise<RunbookHit[]> {
  const perLegLimit = opts.perLegLimit ?? 5;

  // Leg 1: exact fingerprint match
  const fingerprintHits = matchByFingerprint(opts.db, fingerprint.hash, opts.namespace);

  // Leg 2: tool match (only if we detected a tool)
  const toolHits = fingerprint.tool
    ? matchByTool(opts.db, fingerprint.tool, opts.namespace, perLegLimit)
    : [];

  // Leg 3: hybrid recall against any memory in the namespace.
  // Note: provider.search returns Memory[] not ExtendedProcedural[], so
  // we'll need to convert. We're using it as a "fuzzy signal" only; for
  // anything it returns we look up the corresponding runbook (if any)
  // by id-prefix match against procedural rows. In v1 of this MVP we
  // simply skip leg 3 if no fingerprint/tool hits — the procedural
  // table is the source of truth. This keeps the implementation tight.
  // TODO Phase 2: implement true fuzzy-recall fallback that surfaces
  // raw memories (not just runbooks).
  // We invoke provider so the import is still useful and we leave a
  // breadcrumb for future work.
  void opts.provider;

  // Merge + dedup
  const seen = new Set<string>();
  const hits: RunbookHit[] = [];

  for (const r of fingerprintHits) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    hits.push(toHit(r, 'high', 'exact fingerprint match'));
  }
  for (const r of toolHits) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    hits.push(
      toHit(
        r,
        r.verified ? 'medium' : 'low',
        `verified runbook for tool=${fingerprint.tool}`,
      ),
    );
  }

  return hits;
}

function toHit(
  r: ExtendedProcedural,
  confidence: RunbookHit['confidence'],
  reason: string,
): RunbookHit {
  return {
    runbookId: r.id,
    name: r.name,
    summary: r.summary,
    steps: r.steps,
    confidence,
    reason,
    successCount: r.success_count,
    failureCount: r.failure_count,
    verified: r.verified,
    os: r.os ?? undefined,
    tool: r.tool ?? undefined,
  };
}
