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
 */
import type { Memory, Provider } from './store/provider.js';
import { importClaudeExport } from './import/claude.js';
import { importOpenAIExport } from './import/openai.js';

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
      'Fetch a memory by id. Default returns up to 8000 characters — enough for most chats but small enough to stay context-safe. ' +
      'For long memories, set `max_chars` higher, or use `offset` + `max_chars` to page through. ' +
      'A 320KB chat is normal for backfilled web conversations; you probably want max_chars ~4000 and to use the preview/full_length from memory_recall to decide whether to page.',
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
    name: 'memory_list',
    description:
      'List recent memories. Returns PREVIEWS only — call memory_get(id) for full content. ' +
      'Default limit 20, max 100. Use for browsing a namespace.',
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
      'Import past conversations into memory. Accepts a path to a Claude conversation export (conversations.json from claude.ai data export) or an OpenAI conversations export. Each conversation becomes a memory.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the export file.' },
        format: {
          type: 'string',
          enum: ['claude', 'openai', 'auto'],
          description: 'Source format. "auto" sniffs by file content.',
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
) {
  switch (name) {
    case 'memory_save': {
      return await provider.save({
        content: String(args.content ?? ''),
        namespace: (args.namespace as string) ?? defaultNamespace,
        tags: (args.tags as string[]) ?? [],
        source: (args.source as string) ?? 'agent',
      });
    }
    case 'memory_recall': {
      const k = Math.min(25, Math.max(1, (args.k as number) ?? 5));
      const memories = await provider.search({
        query: String(args.query ?? ''),
        namespace: args.namespace as string | undefined,
        k,
        tags: args.tags as string[] | undefined,
      });
      return memories.map(toPreview);
    }
    case 'memory_get': {
      const id = String(args.id ?? '');
      if (!id) throw new Error('id is required');
      const mem = await provider.get(id);
      if (!mem) throw new Error(`memory not found: ${id}`);
      // Cap content size to keep responses context-friendly. The agent can
      // page via offset + max_chars if it needs more.
      const fullLength = mem.content?.length ?? 0;
      const maxChars = Math.min(100000, Math.max(100, (args.max_chars as number) ?? 8000));
      const offset = Math.max(0, Math.min(fullLength, (args.offset as number) ?? 0));
      const slice = (mem.content ?? '').slice(offset, offset + maxChars);
      const truncated = offset + slice.length < fullLength;
      return {
        ...mem,
        content: slice,
        content_full_length: fullLength,
        content_offset: offset,
        content_returned_chars: slice.length,
        content_truncated: truncated,
        content_next_offset: truncated ? offset + slice.length : null,
      };
    }
    case 'memory_list': {
      const limit = Math.min(100, Math.max(1, (args.limit as number) ?? 20));
      const memories = await provider.list({
        namespace: args.namespace as string | undefined,
        limit,
        before: args.before as number | undefined,
      });
      return memories.map(toPreview);
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
      const result = await provider.bulkSave(items);
      return { ...result, namespace: ns, format };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function sniffFormat(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  const head = (await readFile(path, 'utf8')).slice(0, 4000);
  // Claude export wraps each chat in `{ uuid, name, chat_messages: [...] }`
  // OpenAI export uses `{ id, title, mapping: { ... } }` (tree-shaped)
  if (head.includes('"chat_messages"')) return 'claude';
  if (head.includes('"mapping"')) return 'openai';
  // Fallback to Claude (newer exports may use slightly different keys)
  return 'claude';
}
