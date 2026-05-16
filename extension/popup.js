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

// ─── Boot ─────────────────────────────────────────────────────────────────
renderBackendMode();
setTodayCount();
setAutoToggle();
refreshBackfillProgress();
