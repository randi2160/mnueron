/**
 * Date-anchor extraction from natural-language text.
 *
 * Used by:
 *   - LocalProvider.save() — Tier 3: stamps extracted anchors as
 *     metadata.temporal_anchors at ingestion time, so retrieval can
 *     answer "when did X happen" without LLM-side date arithmetic.
 *   - Benchmark adapter — Tier 4: extracts anchor from the QUERY,
 *     re-ranks retrieved memories by proximity to it.
 *   - LocalProvider.search() (future) — Tier 2: temporal-intent boost.
 *
 * Scope (intentional limits):
 *   - English-only patterns. The LoCoMo benchmark + Claude/ChatGPT
 *     dialogs are overwhelmingly English; non-English support is a
 *     separate hard problem and not on the roadmap.
 *   - Regex-only (no LLM call). Tradeoff: lower recall on weird
 *     phrasings like "the spring before last", but ~5 ms per extraction
 *     vs $0.0001 per LLM call. For a 700-memory session that's the
 *     difference between 3.5s of CPU and $0.07.
 *   - Year-disambiguation uses the anchor date as "now". A phrase like
 *     "last March" resolves relative to when the memory was saved.
 *
 * Returns absolute epoch-ms timestamps per anchor so downstream code
 * doesn't have to re-parse anything. Each anchor preserves the original
 * phrase for explainability ("matched 'last March' in memory X").
 */

export type AnchorKind =
  | 'absolute-date' // "March 15, 2024", "2024-03-15"
  | 'absolute-month' // "March 2024"
  | 'relative' // "yesterday", "two weeks ago", "last March"
  | 'day-of-week' // "Monday"
  | 'quarter'; // "Q1 2024"

export interface DateAnchor {
  /** The verbatim phrase from the source text. */
  phrase: string;
  /** Resolved Unix epoch in milliseconds. */
  resolved_ms: number;
  /** What kind of phrase this was (debug + tuning). */
  kind: AnchorKind;
  /** Confidence 0-1. Lower for ambiguous phrasings; higher for ISO dates. */
  confidence: number;
}

// ─── Month + day vocabulary ───────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  january: 0, jan: 0,
  february: 1, feb: 1,
  march: 2, mar: 2,
  april: 3, apr: 3,
  may: 4,
  june: 5, jun: 5,
  july: 6, jul: 6,
  august: 7, aug: 7,
  september: 8, sep: 8, sept: 8,
  october: 9, oct: 9,
  november: 10, nov: 10,
  december: 11, dec: 11,
};

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

const RELATIVE_UNIT_MS: Record<string, number> = {
  second: 1000, seconds: 1000, sec: 1000, secs: 1000,
  minute: 60_000, minutes: 60_000, min: 60_000, mins: 60_000,
  hour: 3_600_000, hours: 3_600_000, hr: 3_600_000, hrs: 3_600_000,
  day: 86_400_000, days: 86_400_000,
  week: 604_800_000, weeks: 604_800_000, wk: 604_800_000, wks: 604_800_000,
  month: 2_629_800_000, months: 2_629_800_000, // ~30.44 days
  year: 31_557_600_000, years: 31_557_600_000, // 365.25 days
};

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, dozen: 12,
  a: 1, an: 1, // "a week ago" = 1 week
};

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Extract every date phrase from `text` and resolve to absolute epoch-ms.
 *
 * `anchor` is the reference time for relative phrases. If a memory was
 * saved on 2024-05-15 and contains "last March", anchor=2024-05-15 →
 * resolved="2024-03 (i.e. 3 months ago)". If anchor is omitted, defaults
 * to Date.now().
 *
 * Returns anchors sorted by resolved_ms ascending. Empty array if none found.
 */
export function extractDateAnchors(text: string, anchor?: Date | number): DateAnchor[] {
  if (!text) return [];
  const anchorDate = anchor instanceof Date
    ? anchor
    : new Date(typeof anchor === 'number' ? anchor : Date.now());

  const out: DateAnchor[] = [];
  const seenSpans = new Set<string>(); // dedup by exact-phrase span

  for (const fn of [
    extractIsoDates,
    extractNumericDates,
    extractWrittenDates,
    extractAbsoluteMonths,
    extractQuarters,
    extractRelativeNAgo,
    extractRelativeUnit,
    extractWeekdays,
  ]) {
    for (const anch of fn(text, anchorDate)) {
      const key = `${anch.phrase}@${anch.resolved_ms}`;
      if (seenSpans.has(key)) continue;
      seenSpans.add(key);
      out.push(anch);
    }
  }

  out.sort((a, b) => a.resolved_ms - b.resolved_ms);
  return out;
}

// ─── Extractors ───────────────────────────────────────────────────────────

