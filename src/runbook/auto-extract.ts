/**
 * `mnueron runbook auto-extract` — read recent Cowork sessions and
 * propose runbooks for any error→fix patterns mnueron already saw the
 * AI solve in chat.
 *
 * The premise: every fix the user worked through with Claude is already
 * in the local DB (via the `mnueron-cowork-daily-sync` scheduled task
 * that runs every 4 hours). Asking the user to retype that into the
 * `runbook capture` wizard is busywork. Instead, scan the recent
 * memories, find error→fix pairs, hand them to an LLM to format as
 * runbooks, and present a review UI with one-tap save.
 *
 * Pipeline:
 *   1. Query memories where namespace LIKE 'claude-cowork%' since N hours ago
 *   2. Group by source_ref (one session = one source_ref)
 *   3. Walk each session chronologically — find error-shaped chunks
 *   4. Auto-verify: a candidate counts as "fixed" if the next 1-2
 *      chunks don't share the same error fingerprint
 *   5. LLM-extract each candidate into a structured runbook draft
 *   6. Review UI: [s]ave / [e]dit-in-wizard / [k]ip per draft
 *   7. Save approved drafts (with dedup against existing fingerprints)
 *
 * Cost: ~$0.001-0.005 per pass with Haiku, depending on session length.
 * Dramatically cheaper than re-deriving the same fix two months later.
 */

