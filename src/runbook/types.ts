/**
 * Mnueron Terminal Copilot — shared types.
 *
 * The Terminal Copilot recognizes repeated errors, looks them up in
 * procedural memory, suggests prior fixes, and writes/updates runbooks
 * on confirmation. This file holds the cross-module types.
 *
 * Storage strategy:
 *   We extend the existing `procedural_memories` table with optional
 *   columns (trigger_phrases, error_fingerprints, verified, os, tool,
 *   success_count, failure_count) rather than introducing a new table.
 *   Older runbooks remain valid — the new columns are nullable.
 */

/**
 * A normalized representation of a terminal error.
 *
 * `hash` is the stable key we match on. Two errors with the same root
 * cause but different paths/timestamps share the same hash. `normalized`
 * is the post-redaction, post-token-replacement string we hashed — kept
 * around for debugging ("why did this match?") and for human-readable
 * display in runbook entries.
 */
export interface Fingerprint {
  /** 12-char hex prefix of sha256(normalized). Storage + match key. */
  hash: string;
  /** The normalized text we hashed. Useful for debugging + display. */
  normalized: string;
  /** Detected tool ("git" | "npm" | "postgres" | ...), undefined if unknown. */
  tool?: string;
  /** Original raw text (post-redaction only — secrets already stripped). */
  redactedOriginal: string;
  /** Count + kinds of secrets redacted, surfaced to the user. */
  redactedCount: number;
  redactedKinds: string[];
}

/**
 * A runbook surfaced by the search step, with the reason it matched.
 *
 * Confidence ranking, highest first:
 *   - 'high'    — exact fingerprint match (we've solved this exact error before)
 *   - 'medium'  — tool match + summary-text fuzzy (probably the same family of issue)
 *   - 'low'     — hybrid recall hit only (might be tangentially related)
 */
export interface RunbookHit {
  /** The procedural memory row this hit corresponds to. */
  runbookId: string;
  /** Display name (e.g., "Fix git index.lock"). */
  name: string;
  /** One-sentence what-it-does. */
  summary: string;
  /** Ordered steps to apply the fix. */
  steps: Array<{ step: string; code?: string; why?: string }>;
  /** Match strength, drives sort order + UI hint. */
  confidence: 'high' | 'medium' | 'low';
  /** Why we matched ("fingerprint hit", "tool=git + fuzzy summary", "FTS5 keyword"). */
  reason: string;
  /** How many times this runbook has been confirmed to work. */
  successCount: number;
  /** How many times this runbook has been tried and failed. */
  failureCount: number;
  /** Whether the user has marked this runbook verified after a successful apply. */
  verified: boolean;
  /** OS the runbook was verified on, if any. */
  os?: string;
  /** Tool family detected at capture time. */
  tool?: string;
}

/**
 * Inputs for `mnueron runbook capture` — the interactive wizard.
 *
 * Each prompt is filled by the user via readline. After confirmation,
 * we either create a new runbook or update an existing one (dedup
 * driven by fingerprint match).
 */
export interface CapturedRunbook {
  /** Short, slug-like name. ("git-index-lock-fix") */
  name: string;
  /** One-sentence summary. */
  summary: string;
  /** The error text the user encountered. Redacted before storage. */
  errorText: string;
  /** The command that produced the error. */
  failingCommand: string;
  /** Step-by-step the user applied. */
  steps: Array<{ step: string; code?: string }>;
  /** Did the user confirm the fix worked? */
  fixWorked: boolean;
  /** Target namespace ("mnueron" default; user can override). */
  namespace: string;
}

/**
 * Result of dedup probe before save. If `existing` is set, the wizard
 * defaults to "update" rather than "create new".
 */
export interface DedupProbe {
  fingerprint: Fingerprint;
  existing?: {
    runbookId: string;
    name: string;
    summary: string;
  };
}
