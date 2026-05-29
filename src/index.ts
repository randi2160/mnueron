#!/usr/bin/env node
/**
 * mnueron MCP server (stdio).
 * Claude Desktop / Claude Code spawn this as a subprocess and talk to it
 * via JSON-RPC on stdin/stdout. Add to claude_desktop_config.json:
 *
 *   { "mcpServers": { "mnueron": { "command": "node",
 *       "args": ["C:\\path\\to\\mnueron\\dist\\index.js"] } } }
 *
 * In hosted mode, set MNUERON_API_URL + MNUERON_API_TOKEN env vars instead.
 *
 * Plugin wiring (W1):
 *   - At startup we load any plugins listed under ~/.mnueron/config.json's
 *     enabledPlugins[] via `loadPlugins(provider)`.
 *   - The returned registry is passed into every tool call so `memory_save`
 *     can run onBeforeSave hooks and `memory_recall` can run onAfterRecall
 *     hooks. See src/tools.ts for the invocation points.
 *   - On shutdown we call `deactivatePlugins(registry)` so plugins can flush
 *     state, close connections, etc.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfig, makeProvider } from './config.js';
import { RecallLogger, detectMcpClient } from './savings/recall-logger.js';
import { TOOL_DEFINITIONS, handleToolCall } from './tools.js';
import { loadPlugins, deactivatePlugins } from './plugins/loader.js';

async function main() {
  const cfg = loadConfig();
  const provider = makeProvider(cfg);

  // Provider-agnostic recall logger — writes to local SQLite at cfg.dbPath
  // regardless of whether `provider` is LocalProvider or RemoteProvider.
  // This is what lets the dashboard at port 3122 see recall events even
  // when memories themselves live in a hosted backend.
  const recallLogger = new RecallLogger({
    dbPath: cfg.dbPath,
    client: detectMcpClient(),
    defaultModelId: process.env.MNUERON_DEFAULT_MODEL ?? 'gpt-4o',
  });

  // Important: log to stderr only. stdout is the JSON-RPC channel; anything
  // we write to stdout that isn't a proper JSON-RPC message corrupts the
  // stream and Claude Desktop drops the connection.
  process.stderr.write(
    `[mnueron] mode=${cfg.mode} ns=${cfg.defaultNamespace} ` +
    `${cfg.mode === 'local' ? `db=${cfg.dbPath}` : `api=${cfg.apiUrl}`}\n`
  );

  // Load enabled plugins (no-op if none configured). Failures here MUST NOT
  // crash the MCP server — a broken plugin should degrade to "feature off",
  // not "tool offline." loadPlugins itself catches per-plugin errors.
  const pluginRegistry = await loadPlugins(provider).catch(e => {
    process.stderr.write(`[mnueron] plugin loader error: ${e?.message ?? e}\n`);
    return { processors: [], sources: [], exporters: [], embedders: [], loaded: [] };
  });
  if (pluginRegistry.loaded.length > 0) {
    process.stderr.write(
      `[mnueron] plugins active: ${pluginRegistry.loaded.map(p => p.manifest.name).join(', ')}\n`
    );
  }

  const server = new Server(
    { name: 'mnueron', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      const result = await handleToolCall(
        provider,
        cfg.defaultNamespace,
        req.params.name,
        args,
        pluginRegistry,
      );

      // Provider-agnostic recall capture. Fires for memory_recall AND
      // memory_recall_multi (bulk searches) so the dashboard reflects every
      // search the agent runs. Other tools (save, get, list, etc.) are not
      // captured — recall_events is for searches, not all memory access.
      if (req.params.name === 'memory_recall' || req.params.name === 'memory_recall_multi') {
        try {
          const query = typeof args.query === 'string' ? args.query : '';
          const namespace = typeof args.namespace === 'string' ? args.namespace : cfg.defaultNamespace;
          const model_id = typeof args.model_id === 'string' ? args.model_id : null;

          // handleToolCall's recall return shape: either an array of memories
          // or { results: Memory[], procedurals?: [...] } when runbooks
          // auto-surface. Normalize either way.
          const memories =
            Array.isArray(result) ? result :
            Array.isArray((result as { results?: unknown })?.results) ? (result as { results: unknown[] }).results :
            [];
          recallLogger.logRecall(
            { query, namespace, model_id },
            memories as Array<{ content?: string | null }>,
          );
        } catch (capErr) {
          // Never fail the MCP tool call because logging stumbled.
          process.stderr.write(`[mnueron/recall-logger] capture failed: ${capErr instanceof Error ? capErr.message : capErr}\n`);
        }
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (e: any) {
      return {
        content: [{ type: 'text', text: `error: ${e?.message ?? String(e)}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    await deactivatePlugins(pluginRegistry).catch(() => {});
    recallLogger.close();
    await provider.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(e => {
  process.stderr.write(`[mnueron] fatal: ${e?.stack ?? e}\n`);
  process.exit(1);
});
