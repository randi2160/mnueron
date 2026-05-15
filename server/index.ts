/**
 * mnueron hosted backend — minimal Express skeleton.
 *
 * What this file shows (the load-bearing bits — fill in the rest as you ship):
 *   1. Bearer-token auth that resolves to (user, org).
 *   2. Setting `app.current_org_id` on every connection so Postgres RLS
 *      enforces tenant isolation.
 *   3. Hybrid recall (BM25 via tsvector + cosine via pgvector).
 *   4. Bulk-save endpoint for the importer.
 *
 * Run:
 *   psql $DATABASE_URL < server/schema.sql
 *   npm install express pg @types/pg
 *   tsx server/index.ts
 *
 * Hosted-mode env vars on the client side:
 *   MNUERON_API_URL=https://api.your-mnueron.com
 *   MNUERON_API_TOKEN=mn_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
 */
import express from 'express';
import { Pool, PoolClient } from 'pg';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = parseInt(process.env.PORT ?? '3111', 10);
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://localhost:5432/mnueron';
// For signup/login we need to write to `users`, `orgs`, `api_tokens` which
// the restricted `mnueron_app`/`authenticated` role typically cannot do.
// Set ADMIN_DATABASE_URL to a connection string with broader privileges
// (Supabase: the service_role pooler URL). If unset, falls back to DATABASE_URL.
const ADMIN_DATABASE_URL = process.env.ADMIN_DATABASE_URL ?? DATABASE_URL;
const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS ?? '10', 10);

const pool = new Pool({ connectionString: DATABASE_URL });
const adminPool = new Pool({ connectionString: ADMIN_DATABASE_URL });

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Auth: bearer token → (user_id, org_id)
// ---------------------------------------------------------------------------

interface AuthContext {
  userId: string;
  orgId: string;
  tokenId: string;
}

async function resolveToken(rawToken: string): Promise<AuthContext | null> {
  const hash = createHash('sha256').update(rawToken).digest('hex');
  const { rows } = await pool.query(
    `SELECT id, user_id, org_id
       FROM api_tokens
      WHERE token_hash = $1
        AND (expires_at IS NULL OR expires_at > NOW())`,
    [hash],
  );
  if (rows.length === 0) return null;
  // best-effort last_used update (don't await)
  pool.query(`UPDATE api_tokens SET last_used_at = NOW() WHERE id = $1`, [rows[0].id]).catch(() => {});
  return { tokenId: rows[0].id, userId: rows[0].user_id, orgId: rows[0].org_id };
}

declare module 'express-serve-static-core' {
  interface Request { auth?: AuthContext; }
}

async function authMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
  const header = req.header('authorization') ?? '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) { res.status(401).json({ error: 'missing bearer token' }); return; }
  const ctx = await resolveToken(m[1]);
  if (!ctx) { res.status(401).json({ error: 'invalid token' }); return; }
  req.auth = ctx;
  next();
}

// Helper: run a query with RLS scope set to this request's org.
async function withTenantScope<T>(
  ctx: AuthContext,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    // Set the GUC. set_config(name, value, is_local=true) keeps it for this txn only.
    await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [ctx.orgId]);
    // Switch to the restricted role so RLS policies apply.
    await client.query(`SET ROLE mnueron_app`);
    return await fn(client);
  } finally {
    await client.query(`RESET ROLE`).catch(() => {});
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Token / password helpers
// ---------------------------------------------------------------------------

interface TokenMaterial {
  raw: string;       // `mnu_xxx…` — shown to user once, never stored
  hash: string;      // sha256 of raw — stored in api_tokens.token_hash
  prefix: string;    // first 12 chars (`mnu_xxxxxxxx`) — display only
}

function generateToken(): TokenMaterial {
  const body = randomBytes(32).toString('base64url');
  const raw = `mnu_${body}`;
  const hash = createHash('sha256').update(raw).digest('hex');
  return { raw, hash, prefix: raw.slice(0, 12) };
}

function isValidEmail(s: unknown): s is string {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;
}
function isValidPassword(s: unknown): s is string {
  return typeof s === 'string' && s.length >= 8 && s.length <= 256;
}
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'org';
}

