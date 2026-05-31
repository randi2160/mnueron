/**
 * Plugin loader.
 *
 * Discovery: reads ~/.mnueron/config.json for an `enabledPlugins: string[]`
 * list, then dynamically imports each one by npm name. Plugins must follow
 * the naming convention `mnueron-plugin-*` or be scoped under a trusted
 * org (e.g. `@mnueron-community/*`).
 *
 * Loading: validates the default export against the MnueronPlugin shape,
 * builds a sandboxed PluginContext, calls onActivate(), and returns the
 * registered capabilities.
 *
 * The MCP server is responsible for actually invoking the registered
 * processors at save/recall time. This file just collects them.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type {
  MnueronPlugin,
  PluginContext,
  PluginStorage,
  PluginLogger,
  MemoryProcessor,
  ExternalSource,
  MemoryExporter,
  EmbeddingProvider,
  MeetingSource,
} from './types.js';
import type { Provider } from '../store/provider.js';

interface PluginConfig {
  enabledPlugins?: string[];
  pluginConfig?: Record<string, Record<string, unknown>>;
}

export interface LoadedPlugin {
  manifest: MnueronPlugin;
  context: PluginContext;
}

export interface PluginRegistry {
  processors: MemoryProcessor[];
  sources: ExternalSource[];
  exporters: MemoryExporter[];
  embedders: EmbeddingProvider[];
  meetingSources: MeetingSource[];
  loaded: LoadedPlugin[];
}

const CONFIG_DIR = join(homedir(), '.mnueron');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');
const PLUGINS_STATE_DIR = join(CONFIG_DIR, 'plugins-state');
const ALLOWED_NAME = /^(?:mnueron-plugin-[a-z0-9-]+|@[a-z0-9-]+\/mnueron-plugin-[a-z0-9-]+)$/;

export async function loadPlugins(provider: Provider): Promise<PluginRegistry> {
  const cfg = await readConfig();
  const registry: PluginRegistry = {
    processors: [],
    sources: [],
    exporters: [],
    embedders: [],
    meetingSources: [],
    loaded: [],
  };

  for (const name of cfg.enabledPlugins ?? []) {
    if (!ALLOWED_NAME.test(name)) {
      console.warn(`[plugins] refusing to load "${name}": doesn't match allowed naming convention`);
      continue;
    }
    try {
      const loaded = await loadOne(name, provider, cfg.pluginConfig?.[name] ?? {});
      if (loaded) {
        registry.processors.push(...(loaded.manifest.processors ?? []));
        registry.sources.push(...(loaded.manifest.sources ?? []));
        registry.exporters.push(...(loaded.manifest.exporters ?? []));
        registry.embedders.push(...(loaded.manifest.embedders ?? []));
        registry.meetingSources.push(...(loaded.manifest.meetingSources ?? []));
        registry.loaded.push(loaded);
        console.log(`[plugins] activated ${name}@${loaded.manifest.version}`);
      }
    } catch (e: any) {
      console.warn(`[plugins] failed to load ${name}: ${e?.message ?? e}`);
    }
  }

  return registry;
}

async function loadOne(
  name: string,
  provider: Provider,
  pluginConfig: Record<string, unknown>,
): Promise<LoadedPlugin | null> {
  // Dynamic import — plugin must be installed in this Node's resolution path.
  const mod = await import(name);
  const manifest: MnueronPlugin | undefined = mod.default ?? mod.plugin ?? mod;
  if (!manifest || typeof manifest !== 'object' || !manifest.name) {
    throw new Error('plugin does not export a valid manifest');
  }
  if (manifest.name !== name && manifest.name !== name.replace(/^@[^/]+\//, '')) {
    throw new Error(`manifest name "${manifest.name}" does not match package name "${name}"`);
  }

  const context: PluginContext = {
    provider,
    config: pluginConfig,
    storage: makePluginStorage(name),
    logger: makePluginLogger(name),
  };

  if (manifest.onInstall) {
    const installed = await context.storage.get<boolean>('_installed');
    if (!installed) {
      await manifest.onInstall(context);
      await context.storage.set('_installed', true);
    }
  }
  if (manifest.onActivate) await manifest.onActivate(context);

  return { manifest, context };
}

export async function deactivatePlugins(registry: PluginRegistry): Promise<void> {
  for (const { manifest, context } of registry.loaded) {
    try {
      await manifest.onDeactivate?.(context);
    } catch (e: any) {
      console.warn(`[plugins] deactivate of ${manifest.name} failed: ${e?.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readConfig(): Promise<PluginConfig> {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function makePluginStorage(name: string): PluginStorage {
  const dir = join(PLUGINS_STATE_DIR, sanitize(name));
  return {
    async get<T>(key: string): Promise<T | null> {
      const path = join(dir, sanitize(key) + '.json');
      if (!existsSync(path)) return null;
      try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
    },
    async set(key: string, value: unknown): Promise<void> {
      const path = join(dir, sanitize(key) + '.json');
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(value));
    },
    async delete(key: string): Promise<void> {
      const path = join(dir, sanitize(key) + '.json');
      if (existsSync(path)) {
        const { unlink } = await import('node:fs/promises');
        await unlink(path);
      }
    },
    async list(): Promise<string[]> {
      if (!existsSync(dir)) return [];
      const { readdir } = await import('node:fs/promises');
      const files = await readdir(dir);
      return files.filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''));
    },
  };
}

function makePluginLogger(name: string): PluginLogger {
  const prefix = `[plugin:${name}]`;
  return {
    debug: (...a) => console.debug(prefix, ...a),
    info: (...a) => console.log(prefix, ...a),
    warn: (...a) => console.warn(prefix, ...a),
    error: (...a) => console.error(prefix, ...a),
  };
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}

// ---------------------------------------------------------------------------
// Public CLI helpers — used by `mnueron plugin add/remove/list`
// ---------------------------------------------------------------------------

export async function listEnabledPlugins(): Promise<string[]> {
  return (await readConfig()).enabledPlugins ?? [];
}

export async function enablePlugin(name: string): Promise<void> {
  if (!ALLOWED_NAME.test(name)) {
    throw new Error(`plugin name "${name}" must match mnueron-plugin-* or @scope/mnueron-plugin-*`);
  }
  const cfg = await readConfig();
  const enabled = new Set(cfg.enabledPlugins ?? []);
  enabled.add(name);
  cfg.enabledPlugins = Array.from(enabled);
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

export async function disablePlugin(name: string): Promise<void> {
  const cfg = await readConfig();
  cfg.enabledPlugins = (cfg.enabledPlugins ?? []).filter(n => n !== name);
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
