/**
 * P1 — Entity extraction for the local CLI / SQLite provider.
 *
 * Mirrors the hosted-backend entity-extractor (see ai-boilerplate-pro/src/lib/
 * entity-extractor.ts) but uses raw fetch for both providers to avoid pulling
 * the Anthropic SDK into the CLI's dependency tree. The CLI ships to npm and
 * gets installed globally by users, so we keep deps lean.
 *
 * Provider precedence (per-call BYOK keys never persisted):
 *   1. metadata.byok_anthropic_key  -> Claude Haiku via raw fetch
 *   2. metadata.byok_openai_key     -> gpt-4o-mini via raw fetch
 *   3. ANTHROPIC_API_KEY env var    -> Claude Haiku
 *   4. OPENAI_API_KEY env var       -> gpt-4o-mini
 *   5. none -> return [], save proceeds with no entities (fail-open)
 *
 * Gating: opt-in. set `metadata.extract_entities: true` per-call, or
 * the `MNUERON_ENABLE_ENTITY_EXTRACTION` env var globally.
 *
 * Fail-open across the board. Save never blocks on extraction.
 */

const MIN_LENGTH_CHARS = 200;
const ANTHROPIC_MODEL = 'claude-haiku-4-5';
const OPENAI_MODEL = 'gpt-4o-mini';
const MAX_CONTENT_CHARS = 12000;
const MAX_ENTITIES = 25;
const TIMEOUT_MS = 30000;

export interface ExtractedEntity {
  name: string;
  type: string;
  canonical_id?: string | null;
  context?: string;
}

export interface ExtractOptions {
  anthropicKey?: string;
  openaiKey?: string;
  minChars?: number;
}

export const ENTITY_EXTRACTION_ENABLED =
  (process.env.MNUERON_ENABLE_ENTITY_EXTRACTION ?? '').toLowerCase() === 'true';

// Process-wide circuit breaker. When either provider returns 429, we suspend
// extraction for a cooldown window so a single rate-limit hit doesn't turn
// into thousands of follow-on warnings (and doesn't keep consuming whatever
// quota remains in shorter time buckets). Saves continue with no entity tags.
//
// Cooldowns by detected scope:
//   - "per day"    -> 1 hour (daily quotas reset at the provider's midnight;
//                    an hour balances "stop spamming" vs. "retry if user upgrades")
//   - "per minute" -> 60 seconds
//   - "per second" -> 5 seconds
//   - unknown      -> 5 minutes
//
// One warn-line per disable event keeps the console clean.
let extractionDisabledUntil = 0;
let warnedThisCooldown = false;

function isExtractionRateLimited(): boolean {
  if (Date.now() < extractionDisabledUntil) return true;
  if (extractionDisabledUntil !== 0 && Date.now() >= extractionDisabledUntil) {
    // Cooldown elapsed -- clear so the next 429 can warn again.
    extractionDisabledUntil = 0;
    warnedThisCooldown = false;
  }
  return false;
}

function disableExtractionAfter429(provider: 'openai' | 'anthropic', body: string): void {
  const lower = body.toLowerCase();
  let durationMs = 5 * 60 * 1000; // default: 5 minutes
  let scope = 'unknown';
  if (lower.includes('per day')) {
    durationMs = 60 * 60 * 1000;
    scope = 'per-day';
  } else if (lower.includes('per minute')) {
    durationMs = 60 * 1000;
    scope = 'per-minute';
  } else if (lower.includes('per second')) {
    durationMs = 5 * 1000;
    scope = 'per-second';
  }
  extractionDisabledUntil = Math.max(extractionDisabledUntil, Date.now() + durationMs);
  if (!warnedThisCooldown) {
    warnedThisCooldown = true;
    const mins = Math.round(durationMs / 60000);
    console.warn(
      `[mnueron/entity-extractor] ${provider} returned 429 (${scope}). ` +
      `Suspending entity extraction for ~${mins}m. ` +
      `Saves will continue with no entity tags. ` +
      `Set MNUERON_ENABLE_ENTITY_EXTRACTION=false to opt out permanently.`,
    );
  }
}