import { createInterface, type Interface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { platform } from 'node:os';
import { loadConfig } from '../config.js';
import { openLocalDb } from '../store/local-db.js';
import { redact } from '../store/redactor.js';
import { fingerprintError } from './fingerprint.js';
import type Database from 'better-sqlite3';

const ANTHROPIC_MODEL = 'claude-haiku-4-5';
const OPENAI_MODEL = 'gpt-4o-mini';
const TIMEOUT_MS = 30000;
const MAX_EXTRACT_CHARS = 6000; // truncate per-candidate LLM context

interface MemoryRow {
  id: string;
  namespace: string;
  content: string;
  source: string;
  source_ref: string | null;
  created_at: number;
  meta_json: string | null;
}

interface CandidateError {
  /** All chunks in this session, in chronological order. */
  session: MemoryRow[];
  /** Index of the error chunk inside `session`. */
  errorIdx: number;
  /** Fingerprint computed from the error chunk. */
  fingerprint: ReturnType<typeof fingerprintError>;
  /** Auto-verified: next 1-2 chunks don't repeat the same fingerprint. */
  autoVerified: boolean;
}

interface RunbookDraft {
  name: string;
  summary: string;
  failingCommand: string;
  errorText: string;
  steps: Array<{ step: string; code?: string }>;
  fixWorked: boolean;
  fingerprintHash: string;
  tool: string | undefined;
  sourceSessionRef: string | null;
}

interface AutoExtractArgs {
  sinceHours: number;
  namespace: string;
  limit: number;
  dryRun: boolean;
  autoSave: boolean;
  targetNs: string;
}

export async function cmdRunbookAutoExtract(args: string[]): Promise<void> {
  const opts = parseArgs(args);
  const cfg = loadConfig();
  const db = openLocalDb(cfg.dbPath);

  console.log('');
  console.log(
    `Scanning ${opts.namespace}* memories from the last ${opts.sinceHours}h...`,
  );

  // 1. Pull recent memories in scope
  const sinceMs = Date.now() - opts.sinceHours * 60 * 60 * 1000;
  const rows = db
    .prepare(
      `SELECT id, namespace, content, source, source_ref, created_at, meta_json
         FROM memories
        WHERE namespace LIKE ?
          AND created_at > ?
        ORDER BY source_ref, created_at
        LIMIT 1000`,
    )
    .all(`${opts.namespace}%`, sinceMs) as MemoryRow[];

  if (rows.length === 0) {
    console.log('');
    console.log(`No memories found in last ${opts.sinceHours}h.`);
    console.log('');
    console.log(`Verify Cowork import is working:`);
    console.log(`  npx tsx src/cli.ts import --claude-cowork --probe`);
    return;
  }
  console.log(`Loaded ${rows.length} memory chunks across ${countDistinct(rows.map((r) => r.source_ref))} session(s).`);

  // 2. Group by source_ref (one session = one source_ref)
  const sessions = new Map<string, MemoryRow[]>();
  for (const r of rows) {
    const k = r.source_ref ?? `(no-ref-${r.id})`;
    const list = sessions.get(k) ?? [];
    list.push(r);
    sessions.set(k, list);
  }

  // 3. Find candidate error→fix patterns
  const candidates: CandidateError[] = [];
  for (const session of sessions.values()) {
    for (let i = 0; i < session.length; i++) {
      const content = session[i].content;
      if (!isErrorShaped(content)) continue;
      const fp = fingerprintError(content);
      // Auto-verify: next 1-2 chunks should NOT repeat the same fingerprint
      const next = session.slice(i + 1, i + 3);
      const stillFailing = next.some(
        (t) => isErrorShaped(t.content) && fingerprintError(t.content).hash === fp.hash,
      );
      candidates.push({ session, errorIdx: i, fingerprint: fp, autoVerified: !stillFailing });
    }
  }
  console.log(`Found ${candidates.length} candidate error→fix pattern(s).`);

  // Dedup candidates against existing runbooks AND against each other
  const existingHashes = new Set(
    (db
      .prepare(`SELECT error_fingerprints FROM procedural_memories WHERE error_fingerprints IS NOT NULL`)
      .all() as Array<{ error_fingerprints: string }>)
      .flatMap((r) => {
        try {
          const v = JSON.parse(r.error_fingerprints);
          return Array.isArray(v) ? (v as string[]) : [];
        } catch {
          return [];
        }
      }),
  );
  const seenInPass = new Set<string>();
  const novel: CandidateError[] = [];
  for (const c of candidates) {
    if (existingHashes.has(c.fingerprint.hash)) continue;
    if (seenInPass.has(c.fingerprint.hash)) continue;
    seenInPass.add(c.fingerprint.hash);
    novel.push(c);
    if (novel.length >= opts.limit) break;
  }
  console.log(`${novel.length} new pattern(s) to extract (existing matches dedupped).`);

  if (novel.length === 0) {
    console.log('');
    console.log('Either you already have runbooks for everything, or no errors were detected.');
    return;
  }

  // 4. LLM-extract each candidate
  console.log('');
  console.log('Extracting drafts via LLM (this can take 30-60s)...');
  const drafts: Array<{ draft: RunbookDraft; candidate: CandidateError }> = [];
  for (let i = 0; i < novel.length; i++) {
    const c = novel[i];
    process.stdout.write(`  [${i + 1}/${novel.length}] ${c.fingerprint.hash}... `);
    try {
      const draft = await extractDraft(c);
      if (draft) {
        drafts.push({ draft, candidate: c });
        process.stdout.write(`✓ "${draft.name}"\n`);
      } else {
        process.stdout.write('skipped (no fix found)\n');
      }
    } catch (e) {
      process.stdout.write(`error: ${(e as Error).message}\n`);
    }
  }

  if (drafts.length === 0) {
    console.log('');
    console.log('LLM extraction returned no usable runbooks. Try again later when more chat history accumulates.');
    return;
  }

  // 5. Review UI (unless --auto-save)
  if (opts.dryRun) {
    console.log('');
    console.log(`Would save ${drafts.length} runbook(s):`);
    for (const { draft } of drafts) {
      console.log(`  • [${draft.tool ?? 'unknown'}] ${draft.name} — ${draft.summary}`);
    }
    return;
  }

  let savedCount = 0;
  let skippedCount = 0;
  if (opts.autoSave) {
    for (const { draft, candidate } of drafts) {
      saveDraft(db, draft, candidate, opts.targetNs);
      savedCount++;
    }
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log('');
      console.log(`Review ${drafts.length} draft runbook(s):`);
      console.log('');
      for (const [i, { draft, candidate }] of drafts.entries()) {
        console.log(`── Draft ${i + 1}/${drafts.length} ─────────────────────────────────`);
        console.log(`  name:        ${draft.name}`);
        console.log(`  summary:     ${draft.summary}`);
        console.log(`  tool:        ${draft.tool ?? '(unknown)'}`);
        console.log(`  fingerprint: ${draft.fingerprintHash}`);
        console.log(`  verified:    ${draft.fixWorked ? 'yes (auto)' : 'no'}`);
        console.log(`  command:     ${draft.failingCommand.slice(0, 80)}`);
        console.log(`  steps (${draft.steps.length}):`);
        for (const [si, s] of draft.steps.entries()) {
          const code = s.code ? `  →  ${s.code.slice(0, 60)}` : '';
          console.log(`     ${si + 1}. ${s.step}${code}`);
        }
        const choice = (await ask(rl, '   [s]ave / [k]ip / [a]ll remaining ? ')).trim().toLowerCase();
        if (choice === 'a') {
          for (const remaining of drafts.slice(i)) {
            saveDraft(db, remaining.draft, remaining.candidate, opts.targetNs);
            savedCount++;
          }
          break;
        } else if (choice === 'k' || choice === 'skip') {
          skippedCount++;
        } else {
          // Default = save
          saveDraft(db, draft, candidate, opts.targetNs);
          savedCount++;
        }
        console.log('');
      }
    } finally {
      rl.close();
    }
  }

  console.log('');
  console.log(`Done — saved ${savedCount}, skipped ${skippedCount} of ${drafts.length}.`);
  if (savedCount > 0) {
    console.log(`Try: mnueron runbook list --ns ${opts.targetNs}`);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseArgs(args: string[]): AutoExtractArgs {
  const out: AutoExtractArgs = {
    sinceHours: 24,
    namespace: 'claude-cowork',
    limit: 10,
    dryRun: false,
    autoSave: false,
    targetNs: 'mnueron',
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--since' && args[i + 1]) out.sinceHours = Math.max(1, Number(args[++i]) || 24);
    else if (a === '--from-ns' && args[i + 1]) out.namespace = args[++i];
    else if (a === '--ns' && args[i + 1]) out.targetNs = args[++i];
    else if (a === '--limit' && args[i + 1]) out.limit = Math.max(1, Number(args[++i]) || 10);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--auto-save') out.autoSave = true;
    else if (a === '--help' || a === '-h') {
      console.log(`mnueron runbook auto-extract — generate runbooks from recent Cowork chats

  --since <hours>      How far back to scan (default 24)
  --from-ns <name>     Source namespace prefix (default 'claude-cowork')
  --ns <name>          Where to save the runbooks (default 'mnueron')
  --limit <n>          Max drafts to extract per pass (default 10)
  --dry-run            List candidates without LLM extraction or save
  --auto-save          Skip review UI; save all extracted drafts
  -h, --help           Show this help`);
      process.exit(0);
    }
  }
  return out;
}

/** Heuristic: does this content look like an error/stderr block? */
function isErrorShaped(content: string): boolean {
  // Skip very short or very long chunks — likely not error pastes
  if (!content || content.length < 30 || content.length > 8000) return false;
  return (
    /\b(error|fatal|failed?|exception|panic|sqlstate)\b[: \t]/i.test(content) ||
    /^\s*[+>]\s*.*\n.*(~~|error|fail)/im.test(content) ||
    /\btraceback\b|\bcannot find\b|\bis not recognized\b|\bnot a valid\b/i.test(content)
  );
}

function countDistinct<T>(arr: Array<T | null | undefined>): number {
  return new Set(arr.filter((x) => x != null)).size;
}

function ask(rl: Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, (a) => resolve(a)));
}

