import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  ToolDetector, DetectorStatus, McpServerEntry, InstallResult, UninstallResult,
} from './types.js';

/**
 * Codex stores MCP servers in ~/.codex/config.toml:
 *
 *   [mcp_servers.<name>]
 *   command = "..."
 *   args = [...]
 *
 *   [mcp_servers.<name>.env]
 *   KEY = "value"
 *
 * This detector edits only the mnueron block and leaves the rest of the TOML
 * untouched. It intentionally avoids a full TOML parser dependency.
 */
export class CodexDetector implements ToolDetector {
  id = 'codex';
  displayName = 'Codex';

  private configPath(): string {
    return join(homedir(), '.codex', 'config.toml');
  }

  status(): DetectorStatus {
    const path = this.configPath();
    const dir = dirname(path);
    const installed = existsSync(dir) || existsSync(path);
    const configExists = existsSync(path);
    let alreadyConfigured = false;

    if (configExists) {
      try {
        const raw = readFileSync(path, 'utf8');
        alreadyConfigured = hasServerBlock(raw, 'mnueron');
      } catch {
        alreadyConfigured = false;
      }
    }

    return {
      id: this.id,
      displayName: this.displayName,
      installed,
      configPath: path,
      configExists,
      alreadyConfigured,
      note: 'writes ~/.codex/config.toml',
    };
  }

  install(serverName: string, entry: McpServerEntry): InstallResult {
    const path = this.configPath();
    mkdirSync(dirname(path), { recursive: true });

    let raw = '';
    if (existsSync(path)) {
      try {
        raw = readFileSync(path, 'utf8');
      } catch (e: any) {
        return { ok: false, changed: false, message: `failed to read ${path}: ${e?.message ?? e}` };
      }
    }

    const before = raw;
    const withoutOld = removeServerBlock(raw, serverName).trimEnd();
    const next = `${withoutOld}${withoutOld ? '\n\n' : ''}${formatServerBlock(serverName, entry)}\n`;
    const changed = before !== next;

    writeFileSync(path, next);
    return {
      ok: true,
      changed,
      configPath: path,
      message: changed
        ? (hasServerBlock(before, serverName) ? 'updated existing entry' : 'added')
        : 'already up to date',
    };
  }

  uninstall(serverName: string): UninstallResult {
    const path = this.configPath();
    if (!existsSync(path)) return { ok: true, removed: false, message: 'nothing to remove' };

    try {
      const raw = readFileSync(path, 'utf8');
      const next = removeServerBlock(raw, serverName).trimEnd() + '\n';
      const removed = raw !== next;
      if (removed) writeFileSync(path, next);
      return { ok: true, removed, message: removed ? 'removed' : 'not registered' };
    } catch (e: any) {
      return { ok: false, removed: false, message: `failed: ${e?.message ?? e}` };
    }
  }
}

function hasServerBlock(raw: string, serverName: string): boolean {
  return new RegExp(`^\\[mcp_servers\\.${escapeRegExp(serverName)}\\]`, 'm').test(raw);
}

function removeServerBlock(raw: string, serverName: string): string {
  const lines = raw.split(/\r?\n/);
  const out: string[] = [];
  let skipping = false;

  for (const line of lines) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      const section = header[1].trim();
      if (section === `mcp_servers.${serverName}` || section === `mcp_servers.${serverName}.env`) {
        skipping = true;
        continue;
      }
      skipping = false;
    }
    if (!skipping) out.push(line);
  }

  return out.join('\n');
}

function formatServerBlock(serverName: string, entry: McpServerEntry): string {
  const lines: string[] = [];
  lines.push(`[mcp_servers.${serverName}]`);
  lines.push(`command = ${tomlString(entry.command)}`);
  lines.push(`args = [${entry.args.map(tomlString).join(', ')}]`);
  lines.push('startup_timeout_sec = 120');

  if (entry.env && Object.keys(entry.env).length > 0) {
    lines.push('');
    lines.push(`[mcp_servers.${serverName}.env]`);
    for (const [key, value] of Object.entries(entry.env)) {
      lines.push(`${key} = ${tomlString(value)}`);
    }
  }

  return lines.join('\n');
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
