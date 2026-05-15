import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { LocalProvider } from './store/local.js';
import { RemoteProvider } from './store/remote.js';
import type { Provider } from './store/provider.js';

export interface MnueronConfig {
  mode: 'local' | 'remote';
  dbPath: string;
  apiUrl?: string;
  apiToken?: string;
  defaultNamespace: string;
}

/**
 * Config precedence:
 *   1. Process env vars (MNUERON_API_URL, MNUERON_API_TOKEN, …)
 *   2. ~/.mnueron/config.json (`apiUrl`, `apiToken`)
 *   3. Defaults (local mode against ~/.mnueron/memories.db)
 *
 * The config.json is written by `mnueron migrate-to-hosted` after a
 * successful upload, so a one-time migration "sticks" without the user
 * having to set env vars in every shell.
 */
export function loadConfig(): MnueronConfig {
  const home = homedir();
  const configPath = join(home, '.mnueron', 'config.json');
  let fileApiUrl: string | undefined;
  let fileApiToken: string | undefined;
  if (existsSync(configPath)) {
    try {
      const j = JSON.parse(readFileSync(configPath, 'utf8'));
      if (typeof j.apiUrl === 'string')   fileApiUrl   = j.apiUrl;
      if (typeof j.apiToken === 'string') fileApiToken = j.apiToken;
    } catch { /* malformed config.json — ignore */ }
  }
  const dbPath = process.env.MNUERON_DB_PATH ?? join(home, '.mnueron', 'memories.db');
  const apiUrl = process.env.MNUERON_API_URL ?? fileApiUrl;
  const apiToken = process.env.MNUERON_API_TOKEN ?? fileApiToken;
  const mode: 'local' | 'remote' = (apiUrl && apiToken) ? 'remote' : 'local';
  const defaultNamespace = process.env.MNUERON_NAMESPACE ?? 'default';
  return { mode, dbPath, apiUrl, apiToken, defaultNamespace };
}

export function makeProvider(cfg: MnueronConfig): Provider {
  if (cfg.mode === 'remote') {
    return new RemoteProvider(cfg.apiUrl!, cfg.apiToken!);
  }
  return new LocalProvider(cfg.dbPath);
}
