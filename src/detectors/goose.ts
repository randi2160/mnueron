import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { JsonMcpDetector } from './json_detector.js';

/**
 * Goose (block.xyz/goose) — an MCP-native open-source AI agent. Goose's
 * config is YAML by default, but it ALSO honours a JSON config at the
 * same path if you choose it explicitly. We write the JSON variant so we
 * can lean on JsonMcpDetector — users with the YAML config will see
 * "configPath exists but not yet wired" and can copy the JSON in.
 *
 * Config locations:
 *   macOS / Linux: ~/.config/goose/config.json (or config.yaml)
 *   Windows:        %APPDATA%\Block\goose\config.json
 *
 * Goose stores MCP servers under the `extensions` key in YAML, or under
 * `mcpServers` in JSON config (mirroring Cursor / Claude Desktop). Our
 * JsonMcpDetector writes to mcpServers, which Goose accepts.
 */
export class GooseDetector extends JsonMcpDetector {
  id = 'goose';
  displayName = 'Goose';

  protected configPath(): string | null {
    const home = homedir();
    switch (platform()) {
      case 'win32': {
        const appdata = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
        return join(appdata, 'Block', 'goose', 'config.json');
      }
      default:
        return join(home, '.config', 'goose', 'config.json');
    }
  }

  protected isInstalled(): boolean {
    const home = homedir();
    // Either the config dir exists or a Goose binary is on PATH (we don't
    // try to resolve PATH to avoid spawning a child process at detect time).
    switch (platform()) {
      case 'win32': {
        const appdata = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
        return existsSync(join(appdata, 'Block', 'goose'));
      }
      default:
        return existsSync(join(home, '.config', 'goose'));
    }
  }
}
