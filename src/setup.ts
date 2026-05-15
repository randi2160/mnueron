/**
 * The setup wizard. Detects every supported AI dev tool, configures each one
 * to point at this mnueron installation, and reports back.
 *
 * Usage from CLI:
 *   mnueron setup                          → interactive: configure all detected
 *   mnueron setup --yes                    → non-interactive: just do it
 *   mnueron setup --only claude-desktop    → just one tool
 *   mnueron setup --hosted https://api.engrama.dev --token mn_xxx
 *                                          → configure for hosted mode
 *   mnueron setup --uninstall              → remove from all tools
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allDetectors } from './detectors/index.js';
import type { McpServerEntry, ToolDetector } from './detectors/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MNUERON_ENTRY = resolve(HERE, 'index.js');
const SERVER_NAME = "mnueron"; // or 'engrama' when rebranded

export interface SetupOptions {
  only?: string[];           // restrict to these detector ids
  hosted?: { url: string; token: string };
  yes?: boolean;             // skip prompts (we don't actually prompt yet — placeholder)
  uninstall?: boolean;
  dryRun?: boolean;
}

export interface SetupReport {
  tool: string;
  status: 'configured' | 'updated' | 'unchanged' | 'skipped' | 'uninstalled' | 'not-found' | 'error';
  detail: string;
  configPath?: string;
}

export async function runSetup(opts: SetupOptions = {}): Promise<SetupReport[]> {
  const detectors = allDetectors().filter(d =>
    !opts.only || opts.only.includes(d.id)
  );

  if (opts.uninstall) return runUninstall(detectors, opts);

  const entry = buildEntry(opts);
  const reports: SetupReport[] = [];

  for (const d of detectors) {
    const status = d.status();
    if (!status.installed) {
      reports.push({
        tool: d.displayName, status: 'not-found',
        detail: 'tool not detected on this machine',
      });
      continue;
    }

    if (opts.dryRun) {
      reports.push({
        tool: d.displayName, status: 'skipped',
        detail: `would write to ${status.configPath}`,
        configPath: status.configPath ?? undefined,
      });
      continue;
    }

    const result = d.install(SERVER_NAME, entry);
    if (!result.ok) {
      reports.push({ tool: d.displayName, status: 'error', detail: result.message });
    } else if (result.changed) {
      reports.push({
        tool: d.displayName,
        status: status.alreadyConfigured ? 'updated' : 'configured',
        detail: result.message,
        configPath: result.configPath,
      });
    } else {
      reports.push({
        tool: d.displayName, status: 'unchanged',
        detail: 'already up to date',
        configPath: result.configPath,
      });
    }
  }

  return reports;
}

function runUninstall(detectors: ToolDetector[], _opts: SetupOptions): SetupReport[] {
  const reports: SetupReport[] = [];
  for (const d of detectors) {
    const result = d.uninstall(SERVER_NAME);
    if (!result.ok) {
      reports.push({ tool: d.displayName, status: 'error', detail: result.message });
    } else if (result.removed) {
      reports.push({ tool: d.displayName, status: 'uninstalled', detail: result.message });
    } else {
      reports.push({ tool: d.displayName, status: 'not-found', detail: result.message });
    }
  }
  return reports;
}

function buildEntry(opts: SetupOptions): McpServerEntry {
  const entry: McpServerEntry = {
    command: 'node',
    args: [MNUERON_ENTRY],
  };
  if (opts.hosted) {
    entry.env = {
      MNUERON_API_URL: opts.hosted.url,
      MNUERON_API_TOKEN: opts.hosted.token,
    };
  }
  return entry;
}

/** Pretty-print the report for terminal output. */
export function formatReport(reports: SetupReport[]): string {
  const lines: string[] = [];
  const icons: Record<SetupReport['status'], string> = {
    configured:  '✓',
    updated:     '↻',
    unchanged:   '·',
    skipped:     '○',
    uninstalled: '✗',
    'not-found': ' ',
    error:       '!',
  };
  const found = reports.filter(r => r.status !== 'not-found');
  const missing = reports.filter(r => r.status === 'not-found');

  if (found.length > 0) {
    lines.push('Configured:');
    for (const r of found) {
      lines.push(`  ${icons[r.status]} ${r.tool.padEnd(22)} ${r.detail}`);
      if (r.configPath) lines.push(`    ${r.configPath}`);
    }
  }
  if (missing.length > 0) {
    lines.push('');
    lines.push('Not detected:');
    for (const r of missing) lines.push(`    ${r.tool}`);
  }
  return lines.join('\n');
}
