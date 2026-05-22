/**
 * v0.2.6 — Claude Cowork local import.
 *
 * Cowork ("local agent mode") is the desktop variant of Claude that the
 * non-developer "Cowork" mode runs on. Under the hood it's the Claude Code
 * runtime, which writes one JSONL transcript per session into a folder
 * whose name encodes the session's cwd.
 *
 * On disk these transcripts live under one of several roots depending on
 * how the Claude desktop app was installed and the OS:
 *
 *   - ~/.claude/projects/<encoded-cwd>/<sessionUuid>.jsonl
 *       (regular Claude Code or non-Store Claude Desktop installs)
 *
 *   - %LOCALAPPDATA%\Packages\Claude_<sfx>\LocalCache\Roaming\Claude\
 *       local-agent-mode-sessions\**\.claude\projects\
 *       <encoded-cwd>\<sessionUuid>.jsonl
 *       OR more directly
 *       %LOCALAPPDATA%\Packages\Claude_<sfx>\LocalCache\Roaming\Claude\
 *       local-agent-mode-sessions\**\<sessionUuid>.jsonl
 *       (Microsoft Store install — Store sandboxes %APPDATA% writes into
 *        the package folder)
 *
 * To stay robust to wherever Cowork actually writes, we recursively walk
 * a list of candidate roots looking for *.jsonl files. Each file is then
 * sniffed: it counts as a Cowork transcript when the cwd recorded in the
 * file contains `local-agent-mode-sessions`.
 *
 * Each session becomes ONE memory containing the flattened transcript.
 * The mnueron chunker (LocalProvider.save/bulkSave) automatically splits
 * long transcripts per-turn for granular recall.
 *
 * Triggered from the CLI:  `mnueron import --claude-cowork`
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

import type { Provider, SaveMemoryInput } from '../store/provider.js';

const MAX_TRANSCRIPT_CHARS = 10_000_000; // chunker splits per-turn; cap just prevents runaway
const MAX_WALK_DEPTH = 10;            // safety cap on recursion
const COWORK_MARKER = 'local-agent-mode-sessions';

export interface CoworkSession {
  sessionId: string;
  filePath: string;
  cwd: string;
  title?: string;
  messageCount: number;
  mtimeMs: number;
  sizeBytes: number;
}

export interface CoworkProbeResult {
  found: boolean;
  /** Primary directory where Cowork transcripts were located, if any. */
  projectsDir: string | null;
  /** Every root we scanned in this probe (existed and was readable). */
  scannedRoots: string[];
  /** All roots considered, even ones that didn't exist. */
  pathsAttempted: string[];
  sessions: CoworkSession[];
  hints: string[];
}

/**
 * Roots to walk on this platform.
 *
 * Order matters only for the `projectsDir` "primary" hint. We still walk
 * every existing root and merge the sessions found.
 */
