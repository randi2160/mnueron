/**
 * mnueron popup.
 *
 * On open:
 *   - detect supported chat site in active tab
 *   - render current backend mode (Local/Hosted) + connection state
 *   - report today's capture count and auto-capture toggle
 *   - show backfill progress / Stop button if a run is in flight
 *
 * Click handlers:
 *   - Capture chat → asks background to scrape active tab and save
 *   - Local/Hosted toggle → updates `prefer_hosted` setting + re-checks ping
 *   - Sign in to hosted → opens mnueron.com/account-settings/tokens
 *   - Backfill all history → starts (or resumes) the claude.ai backfill
 *   - Stop → asks background to pause cleanly between iterations
 */

const $ = (id) => document.getElementById(id);

const HOSTED_TOKENS_URL = 'https://mnueron.com/account-settings/tokens';

const SUPPORTED = {
  'claude.ai':           'Claude',
  'chatgpt.com':         'ChatGPT',
  'chat.openai.com':     'ChatGPT',
  'gemini.google.com':   'Gemini',
};

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function siteFromUrl(url) {
  try {
    const u = new URL(url);
    return SUPPORTED[u.hostname] || null;
  } catch { return null; }
}

// ─── Backend mode toggle ──────────────────────────────────────────────────
async function renderBackendMode() {
  const res = await chrome.runtime.sendMessage({ type: 'mnueron:get_settings' });
  const s = res?.settings ?? {};
  const isHosted = !!s.prefer_hosted;

  $('mode-local').classList.toggle('active', !isHosted);
  $('mode-hosted').classList.toggle('active', isHosted);

  if (isHosted) {
    const url = (s.hosted_url || 'https://mnueron.com').replace(/^https?:\/\//, '');
    $('backend-url-line').textContent = url;
    const hasToken = !!(s.hosted_token && s.hosted_token.trim());
    $('hosted-signin-btn').style.display = hasToken ? 'none' : 'block';
    // Backfill is local-only for now (hits the user's claude.ai tab + local
    // import script). Hide it when in hosted mode to avoid confusion.
    $('backfill-section').style.display = 'none';
  } else {
    const url = (s.local_url || 'http://localhost:3122').replace(/^https?:\/\//, '');
    $('backend-url-line').textContent = url;
    $('hosted-signin-btn').style.display = 'none';
  }

  await setBackendStatus();
  // Re-evaluate backfill visibility based on tab + mode
  await setSiteLine();
}

async function setMode(prefer_hosted) {
  await chrome.runtime.sendMessage({
    type: 'mnueron:set_settings',
    patch: { prefer_hosted },
  });
  await renderBackendMode();
}

$('mode-local').addEventListener('click',  () => setMode(false));
$('mode-hosted').addEventListener('click', () => setMode(true));

$('hosted-signin-btn').addEventListener('click', () => {
  chrome.tabs.create({ url: HOSTED_TOKENS_URL });
});

// ─── Backend connection status ────────────────────────────────────────────
async function setBackendStatus() {
  const dot = $('status-dot');
  const state = $('backend-state');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'mnueron:ping' });
    if (res?.status?.ok) {
      dot.classList.remove('off');
      state.textContent = 'connected';
      state.className = 'state ok';
    } else {
      dot.classList.add('off');
      state.textContent = res?.status?.error?.slice(0, 24) || 'not reachable';
      state.className = 'state err';
    }
  } catch {
    dot.classList.add('off');
    state.textContent = 'error';
    state.className = 'state err';
  }
}

