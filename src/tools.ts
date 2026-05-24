/**
 * MCP tool definitions and handlers.
 * Each tool has a JSON-schema for parameters (so Claude knows how to call it)
 * and a handler that runs against the Provider.
 *
 * IMPORTANT: memory_recall and memory_list return *previews* of each memory,
 * not the full content. Backfilled chats can be tens of thousands of
 * characters each — returning 10 of them in full blows up the agent's
 * context window. Agents should `memory_get(id)` after triaging which
 * previews are actually worth reading.
 *
 * Plugin hooks (W1):
 *   - handleToolCall accepts a PluginRegistry. For each save (memory_save +
 *     memory_import_chat), every processor's `onBeforeSave` runs in order;
 *     if any returns null, the save is silently dropped (useful for
 *     blocking redaction).
 *   - For each recall (memory_recall, memory_list, memory_get), every
 *     processor's `onAfterRecall` runs in order on each returned memory.
 *   - Failures in plugin hooks are caught and logged; they don't break
 *     the user's tool call.
 */
import type { Memory, Provider, SaveMemoryInput } from './store/provider.js';
import type { PluginRegistry } from './plugins/loader.js';
import { importClaudeExport } from './import/claude.js';
import { importOpenAIExport } from './import/openai.js';
import { probeClaudeCowork, importFromCoworkSession } from './import/claude_cowork.js';

// Sentinel registry for callers that don't pass one (CLI commands, tests).
const EMPTY_REGISTRY: PluginRegistry = {
  processors: [],
  sources: [],
  exporters: [],
  embedders: [],
  loaded: [],
};

/**
 * Run every plugin's onBeforeSave in sequence. Each plugin sees the output
 * of the prior one. Returning `null` from any plugin cancels the save.
 */
async function runBeforeSave(
  input: SaveMemoryInput,
  registry: PluginRegistry,
): Promise<SaveMemoryInput | null> {
  let current: SaveMemoryInput | null = input;
  for (const p of registry.processors) {
    if (!p.onBeforeSave || current === null) continue;
    try {
      current = await p.onBeforeSave(current);
    } catch (e: any) {
      process.stderr.write(`[mnueron] processor ${p.id} onBeforeSave threw: ${e?.message ?? e}\n`);
    }
  }
  return current;
}

/**
 * Run every plugin's onAfterRecall on each memory. Failures are logged but
 * don't drop the memory from results.
 */
async function runAfterRecall(
  memories: Memory[],
  registry: PluginRegistry,
): Promise<Memory[]> {
  if (registry.processors.length === 0) return memories;
  const out: Memory[] = [];
  for (const m of memories) {
    let curr: Memory = m;
    for (const p of registry.processors) {
      if (!p.onAfterRecall) continue;
      try {
        curr = await p.onAfterRecall(curr);
      } catch (e: any) {
        process.stderr.write(`[mnueron] processor ${p.id} onAfterRecall threw: ${e?.message ?? e}\n`);
      }
    }
    out.push(curr);
  }
  return out;
}

// Max content length included in list/recall responses. ~800 chars is enough
// for a smart agent to see whether a memory is relevant; if it wants the
// rest, memory_get(id) gives the full text.
const PREVIEW_CHARS = 800;

function toPreview(m: Memory) {
  const full = m.content ?? '';
  const truncated = full.length > PREVIEW_CHARS;
  return {
    id: m.id,
    namespace: m.namespace,
    content_preview: truncated ? full.slice(0, PREVIEW_CHARS) + '…' : full,
    content_full_length: full.length,
    content_truncated: truncated,
    tags: m.tags,
    source: m.source,
    source_ref: m.source_ref,
    score: m.score,
    created_at: m.created_at,
    updated_at: m.updated_at,
  };
}

