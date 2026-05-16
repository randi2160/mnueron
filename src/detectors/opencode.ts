import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { JsonMcpDetector } from './json_detector.js';

/**
 * OpenCode (sst.dev/opencode) — open-source terminal AI coding agent.
 * Speaks MCP natively. Config lives at:
 *
 *   macOS / Linux:  ~/.config/opencode/config.json
 *   Windows:        %APPDATA%\opencode\config.json
 *
 * Schema: standard `mcpServers` map — same shape as Cursor / Claude Desktop,
 * so we inherit JsonMcpDetector directly. OpenCode auto-reloads MCP servers
 * when the config changes; users don't have to restart.
 */
export class OpenCodeDetector extends JsonMcpDetector {
  id = 'opencode';
  displayName = 'OpenCode';

  protected configPath(): string | null {
    const home = homedir();
    switch (platform()) {
      case 'win32': {
        const appdata = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
        return join(appdata, 'opencode', 'config.json');
      }
      default:
        return join(home, '.config', 'opencode', 'config.json');
    }
  }

  protected isInstalled(): boolean {
    const home = homedir();
    switch (platform()) {
      case 'win32': {
        const appdata = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
        return existsSync(join(appdata, 'opencode'));
      }
      default:
        return existsSync(join(home, '.config', 'opencode'));
    }
  }
}
