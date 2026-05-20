/**
 * Options page: read settings, write on Save, ping backend on Test, and
 * run a local-to-hosted migration on Migrate.
 */
const $ = (id) => document.getElementById(id);

const FIELDS = ['local_url', 'hosted_url', 'hosted_token', 'namespace_prefix'];
// `notifications` is new in the sidebar redesign (May 2026). Defaults to
// true so existing users start with the friendly notification toast.
const CHECKS = ['auto_capture', 'prefer_hosted', 'ambient_context', 'notifications'];
// Single-select dropdowns (separate from text fields so we can populate
// their <option>s before setting the value).
const SELECTS = ['ambient_namespace'];

// Settings whose default-true behavior we want when the user has never
// touched them. Without this, the first paint shows them as unchecked
// even though the actual runtime behavior is "on". Mirror in background.js
// when adding new ones.
const DEFAULT_TRUE_CHECKS = new Set(['notifications']);

// Hard-coded fallbacks shown in the input boxes when settings storage has
// the field empty. Keep these in sync with DEFAULTS in background.js. Users
// can override either field; we just don't want them staring at a blank box
// when there's an obvious right answer.
const VISIBLE_FALLBACK = {
  local_url:        'http://localhost:3122',
  hosted_url:       'https://mnueron.com',
  namespace_prefix: 'web',
};

async function load() {
  const res = await chrome.runtime.sendMessage({ type: 'mnueron:get_settings' });
  if (!res?.ok) return;
  for (const f of FIELDS) {
    const v = res.settings[f];
    if (v != null && v !== '') {
      $(f).value = v;
    } else if (VISIBLE_FALLBACK[f]) {
      // Pre-fill so the user sees the URL we'd actually use, not blank.
      // Saving without edits will persist this default into storage.
      $(f).value = VISIBLE_FALLBACK[f];
    }
  }
  for (const f of CHECKS) {
    const saved = res.settings[f];
    if (saved === undefined && DEFAULT_TRUE_CHECKS.has(f)) {
      $(f).checked = true;
    } else {
      $(f).checked = !!saved;
    }
  }

  // Load namespace list from the configured backend so the dropdown shows
  // real choices instead of "type a name". Non-blocking; if the backend is
  // unreachable we just leave the dropdown at "All namespaces".
  void loadNamespaceOptions(res.settings.ambient_namespace || '');

  // Auto-test the connection on load so the user lands on a state
  // they can trust ("Connected" pill or "Not connected" pill) without
  // having to click Test connection. Non-blocking.
  void refreshConnectionPill();
}

// ─── Connection-status pill ──────────────────────────────────────────────
// Replaces the old toast for the common "is my token working" check.
// Pings the backend and either fills the green pill or hides it.
async function refreshConnectionPill() {
  const pill = $('connection-pill');
  if (!pill) return;
  const text = $('connection-text');

  pill.className = 'status-pill checking';
  pill.classList.remove('hidden');
  if (text) text.textContent = 'Checking connection…';

  try {
    const res = await chrome.runtime.sendMessage({ type: 'mnueron:ping' });
    if (res?.status?.ok) {
      pill.className = 'status-pill';
      if (text) text.textContent = 'Connected successfully';
    } else {
      pill.className = 'status-pill err';
      if (text) {
        text.textContent =
          res?.status?.error
            ? `Not connected — ${res.status.error}`
            : 'Not connected — check your token';
      }
    }
  } catch (e) {
    pill.className = 'status-pill err';
    if (text) text.textContent = `Connection check failed: ${e?.message ?? e}`;
  }
}

async function loadNamespaceOptions(selectedValue) {
  const sel = $('ambient_namespace');
  try {
    const r = await chrome.runtime.sendMessage({ type: 'mnueron:list_namespaces' });
    const list = Array.isArray(r?.result) ? r.result : [];
    // Keep the leading "All namespaces" option, then append each namespace.
    while (sel.options.length > 1) sel.remove(1);
    for (const ns of list) {
      if (!ns?.name) continue;
      const opt = document.createElement('option');
      opt.value = ns.name;
      opt.textContent = `${ns.name}  (${ns.count ?? 0})`;
      sel.appendChild(opt);
    }
    // If the saved value isn't in the list (deleted namespace, etc.), keep
    // it as a separate option so the user still sees what they picked.
    if (selectedValue && !list.find((n) => n?.name === selectedValue)) {
      const opt = document.createElement('option');
      opt.value = selectedValue;
      opt.textContent = `${selectedValue}  (offline)`;
      sel.appendChild(opt);
    }
    sel.value = selectedValue || '';
  } catch {
    sel.value = selectedValue || '';
  }
}

async function save() {
  const patch = {};
  for (const f of FIELDS) patch[f] = $(f).value.trim();
  for (const f of CHECKS) patch[f] = $(f).checked;
  for (const f of SELECTS) patch[f] = $(f).value;
  const res = await chrome.runtime.sendMessage({ type: 'mnueron:set_settings', patch });
  if (res?.ok) toast('Saved.', 'ok');
  else toast('Save failed.', 'err');
}

async function testConnection() {
  toast('Pinging…');
  const res = await chrome.runtime.sendMessage({ type: 'mnueron:ping' });
  if (res?.status?.ok) toast('Backend reachable ✓', 'ok');
  else toast(`Cannot reach backend: ${res?.status?.error || 'unknown error'}`, 'err');
}

