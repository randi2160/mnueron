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
      'Defaults to top 5 results. Search is hybrid (keyword + semantic), so the query can be a natural-language description.',
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
      const memories = await provider.search({
        query: String(args.query ?? ''),
        namespace: args.namespace as string | undefined,
        k,
        tags: args.tags as string[] | undefined,
      });
      const processed = await runAfterRecall(memories, registry);
      return processed.map(toPreview);
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
