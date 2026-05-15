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
    if (q) {
      return sendJson(res, 200, await p.search({ query: q, namespace, k: limit }));
    }
    return sendJson(res, 200, await p.list({ namespace, limit }));
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
    if (method === 'DELETE') {
      const ok = await p.delete(id);
      return sendJson(res, ok ? 200 : 404, { deleted: ok });
    }
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
