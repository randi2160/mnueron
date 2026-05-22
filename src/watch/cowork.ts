/**
 * v0.2.6 — Cowork background sync.
 *
 * Periodically probes the on-disk Cowork transcripts and incrementally
 * imports new or changed ones into mnueron. Drives `mnueron watch
 * --claude-cowork`.
 *
 * State file at `~/.mnueron/cowork-sync.json` records the last-synced
 * mtimeMs per sessionId. On each tick we re-import only sessions whose
 * file mtime has advanced. Idempotent: re-importing a session upserts via
 * `source_ref="cowork:<sessionId>"` so duplicates never accumulate.
 *
 * Stop with Ctrl+C — SIGINT/SIGTERM are caught and we flush the state
 * file before exiting.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { Provider, SaveMemoryInput } from '../store/provider.js';
import { probeClaudeCowork, importFromCoworkSession } from '../import/claude_cowork.js';

const STATE_VERSION = 1;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

interface SyncState {
  version: number;
  last_run_ms: number;
  // sessionId → file.mtimeMs at last successful import
  sessions: Record<string, number>;
}

function stateFilePath(): string {
  return join(homedir(), '.mnueron', 'cowork-sync.json');
}

function loadState(): SyncState {
  const p = stateFilePath();
  try {
    const raw = readFileSync(p, 'utf8');
    const obj = JSON.parse(raw);
    if (obj?.version === STATE_VERSION && obj.sessions && typeof obj.sessions === 'object') {
      return obj;
    }
  } catch { /* missing or malformed — start fresh */ }
  return { version: STATE_VERSION, last_run_ms: 0, sessions: {} };
}

function saveState(s: SyncState): void {
  const p = stateFilePath();
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(s, null, 2), 'utf8');
  } catch (e) {
    process.stderr.write(`[mnueron watch] failed to write sync state: ${(e as Error).message}\n`);
  }
}

export interface CoworkWatchOptions {
  intervalMs?: number;
  namespace?: string;
  once?: boolean;
  /** Called after each tick with a one-line summary string. Defaults to console.log. */
  log?: (msg: string) => void;
}

/**
 * Run one tick of the sync: probe disk, compare against state, import any
 * changed sessions. Returns counts so callers can log / surface in UIs.
 */
export async function runCoworkSyncTick(
  provider: Provider,
  state: SyncState,
  namespace: string,
): Promise<{ checked: number; changed: number; imported: number; saved: number; errors: number }> {
  const probe = probeClaudeCowork();
  const out = { checked: probe.sessions.length, changed: 0, imported: 0, saved: 0, errors: 0 };
  if (probe.sessions.length === 0) return out;

  const items: SaveMemoryInput[] = [];
  const pendingMtimes: Array<[string, number]> = [];

  for (const s of probe.sessions) {
    const prevMtime = state.sessions[s.sessionId] ?? 0;
    if (s.mtimeMs <= prevMtime) continue; // unchanged, skip
    out.changed++;
    try {
      const sessionItems = importFromCoworkSession(s.filePath, namespace, {
        sessionId: s.sessionId,
        title: s.title,
        cwd: s.cwd,
      });
      if (sessionItems.length > 0) {
        items.push(...sessionItems);
        out.imported++;
      }
      pendingMtimes.push([s.sessionId, s.mtimeMs]);
    } catch {
      out.errors++;
    }
  }

  if (items.length > 0) {
    const result = await provider.bulkSave(items);
    out.saved = result.saved;
    out.errors += result.errors;
  }

  // Stamp success mtimes only after the save succeeds.
  for (const [id, mtime] of pendingMtimes) state.sessions[id] = mtime;
  state.last_run_ms = Date.now();
  saveState(state);

  return out;
}

/**
 * Long-running watcher. Resolves only on signal (--once mode) or never
 * (continuous mode). Caller is responsible for provider lifecycle.
 */
export async function runCoworkWatch(
  provider: Provider,
  opts: CoworkWatchOptions = {},
): Promise<void> {
  const intervalMs = Math.max(10_000, opts.intervalMs ?? DEFAULT_INTERVAL_MS);
  const namespace = opts.namespace ?? 'claude-cowork';
  const log = opts.log ?? ((m: string) => console.log(m));

  let state = loadState();
  let stopping = false;

  const onSignal = (sig: string) => {
    if (stopping) return;
    stopping = true;
    log(`[watch] caught ${sig}, flushing state and exiting…`);
    saveState(state);
    // Give any in-flight tick a tiny window to wrap up cleanly.
    setTimeout(() => process.exit(0), 250).unref();
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  log(
    `[watch] cowork sync started — interval ${(intervalMs / 1000).toFixed(0)}s, ` +
    `ns "${namespace}", state @ ${stateFilePath()}`,
  );

  const tick = async () => {
    if (stopping) return;
    const startedAt = new Date().toISOString();
    try {
      const result = await runCoworkSyncTick(provider, state, namespace);
      log(
        `[watch ${startedAt}] checked=${result.checked} changed=${result.changed} ` +
        `imported=${result.imported} saved=${result.saved} errors=${result.errors}`,
      );
    } catch (e) {
      log(`[watch ${startedAt}] tick failed: ${(e as Error).message}`);
    }
  };

  // Run an initial tick immediately so a fresh `mnueron watch` is useful
  // without waiting for the first interval.
  await tick();

  if (opts.once) return;

  // Schedule subsequent ticks. The active setInterval keeps the event loop
  // alive; we exit via the SIGINT/SIGTERM handler.
  setInterval(() => { void tick(); }, intervalMs);
  await new Promise<void>(() => { /* never resolves; SIGINT calls process.exit */ });
}
