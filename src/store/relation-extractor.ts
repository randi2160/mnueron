// ─────────────────────────────────────────────────────────────────────────────
// P3 — Relationship extraction.
//
// Given the content of a memory and the canonical entities P1+P2.3 already
// resolved for it, this module asks an LLM to extract the *relationships*
// between those entities. The result populates a `relations` table that
// turns the memory store into a queryable knowledge graph:
//
//   "John recommended deprecating the v1 API after the Q3 review"
//   →  (John) —[recommended]→ (deprecate v1 API)
//      (recommendation) —[came_from]→ (Q3 review)
//
// P4 — Bi-temporal extension lives in this same module. The same Haiku
// call is asked to also extract `valid_from` / `valid_to` windows where
// they're stated in the text ("worked at Stripe 2022 - April 2025"). When
// the text doesn't say, both fields stay null.
//
// Design echoes entity-extractor.ts:
//   - raw fetch (no SDK dep in the CLI bundle)
//   - BYOK precedence: metadata.byok_anthropic_key > env ANTHROPIC_API_KEY > env OPENAI_API_KEY
//   - fail-open: returns [] on any error
//   - cap the output so an over-eager LLM can't flood the graph
//
// Why a separate module from entity-extractor: it gets called LATER in the
// save path (after resolution), it sees the resolved canonical IDs, and
// the prompt is materially different. Sharing one module would tangle the
// gating logic.
// ─────────────────────────────────────────────────────────────────────────────

const ANTHROPIC_MODEL = 'claude-haiku-4-5';
const OPENAI_MODEL = 'gpt-4o-mini';
const MAX_CONTENT_CHARS = 12000;
const MAX_RELATIONS = 25;
const TIMEOUT_MS = 30000;

export interface ResolvedEntityForRelation {
  /** Canonical entity id (UUID). */
  canonical_id: string;
  /** Display name for the LLM prompt. */
  name: string;
  /** Entity type for the LLM prompt. */
  type: string;
}

export interface ExtractedRelation {
  /** Source canonical_id. Set null if extractor couldn't resolve. */
  from_canonical_id: string;
  /** Target canonical_id. */
  to_canonical_id: string;
  /** Lowercase, snake_case verb phrase ("recommended", "deprecated_for"). */
  predicate: string;
  /** [0, 1] — extractor's confidence the fact is true. */
  confidence: number;
  /** P4: epoch ms when the relationship became true. null if unspecified. */
  valid_from: number | null;
  /** P4: epoch ms when it stopped (null = still true). */
  valid_to: number | null;
}

export interface ExtractOptions {
  anthropicKey?: string;
  openaiKey?: string;
  /** Hosted gating flag. Defaults to false; the local CLI ignores it. */
  extractTemporal?: boolean;
}

/**
 * Returns true when we should run relationship extraction for a memory.
 * Requires at least TWO resolved entities (a relation needs both endpoints)
 * and an explicit opt-in via metadata or the global env var. We also gate
 * on content length to keep noise out of the graph.
 */
export function shouldExtractRelations(
  contentLen: number,
  entityCount: number,
  metadata: Record<string, unknown> | undefined,
): boolean {
  if (entityCount < 2) return false;
  if (contentLen < 80) return false; // skimpy memories rarely have real relations
  if (metadata?.extract_relations === true) return true;
  const a = metadata?.byok_anthropic_key;
  if (typeof a === 'string' && a.length > 0) return true;
  const o = metadata?.byok_openai_key;
  if (typeof o === 'string' && o.length > 0) return true;
  if ((process.env.MNUERON_ENABLE_RELATION_EXTRACTION ?? '').toLowerCase() === 'true') return true;
  return false;
}

/**
 * Pull structured relations between resolved entities. Returns [] on any
 * error. Caller is responsible for inserting the rows into `relations`.
 */
export async function extractRelations(
  content: string,
  entities: ResolvedEntityForRelation[],
  opts: ExtractOptions = {},
): Promise<ExtractedRelation[]> {
  if (!content || entities.length < 2) return [];
  const trimmed = content.slice(0, MAX_CONTENT_CHARS);

  try {
    if (opts.anthropicKey) {
      const out = await extractViaAnthropic(trimmed, entities, opts.anthropicKey);
      if (out.length > 0) return cap(out);
    }
    if (opts.openaiKey) {
      const out = await extractViaOpenAI(trimmed, entities, opts.openaiKey);
      if (out.length > 0) return cap(out);
    }
    if (process.env.ANTHROPIC_API_KEY) {
      const out = await extractViaAnthropic(trimmed, entities, process.env.ANTHROPIC_API_KEY);
      if (out.length > 0) return cap(out);
    }
    if (process.env.OPENAI_API_KEY) {
      const out = await extractViaOpenAI(trimmed, entities, process.env.OPENAI_API_KEY);
      if (out.length > 0) return cap(out);
    }
  } catch (e) {
    console.warn(
      '[mnueron/relation-extractor]',
      e instanceof Error ? e.message : e,
    );
  }
  return [];
}

