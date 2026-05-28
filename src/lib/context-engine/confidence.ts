/**
 * Confidence scoring + threshold logic for the Context Engine.
 *
 * The recall engine searches mnueron memory and returns candidates with
 * raw hybrid-search scores (BM25 + cosine). Those scores are good for
 * RANKING within a result set, but they're not directly interpretable
 * as "should I surface this to the user?"
 *
 * This module converts the raw signals (intent classification,
 * entity matches, raw recall score) into a single confidence value
 * 0..1, and gates surfacing decisions against a conservative threshold.
 *
 * Conservative default 0.75 — only surface high-confidence matches.
 * Users CAN explicitly lower it for "show me anything you've got" mode.
 */

import type { ContextIntent } from './intent.js';
import type { ContextEntities } from './entities.js';
import type { RunbookDetection } from './runbook-detector.js';

/** A single candidate suggestion before threshold filtering. */
export interface RankedCandidate {
  /** Source memory or runbook id. */
  id: string;
  /** What kind of suggestion. */
  kind: 'memory' | 'runbook';
  /** Raw hybrid-search score (or for runbooks, a composite score). */
  rawScore: number;
  /** The content/summary to show in the suggestion card. */
  content: string;
  /** Optional namespace the candidate was found in. */
  namespace?: string;
  /** Whether this candidate is a verified runbook (boost confidence). */
  verified?: boolean;
  /** For runbooks: success/failure counters (used as confidence prior). */
  successCount?: number;
  failureCount?: number;
}

/** A candidate that has passed the confidence gate. */
export interface ScoredSuggestion extends RankedCandidate {
  /** Final confidence 0..1 used for surfacing decisions. */
  confidence: number;
  /** Reason for the confidence — useful for debugging + tuning. */
  reason: string;
}

export interface ConfidenceConfig {
  /** Minimum confidence to surface. Default 0.75. */
  threshold: number;
  /** Maximum suggestions to return per call. Default 3. */
  maxSuggestions: number;
  /** If true, lower the threshold by 0.1 for runbooks specifically. */
  preferRunbooks: boolean;
}

export const DEFAULT_CONFIG: ConfidenceConfig = {
  threshold: 0.75,
  maxSuggestions: 3,
  preferRunbooks: true,
};

/**
 * Score a candidate by combining intent fit, entity overlap, raw search
 * score, and verified-runbook prior.
 *
 * The formula:
 *
 *   confidence = 0.45 * raw_score
 *              + 0.20 * intent_fit
 *              + 0.20 * entity_overlap
 *              + 0.15 * verified_prior
 *
 * Weights tuned for HIGH PRECISION. Boost factors:
 *   - Verified runbook with >0 successes:  +0.10
 *   - Verified runbook with >0 failures:   -0.05 (proven not always working)
 */