// ─── Site detection ───────────────────────────────────────────────────────
async function setSiteLine() {
  const tab = await activeTab();
  const site = siteFromUrl(tab?.url);
  const line = $('site-line');
  const btn  = $('capture-btn');
  const captureSection = $('capture-section');
  const unsupportedSection = $('unsupported-section');

  if (site === 'Gemini') {
    captureSection.style.display = 'block';
    unsupportedSection.style.display = 'none';
    line.innerHTML = `On <span class="name">Gemini</span> — scraper not yet implemented`;
    btn.disabled = true;
  } else if (site) {
    captureSection.style.display = 'block';
    unsupportedSection.style.display = 'none';
    line.innerHTML = `On <span class="name">${site}</span>`;
    btn.disabled = false;
  } else {
    captureSection.style.display = 'none';
    unsupportedSection.style.display = 'block';
  }

  // Backfill is Claude-only AND local-only (uses claude.ai's internal API +
  // pipes to the configured backend; we keep it visible regardless of mode
  // but it'll write to whichever backend is currently selected).
  $('backfill-section').style.display = (site === 'Claude') ? 'block' : 'none';
}

async function setTodayCount() {
  const today = new Date().toISOString().slice(0, 10);
  const k = `count_${today}`;
  const res = await chrome.storage.local.get(k);
  $('today-line').textContent = res[k] || 0;
}

async function setAutoToggle() {
  const res = await chrome.runtime.sendMessage({ type: 'mnueron:get_settings' });
  if (res?.ok) $('auto-toggle').checked = !!res.settings.auto_capture;
}

