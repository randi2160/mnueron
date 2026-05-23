// ─────────────────────────────────────────────────────────────────────────────
// Procedural memory — the "remembered workflows" feature.
//
// Mem0 / Letta / Zep all ship semantic and episodic memory (facts + events).
// Procedural is what they don't have: "the runbook for how to do X." A user
// asks the agent to deploy the API, the agent does it; mnueron captures the
// sequence of steps + tools used + key decisions and stores it as a named
// procedural memory. Next time someone asks "deploy the API", recall surfaces
// the runbook from memory instead of re-discovering it.
//
// Data model:
//   procedural_memories (
//     id, namespace, name, summary,
//     steps_json (ordered list of steps),
//     tools_json (tools / commands / files involved),
//     last_used_at, mention_count, created_at
//   )
//
// IMPORTANT — TIER GATING:
// This module is the LOCAL implementation; LLM calls fall through to env
// keys unconditionally because the operator IS the user. The hosted mirror
// (when built) must gate the LLM extraction by allowServerKey for paid tier,
// same policy as entity-extractor.ts and relation-extractor.ts.
// ─────────────────────────────────────────────────────────────────────────────

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

const ANTHROPIC_MODEL = 'claude-haiku-4-5';
const OPENAI_MODEL = 'gpt-4o-mini';
const TIMEOUT_MS = 30000;
const MAX_CONTENT_CHARS = 16000;
const MAX_STEPS = 30;

export interface ProceduralStep {
  /** Short imperative description ("Open PowerShell as admin"). */
  step: string;
  /** Optional code/command snippet associated with this step. */
  code?: string;
  /** Optional rationale ("Why this works"). */
  why?: string;
}

export interface ProceduralMemory {
  id: string;
  namespace: string;
  /** Short, slug-like name the user recalls by ("deploy-elevizio"). */
  name: string;
  /** One-sentence summary ("Build, push, redeploy on Lightsail"). */
  summary: string;
  steps: ProceduralStep[];
  /** Free-form tools/commands/files referenced ("dotnet", "git", "redeploy.sh"). */
  tools: string[];
  /** Epoch ms — most recently recalled (used to surface top-of-list). */
  last_used_at: number;
  /** How many times the user has recalled this. */
  use_count: number;
  created_at: number;
}

export interface ProceduralExtractOptions {
  anthropicKey?: string;
  openaiKey?: string;
}

// ── Schema bootstrap (idempotent) ───────────────────────────────────────────

export function ensureProceduralSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS procedural_memories (
      id            TEXT PRIMARY KEY,
      namespace     TEXT NOT NULL DEFAULT 'default',
      name          TEXT NOT NULL,
      summary       TEXT NOT NULL DEFAULT '',
      steps_json    TEXT NOT NULL DEFAULT '[]',
      tools_json    TEXT NOT NULL DEFAULT '[]',
      last_used_at  INTEGER NOT NULL,
      use_count     INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_procedural_namespace
      ON procedural_memories(namespace);
    CREATE INDEX IF NOT EXISTS idx_procedural_last_used
      ON procedural_memories(last_used_at DESC);
    -- Name is unique per-namespace so 'deploy' in 'work' and 'deploy' in
    -- 'home' don't collide. Users with one namespace see a flat list.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_procedural_name
      ON procedural_memories(namespace, lower(name));
  `);
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export interface SaveProceduralInput {
  name: string;
  namespace?: string;
  summary?: string;
  steps: ProceduralStep[];
  tools?: string[];
}

export function saveProcedural(
  db: Database.Database,
  input: SaveProceduralInput,
): ProceduralMemory {
  const now = Date.now();
  const ns = (input.namespace ?? 'default').trim();
  const name = input.name.trim();
  if (!name) throw new Error('procedural memory requires a name');
  const steps = (input.steps ?? []).slice(0, MAX_STEPS);
  const tools = (input.tools ?? []).filter((t) => typeof t === 'string' && t.length > 0);

  // UPSERT — same (namespace, name) replaces.
  const existing = db
    .prepare(`SELECT id, use_count FROM procedural_memories WHERE namespace = ? AND lower(name) = lower(?)`)
    .get(ns, name) as { id: string; use_count: number } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE procedural_memories
          SET summary    = ?,
              steps_json = ?,
              tools_json = ?,
              last_used_at = ?
        WHERE id = ?`,
    ).run(
      input.summary ?? '',
      JSON.stringify(steps),
      JSON.stringify(tools),
      now,
      existing.id,
    );
    return getProceduralById(db, existing.id)!;
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO procedural_memories
       (id, namespace, name, summary, steps_json, tools_json, last_used_at, use_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(
    id,
    ns,
    name,
    input.summary ?? '',
    JSON.stringify(steps),
    JSON.stringify(tools),
    now,
    now,
  );
  return getProceduralById(db, id)!;
}