function toast(msg, kind = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast show ${kind}`;
  setTimeout(() => { t.className = `toast ${kind}`; }, 3500);
}

// ─── Migrate local → hosted ──────────────────────────────────────────────
async function migrate() {
  const local = $('local_url').value.trim() || 'http://localhost:3122';
  const hosted = $('hosted_url').value.trim();
  const token = $('hosted_token').value.trim();

  if (!hosted || !token) {
    toast('Set Hosted URL + Bearer token first, then Save.', 'err');
    return;
  }

  const btn = $('migrate');
  const box = $('migrate-progress');
  const line = $('migrate-line');
  const bar = $('migrate-bar');
  btn.disabled = true;
  box.style.display = 'block';
  line.textContent = 'Fetching local memories…';
  bar.style.width = '4%';
  bar.style.background = '#5b2cff';

  try {
    // Pull pages of 200 until we've seen them all. Local dashboard's
    // /api/memories supports limit + offset.
    const all = [];
    let offset = 0;
    const PAGE = 200;
    while (true) {
      const r = await fetch(`${local.replace(/\/$/, '')}/api/memories?limit=${PAGE}&offset=${offset}`);
      if (!r.ok) throw new Error(`local API ${r.status}`);
      const batch = await r.json();
      if (!Array.isArray(batch) || batch.length === 0) break;
      all.push(...batch);
      if (batch.length < PAGE) break;
      offset += PAGE;
    }

    if (all.length === 0) {
      line.textContent = 'No memories in local store. Nothing to migrate.';
      line.style.color = '#ffd6a6';
      bar.style.width = '100%';
      bar.style.background = '#8a8a3a';
      btn.disabled = false;
      return;
    }

    line.textContent = `Found ${all.length} memories. Uploading to ${hosted}…`;

    // Upload one at a time so a partial failure doesn't lose everything.
    // The hosted API dedupes by source_ref on the server side (when
    // present), so re-running this is idempotent.
    let pushed = 0, failed = 0;
    for (let i = 0; i < all.length; i++) {
      const m = all[i];
      try {
        const r = await fetch(`${hosted.replace(/\/$/, '')}/api/memories`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({
            content: m.content,
            namespace: m.namespace,
            tags: m.tags ?? [],
            source: m.source,
            source_ref: m.source_ref,
            metadata: m.metadata ?? {},
          }),
        });
        if (r.ok || r.status === 201) {
          pushed++;
        } else {
          failed++;
          console.warn('[mnueron] migrate row failed', m.id, r.status);
        }
      } catch (e) {
        failed++;
        console.warn('[mnueron] migrate row exception', m.id, e);
      }
      const pct = Math.min(100, Math.round(((i + 1) / all.length) * 100));
      bar.style.width = `${pct}%`;
      if ((i + 1) % 5 === 0 || i === all.length - 1) {
        line.textContent = `${i + 1}/${all.length} — ${pushed} ok, ${failed} failed`;
      }
    }

    if (failed === 0) {
      line.textContent = `Done — ${pushed}/${all.length} memories migrated to ${hosted}.`;
      line.style.color = '#a6ffc4';
      bar.style.background = '#2a5a3a';
      toast('Migration complete ✓', 'ok');
    } else {
      line.textContent = `Finished with errors — ${pushed} ok, ${failed} failed. Check the browser console for details.`;
      line.style.color = '#ffa6b0';
      bar.style.background = '#5a2530';
      toast(`Migration finished with ${failed} errors`, 'err');
    }
  } catch (e) {
    line.textContent = `Error: ${e.message}`;
    line.style.color = '#ffa6b0';
    bar.style.background = '#5a2530';
    toast(`Migration failed: ${e.message}`, 'err');
  } finally {
    btn.disabled = false;
  }
}

async function resetBackfill() {
  if (!confirm("Clear the 'already imported' cache? Next Backfill run will re-process every Claude chat through the latest scraper.")) {
    return;
  }
  const res = await chrome.runtime.sendMessage({ type: 'mnueron:backfill_reset' });
  if (res?.ok) {
    toast('Backfill cache cleared — open the popup and click Backfill to re-pull.', 'ok');
  } else {
    toast('Clear failed.', 'err');
  }
}

$('save').addEventListener('click', save);
$('test').addEventListener('click', () => {
  // The new design has both a Test button AND the live status pill.
  // Run both so the user sees instant feedback either way.
  testConnection();
  void refreshConnectionPill();
});
$('migrate').addEventListener('click', migrate);
$('reset-backfill').addEventListener('click', resetBackfill);

// ─── Sidebar nav: swap the active .page block on click ────────────────────
// One click handler delegated to the navlist container.
document.getElementById('navlist').addEventListener('click', (e) => {
  const btn = e.target.closest('.nav-btn');
  if (!btn) return;
  const target = btn.dataset.page;
  if (!target) return;
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.page').forEach((p) => {
    p.classList.toggle('active', p.id === `page-${target}`);
  });
  // Scroll the content pane to top on section change so long forms don't
  // start in the middle.
  document.querySelector('.content')?.scrollTo({ top: 0, behavior: 'instant' });
});

// ─── Show/hide API token via the eye icon ────────────────────────────────
document.getElementById('toggle-token-visibility')?.addEventListener('click', () => {
  const inp = $('hosted_token');
  inp.type = inp.type === 'password' ? 'text' : 'password';
});

// ─── Re-check connection when the user pastes a new token ────────────────
// Debounced — wait until they stop typing for 800ms so we don't spam the
// backend on every keystroke.
let _connRecheckTimer = null;
$('hosted_token')?.addEventListener('input', () => {
  clearTimeout(_connRecheckTimer);
  _connRecheckTimer = setTimeout(() => {
    void refreshConnectionPill();
  }, 800);
});

// ─── About page: fill version + commit info from the manifest ────────────
try {
  const m = chrome.runtime.getManifest();
  const v = document.getElementById('about-version');
  if (v && m?.version) v.textContent = `v${m.version}`;
} catch {
  /* getManifest is sync + reliable, but fail-soft anyway */
}

load();