/**
 * Per-call gate. Same shape as hosted-side `shouldExtractEntities`.
 *
 * Explicit per-call opt-in (metadata.extract_entities: true OR BYOK key)
 * always runs, even on short content. The length floor only applies to
 * the env-var default path, to keep that from burning money on noise.
 *
 * Circuit breaker: a recent 429 from either provider disables this gate
 * across the whole process for the cooldown window. Saves still complete
 * normally -- they just skip the LLM call that would have failed anyway.
 */
export function shouldExtractEntities(
  contentLen: number,
  metadata: Record<string, unknown> | undefined,
  minChars = MIN_LENGTH_CHARS,
): boolean {
  if (isExtractionRateLimited()) return false;
  if (metadata?.extract_entities === true) return true;
  const a = metadata?.byok_anthropic_key;
  if (typeof a === 'string' && a.length > 0) return true;
  const o = metadata?.byok_openai_key;
  if (typeof o === 'string' && o.length > 0) return true;
  if (ENTITY_EXTRACTION_ENABLED && contentLen >= minChars) return true;
  return false;
}

/**
 * Pull a structured entity list from `content`. Tries each provider in
 * order until one returns results. Returns `[]` on every failure.
 */
export async function extractEntities(
  content: string,
  opts: ExtractOptions = {},
): Promise<ExtractedEntity[]> {
  const min = opts.minChars ?? MIN_LENGTH_CHARS;
  if (!content || content.length < min) return [];
  const trimmed = content.slice(0, MAX_CONTENT_CHARS);

  try {
    if (opts.anthropicKey) {
      const out = await extractViaAnthropic(trimmed, opts.anthropicKey);
      if (out.length > 0) return cap(out);
    }
    if (opts.openaiKey) {
      const out = await extractViaOpenAI(trimmed, opts.openaiKey);
      if (out.length > 0) return cap(out);
    }
    if (process.env.ANTHROPIC_API_KEY) {
      const out = await extractViaAnthropic(trimmed, process.env.ANTHROPIC_API_KEY);
      if (out.length > 0) return cap(out);
    }
    if (process.env.OPENAI_API_KEY) {
      const out = await extractViaOpenAI(trimmed, process.env.OPENAI_API_KEY);
      if (out.length > 0) return cap(out);
    }
  } catch (e) {
    console.warn('[mnueron/entity-extractor]', e instanceof Error ? e.message : e);
  }
  return [];
}

const SYSTEM_PROMPT = [
  'You extract structured entities from memory text that will be stored',
  "alongside an AI agent's long-term memory. The goal is a list of",
  'recurring, identifiable, *referenceable* things — not a list of every',
  'noun in the text.',
  '',
  'For each entity found, output:',
  '',
  '  - name: the canonical display form (proper noun preferred)',
  '  - type: one of "person", "organization", "project", "technology",',
  '          "place", "decision", "event", "concept", "other"',
  '  - context: a short phrase (<= 80 chars) from the source that disambiguates',
  '             this entity from others with the same name. Optional.',
  '',
  'STRONG inclusion criteria — only emit an entity if it would survive these:',
  '  - Is it a proper noun, a named system, or a clearly bounded concept?',
  '    (YES: "Stripe", "Q3 roadmap", "PostgreSQL", "deprecate v1 API decision")',
  '    (NO:  "Step 1 view file", "DB-backed settings", "server-side validation")',
  '  - Will another memory plausibly reference this same thing again?',
  '    If you can\'t imagine a second memory mentioning it, skip it.',
  '  - Is it identifiable on its own? "the API" is not — "Stripe API v2" is.',
  '',
  'EXPLICIT EXCLUSIONS — never emit any of these:',
  '  - Action phrases / implementation steps ("Step 1", "set up X", "fix Y",',
  '    "DB-backed", "server-side validation", "role-based auth").',
  '  - Generic technical terms used as common nouns ("the database",',
  '    "the wizard", "the controller", "the API call").',
  '  - File paths or hostnames as "place" — those are "technology".',
  '  - Verbs or verb phrases as concepts.',
  '  - Single-letter or all-lowercase one-word concepts ("PROD" can stay if',
  '    it\'s clearly an environment label, but "qa" or "dev" alone — skip).',
  '  - Anything mentioned only once in passing with no further context.',
  '',
  'Type guidance:',
  '  - "place"      ONLY for real geographic locations (cities, offices,',
  '                 countries). Hostnames, URLs, file paths → "technology".',
  '  - "decision"   for explicit choices made ("we decided to use X").',
  '                 NOT for implementation steps or recommendations in passing.',
  '  - "project"    for named multi-task efforts ("Q3 roadmap", "Auth Rewrite").',
  '                 NOT for one-off files or single UI screens.',
  '  - "concept"    sparingly — only for abstract ideas referenced multiple times.',
  '',
  'Cap output at 25 entities; if more exist, pick the most important.',
  'If fewer than 2 high-quality entities exist, return [] — better to return',
  'nothing than to fill the list with noise.',
  '',
  'Respond with STRICT JSON. No prose, no preamble, no markdown.',
  'Schema:',
  '  { "entities": [ { "name": "...", "type": "...", "context": "..." }, ... ] }',
].join('\n');

