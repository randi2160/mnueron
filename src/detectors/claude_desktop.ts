import { existsSync, readdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { JsonMcpDetector } from './json_detector.js';

/**
 * Where Claude Desktop's `claude_desktop_config.json` lives, by OS.
 *
 * On Windows there are two install shapes to consider:
 *
 *   - Traditional (.exe / installer): config at
 *       %APPDATA%\Claude\claude_desktop_config.json
 *   - Microsoft Store install: every %APPDATA% write the app makes is
 *     redirected by the Store to:
 *       %LOCALAPPDATA%\Packages\Claude_<sfx>\LocalCache\Roaming\Claude\
 *         claude_desktop_config.json
 *
 * The earlier detector only looked at the traditional path, so users with
 * the Microsoft Store install saw "Claude Desktop not detected." We now
 * check both and pick the first one that exists (or whose parent dir does,
 * which catches "installed but never launched after install").
 */
export class ClaudeDesktopDetector extends JsonMcpDetector {
  id = 'claude-desktop';
  displayName = 'Claude Desktop';

  protected configPath(): string | null {
    const candidates = this.candidatePaths();
    if (candidates.length === 0) return null;

    for (const p of candidates) {
      if (existsSync(p)) return p;
      const dir = p.replace(/[/\\]claude_desktop_config\.json$/, '');
      if (existsSync(dir)) return p;
    }
    return candidates[0] ?? null;
  }

  protected isInstalled(): boolean {
    for (const p of this.candidatePaths()) {
      if (existsSync(p)) return true;
      const dir = p.replace(/[/\\]claude_desktop_config\.json$/, '');
      if (existsSync(dir)) return true;
    }
    return false;
  }

  /**
   * Every place Claude Desktop's config has been observed to land, ordered
   * by preference. Order matters: configPath() returns the first existing
   * one.
   */
  private candidatePaths(): string[] {
    const home = homedir();
    const out: string[] = [];

    switch (platform()) {
      case 'darwin':
        out.push(join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
        out.push(join(home, 'Library', 'Application Support', 'AnthropicClaude', 'claude_desktop_config.json'));
        break;

      case 'win32': {
        const appdata = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
        const localApp = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');

        out.push(join(appdata, 'Claude', 'claude_desktop_config.json'));
        out.push(join(appdata, 'AnthropicClaude', 'claude_desktop_config.json'));

        // Microsoft Store install — Store redirects %APPDATA% writes into
        // the package's LocalCache\Roaming. Package suffix isn't stable, so
        // we glob Packages\Claude* and Packages\Anthropic*.
        const packagesDir = join(localApp, 'Packages');
        if (existsSync(packagesDir)) {
          try {
            for (const name of readdirSync(packagesDir)) {
              const lower = name.toLowerCase();
              if (!lower.startsWith('claude') && !lower.startsWith('anthropic')) continue;
              out.push(
                join(packagesDir, name, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'),
              );
              out.push(
                join(packagesDir, name, 'LocalCache', 'Roaming', 'AnthropicClaude', 'claude_desktop_config.json'),
              );
            }
          } catch {
            /* unreadable Packages dir — skip Store paths */
          }
        }
        break;
      }

      case 'linux':
        out.push(join(home, '.config', 'Claude', 'claude_desktop_config.json'));
        out.push(join(home, '.config', 'AnthropicClaude', 'claude_desktop_config.json'));
        break;
    }

    return out;
  }
}
