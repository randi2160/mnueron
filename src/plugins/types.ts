/**
 * MNUERON plugin system — public types.
 *
 * Third-party plugins implement these interfaces and publish as npm
 * packages prefixed with `mnueron-plugin-` (e.g. `mnueron-plugin-github-issues`).
 *
 * Plugins extend MNUERON in five ways:
 *
 *   1. PROCESSORS  — transform memories on save or recall (PII redaction,
 *                    translation, sentiment tagging, etc.)
 *   2. SOURCES     — pull memories in from external systems (GitHub issues,
 *                    Slack mentions, Linear tasks, calendar events)
 *   3. EXPORTERS   — push memories out to external systems (daily digest
 *                    email, Notion sync, Slack bot updates)
 *   4. DETECTORS   — add support for new AI dev tools (Aider, Goose, Zed,
 *                    custom in-house tools)
 *   5. EMBEDDERS   — alternative embedding providers (local ONNX, Cohere,
 *                    Voyage, self-hosted)
 *
 * A plugin can implement any combination. The simplest plugin implements
 * one hook and is ~20 lines of code.
 */

import type { Memory, SaveMemoryInput, Provider } from '../store/provider.js';

// ---------------------------------------------------------------------------
// The plugin manifest — what every plugin exports as its default
// ---------------------------------------------------------------------------

export interface MnueronPlugin {
  /** npm-style package identifier. */
  name: string;
  /** Semver. */
  version: string;
  /** One-sentence description shown in the marketplace listing. */
  description: string;
  /** Author display name. */
  author?: string;
  /** URL to source/docs. */
  homepage?: string;
  /** What MNUERON version range this plugin supports. */
  engines?: { mnueron?: string };

  /** Called once when the plugin is installed/loaded for the first time. */
  onInstall?: (ctx: PluginContext) => Promise<void>;
  /** Called every time MNUERON starts up with this plugin enabled. */
  onActivate?: (ctx: PluginContext) => Promise<void>;
  /** Called when the plugin is being disabled or uninstalled. */
  onDeactivate?: (ctx: PluginContext) => Promise<void>;

  /** What capabilities this plugin contributes. */
  processors?: MemoryProcessor[];
  sources?: ExternalSource[];
  exporters?: MemoryExporter[];
  embedders?: EmbeddingProvider[];
  // Tool detectors live in src/detectors and follow that interface; plugins
  // can register additional detectors at runtime via ctx.registerDetector().
}

// ---------------------------------------------------------------------------
// Context every plugin receives at activate time
// ---------------------------------------------------------------------------

export interface PluginContext {
  /** Read-only access to the same Provider the MCP server uses. */
  provider: Provider;
  /** This plugin's user-supplied config from ~/.mnueron/config.json */
  config: Record<string, unknown>;
  /** Plugin-private key-value storage (sandboxed per plugin). */
  storage: PluginStorage;
  /** Logger that prepends the plugin name. */
  logger: PluginLogger;
  /** Register a detector at runtime (alternative to declaring statically). */
  registerDetector?: (detector: any) => void;
}

export interface PluginStorage {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<string[]>;
}

export interface PluginLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

// ---------------------------------------------------------------------------
// Capability interfaces
// ---------------------------------------------------------------------------

/** Transform memories on save or recall. */
export interface MemoryProcessor {
  id: string;
  /** Fires before a memory is persisted. Return modified input or `null` to drop. */
  onBeforeSave?: (input: SaveMemoryInput) => Promise<SaveMemoryInput | null>;
  /** Fires on every search result. Useful for redaction-at-read. */
  onAfterRecall?: (memory: Memory) => Promise<Memory>;
}

/** Pull memories in from an external system on a schedule. */
export interface ExternalSource {
  id: string;
  /** How often (ms) the source should be polled. 0 = manual trigger only. */
  pollInterval?: number;
  /** Fetch new items and return them ready for save. */
  fetch(ctx: PluginContext): Promise<SaveMemoryInput[]>;
}

/** Push memories out to an external system on a schedule. */
export interface MemoryExporter {
  id: string;
  exportInterval?: number;
  /** Send memories to an external system. */
  export(memories: Memory[], ctx: PluginContext): Promise<void>;
}

/** Alternative embedding provider. */
export interface EmbeddingProvider {
  id: string;
  dimensions: number;
  embed(text: string): Promise<number[]>;
  embedBatch?(texts: string[]): Promise<number[][]>;
}