function candidateRoots(): string[] {
  const home = homedir();
  const roots: string[] = [];

  // Universal: ~/.claude/projects/
  roots.push(join(home, '.claude', 'projects'));

  switch (platform()) {
    case 'win32': {
      const appdata = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
      const localApp = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');

      // Non-Store install location for the cowork agent root.
      roots.push(join(appdata, 'Claude', 'local-agent-mode-sessions'));
      roots.push(join(appdata, 'AnthropicClaude', 'local-agent-mode-sessions'));

      // Microsoft Store sandboxed location. The package suffix isn't stable,
      // so we glob the Packages directory for any Claude*\LocalCache\Roaming
      // \Claude\local-agent-mode-sessions folder.
      const packagesDir = join(localApp, 'Packages');
      if (existsSync(packagesDir)) {
        try {
          for (const name of readdirSync(packagesDir)) {
            if (!name.toLowerCase().startsWith('claude') &&
                !name.toLowerCase().startsWith('anthropic')) {
              continue;
            }
            roots.push(
              join(
                packagesDir,
                name,
                'LocalCache',
                'Roaming',
                'Claude',
                'local-agent-mode-sessions',
              ),
            );
          }
        } catch {
          /* ignore unreadable Packages dir */
        }
      }
      break;
    }
    case 'darwin':
      // ~/Library/Application Support/Claude/local-agent-mode-sessions/
      roots.push(
        join(home, 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions'),
        join(home, 'Library', 'Application Support', 'AnthropicClaude', 'local-agent-mode-sessions'),
      );
      break;
    case 'linux':
      roots.push(
        join(home, '.config', 'Claude', 'local-agent-mode-sessions'),
        join(home, '.config', 'AnthropicClaude', 'local-agent-mode-sessions'),
      );
      break;
  }

  return roots;
}

/**
 * Locate every Cowork session transcript reachable from this machine.
 * Read-only — does not import anything.
 */
export function probeClaudeCowork(): CoworkProbeResult {
  const attempted = candidateRoots();
  const scanned: string[] = [];
  const sessions: CoworkSession[] = [];

  for (const root of attempted) {
    if (!existsSync(root)) continue;
    scanned.push(root);
    walkForJsonl(root, 0, (filePath) => {
      try {
        const fileStat = statSync(filePath);
        if (!fileStat.isFile() || fileStat.size < 50) return;
        const info = quickScan(filePath);
        // Only keep files that look like cowork transcripts (cwd marker).
        if (info.messageCount === 0) return;
        if (!info.cwd.includes(COWORK_MARKER)) return;
        const base = filePath.split(/[\\/]/).pop() ?? '';
        sessions.push({
          sessionId: base.replace(/\.jsonl$/, ''),
          filePath,
          cwd: info.cwd,
          title: info.title,
          messageCount: info.messageCount,
          mtimeMs: fileStat.mtimeMs,
          sizeBytes: fileStat.size,
        });
      } catch {
        /* unreadable — skip */
      }
    });
  }

  // Dedup by sessionId — the same transcript can show up under multiple roots
  // (e.g., a symlinked or sandboxed copy).
  const dedup = new Map<string, CoworkSession>();
  for (const s of sessions) {
    const prev = dedup.get(s.sessionId);
    if (!prev || s.mtimeMs > prev.mtimeMs) dedup.set(s.sessionId, s);
  }
  const final = [...dedup.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);

  const out: CoworkProbeResult = {
    found: final.length > 0,
    projectsDir: scanned[0] ?? null,
    scannedRoots: scanned,
    pathsAttempted: attempted,
    sessions: final,
    hints: [],
  };

  if (final.length > 0) {
    out.hints.push(`Found ${final.length} Cowork session(s) across ${scanned.length} root(s).`);
  } else if (scanned.length === 0) {
    out.hints.push(
      'None of the candidate Cowork roots existed on this machine.',
      'On Windows the Microsoft Store install lives under',
      '%LOCALAPPDATA%\\Packages\\Claude_<sfx>\\LocalCache\\Roaming\\Claude\\local-agent-mode-sessions\\.',
      'If you have a non-default install location, point us at it:',
      '  mnueron import --claude-cowork --dir <path>',
    );
  } else {
    out.hints.push(
      `Walked ${scanned.length} root(s) but found no Cowork session transcripts.`,
      'A .jsonl file qualifies as Cowork when the cwd it records contains',
      `"${COWORK_MARKER}". Run a Cowork chat once and re-try.`,
    );
  }
  return out;
}

/**
 * Recursively walk `dir` up to MAX_WALK_DEPTH levels and call `onFile` for
 * each `.jsonl` we find. Doesn't follow symlinks, swallows perm errors.
 */
function walkForJsonl(
  dir: string,
  depth: number,
  onFile: (filePath: string) => void,
): void {
  if (depth > MAX_WALK_DEPTH) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkForJsonl(p, depth + 1, onFile);
    } else if (st.isFile() && name.endsWith('.jsonl')) {
      onFile(p);
    }
  }
}

interface QuickScan {
  title?: string;
  cwd: string;
  messageCount: number;
}

/**
 * Pass over a transcript counting human-readable turns and grabbing the
 * latest ai-title + cwd. Skips internal-state records.
 */
function quickScan(filePath: string): QuickScan {
  const raw = readFileSync(filePath, 'utf8');
  let title: string | undefined;
  let cwd = '';
  let messageCount = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type === 'user' || obj.type === 'assistant') {
      messageCount++;
      if (!cwd && typeof obj.cwd === 'string') cwd = obj.cwd;
    } else if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string') {
      title = obj.aiTitle;
    }
  }
  return { title, cwd, messageCount };
}

/**
 * Convert one Cowork transcript file into a SaveMemoryInput. Returns an
 * empty array if there are no human-readable turns.
 */