/** ISO 8601: 2024-03-15 or 2024-03-15T10:30:00Z. */
function extractIsoDates(text: string, _anchor: Date): DateAnchor[] {
  const out: DateAnchor[] = [];
  const re = /\b(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const [, y, mo, d, hh, mm, ss] = m;
    const ms = Date.UTC(+y, +mo - 1, +d, +(hh ?? 0), +(mm ?? 0), +(ss ?? 0));
    if (!Number.isFinite(ms)) continue;
    out.push({
      phrase: m[0],
      resolved_ms: ms,
      kind: 'absolute-date',
      confidence: 0.99,
    });
  }
  return out;
}

/** MM/DD/YYYY or M/D/YY (US-style; ambiguous DD/MM/YY accepted with lower conf). */
function extractNumericDates(text: string, _anchor: Date): DateAnchor[] {
  const out: DateAnchor[] = [];
  // 5/15/24, 05/15/2024
  const re = /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let [, a, b, y] = m;
    let yy = +y;
    if (yy < 100) yy += yy >= 50 ? 1900 : 2000;
    // Assume US MM/DD ordering. If first part > 12, assume DD/MM (less common).
    let month = +a - 1;
    let day = +b;
    if (+a > 12) {
      month = +b - 1;
      day = +a;
    }
    if (month < 0 || month > 11 || day < 1 || day > 31) continue;
    const ms = Date.UTC(yy, month, day);
    out.push({
      phrase: m[0],
      resolved_ms: ms,
      kind: 'absolute-date',
      confidence: +a > 12 ? 0.7 : 0.85,
    });
  }
  return out;
}