export const TOOL_DEFINITIONS = [
  {
    name: 'memory_save',
    description:
      'Save a memory for later recall. Use for facts about the user, project conventions, decisions, or anything worth remembering across sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The text to remember.' },
        namespace: { type: 'string', description: 'Optional logical group (e.g. project name). Defaults to user default.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for filtering.' },
        source: { type: 'string', description: 'Where this memory came from (default: "agent").' },
      },
      required: ['content'],
    },
  },
  {
    name: 'memory_recall',
    description:
      'Search saved memories by relevance. Returns PREVIEWS (first ~800 chars) plus full length and id for each match. ' +
      'Use memory_get(id) to fetch the complete text of a specific result. ' +
      'Defaults to top 5 results. Search is hybrid (keyword + semantic), so the query can be a natural-language description. ' +
      'AUTO-SURFACES RUNBOOKS: if the query matches any saved procedural memory trigger phrase ' +
      '(e.g. "ship to vercel" → "Push mnueron changes to Vercel" runbook), those runbooks come back ' +
      'in a separate "procedurals" array alongside the memories. Use procedural_get(id) to fetch full step content.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language search.' },
        namespace: { type: 'string', description: 'Limit to one namespace.' },
        k: { type: 'number', description: 'Top-k results to return. Default 5. Max 25.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_get',
    description:
      'Fetch a memory by id. Default returns up to 8000 characters. For long memories, set max_chars higher, or use offset + max_chars to page through.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The memory id from memory_recall.' },
        max_chars: { type: 'number', description: 'Cap on characters returned. Default 8000, max 100000.' },
        offset: { type: 'number', description: 'Start character offset (for paging through long content). Default 0.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'memory_get_thread',
    description:
      'Fetch every chunk of a chunked conversation, ordered by position. Use this after memory_recall returns a chunk and you want the full thread context. Pass either the chunk id (we will resolve its parent_ref) or the parent_ref directly.',
    inputSchema: {
      type: 'object',
      properties: {
        id_or_parent_ref: {
          type: 'string',
          description: 'A chunk id from memory_recall, OR a parent_ref value from metadata.parent_ref.',
        },
      },
      required: ['id_or_parent_ref'],
    },
  },
  {
    name: 'memory_list',
    description:
      'List recent memories. Returns PREVIEWS only — call memory_get(id) for full content. Default limit 20, max 100. Use for browsing a namespace.',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string' },
        limit: { type: 'number', description: 'Default 20, max 100.' },
        before: { type: 'number', description: 'Unix ms cursor for pagination.' },
      },
    },
  },
  {
    name: 'memory_delete',
    description: 'Delete a memory by id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'memory_namespaces',
    description: 'List all namespaces and their memory counts.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_import_chat',
    description:
      'Import past conversations into memory. Accepts a path to a Claude conversation export or an OpenAI conversations export. Each conversation becomes a memory.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the export file.' },
        format: {
          type: 'string',
          enum: ['claude', 'openai', 'auto'],
          description: 'Source format. auto sniffs by file content.',
        },
        namespace: { type: 'string', description: 'Target namespace for imported memories.' },
        summarize: {
          type: 'boolean',
          description: 'If true, summarize long chats (requires summarizer; otherwise raw text is stored). Default false.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'memory_import_cowork',
    description:
      'Import every Claude Cowork (desktop "local agent") session transcript on this machine into memory. Probes platform-specific roots (~/.claude/projects, %APPDATA%\\Claude\\local-agent-mode-sessions, and the Microsoft Store Packages location), recursively finds Cowork JSONL transcripts, and saves each session as one memory (the chunker splits per-turn). Idempotent: re-running upserts by source_ref="cowork:<sessionId>". Use this when the user says "import my cowork chats" / "remember context from my past sessions" / similar.',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Target namespace (default "claude-cowork").' },
        limit: { type: 'number', description: 'Cap the number of sessions imported in this call (default unlimited).' },
        probe_only: { type: 'boolean', description: 'If true, return what would be imported but do not save.' },
      },
    },
  },
  // ─── Procedural memory (runbooks) ──────────────────────────────────────
  // Procedural memory stores how-to runbooks: title + trigger phrases + step
  // list. Use these tools when the user asks how to do a recurring task and
  // memory_recall doesn't already surface a runbook automatically.
  {
    name: 'procedural_match',
    description:
      'Look up saved runbooks whose trigger phrases match a query. ' +
      'Returns each matching runbook with its full step list. ' +
      'Use this when the user asks how to do something — "how do I deploy", "ship to vercel", etc. ' +
      'memory_recall also auto-surfaces runbooks, but call this directly when you specifically want procedural results.',
    inputSchema: {
      type: 'object',
      properties: {
        trigger: { type: 'string', description: 'The phrase to match against trigger_phrases.' },
        limit: { type: 'number', description: 'Top-k runbooks to return. Default 5.' },
      },
      required: ['trigger'],
    },
  },
  {
    name: 'procedural_list',
    description:
      'List saved runbooks, most-recently-used first. Returns titles, trigger phrases, and reliability counters. ' +
      'Use to browse available procedures without a specific query.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Default 50, max 200.' },
      },
    },
  },
  {
    name: 'procedural_get',
    description:
      'Fetch a saved runbook by id, including every step with its command and verification check.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The runbook id from procedural_match or procedural_list.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'procedural_record_outcome',
    description:
      'Record that a runbook was run, with the outcome. Bumps the success or failure counter and stamps last_used_at. ' +
      'Use after the user (or you) has actually executed the runbook end-to-end. ' +
      'Argument: outcome must be exactly "success" or "failure".',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The runbook id.' },
        outcome: { type: 'string', enum: ['success', 'failure'] },
      },
      required: ['id', 'outcome'],
    },
  },
];

