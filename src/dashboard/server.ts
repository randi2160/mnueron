/**
 * mnueron dashboard — tiny localhost HTTP server.
 *
 * - Zero new dependencies: uses Node's built-in `http`.
 * - Reads/writes through the same Provider interface the MCP server uses,
 *   so local and hosted modes both work.
 * - Serves a single static HTML page from ../../dashboard/index.html
 *   (path resolves relative to the compiled file in dist/dashboard/server.js).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Provider } from '../store/provider.js';
import { importClaudeExport } from '../import/claude.js';
import { importOpenAIExport } from '../import/openai.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// dist/dashboard/server.js → ../../dashboard
const STATIC_DIR = join(HERE, '..', '..', 'dashboard');

export interface DashboardHandle {
  url: string;
  close: () => Promise<void>;
}

export async function startDashboard(
  provider: Provider,
  port = 3122,
  host = '127.0.0.1',
): Promise<DashboardHandle> {
  const server = createServer(async (req, res) => {
    try {
      await route(provider, req, res);
    } catch (e: any) {
      sendJson(res, 500, { error: e?.message ?? String(e) });
    }
  });
  // Lift Node's default 10-listener cap. Keep-alive connections from the
  // dashboard tab + the extension polling can easily exceed 10 concurrent
  // close-listeners, which is fine — they're cleaned up per-connection.
  server.setMaxListeners(0);

  return new Promise<DashboardHandle>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const url = `http://${host}:${port}`;
      resolve({
        url,
        close: () => new Promise<void>(r => server.close(() => r())),
      });
    });
  });
}

async function route(p: Provider, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // ─── CORS / preflight ────────────────────────────────────────────────────
  // Bound to 127.0.0.1 by default, so * is safe for local dev. The Chrome
  // extension talks here directly; declaring host_permissions in the
  // manifest plus these headers covers both fetch and XHR paths.
  setCors(res);
  if (method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // ─── Static ──────────────────────────────────────────────────────────────
  if (method === 'GET' && (path === '/' || path === '/index.html')) {
    return sendFile(res, join(STATIC_DIR, 'index.html'), 'text/html; charset=utf-8');
  }

  // ─── API ─────────────────────────────────────────────────────────────────
  if (method === 'GET' && path === '/api/health') {
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'GET' && path === '/api/namespaces') {
    return sendJson(res, 200, await p.namespaces());
  }

  if (method === 'GET' && path === '/api/stats') {
    const ns = await p.namespaces();
    const total = ns.reduce((s, n) => s + n.count, 0);
    const latest = ns.length ? Math.max(...ns.map(n => n.last_updated || 0)) : 0;
    return sendJson(res, 200, { total, namespaces: ns.length, latest });
  }

  if (method === 'GET' && path === '/api/memories') {
    const namespace = url.searchParams.get('namespace') || undefined;
    const q = (url.searchParams.get('q') || '').trim();
    const limit = clampInt(url.searchParams.get('limit'), 50, 1, 500);
    const offset = clampInt(url.searchParams.get('offset'), 0, 0, 100_000);
    // v0.2.1 — date filters (epoch ms)
    const created_after  = parseEpochMs(url.searchParams.get('created_after'));
    const created_before = parseEpochMs(url.searchParams.get('created_before'));
    const updated_after  = parseEpochMs(url.searchParams.get('updated_after'));
    const updated_before = parseEpochMs(url.searchParams.get('updated_before'));
    // v0.2.4 — metadata containment via URL-encoded JSON
    const metadata_filter = parseJsonObject(url.searchParams.get('metadata_filter'));

    const filters = {
      namespace, created_after, created_before, updated_after, updated_before, metadata_filter,
    };
    if (q) {
      return sendJson(res, 200, await p.search({ query: q, k: limit, ...filters }));
    }
    return sendJson(res, 200, await p.list({ limit, offset, ...filters }));
  }

  // v0.2.3 — bulk search
  if (method === 'POST' && path === '/api/memories/search/bulk') {
    const body = await readBody(req);
    let parsed: any;
    try { parsed = JSON.parse(body); }
    catch { return sendJson(res, 400, { error: 'invalid JSON body' }); }
    const queries = Array.isArray(parsed.queries)
      ? parsed.queries.filter((q: unknown): q is string => typeof q === 'string' && q.trim().length > 0)
      : [];
    if (queries.length === 0) {
      return sendJson(res, 400, { error: 'queries[] required (non-empty strings)' });
    }
    if (typeof (p as any).bulkSearch !== 'function') {
      return sendJson(res, 501, { error: 'provider does not support bulkSearch' });
    }
    const out = await (p as any).bulkSearch({
      queries,
      namespace: parsed.namespace,
      k: clampInt(parsed.k, 5, 1, 50),
      metadata_filter:
        parsed.metadata_filter && typeof parsed.metadata_filter === 'object'
          ? parsed.metadata_filter
          : undefined,
      created_after:
        typeof parsed.created_after === 'number' ? parsed.created_after : undefined,
      created_before:
        typeof parsed.created_before === 'number' ? parsed.created_before : undefined,
    });
    return sendJson(res, 200, { results: out });
  }

  if (method === 'POST' && path === '/api/memories') {
    // Direct memory creation. Used by the Chrome extension to push captured
    // chats. Accepts the same shape as SaveMemoryInput.
    const body = await readBody(req);
    let parsed: any;
    try { parsed = JSON.parse(body); }
    catch { return sendJson(res, 400, { error: 'invalid JSON body' }); }
    const content = String(parsed.content ?? '');
    if (!content) return sendJson(res, 400, { error: 'content is required' });
    const saved = await p.save({
      content,
      namespace: parsed.namespace || undefined,
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
      source: parsed.source || 'extension',
      source_ref: parsed.source_ref || undefined,
      metadata: parsed.metadata && typeof parsed.metadata === 'object' ? parsed.metadata : undefined,
    });
    return sendJson(res, 201, saved);
  }

  if (path.startsWith('/api/memories/')) {
    const id = decodeURIComponent(path.slice('/api/memories/'.length));
    if (!id) return sendJson(res, 400, { error: 'missing id' });
    if (method === 'GET') {
      const mem = await p.get(id);
      if (!mem) return sendJson(res, 404, { error: 'not found' });
      return sendJson(res, 200, mem);
    }
    if (method === 'PATCH') {
      // v0.2.2 — partial update with metadata.history audit trail
      if (typeof (p as any).update !== 'function') {
        return sendJson(res, 501, { error: 'provider does not support update' });
      }
      const body = await readBody(req);
      let patch: any;
      try { patch = JSON.parse(body); }
      catch { return sendJson(res, 400, { error: 'invalid JSON body' }); }
      const updated = await (p as any).update(id, {
        content:   typeof patch.content   === 'string' ? patch.content   : undefined,
        namespace: typeof patch.namespace === 'string' ? patch.namespace : undefined,
        tags:      Array.isArray(patch.tags) ? patch.tags.map(String) : undefined,
        metadata:  patch.metadata && typeof patch.metadata === 'object' ? patch.metadata : undefined,
      });
      if (!updated) return sendJson(res, 404, { error: 'not found' });
      return sendJson(res, 200, updated);
    }
    if (method === 'DELETE') {
      const ok = await p.delete(id);
      return sendJson(res, ok ? 200 : 404, { deleted: ok });
    }
  }

  // ─── threads ─────────────────────────────────────────────────────────────
  // A "thread" is a group of memories sharing a parent_ref in metadata.
  // The dashboard groups chunks back into conversations for display.
  //
  // GET /api/threads?namespace=&limit=&offset=
  //   list of { parent_ref, namespace, count, first_at, last_at, sample_title }
  //
  // GET /api/threads/<parent_ref>
  //   all chunks of one thread, ordered by chunk_index then created_at
  if (method === 'GET' && path === '/api/threads') {
    const namespace = url.searchParams.get('namespace') || undefined;
    const limit = clampInt(url.searchParams.get('limit'), 100, 1, 500);
    const offset = clampInt(url.searchParams.get('offset'), 0, 0, 100000);
    const anyP = p as any;
    if (typeof anyP.listThreads !== 'function') {
      return sendJson(res, 501, { error: 'threads only supported on local provider for now' });
    }
    return sendJson(res, 200, anyP.listThreads({ namespace, limit, offset }));
  }
  if (method === 'GET' && path.startsWith('/api/threads/')) {
    const ref = decodeURIComponent(path.slice('/api/threads/'.length));
    if (!ref) return sendJson(res, 400, { error: 'missing parent_ref' });
    const anyP = p as any;
    if (typeof anyP.findThread !== 'function') {
      return sendJson(res, 501, { error: 'threads only supported on local provider for now' });
    }
    return sendJson(res, 200, { parent_ref: ref, chunks: anyP.findThread(ref) });
  }

  if (method === 'POST' && path === '/api/import') {
    const body = await readBody(req);
    let parsed: any;
    try { parsed = JSON.parse(body); }
    catch { return sendJson(res, 400, { error: 'invalid JSON body' }); }
    const fileContent = String(parsed.content ?? '');
    const namespace = String(parsed.namespace || 'imported');
    let format = String(parsed.format || 'auto');
    if (!fileContent) return sendJson(res, 400, { error: 'missing file content' });
    if (format === 'auto') {
      if (fileContent.includes('"chat_messages"')) format = 'claude';
      else if (fileContent.includes('"mapping"')) format = 'openai';
      else format = 'claude';
    }
    // Importers expect a file path. Stash to temp, import, clean up.
    const tmp = join(tmpdir(), `mnueron-import-${randomUUID()}.json`);
    try {
      await writeFile(tmp, fileContent, 'utf8');
      const items = format === 'claude'
        ? await importClaudeExport(tmp, namespace)
        : await importOpenAIExport(tmp, namespace);
      const result = await p.bulkSave(items);
      return sendJson(res, 200, { ...result, format, namespace, parsed: items.length });
    } catch (e: any) {
      return sendJson(res, 500, { error: e?.message ?? String(e) });
    } finally {
      await unlink(tmp).catch(() => {});
    }
  }

  return sendJson(res, 404, { error: 'not found', path });
}

// ─── helpers ───────────────────────────────────────────────────────────────
function setCors(res: ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '600');
}

function sendJson(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

async function sendFile(res: ServerResponse, file: string, mime: string) {
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function clampInt(s: string | null, dflt: number, min: number, max: number): number {
  if (s == null) return dflt;
  const n = parseInt(s, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

/** Parse a single epoch-ms query value, or null when missing/invalid. */
function parseEpochMs(s: string | null): number | undefined {
  if (s == null || s === '') return undefined;
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Parse a URL-encoded JSON object query parameter (used for metadata_filter).
 * Returns undefined when missing or invalid — silently fails closed so a
 * bad client param doesn't 500 the whole list endpoint.
 */
function parseJsonObject(s: string | null): Record<string, unknown> | undefined {
  if (s == null || s === '') return undefined;
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch { /* swallow */ }
  return undefined;
}
