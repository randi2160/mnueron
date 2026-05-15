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
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfig, makeProvider } from './config.js';
import { TOOL_DEFINITIONS, handleToolCall } from './tools.js';

async function main() {
  const cfg = loadConfig();
  const provider = makeProvider(cfg);

  // Important: log to stderr only. stdout is the JSON-RPC channel; anything
  // we write to stdout that isn't a proper JSON-RPC message corrupts the
  // stream and Claude Desktop drops the connection.
  process.stderr.write(
    `[mnueron] mode=${cfg.mode} ns=${cfg.defaultNamespace} ` +
    `${cfg.mode === 'local' ? `db=${cfg.dbPath}` : `api=${cfg.apiUrl}`}\n`
  );

  const server = new Server(
    { name: 'mnueron', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const result = await handleToolCall(
        provider,
        cfg.defaultNamespace,
        req.params.name,
        (req.params.arguments ?? {}) as Record<string, unknown>,
      );
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
