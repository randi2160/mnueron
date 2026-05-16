import {
  existsSync, readFileSync, writeFileSync, mkdirSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  ToolDetector, DetectorStatus, McpServerEntry, InstallResult, UninstallResult,
} from './types.js';

/**
 * Zed (zed.dev) — Rust-based collaborative editor. MCP servers are
 * declared under the `context_servers` key in Zed's settings.json (NOT
 * the standard `mcpServers` key our other detectors use), so we can't
 * inherit JsonMcpDetector — we need a custom install/uninstall path.
 *
 * Locations:
 *   macOS:   ~/.config/zed/settings.json (preferred) OR
 *            ~/Library/Application Support/Zed/settings.json
 *   Windows: %APPDATA%\Zed\settings.json
 *   Linux:   ~/.config/zed/settings.json
 *
 * Zed reads settings.json with comments + trailing commas (JSONC). We
 * use plain JSON.parse, which works for any human-edited file that
 * doesn't actively have comments. If parsing fails we leave the file
 * alone and surface a message — safer than corrupting a config.
 */
export class ZedDetector implements ToolDetector {
  id = 'zed';
  displayName = 'Zed';

  private lastServerName: string | undefined;

  private settingsPath(): string {
    const home = homedir();
    switch (platform()) {
      case 'win32': {
        const appdata = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
        return join(appdata, 'Zed', 'settings.json');
      }
      default:
        return join(home, '.config', 'zed', 'settings.json');
    }
  }

  private isInstalled(): boolean {
    const home = homedir();
    if (existsSync(this.settingsPath())) return true;
    switch (platform()) {
      case 'darwin':
        return (
          existsSync(join(home, 'Library', 'Application Support', 'Zed')) ||
          existsSync(join(home, '.config', 'zed'))
        );
      case 'win32': {
        const appdata = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
        return existsSync(join(appdata, 'Zed'));
      }
      case 'linux':
        return existsSync(join(home, '.config', 'zed'));
      default:
        return false;
    }
  }

  status(): DetectorStatus {
    const path = this.settingsPath();
    const installed = this.isInstalled();
    if (!installed) {
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
        alreadyConfigured = !!cfg?.context_servers?.[this.lastServerName ?? 'mnueron'];
      } catch { /* malformed or JSONC — leave alone */ }
    }
    return {
      id: this.id, displayName: this.displayName,
      installed: true, configPath: path,
      configExists, alreadyConfigured,
    };
  }

  install(serverName: string, entry: McpServerEntry): InstallResult {
    const path = this.settingsPath();
    if (!this.isInstalled()) {
      return { ok: false, changed: false, message: `${this.displayName} not detected` };
    }
    mkdirSync(dirname(path), { recursive: true });

    let cfg: Record<string, unknown> = {};
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, 'utf8');
        cfg = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        return {
          ok: false, changed: false,
          message:
            `${path} contains JSONC / comments / trailing commas — we can't parse it. ` +
            `Add the following to context_servers manually: { ${serverName}: ${JSON.stringify(entry)} }`,
        };
      }
    }
    const cs = (cfg.context_servers as Record<string, unknown> | undefined) ?? {};
    const before = JSON.stringify(cs[serverName] ?? null);
    cs[serverName] = entry as unknown as Record<string, unknown>;
    cfg.context_servers = cs;
    const after = JSON.stringify(cs[serverName]);
    const changed = before !== after;

    writeFileSync(path, JSON.stringify(cfg, null, 2));
    this.lastServerName = serverName;
    return {
      ok: true, changed, configPath: path,
      message: changed
        ? (before === 'null' ? 'added' : 'updated existing entry')
        : 'already up to date',
    };
  }

  uninstall(serverName: string): UninstallResult {
    const path = this.settingsPath();
    if (!existsSync(path)) {
      return { ok: true, removed: false, message: 'nothing to remove' };
    }
    try {
      const cfg = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      const cs = (cfg.context_servers as Record<string, unknown> | undefined) ?? {};
      if (cs[serverName]) {
        delete cs[serverName];
        cfg.context_servers = cs;
        writeFileSync(path, JSON.stringify(cfg, null, 2));
        return { ok: true, removed: true, message: 'removed' };
      }
      return { ok: true, removed: false, message: 'not registered' };
    } catch (e) {
      return {
        ok: false, removed: false,
        message: `failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }
}
