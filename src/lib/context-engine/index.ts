/**
 * Context Engine — top-level orchestrator.
 *
 * Single entrypoint that takes active context text + optional cwd and
 * returns a complete `ContextSignal` ready to be passed to the recall
 * engine.
 *
 * Combines:
 *   - intent.classifyIntent()
 *   - entities.extractEntities()
 *   - runbook-detector.detectRunbook()
 *
 * Used by the MCP tools (`recall_assist`, `runbook_suggest`) and any
 * future client (VS Code extension, browser ext suggestion watcher,
 * dashboard live-demo box).
 */

import { classifyIntent, type ContextIntent } from './intent.js';
import { extractEntities, type ContextEntities } from './entities.js';
import { detectRunbook, type RunbookDetection } from './runbook-detector.js';

export type { ContextIntent, IntentKind } from './intent.js';
export type { ContextEntities } from './entities.js';
export type { RunbookDetection, DetectedStep } from './runbook-detector.js';
export type {
  ConfidenceConfig,
  RankedCandidate,
  ScoredSuggestion,
} from './confidence.js';
export {
  DEFAULT_CONFIG,
  scoreCandidate,
  filterByConfidence,
  gateSurfacing,
} from './confidence.js';

/**
 * Full analysis of an active-context chunk.
 *
 * `intent` and `entities` always populated. `runbookDetection` only
 * populated when the text looks like it might be a runbook.
 */
export interface ContextSignal {
  /** What kind of task is the user doing? */
  intent: ContextIntent;
  /** What's mentioned in the text? */
  entities: ContextEntities;
  /** Does this look like a runbook the user might want to save? */
  runbookDetection: RunbookDetection;
  /** Suggested mnueron namespace(s) to search based on signal. */
  namespaceHints: string[];
  /** Whether the signal is strong enough to bother searching memory at all. */
  worthSearching: boolean;
}

export interface AnalyzeOptions {
  /** Current working directory (for project inference). */
  cwd?: string;
  /** Explicit project override. */
  project?: string;
  /** Namespace prefix conventions the caller wants to bias toward. */
  namespaceHints?: string[];
}

/**
 * Analyze active context. Pure function — no I/O.
 *
 * Returns a ContextSignal that the recall engine can use to decide:
 *   - What namespace(s) to search
 *   - Whether to look at procedural_memories (runbooks) vs memories
 *   - What confidence threshold to apply
 *   - Whether to offer the user to save THIS text as a runbook
 */
export function analyzeContext(text: string, opts: AnalyzeOptions = {}): ContextSignal {
  const intent = classifyIntent(text);
  const entities = extractEntities(text, {
    cwd: opts.cwd,
    explicitProject: opts.project,
  });
  const runbookDetection = detectRunbook(text);

  // ─── Namespace hints ──────────────────────────────────────────────────
  // Project namespace convention (from migration 040): `repo:<name>`.
  // If we have a project, prefer searching that namespace first; fall
  // back to broader namespaces if no hits.
  const namespaceHints: string[] = [];
  if (opts.namespaceHints?.length) {
    namespaceHints.push(...opts.namespaceHints);
  }
  if (entities.project) {
    namespaceHints.push(`repo:${entities.project}`);
    namespaceHints.push(`project:${entities.project}`);
  }
  // For runbook-shaped queries, also include the 'mnueron' namespace
  // (the default for `runbook capture` saves).
  if (runbookDetection.isRunbook || intent.kind === 'deploying' || intent.kind === 'debugging') {
    namespaceHints.push('mnueron');
  }
  // Always include 'default' as a fallback.
  if (!namespaceHints.includes('default')) namespaceHints.push('default');

  // ─── Worth searching? ────────────────────────────────────────────────
  // We skip the recall query entirely if the signal is so weak there's
  // no useful filter. Saves DB queries on every keystroke debounce.
  const worthSearching =
    intent.kind !== 'none' ||
    entities.files.length > 0 ||
    entities.commands.length > 0 ||
    entities.errors.length > 0 ||
    runbookDetection.confidence > 0.4 ||
    (entities.technologies.length > 0 && entities.technologies.length >= 2);

  return {
    intent,
    entities,
    runbookDetection,
    namespaceHints,
    worthSearching,
  };
}