/** "March 15, 2024", "Mar 15 2024", "15 March 2024", "15th of March 2024". */
function extractWrittenDates(text: string, _anchor: Date): DateAnchor[] {
  const out: DateAnchor[] = [];
  const monthAlt = Object.keys(MONTHS).join('|');

  // "March 15, 2024" / "March 15 2024" / "Mar 15th, 2024"
  const re1 = new RegExp(
    `\\b(${monthAlt})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`,
    'gi',
  );
  for (let m: RegExpExecArray | null; (m = re1.exec(text)); ) {
    const mo = MONTHS[m[1].toLowerCase()];
    const d = +m[2];
    const y = +m[3];
    if (mo == null || d < 1 || d > 31) continue;
    out.push({
      phrase: m[0],
      resolved_ms: Date.UTC(y, mo, d),
      kind: 'absolute-date',
      confidence: 0.95,
    });
  }

  // "15 March 2024" / "15th of March, 2024"
  const re2 = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${monthAlt})(?:,?\\s+(\\d{4}))?\\b`,
    'gi',
  );
  for (let m: RegExpExecArray | null; (m = re2.exec(text)); ) {
    const d = +m[1];
    const mo = MONTHS[m[2].toLowerCase()];
    const y = m[3] ? +m[3] : new Date().getUTCFullYear();
    if (mo == null || d < 1 || d > 31) continue;
    out.push({
      phrase: m[0],
      resolved_ms: Date.UTC(y, mo, d),
      kind: 'absolute-date',
      confidence: m[3] ? 0.92 : 0.7,
    });
  }

  return out;
}

/** "March 2024", "in March 2024", "March of 2024". */
function extractAbsoluteMonths(text: string, _anchor: Date): DateAnchor[] {
  const out: DateAnchor[] = [];
  const monthAlt = Object.keys(MONTHS).join('|');
  const re = new RegExp(`\\b(?:in\\s+|of\\s+)?(${monthAlt})(?:\\s+of)?\\s+(\\d{4})\\b`, 'gi');
  for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
    const mo = MONTHS[m[1].toLowerCase()];
    const y = +m[2];
    out.push({
      phrase: m[0],
      resolved_ms: Date.UTC(y, mo, 1),
      kind: 'absolute-month',
      confidence: 0.9,
    });
  }
  return out;
}

/** "Q1 2024", "Q2 of 2024". */
function extractQuarters(text: string, _anchor: Date): DateAnchor[] {
  const out: DateAnchor[] = [];
  const re = /\bq([1-4])(?:\s+(?:of\s+)?(\d{4}))?\b/gi;
  for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
    const q = +m[1];
    const y = m[2] ? +m[2] : new Date().getUTCFullYear();
    const month = (q - 1) * 3;
    out.push({
      phrase: m[0],
      resolved_ms: Date.UTC(y, month, 1),
      kind: 'quarter',
      confidence: m[2] ? 0.9 : 0.65,
    });
  }
  return out;
}

/** "two weeks ago", "3 days ago", "a month ago". */
function extractRelativeNAgo(text: string, anchor: Date): DateAnchor[] {
  const out: DateAnchor[] = [];
  const unitAlt = Object.keys(RELATIVE_UNIT_MS).join('|');
  const numAlt = Object.keys(NUMBER_WORDS).join('|');
  const re = new RegExp(
    `\\b(\\d+|${numAlt})\\s+(${unitAlt})\\s+ago\\b`,
    'gi',
  );
  for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
    const numStr = m[1].toLowerCase();
    const n = NUMBER_WORDS[numStr] ?? +numStr;
    if (!Number.isFinite(n)) continue;
    const unitMs = RELATIVE_UNIT_MS[m[2].toLowerCase()];
    if (unitMs == null) continue;
    const ms = anchor.getTime() - n * unitMs;
    out.push({
      phrase: m[0],
      resolved_ms: ms,
      kind: 'relative',
      confidence: 0.85,
    });
  }
  return out;
}

/** "yesterday", "today", "tomorrow", "last week", "last month", "last March". */
function extractRelativeUnit(text: string, anchor: Date): DateAnchor[] {
  const out: DateAnchor[] = [];

  // yesterday / today / tomorrow
  for (const m of text.matchAll(/\b(yesterday|today|tomorrow|tonight)\b/gi)) {
    const word = m[1].toLowerCase();
    const offset = word === 'yesterday' ? -1 : word === 'tomorrow' ? +1 : 0;
    const d = new Date(anchor);
    d.setUTCDate(d.getUTCDate() + offset);
    d.setUTCHours(word === 'tonight' ? 20 : 12, 0, 0, 0);
    out.push({
      phrase: m[0],
      resolved_ms: d.getTime(),
      kind: 'relative',
      confidence: 0.9,
    });
  }

  // last week / last month / last year / next week / etc.
  for (const m of text.matchAll(/\b(last|next|this|previous|past)\s+(week|month|year)\b/gi)) {
    const dir = m[1].toLowerCase();
    const unit = m[2].toLowerCase();
    const sign = dir === 'next' ? +1 : dir === 'this' ? 0 : -1;
    const ms = RELATIVE_UNIT_MS[unit] ?? 0;
    out.push({
      phrase: m[0],
      resolved_ms: anchor.getTime() + sign * ms,
      kind: 'relative',
      confidence: 0.8,
    });
  }

  // last March / next March / etc. — resolves to nearest March in that direction
  const monthAlt = Object.keys(MONTHS).join('|');
  const reMonth = new RegExp(`\\b(last|next|this|previous)\\s+(${monthAlt})\\b`, 'gi');
  for (let m: RegExpExecArray | null; (m = reMonth.exec(text)); ) {
    const dir = m[1].toLowerCase();
    const mo = MONTHS[m[2].toLowerCase()];
    const y = anchor.getUTCFullYear();
    const curMo = anchor.getUTCMonth();
    let resolvedYear = y;
    if (dir === 'last' || dir === 'previous') {
      resolvedYear = mo < curMo ? y : y - 1;
    } else if (dir === 'next') {
      resolvedYear = mo > curMo ? y : y + 1;
    } // this March → current year
    out.push({
      phrase: m[0],
      resolved_ms: Date.UTC(resolvedYear, mo, 1),
      kind: 'relative',
      confidence: 0.85,
    });
  }

  return out;
}

/** "Monday", "last Monday", "Tuesday" — anchored against `anchor`. */
function extractWeekdays(text: string, anchor: Date): DateAnchor[] {
  const out: DateAnchor[] = [];
  const dayAlt = Object.keys(WEEKDAYS).join('|');
  // Only match standalone weekdays preceded by "last", "next", "this", or "on"
  // to avoid false positives on every "Monday" mention.
  const re = new RegExp(`\\b(?:(last|next|this|on)\\s+)?(${dayAlt})\\b`, 'gi');
  for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
    const dir = (m[1] ?? '').toLowerCase();
    if (!dir) continue; // skip standalone "Monday" without context
    const targetDay = WEEKDAYS[m[2].toLowerCase()];
    const curDay = anchor.getUTCDay();
    const diff = targetDay - curDay;
    let offsetDays =
      dir === 'next' ? (diff <= 0 ? diff + 7 : diff) :
      dir === 'last' ? (diff >= 0 ? diff - 7 : diff) :
      diff; // "this Monday" / "on Monday"
    const d = new Date(anchor);
    d.setUTCDate(d.getUTCDate() + offsetDays);
    d.setUTCHours(12, 0, 0, 0);
    out.push({
      phrase: m[0],
      resolved_ms: d.getTime(),
      kind: 'day-of-week',
      confidence: 0.75,
    });
  }
  return out;
}

// ─── Query-side helpers ───────────────────────────────────────────────────

/**
 * Returns the single most-likely time anchor from a question.
 *
 * "When did Sarah change jobs last March?" → the "last March" anchor.
 * "How long ago did the meeting happen?" → null (no anchor present).
 *
 * Used by the benchmark adapter to bias retrieval toward memories near
 * the query's time reference. If multiple anchors are present, prefers
 * the most specific (highest confidence).
 */
export function extractQueryAnchor(query: string, now?: Date): DateAnchor | null {
  const anchors = extractDateAnchors(query, now);
  if (anchors.length === 0) return null;
  // Prefer highest confidence; break ties by latest in text.
  return anchors.slice().sort((a, b) => b.confidence - a.confidence)[0];
}
