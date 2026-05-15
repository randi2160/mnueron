import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { JsonMcpDetector } from './json_detector.js';
import type { DetectorStatus, McpServerEntry, InstallResult } from './types.js';

/**
 * Claude Code stores MCP server registrations in its user-scoped settings.
 * The "official" way to register is via `claude mcp add`, but that command
 * isn't always available (older versions, custom installs). We try the CLI
 * first and fall back to direct JSON editing.
 */
export class ClaudeCodeDetector extends JsonMcpDetector {
  id = 'claude-code';
  displayName = 'Claude Code';

  protected configPath(): string | null {
    const home = homedir();
    switch (platform()) {
      case 'darwin':
      case 'linux':
        return join(home, '.claude', 'settings.json');
      case 'win32':
        return join(home, '.claude', 'settings.json');
      default:
        return null;
    }
  }

  protected isInstalled(): boolean {
    // `.claude` directory exists OR the `claude` CLI is on PATH
    const path = this.configPath();
    if (path && existsSync(path.replace(/[\/\\]settings\.json$/, ''))) return true;
    try {
      execSync('claude --version', { stdio: 'ignore', timeout: 2000 });
      return true;
    } catch {
      return false;
    }
  }

  status(): DetectorStatus {
    const base = super.status();
    // Add a note if we'll use the CLI route on install.
    let note: string | undefined;
    try {
      execSync('claude --version', { stdio: 'ignore', timeout: 2000 });
      note = 'will use `claude mcp add` if available';
    } catch { /* no CLI on PATH */ }
    return { ...base, note };
  }

  install(serverName: string, entry: McpServerEntry): InstallResult {
    // Prefer the CLI if it's there — it handles version-specific config
    // shape better than us editing JSON blindly.
    try {
      execSync('claude --version', { stdio: 'ignore', timeout: 2000 });
      const envFlags = Object.entries(entry.env ?? {})
        .map(([k, v]) => `-e ${k}="${v}"`)
        .join(' ');
      const cmd = `claude mcp add --scope user ${envFlags} ${serverName} -- ${entry.command} ${entry.args.map(a => `"${a}"`).join(' ')}`;
      execSync(cmd, { stdio: 'ignore', timeout: 10000 });
      return {
        ok: true, changed: true,
        message: 'added via `claude mcp add`',
      };
    } catch {
      // CLI unavailable or failed — fall through to JSON edit.
    }
    return super.install(serverName, entry);
  }
}