export function getProceduralByName(
  db: Database.Database,
  name: string,
  namespace?: string,
): ProceduralMemory | null {
  const ns = (namespace ?? 'default').trim();
  const row = db
    .prepare(
      `SELECT * FROM procedural_memories
        WHERE namespace = ? AND lower(name) = lower(?)
        LIMIT 1`,
    )
    .get(ns, name.trim()) as ProceduralRow | undefined;
  return row ? rowToProcedural(row) : null;
}

export function getProceduralById(
  db: Database.Database,
  id: string,
): ProceduralMemory | null {
  const row = db
    .prepare(`SELECT * FROM procedural_memories WHERE id = ?`)
    .get(id) as ProceduralRow | undefined;
  return row ? rowToProcedural(row) : null;
}

export function listProcedural(
  db: Database.Database,
  opts: { namespace?: string; limit?: number; offset?: number } = {},
): ProceduralMemory[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
  const offset = Math.max(0, opts.offset ?? 0);
  const rows = (opts.namespace
    ? db.prepare(
        `SELECT * FROM procedural_memories WHERE namespace = ? ORDER BY last_used_at DESC LIMIT ? OFFSET ?`,
      ).all(opts.namespace, limit, offset)
    : db.prepare(
        `SELECT * FROM procedural_memories ORDER BY last_used_at DESC LIMIT ? OFFSET ?`,
      ).all(limit, offset)) as ProceduralRow[];
  return rows.map(rowToProcedural);
}

/**
 * Recall — bumps last_used_at + use_count so most-recently-recalled
 * floats to the top in list views.
 */
export function recallProcedural(
  db: Database.Database,
  name: string,
  namespace?: string,
): ProceduralMemory | null {
  const found = getProceduralByName(db, name, namespace);
  if (!found) return null;
  db.prepare(
    `UPDATE procedural_memories
        SET last_used_at = ?, use_count = use_count + 1
      WHERE id = ?`,
  ).run(Date.now(), found.id);
  return getProceduralById(db, found.id);
}

export function deleteProcedural(db: Database.Database, id: string): boolean {
  const r = db.prepare(`DELETE FROM procedural_memories WHERE id = ?`).run(id);
  return r.changes > 0;
}

// ── LLM-based extraction (turn a transcript into a runbook) ─────────────────

/**
 * Given the content of a memory (typically a chat transcript or session
 * summary), ask the LLM to extract a procedural memory: name, summary,
 * ordered steps, and the tools/commands involved.
 *
 * Returns null on any failure (fail-open).
 */
export async function extractProcedural(
  content: string,
  opts: ProceduralExtractOptions = {},
): Promise<{
  name: string;
  summary: string;
  steps: ProceduralStep[];
  tools: string[];
} | null> {
  if (!content || content.length < 100) return null;
  const trimmed = content.slice(0, MAX_CONTENT_CHARS);

  try {
    if (opts.anthropicKey) {
      const out = await extractViaAnthropic(trimmed, opts.anthropicKey);
      if (out) return out;
    }
    if (opts.openaiKey) {
      const out = await extractViaOpenAI(trimmed, opts.openaiKey);
      if (out) return out;
    }
    if (process.env.ANTHROPIC_API_KEY) {
      const out = await extractViaAnthropic(trimmed, process.env.ANTHROPIC_API_KEY);
      if (out) return out;
    }
    if (process.env.OPENAI_API_KEY) {
      const out = await extractViaOpenAI(trimmed, process.env.OPENAI_API_KEY);
      if (out) return out;
    }
  } catch (e) {
    console.warn(
      '[mnueron/procedural]',
      e instanceof Error ? e.message : e,
    );
  }
  return null;
}

