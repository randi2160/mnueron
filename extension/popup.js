/**
 * mnueron popup.
 *
 * On open we:
 *   - check whether the active tab is a supported chat site
 *   - ping the backend
 *   - report today's capture count and auto-capture toggle
 *
 * Click "Capture chat" → ask background to capture from the active tab.
 */

const $ = (id) => document.getElementById(id);

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

async function setBackendStatus() {
  const dot = $('status-dot');
  const line = $('backend-line');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'mnueron:ping' });
    if (res?.status?.ok) {
      dot.classList.remove('off');
      line.textContent = 'connected';
      line.style.color = '#a6ffc4';
    } else {
      dot.classList.add('off');
      line.textContent = 'not reachable';
      line.style.color = '#ffa6b0';
    }
  } catch {
    dot.classList.add('off');
    line.textContent = 'error';
    line.style.color = '#ffa6b0';
  }
}

async function setSiteLine() {
  const tab = await activeTab();
  const site = siteFromUrl(tab?.url);
  const line = $('site-line');
  const btn  = $('capture-btn');
  const captureSection = $('capture-section');
  const unsupportedSection = $('unsupported-section');

  if (site === 'Gemini') {
    // Show the capture section but disabled with explanatory text
    captureSection.style.display = 'block';
    unsupportedSection.style.display = 'none';
    line.innerHTML = `On <span class="name">Gemini</span> — scraper not yet implemented`;
    btn.disabled = true;
  } else if (site) {
    // Supported chat site — capture is live
    captureSection.style.display = 'block';
    unsupportedSection.style.display = 'none';
    line.innerHTML = `On <span class="name">${site}</span>`;
    btn.disabled = false;
  } else {
    // Not on a chat site — swap to the helpful "open a chat site" panel
    captureSection.style.display = 'none';
    unsupportedSection.style.display = 'block';
  }
  // Backfill is only meaningful on claude.ai right now
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

// ─── Event handlers ───────────────────────────────────────────────────────
$('open-options').addEventListener('click', e => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

async function openDashboardTab() {
  const res = await chrome.runtime.sendMessage({ type: 'mnueron:get_settings' });
  const url = res?.settings?.local_url || 'http://localhost:3122';
  chrome.tabs.create({ url });
}

$('open-dashboard').addEventListener('click', openDashboardTab);
$('open-dashboard-alt')?.addEventListener('click', openDashboardTab);

// Quick-go buttons in the unsupported-site panel
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
  const btn = $('backfill-btn');
  const running = $('backfill-btn').dataset.running === '1';

  // No state yet, or never run
  if (!s) {
    box.style.display = 'none';
    btn.textContent = 'Backfill all history';
    btn.disabled = false;
    return;
  }

  // Terminal states (done or error) — only honor them once we're not in mid-click
  if (!running && s.status === 'done') {
    $('backfill-line').textContent =
      `Done — ${s.done || 0} new, ${s.skipped || 0} already imported, ${s.errors || 0} errors`;
    $('backfill-line').style.color = '#a6ffc4';
    $('backfill-bar').style.width = '100%';
    $('backfill-bar').style.background = '#2a5a3a';
    box.style.display = 'block';
    btn.textContent = 'Re-run backfill';
    btn.disabled = false;
    return;
  }
  if (!running && s.status === 'error') {
    $('backfill-line').textContent = `Error — ${s.error || 'unknown failure'}`;
    $('backfill-line').style.color = '#ffa6b0';
    $('backfill-bar').style.width = '100%';
    $('backfill-bar').style.background = '#5a2530';
    box.style.display = 'block';
    btn.textContent = 'Try again';
    btn.disabled = false;
    return;
  }

  // Running (status is 'starting' or 'running', or we're mid-click)
  const total = s.todo || s.total || 1;
  const completed = (s.done || 0) + (s.errors || 0);
  const pct = Math.min(100, Math.round((completed / Math.max(1, total)) * 100));
  $('backfill-line').textContent = `${completed}/${total} — ${s.current || 'fetching list…'}`;
  $('backfill-line').style.color = '#8a92a6';
  $('backfill-bar').style.width = `${Math.max(2, pct)}%`;
  $('backfill-bar').style.background = '#3a5cf0';
  box.style.display = 'block';
  btn.textContent = 'Backfilling…';
  btn.disabled = true;
}

$('backfill-btn').addEventListener('click', async () => {
  $('backfill-btn').dataset.running = '1';
  $('backfill-btn').disabled = true;
  $('backfill-btn').textContent = 'Backfilling…';
  $('backfill-progress').style.display = 'block';
  $('backfill-line').textContent = 'Starting…';
  $('backfill-bar').style.width = '2%';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'mnueron:backfill_start' });
    if (res?.ok) {
      showToast(`✓ Backfill complete — ${res.result.done} new`, 'ok');
    } else {
      showToast(res?.error || 'backfill failed', 'err');
    }
  } catch (e) {
    showToast(e.message, 'err');
  } finally {
    delete $('backfill-btn').dataset.running;
    await refreshBackfillProgress();
    await setTodayCount();
  }
});

// Poll progress every 600ms while popup is open
let backfillPoll = setInterval(refreshBackfillProgress, 600);
window.addEventListener('unload', () => clearInterval(backfillPoll));

// ─── Boot ─────────────────────────────────────────────────────────────────
setSiteLine();
setBackendStatus();
setTodayCount();
setAutoToggle();
refreshBackfillProgress();
