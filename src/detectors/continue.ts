import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { JsonMcpDetector } from './json_detector.js';

/**
 * Continue (continue.dev) — open-source AI coding assistant for VS Code,
 * JetBrains, and standalone. Stores its global config at:
 *
 *   ~/.continue/config.json     (legacy, still supported)
 *   ~/.continue/config.yaml     (newer, default for fresh installs)
 *
 * MCP servers go under `experimental.modelContextProtocolServers` in JSON
 * or `mcpServers` in YAML. We target the JSON config path because we ship
 * JsonMcpDetector and most existing users still have the JSON variant. If
 * a user only has the YAML config we surface that as "detected but not
 * configured" so they know to wire it manually.
 */
export class ContinueDetector extends JsonMcpDetector {
  id = 'continue';
  displayName = 'Continue';

  protected configPath(): string | null {
    return join(homedir(), '.continue', 'config.json');
  }

  protected isInstalled(): boolean {
    // The .continue/ directory exists if the user has installed any Continue
    // edition (VS Code, JetBrains, CLI). Presence of EITHER config.json or
    // config.yaml is the strongest signal.
    return existsSync(join(homedir(), '.continue'));
  }
}
