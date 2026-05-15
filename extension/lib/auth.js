/**
 * OAuth-style login flow for the MNUERON extension.
 *
 * Uses chrome.identity.launchWebAuthFlow, which:
 *   - opens a popup window to the MNUERON dashboard auth page
 *   - waits for the dashboard to redirect to chrome-extension://<id>/...
 *   - returns control with the final URL (containing the token)
 *
 * The user never copy-pastes anything. They just sign in to MNUERON
 * (Supabase Auth — same login they'd use on the dashboard), click
 * "Authorize MNUERON Extension", and the token lands in chrome.storage.
 *
 * Works cross-browser — Firefox aliases chrome.identity → browser.identity
 * and supports the same API.
 */

/**
 * Begin the auth flow.
 *
 * @param {string} apiUrl  The user's MNUERON API base URL (e.g.
 *   https://api.mnueron.dev). We send them to <apiUrl>/extension-auth/start.
 * @returns {Promise<{token: string, namespace?: string, email?: string}>}
 */
export async function signInWithMnueron(apiUrl) {
  if (!apiUrl) throw new Error('MNUERON API URL required before sign-in');

  const cleanUrl = apiUrl.replace(/\/$/, '');
  const redirectUri = chrome.identity.getRedirectURL();
  const state = crypto.randomUUID();

  const startUrl = `${cleanUrl}/extension-auth/start` +
    `?redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${state}` +
    `&client=mnueron-extension` +
    `&extension_id=${chrome.runtime.id}`;

  // Pop up the auth window; resolves when the dashboard redirects back to
  // our redirectUri with the token in the URL fragment.
  const responseUrl = await new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: startUrl, interactive: true },
      (url) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!url) {
          reject(new Error('auth flow cancelled'));
          return;
        }
        resolve(url);
      }
    );
  });

  const parsed = parseAuthResponse(responseUrl);
  if (!parsed.token) throw new Error('no token returned from MNUERON');
  if (parsed.state !== state) throw new Error('state mismatch — possible CSRF, aborted');
  return {
    token: parsed.token,
    namespace: parsed.namespace ?? 'browser-capture',
    email: parsed.email,
  };
}

function parseAuthResponse(url) {
  const u = new URL(url);
  // Token can arrive either in the URL fragment (preferred — never logged
  // by servers) or the query string. Try fragment first.
  const fragment = u.hash.startsWith('#') ? u.hash.slice(1) : u.hash;
  const fragParams = new URLSearchParams(fragment);
  const qsParams = u.searchParams;
  const get = (k) => fragParams.get(k) ?? qsParams.get(k);
  return {
    token: get('token'),
    state: get('state'),
    namespace: get('namespace'),
    email: get('email'),
  };
}
