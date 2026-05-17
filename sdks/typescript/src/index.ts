/**
 * @mnueron/sdk — TypeScript client for the mnueron memory backend.
 *
 * Wraps the hosted HTTP API at https://www.mnueron.com. Get a bearer
 * token from /account-settings/tokens after signing up.
 *
 *   npm install @mnueron/sdk
 *
 *   import { Mnueron } from '@mnueron/sdk';
 *   const m = new Mnueron({ apiKey: 'mnu_...' });
 *   const mem = await m.save('User prefers concise replies', { namespace: 'my-app' });
 *   const hits = await m.search('how does the user like responses?', { namespace: 'my-app' });
 *
 * Endpoint coverage (v0.3.x):
 *   - save / search / list / get / update / delete
 *   - bulkSearch (multi-query in one HTTP round-trip)
 *   - date-range + metadata containment filters
 *   - namespaces / health
 *   - webhooks: list / create / get / update / delete
 *   - verifyWebhookSignature() — constant-time HMAC-SHA256 check
 */

// ── Types ─────────────────────────────────────────────────────────────────

/** A single memory row returned by /api/memories. */
export interface Memory {
  id: string;
  namespace: string;
  content: string;
  tags: string[];
  source: string;
  source_ref?: string | null;
  metadata?: Record<string, unknown> | null;
  score?: number | null;
  created_at?: number | null;
  updated_at?: number | null;
}

export interface Namespace {
  name: string;
  count: number;
  last_updated: number;
}

/** One row from a bulk-search response: a query + its top-k hits. */
export interface BulkSearchResult {
  query: string;
  hits: Memory[];
}

/** Webhook subscription. `secret` is only set in the response of create(). */
export interface WebhookEndpoint {
  id: string;
  url: string;
  events: string[];
  description?: string | null;
  enabled: boolean;
  secret?: string;
  consecutive_failures?: number;
  last_success_at?: number | null;
  last_failure_at?: number | null;
  created_at?: number;
  updated_at?: number;
}

export type WebhookEvent =
  | 'memory.saved'
  | 'memory.updated'
  | 'memory.deleted'
  | 'summary.created';

export interface SaveOptions {
  namespace?: string;
  tags?: string[];
  source?: string;
  source_ref?: string;
  metadata?: Record<string, unknown>;
}

export interface QueryOptions {
  namespace?: string;
  k?: number;
  created_after?: number;
  created_before?: number;
  updated_after?: number;
  updated_before?: number;
  metadata_filter?: Record<string, unknown>;
}

export interface ListOptions extends QueryOptions {
  limit?: number;
  offset?: number;
}

export interface UpdateInput {
  content?: string;
  tags?: string[];
  namespace?: string;
  metadata?: Record<string, unknown>;
}

export interface BulkSearchOptions {
  namespace?: string;
  k?: number;
  created_after?: number;
  created_before?: number;
  metadata_filter?: Record<string, unknown>;
}

export interface CreateWebhookInput {
  events?: WebhookEvent[];
  description?: string;
}

export interface UpdateWebhookInput {
  url?: string;
  events?: WebhookEvent[];
  enabled?: boolean;
  description?: string;
}

export interface MnueronClientOptions {
  /** Bearer token. Falls back to MNUERON_API_KEY env var. */
  apiKey?: string;
  /** Defaults to https://www.mnueron.com. Falls back to MNUERON_API_URL env. */
  baseUrl?: string;
  /** Optional pre-bound fetch (e.g. node-fetch or undici). Defaults to global `fetch`. */
  fetch?: typeof fetch;
  /** Per-request timeout in ms. Default 10_000. */
  timeoutMs?: number;
}

export const DEFAULT_BASE = 'https://www.mnueron.com';

/** Raised when the API returns a non-2xx response. */
export class MnueronError extends Error {
  public readonly status: number;
  constructor(status: number, message: string) {
    super(`mnueron API ${status}: ${message}`);
    this.name = 'MnueronError';
    this.status = status;
  }
}

// ── Client ────────────────────────────────────────────────────────────────

/**
 * Synchronous-feeling promise-based client. One method per HTTP endpoint.
 * Throws {@link MnueronError} on non-2xx responses; returns parsed JSON
 * otherwise.
 */
export class Mnueron {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: MnueronClientOptions = {}) {
    const apiKey =
      opts.apiKey ??
      (typeof process !== 'undefined'
        ? process.env?.MNUERON_API_KEY ?? process.env?.MNUERON_API_TOKEN
        : undefined);
    if (!apiKey) {
      throw new MnueronError(0, 'apiKey required (or set MNUERON_API_KEY)');
    }
    const base =
      opts.baseUrl ??
      (typeof process !== 'undefined' ? process.env?.MNUERON_API_URL : undefined) ??
      DEFAULT_BASE;
    this.baseUrl = base.replace(/\/$/, '');
    this.headers = {
      Authorization: `Bearer ${apiKey}`,
      'User-Agent': 'mnueron-typescript/0.3.1',
      'Content-Type': 'application/json',
    };
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  // ── memories ────────────────────────────────────────────────────────────

