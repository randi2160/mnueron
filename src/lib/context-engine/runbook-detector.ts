/**
 * Runbook-pattern detector.
 *
 * Given a chunk of active context, decide whether it looks like a
 * sequence of repeatable operational steps that the user might want to
 * save as a runbook. Triggers the "Do you want to create a runbook
 * from this?" suggestion.
 *
 * Different from `src/runbook/fingerprint.ts` (which fingerprints
 * INDIVIDUAL errors) and from `src/runbook/auto-extract.ts` (which
 * LLM-extracts from past Cowork chats). This detector is REAL-TIME and
 * regex-only — runs on every typing pause, decides "is this currently
 * being written like a runbook?"
 *
 * Signals it looks for:
 *
 *   1. Numbered or bulleted list of 3+ items
 *   2. Multiple fenced code blocks (commands) in sequence
 *   3. Imperative verbs at line starts ("Run", "Click", "Open", "Copy")
 *   4. Sequential step language ("first", "then", "next", "finally")
 *   5. Test pattern: each step is a single-line action + optional code
 *
 * NEGATIVE signals that demote runbook-confidence:
 *   - Continuous prose paragraphs without lists
 *   - Code that's clearly NOT a command (function definitions, classes)
 *   - Q&A or back-and-forth dialog
 *
 * Pure module — no I/O. Sibling to intent.ts and entities.ts.
 */

export interface RunbookDetection {
  /** Did we detect runbook-shaped content? */
  isRunbook: boolean;
  /** 0..1 confidence. Threshold 0.55 to suggest, 0.75 to auto-suggest. */
  confidence: number;
  /** Steps we managed to extract, if any. */
  steps: DetectedStep[];
  /** Suggested title for the runbook (from the first heading or imperative). */
  suggestedTitle: string | null;
  /** Signals that fired. */
  signals: string[];
}

export interface DetectedStep {
  /** Imperative description ("Open chrome://extensions"). */
  text: string;
  /** Code/command if the step has one. */
  code?: string;
  /** Source line number (for reference back to the original text). */
  sourceLine?: number;
}

export function detectRunbook(text: string): RunbookDetection {
  if (!text || text.trim().length < 30) {
    return { isRunbook: false, confidence: 0, steps: [], suggestedTitle: null, signals: [] };
  }

  const lines = text.split(/\r?\n/);
  const signals: string[] = [];
  let score = 0;

  // ─── Signal 1: numbered list of 3+ items ─────────────────────────────
  const numberedItems: Array<{ idx: number; text: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(\d+)[.)\]]\s+(.+)/);
    if (m) numberedItems.push({ idx: i, text: m[2].trim() });
  }
  if (numberedItems.length >= 3) {
    score += 0.5;
    signals.push(`numbered-list-${numberedItems.length}`);
  } else if (numberedItems.length === 2) {
    score += 0.2;
    signals.push('numbered-list-short');
  }

  // ─── Signal 2: bulleted list of 3+ items ─────────────────────────────
  const bulletItems: Array<{ idx: number; text: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*[-*•]\s+(.+)/);
    if (m) bulletItems.push({ idx: i, text: m[1].trim() });
  }
  if (bulletItems.length >= 4) {
    score += 0.35;
    signals.push(`bullet-list-${bulletItems.length}`);
  }

  // ─── Signal 3: fenced code blocks (multiple = command sequence) ──────
  const fencedBlocks = Array.from(text.matchAll(/```(?:bash|sh|powershell|ps1|zsh|fish|cmd|console)?\n([\s\S]*?)```/gi));
  if (fencedBlocks.length >= 2) {
    score += 0.4;
    signals.push(`fenced-code-${fencedBlocks.length}`);
  } else if (fencedBlocks.length === 1 && fencedBlocks[0][1].split('\n').filter(l => l.trim()).length >= 3) {
    score += 0.25;
    signals.push('fenced-code-multiline');
  }

  // ─── Signal 4: imperative verbs at line starts ───────────────────────
  // "Run X", "Open Y", "Click Z", "Copy ...", "Navigate to ..."
  // The `(?:\d+[.)\]]?\s+|[-*•]\s+)?` prefix allows list-marker text
  // BEFORE the imperative — so "1. Open Chrome" and "- Click button"
  // both count. Without this, numbered/bulleted runbooks hide their
  // imperatives behind list markers and score 0 on this signal.
  const imperativeRe = /^\s*(?:\d+[.)\]]\s+|[-*•]\s+)?(?:Run|Open|Click|Copy|Paste|Navigate|Type|Press|Enter|Select|Go\s+to|Visit|Download|Upload|Install|Verify|Check|Confirm|Wait|Save|Submit|Apply|Apply|Deploy|Push|Pull|Build|Test|Edit|Add|Remove|Delete|Update|Set|Configure|Start|Stop|Restart|Login|Sign\s+in|Sign\s+up|Connect|Disconnect|Toggle|Trigger|Verify)\s+/i;
  let imperativeCount = 0;
  for (const line of lines) {
    if (imperativeRe.test(line)) imperativeCount++;
  }
  if (imperativeCount >= 3) {
    score += 0.4;
    signals.push(`imperative-${imperativeCount}`);
  } else if (imperativeCount === 2) {
    score += 0.15;
    signals.push('imperative-pair');
  }

  // ─── Signal 5: sequential step language ──────────────────────────────
  const sequentialPhrases = [
    /\bfirst,?\s+\w+/i,
    /\bthen,?\s+\w+/i,
    /\bnext,?\s+\w+/i,
    /\bafter\s+(?:that|this),?\s+\w+/i,
    /\bfinally,?\s+\w+/i,
    /\blastly,?\s+\w+/i,
    /\bstep\s+\d+\b/i,
  ];
  const seqHits = sequentialPhrases.filter(re => re.test(text)).length;
  if (seqHits >= 2) {
    score += 0.25;
    signals.push(`sequential-${seqHits}`);
  }

  // ─── NEGATIVE: continuous prose ──────────────────────────────────────
  // If the text is mostly paragraphs with NO lists, NO commands, it's
  // probably explaining something rather than describing steps.
  const paragraphLines = lines.filter(l => l.trim().length > 80 && !l.match(/^\s*[\d-*•]/)).length;
  const totalNonEmpty = lines.filter(l => l.trim().length > 0).length;
  if (totalNonEmpty > 0 && paragraphLines / totalNonEmpty > 0.7 && score < 0.5) {
    score *= 0.5;
    signals.push('mostly-prose-demote');
  }

  // ─── NEGATIVE: dialog / Q&A pattern ──────────────────────────────────
  // "You: ... Claude: ..." or "Q: ... A: ..."
  const dialogRe = /^(?:you|claude|gpt|user|assistant|q|a)[:>]\s+/im;
  if (dialogRe.test(text)) {
    score *= 0.6;
    signals.push('dialog-demote');
  }

  const isRunbook = score >= 0.55;

  // ─── Extract steps if confident enough ───────────────────────────────
  let steps: DetectedStep[] = [];
  let suggestedTitle: string | null = null;

  if (score >= 0.4) {
    steps = extractSteps(lines, numberedItems, bulletItems, fencedBlocks);
    suggestedTitle = extractTitle(text, lines, steps);
  }

  return {
    isRunbook,
    confidence: Math.min(score, 1.0),
    steps,
    suggestedTitle,
    signals,
  };
}

