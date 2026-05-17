/**
 * Tiny REST client for the mnueron backend. Talks to either the local
 * CLI's dashboard server (127.0.0.1:3122 — no auth) or the hosted
 * backend at mnueron.com (bearer token required).
 *
 * We deliberately do NOT depend on the @mnueron/sdk npm package — the
 * VS Code extension is small and we want zero runtime deps to keep the
 * VSIX tight. The endpoint shapes match exactly, so when @mnueron/sdk
 * ships an npm release we can swap to it via a single import change.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';

export interface Memory {
  id: string;
  namespace: string;
  content: string;
  tags: string[];
  source?: string;
  source_ref?: string | null;
  metadata?: Record<string, unknown> | null;
  score?: number | null;
  created_at?: number | null;
  updated_at?: number | null;
}

export interface ClientConfig {
  baseUrl: string;
  /** Bearer token. Only required in hosted mode. */
  token?: string;
}

export class MnueronClient {
  constructor(private cfg: ClientConfig) {}

  setConfig(cfg: ClientConfig) {
    this.cfg = cfg;
  }

  async health(): Promise<boolean> {
    try {
      const resp = await this.fetch('GET', '/api/health');
      return resp.status === 200;
    } catch {
      return false;
    }
  }

  async save(input: {
    content: string;
    namespace?: string;
    tags?: string[];
    source?: string;
    source_ref?: string;
    metadata?: Record<string, unknown>;
  }): Promise<Memory> {
    const resp = await this.fetch('POST', '/api/memories', {
      content: input.content,
      namespace: input.namespace ?? 'default',
      tags: input.tags ?? [],
      source: input.source ?? 'vscode',
      ...(input.source_ref ? { source_ref: input.source_ref } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
    if (resp.status >= 400) throw new Error(`save failed: ${resp.status} ${resp.body}`);
    return JSON.parse(resp.body) as Memory;
  }

  async search(query: string, opts: { namespace?: string; k?: number } = {}): Promise<Memory[]> {
    const qs = new URLSearchParams();
    qs.set('q', query);
    qs.set('limit', String(opts.k ?? 10));
    if (opts.namespace) qs.set('namespace', opts.namespace);
    const resp = await this.fetch('GET', `/api/memories?${qs.toString()}`);
    if (resp.status >= 400) throw new Error(`search failed: ${resp.status} ${resp.body}`);
    return JSON.parse(resp.body) as Memory[];
  }

  async list(opts: { namespace?: string; limit?: number } = {}): Promise<Memory[]> {
    const qs = new URLSearchParams();
    qs.set('limit', String(opts.limit ?? 25));
    if (opts.namespace) qs.set('namespace', opts.namespace);
    const resp = await this.fetch('GET', `/api/memories?${qs.toString()}`);
    if (resp.status >= 400) throw new Error(`list failed: ${resp.status} ${resp.body}`);
    return JSON.parse(resp.body) as Memory[];
  }

  async get(id: string): Promise<Memory | null> {
    const resp = await this.fetch('GET', `/api/memories/${encodeURIComponent(id)}`);
    if (resp.status === 404) return null;
    if (resp.status >= 400) throw new Error(`get failed: ${resp.status}`);
    return JSON.parse(resp.body) as Memory;
  }

  async namespaces(): Promise<Array<{ name: string; count: number; last_updated: number }>> {
    const resp = await this.fetch('GET', '/api/namespaces');
    if (resp.status >= 400) throw new Error(`namespaces failed: ${resp.status}`);
    return JSON.parse(resp.body);
  }

  // ── internals ──────────────────────────────────────────────────────────

  private fetch(method: string, path: string, body?: unknown): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const url = new URL(this.cfg.baseUrl.replace(/\/$/, '') + path);
      const headers: Record<string, string> = {
        'User-Agent': 'mnueron-vscode/0.1',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };
      if (this.cfg.token) headers.Authorization = `Bearer ${this.cfg.token}`;
      const lib = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = lib(
        {
          method,
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + url.search,
          headers,
        },
        (resp) => {
          let raw = '';
          resp.on('data', (chunk) => (raw += chunk));
          resp.on('end', () => resolve({ status: resp.statusCode ?? 0, body: raw }));
        },
      );
      req.on('error', reject);
      req.setTimeout(10_000, () => {
        req.destroy(new Error('timeout'));
      });
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  }
}
