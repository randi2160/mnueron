/**
 * Shared helper for tools that store MCP config as `{ "mcpServers": { ... } }`
 * in a JSON file. Claude Desktop, Cursor, and Claude Code all follow this
 * pattern with different paths.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  ToolDetector, DetectorStatus, McpServerEntry, InstallResult, UninstallResult,
} from './types.js';

export abstract class JsonMcpDetector implements ToolDetector {
  abstract id: string;
  abstract displayName: string;

  /** Where this tool reads its MCP config from. null = tool not present. */
  protected abstract configPath(): string | null;

  /** Optional extra check (e.g. confirm app is actually installed, not just config-present). */
  protected isInstalled(): boolean {
    return this.configPath() !== null;
  }

  status(): DetectorStatus {
    const path = this.configPath();
    const installed = this.isInstalled();
    if (!path || !installed) {
      return {
        id: this.id, displayName: this.displayName,
        installed: false, configPath: null,
        configExists: false, alreadyConfigured: false,
      };
    }
    const configExists = existsSync(path);
    let alreadyConfigured = false;
    if (configExists) {
      try {
        const cfg = JSON.parse(readFileSync(path, 'utf8'));
        alreadyConfigured = !!cfg?.mcpServers?.[this.serverNameInConfig()];
      } catch { /* malformed config */ }
    }
    return {
      id: this.id, displayName: this.displayName,
      installed: true, configPath: path,
      configExists, alreadyConfigured,
    };
  }

  install(serverName: string, entry: McpServerEntry): InstallResult {
    const path = this.configPath();
    if (!path) return { ok: false, changed: false, message: `${this.displayName} not detected` };

    mkdirSync(dirname(path), { recursive: true });

    let cfg: any = { mcpServers: {} };
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, 'utf8');
        cfg = raw.trim() ? JSON.parse(raw) : { mcpServers: {} };
      } catch {
        return {
          ok: false, changed: false,
          message: `${path} is not valid JSON — not touching it. Fix it by hand first.`,
        };
      }
    }
    cfg.mcpServers = cfg.mcpServers ?? {};

    // Don't blow away any other servers the user has configured.
    const before = JSON.stringify(cfg.mcpServers[serverName] ?? null);
    cfg.mcpServers[serverName] = entry;
    const after = JSON.stringify(cfg.mcpServers[serverName]);
    const changed = before !== after;

    writeFileSync(path, JSON.stringify(cfg, null, 2));
    this.lastServerName = serverName;
    return {
      ok: true, changed,
      configPath: path,
      message: changed
        ? (before === 'null' ? 'added' : 'updated existing entry')
        : 'already up to date',
    };
  }

  uninstall(serverName: string): UninstallResult {
    const path = this.configPath();
    if (!path || !existsSync(path)) {
      return { ok: true, removed: false, message: 'nothing to remove' };
    }
    try {
      const cfg = JSON.parse(readFileSync(path, 'utf8'));
      if (cfg?.mcpServers?.[serverName]) {
        delete cfg.mcpServers[serverName];
        writeFileSync(path, JSON.stringify(cfg, null, 2));
        return { ok: true, removed: true, message: 'removed' };
      }
      return { ok: true, removed: false, message: 'not registered' };
    } catch (e: any) {
      return { ok: false, removed: false, message: `failed: ${e?.message}` };
    }
  }

  private lastServerName: string | undefined;
  private serverNameInConfig(): string {
    return this.lastServerName ?? 'engrama';
  }
}