// ─── Step extraction ──────────────────────────────────────────────────────

function extractSteps(
  lines: string[],
  numbered: Array<{ idx: number; text: string }>,
  bullets: Array<{ idx: number; text: string }>,
  fenced: RegExpMatchArray[],
): DetectedStep[] {
  const out: DetectedStep[] = [];

  // Prefer numbered list as the canonical step structure.
  const source = numbered.length >= 2 ? numbered : bullets.length >= 3 ? bullets : [];

  for (const item of source) {
    // Look ahead for an attached code block (line after this list item).
    let code: string | undefined;
    const nextLine = lines[item.idx + 1];
    if (nextLine?.match(/^\s*```/)) {
      // Walk until closing fence
      const fenceLines: string[] = [];
      for (let j = item.idx + 2; j < lines.length; j++) {
        if (lines[j].match(/^\s*```/)) break;
        fenceLines.push(lines[j]);
      }
      if (fenceLines.length > 0) {
        code = fenceLines.join('\n').slice(0, 1000);
      }
    } else {
      // Inline code in the step text itself
      const inlineCode = item.text.match(/`([^`]+)`/);
      if (inlineCode) code = inlineCode[1];
    }

    out.push({
      text: item.text.replace(/`([^`]+)`/g, '$1').slice(0, 500),
      ...(code ? { code } : {}),
      sourceLine: item.idx,
    });

    if (out.length >= 20) break;
  }

  // If we don't have list-based steps but DO have fenced code blocks,
  // synthesize each block as a step.
  if (out.length === 0 && fenced.length >= 2) {
    for (const f of fenced) {
      out.push({
        text: 'Run',
        code: f[1].trim().slice(0, 500),
      });
      if (out.length >= 10) break;
    }
  }

  return out;
}

/** Extract a title from the text — first markdown heading, or imperative line. */
function extractTitle(text: string, lines: string[], steps: DetectedStep[]): string | null {
  // Markdown heading first
  const headingMatch = text.match(/^#+\s+(.{5,120}?)$/m);
  if (headingMatch) return headingMatch[1].trim();

  // First line if it's short + descriptive
  const firstLine = lines.find(l => l.trim().length > 0);
  if (firstLine && firstLine.length < 100 && !firstLine.match(/^[\d-*•]/)) {
    return firstLine.trim();
  }

  // Synthesize from first step
  if (steps.length > 0) {
    return `${steps[0].text.slice(0, 80)}...`;
  }

  return null;
}
