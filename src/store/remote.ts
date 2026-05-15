import type {
  Provider, Memory, SaveMemoryInput, SearchInput, ListInput, NamespaceInfo,
} from './provider.js';

/**
 * Remote HTTP provider — talks to the hosted multi-tenant backend.
 * Multi-company isolation happens server-side via the token → org_id binding.
 * The MCP client doesn't need to know which org it's hitting; the token decides.
 */
export class RemoteProvider implements Provider {
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
        'User-Agent': 'mnueron-mcp/0.1',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`mnueron API ${res.status} ${method} ${path}: ${text}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  save(input: SaveMemoryInput) {
    return this.req<Memory>('POST', '/v1/memories', input);
  }

  bulkSave(inputs: SaveMemoryInput[]) {
    return this.req<{ saved: number; errors: number }>(
      'POST', '/v1/memories/bulk', { items: inputs },
    );
  }

  search(input: SearchInput) {
    return this.req<Memory[]>('POST', '/v1/memories/search', input);
  }

  list(input: ListInput) {
    const params = new URLSearchParams();
    if (input.namespace) params.set('namespace', input.namespace);
    if (input.limit) params.set('limit', String(input.limit));
    if (input.before) params.set('before', String(input.before));
    return this.req<Memory[]>('GET', `/v1/memories?${params}`);
  }

  get(id: string) {
    return this.req<Memory | null>('GET', `/v1/memories/${id}`);
  }

  async delete(id: string) {
    await this.req<void>('DELETE', `/v1/memories/${id}`);
    return true;
  }

  namespaces() {
    return this.req<NamespaceInfo[]>('GET', '/v1/namespaces');
  }

  async close() { /* no-op for HTTP */ }
}
