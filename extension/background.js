/**
 * mnueron extension — background service worker.
 *
 * Responsibilities:
 *   - Settings storage (default URL, hosted URL, hosted token, auto-capture).
 *   - Talk to mnueron backend (local at http://localhost:3122 by default,
 *     optionally a hosted URL with bearer token).
 *   - Mediate between popup and content scripts: popup asks "capture current
 *     chat"; we ask the active tab's content script to scrape; we POST to mnueron.
 *
 * MV3 service workers can be terminated at any moment. Do not keep important
 * state in module-level variables; persist to chrome.storage instead.
 */

const DEFAULTS = Object.freeze({
  local_url: 'http://localhost:3122',
  // Default the hosted URL to the canonical mnueron.com so users don't have
  // to type it. They can still override in the options page if self-hosting.
  hosted_url: 'https://mnueron.com',
  hosted_token: '',
  auto_capture: false,
  // Ambient context: search mnueron as the user types and surface relevant
  // past memories in a small floating pill. Off by default because it
  // changes the page UX without asking; user enables in options.
  ambient_context: false,
  // Optional namespace scope for ambient searches. Empty = search all.
  // User can scope to a specific namespace (e.g., "web-claude") in options.
  ambient_namespace: '',
  namespace_prefix: 'web',     // memories saved as `${prefix}-${site}` namespace
  prefer_hosted: false,        // if true, use hosted_url (with token); else local
});

