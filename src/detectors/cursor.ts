import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { JsonMcpDetector } from './json_detector.js';

/**
 * Cursor stores user-global MCP configuration at ~/.cursor/mcp.json
 * Same shape as Claude Desktop: { "mcpServers": { name: { command, args, env } } }
 * Project-scoped MCP config goes in <project>/.cursor/mcp.json — we don't
 * touch project configs from a global installer.
 */
export class CursorDetector extends JsonMcpDetector {
  id = 'cursor';
  displayName = 'Cursor';

  protected configPath(): string | null {
    return join(homedir(), '.cursor', 'mcp.json');
  }

  protected isInstalled(): boolean {
    const home = homedir();
    // Check for either the config file or the Cursor app data folder.
    if (existsSync(join(home, '.cursor'))) return true;
    switch (platform()) {
      case 'darwin':
        return existsSync(join(home, 'Library', 'Application Support', 'Cursor'));
      case 'win32': {
        const appdata = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
        return existsSync(join(appdata, 'Cursor'));
      }
      case 'linux':
        return existsSync(join(home, '.config', 'Cursor'));
      default:
        return false;
    }
  }
}
