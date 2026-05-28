/**
 * Context-intent classifier.
 *
 * Given the user's active context (current text in editor, chat input,
 * doc, etc.), classify WHAT KIND of task they're doing:
 *
 *   coding       — writing/editing source code
 *   deploying    — release / rollout / production push
 *   debugging    — investigating an error, reading logs, fixing a bug
 *   testing      — writing test cases, QA, validation
 *   documenting  — readme, comments, API docs, runbooks
 *   planning     — design doc, roadmap, sprint planning, architecture
 *   temporal     — questions about when things happened (reuses temporal-intent)
 *   none         — fallback when no strong signal
 *
 * This is the gate for everything downstream: which namespace to search,
 * which kind of recall to prefer (memories vs runbooks), what confidence
 * threshold to apply.
 *
 * Pure module — no I/O, no DB, no LLM. Trivially unit-testable. The
 * patterns are tuned to be HIGH PRECISION (false positives are worse
 * than misses for the "should I surface a suggestion?" use case).
 */

import { isTemporalQuery } from '../temporal-intent.js';

export type IntentKind =
  | 'coding'
  | 'deploying'
  | 'debugging'
  | 'testing'
  | 'documenting'
  | 'planning'
  | 'temporal'
  | 'none';

export interface ContextIntent {
  kind: IntentKind;
  /** 0..1. Higher = more confident this kind matches. */
  confidence: number;
  /** Patterns that fired (debug + tuning). */
  signals: string[];
}

/**
 * Patterns per intent kind. Order matters within an array — the first
 * match wins for tie-breaking when two kinds score equal.
 *
 * Each entry has a regex + a weight 0-1. Multiple matches in the same
 * kind compound (capped at 1.0). The kind with the highest total weight
 * wins.
 */
