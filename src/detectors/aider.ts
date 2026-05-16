import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  ToolDetector, DetectorStatus, McpServerEntry, InstallResult, UninstallResult,
} from './types.js';

/**
 * Aider (aider.chat) — pair-programming AI in the terminal.
 *
 * As of late-2026 Aider doesn't natively speak MCP — it talks to LLM APIs
 * directly via LiteLLM. So we DETECT Aider's presence (so `mnueron setup`
 * can report it as "found, manual integration only") but we don't write
 * a config that Aider wouldn't read.
 *
 * If/when Aider adds MCP server support upstream, we'll switch this to
 * extend JsonMcpDetector and target the right config key.
 *
 * Detection signals (any one is enough):
 *   - ~/.aider.conf.yml exists (Aider's main config file)
 *   - ~/.aider.input.history exists (Aider's prompt-history cache)
 *   - .aider.* files in CWD (project-local Aider state)
 */
export class AiderDetector implements ToolDetector {
  id = 'aider';
  displayName = 'Aider';

  private isInstalled(): boolean {
    const home = homedir();
    if (existsSync(join(home, '.aider.conf.yml'))) return true;
    if (existsSync(join(home, '.aider.input.history'))) return true;
    if (existsSync(join(home, '.aider.chat.history.md'))) return true;
    return false;
  }

  status(): DetectorStatus {
    const installed = this.isInstalled();
    return {
      id: this.id,
      displayName: this.displayName,
      installed,
      configPath: null,
      configExists: false,
      alreadyConfigured: false,
    };
  }

  install(_serverName: string, _entry: McpServerEntry): InstallResult {
    const installed = this.isInstalled();
    if (!installed) {
      return { ok: false, changed: false, message: `${this.displayName} not detected` };
    }
    return {
      ok: true, changed: false,
      message:
        'Aider does not yet speak MCP natively — install the mnueron Python SDK and call ' +
        'mem.recall() inside an Aider /run hook, or wait for upstream MCP support.',
    };
  }

  uninstall(_serverName: string): UninstallResult {
    return { ok: true, removed: false, message: 'no config to remove (Aider has no MCP support yet)' };
  }
}
