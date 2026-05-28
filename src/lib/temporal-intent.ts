/**
 * Temporal-intent classifier for queries.
 *
 * A query is "temporal" if answering it requires reasoning about WHEN
 * something happened, not just WHAT. Examples:
 *
 *   "When did Sarah change jobs?"         ← yes (explicit "when")
 *   "How long ago was the meeting?"       ← yes (duration)
 *   "What did Sarah do in March?"         ← yes (month anchor)
 *   "Before or after Tuesday?"            ← yes (relational)
 *   "What did Sarah say about hiking?"    ← no (purely semantic)
 *
 * Temporal queries benefit from:
 *   - Tier 2: timestamp-aware retrieval ranking (boost time-proximate memories)
 *   - Tier 4: chronological re-sort + anchor-proximity re-rank
 *
 * Non-temporal queries skip the temporal machinery entirely.
 *
 * Returns a structured TemporalIntent with:
 *   - `isTemporal`: boolean gate
 *   - `kind`: what KIND of temporal (when / duration / ordering / range)
 *   - `anchor`: extracted query time reference, if any (via date-anchors.ts)
 *
 * Pure module — no I/O, no DB. Trivially unit-testable.
 */

import { extractQueryAnchor, type DateAnchor } from './date-anchors.js';

export type TemporalKind =
  | 'when' // "when did X happen?"
  | 'duration' // "how long ago", "how many days/months"
  | 'ordering' // "before/after/first/last/earliest/latest"
  | 'range' // "between X and Y", "since March"
  | 'date-mention' // mentions a specific date/month but isn't asking about time
  | null; // not temporal

export interface TemporalIntent {
  isTemporal: boolean;
  kind: TemporalKind;
  /** Time anchor extracted from the query, if any (e.g. "last March"). */
  anchor: DateAnchor | null;
  /** Words that triggered the classification (debug + tuning). */
  triggers: string[];
}

// Strong markers — presence flips isTemporal=true with high confidence.
const TRIGGER_PATTERNS: Array<{ re: RegExp; kind: Exclude<TemporalKind, null> }> = [
  // "when did X happen", "when was Y"
  { re: /\bwhen\b/i, kind: 'when' },
  // "how long ago", "how many days/weeks/months/years"
  { re: /\bhow\s+long\b/i, kind: 'duration' },
  { re: /\bhow\s+many\s+(?:days|weeks|months|years|hours|minutes)\b/i, kind: 'duration' },
  { re: /\bago\b/i, kind: 'duration' },
  // ordering
  { re: /\bbefore\b/i, kind: 'ordering' },
  { re: /\bafter\b/i, kind: 'ordering' },
  { re: /\bprior\s+to\b/i, kind: 'ordering' },
  { re: /\bfirst\s+(?:time|did|was|met|said|asked)\b/i, kind: 'ordering' },
  { re: /\blast\s+(?:time|did|was|met|said|asked)\b/i, kind: 'ordering' },
  { re: /\bearliest\b/i, kind: 'ordering' },
  { re: /\blatest\b/i, kind: 'ordering' },
  // range
  { re: /\bbetween\s+\w+\s+and\s+\w+\b/i, kind: 'range' },
  { re: /\bsince\s+(?:\w+|the)\b/i, kind: 'range' },
  // explicit date/month mentions — weaker, only counts if no other signal yet
  { re: /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/i, kind: 'date-mention' },
  { re: /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i, kind: 'date-mention' },
  { re: /\b(?:yesterday|today|tomorrow|tonight)\b/i, kind: 'date-mention' },
];

export function classifyTemporal(query: string, now?: Date): TemporalIntent {
  if (!query) {
    return { isTemporal: false, kind: null, anchor: null, triggers: [] };
  }

  const triggers: string[] = [];
  let strongestKind: TemporalKind = null;

  for (const { re, kind } of TRIGGER_PATTERNS) {
    const m = re.exec(query);
    if (!m) continue;
    triggers.push(m[0].toLowerCase());
    // Priority: when > ordering > duration > range > date-mention.
    // Use first-match-wins by priority order in the array.
    if (strongestKind === null) strongestKind = kind;
  }

  const anchor = extractQueryAnchor(query, now);

  return {
    isTemporal: strongestKind !== null,
    kind: strongestKind,
    anchor,
    triggers,
  };
}

/**
 * Convenience: just the boolean gate, for places that don't need
 * the full classifier output.
 */
export function isTemporalQuery(query: string): boolean {
  return classifyTemporal(query).isTemporal;
}

/**
 * Compute a proximity score [0..1] between a memory and a query anchor.
 * 1.0 = same timestamp; decays with distance using a half-life schedule.
 *
 * Half-life is 30 days by default — most LoCoMo conversations span weeks,
 * so memories within ~1 month of the query anchor get strong boosts.
 *
 * Used by Tier 4 re-rank.
 */
export function temporalProximityScore(
  memoryTs: number | null | undefined,
  queryAnchor: DateAnchor | null,
  halfLifeMs = 30 * 24 * 60 * 60 * 1000,
): number {
  if (!memoryTs || !queryAnchor) return 0;
  const distMs = Math.abs(memoryTs - queryAnchor.resolved_ms);
  // Exponential decay: score = 0.5^(dist/halfLife)
  return Math.pow(0.5, distMs / halfLifeMs);
}