const SIGNALS: Record<Exclude<IntentKind, 'temporal' | 'none'>, Array<{ re: RegExp; w: number; label: string }>> = {
  coding: [
    // Source-code markers
    { re: /```(?:typescript|javascript|tsx?|jsx?|python|py|go|rust|java|c\+\+|cpp|csharp|cs|ruby|rb|php|swift|kotlin|scala|sql)\b/i, w: 0.6, label: 'fenced-code-lang' },
    { re: /\b(?:function|const|let|var|import|export|class|interface|def|async|await)\s+[a-z_]/i, w: 0.45, label: 'language-keyword' },
    { re: /\b(?:return|throw|try|catch|if|else|for|while|switch)\b.*[{(]/i, w: 0.25, label: 'control-flow' },
    { re: /\.(?:then|catch|map|filter|reduce|forEach)\b/, w: 0.35, label: 'method-chain' },
    { re: /\b(?:writing|coding|implementing|refactoring|fixing|adding)\s+(?:a\s+)?(?:function|method|class|component|endpoint|api|route|handler)\b/i, w: 0.55, label: 'verb-noun' },
    // File paths in src/, components/, lib/, etc.
    { re: /\b(?:src|components|lib|hooks|utils|services|controllers|routes|pages|app)\/[a-z0-9-_/]+\.(?:ts|tsx|js|jsx|py|go|rs|java|cs|rb|php|swift|kt)\b/i, w: 0.5, label: 'src-file-path' },
  ],
  deploying: [
    { re: /\b(?:deploy(?:ing|ment)?|rollout|roll\s+out|release|push\s+to\s+(?:prod|production|staging|live))\b/i, w: 0.7, label: 'deploy-verb' },
    { re: /\b(?:vercel|netlify|fly\.io|railway|render|heroku|aws|gcp|azure|kubernetes|k8s|docker)\s+(?:deploy|push|build)/i, w: 0.6, label: 'platform-deploy' },
    { re: /\b(?:git\s+push|npm\s+publish|cargo\s+publish|pip\s+upload|docker\s+push)\b/i, w: 0.55, label: 'publish-cmd' },
    { re: /\b(?:rolling\s+back|hotfix|cab(?:\s+release)?|prod\s+(?:incident|release))\b/i, w: 0.65, label: 'release-event' },
    { re: /\b(?:staging|production)\s+(?:server|env|environment)\b/i, w: 0.45, label: 'env-mention' },
    { re: /\bblue-green\b|\bcanary\b/i, w: 0.5, label: 'deploy-strategy' },
  ],
  debugging: [
    { re: /\b(?:error|exception|failure|failed|fatal|panic|stack\s+trace|traceback)\b/i, w: 0.55, label: 'error-noun' },
    { re: /\bfix(?:ing|ed)?\s+(?:a\s+)?(?:bug|issue|error|problem|crash)\b/i, w: 0.65, label: 'fix-verb' },
    { re: /\b(?:debug(?:ging)?|investigate|investigating|root\s+cause|why\s+is|what's\s+wrong)\b/i, w: 0.6, label: 'debug-verb' },
    { re: /\b(?:sqlstate|err_|errno|err\s+\d|http\s+(?:4|5)\d{2})\b/i, w: 0.55, label: 'error-code' },
    { re: /\b(?:not\s+working|broken|crashing|hangs|times?\s+out)\b/i, w: 0.45, label: 'broken-phrase' },
    { re: /\b(?:console\.log|print\(|debugger|breakpoint|pdb|gdb)\b/i, w: 0.4, label: 'debug-tool' },
  ],
  testing: [
    { re: /\b(?:test(?:s|ing|ed)?|spec(?:s)?|describe|it\(|expect\(|assert(?:Equals?|True|False)?)\b/i, w: 0.5, label: 'test-verb' },
    { re: /\b(?:vitest|jest|mocha|chai|pytest|unittest|rspec|junit|xunit)\b/i, w: 0.65, label: 'test-framework' },
    { re: /\b(?:qa|q\.a\.|quality\s+assurance|test\s+plan|test\s+case|cr\s+coverage|cab\s+coverage|regression\s+test)\b/i, w: 0.6, label: 'qa-noun' },
    { re: /\b(?:writing|adding|fixing)\s+(?:a\s+)?test/i, w: 0.55, label: 'verb-test' },
    { re: /\b(?:should|must|expects?\s+to)\s+(?:return|throw|equal|contain|match)\b/i, w: 0.4, label: 'assertion-language' },
  ],
  documenting: [
    { re: /\b(?:docu?mentation|readme|docstring|api\s+docs|user\s+guide|how-?to)\b/i, w: 0.6, label: 'doc-noun' },
    { re: /\bwriting\s+(?:a\s+)?(?:doc|guide|readme|tutorial|spec|specification)\b/i, w: 0.6, label: 'writing-doc' },
    { re: /\b(?:markdown|\.md\b|<!--|jsdoc|tsdoc|sphinx|docusaurus)\b/i, w: 0.45, label: 'doc-format' },
    { re: /\b(?:install(?:ation)?|setup|getting\s+started|quickstart|configure)\b/i, w: 0.4, label: 'setup-doc-topic' },
    { re: /^#+\s+/m, w: 0.3, label: 'md-header' },
  ],
  planning: [
    { re: /\b(?:roadmap|sprint|planning|design\s+doc|rfc|architecture|adr)\b/i, w: 0.65, label: 'planning-noun' },
    { re: /\b(?:should\s+we|let'?s|we\s+need\s+to|next\s+up|todo|tbd|wip)\b/i, w: 0.3, label: 'planning-phrase' },
    { re: /\b(?:decision|decided|trade-?off|alternative(?:s)?|considered)\b/i, w: 0.45, label: 'decision-language' },
    { re: /\b(?:phase\s+\d|milestone|deadline|deliverable)\b/i, w: 0.5, label: 'milestone' },
    { re: /\b(?:goal|objective|requirement|user\s+story|acceptance\s+criteria)\b/i, w: 0.5, label: 'goal-language' },
  ],
};

/**
 * Classify the active context. Returns the highest-scoring intent above
 * a minimum signal floor of 0.25 (below that, it's "none").
 *
 * Why not multi-label: in practice the user is doing one thing at a
 * time. A single intent keeps the downstream namespace/threshold logic
 * deterministic. If multi-label is needed later, we can return a sorted
 * list and let callers consume top-N.
 */
export function classifyIntent(text: string): ContextIntent {
  if (!text || text.trim().length < 5) {
    return { kind: 'none', confidence: 0, signals: [] };
  }

  // Special case: temporal queries are detected by a separate, more
  // specific classifier we already shipped. If it fires AND no other
  // intent scores higher, return 'temporal'.
  const isTemporal = isTemporalQuery(text);

  // Score each non-temporal kind.
  const scores: Record<string, { score: number; signals: string[] }> = {};
  for (const [kind, patterns] of Object.entries(SIGNALS)) {
    let total = 0;
    const hits: string[] = [];
    for (const p of patterns) {
      if (p.re.test(text)) {
        total += p.w;
        hits.push(p.label);
      }
    }
    // Cap at 1.0 — diminishing returns past full signal.
    scores[kind] = { score: Math.min(total, 1.0), signals: hits };
  }

  // Pick the top-scoring kind.
  let topKind: IntentKind = 'none';
  let topScore = 0;
  let topSignals: string[] = [];
  for (const [kind, { score, signals }] of Object.entries(scores)) {
    if (score > topScore) {
      topKind = kind as IntentKind;
      topScore = score;
      topSignals = signals;
    }
  }

  // Minimum floor: if nothing fired above 0.25, treat as 'none' unless
  // it's a clear temporal query (which can have its own classifier hit).
  if (topScore < 0.25) {
    if (isTemporal) {
      return { kind: 'temporal', confidence: 0.6, signals: ['temporal-classifier'] };
    }
    return { kind: 'none', confidence: 0, signals: [] };
  }

  // Temporal-vs-other tiebreak: if temporal fires AND another intent
  // scores below 0.45, prefer temporal (it's a more specific signal).
  if (isTemporal && topScore < 0.45) {
    return { kind: 'temporal', confidence: 0.6, signals: ['temporal-classifier'] };
  }

  return { kind: topKind, confidence: topScore, signals: topSignals };
}