async function extractViaAnthropic(
  content: string,
  apiKey: string,
): Promise<ExtractedEntity[]> {
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
        max_tokens: 1500,
        temperature: 0.1,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const body = await resp.text();
      if (resp.status === 429) {
        disableExtractionAfter429('anthropic', body);
      } else {
        console.warn(
          '[mnueron/entity-extractor/anthropic] HTTP ' + resp.status + ': ' + body.slice(0, 200),
        );
      }
      return [];
    }
    const data = (await resp.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = (data.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    return parseEntities(text);
  } catch (e) {
    console.warn('[mnueron/entity-extractor/anthropic]', e instanceof Error ? e.message : e);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function extractViaOpenAI(content: string, apiKey: string): Promise<ExtractedEntity[]> {
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
        model: OPENAI_MODEL,
        max_tokens: 1500,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const body = await resp.text();
      if (resp.status === 429) {
        disableExtractionAfter429('openai', body);
      } else {
        console.warn(
          '[mnueron/entity-extractor/openai] HTTP ' + resp.status + ': ' + body.slice(0, 200),
        );
      }
      return [];
    }
    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return parseEntities(data.choices?.[0]?.message?.content ?? '');
  } catch (e) {
    console.warn('[mnueron/entity-extractor/openai]', e instanceof Error ? e.message : e);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resilient JSON parse:
 *   - strips ```json ... ``` fences
 *   - skips leading prose ("Here are the entities:\n{...}")
 *   - accepts entities as bare array OR under `entities`/`results`/`items`
 */
function parseEntities(raw: string): ExtractedEntity[] {
  if (!raw) return [];
  let s = raw.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  }
  const start = s.search(/[\[{]/);
  if (start > 0) s = s.slice(start);

  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    return [];
  }

  const arr = pickEntitiesArray(parsed);
  if (!Array.isArray(arr)) return [];

  const out: ExtractedEntity[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    if (!name) continue;
    const type = typeof r.type === 'string' ? r.type.trim() : 'other';
    const context =
      typeof r.context === 'string' ? r.context.trim().slice(0, 80) : undefined;
    out.push({ name, type, context, canonical_id: null });
  }
  return dedupe(out);
}

function pickEntitiesArray(parsed: unknown): unknown {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    const p = parsed as Record<string, unknown>;
    if (Array.isArray(p.entities)) return p.entities;
    if (Array.isArray(p.results)) return p.results;
    if (Array.isArray(p.items)) return p.items;
    if (Array.isArray(p.extracted)) return p.extracted;
  }
  return null;
}

function dedupe(items: ExtractedEntity[]): ExtractedEntity[] {
  const seen = new Set<string>();
  const out: ExtractedEntity[] = [];
  for (const item of items) {
    const key = item.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function cap(items: ExtractedEntity[]): ExtractedEntity[] {
  return items.length > MAX_ENTITIES ? items.slice(0, MAX_ENTITIES) : items;
}
