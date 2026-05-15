import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { JsonMcpDetector } from './json_detector.js';

export class ClaudeDesktopDetector extends JsonMcpDetector {
  id = 'claude-desktop';
  displayName = 'Claude Desktop';

  protected configPath(): string | null {
    const home = homedir();
    switch (platform()) {
      case 'darwin':
        return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
      case 'win32':
        return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
      case 'linux':
        return join(home, '.config', 'Claude', 'claude_desktop_config.json');
      default:
        return null;
    }
  }

  protected isInstalled(): boolean {
    // We treat presence of the config dir OR the app itself as "installed."
    // On Windows the app folder is %LOCALAPPDATA%\Programs\Claude. We check
    // for either to avoid false negatives for users who configured but never
    // launched, or who launched but on a system without the typical path.
    const path = this.configPath();
    if (!path) return false;
    if (existsSync(path)) return true;
    // Check the directory's parent — if Claude Desktop has run at least once
    // it creates this folder.
    const dir = path.replace(/[\/\\]claude_desktop_config\.json$/, '');
    return existsSync(dir);
  }
}
