/**
 * v0.2.5 — Claude Desktop local import.
 *
 * Claude Desktop is an Electron app. Its on-disk format is undocumented
 * and has changed across versions (Local Storage / IndexedDB / SQLite
 * variants depending on Electron + Anthropic's app shape). Cracking the
 * live cache is fragile.
 *
 * Stable path that works on every version: Claude's built-in
 * Settings → Privacy → Export data feature outputs a JSON file with all
 * conversations. This module:
 *
 *   1. PROBE mode: locate the Claude Desktop folder and list what's
 *      there. Useful for the user to discover where their data lives
 *      and for us to add format-specific parsers as we see real data.
 *
 *   2. IMPORT mode: ingest a JSON export file (the one from
 *      Settings → Privacy → Export). Same `importClaudeExport()` path
 *      as the regular CLI's `mnueron import --claude`.
 *
 *   3. AUTO mode: try to find a recently-downloaded Claude export under
 *      ~/Downloads, ~/Desktop, or the Claude config folder itself. If
 *      one is found, import it. Otherwise, fall through to PROBE and
 *      print instructions for getting one.
 *
 * Why not crack the cache: Electron's leveldb data is unstable across
 * minor versions, varies by platform, and Anthropic changes shape
 * without notice. The JSON export is a documented API surface and
 * survives version bumps.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

import { importClaudeExport } from './claude.js';
import type { SaveMemoryInput } from '../store/provider.js';
import type { Provider } from '../store/provider.js';

export interface ProbeResult {
  found: boolean;
  path: string | null;
  pathsAttempted: string[];
  contents: Array<{ name: string; type: 'file' | 'dir'; size?: number }>;
  hints: string[];
  exportCandidates: string[];
}

/**
 * Walk all the standard Claude Desktop folder locations and return what's
 * there + heuristic hints. Doesn't read or modify anything — read-only
 * inspection.
 */
export function probeClaudeDesktop(): ProbeResult {
  const attempted = standardPaths();
  const found = attempted.find((p) => existsSync(p)) ?? null;

  const out: ProbeResult = {
    found: !!found,
    path: found,
    pathsAttempted: attempted,
    contents: [],
    hints: [],
    exportCandidates: [],
  };

  if (!found) {
    out.hints.push(
      'Claude Desktop folder not found at any standard location.',
      'Install Claude Desktop from https://claude.ai/download first.',
      'If you have it installed under a non-default path, point us at it:',
      '  mnueron import --claude-desktop --dir <path>',
    );
    return out;
  }

  // Top-level listing
  for (const name of readdirSync(found)) {
    try {
      const p = join(found, name);
      const stat = statSync(p);
      out.contents.push({
        name,
        type: stat.isDirectory() ? 'dir' : 'file',
        size: stat.isFile() ? stat.size : undefined,
      });
    } catch {
      /* permission denied or symlink loop — skip */
    }
  }

  // Heuristic hints based on what's there
  const has = (n: string) => out.contents.some((c) => c.name === n);
  if (has('Local Storage'))    out.hints.push('• Local Storage/ — Electron localStorage (leveldb)');
  if (has('IndexedDB'))        out.hints.push('• IndexedDB/ — conversations likely stored here in newer builds');
  if (has('Preferences'))      out.hints.push('• Preferences — app config JSON (settings only, no chats)');
  if (has('Session Storage'))  out.hints.push('• Session Storage/ — short-lived per-session data');
  if (has('Cache') || has('Code Cache')) {
    out.hints.push('• Cache/ Code Cache/ — HTTP + V8 caches (skip; no chat data)');
  }

  // Probe for an export JSON file in the Claude folder itself
  out.exportCandidates.push(...findExportCandidates(found));

  // Also check Downloads + Desktop, since that's where the export
  // dialog usually drops the file.
  const home = homedir();
  for (const folder of [join(home, 'Downloads'), join(home, 'Desktop')]) {
    if (existsSync(folder)) {
      out.exportCandidates.push(...findExportCandidates(folder));
    }
  }

  if (out.exportCandidates.length > 0) {
    out.hints.push(
      `Found ${out.exportCandidates.length} candidate export file(s) — see exportCandidates below.`,
    );
  } else {
    out.hints.push(
      'No Claude export JSON found yet. To create one:',
      '  1. Open Claude Desktop',
      '  2. Settings → Privacy → Export data',
      '  3. Save the resulting JSON to your Downloads folder',
      '  4. Re-run: mnueron import --claude-desktop',
    );
  }

  return out;
}