const SYSTEM_PROMPT = [
  'You extract structured relationships between named entities from a memory',
  "text that will be stored alongside an AI agent's long-term knowledge graph.",
  '',
  'The user message has two parts:',
  '  1. CONTENT — the source text',
  '  2. ENTITIES — a numbered list of canonical entities ALREADY identified',
  '                in this text. Each has an id, name, and type.',
  '',
  'Your task: for every relationship the text asserts BETWEEN those entities,',
  'emit one row. You may also emit a row pointing to a NEW entity by using',
  'name + type (and leaving id null) — but prefer matching existing ids when',
  'possible.',
  '',
  'OUTPUT — STRICT JSON, no prose, no markdown. Schema:',
  '{',
  '  "relations": [',
  '    {',
  '      "from_id": "<entity id from ENTITIES list>",',
  '      "to_id":   "<entity id from ENTITIES list>",',
  '      "predicate": "<lowercase snake_case verb phrase>",',
  '      "confidence": <0.0 - 1.0>,',
  '      "valid_from": "<ISO 8601 date | null>",',
  '      "valid_to":   "<ISO 8601 date | null>"',
  '    }',
  '  ]',
  '}',
  '',
  'Rules:',
  '  - predicate: short, lowercase, snake_case. Use verbs that capture the',
  '    semantic. Examples: recommended, works_at, deprecated_for, decided_by,',
  '    reports_to, founded, mentioned_in, blocked_by.',
  '  - Skip pronoun-only and trivial relations.',
  '  - If a temporal window is stated ("from March 2022 to April 2025"),',
  '    fill valid_from/valid_to as ISO dates. If only a start is given,',
  '    leave valid_to null. If neither is stated, both null.',
  '  - Skip relations you are not confident about (confidence < 0.5).',
  '  - Cap output at 25 relations.',
].join('\n');

function buildUserMessage(
  content: string,
  entities: ResolvedEntityForRelation[],
): string {
  const list = entities
    .map((e, i) => `  ${i + 1}. id=${e.canonical_id}  name="${e.name}"  type=${e.type}`)
    .join('\n');
  return `CONTENT:\n${content}\n\nENTITIES:\n${list}`;
}

async function extractViaAnthropic(
  content: string,
  entities: ResolvedEntityForRelation[],
  apiKey: string,
): Promise<ExtractedRelation[]> {
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
        temperature: 0.0,
        system: SYSTEM_PROMPT,
        messages: [
          { role: 'user', content: buildUserMessage(content, entities) },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) return [];
    const data = (await resp.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = (data.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    return parseRelations(text, entities);
  } catch (e) {
    console.warn(
      '[mnueron/relation-extractor/anthropic]',
      e instanceof Error ? e.message : e,
    );
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function extractViaOpenAI(
  content: string,
  entities: ResolvedEntityForRelation[],
  apiKey: string,
): Promise<ExtractedRelation[]> {
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
        temperature: 0.0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserMessage(content, entities) },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) return [];
    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return parseRelations(data.choices?.[0]?.message?.content ?? '', entities);
  } catch (e) {
    console.warn(
      '[mnueron/relation-extractor/openai]',
      e instanceof Error ? e.message : e,
    );
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Resilient JSON parse + validation. Drops any row whose from_id / to_id
 *  isn't in the provided entities list — keeps the graph honest. */
function parseRelations(
  raw: string,
  entities: ResolvedEntityForRelation[],
): ExtractedRelation[] {
  if (!raw) return [];
  let s = raw.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  }
  const start = s.search(/[\[{]/);
  if (start > 0) s = s.slice(start);

  let parsed: unknown;
  try { parsed = JSON.parse(s); }
  catch { return []; }

  const arr =
    Array.isArray(parsed) ? parsed :
    parsed && typeof parsed === 'object' && Array.isArray((parsed as any).relations)
      ? (parsed as any).relations
      : [];

  const validIds = new Set(entities.map((e) => e.canonical_id));
  const out: ExtractedRelation[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const from_id = typeof r.from_id === 'string' ? r.from_id : '';
    const to_id   = typeof r.to_id   === 'string' ? r.to_id   : '';
    if (!validIds.has(from_id) || !validIds.has(to_id)) continue;
    if (from_id === to_id) continue; // self-loops are noise

    const predicate = typeof r.predicate === 'string'
      ? r.predicate.trim().toLowerCase().replace(/\s+/g, '_')
      : '';
    if (!predicate) continue;

    const confidence = typeof r.confidence === 'number'
      ? clamp01(r.confidence)
      : 0.7;
    if (confidence < 0.5) continue;

    out.push({
      from_canonical_id: from_id,
      to_canonical_id: to_id,
      predicate,
      confidence,
      valid_from: parseIsoDate(r.valid_from),
      valid_to:   parseIsoDate(r.valid_to),
    });
  }
  return out;
}

function parseIsoDate(v: unknown): number | null {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function cap(items: ExtractedRelation[]): ExtractedRelation[] {
  return items.length > MAX_RELATIONS ? items.slice(0, MAX_RELATIONS) : items;
}
