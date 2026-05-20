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

/**
 * Per-call gate. Same shape as hosted-side `shouldExtractEntities`.
 *
 * Explicit per-call opt-in (metadata.extract_entities: true OR BYOK key)
 * always runs, even on short content. The length floor only applies to
 * the env-var default path, to keep that from burning money on noise.
 */
export function shouldExtractEntities(
  contentLen: number,
  metadata: Record<string, unknown> | undefined,
  minChars = MIN_LENGTH_CHARS,
): boolean {
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
  "alongside an AI agent's long-term memory. For each entity found, output:",
  '',
  '  - name: the canonical display form (proper noun preferred)',
  '  - type: one of "person", "organization", "project", "technology",',
  '          "place", "decision", "event", "concept", "other"',
  '  - context: a short phrase (<= 80 chars) from the source that disambiguates',
  '             this entity from others with the same name. Optional.',
  '',
  'Rules:',
  '  - Skip pronouns, common nouns, dates, generic phrases.',
  '  - Skip entities mentioned only in passing (e.g. boilerplate URLs).',
  '  - Prefer named, recurring entities over single-mention fluff.',
  '  - Decisions and recommendations DO count as entities. Use type "decision".',
  '  - Cap output at 25 entities; if more exist, pick the most important.',
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
      console.warn(
        '[mnueron/entity-extractor/anthropic] HTTP ' + resp.status + ': ' + body.slice(0, 200),
      );
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
      console.warn(
        '[mnueron/entity-extractor/openai] HTTP ' + resp.status + ': ' + body.slice(0, 200),
      );
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