function showToast(msg, kind = 'ok') {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast show ${kind}`;
  setTimeout(() => { t.className = `toast ${kind}`; }, 4000);
}

// ─── Capture button ───────────────────────────────────────────────────────
$('open-options').addEventListener('click', e => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

async function openDashboardTab() {
  const res = await chrome.runtime.sendMessage({ type: 'mnueron:get_settings' });
  const s = res?.settings ?? {};
  // Mirror background.js's backendBase() resolution exactly: when Hosted is
  // on, ALWAYS land at the cloud /dashboard (default mnueron.com), even if
  // hosted_url is somehow blank. Local mode opens the local dashboard root.
  let url;
  if (s.prefer_hosted) {
    const base = (s.hosted_url || 'https://mnueron.com').replace(/\/$/, '');
    url = `${base}/dashboard`;
  } else {
    url = (s.local_url || 'http://localhost:3122').replace(/\/$/, '');
  }
  chrome.tabs.create({ url });
}

$('open-dashboard').addEventListener('click', openDashboardTab);
$('open-dashboard-alt')?.addEventListener('click', openDashboardTab);

document.querySelectorAll('[data-go]').forEach(el => {
  el.addEventListener('click', () => {
    const url = el.getAttribute('data-go');
    if (url) chrome.tabs.create({ url });
  });
});

$('capture-btn').addEventListener('click', async () => {
  $('capture-btn').disabled = true;
  $('capture-btn').textContent = 'Capturing…';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'mnueron:capture' });
    if (res?.ok) {
      showToast(`✓ Captured ${res.result.message_count} messages → ${res.result.namespace}`, 'ok');
      await setTodayCount();
    } else {
      showToast(res?.error || 'capture failed', 'err');
    }
  } catch (e) {
    showToast(e.message, 'err');
  } finally {
    $('capture-btn').textContent = 'Capture chat';
    $('capture-btn').disabled = false;
  }
});

$('auto-toggle').addEventListener('change', async e => {
  await chrome.runtime.sendMessage({
    type: 'mnueron:set_settings',
    patch: { auto_capture: e.target.checked },
  });
});

// ─── Backfill ─────────────────────────────────────────────────────────────
async function refreshBackfillProgress() {
  const res = await chrome.runtime.sendMessage({ type: 'mnueron:backfill_status' });
  const s = res?.status;
  const box = $('backfill-progress');
  const startBtn = $('backfill-btn');
  const stopBtn  = $('backfill-stop-btn');

  if (!s) {
    box.style.display = 'none';
    startBtn.textContent = 'Backfill all history';
    startBtn.disabled = false;
    stopBtn.style.display = 'none';
    return;
  }

  // Terminal states: done / error / paused — Start/Resume button reappears
  if (s.status === 'done') {
    $('backfill-line').textContent =
      `Done — ${s.done || 0} new, ${s.skipped || 0} already imported, ${s.errors || 0} errors`;
    $('backfill-line').style.color = '#a6ffc4';
    $('backfill-bar').style.width = '100%';
    $('backfill-bar').style.background = '#2a5a3a';
    box.style.display = 'block';
    startBtn.textContent = 'Re-run backfill';
    startBtn.disabled = false;
    stopBtn.style.display = 'none';
    return;
  }
  if (s.status === 'error') {
    $('backfill-line').textContent = `Error — ${s.error || 'unknown failure'}`;
    $('backfill-line').style.color = '#ffa6b0';
    $('backfill-bar').style.width = '100%';
    $('backfill-bar').style.background = '#5a2530';
    box.style.display = 'block';
    startBtn.textContent = 'Try again';
    startBtn.disabled = false;
    stopBtn.style.display = 'none';
    return;
  }
  if (s.status === 'paused') {
    const total = s.todo || s.total || 1;
    const completed = (s.done || 0) + (s.errors || 0);
    const pct = Math.min(100, Math.round((completed / Math.max(1, total)) * 100));
    $('backfill-line').textContent = `Paused — ${completed}/${total}. Click Resume to continue.`;
    $('backfill-line').style.color = '#ffd6a6';
    $('backfill-bar').style.width = `${Math.max(2, pct)}%`;
    $('backfill-bar').style.background = '#5a8a3a';
    box.style.display = 'block';
    startBtn.textContent = 'Resume backfill';
    startBtn.disabled = false;
    stopBtn.style.display = 'none';
    return;
  }

  // Active (starting / running)
  const total = s.todo || s.total || 1;
  const completed = (s.done || 0) + (s.errors || 0);
  const pct = Math.min(100, Math.round((completed / Math.max(1, total)) * 100));
  $('backfill-line').textContent = `${completed}/${total} — ${s.current || 'fetching list…'}`;
  $('backfill-line').style.color = '#8a92a6';
  $('backfill-bar').style.width = `${Math.max(2, pct)}%`;
  $('backfill-bar').style.background = '#3a5cf0';
  box.style.display = 'block';
  startBtn.textContent = 'Backfilling…';
  startBtn.disabled = true;
  stopBtn.style.display = 'block';
}

$('backfill-btn').addEventListener('click', async () => {
  $('backfill-btn').disabled = true;
  $('backfill-btn').textContent = 'Backfilling…';
  $('backfill-progress').style.display = 'block';
  $('backfill-line').textContent = 'Starting…';
  $('backfill-bar').style.width = '2%';
  $('backfill-stop-btn').style.display = 'block';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'mnueron:backfill_start' });
    if (res?.ok) {
      if (res.result?.paused) {
        showToast('Backfill paused', 'ok');
      } else {
        showToast(`✓ Backfill complete — ${res.result.done} new`, 'ok');
      }
    } else {
      showToast(res?.error || 'backfill failed', 'err');
    }
  } catch (e) {
    showToast(e.message, 'err');
  } finally {
    await refreshBackfillProgress();
    await setTodayCount();
  }
});

$('backfill-stop-btn').addEventListener('click', async () => {
  $('backfill-stop-btn').textContent = 'Stopping…';
  $('backfill-stop-btn').disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: 'mnueron:backfill_stop' });
    // Poll will pick up the 'paused' state and re-render shortly.
    showToast('Stopping…', 'ok');
  } catch (e) {
    showToast(e.message, 'err');
  } finally {
    setTimeout(() => {
      $('backfill-stop-btn').textContent = 'Stop';
      $('backfill-stop-btn').disabled = false;
    }, 1500);
  }
});

let backfillPoll = setInterval(refreshBackfillProgress, 600);
window.addEventListener('unload', () => clearInterval(backfillPoll));

// ─── Recall: search memories + insert into the page's prompt ─────────────
//
// Pattern:
//   1. User types a query, hits Search (or Enter).
//   2. We ask background to fetch top-5 from the configured backend.
//   3. Render each as a card with a preview + "Insert" button.
//   4. Click Insert → background forwards to active tab's content script,
//      which finds the prompt input and pastes the memory content.
//
// Only shows the section on supported chat sites (otherwise Insert is a
// no-op).
// Memories currently shown in the Recall results. Indexed by id so we can
// rebuild the "build prompt" output from the selection without re-fetching.
const recallById = new Map();
const recallSelected = new Set();

async function doRecall() {
  const q = $('recall-q').value.trim();
  const resultsEl = $('recall-results');
  if (!q) {
    resultsEl.innerHTML = '';
    recallById.clear();
    recallSelected.clear();
    renderRecallFooter();
    return;
  }
  $('recall-go').disabled = true;
  $('recall-go').textContent = '…';
  resultsEl.innerHTML = '<div style="color:#6c7488; font-size:12px; padding:6px 0;">Searching…</div>';

  try {
    // Unified recall: returns { memories, procedurals }. We render runbooks
    // first (action-oriented; more useful when the user is asking how to do
    // something) then memories. Falls back to the legacy shape if the
    // backend's older — see recallUnified() in background.js.
    const res = await chrome.runtime.sendMessage({ type: 'mnueron:recall_unified', q, k: 5 });
    if (!res?.ok) {
      resultsEl.innerHTML = `<div style="color:#ffa6b0; font-size:12px;">${res?.error || 'recall failed'}</div>`;
      return;
    }

    // Defensive shape-handling: support BOTH the new unified shape
    // ({memories, procedurals}) AND any older self-hosted backend that
    // might still return a flat array. Either way we end up with `items`
    // as a single ordered list the existing card renderer can process.
    let items = [];
    if (Array.isArray(res.result)) {
      // Legacy flat-array fallback.
      items = res.result;
    } else if (res.result && typeof res.result === 'object') {
      const procedurals = Array.isArray(res.result.procedurals) ? res.result.procedurals : [];
      const memories    = Array.isArray(res.result.memories)    ? res.result.memories    : [];
      // Synthesize each runbook as a memory-shaped card so the existing
      // renderer + Insert + Open paths work unchanged. The `_isRunbook`
      // flag lets openMemoryInDashboard route to /dashboard/procedural.
      const runbookCards = procedurals.map(p => synthRunbookCard(p));
      items = [...runbookCards, ...memories];
    }

    recallById.clear();
    // Fresh search clears prior selection — IDs from the new result set
    // are the only valid selections going forward.
    recallSelected.clear();
    items.forEach((m) => recallById.set(m.id, m));

    if (items.length === 0) {
      resultsEl.innerHTML = '<div style="color:#6c7488; font-size:12px;">No matches.</div>';
      renderRecallFooter();
      return;
    }
    resultsEl.innerHTML = '';
    items.forEach((m, i) => resultsEl.appendChild(renderResult(m, i)));
    renderRecallFooter();
  } catch (e) {
    resultsEl.innerHTML = `<div style="color:#ffa6b0; font-size:12px;">${e.message}</div>`;
  } finally {
    $('recall-go').disabled = false;
    $('recall-go').textContent = 'Search';
  }
}

// Sticky-ish footer under the results. Hidden when nothing is selected.
function renderRecallFooter() {
  let footer = document.getElementById('recall-footer');
  if (!footer) {
    footer = document.createElement('div');
    footer.id = 'recall-footer';
    footer.style.cssText = 'margin-top:8px; padding-top:8px; border-top:1px solid #161a26; display:none;';
    $('recall-results').parentElement.appendChild(footer);
  }
  const n = recallSelected.size;
  if (n === 0) {
    footer.style.display = 'none';
    footer.innerHTML = '';
    return;
  }
  footer.style.display = 'block';
  footer.innerHTML = `
    <div style="display:flex; gap:6px;">
      <button id="recall-copy" style="flex:1; padding:7px 12px; font-size:12px;">
        Copy ${n} as prompt
      </button>
      <button id="recall-clear" class="secondary" style="width:auto; padding:7px 12px; font-size:12px; margin-top:0;">
        Clear
      </button>
    </div>
    <p style="margin:6px 0 0; font-size:11px; color:#6c7488;">
      Generates a markdown block you can paste into Cowork / ChatGPT / anywhere.
    </p>
  `;
  document.getElementById('recall-copy').addEventListener('click', copySelectedAsPrompt);
  document.getElementById('recall-clear').addEventListener('click', () => {
    recallSelected.clear();
    // Re-render cards to clear checkboxes
    const resultsEl = $('recall-results');
    resultsEl.innerHTML = '';
    [...recallById.values()].forEach((m, i) => resultsEl.appendChild(renderResult(m, i)));
    renderRecallFooter();
  });
}

async function copySelectedAsPrompt() {
  const selected = [...recallSelected].map((id) => recallById.get(id)).filter(Boolean);
  if (selected.length === 0) return;

  const blocks = selected.map((m, i) => {
    const title =
      (m.metadata && m.metadata.title) ||
      (m.content || m.content_preview || 'memory').replace(/\s+/g, ' ').slice(0, 80);
    const date = new Date(m.created_at || Date.now()).toISOString().slice(0, 10);
    const body = (m.content || m.content_preview || '').trim();
    return `<memory ${i + 1} namespace="${m.namespace}" date="${date}">\ntitle: ${title}\n\n${body}\n</memory ${i + 1}>`;
  });

  const text = [
    "Here is context from my mnueron memory store. Absorb it, then I'll ask my real question.",
    '',
    blocks.join('\n\n'),
    '',
    "(End of context. Acknowledge briefly and I'll send my actual question.)",
  ].join('\n');

  try {
    await navigator.clipboard.writeText(text);
    showToast(`Copied ${selected.length} memor${selected.length === 1 ? 'y' : 'ies'} → paste anywhere`, 'ok');
  } catch (e) {
    // Fallback for non-HTTPS contexts where clipboard API is denied.
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      showToast(`Copied ${selected.length} memor${selected.length === 1 ? 'y' : 'ies'}`, 'ok');
    } catch {
      showToast('Copy failed — clipboard blocked', 'err');
    } finally {
      document.body.removeChild(ta);
    }
  }
}

function renderResult(m, i) {
  const card = document.createElement('div');
  card.style.cssText = 'background:#11141c; border:1px solid #1f2330; border-radius:8px; padding:8px 10px; margin-top:6px;';
  const content = (m.content || m.content_preview || '').replace(/\s+/g, ' ').slice(0, 200);
  const title = (m.metadata?.title || m.namespace || `memory ${i + 1}`).slice(0, 60);
  const meta = m.namespace ? `${m.namespace}` : '';
  const checked = recallSelected.has(m.id) ? 'checked' : '';

  card.innerHTML = `
    <div style="display:flex; gap:8px; align-items:flex-start;">
      <input type="checkbox" class="select-cb" data-id="${escapeHtml(m.id)}" ${checked}
        style="margin-top:2px; accent-color:#5b2cff;" />
      <div style="min-width:0; flex:1;">
        <div style="font-size:12px; font-weight:600; color:#d6dae3; margin-bottom:2px;">${escapeHtml(title)}</div>
        <div style="font-size:11px; color:#6c7488; margin-bottom:6px;">${escapeHtml(meta)}</div>
        <div style="font-size:12px; color:#8a92a6; line-height:1.4; margin-bottom:8px;">${escapeHtml(content)}${content.length === 200 ? '…' : ''}</div>
        <div style="display:flex; gap:6px;">
          <button class="insert-btn" data-idx="${i}" style="width:auto; padding:5px 10px; font-size:11px;">Insert</button>
          <button class="open-btn" data-idx="${i}" style="width:auto; padding:5px 10px; font-size:11px;">Open in dashboard</button>
        </div>
      </div>
    </div>
  `;
  card.querySelector('.open-btn').classList.add('secondary');
  card.querySelector('.insert-btn').addEventListener('click', () => insertMemory(m));
  card.querySelector('.open-btn').addEventListener('click', () => openMemoryInDashboard(m));
  card.querySelector('.select-cb').addEventListener('change', (ev) => {
    if (ev.target.checked) recallSelected.add(m.id);
    else recallSelected.delete(m.id);
    renderRecallFooter();
  });
  return card;
}

function escapeHtml(s) {
  return (s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function insertMemory(m) {
  const text = m.content || m.content_preview || '';
  if (!text) {
    showToast('memory has no content to insert', 'err');
    return;
  }
  const res = await chrome.runtime.sendMessage({ type: 'mnueron:inject_prompt', text });
  if (res?.ok) {
    showToast('Inserted into prompt ✓', 'ok');
    // Auto-close the popup so the user can finish typing — small UX win.
    setTimeout(() => window.close(), 600);
  } else {
    showToast(res?.error || 'inject failed', 'err');
  }
}

async function openMemoryInDashboard(m) {
  const settingsRes = await chrome.runtime.sendMessage({ type: 'mnueron:get_settings' });
  const s = settingsRes?.settings ?? {};
  const base = s.prefer_hosted
    ? (s.hosted_url || 'https://mnueron.com').replace(/\/$/, '')
    : (s.local_url || 'http://localhost:3122').replace(/\/$/, '');

  // Runbooks live in /dashboard/procedural, not /dashboard. Detect via the
  // _isRunbook flag synthRunbookCard stamps.
  if (m._isRunbook) {
    chrome.tabs.create({ url: `${base}/dashboard/procedural` });
    return;
  }

  // Mark a hash so the dashboard could deep-link to the memory in the
  // future. Today the dashboard just lands you on the list.
  chrome.tabs.create({ url: `${base}/dashboard#memory=${encodeURIComponent(m.id)}` });
}