export async function handleToolCall(
  provider: Provider,
  defaultNamespace: string,
  name: string,
  args: Record<string, unknown>,
  registry: PluginRegistry = EMPTY_REGISTRY,
) {
  switch (name) {
    case 'memory_save': {
      const initial: SaveMemoryInput = {
        content: String(args.content ?? ''),
        namespace: (args.namespace as string) ?? defaultNamespace,
        tags: (args.tags as string[]) ?? [],
        source: (args.source as string) ?? 'agent',
      };
      const transformed = await runBeforeSave(initial, registry);
      if (transformed === null) {
        // A plugin dropped the save (e.g. policy/redaction filter).
        return { dropped: true, reason: 'a plugin cancelled the save' };
      }
      return await provider.save(transformed);
    }
    case 'memory_recall': {
      const k = Math.min(25, Math.max(1, (args.k as number) ?? 5));
      const query = String(args.query ?? '');

      // Hosted mode: use the unified /api/recall/unified endpoint which
      // returns BOTH memories and matching runbooks in one round trip.
      // This is what lets an agent saying "ship to vercel" auto-pull the
      // matching runbook without ever calling procedural_match directly.
      //
      // Local mode (or hosted-old-binary): fall back to the legacy
      // provider.search() — no runbook surfacing, but agents can still
      // call procedural_match explicitly.
      const unifiedRecall = (provider as any).unifiedRecall;
      let memories: Memory[];
      let procedurals: Array<Record<string, unknown>> = [];
      if (typeof unifiedRecall === 'function') {
        const r = await unifiedRecall.call(provider, query, {
          namespace: args.namespace as string | undefined,
          limit: k,
        });
        memories = r.memories ?? [];
        procedurals = r.procedurals ?? [];
      } else {
        memories = await provider.search({
          query,
          namespace: args.namespace as string | undefined,
          k,
          tags: args.tags as string[] | undefined,
        });
      }
      const processed = await runAfterRecall(memories, registry);
      const memPreviews = processed.map(toPreview);

      // Trim runbook steps to the same kind of context-friendly preview
      // the memory previews use. Full step content is still one
      // procedural_get away — the agent can fetch it if it actually
      // needs to execute the runbook.
      const runbookPreviews = procedurals.map((rb) => ({
        id: rb.id,
        title: rb.title,
        summary: rb.summary,
        trigger_phrases: rb.trigger_phrases,
        step_count: Array.isArray(rb.steps) ? rb.steps.length : 0,
        match_kind: rb.match_kind,
        success_count: rb.success_count,
        failure_count: rb.failure_count,
        last_used_at: rb.last_used_at,
      }));

      // Backwards-compat: if no runbooks matched, return a flat array
      // (the legacy shape every existing caller expects). If runbooks
      // ARE present, return the richer envelope. Agents that care about
      // runbooks see the new shape; old agents see the old one.
      if (runbookPreviews.length === 0) {
        return memPreviews;
      }
      return {
        memories: memPreviews,
        procedurals: runbookPreviews,
      };
    }
    case 'memory_get': {
      const id = String(args.id ?? '');
      if (!id) throw new Error('id is required');
      const mem = await provider.get(id);
      if (!mem) throw new Error(`memory not found: ${id}`);
      // Run onAfterRecall plugins before slicing — gives plugins a chance to
      // redact / decorate the full content, then we slice the result.
      const [processed] = await runAfterRecall([mem], registry);
      // Cap content size to keep responses context-friendly. The agent can
      // page via offset + max_chars if it needs more.
      const fullLength = processed.content?.length ?? 0;
      const maxChars = Math.min(100000, Math.max(100, (args.max_chars as number) ?? 8000));
      const offset = Math.max(0, Math.min(fullLength, (args.offset as number) ?? 0));
      const slice = (processed.content ?? '').slice(offset, offset + maxChars);
      const truncated = offset + slice.length < fullLength;
      return {
        ...processed,
        content: slice,
        content_full_length: fullLength,
        content_offset: offset,
        content_returned_chars: slice.length,
        content_truncated: truncated,
        content_next_offset: truncated ? offset + slice.length : null,
      };
    }
    case 'memory_get_thread': {
      const idOrRef = String(args.id_or_parent_ref ?? '');
      if (!idOrRef) throw new Error('id_or_parent_ref is required');
      const findThread = (provider as any).findThread;
      if (typeof findThread !== 'function') {
        throw new Error('memory_get_thread is only supported in local mode for now');
      }
      const chunks = findThread.call(provider, idOrRef) as Memory[];
      if (chunks.length === 0) return { chunks: [], count: 0 };
      const processed = await runAfterRecall(chunks, registry);
      return {
        count: processed.length,
        parent_ref: processed[0].source_ref ?? null,
        chunks: processed.map(toPreview),
      };
    }
    case 'memory_list': {
      const limit = Math.min(100, Math.max(1, (args.limit as number) ?? 20));
      const memories = await provider.list({
        namespace: args.namespace as string | undefined,
        limit,
        before: args.before as number | undefined,
      });
      const processed = await runAfterRecall(memories, registry);
      return processed.map(toPreview);
    }
    case 'memory_delete': {
      const ok = await provider.delete(String(args.id));
      return { deleted: ok };
    }
    case 'memory_namespaces': {
      return await provider.namespaces();
    }
    case 'memory_import_chat': {
      const path = String(args.path ?? '');
      const ns = (args.namespace as string) ?? defaultNamespace;
      let format = (args.format as string) ?? 'auto';

      if (format === 'auto') format = await sniffFormat(path);

      let items;
      if (format === 'claude') {
        items = await importClaudeExport(path, ns);
      } else if (format === 'openai') {
        items = await importOpenAIExport(path, ns);
      } else {
        throw new Error(`Unknown format: ${format}`);
      }
      // Run onBeforeSave plugin hooks against every imported item.
      // Items dropped by plugins are filtered out and counted separately.
      let droppedByPlugin = 0;
      const filtered: SaveMemoryInput[] = [];
      for (const it of items) {
        const transformed = await runBeforeSave(it, registry);
        if (transformed === null) droppedByPlugin++;
        else filtered.push(transformed);
      }
      const result = await provider.bulkSave(filtered);
      return { ...result, namespace: ns, format, dropped_by_plugin: droppedByPlugin };
    }
    case 'memory_import_cowork': {
      const ns = (args.namespace as string) ?? 'claude-cowork';
      const limit = typeof args.limit === 'number' ? Math.max(1, Math.floor(args.limit)) : undefined;
      const probeOnly = Boolean(args.probe_only);

      const probe = probeClaudeCowork();
      if (!probe.found || probe.sessions.length === 0) {
        return {
          imported: 0,
          saved: 0,
          dropped_by_plugin: 0,
          empty_sessions: 0,
          errors: 0,
          total_sessions: 0,
          scanned_roots: probe.scannedRoots,
          paths_attempted: probe.pathsAttempted,
          hints: probe.hints,
          namespace: ns,
        };
      }
      const targets = limit ? probe.sessions.slice(0, limit) : probe.sessions;

      const items: SaveMemoryInput[] = [];
      let empty = 0;
      let parseErrors = 0;
      for (const s of targets) {
        try {
          const sessionItems = importFromCoworkSession(s.filePath, ns, {
            sessionId: s.sessionId,
            title: s.title,
            cwd: s.cwd,
          });
          if (sessionItems.length === 0) empty++;
          else items.push(...sessionItems);
        } catch {
          parseErrors++;
        }
      }

      if (probeOnly) {
        return {
          would_import: items.length,
          empty_sessions: empty,
          parse_errors: parseErrors,
          total_sessions: probe.sessions.length,
          scanned_roots: probe.scannedRoots,
          namespace: ns,
          probe_only: true,
        };
      }

      let droppedByPlugin = 0;
      const filtered: SaveMemoryInput[] = [];
      for (const it of items) {
        const transformed = await runBeforeSave(it, registry);
        if (transformed === null) droppedByPlugin++;
        else filtered.push(transformed);
      }
      const result = await provider.bulkSave(filtered);
      return {
        ...result,
        namespace: ns,
        imported_sessions: items.length,
        empty_sessions: empty,
        parse_errors: parseErrors,
        dropped_by_plugin: droppedByPlugin,
        total_sessions: probe.sessions.length,
        scanned_roots: probe.scannedRoots,
      };
    }

    // ── Procedural memory tools ────────────────────────────────────────
    // All four delegate to RemoteProvider methods (defined in remote.ts).
    // Local SQLite has procedural support too but a different shape; the
    // bridging is left for a follow-up. If the user is on a local-only
    // setup, these tools error gracefully with a clear message.
    case 'procedural_match': {
      const trigger = String(args.trigger ?? '');
      if (!trigger) throw new Error('trigger is required');
      const limit = Math.min(25, Math.max(1, (args.limit as number) ?? 5));
      const match = (provider as any).proceduralMatch;
      if (typeof match !== 'function') {
        throw new Error(
          'procedural_match is only supported on hosted mode. ' +
            'Set MNUERON_API_URL + MNUERON_API_TOKEN to enable.',
        );
      }
      const runbooks = await match.call(provider, trigger, limit);
      return { trigger, count: runbooks.length, runbooks };
    }
    case 'procedural_list': {
      const limit = Math.min(200, Math.max(1, (args.limit as number) ?? 50));
      const list = (provider as any).proceduralList;
      if (typeof list !== 'function') {
        throw new Error('procedural_list is only supported on hosted mode.');
      }
      const runbooks = await list.call(provider, limit);
      return { count: runbooks.length, runbooks };
    }
    case 'procedural_get': {
      const id = String(args.id ?? '');
      if (!id) throw new Error('id is required');
      const get = (provider as any).proceduralGet;
      if (typeof get !== 'function') {
        throw new Error('procedural_get is only supported on hosted mode.');
      }
      const runbook = await get.call(provider, id);
      if (!runbook) throw new Error(`runbook not found: ${id}`);
      return runbook;
    }
    case 'procedural_record_outcome': {
      const id = String(args.id ?? '');
      const outcome = String(args.outcome ?? '');
      if (!id) throw new Error('id is required');
      if (outcome !== 'success' && outcome !== 'failure') {
        throw new Error('outcome must be "success" or "failure"');
      }
      const record = (provider as any).proceduralRecordOutcome;
      if (typeof record !== 'function') {
        throw new Error(
          'procedural_record_outcome is only supported on hosted mode.',
        );
      }
      const updated = await record.call(provider, id, outcome);
      if (!updated) throw new Error(`runbook not found: ${id}`);
      return updated;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function sniffFormat(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  const head = (await readFile(path, 'utf8')).slice(0, 4000);
  if (head.includes('"chat_messages"')) return 'claude';
  if (head.includes('"mapping"')) return 'openai';
  return 'claude';
}
