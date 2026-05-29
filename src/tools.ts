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
  {
    name: 'import_file',
    description:
      'Import a large local document (Markdown, text, logs, notes, dumps) into memory as small overlapping searchable chunks, instead of loading the whole file into context. Use this when a file is too big to read directly or would bloat the context window / make the client sluggish: it reads the file, splits it into ~chunk_size-char pieces (linked by parent_ref="file:<path>"), and saves each as its own memory. Afterwards, recall only the relevant pieces with memory_recall rather than re-reading the file. Note: local re-import appends a fresh set of chunks (no upsert by source_ref); the hosted backend upserts.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file to import.' },
        namespace: { type: 'string', description: 'Target namespace (default "default").' },
        chunk_size: { type: 'number', description: 'Max characters per chunk (default 1200).' },
        overlap: { type: 'number', description: 'Overlap in characters between consecutive chunks (default 150).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Extra tags to attach to every chunk.' },
      },
      required: ['path'],
    },
  },
  // ─── Procedural memory (runbooks) ──────────────────────────────────────
  // Procedural memory stores how-to runbooks: title + trigger phrases + step
  // list. Use these tools when the user asks how to do a recurring task and
  // memory_recall doesn't already surface a runbook automatically.
  {
    name: 'procedural_save',
    description:
      'Create a saved runbook/procedural memory. Use this when the user says "save to runbook", "save as a runbook", ' +
      '"save to Mnueron Runbook", or confirms a runbook_suggest proposal. In hosted mode this creates the same record ' +
      'shown in the Mnueron dashboard Runbooks UI. In local mode it writes to the local procedural memory store.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Short title for the runbook, e.g. "Kill Claude Desktop before clearing caches on Windows".',
        },
        summary: {
          type: 'string',
          description: 'Optional one-line summary of what the runbook does.',
        },
        trigger_phrases: {
          type: 'array',
          items: { type: 'string' },
          description: 'Phrases that should recall this runbook later.',
        },
        steps: {
          type: 'array',
          description: 'Ordered runbook steps.',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string', description: 'What this step does.' },
              command: { type: 'string', description: 'Optional shell command.' },
              check: { type: 'string', description: 'Optional verification check.' },
              notes: { type: 'string', description: 'Optional notes or caveats.' },
            },
            required: ['description'],
          },
        },
        namespace: {
          type: 'string',
          description: 'Local-mode namespace. Hosted dashboard runbooks are org-scoped and ignore this.',
        },
        metadata: {
          type: 'object',
          description: 'Optional hosted metadata.',
        },
      },
      required: ['title', 'steps'],
    },
  },
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
  {
    name: 'recall_assist',
    description:
      'Contextual recall — given what the user is currently writing or discussing, search mnueron memory for HIGHLY RELEVANT past context. ' +
      "Use this PROACTIVELY whenever the user describes a task they're working on, an error they're hitting, or a decision they're making — " +
      'before answering from your general knowledge, check if mnueron has prior context. ' +
      'Returns at most 3 suggestions, each with a confidence score. ONLY surface suggestions with confidence ≥ 0.75 by default. ' +
      'Each suggestion is either a memory snippet or a runbook. Pass the user\'s active text + optional cwd; the tool classifies intent (coding / deploying / debugging / testing / documenting / planning / temporal), extracts entities, and searches the matching namespace. ' +
      'Returns empty when nothing crosses the threshold — silence is correct behavior; do not fabricate results.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description:
            "The user's active context — what they're currently writing, asking, or working on. " +
            'Typically the last few sentences of the conversation or the active editor selection.',
        },
        cwd: {
          type: 'string',
          description:
            "The user's current working directory (if known) — helps detect the project namespace.",
        },
        project: {
          type: 'string',
          description:
            'Explicit project name override. Use when the cwd-based inference would be wrong.',
        },
        namespace_hints: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Additional namespaces to prefer in the search (beyond auto-inferred repo:/project:).',
        },
        confidence_threshold: {
          type: 'number',
          description:
            'Minimum confidence to surface a suggestion. Default 0.75 (conservative). Lower to 0.5 only if user asks "show me anything".',
        },
        max_suggestions: {
          type: 'number',
          description: 'Maximum suggestions to return. Default 3.',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'runbook_suggest',
    description:
      'Detect whether the user is currently DESCRIBING repeatable steps that could become a saved runbook. ' +
      'Use after the user has finished explaining a multi-step procedure (deployment, setup, troubleshooting, etc.). ' +
      'Returns whether the content looks runbook-shaped, a confidence score, the detected steps, and a suggested title. ' +
      'If confidence ≥ 0.75, offer the user: "Save as a runbook?" — and on yes, call procedural_save with the extracted steps. ' +
      'Do NOT call this on every message; only when the user has clearly described a sequence.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The full conversation context or document section containing the candidate runbook.',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'suggestion_outcome',
    description:
      'Record what happened with a suggestion that was previously returned. Use this AFTER the user has acted on (or ignored) a suggestion from recall_assist or runbook_suggest. ' +
      "Drives the feedback loop that auto-tunes confidence thresholds — every recorded outcome trains mnueron to surface BETTER suggestions next time. " +
      'Always record outcomes when you can — it costs nothing and improves the system.',
    inputSchema: {
      type: 'object',
      properties: {
        source_text: {
          type: 'string',
          description: "The active context that triggered the suggestion (the same text you passed to recall_assist).",
        },
        intent_kind: {
          type: 'string',
          description: 'The intent classified by recall_assist.',
        },
        action: {
          type: 'string',
          enum: ['accepted', 'ignored', 'saved_runbook', 'opened', 'shown'],
          description:
            'What happened: accepted = user used the suggestion; ignored = dismissed; saved_runbook = converted into a saved runbook; opened = clicked through to view; shown = displayed but no follow-up yet.',
        },
        surface: {
          type: 'string',
          enum: ['mcp', 'dashboard', 'vscode', 'chrome', 'cowork', 'cli'],
          description: 'Which surface displayed the suggestion.',
        },
        acted_on_id: {
          type: 'string',
          description: 'The specific suggestion id the user acted on (for accepted / opened / saved_runbook actions).',
        },
      },
      required: ['source_text', 'action', 'surface'],
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
    case 'import_file': {
      const { planDocImport } = await import('./import/file.js');
      const path = String(args.path ?? '');
      if (!path) throw new Error('path is required');
      const ns = (args.namespace as string) ?? defaultNamespace;
      const chunkSize = typeof args.chunk_size === 'number'
        ? Math.max(1, Math.floor(args.chunk_size)) : undefined;
      const overlap = typeof args.overlap === 'number'
        ? Math.max(0, Math.floor(args.overlap)) : undefined;
      const extraTags = Array.isArray(args.tags)
        ? (args.tags as unknown[]).map(String) : [];

      const plan = await planDocImport(path, { namespace: ns, chunkSize, overlap, tags: extraTags });
      if (plan.chunkCount === 0) {
        return {
          saved: 0, errors: 0, namespace: ns, title: plan.title,
          chunk_count: 0, size_bytes: plan.sizeBytes, dropped_by_plugin: 0,
          note: 'File is empty — nothing imported.',
        };
      }

      let droppedByPlugin = 0;
      const filtered: SaveMemoryInput[] = [];
      for (const it of plan.items) {
        const transformed = await runBeforeSave(it, registry);
        if (transformed === null) droppedByPlugin++;
        else filtered.push(transformed);
      }
      const result = await provider.bulkSave(filtered);
      return {
        ...result,
        namespace: ns,
        title: plan.title,
        source_path: plan.filePath,
        chunk_count: plan.chunkCount,
        chunk_size: plan.chunkSize,
        overlap: plan.overlap,
        size_bytes: plan.sizeBytes,
        dropped_by_plugin: droppedByPlugin,
      };
    }

    // ── Procedural memory tools ────────────────────────────────────────
    // Hosted procedural tools delegate to RemoteProvider methods
    // (defined in remote.ts). procedural_save also bridges to local SQLite
    // so "save to runbook" stays local-first when no hosted token is set.
    case 'procedural_save': {
      const title = String(args.title ?? '').trim();
      if (!title) throw new Error('title is required');

      const rawSteps = Array.isArray(args.steps) ? args.steps : [];
      const steps = rawSteps
        .map((s) => {
          const step = (s ?? {}) as Record<string, unknown>;
          return {
            description: String(step.description ?? '').trim(),
            command: typeof step.command === 'string' && step.command.trim() ? step.command.trim() : undefined,
            check: typeof step.check === 'string' && step.check.trim() ? step.check.trim() : undefined,
            notes: typeof step.notes === 'string' && step.notes.trim() ? step.notes.trim() : undefined,
          };
        })
        .filter((s) => s.description);
      if (steps.length === 0) throw new Error('at least one step with description is required');

      const triggerPhrases = Array.isArray(args.trigger_phrases)
        ? (args.trigger_phrases as unknown[])
            .map((t) => (typeof t === 'string' ? t.trim() : ''))
            .filter(Boolean)
        : [];
      const summary = typeof args.summary === 'string' ? args.summary.trim() : '';

      const hostedSave = (provider as any).proceduralSave;
      if (typeof hostedSave === 'function') {
        return await hostedSave.call(provider, {
          title,
          summary: summary || null,
          trigger_phrases: triggerPhrases,
          steps,
          metadata: typeof args.metadata === 'object' && args.metadata !== null
            ? args.metadata as Record<string, unknown>
            : {},
        });
      }

      const localSave = provider.saveProcedural;
      if (typeof localSave !== 'function') {
        throw new Error('procedural_save is not supported by this provider.');
      }
      const saved = await localSave.call(provider, {
        name: title,
        namespace: (args.namespace as string) ?? defaultNamespace,
        summary,
        steps: steps.map((s) => ({
          step: s.description,
          code: s.command,
          why: [s.check ? `Check: ${s.check}` : '', s.notes ?? ''].filter(Boolean).join('\n') || undefined,
        })),
        tools: triggerPhrases,
      });
      return {
        ...saved,
        trigger_phrases: triggerPhrases,
        note: 'Saved to local procedural memory. Hosted dashboard Runbooks UI shows hosted runbooks only.',
      };
    }
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

    // ─── Recall Assist (Phase 1) ──────────────────────────────────────
    case 'recall_assist': {
      const { analyzeContext, gateSurfacing, DEFAULT_CONFIG } = await import(
        './lib/context-engine/index.js'
      );
      const text = String(args.text ?? '');
      if (!text.trim()) {
        return {
          intent: { kind: 'none', confidence: 0, signals: [] },
          suggestions: [],
          fallback: 'No active context provided.',
        };
      }
      const cwd = typeof args.cwd === 'string' ? args.cwd : undefined;
      const project = typeof args.project === 'string' ? args.project : undefined;
      const namespaceHints = Array.isArray(args.namespace_hints)
        ? (args.namespace_hints as string[])
        : [];
      const threshold = typeof args.confidence_threshold === 'number'
        ? Math.max(0, Math.min(1, args.confidence_threshold))
        : DEFAULT_CONFIG.threshold;
      const maxSuggestions = typeof args.max_suggestions === 'number'
        ? Math.max(1, Math.min(10, args.max_suggestions))
        : DEFAULT_CONFIG.maxSuggestions;

      const signal = analyzeContext(text, { cwd, project, namespaceHints });
      if (!signal.worthSearching) {
        return {
          intent: signal.intent,
          entities: signal.entities,
          suggestions: [],
          fallback: 'Context too thin to search confidently.',
        };
      }

      // Search each namespace hint in priority order, stopping when we
      // have enough candidates above the floor.
      const candidates: Array<{
        id: string;
        kind: 'memory' | 'runbook';
        rawScore: number;
        content: string;
        namespace?: string;
        verified?: boolean;
        successCount?: number;
        failureCount?: number;
      }> = [];
      const seenIds = new Set<string>();
      const searchQuery = text.slice(0, 1000);
      for (const ns of signal.namespaceHints) {
        if (candidates.length >= maxSuggestions * 5) break;
        try {
          const results = await provider.search({
            query: searchQuery,
            namespace: ns,
            k: maxSuggestions * 3,
          });
          for (const r of results) {
            if (seenIds.has(r.id)) continue;
            seenIds.add(r.id);
            candidates.push({
              id: r.id,
              kind: 'memory',
              rawScore: typeof (r as any).score === 'number' ? (r as any).score : 0.5,
              content: r.content.slice(0, 500),
              namespace: r.namespace,
            });
          }
        } catch {
          // Namespace doesn't exist — fine, just skip.
        }
      }

      const surfaced = gateSurfacing(
        candidates,
        signal.intent,
        signal.entities,
        signal.runbookDetection,
        { ...DEFAULT_CONFIG, threshold, maxSuggestions },
      );

      return {
        intent: signal.intent,
        entities: {
          project: signal.entities.project,
          files: signal.entities.files,
          technologies: signal.entities.technologies,
          tags: signal.entities.tags,
        },
        namespaceHints: signal.namespaceHints,
        suggestions: surfaced.map(s => ({
          id: s.id,
          kind: s.kind,
          content: s.content,
          confidence: Number(s.confidence.toFixed(3)),
          reason: s.reason,
          namespace: s.namespace,
        })),
        ...(surfaced.length === 0 && {
          fallback: 'No candidates crossed the confidence threshold. Try again with more context or lower confidence_threshold.',
        }),
      };
    }

    case 'runbook_suggest': {
      const { detectRunbook } = await import('./lib/context-engine/runbook-detector.js');
      const text = String(args.text ?? '');
      if (!text.trim() || text.length < 30) {
        return {
          is_runbook_candidate: false,
          confidence: 0,
          detected_steps: [],
          suggested_title: null,
          signals: [],
        };
      }
      const det = detectRunbook(text);
      return {
        is_runbook_candidate: det.isRunbook,
        confidence: Number(det.confidence.toFixed(3)),
        detected_steps: det.steps,
        suggested_title: det.suggestedTitle,
        signals: det.signals,
      };
    }

    case 'suggestion_outcome': {
      // Local-only no-op: the local provider doesn't have a
      // suggestion_outcomes table (that's hosted-only). We still accept
      // the call so MCP clients can use the same shape in both modes —
      // hosted records, local silently swallows. Future: write to a
      // local SQLite suggestion_outcomes table for fully-local analytics.
      const record = (provider as any).recordSuggestionOutcome;
      if (typeof record !== 'function') {
        return {
          ok: true,
          recorded: false,
          note: 'suggestion_outcome currently only persisted in hosted mode',
        };
      }
      await record.call(provider, {
        source_text: String(args.source_text ?? '').slice(0, 4000),
        intent_kind: typeof args.intent_kind === 'string' ? args.intent_kind : null,
        action: String(args.action ?? 'shown'),
        surface: String(args.surface ?? 'mcp'),
        acted_on_id: typeof args.acted_on_id === 'string' ? args.acted_on_id : null,
      });
      return { ok: true, recorded: true };
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