/**
 * Call an LLM (Haiku preferred, gpt-4o-mini fallback) with a focused
 * extraction prompt. Returns null if the LLM judges the candidate too
 * weak to formalize.
 */
async function extractDraft(c: CandidateError): Promise<RunbookDraft | null> {
  // Build LLM context: 1 chunk before error + error + 2 chunks after
  const slice = c.session.slice(Math.max(0, c.errorIdx - 1), c.errorIdx + 3);
  const transcript = slice
    .map((r, i) => {
      const role = r.source === 'cowork-user' || /^user\b/.test(r.source) ? 'USER' : 'ASSISTANT';
      const marker = i === Math.min(c.errorIdx, 1) ? ' (← error chunk)' : '';
      return `### ${role}${marker}\n${redact(r.content).content.slice(0, 1500)}`;
    })
    .join('\n\n');

  const truncated = transcript.length > MAX_EXTRACT_CHARS
    ? transcript.slice(0, MAX_EXTRACT_CHARS) + '\n... [truncated]'
    : transcript;

  const prompt = `You are extracting a "runbook" from a chat transcript between a user and an AI assistant. The user hit an error and the assistant proposed a fix.

Return STRICT JSON only, no prose. If the transcript doesn't actually contain an error+fix pair (or if the fix isn't concrete enough to act on), return {"skip": true}.

Schema:
{
  "name": "short kebab-case name like 'fix-git-index-lock'",
  "summary": "one sentence — what this runbook fixes",
  "failingCommand": "the command the user ran that produced the error",
  "errorText": "the key error message (≤200 chars; copy from the transcript)",
  "steps": [
    {"step": "imperative description", "code": "optional exact command/snippet"}
  ],
  "fixWorked": true | false,
  "tool": "git" | "npm" | "supabase" | "postgres" | "typescript" | "powershell" | "docker" | "kubectl" | "python" | "node" | null
}

Transcript:
${truncated}

Return JSON now:`;

  const json = await callLLM(prompt);
  if (!json) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (parsed.skip === true) return null;
  if (!parsed.name || !parsed.steps || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    return null;
  }

  const steps = parsed.steps
    .filter((s: any) => s && typeof s.step === 'string')
    .map((s: any) => ({
      step: String(s.step).slice(0, 500),
      ...(typeof s.code === 'string' ? { code: s.code.slice(0, 1000) } : {}),
    }))
    .slice(0, 30);

  if (steps.length === 0) return null;

  return {
    name: String(parsed.name).toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 64),
    summary: String(parsed.summary ?? '').slice(0, 300),
    failingCommand: String(parsed.failingCommand ?? '').slice(0, 500),
    errorText: c.fingerprint.redactedOriginal.slice(0, 4000),
    steps,
    // Trust LLM judgment, but if our auto-verify says yes too, bias to yes
    fixWorked: Boolean(parsed.fixWorked) || c.autoVerified,
    fingerprintHash: c.fingerprint.hash,
    tool: parsed.tool ?? c.fingerprint.tool ?? undefined,
    sourceSessionRef: c.session[c.errorIdx].source_ref,
  };
}