const SYSTEM_PROMPT = [
  'You extract a PROCEDURAL memory from a chat transcript or memory text.',
  'A procedural memory is a runbook: "the steps to do this thing again."',
  '',
  'Output STRICT JSON with this schema:',
  '{',
  '  "name":    "<short slug-like name, lowercase-with-hyphens, e.g. deploy-elevizio>",',
  '  "summary": "<one sentence describing what this procedure accomplishes>",',
  '  "steps": [',
  '    { "step": "<imperative description>", "code": "<optional command/snippet>", "why": "<optional rationale>" },',
  '    ...',
  '  ],',
  '  "tools": ["<tool/command/file>", ...]',
  '}',
  '',
  'Rules:',
  '  - Only extract if the text describes a clear sequence of steps with',
  '    a recognizable goal. If the content is a conversation, debate, or',
  '    free exploration, return null (output literally null, no JSON).',
  '  - Steps must be ORDERED — preserve the sequence from the source.',
  '  - Step descriptions are short imperatives ("Run the build", not "we ran the build").',
  '  - Cap at 30 steps. If more exist, group sub-steps into parent steps.',
  '  - The "name" is a short identifier the user would recall by. Lowercase',
  '    with hyphens. Examples: deploy-api, fix-cors, build-extension.',
  '  - "tools" lists every command-line tool, script, file, or service touched.',
  '  - Skip exploratory wandering — only the steps that LED TO the outcome.',
].join('\n');

async function extractViaAnthropic(
  content: string,
  apiKey: string,
): Promise<{ name: string; summary: string; steps: ProceduralStep[]; tools: string[] } | null> {
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
        max_tokens: 2000,
        temperature: 0.0,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = (data.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    return parseProcedural(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function extractViaOpenAI(
  content: string,
  apiKey: string,
): Promise<{ name: string; summary: string; steps: ProceduralStep[]; tools: string[] } | null> {
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
        max_tokens: 2000,
        temperature: 0.0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return parseProcedural(data.choices?.[0]?.message?.content ?? '');
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseProcedural(
  raw: string,
): { name: string; summary: string; steps: ProceduralStep[]; tools: string[] } | null {
  if (!raw) return null;
  let s = raw.trim();
  if (s === 'null') return null;
  if (s.startsWith('```')) s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = s.search(/[\[{]/);
  if (start > 0) s = s.slice(start);

  let parsed: unknown;
  try { parsed = JSON.parse(s); }
  catch { return null; }

  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  const name = typeof p.name === 'string' ? p.name.trim().toLowerCase().replace(/\s+/g, '-') : '';
  if (!name) return null;
  const summary = typeof p.summary === 'string' ? p.summary.trim() : '';
  const stepsRaw = Array.isArray(p.steps) ? p.steps : [];
  const steps: ProceduralStep[] = [];
  for (const sr of stepsRaw) {
    if (!sr || typeof sr !== 'object') continue;
    const s = sr as Record<string, unknown>;
    const step = typeof s.step === 'string' ? s.step.trim() : '';
    if (!step) continue;
    steps.push({
      step,
      code: typeof s.code === 'string' && s.code.trim() ? s.code.trim() : undefined,
      why: typeof s.why === 'string' && s.why.trim() ? s.why.trim() : undefined,
    });
  }
  if (steps.length === 0) return null;
  const tools = Array.isArray(p.tools)
    ? (p.tools as unknown[]).filter((t): t is string => typeof t === 'string' && t.length > 0)
    : [];

  return { name, summary, steps: steps.slice(0, MAX_STEPS), tools };
}

// ── Internal ────────────────────────────────────────────────────────────────

interface ProceduralRow {
  id: string;
  namespace: string;
  name: string;
  summary: string;
  steps_json: string;
  tools_json: string;
  last_used_at: number;
  use_count: number;
  created_at: number;
}

function rowToProcedural(row: ProceduralRow): ProceduralMemory {
  let steps: ProceduralStep[] = [];
  let tools: string[] = [];
  try { steps = JSON.parse(row.steps_json); } catch { /* */ }
  try { tools = JSON.parse(row.tools_json); } catch { /* */ }
  return {
    id: row.id,
    namespace: row.namespace,
    name: row.name,
    summary: row.summary,
    steps: Array.isArray(steps) ? steps : [],
    tools: Array.isArray(tools) ? tools : [],
    last_used_at: row.last_used_at,
    use_count: row.use_count,
    created_at: row.created_at,
  };
}
