import { homedir } from 'node:os';
import { join } from 'node:path';
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

export function loadConfig(): MnueronConfig {
  const home = homedir();
  const dbPath = process.env.MNUERON_DB_PATH ?? join(home, '.mnueron', 'memories.db');
  const apiUrl = process.env.MNUERON_API_URL;
  const apiToken = process.env.MNUERON_API_TOKEN;
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