export function scoreCandidate(
  candidate: RankedCandidate,
  intent: ContextIntent,
  entities: ContextEntities,
  config: ConfidenceConfig = DEFAULT_CONFIG,
): ScoredSuggestion {
  const reasons: string[] = [];

  // ─── Raw search score (0.45 weight) ──────────────────────────────────
  // BM25+cosine RRF scores from LocalProvider are roughly [0..1].
  // For runbooks (from procedural_memories) we treat them as already
  // normalized.
  const rawComponent = Math.max(0, Math.min(1, candidate.rawScore)) * 0.45;
  reasons.push(`raw=${(rawComponent / 0.45).toFixed(2)}`);

  // ─── Intent fit (0.20 weight) ────────────────────────────────────────
  // High when the intent strongly matches the candidate kind. E.g.,
  // 'deploying' intent + runbook candidate = good fit. 'debugging' intent
  // + runbook with `tool=git` and matching error fingerprint = great fit.
  let intentFit = 0;
  if (intent.kind === 'none') {
    intentFit = 0.3; // no penalty for unclassified intent
  } else if (candidate.kind === 'runbook') {
    if (intent.kind === 'deploying' || intent.kind === 'debugging') intentFit = 1.0;
    else if (intent.kind === 'testing' || intent.kind === 'coding') intentFit = 0.7;
    else intentFit = 0.5;
  } else {
    // memory candidate
    intentFit = 0.6;
  }
  const intentComponent = intentFit * 0.20;
  reasons.push(`intent[${intent.kind}]=${intentFit.toFixed(2)}`);

  // ─── Entity overlap (0.20 weight) ────────────────────────────────────
  // How many query entities appear in the candidate content?
  const candidateLower = (candidate.content ?? '').toLowerCase();
  let overlap = 0;
  let possibleOverlap = 0;
  for (const tech of entities.technologies) {
    possibleOverlap++;
    if (candidateLower.includes(tech)) overlap++;
  }
  for (const file of entities.files) {
    possibleOverlap++;
    if (candidateLower.includes(file.toLowerCase())) overlap++;
  }
  if (entities.project) {
    possibleOverlap++;
    if (candidateLower.includes(entities.project.toLowerCase())) overlap++;
  }
  const overlapRatio = possibleOverlap > 0 ? overlap / possibleOverlap : 0.5;
  const overlapComponent = overlapRatio * 0.20;
  reasons.push(`entities=${overlap}/${possibleOverlap}`);

  // ─── Verified prior (0.15 weight) ────────────────────────────────────
  // A verified runbook with successful uses is more confident than an
  // unverified draft.
  let verifiedPrior = 0;
  if (candidate.kind === 'runbook') {
    const successes = candidate.successCount ?? 0;
    const failures = candidate.failureCount ?? 0;
    if (candidate.verified) verifiedPrior += 0.5;
    if (successes > 0) verifiedPrior += Math.min(0.5, successes * 0.1);
    if (failures > 0) verifiedPrior -= Math.min(0.3, failures * 0.05);
    verifiedPrior = Math.max(0, Math.min(1, verifiedPrior));
  } else {
    verifiedPrior = 0.3; // memories don't have verified state; neutral
  }
  const verifiedComponent = verifiedPrior * 0.15;
  reasons.push(`verified=${verifiedPrior.toFixed(2)}`);

  let confidence = rawComponent + intentComponent + overlapComponent + verifiedComponent;
  confidence = Math.max(0, Math.min(1, confidence));

  return {
    ...candidate,
    confidence,
    reason: reasons.join(' '),
  };
}

/**
 * Filter ranked candidates by threshold and rank. Returns at most
 * `config.maxSuggestions` candidates above `config.threshold`.
 */
export function filterByConfidence(
  scored: ScoredSuggestion[],
  config: ConfidenceConfig = DEFAULT_CONFIG,
): ScoredSuggestion[] {
  let threshold = config.threshold;

  // If runbook preference enabled and we have runbook candidates,
  // lower threshold for them by 0.1 (runbooks tend to be more
  // actionable than memories — worth surfacing slightly earlier).
  const surviving = scored.filter(s => {
    const effective = config.preferRunbooks && s.kind === 'runbook'
      ? Math.max(0.5, threshold - 0.1)
      : threshold;
    return s.confidence >= effective;
  });

  surviving.sort((a, b) => b.confidence - a.confidence);
  return surviving.slice(0, config.maxSuggestions);
}

/**
 * Decide whether to surface ANY suggestion. Used by the suggestion
 * service to short-circuit when no candidate clears the bar.
 *
 * Returns the surfaced list (possibly empty).
 */
export function gateSurfacing(
  candidates: RankedCandidate[],
  intent: ContextIntent,
  entities: ContextEntities,
  runbookDetection: RunbookDetection | null,
  config: ConfidenceConfig = DEFAULT_CONFIG,
): ScoredSuggestion[] {
  // If intent is 'none' and no entities of substance, don't bother.
  if (
    intent.kind === 'none' &&
    entities.files.length === 0 &&
    entities.commands.length === 0 &&
    entities.errors.length === 0 &&
    !runbookDetection?.isRunbook
  ) {
    return [];
  }

  const scored = candidates.map(c => scoreCandidate(c, intent, entities, config));
  return filterByConfidence(scored, config);
}
