import type {
  Provider, Memory, SaveMemoryInput, SearchInput, ListInput, NamespaceInfo,
} from './provider.js';
import { chunkContent } from './chunking.js';
import { randomUUID } from 'node:crypto';

/**
 * The hosted backend is the Next.js app under `ai-boilerplate-pro`. Its API
 * surface looks like:
 *
 *   POST   /api/memories                   - save one
 *   GET    /api/memories?q=... [&ns=...]   - search (BM25)
 *   GET    /api/memories?namespace=...     - list
 *   GET    /api/memories/<id>              - fetch one
 *   PATCH  /api/memories/<id>              - partial update
 *   DELETE /api/memories/<id>              - remove
 *   POST   /api/memories/search/bulk       - multi-query search
 *   GET    /api/threads/<ref>              - all chunks of a thread
 *   GET    /api/namespaces                 - namespace + counts
 *   GET    /api/health                     - health probe
 *
 * Notable hosted-side constraints (mirrored on the client so we don't
 * burn round-trips discovering them):
 *
 *   1. No bulk-save endpoint. Every memory must POST /api/memories
 *      individually. We fan out with a small concurrency window.
 *   2. 256KB per-memory content cap. Anything larger is 413'd. We
 *      pre-chunk via chunkContent() so each item fits.
 *   3. 60 writes/min/token rate limit. A naive fan-out of hundreds of
 *      chunks will trip it; we throttle to ~1 write/sec and respect
 *      Retry-After on 429s.
 *   4. Vercel ~4.5MB body limit. Single posts well under the 256KB cap
 *      stay comfortably below this.
 *
 * The /v1/* paths in older versions of this provider pointed at the
 * unshipped standalone server in server/index.ts. If that ever deploys,
 * give it its own provider class rather than overloading this one.
 */

const HOSTED_PER_MEMORY_CHAR_CAP = 256 * 1024;
const CHUNK_SOFT_TARGET = 4000;
const SAVE_CONCURRENCY = 2;
const MIN_WRITE_INTERVAL_MS = 1100;
const SAVE_MAX_RETRIES = 4;

