/**
 * Extension authorization endpoint.
 *
 * Flow:
 *   1. Browser extension calls chrome.identity.launchWebAuthFlow → opens
 *      a popup to GET /extension-auth/start with ?redirect_uri=... &state=...
 *   2. /extension-auth/start renders a small HTML page. If the user is
 *      already logged in to MNUERON (Supabase session cookie present), it
 *      shows "Authorize MNUERON Extension to access your account?" with a
 *      button. If not logged in, it redirects to /login first and returns
 *      after.
 *   3. On "Approve", we POST to /extension-auth/approve, which:
 *        - validates the session
 *        - generates a new long-lived API token bound to this user/org
 *        - stores the SHA-256 hash, returns the raw token to the browser
 *        - 302-redirects to redirect_uri#token=mnu_xxx&state=xxx&namespace=...
 *   4. The browser is now sitting on chrome-extension://<id>/... — Chrome
 *      Identity captures that, closes the popup, calls back to our auth.js
 *      with the token. Extension saves it to chrome.storage.local.
 *
 * Mount in server/index.ts:
 *   import { extensionAuthRoutes } from './extension_auth.js';
 *   extensionAuthRoutes(app);
 *
 * Assumes Supabase session cookies for auth (or substitute your own
 * `getSessionUser(req)` adapter).
 */
import type { Express, Request, Response } from 'express';
import { randomBytes, createHash } from 'node:crypto';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/**
 * Replace with your real session lookup. The example below assumes a
 * `mnueron_session` cookie containing a Supabase JWT or session id.
 */
async function getSessionUser(req: Request): Promise<{ user_id: string; org_id: string; email: string } | null> {
  const sessionId = req.cookies?.mnueron_session;
  if (!sessionId) return null;
  // Adapter — replace with the real session lookup from your dashboard.
  const r = await pool.query(
    `SELECT u.id AS user_id, u.email,
            (SELECT org_id FROM org_members WHERE user_id = u.id LIMIT 1) AS org_id
       FROM users u
       JOIN dashboard_sessions s ON s.user_id = u.id
      WHERE s.id = $1 AND s.expires_at > NOW()`,
    [sessionId],
  );
  if (r.rows.length === 0) return null;
  return r.rows[0];
}

export function extensionAuthRoutes(app: Express) {
  // --- 1. The start page — extension lands here ---
  app.get('/extension-auth/start', async (req, res) => {
    const redirectUri = String(req.query.redirect_uri ?? '');
    const state = String(req.query.state ?? '');
    const extensionId = String(req.query.extension_id ?? '');

    if (!validateRedirect(redirectUri, extensionId)) {
      res.status(400).send('invalid redirect_uri');
      return;
    }
    if (!state || state.length < 16) {
      res.status(400).send('missing state');
      return;
    }

    const user = await getSessionUser(req);
    if (!user) {
      // Send them to login, then back here
      const next = encodeURIComponent(req.originalUrl);
      res.redirect(`/login?next=${next}`);
      return;
    }

    // Render approval page
    res.set('Content-Type', 'text/html');
    res.send(renderApproval({
      email: user.email,
      redirectUri,
      state,
      // CSRF: a per-request token tied to the cookie
      csrf: generateCsrf(user.user_id, state),
    }));
  });

  // --- 2. Approval — issues the token and redirects ---
  app.post('/extension-auth/approve', async (req, res) => {
    const user = await getSessionUser(req);
    if (!user) { res.status(401).send('not authenticated'); return; }

    const { redirect_uri, state, csrf } = req.body ?? {};
    if (!validateRedirect(String(redirect_uri ?? ''))) {
      res.status(400).send('invalid redirect'); return;
    }
    if (!verifyCsrf(String(csrf ?? ''), user.user_id, String(state ?? ''))) {
      res.status(403).send('csrf failure'); return;
    }

    const rawToken = 'mnu_' + randomBytes(24).toString('hex');
    const hash = createHash('sha256').update(rawToken).digest('hex');
    const prefix = rawToken.slice(0, 8);

    await pool.query(
      `INSERT INTO api_tokens (user_id, org_id, token_hash, prefix, name, scopes, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, NULL)`,
      [
        user.user_id,
        user.org_id,
        hash,
        prefix,
        'Browser extension',
        ['read', 'write'],
      ],
    );

    const finalUrl = `${redirect_uri}#` + new URLSearchParams({
      token: rawToken,
      state: String(state ?? ''),
      namespace: 'browser-capture',
      email: user.email,
    }).toString();
    res.redirect(finalUrl);
  });
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function validateRedirect(uri: string, extensionId?: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol !== 'https:') return false;
    // chrome-extension redirect domains look like:
    //   https://<extension-id>.chromiumapp.org/
    if (!u.hostname.endsWith('.chromiumapp.org')) return false;
    if (extensionId && !u.hostname.startsWith(extensionId)) return false;
    return true;
  } catch {
    return false;
  }
}

function generateCsrf(userId: string, state: string): string {
  const secret = process.env.EXTENSION_CSRF_SECRET ?? 'change-me-in-production';
  return createHash('sha256').update(`${userId}|${state}|${secret}`).digest('hex');
}

function verifyCsrf(csrf: string, userId: string, state: string): boolean {
  return csrf === generateCsrf(userId, state);
}

// ---------------------------------------------------------------------------
// Approval page HTML
// ---------------------------------------------------------------------------

function renderApproval(opts: {
  email: string;
  redirectUri: string;
  state: string;
  csrf: string;
}): string {
  // Inline minimal HTML so this works without a templating engine
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Authorize MNUERON Extension</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #fafafa; color: #1a1a1a; max-width: 480px; margin: 80px auto; padding: 32px; }
  .card { background: #fff; border: 1px solid #e5e5e5; border-radius: 12px; padding: 32px; }
  h1 { font-size: 20px; margin-bottom: 8px; }
  p { color: #525252; margin-bottom: 16px; line-height: 1.5; }
  .perms { background: #fafafa; border-radius: 6px; padding: 16px; margin: 16px 0; }
  .perms li { font-size: 13px; margin: 6px 0; }
  button { width: 100%; padding: 12px; background: #1a1a1a; color: #fff; border: 0; border-radius: 6px; font-size: 14px; cursor: pointer; }
  button:hover { background: #333; }
  button.secondary { background: transparent; color: #525252; margin-top: 8px; }
</style></head>
<body><div class="card">
  <h1>🧠 Authorize MNUERON Extension</h1>
  <p>Signed in as <strong>${escapeHtml(opts.email)}</strong>. The browser extension is requesting access to:</p>
  <div class="perms"><ul>
    <li>✓ Save memories on your behalf</li>
    <li>✓ Search and recall your memories</li>
    <li>✓ Read namespaces you have access to</li>
  </ul></div>
  <p>This grants the extension a new long-lived API token. You can revoke it anytime from your dashboard.</p>
  <form method="POST" action="/extension-auth/approve">
    <input type="hidden" name="redirect_uri" value="${escapeHtml(opts.redirectUri)}">
    <input type="hidden" name="state" value="${escapeHtml(opts.state)}">
    <input type="hidden" name="csrf" value="${escapeHtml(opts.csrf)}">
    <button type="submit">Authorize Extension</button>
    <button type="button" class="secondary" onclick="window.close()">Cancel</button>
  </form>
</div></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)
  );
}
