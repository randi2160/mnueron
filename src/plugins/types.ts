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
  meetingSources?: MeetingSource[];
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

// ---------------------------------------------------------------------------
// Meeting source plugins
//
// Meetings are a richer primitive than memories — a single meeting becomes
// a meetings row, attendee rows, transcript-chunk memory rows, decision
// rows, action-item rows, and link rows in one transactional write. The
// MeetingSource plugin interface returns the normalized envelope; the core
// meeting pipeline does everything downstream of that envelope.
//
// Connectors implement at minimum one of:
//   - onWebhook(payload) — vendor pushes when a meeting ends (Granola, Read.ai)
//   - onPoll() — we poll the vendor's API (Otter free tier, Fireflies)
//   - onUpload(file) — user-driven manual ingestion (upload plugin)
//   - onEmail(email) — inbound email to magic address (email-forward plugin)
//
// Plugins do NOT touch the database or embedder directly. Returning an
// envelope hands off to core, which does all the work that needs RLS and
// internal API access.
// ---------------------------------------------------------------------------

/** One meeting transcript turn (a single contiguous utterance from one speaker). */
export interface MeetingTurn {
  speaker: string;
  text: string;
  /** Milliseconds from meeting start. */
  started_at_ms: number;
}

/** Attendee record produced by a meeting source. */
export interface MeetingAttendee {
  name: string;
  email?: string;
  /** 'organizer' | 'attendee' | 'invited_absent' */
  role?: 'organizer' | 'attendee' | 'invited_absent';
}

/**
 * Normalized meeting payload. The single contract between a MeetingSource
 * plugin and the core meeting pipeline. Connectors translate vendor-specific
 * shapes into this envelope; core does not know or care where it came from.
 */
export interface MeetingEnvelope {
  /** Plugin id that produced this envelope. Filled in by the registry. */
  source: string;
  /**
   * The source's stable id for this meeting (e.g. granola note id, fathom
   * recording id). Used together with `source` for dedupe.
   */
  source_ref: string;
  title: string;
  /** Unix ms. */
  started_at: number;
  duration_seconds: number | null;
  attendees: MeetingAttendee[];
  transcript: MeetingTurn[];
  /** Vendor-provided summary if any. Core may also generate its own. */
  summary?: string;
  /** Verbatim source payload, kept for audit and debug. */
  raw?: Record<string, unknown>;
}

/**
 * Result of ingesting one envelope. Mostly opaque to plugins; surfaces
 * enough that a connector can log a useful confirmation back to the
 * user / vendor.
 */
export interface MeetingIngestResult {
  meeting_id: string;
  status: 'created' | 'merged' | 'duplicate';
  decision_count: number;
  action_item_count: number;
}

/**
 * Plugin interface for meeting sources. A plugin implements whichever
 * lifecycle hooks make sense for its vendor.
 */
export interface MeetingSource {
  id: string;
  /** Human-readable name for the integrations dashboard. */
  display_name: string;
  /**
   * Vendor logo (path under /public/integrations/) or null to fall back
   * to a generic icon.
   */
  logo?: string;

  /**
   * Called when a vendor-specific webhook arrives at
   * /api/integrations/meet/<plugin.id>/webhook. The plugin validates the
   * signature, translates the payload, and returns zero or more envelopes.
   * Throwing aborts processing for that webhook (vendor will retry).
   */
  onWebhook?(payload: unknown, headers: Record<string, string>, ctx: PluginContext): Promise<MeetingEnvelope[]>;

  /**
   * Called on the poll schedule (or by manual trigger). Plugin reaches
   * out to vendor API and returns new envelopes since last poll. Polled
   * sources should track their cursor in ctx.storage.
   */
  pollInterval?: number;
  onPoll?(ctx: PluginContext): Promise<MeetingEnvelope[]>;

  /**
   * Called when a user uploads a file via the dashboard. Plugin parses
   * the file (txt, vtt, srt, json) and returns one envelope. The upload
   * plugin implements this; vendor plugins do not.
   */
  onUpload?(file: { name: string; mime: string; bytes: Uint8Array }, ctx: PluginContext): Promise<MeetingEnvelope>;

  /**
   * Called when an email arrives at the org's magic ingest address. The
   * email-forward plugin implements this; vendor plugins do not.
   */
  onEmail?(email: { from: string; subject: string; text: string; html?: string; attachments: Array<{ name: string; mime: string; bytes: Uint8Array }> }, ctx: PluginContext): Promise<MeetingEnvelope[]>;
}