async function getSettings() {
  const stored = await chrome.storage.sync.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

async function setSettings(patch) {
  await chrome.storage.sync.set(patch);
}

// ─── HTTP client ───────────────────────────────────────────────────────────
/**
 * Resolve the current backend URL + bearer token from settings.
 *
 * In Hosted mode we ALWAYS use the canonical mnueron.com URL even if the
 * user's settings somehow have hosted_url cleared. That way the "Hosted"
 * toggle never silently falls back to localhost — a class of bug we hit
 * when the popup said "Hosted" but requests still went to 127.0.0.1.
 */
async function backendBase() {
  const s = await getSettings();
  if (s.prefer_hosted) {
    const url = (s.hosted_url || 'https://mnueron.com').replace(/\/$/, '');
    return { url, token: s.hosted_token || '' };
  }
  return {
    url: (s.local_url || 'http://localhost:3122').replace(/\/$/, ''),
    token: '',
  };
}

async function apiFetch(path, opts = {}) {
  const { url, token } = await backendBase();
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const r = await fetch(url + path, { ...opts, headers });
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try { const j = await r.json(); if (j.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
  return r.json();
}

async function ping() {
  try {
    const r = await apiFetch('/api/health');
    return { ok: !!r.ok };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function saveMemory({ content, namespace, tags, source, source_ref, metadata }) {
  return apiFetch('/api/memories', {
    method: 'POST',
    body: JSON.stringify({ content, namespace, tags, source, source_ref, metadata }),
  });
}

/**
 * Search memories for a free-text query, optionally scoped to a namespace.
 * Returns the top-k matches. Hosted mode: hits mnueron.com BM25/semantic
 * search. Local mode: hits the local dashboard server's same endpoint.
 *
 * Used by the popup's Recall panel and by ambient.js. If namespace is not
 * supplied explicitly we fall back to settings.ambient_namespace, so the
 * ambient feature respects the user's scope choice without each caller
 * having to pass it.
 */
async function recallMemories({ q, namespace, k = 5 }) {
  if (!q || !q.trim()) return [];
  const params = new URLSearchParams();
  params.set('q', q.trim());
  if (!namespace) {
    const s = await getSettings();
    if (s.ambient_namespace) namespace = s.ambient_namespace;
  }
  if (namespace) params.set('namespace', namespace);
  params.set('limit', String(k));
  return apiFetch(`/api/memories?${params.toString()}`);
}

/**
 * List the user's distinct namespaces. Used by the options page to
 * populate the "Search scope" dropdown so they can pick from real
 * existing namespaces instead of guessing names.
 */
async function listNamespaces() {
  try {
    return await apiFetch('/api/namespaces');
  } catch {
    return [];
  }
}

// ─── Site detection from URL ───────────────────────────────────────────────
function detectSite(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.hostname === 'claude.ai') return 'claude';
    if (u.hostname === 'chatgpt.com' || u.hostname === 'chat.openai.com') return 'chatgpt';
    if (u.hostname === 'gemini.google.com') return 'gemini';
  } catch {}
  return null;
}

// ─── Format messages into a markdown transcript ────────────────────────────
function renderTranscript(chat) {
  const parts = [];
  if (chat.title) parts.push(`# ${chat.title}`);
  if (chat.url) parts.push(`Source: ${chat.url}`);
  if (chat.captured_at) parts.push(`(captured ${new Date(chat.captured_at).toISOString()})`);
  parts.push('');
  for (const m of chat.messages || []) {
    const who =
      m.role === 'assistant' ? 'Assistant' :
      m.role === 'user'      ? 'User'      :
      (m.role || 'Unknown');
    parts.push(`**${who}:** ${m.content || ''}`);
    parts.push('');
  }
  return parts.join('\n').trim();
}

// Render a Claude API conversation object (different shape than the DOM scraper output).
function renderClaudeApiConv(conv) {
  const parts = [];
  if (conv.name) parts.push(`# ${conv.name}`);
  if (conv.created_at) parts.push(`Created: ${new Date(conv.created_at).toISOString()}`);
  if (conv.updated_at) parts.push(`Updated: ${new Date(conv.updated_at).toISOString()}`);
  parts.push('');
  for (const m of conv.chat_messages || []) {
    const who =
      m.sender === 'assistant' ? 'Claude' :
      m.sender === 'human'     ? 'User'   :
      (m.sender || 'Unknown');
    const text = extractApiMessageText(m);
    if (!text.trim()) continue;
    parts.push(`**${who}:** ${text}`);
    parts.push('');
  }
  return parts.join('\n').trim();
}

function extractApiMessageText(msg) {
  if (typeof msg.text === 'string' && msg.text) return msg.text;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map(p => (typeof p === 'string') ? p : (p?.text || ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

// ─── Capture flow ──────────────────────────────────────────────────────────
async function captureFromTab(tabId, tabUrl) {
  const site = detectSite(tabUrl);
  if (!site) throw new Error('Not a supported chat site.');

  // Ask the content script to scrape the page
  let chat;
  try {
    chat = await chrome.tabs.sendMessage(tabId, { type: 'mnueron:scrape' });
  } catch (e) {
    throw new Error('No scraper loaded on this page. Try reloading the page.');
  }
  if (!chat || !chat.messages || chat.messages.length === 0) {
    throw new Error('No messages found on this page.');
  }

  const transcript = renderTranscript(chat);
  if (transcript.length < 20) throw new Error('Captured transcript looks empty.');

  const settings = await getSettings();
  const namespace = `${settings.namespace_prefix}-${site}`;
  const tags = ['captured', site, 'extension'];
  const saved = await saveMemory({
    content: transcript,
    namespace,
    tags,
    source: `${site}-extension`,
    source_ref: chat.url || tabUrl,
    metadata: {
      title: chat.title,
      message_count: chat.messages.length,
      captured_at: chat.captured_at || Date.now(),
    },
  });

  // bookkeeping: count captures today for the popup
  const today = new Date().toISOString().slice(0, 10);
  const k = `count_${today}`;
  const cur = (await chrome.storage.local.get(k))[k] || 0;
  await chrome.storage.local.set({ [k]: cur + 1, last_capture: { site, at: Date.now() } });

  return { id: saved.id, namespace, message_count: chat.messages.length };
}

// ─── Backfill: import all claude.ai chats via internal API ────────────────
// One-shot. Persists progress in chrome.storage.local so the popup can render
// it across re-openings, and so we can resume cleanly across service-worker
// restarts. Idempotent: chats whose uuid we've already imported are skipped.
const BACKFILL_RATE_MS = 250;     // delay between API requests to be polite

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function findClaudeTab() {
  const tabs = await chrome.tabs.query({ url: ['https://claude.ai/*'] });
  if (tabs.length === 0) {
    throw new Error('Open a claude.ai tab first (any chat page is fine), then click Backfill again.');
  }
  // Prefer the active one in current window, else any.
  return tabs.find(t => t.active) ?? tabs[0];
}

async function setBackfillProgress(patch) {
  const cur = (await chrome.storage.local.get('backfill_progress')).backfill_progress || {};
  await chrome.storage.local.set({ backfill_progress: { ...cur, ...patch, ts: Date.now() } });
}

/**
 * Stop flag. The backfill loop reads this between iterations and exits
 * cleanly with status='paused' if true. Set by mnueron:backfill_stop.
 * Cleared at the start of every new backfill run.
 */
async function isStopRequested() {
  const r = await chrome.storage.local.get('backfill_stop_requested');
  return !!r.backfill_stop_requested;
}

async function setStopRequested(v) {
  await chrome.storage.local.set({ backfill_stop_requested: !!v });
}

async function startBackfill() {
  const settings = await getSettings();
  const tab = await findClaudeTab();

  // Fresh run = clear any stale stop signal from a previous pause.
  await setStopRequested(false);

  // Replace, not merge — clear any stale fields from a prior run.
  await chrome.storage.local.set({
    backfill_progress: {
      status: 'starting',
      done: 0, errors: 0, skipped: 0, total: 0, todo: 0,
      current: null, error: null,
      ts: Date.now(),
    },
  });

  let list;
  try {
    list = await chrome.tabs.sendMessage(tab.id, { type: 'mnueron:backfill_list' });
  } catch (e) {
    const hint =
      'Reload the claude.ai tab (F5), then click Backfill again. ' +
      'The page must be reloaded after the extension is updated so the content script re-injects.';
    await setBackfillProgress({ status: 'error', error: hint });
    throw new Error(hint);
  }
  if (!list?.ok) {
    await setBackfillProgress({ status: 'error', error: list?.error || 'failed to list chats' });
    throw new Error(list?.error || 'could not list chats');
  }

  const { orgId, conversations } = list;
  const stored = await chrome.storage.local.get('imported_chat_uuids');
  const imported = new Set(stored.imported_chat_uuids || []);

  const todo = conversations.filter(c => !imported.has(c.uuid));
  const skippedCount = conversations.length - todo.length;

  await setBackfillProgress({
    status: 'running',
    total: conversations.length,
    todo: todo.length,
    skipped: skippedCount,
    done: 0,
    errors: 0,
  });

  let done = 0, errors = 0;
  for (const conv of todo) {
    // Honor Stop button — exit cleanly. Already-imported uuids are
    // persisted below so Resume picks up where we left off automatically.
    if (await isStopRequested()) {
      await chrome.storage.local.set({ imported_chat_uuids: [...imported] });
      await setBackfillProgress({
        status: 'paused',
        done, errors,
        current: null,
      });
      await setStopRequested(false);
      return { done, errors, skipped: skippedCount, total: conversations.length, paused: true };
    }
    await setBackfillProgress({ current: conv.name || conv.uuid });
    try {
      const full = await chrome.tabs.sendMessage(tab.id, {
        type: 'mnueron:backfill_get',
        orgId, uuid: conv.uuid,
      });
      if (!full?.ok || !full.conversation) throw new Error(full?.error || 'fetch failed');

      const transcript = renderClaudeApiConv(full.conversation);
      if (!transcript || transcript.length < 20) {
        // Empty chat — record uuid so we don't keep retrying.
        imported.add(conv.uuid);
        continue;
      }
      const namespace = `${settings.namespace_prefix}-claude`;
      await saveMemory({
        content: transcript,
        namespace,
        tags: ['imported', 'claude', 'backfill'],
        source: 'claude-backfill',
        source_ref: `https://claude.ai/chat/${conv.uuid}`,
        metadata: {
          title: conv.name,
          created_at: conv.created_at,
          updated_at: conv.updated_at,
          message_count: (full.conversation.chat_messages || []).length,
          model: conv.model,
        },
      });
      imported.add(conv.uuid);
      done++;
    } catch (e) {
      errors++;
      console.warn('[mnueron] backfill chat failed', conv.uuid, e);
    }

    await setBackfillProgress({ done, errors });
    // Persist imported set every 10 to survive worker restarts
    if ((done + errors) % 10 === 0) {
      await chrome.storage.local.set({ imported_chat_uuids: [...imported] });
    }
    await sleep(BACKFILL_RATE_MS);
  }

  // Final flush
  await chrome.storage.local.set({ imported_chat_uuids: [...imported] });
  await setBackfillProgress({
    status: 'done',
    done, errors,
    current: null,
  });

  return { done, errors, skipped: skippedCount, total: conversations.length };
}

// ─── Message router ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'mnueron:capture') {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tab = tabs[0];
        if (!tab) throw new Error('No active tab.');
        const result = await captureFromTab(tab.id, tab.url);
        sendResponse({ ok: true, result });
      } else if (msg.type === 'mnueron:ping') {
        sendResponse({ ok: true, status: await ping() });
      } else if (msg.type === 'mnueron:get_settings') {
        sendResponse({ ok: true, settings: await getSettings() });
      } else if (msg.type === 'mnueron:set_settings') {
        await setSettings(msg.patch || {});
        sendResponse({ ok: true });
      } else if (msg.type === 'mnueron:backfill_start') {
        const result = await startBackfill();
        sendResponse({ ok: true, result });
      } else if (msg.type === 'mnueron:backfill_stop') {
        // Set the flag; the running loop reads it between iterations and
        // will flip status to 'paused' on its next check. We don't wait
        // for that here — the popup polls status separately.
        await setStopRequested(true);
        sendResponse({ ok: true });
      } else if (msg.type === 'mnueron:recall') {
        const result = await recallMemories({
          q: msg.q,
          namespace: msg.namespace,
          k: msg.k ?? 5,
        });
        sendResponse({ ok: true, result });
      } else if (msg.type === 'mnueron:list_namespaces') {
        const result = await listNamespaces();
        sendResponse({ ok: true, result });
      } else if (msg.type === 'mnueron:inject_prompt') {
        // Forward from popup → active tab's content script.
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) { sendResponse({ ok: false, error: 'no active tab' }); return; }
        try {
          const r = await chrome.tabs.sendMessage(tab.id, {
            type: 'mnueron:inject_prompt',
            text: msg.text || '',
          });
          sendResponse(r || { ok: false, error: 'no response from content script' });
        } catch (e) {
          sendResponse({ ok: false, error: 'page has no scraper loaded — reload the tab and try again' });
        }
      } else if (msg.type === 'mnueron:backfill_status') {
        const s = (await chrome.storage.local.get('backfill_progress')).backfill_progress || null;
        sendResponse({ ok: true, status: s });
      } else if (msg.type === 'mnueron:backfill_reset') {
        await chrome.storage.local.remove(['imported_chat_uuids', 'backfill_progress']);
        sendResponse({ ok: true });
      } else if (msg.type === 'mnueron:auto_capture_event') {
        // Content script tells us auto-capture should fire (e.g. user idle).
        const tab = sender.tab;
        if (!tab) return sendResponse({ ok: false, error: 'no tab' });
        const settings = await getSettings();
        if (!settings.auto_capture) return sendResponse({ ok: true, skipped: true });
        const result = await captureFromTab(tab.id, tab.url);
        sendResponse({ ok: true, result });
      } else {
        sendResponse({ ok: false, error: 'unknown message type' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();
  return true;   // keep the channel open for async sendResponse
});

// First install: open options page so the user can set the backend URL.
chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});