export function importFromCoworkSession(
  filePath: string,
  namespace: string,
  sessionMeta: { sessionId: string; title?: string; cwd: string },
): SaveMemoryInput[] {
  const raw = readFileSync(filePath, 'utf8');
  const turns: Array<{ role: 'user' | 'assistant'; text: string; ts?: string }> = [];

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type === 'user') {
      const text = extractUserText(obj.message);
      if (text) turns.push({ role: 'user', text, ts: obj.timestamp });
    } else if (obj.type === 'assistant') {
      const text = extractAssistantText(obj.message);
      if (text) turns.push({ role: 'assistant', text, ts: obj.timestamp });
    }
  }

  if (turns.length === 0) return [];

  const parts: string[] = [];
  const titleLine = sessionMeta.title
    ? `# ${sessionMeta.title}`
    : `# Cowork session ${sessionMeta.sessionId}`;
  parts.push(titleLine);
  if (turns[0]?.ts) parts.push(`(${turns[0].ts})`);
  parts.push('');
  for (const t of turns) {
    parts.push(`**${t.role === 'assistant' ? 'Claude' : 'User'}:** ${t.text}`);
    parts.push('');
  }
  let content = parts.join('\n').trim();
  if (content.length > MAX_TRANSCRIPT_CHARS) {
    content = content.slice(0, MAX_TRANSCRIPT_CHARS) +
      `\n\n[truncated — original ${content.length} chars]`;
  }

  return [{
    content,
    namespace,
    source: 'claude-cowork',
    source_ref: `cowork:${sessionMeta.sessionId}`,
    tags: ['imported', 'claude-cowork'],
    metadata: {
      title: sessionMeta.title ?? null,
      session_id: sessionMeta.sessionId,
      cwd: sessionMeta.cwd,
      message_count: turns.length,
      first_timestamp: turns[0]?.ts ?? null,
      last_timestamp: turns[turns.length - 1]?.ts ?? null,
    },
  }];
}

function extractUserText(message: any): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content.trim();
  if (Array.isArray(message.content)) {
    return message.content
      .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text as string)
      .join('\n')
      .trim();
  }
  return '';
}

function extractAssistantText(message: any): string {
  if (!message || !Array.isArray(message.content)) return '';
  // Skip thinking blocks (internal reasoning) and tool_use blocks (mostly noise
  // in memory). Keep only `text` blocks — these are what the human actually saw.
  return message.content
    .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text as string)
    .join('\n')
    .trim();
}

/**
 * Probe + import every Cowork session into mnueron. Idempotent via
 * `source_ref` dedup — re-running just re-upserts.
 */
export async function autoImport(
  provider: Provider,
  namespace: string,
  opts: { dryRun?: boolean; limit?: number } = {},
): Promise<{
  totalSessions: number;
  parsed: number;
  empty: number;
  saved: number;
  errors: number;
  sessions: Array<{ sessionId: string; title?: string; messageCount: number }>;
}> {
  const probe = probeClaudeCowork();
  if (!probe.found || probe.sessions.length === 0) {
    throw new Error(
      'No Cowork sessions found. ' +
      'Run Cowork at least once first, then try again.',
    );
  }

  const sessions = opts.limit && opts.limit > 0
    ? probe.sessions.slice(0, opts.limit)
    : probe.sessions;

  let parsed = 0;
  let empty = 0;
  let errors = 0;
  let saved = 0;
  const items: SaveMemoryInput[] = [];

  for (const s of sessions) {
    try {
      const sessionItems = importFromCoworkSession(s.filePath, namespace, {
        sessionId: s.sessionId,
        title: s.title,
        cwd: s.cwd,
      });
      if (sessionItems.length === 0) {
        empty++;
        continue;
      }
      items.push(...sessionItems);
      parsed++;
    } catch {
      errors++;
    }
  }

  if (!opts.dryRun && items.length > 0) {
    const result = await provider.bulkSave(items);
    saved = result.saved;
    errors += result.errors;
  }

  return {
    totalSessions: probe.sessions.length,
    parsed,
    empty,
    saved,
    errors,
    sessions: sessions.map((s) => ({
      sessionId: s.sessionId,
      title: s.title,
      messageCount: s.messageCount,
    })),
  };
}