/**
 * Heuristic: a Claude export file is a `.json` that contains either
 * `"chat_messages"` or `"conversations"` near the top + was modified in
 * the last 90 days. We don't fully parse here — just enough to flag.
 */
function findExportCandidates(dir: string): string[] {
  const hits: string[] = [];
  try {
    const ninetyDaysAgo = Date.now() - 90 * 24 * 3600 * 1000;
    for (const name of readdirSync(dir)) {
      if (!name.toLowerCase().endsWith('.json')) continue;
      const p = join(dir, name);
      try {
        const stat = statSync(p);
        if (!stat.isFile() || stat.size < 200 || stat.mtimeMs < ninetyDaysAgo) continue;
        // Sniff: read the first 8 KB and look for tell-tale keys. Avoids
        // parsing massive files just to reject them.
        const fd = readFileSync(p, { encoding: 'utf8', flag: 'r' }).slice(0, 8192);
        if (fd.includes('"chat_messages"') ||
            fd.includes('"conversations"') ||
            (fd.includes('"sender"') && fd.includes('"human"'))) {
          hits.push(p);
        }
      } catch { /* unreadable — skip */ }
    }
  } catch { /* dir not readable */ }
  return hits;
}

/**
 * Import a Claude Desktop export JSON file. Delegates to the existing
 * importClaudeExport() — same format as `mnueron import --claude` for
 * web exports.
 */
export async function importFromExportFile(
  filePath: string,
  namespace: string,
): Promise<SaveMemoryInput[]> {
  if (!existsSync(filePath)) {
    throw new Error(`export file not found: ${filePath}`);
  }
  return importClaudeExport(filePath, namespace);
}

/**
 * Auto-find a recent export JSON and import it. Returns the import
 * result + the resolved path. If nothing's found, throws so the caller
 * can fall back to probe + manual guidance.
 */
export async function autoImport(provider: Provider, namespace: string): Promise<{
  path: string;
  saved: number;
  errors: number;
}> {
  const probe = probeClaudeDesktop();
  if (probe.exportCandidates.length === 0) {
    throw new Error(
      'No Claude Desktop export JSON found. ' +
      'Open Claude Desktop → Settings → Privacy → Export data, ' +
      'save the JSON, then re-run this command.',
    );
  }
  // Pick the newest by mtime
  const newest = probe.exportCandidates
    .map((p) => ({ p, m: statSync(p).mtimeMs }))
    .sort((a, b) => b.m - a.m)[0].p;
  const items = await importFromExportFile(newest, namespace);
  const result = await provider.bulkSave(items);
  return { path: newest, ...result };
}

/**
 * Default-location paths for Claude Desktop's user data folder per OS.
 * The first one that exists wins. If your install is non-standard,
 * pass `--dir <path>` to the CLI subcommand.
 */
function standardPaths(): string[] {
  const home = homedir();
  switch (platform()) {
    case 'darwin':
      return [
        join(home, 'Library', 'Application Support', 'Claude'),
        join(home, 'Library', 'Application Support', 'AnthropicClaude'),
      ];
    case 'win32': {
      const appdata = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
      const localApp = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
      return [
        join(appdata, 'Claude'),
        join(appdata, 'AnthropicClaude'),
        join(localApp, 'Claude'),
        join(localApp, 'AnthropicClaude'),
      ];
    }
    case 'linux':
      return [
        join(home, '.config', 'Claude'),
        join(home, '.config', 'AnthropicClaude'),
      ];
    default:
      return [];
  }
}