/**
 * Build a memory-shaped object from a procedural memory so the existing
 * renderResult() / Insert / Open paths work unchanged.
 *
 * Visual cues that mark it as a runbook:
 *   - title prefixed with ▶
 *   - namespace shown as "runbook"
 *   - content is the joined step list, so Insert pastes a runnable recipe
 *   - _isRunbook flag routes Open to /dashboard/procedural
 *
 * Procedural IDs are UUIDs so they can't collide with memory IDs in the
 * recallById map.
 */
function synthRunbookCard(p) {
  const summary = (p.summary || '').trim();
  const stepText = (p.steps || [])
    .map((s, i) => {
      const desc = (s.description || '').trim();
      const cmd  = s.command ? `\n   $ ${String(s.command).trim()}` : '';
      const chk  = s.check   ? `\n   → check: ${String(s.check).trim()}` : '';
      return `${i + 1}. ${desc}${cmd}${chk}`;
    })
    .join('\n');

  const triggerLine = (p.trigger_phrases || []).length > 0
    ? `Triggers: ${(p.trigger_phrases || []).join(', ')}\n\n`
    : '';

  const content = [summary, triggerLine + stepText].filter(Boolean).join('\n\n').trim();

  return {
    id: p.id,
    namespace: 'runbook',
    content,
    metadata: {
      title: `▶ ${p.title || 'Untitled runbook'}`,
      runbook: true,
      runbook_id: p.id,
      trigger_phrases: p.trigger_phrases || [],
      success_count: p.success_count ?? 0,
      failure_count: p.failure_count ?? 0,
    },
    created_at: p.last_used_at || p.updated_at || p.created_at || Date.now(),
    _isRunbook: true,
  };
}

$('recall-go').addEventListener('click', doRecall);
$('recall-q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doRecall();
});

// ─── Boot ─────────────────────────────────────────────────────────────────
renderBackendMode();
setTodayCount();
setAutoToggle();
refreshBackfillProgress();