// ---------------------------------------------------------------------------
// Embeddings — pluggable. Default to OpenAI text-embedding-3-small.
// ---------------------------------------------------------------------------

async function embed(text: string): Promise<number[] | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null; // fall through to BM25-only
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),
  });
  if (!res.ok) return null;
  const data: any = await res.json();
  return data.data?.[0]?.embedding ?? null;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: '4mb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------------
// Auth: signup / login / me / token management
//
// These endpoints write to identity tables (users, orgs, api_tokens). They
// run on `adminPool`, which connects with a Postgres role that has the
// necessary INSERT/UPDATE grants. In Supabase that means using the
// service_role connection string. In a standalone Postgres deployment that
// means a user with privileges on these tables (often `postgres` itself).
// ---------------------------------------------------------------------------

// Serve static auth pages (./auth.html if present)
app.get('/signup', async (_req, res) => {
  try {
    const html = await readFile(join(HERE, 'auth.html'), 'utf8');
    res.type('text/html').send(html.replace('{{mode}}', 'signup'));
  } catch {
    res.status(404).send('auth page missing');
  }
});
app.get('/login', async (_req, res) => {
  try {
    const html = await readFile(join(HERE, 'auth.html'), 'utf8');
    res.type('text/html').send(html.replace('{{mode}}', 'login'));
  } catch {
    res.status(404).send('auth page missing');
  }
});

