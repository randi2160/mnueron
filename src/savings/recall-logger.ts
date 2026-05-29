/**
 * Provider-agnostic recall logger for the MCP server.
 *
 * Why this exists: in hosted mode (MNUERON_API_URL + MNUERON_API_TOKEN set)
 * the MCP server's `provider` is RemoteProvider — every memory_recall call
 * goes over HTTP to a hosted backend. That hosted backend may or may not
 * capture recall_events, and even if it does, the local user has no way to
 * see "how many times my Claude Desktop recalled from mnueron today"
 * unless we ALSO log it locally.
 *
 * In local mode, LocalProvider used to capture inside .search(). That's now
 * removed in favor of this logger so we have a single capture point for
 * BOTH modes. No double-counting, no provider-dependent behavior.
 *
 * The logger opens its own better-sqlite3 connection to cfg.dbPath (which
 * is defined regardless of mode — defaults to ~/.mnueron/memories.db). Runs
 * RECALL_EVENTS_DDL on construction so the table exists even on a fresh
 * install. Fail-open on every insert: a bad log row never breaks recall.
 */

import Database from 'better-sqlite3';
import {
  RECALL_EVENTS_DDL,
  buildRecallEvent,
  approximateTokens,
  type RecallEventInput,
} from './recall-event.js';

export interface RecallLoggerOptions {
  /** Path to the local SQLite store. Defaults to ~/.mnueron/memories.db. */
  dbPath: string;
  /** Client identifier (claude-desktop, cursor, cline, etc.). */
  client?: string | null;
  /** Default model id when the search call doesn't specify one. */
  defaultModelId?: string | null;
}

export interface SearchLikeInput {
  query?: string;
  namespace?: string | null;
  model_id?: string | null;
}

export interface MemoryLike {
  content?: string | null;
}

export class RecallLogger {
  private db: Database.Database;
  private client: string | null;
  private defaultModelId: string | null;
  private insertStmt: Database.Statement | null = null;
  private nsBaselineStmt: Database.Statement | null = null;
  private globalBaselineStmt: Database.Statement | null = null;
  private ready = false;
  private warned = false;

  constructor(opts: RecallLoggerOptions) {
    this.client = opts.client ?? null;
    this.defaultModelId = opts.defaultModelId ?? null;
    try {
      this.db = new Database(opts.dbPath);
      this.db.exec(RECALL_EVENTS_DDL);
      this.insertStmt = this.db.prepare(
        `INSERT INTO recall_events
           (id, created_at, namespace, query_hash, tokens_returned,
            tokens_baseline_namespace, tokens_baseline_capped, model_id,
            context_limit, client)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      this.nsBaselineStmt = this.db.prepare(
        `SELECT COALESCE(SUM(LENGTH(content)), 0) AS chars
           FROM memories
          WHERE namespace = ?`,
      );
      this.globalBaselineStmt = this.db.prepare(
        `SELECT COALESCE(SUM(LENGTH(content)), 0) AS chars FROM memories`,
      );
      this.ready = true;
      process.stderr.write(`[mnueron/recall-logger] ready dbPath=${opts.dbPath} client=${this.client}\n`);
    } catch (e) {
      // Don't crash the MCP server if SQLite is unavailable for whatever
      // reason (file locked, disk full, etc.). The MCP service stays up;
      // dashboard just won't show new events until the underlying issue
      // resolves.
      this.db = undefined as unknown as Database.Database;
      this.warnOnce(`init failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  /**
   * Write one row for a completed memory_recall call. Fail-open. Called
   * AFTER the underlying provider.search() succeeds so we never log a row
   * for a failed recall (cleaner aggregates).
   */
  logRecall(input: SearchLikeInput, returned: MemoryLike[]): void {
    process.stderr.write(`[mnueron/recall-logger] logRecall called: ns=${input.namespace ?? '-'} returned=${returned.length} ready=${this.ready}\n`);
    if (!this.ready || !this.insertStmt) {
      process.stderr.write(`[mnueron/recall-logger] SKIPPED (not ready)\n`);
      return;
    }
    try {
      const tokens_returned = returned.reduce(
        (sum, m) => sum + approximateTokens(m.content ?? ''),
        0,
      );

      // Baseline = sum of all content tokens in the namespace (or global if
      // no namespace). LENGTH() over text is cheap; sub-millisecond even on
      // tens of thousands of rows.
      const ns = input.namespace ?? null;
      let baseline_chars = 0;
      if (ns && this.nsBaselineStmt) {
        const row = this.nsBaselineStmt.get(ns) as { chars?: number } | undefined;
        baseline_chars = row?.chars ?? 0;
      } else if (this.globalBaselineStmt) {
        const row = this.globalBaselineStmt.get() as { chars?: number } | undefined;
        baseline_chars = row?.chars ?? 0;
      }
      const tokens_baseline_namespace = Math.ceil(baseline_chars / 4);

      const event: RecallEventInput = {
        namespace: ns,
        query: input.query,
        tokens_returned,
        tokens_baseline_namespace,
        model_id: input.model_id ?? this.defaultModelId ?? null,
        client: this.client,
      };
      const ev = buildRecallEvent(event);

      this.insertStmt.run(
        ev.id,
        ev.created_at,
        ev.namespace,
        ev.query_hash,
        ev.tokens_returned,
        ev.tokens_baseline_namespace,
        ev.tokens_baseline_capped,
        ev.model_id,
        ev.context_limit,
        ev.client,
      );
      process.stderr.write(`[mnueron/recall-logger] INSERTED id=${ev.id.slice(0, 8)} tokens_returned=${ev.tokens_returned} tokens_saved=${ev.tokens_baseline_capped - ev.tokens_returned}\n`);
    } catch (e) {
      this.warnOnce(`insert failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  close(): void {
    if (this.ready && this.db) {
      try { this.db.close(); } catch { /* ignore */ }
      this.ready = false;
    }
  }

  private warnOnce(msg: string): void {
    if (this.warned) return;
    this.warned = true;
    // stderr only — stdout is the JSON-RPC channel.
    process.stderr.write(`[mnueron/recall-logger] ${msg}\n`);
  }
}

/**
 * Detect the calling client. MCP doesn't pass a User-Agent equivalent on
 * every request, so we use this precedence:
 *
 *   1. MNUERON_CLIENT env var (explicit override — users can set this in
 *      claude_desktop_config.json's env section)
 *   2. Best-guess from launch context (CODEX_ env, CURSOR_TRACE_ID, etc.)
 *   3. "mnueron-mcp" as a safe generic default
 *
 * Returns a lowercase slug-shaped string the dashboard can group on.
 */
export function detectMcpClient(): string {
  const explicit = process.env.MNUERON_CLIENT;
  if (explicit && explicit.trim().length > 0) return explicit.trim().toLowerCase();

  // Cursor sets CURSOR_TRACE_ID on its MCP child processes.
  if (process.env.CURSOR_TRACE_ID || process.env.CURSOR_USER) return 'cursor';

  // Claude Code (CLI) sets CLAUDE_CODE_SSE_PORT or CODEX_HOME.
  if (process.env.CLAUDE_CODE_SSE_PORT || process.env.CODEX_HOME) return 'claude-code';

  // Cline / VS Code extensions usually inherit VSCODE_PID.
  if (process.env.VSCODE_PID || process.env.VSCODE_INJECTION) {
    return process.env.CLINE_INSTALLED ? 'cline' : 'vscode';
  }

  // Windsurf identifies via CODEIUM_API_URL or similar.
  if (process.env.CODEIUM_API_URL) return 'windsurf';

  return 'mnueron-mcp';
}