  /** Insert a new memory. Triggers backend redaction + (optional) fact extraction. */
  async save(content: string, opts: SaveOptions = {}): Promise<Memory> {
    const body = {
      content,
      namespace: opts.namespace ?? 'default',
      tags: opts.tags ?? [],
      source: opts.source ?? 'sdk',
      ...(opts.source_ref !== undefined ? { source_ref: opts.source_ref } : {}),
      ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}),
    };
    return this.json<Memory>('POST', '/api/memories', body);
  }

  /** BM25 search via GET /api/memories?q=… with optional date / metadata filters. */
  async search(query: string, opts: QueryOptions = {}): Promise<Memory[]> {
    const qs = this.buildListQuery({ q: query, limit: opts.k ?? 10, offset: 0, ...opts });
    return this.json<Memory[]>('GET', `/api/memories?${qs}`);
  }

  /** Multi-query search in one HTTP round-trip. Max 25 queries. */
  async bulkSearch(
    queries: string[],
    opts: BulkSearchOptions = {},
  ): Promise<BulkSearchResult[]> {
    const body: Record<string, unknown> = { queries, k: opts.k ?? 5 };
    if (opts.namespace) body.namespace = opts.namespace;
    if (opts.created_after !== undefined) body.created_after = opts.created_after;
    if (opts.created_before !== undefined) body.created_before = opts.created_before;
    if (opts.metadata_filter) body.metadata_filter = opts.metadata_filter;
    const payload = await this.json<{ results?: BulkSearchResult[] }>(
      'POST',
      '/api/memories/search/bulk',
      body,
    );
    return payload.results ?? [];
  }

  /** Newest-first list with optional date + metadata filters. */
  async list(opts: ListOptions = {}): Promise<Memory[]> {
    const qs = this.buildListQuery({
      limit: opts.limit ?? 50,
      offset: opts.offset ?? 0,
      ...opts,
    });
    return this.json<Memory[]>('GET', `/api/memories?${qs}`);
  }

  /** Fetch a single memory by id. Returns null on 404. */
  async get(id: string): Promise<Memory | null> {
    const resp = await this.request('GET', `/api/memories/${encodeURIComponent(id)}`);
    if (resp.status === 404) return null;
    return this.consume<Memory>(resp);
  }

  /**
   * Partial update. `metadata` is MERGED into the existing keys; pass
   * `{ key: null }` to remove a metadata key.
   */
  async update(id: string, patch: UpdateInput): Promise<Memory> {
    if (
      patch.content === undefined &&
      patch.tags === undefined &&
      patch.namespace === undefined &&
      patch.metadata === undefined
    ) {
      throw new MnueronError(0, 'update() requires at least one field');
    }
    return this.json<Memory>('PATCH', `/api/memories/${encodeURIComponent(id)}`, patch);
  }

  async delete(id: string): Promise<void> {
    const resp = await this.request('DELETE', `/api/memories/${encodeURIComponent(id)}`);
    if (!resp.ok) throw new MnueronError(resp.status, await readErr(resp));
  }

  // ── namespaces / health ─────────────────────────────────────────────────

  async namespaces(): Promise<Namespace[]> {
    return this.json<Namespace[]>('GET', '/api/namespaces');
  }

  /** Liveness probe — returns true iff the backend reports `{ ok: true }`. */
  async health(): Promise<boolean> {
    const resp = await this.request('GET', '/api/health');
    if (!resp.ok) return false;
    try {
      const body = (await resp.json()) as { ok?: boolean };
      return !!body.ok;
    } catch {
      return false;
    }
  }

  // ── webhooks (v0.3.1) ───────────────────────────────────────────────────

  async listWebhooks(): Promise<WebhookEndpoint[]> {
    const payload = await this.json<{ endpoints?: WebhookEndpoint[] }>('GET', '/api/webhooks');
    return payload.endpoints ?? [];
  }

  /**
   * Register a webhook endpoint. The returned object includes `secret`,
   * which is exposed exactly once — record it before the call returns.
   */
  async createWebhook(url: string, opts: CreateWebhookInput = {}): Promise<WebhookEndpoint> {
    const body: Record<string, unknown> = { url };
    if (opts.events) body.events = opts.events;
    if (opts.description) body.description = opts.description;
    return this.json<WebhookEndpoint>('POST', '/api/webhooks', body);
  }

  async getWebhook(id: string): Promise<WebhookEndpoint | null> {
    const resp = await this.request('GET', `/api/webhooks/${encodeURIComponent(id)}`);
    if (resp.status === 404) return null;
    return this.consume<WebhookEndpoint>(resp);
  }

  async updateWebhook(id: string, patch: UpdateWebhookInput): Promise<void> {
    if (
      patch.url === undefined &&
      patch.events === undefined &&
      patch.enabled === undefined &&
      patch.description === undefined
    ) {
      throw new MnueronError(0, 'updateWebhook() requires at least one field');
    }
    await this.json<unknown>('PUT', `/api/webhooks/${encodeURIComponent(id)}`, patch);
  }

  async deleteWebhook(id: string): Promise<void> {
    const resp = await this.request('DELETE', `/api/webhooks/${encodeURIComponent(id)}`);
    if (!resp.ok) throw new MnueronError(resp.status, await readErr(resp));
  }

  // ── internals ───────────────────────────────────────────────────────────

  private buildListQuery(opts: {
    q?: string;
    namespace?: string;
    limit: number;
    offset: number;
    created_after?: number;
    created_before?: number;
    updated_after?: number;
    updated_before?: number;
    metadata_filter?: Record<string, unknown>;
  }): string {
    const parts: string[] = [`limit=${opts.limit}`, `offset=${opts.offset}`];
    if (opts.q) parts.push(`q=${encodeURIComponent(opts.q)}`);
    if (opts.namespace) parts.push(`namespace=${encodeURIComponent(opts.namespace)}`);
    if (opts.created_after !== undefined) parts.push(`created_after=${opts.created_after}`);
    if (opts.created_before !== undefined) parts.push(`created_before=${opts.created_before}`);
    if (opts.updated_after !== undefined) parts.push(`updated_after=${opts.updated_after}`);
    if (opts.updated_before !== undefined) parts.push(`updated_before=${opts.updated_before}`);
    if (opts.metadata_filter) {
      parts.push(
        `metadata_filter=${encodeURIComponent(JSON.stringify(opts.metadata_filter))}`,
      );
    }
    return parts.join('&');
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Send a request and parse JSON. Throws on non-2xx. */
  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const resp = await this.request(method, path, body);
    return this.consume<T>(resp);
  }

  private async consume<T>(resp: Response): Promise<T> {
    if (!resp.ok) throw new MnueronError(resp.status, await readErr(resp));
    if (resp.status === 204) return undefined as unknown as T;
    return (await resp.json()) as T;
  }
}

