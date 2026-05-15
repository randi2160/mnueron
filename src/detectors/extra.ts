import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { JsonMcpDetector } from './json_detector.js';

/**
 * Windsurf (Codeium) MCP config:
 *   ~/.codeium/windsurf/mcp_config.json
 * Same mcpServers shape.
 */
export class WindsurfDetector extends JsonMcpDetector {
  id = 'windsurf';
  displayName = 'Windsurf';

  protected configPath(): string | null {
    return join(homedir(), '.codeium', 'windsurf', 'mcp_config.json');
  }

  protected isInstalled(): boolean {
    const home = homedir();
    if (existsSync(join(home, '.codeium', 'windsurf'))) return true;
    switch (platform()) {
      case 'darwin':
        return existsSync(join(home, 'Library', 'Application Support', 'Windsurf'));
      case 'win32': {
        const appdata = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
        return existsSync(join(appdata, 'Windsurf'));
      }
      case 'linux':
        return existsSync(join(home, '.config', 'Windsurf'));
      default:
        return false;
    }
  }
}

/**
 * Cline (VS Code extension) stores MCP servers in VS Code's globalStorage.
 * Path is different per OS, and the format is a JSON file edited by Cline's UI.
 * We just check presence here — actual config injection for Cline is best
 * done through Cline's UI today, so we surface a note instead of writing.
 */
export class ClineDetector extends JsonMcpDetector {
  id = 'cline';
  displayName = 'Cline (VS Code)';

  protected configPath(): string | null {
    const home = homedir();
    switch (platform()) {
      case 'darwin':
        return join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage',
                    'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json');
      case 'win32': {
        const appdata = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
        return join(appdata, 'Code', 'User', 'globalStorage',
                    'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json');
      }
      case 'linux':
        return join(home, '.config', 'Code', 'User', 'globalStorage',
                    'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json');
      default:
        return null;
    }
  }
}