// POST /v1/auth/signup
// Body: { email, password, name?, org_name? }
// Returns: { user, org, token } where `token` is the raw `mnu_…` string
//          (shown ONCE — client must persist it).
app.post('/v1/auth/signup', async (req, res) => {
  const { email, password, name, org_name } = req.body ?? {};
  if (!isValidEmail(email))    { res.status(400).json({ error: 'valid email required' }); return; }
  if (!isValidPassword(password)) { res.status(400).json({ error: 'password must be 8+ chars' }); return; }

  const client = await adminPool.connect();
  try {
    // already exists?
    const dup = await client.query(`SELECT 1 FROM users WHERE email = $1`, [email]);
    if (dup.rowCount && dup.rowCount > 0) {
      res.status(409).json({ error: 'email already registered' });
      return;
    }

    const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const token = generateToken();
    const orgSlug = `${slugify(name || email.split('@')[0])}-${randomBytes(3).toString('hex')}`;
    const orgDisplayName = org_name || `${(name || email.split('@')[0])}'s workspace`;

    await client.query('BEGIN');
    try {
      const ur = await client.query(
        `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id`,
        [email, name ?? null, password_hash],
      );
      const userId = ur.rows[0].id;

      const orr = await client.query(
        `INSERT INTO orgs (slug, name) VALUES ($1, $2) RETURNING id`,
        [orgSlug, orgDisplayName],
      );
      const orgId = orr.rows[0].id;

      await client.query(
        `INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [orgId, userId],
      );

      const tr = await client.query(
        `INSERT INTO api_tokens (user_id, org_id, token_hash, prefix, name)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, created_at`,
        [userId, orgId, token.hash, token.prefix, 'default'],
      );
      await client.query('COMMIT');

      res.status(201).json({
        user:  { id: userId, email, name: name ?? null },
        org:   { id: orgId, slug: orgSlug, name: orgDisplayName },
        token: { raw: token.raw, id: tr.rows[0].id, prefix: token.prefix, created_at: +new Date(tr.rows[0].created_at) },
      });
    } catch (e: any) {
      await client.query('ROLLBACK');
      throw e;
    }
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'signup failed' });
  } finally {
    client.release();
  }
});

// POST /v1/auth/login
// Body: { email, password }
// Returns: { user, org, token } — issues a fresh token on each successful login.
app.post('/v1/auth/login', async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!isValidEmail(email))    { res.status(400).json({ error: 'valid email required' }); return; }
  if (typeof password !== 'string' || !password) {
    res.status(400).json({ error: 'password required' }); return;
  }

  const client = await adminPool.connect();
  try {
    const ur = await client.query(
      `SELECT id, email, name, password_hash FROM users WHERE email = $1`,
      [email],
    );
    if (ur.rowCount === 0 || !ur.rows[0].password_hash) {
      // Same response for missing user and wrong password — don't reveal which.
      res.status(401).json({ error: 'invalid email or password' });
      return;
    }
    const user = ur.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      res.status(401).json({ error: 'invalid email or password' });
      return;
    }

    // Find any org the user belongs to. For users with multiple orgs we pick
    // the oldest membership; future "switch org" is a separate endpoint.
    const orgr = await client.query(
      `SELECT o.id, o.slug, o.name
         FROM orgs o
         JOIN org_members m ON m.org_id = o.id
        WHERE m.user_id = $1
        ORDER BY m.joined ASC
        LIMIT 1`,
      [user.id],
    );
    if (orgr.rowCount === 0) {
      res.status(500).json({ error: 'user has no org membership' });
      return;
    }
    const org = orgr.rows[0];

    const token = generateToken();
    const tr = await client.query(
      `INSERT INTO api_tokens (user_id, org_id, token_hash, prefix, name)
       VALUES ($1, $2, $3, $4, 'login')
       RETURNING id, created_at`,
      [user.id, org.id, token.hash, token.prefix],
    );
    await client.query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [user.id]);

    res.json({
      user:  { id: user.id, email: user.email, name: user.name },
      org:   { id: org.id, slug: org.slug, name: org.name },
      token: { raw: token.raw, id: tr.rows[0].id, prefix: token.prefix, created_at: +new Date(tr.rows[0].created_at) },
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'login failed' });
  } finally {
    client.release();
  }
});

// GET /v1/auth/me
app.get('/v1/auth/me', authMiddleware, async (req, res) => {
  const client = await adminPool.connect();
  try {
    const r = await client.query(
      `SELECT u.id, u.email, u.name, u.last_login_at, o.id AS org_id, o.slug AS org_slug, o.name AS org_name
         FROM users u
         JOIN api_tokens t ON t.user_id = u.id
         JOIN orgs o ON o.id = t.org_id
        WHERE t.id = $1`,
      [req.auth!.tokenId],
    );
    if (r.rowCount === 0) { res.status(404).json({ error: 'not found' }); return; }
    const row = r.rows[0];
    res.json({
      user: { id: row.id, email: row.email, name: row.name, last_login_at: row.last_login_at },
      org:  { id: row.org_id, slug: row.org_slug, name: row.org_name },
    });
  } finally {
    client.release();
  }
});

// GET /v1/auth/tokens  — list this user's tokens (hashes never returned)
app.get('/v1/auth/tokens', authMiddleware, async (req, res) => {
  const client = await adminPool.connect();
  try {
    const r = await client.query(
      `SELECT id, prefix, name, last_used_at, expires_at, created_at
         FROM api_tokens
        WHERE user_id = $1 AND org_id = $2
        ORDER BY created_at DESC`,
      [req.auth!.userId, req.auth!.orgId],
    );
    res.json(r.rows);
  } finally {
    client.release();
  }
});

// POST /v1/auth/tokens  — issue a new token bound to the current (user, org)
app.post('/v1/auth/tokens', authMiddleware, async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.slice(0, 64) : null;
  const token = generateToken();
  const client = await adminPool.connect();
  try {
    const r = await client.query(
      `INSERT INTO api_tokens (user_id, org_id, token_hash, prefix, name)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, created_at`,
      [req.auth!.userId, req.auth!.orgId, token.hash, token.prefix, name],
    );
    res.status(201).json({
      id: r.rows[0].id, prefix: token.prefix, name,
      created_at: +new Date(r.rows[0].created_at),
      raw: token.raw,                              // shown ONCE
    });
  } finally {
    client.release();
  }
});

// DELETE /v1/auth/tokens/:id  — revoke
app.delete('/v1/auth/tokens/:id', authMiddleware, async (req, res) => {
  const client = await adminPool.connect();
  try {
    const r = await client.query(
      `DELETE FROM api_tokens
        WHERE id = $1 AND user_id = $2 AND org_id = $3`,
      [req.params.id, req.auth!.userId, req.auth!.orgId],
    );
    res.status(r.rowCount && r.rowCount > 0 ? 204 : 404).end();
  } finally {
    client.release();
  }
});

// POST /v1/memories — save one
app.post('/v1/memories', authMiddleware, async (req, res) => {
  const { content, namespace = 'default', tags = [], source = 'agent', source_ref, metadata } = req.body ?? {};
  if (typeof content !== 'string' || !content) { res.status(400).json({ error: 'content required' }); return; }
  const embedding = await embed(content);

  const result = await withTenantScope(req.auth!, async (c) => {
    // upsert namespace
    const nsr = await c.query(
      `INSERT INTO namespaces (org_id, name) VALUES ($1, $2)
         ON CONFLICT (org_id, name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [req.auth!.orgId, namespace],
    );
    const namespaceId = nsr.rows[0].id;
    const r = await c.query(
      `INSERT INTO memories
         (org_id, namespace_id, created_by, content, tags, source, source_ref, metadata, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, created_at, updated_at`,
      [
        req.auth!.orgId, namespaceId, req.auth!.userId,
        content, tags, source, source_ref ?? null, metadata ?? {},
        embedding ? `[${embedding.join(',')}]` : null,
      ],
    );
    await c.query(
      `INSERT INTO audit_log (org_id, user_id, actor_token, action, target_id)
       VALUES ($1, $2, $3, 'memory.save', $4)`,
      [req.auth!.orgId, req.auth!.userId, req.auth!.tokenId, r.rows[0].id],
    );
    return r.rows[0];
  });

  res.json({ id: result.id, namespace, content, tags, source, source_ref,
             created_at: +new Date(result.created_at), updated_at: +new Date(result.updated_at) });
});

// POST /v1/memories/search — hybrid recall
app.post('/v1/memories/search', authMiddleware, async (req, res) => {
  const { query, namespace, k = 10, tags } = req.body ?? {};
  if (typeof query !== 'string' || !query) { res.status(400).json({ error: 'query required' }); return; }
  const q_emb = await embed(query);

  const rows = await withTenantScope(req.auth!, async (c) => {
    // BM25 via ts_rank_cd. Vector similarity via cosine distance if we have an embedding.
    // We blend the two with simple reciprocal-rank fusion.
    if (q_emb) {
      const r = await c.query(
        `WITH bm AS (
            SELECT m.id, ts_rank_cd(content_tsv, plainto_tsquery('english', $1)) AS s
              FROM memories m
              JOIN namespaces ns ON ns.id = m.namespace_id
             WHERE ($2::text IS NULL OR ns.name = $2)
               AND ($3::text[] IS NULL OR m.tags && $3)
             ORDER BY s DESC LIMIT 50
         ),
         vec AS (
            SELECT m.id, 1 - (m.embedding <=> $4::vector) AS s
              FROM memories m
              JOIN namespaces ns ON ns.id = m.namespace_id
             WHERE m.embedding IS NOT NULL
               AND ($2::text IS NULL OR ns.name = $2)
               AND ($3::text[] IS NULL OR m.tags && $3)
             ORDER BY m.embedding <=> $4::vector ASC LIMIT 50
         ),
         fused AS (
            SELECT id, SUM(score) AS score FROM (
               SELECT id, 1.0/(60 + ROW_NUMBER() OVER (ORDER BY s DESC)) AS score FROM bm
               UNION ALL
               SELECT id, 1.0/(60 + ROW_NUMBER() OVER (ORDER BY s DESC)) AS score FROM vec
            ) x GROUP BY id
         )
         SELECT m.*, ns.name AS namespace_name, f.score
           FROM fused f
           JOIN memories m ON m.id = f.id
           JOIN namespaces ns ON ns.id = m.namespace_id
          ORDER BY f.score DESC
          LIMIT $5`,
        [query, namespace ?? null, tags ?? null, `[${q_emb.join(',')}]`, k],
      );
      return r.rows;
    }
    const r = await c.query(
      `SELECT m.*, ns.name AS namespace_name,
              ts_rank_cd(content_tsv, plainto_tsquery('english', $1)) AS score
         FROM memories m
         JOIN namespaces ns ON ns.id = m.namespace_id
        WHERE content_tsv @@ plainto_tsquery('english', $1)
          AND ($2::text IS NULL OR ns.name = $2)
          AND ($3::text[] IS NULL OR m.tags && $3)
        ORDER BY score DESC LIMIT $4`,
      [query, namespace ?? null, tags ?? null, k],
    );
    return r.rows;
  });

  res.json(rows.map(r => ({
    id: r.id,
    namespace: r.namespace_name,
    content: r.content,
    tags: r.tags ?? [],
    source: r.source,
    source_ref: r.source_ref ?? undefined,
    metadata: r.metadata ?? undefined,
    score: r.score,
    created_at: +new Date(r.created_at),
    updated_at: +new Date(r.updated_at),
  })));
});

// POST /v1/memories/bulk — used by the importer
app.post('/v1/memories/bulk', authMiddleware, async (req, res) => {
  const items = (req.body?.items ?? []) as any[];
  if (!Array.isArray(items)) { res.status(400).json({ error: 'items[] required' }); return; }

  let saved = 0, errors = 0;
  await withTenantScope(req.auth!, async (c) => {
    for (const item of items) {
      try {
        const ns = item.namespace ?? 'default';
        const nsr = await c.query(
          `INSERT INTO namespaces (org_id, name) VALUES ($1, $2)
             ON CONFLICT (org_id, name) DO UPDATE SET name = EXCLUDED.name
           RETURNING id`,
          [req.auth!.orgId, ns],
        );
        await c.query(
          `INSERT INTO memories
             (org_id, namespace_id, created_by, content, tags, source, source_ref, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            req.auth!.orgId, nsr.rows[0].id, req.auth!.userId,
            item.content, item.tags ?? [], item.source ?? 'import',
            item.source_ref ?? null, item.metadata ?? {},
          ],
        );
        saved++;
      } catch {
        errors++;
      }
    }
  });
  // Embeddings get filled in by an async worker — return immediately.
  res.json({ saved, errors });
});

// GET /v1/namespaces
app.get('/v1/namespaces', authMiddleware, async (req, res) => {
  const rows = await withTenantScope(req.auth!, async (c) => {
    const r = await c.query(
      `SELECT ns.name,
              COUNT(m.*)::int AS count,
              COALESCE(MAX(m.updated_at), ns.created_at) AS last_updated
         FROM namespaces ns
         LEFT JOIN memories m ON m.namespace_id = ns.id
        GROUP BY ns.id, ns.name, ns.created_at
        ORDER BY last_updated DESC`,
    );
    return r.rows;
  });
  res.json(rows.map(r => ({
    name: r.name, count: r.count, last_updated: +new Date(r.last_updated),
  })));
});

// DELETE /v1/memories/:id
app.delete('/v1/memories/:id', authMiddleware, async (req, res) => {
  await withTenantScope(req.auth!, async (c) => {
    await c.query(`DELETE FROM memories WHERE id = $1`, [req.params.id]);
    await c.query(
      `INSERT INTO audit_log (org_id, user_id, actor_token, action, target_id)
       VALUES ($1, $2, $3, 'memory.delete', $4)`,
      [req.auth!.orgId, req.auth!.userId, req.auth!.tokenId, req.params.id],
    );
  });
  res.status(204).end();
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`mnueron-server listening on :${PORT}`);
});