async function readErr(resp: Response): Promise<string> {
  try {
    const text = await resp.text();
    try {
      const body = JSON.parse(text) as { error?: string };
      if (typeof body.error === 'string') return body.error;
    } catch {
      /* not json */
    }
    return text || resp.statusText;
  } catch {
    return resp.statusText;
  }
}

// ── Webhook signature verification ─────────────────────────────────────────

/**
 * Constant-time verification of an incoming mnueron webhook delivery.
 *
 * mnueron signs each delivery with HMAC-SHA256 over the raw request body
 * and sends the hex digest in the `X-Mnueron-Signature` header prefixed
 * with `sha256=`. Use this helper from your webhook handler:
 *
 * ```ts
 * import { verifyWebhookSignature } from '@mnueron/sdk';
 *
 * if (!await verifyWebhookSignature(secret, rawBody, req.headers['x-mnueron-signature']!)) {
 *   res.status(401).send('invalid signature');
 *   return;
 * }
 * ```
 *
 * Uses Node's `node:crypto` if available; falls back to Web Crypto
 * (browser / Workers / Deno / Bun).
 */
export async function verifyWebhookSignature(
  secret: string,
  body: Uint8Array | string,
  signatureHeader: string | undefined | null,
): Promise<boolean> {
  if (!signatureHeader) return false;
  const expected = await computeHmacHex(secret, body);
  const got = signatureHeader.trim();
  return timingSafeEqualHex(`sha256=${expected}`, got);
}

async function computeHmacHex(secret: string, body: Uint8Array | string): Promise<string> {
  const bodyBytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  // Try Node first
  try {
    const nodeCrypto = await import('node:crypto');
    return nodeCrypto
      .createHmac('sha256', secret)
      .update(Buffer.from(bodyBytes))
      .digest('hex');
  } catch {
    // Fall through to Web Crypto
  }
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (!subtle) {
    throw new MnueronError(0, 'no HMAC implementation available (need node:crypto or Web Crypto)');
  }
  const key = await subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await subtle.sign('HMAC', key, bodyBytes);
  return bufferToHex(new Uint8Array(sig));
}

function bufferToHex(buf: Uint8Array): string {
  let s = '';
  for (let i = 0; i < buf.length; i++) s += buf[i]!.toString(16).padStart(2, '0');
  return s;
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