/** Save a draft to procedural_memories, dedup by fingerprint. */
function saveDraft(
  db: Database.Database,
  draft: RunbookDraft,
  _candidate: CandidateError,
  targetNs: string,
): void {
  // One last dedup check inside the same pass
  const existing = db
    .prepare(`SELECT id FROM procedural_memories WHERE error_fingerprints LIKE ? LIMIT 1`)
    .get(`%"${draft.fingerprintHash}"%`) as { id: string } | undefined;
  if (existing) return; // someone else won the race; skip silently

  const now = Date.now();
  db.prepare(
    `INSERT INTO procedural_memories
      (id, namespace, name, summary, steps_json, tools_json, last_used_at, use_count, created_at,
       trigger_phrases, error_fingerprints, verified, verified_at, os, tool,
       success_count, failure_count, error_text, failing_command)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?,  ?, ?, ?, ?, ?, ?,  ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    targetNs,
    draft.name,
    draft.summary || `Fix for ${draft.tool ?? 'an unknown'} error`,
    JSON.stringify(draft.steps),
    JSON.stringify(draft.tool ? [draft.tool] : []),
    now,
    now,
    JSON.stringify([]),
    JSON.stringify([draft.fingerprintHash]),
    draft.fixWorked ? 1 : 0,
    draft.fixWorked ? now : null,
    platform(),
    draft.tool ?? null,
    draft.fixWorked ? 1 : 0,
    0,
    draft.errorText,
    draft.failingCommand,
  );
}

/**
 * LLM call with Haiku preferred / OpenAI fallback. Mirrors the pattern
 * in store/procedural.ts:extractProcedural so behavior + key handling
 * stay consistent across the codebase.
 */
async function callLLM(prompt: string): Promise<string | null> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!anthropicKey && !openaiKey) {
    throw new Error(
      'auto-extract requires ANTHROPIC_API_KEY or OPENAI_API_KEY env var (no LLM key configured)',
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    if (anthropicKey) {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 1500,
          temperature: 0,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: controller.signal,
      });
      if (!resp.ok) throw new Error(`anthropic ${resp.status}`);
      const data = (await resp.json()) as { content?: Array<{ text?: string }> };
      const text = data.content?.[0]?.text ?? '';
      return extractJsonBlob(text);
    }
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${openaiKey}` },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        max_tokens: 1500,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`openai ${resp.status}`);
    const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content ?? '';
    return extractJsonBlob(text);
  } finally {
    clearTimeout(timer);
  }
}

/** Pull the first {...} JSON blob out of a possibly chatty LLM response. */
function extractJsonBlob(text: string): string | null {
  const match = text.match(/\{[\s\S]*\}/);
  return match ? match[0] : null;
}