/**
 * A bare Postgres uuid. Anything else — e.g. a thread key like
 * "cowork:<sessionId>" or "chunked:<uuid>" — is NOT a memory id and must be
 * treated as a parent_ref/source_ref when resolving a thread.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function detectRemoteClient(): string {
  const explicit = process.env.MNUERON_CLIENT;
  if (explicit && explicit.trim().length > 0) return explicit.trim().toLowerCase();
  if (process.env.CURSOR_TRACE_ID || process.env.CURSOR_USER) return 'cursor';
  if (process.env.CLAUDE_CODE_SSE_PORT) return 'claude-code';
  if (process.env.CODEX_HOME) return 'openai-codex';
  if (process.env.VSCODE_PID || process.env.VSCODE_INJECTION) {
    return process.env.CLINE_INSTALLED ? 'cline' : 'vscode';
  }
  if (process.env.CODEIUM_API_URL) return 'windsurf';
  return 'mnueron-mcp';
}

interface HttpError extends Error {
  status?: number;
  retryAfterMs?: number;
}

export class RemoteProvider implements Provider {
  private lastWriteAt = 0;

  constructor(
    private baseUrl: string,
    private token: string,
  ) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'mnueron-mcp/0.2',
        'X-Mnueron-Client': detectRemoteClient(),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`mnueron API ${res.status} ${method} ${path}: ${text.slice(0, 500)}`) as HttpError;
      err.status = res.status;
      const ra = res.headers.get('retry-after');
      if (ra) {
        const n = Number(ra);
        if (Number.isFinite(n)) err.retryAfterMs = n * 1000;
      }
      throw err;
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async save(input: SaveMemoryInput): Promise<Memory> {
    const content = input.content ?? '';
    if (content.length > HOSTED_PER_MEMORY_CHAR_CAP || content.length > CHUNK_SOFT_TARGET * 2) {
      await this.bulkSave([input]);
      return {
        id: '',
        namespace: input.namespace,
        content: input.content,
        tags: input.tags ?? [],
        source: input.source ?? 'manual',
        source_ref: input.source_ref ?? null,
        metadata: input.metadata ?? null,
        created_at: Date.now(),
        updated_at: Date.now(),
      } as Memory;
    }
    return this.saveOneThrottled(input);
  }

  async bulkSave(inputs: SaveMemoryInput[]): Promise<{ saved: number; errors: number }> {
    if (inputs.length === 0) return { saved: 0, errors: 0 };

    const expanded: SaveMemoryInput[] = [];
    for (const it of inputs) {
      const chunks = chunkContent(it.content ?? '');
      if (chunks.length <= 1) {
        expanded.push(it);
        continue;
      }
      const parentRef = it.source_ref ?? `chunked:${randomUUID()}`;
      const baseTags = it.tags ?? [];
      const total = chunks.length;
      for (let i = 0; i < total; i++) {
        const c = chunks[i];
        expanded.push({
          content: c.content,
          namespace: it.namespace,
          tags: [...baseTags, 'chunk', ...(c.role ? [`role:${c.role}`] : [])],
          source: it.source ?? 'manual',
          source_ref: parentRef,
          metadata: {
            ...(it.metadata ?? {}),
            parent_ref: parentRef,
            chunk_index: i,
            chunk_count: total,
            ...(c.role ? { role: c.role } : {}),
          },
        });
      }
    }

    let saved = 0;
    let errors = 0;
    let nextIdx = 0;
    const total = expanded.length;

    const worker = async () => {
      while (true) {
        const idx = nextIdx++;
        if (idx >= total) return;
        const item = expanded[idx];
        if (item.content && item.content.length > HOSTED_PER_MEMORY_CHAR_CAP) {
          item.content = item.content.slice(0, HOSTED_PER_MEMORY_CHAR_CAP - 64) + '\n...[truncated]';
        }
        try {
          await this.saveOneThrottled(item);
          saved++;
          if ((saved + errors) % 25 === 0 || saved + errors === total) {
            process.stderr.write(`[mnueron] hosted save progress: ${saved + errors}/${total}\n`);
          }
        } catch (e) {
          errors++;
          const msg = e instanceof Error ? e.message : String(e);
          process.stderr.write(`[mnueron] save failed for chunk ${idx + 1}/${total}: ${msg.slice(0, 200)}\n`);
        }
      }
    };

    const workers = Array.from({ length: Math.min(SAVE_CONCURRENCY, total) }, () => worker());
    await Promise.all(workers);
    return { saved, errors };
  }

  private async saveOneThrottled(input: SaveMemoryInput): Promise<Memory> {
    let attempt = 0;
    while (true) {
      const now = Date.now();
      const earliest = this.lastWriteAt + MIN_WRITE_INTERVAL_MS;
      if (now < earliest) await sleep(earliest - now);
      this.lastWriteAt = Date.now();

      try {
        return await this.req<Memory>('POST', '/api/memories', input);
      } catch (e) {
        const httpErr = e as HttpError;
        const status = httpErr?.status ?? 0;
        const retryable = status === 429 || status >= 500;
        if (!retryable || attempt >= SAVE_MAX_RETRIES) throw e;
        const backoff = httpErr?.retryAfterMs ?? Math.min(30_000, 1000 * Math.pow(2, attempt));
        process.stderr.write(`[mnueron] ${status} - backing off ${backoff}ms (attempt ${attempt + 1}/${SAVE_MAX_RETRIES})\n`);
        await sleep(backoff);
        attempt++;
      }
    }
  }

  async search(input: SearchInput): Promise<Memory[]> {
    const params = new URLSearchParams();
    if (input.query) params.set('q', input.query);
    if (input.namespace) params.set('namespace', input.namespace);
    if (input.k != null) params.set('limit', String(input.k));
    return this.req<Memory[]>('GET', `/api/memories?${params.toString()}`);
  }

  async list(input: ListInput): Promise<Memory[]> {
    const params = new URLSearchParams();
    if (input.namespace) params.set('namespace', input.namespace);
    if (input.limit) params.set('limit', String(input.limit));
    return this.req<Memory[]>('GET', `/api/memories?${params.toString()}`);
  }

  async get(id: string): Promise<Memory | null> {
    try {
      return await this.req<Memory>('GET', `/api/memories/${encodeURIComponent(id)}`);
    } catch (e) {
      if ((e as HttpError)?.status === 404) return null;
      throw e;
    }
  }

  /**
   * Reassemble a chunked thread from the hosted store. Mirrors
   * LocalProvider.findThread so `memory_get_thread` works in hosted mode
   * (previously it threw "only supported in local mode").
   *
   * `idOrRef` may be:
   *   - a thread key (metadata.parent_ref or source_ref, e.g.
   *     "cowork:<sessionId>" or "chunked:<uuid>"), or
   *   - the memory id of any single chunk — we first resolve it to its
   *     parent_ref/source_ref so the WHOLE thread is returned, not just
   *     that one row (matching the local provider's behaviour).
   *
   * Hits GET /api/threads/<ref>, which matches parent_ref OR source_ref and
   * orders chunks by chunk_index.
   */
  async findThread(idOrRef: string): Promise<Memory[]> {
    let ref = idOrRef;

    // A bare uuid might be a child chunk's id. Resolve it to the thread key
    // first; if it's a standalone memory (no parent_ref/source_ref) we fall
    // back to the id itself, and the endpoint returns it as a 1-item thread.
    if (UUID_RE.test(idOrRef)) {
      const mem = await this.get(idOrRef).catch(() => null);
      const meta = (mem?.metadata ?? {}) as Record<string, unknown>;
      const parentRef =
        typeof meta.parent_ref === 'string' ? meta.parent_ref : undefined;
      ref = parentRef ?? mem?.source_ref ?? idOrRef;
    }

    const res = await this.req<{ parent_ref: string; chunks: Memory[] }>(
      'GET',
      `/api/threads/${encodeURIComponent(ref)}`,
    );
    return res.chunks ?? [];
  }

  async delete(id: string): Promise<boolean> {
    try {
      await this.req<void>('DELETE', `/api/memories/${encodeURIComponent(id)}`);
      return true;
    } catch (e) {
      if ((e as HttpError)?.status === 404) return false;
      throw e;
    }
  }

  namespaces(): Promise<NamespaceInfo[]> {
    return this.req<NamespaceInfo[]>('GET', '/api/namespaces');
  }

  // ─── Procedural memory (hosted) ─────────────────────────────────────
  //
  // The hosted backend stores runbooks in a different shape than the
  // local SQLite provider — title vs name, success/failure vs use_count,
  // text[] trigger_phrases vs JSONB schema. These methods talk to the
  // hosted shape; the MCP layer in tools.ts adapts between them and the
  // ProceduralMemoryView local shape if needed.

  /**
   * Create a hosted runbook. This is the write path used by the MCP
   * `procedural_save` tool so agents can push directly into the dashboard
   * Runbooks UI instead of saving a plain memory.
   */
  async proceduralSave(input: {
    title: string;
    summary?: string | null;
    trigger_phrases?: string[];
    steps?: Array<{
      description: string;
      command?: string;
      check?: string;
      notes?: string;
    }>;
    metadata?: Record<string, unknown>;
  }): Promise<HostedProcedural> {
    return await this.req<HostedProcedural>('POST', '/api/procedural', input);
  }

  /**
   * Look up runbooks whose trigger_phrases contain the given phrase
   * (exact text[] match). Used by memory_recall to auto-surface runbooks
   * matching the user's recall query.
   */
  async proceduralMatch(trigger: string, limit = 5): Promise<HostedProcedural[]> {
    const params = new URLSearchParams();
    params.set('trigger', trigger);
    params.set('limit', String(limit));
    const res = await this.req<{ procedurals: HostedProcedural[] }>(
      'GET',
      `/api/procedural?${params.toString()}`,
    );
    return res.procedurals ?? [];
  }

  /**
   * List runbooks (most recently used first). For browsing in MCP tools.
   */
  async proceduralList(limit = 50): Promise<HostedProcedural[]> {
    const res = await this.req<{ procedurals: HostedProcedural[] }>(
      'GET',
      `/api/procedural?limit=${limit}`,
    );
    return res.procedurals ?? [];
  }

  /**
   * Fetch a runbook by id (full step content).
   */
  async proceduralGet(id: string): Promise<HostedProcedural | null> {
    try {
      return await this.req<HostedProcedural>('GET', `/api/procedural/${encodeURIComponent(id)}`);
    } catch (e) {
      if ((e as HttpError)?.status === 404) return null;
      throw e;
    }
  }

  /**
   * Record a runbook outcome — bumps success_count or failure_count and
   * stamps last_used_at. Use after the agent (or human) has actually run
   * the procedure end-to-end.
   */
  async proceduralRecordOutcome(
    id: string,
    outcome: 'success' | 'failure',
  ): Promise<HostedProcedural | null> {
    try {
      return await this.req<HostedProcedural>(
        'POST',
        `/api/procedural/${encodeURIComponent(id)}`,
        { outcome },
      );
    } catch (e) {
      if ((e as HttpError)?.status === 404) return null;
      throw e;
    }
  }

  /**
   * Unified recall — calls /api/recall/unified to get memories AND
   * matching runbooks in one round trip. Used by the memory_recall MCP
   * tool to transparently surface runbooks when a query matches a
   * trigger phrase.
   */
  async unifiedRecall(
    query: string,
    opts: { namespace?: string; limit?: number } = {},
  ): Promise<{ memories: Memory[]; procedurals: HostedProcedural[] }> {
    const params = new URLSearchParams();
    params.set('q', query);
    if (opts.namespace) params.set('namespace', opts.namespace);
    if (opts.limit) params.set('limit', String(opts.limit));
    const res = await this.req<{
      memories: Memory[];
      procedurals: HostedProcedural[];
    }>('GET', `/api/recall/unified?${params.toString()}`);
    return {
      memories: res.memories ?? [],
      procedurals: res.procedurals ?? [],
    };
  }

  /**
   * Set a memory's visibility (private/team/public). When transitioning to
   * 'public', the hosted side generates a fresh 32-byte token. Returns the
   * full visibility row including the URL the agent should share. Used by
   * the memory_share MCP tool.
   */
  async share(
    memoryId: string,
    visibility: 'private' | 'team' | 'public',
  ): Promise<{
    memory_id: string;
    visibility: 'private' | 'team' | 'public';
    public_token: string | null;
    url: string | null;
    updated_at: number | null;
  }> {
    return this.req('PATCH', `/api/memories/${encodeURIComponent(memoryId)}/visibility`, {
      visibility,
    });
  }

  async close(): Promise<void> { /* no-op for HTTP */ }
}

/**
 * Hosted-side runbook shape. Mirrors what /api/procedural returns.
 * Different from ProceduralMemoryView (local) — see provider.ts.
 */
export interface HostedProcedural {
  id: string;
  title: string;
  summary: string | null;
  trigger_phrases: string[];
  steps: Array<{
    description: string;
    command?: string;
    check?: string;
    notes?: string;
  }>;
  success_count: number;
  failure_count: number;
  created_at: number | null;
  updated_at: number | null;
  last_used_at: number | null;
  /** Present only on /api/recall/unified responses. */
  match_kind?: 'trigger' | 'title-fuzzy';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
