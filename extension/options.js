/**
 * Options page: read settings, write on Save, ping backend on Test, and
 * run a local-to-hosted migration on Migrate.
 */
const $ = (id) => document.getElementById(id);

const FIELDS = ['local_url', 'hosted_url', 'hosted_token', 'namespace_prefix'];
const CHECKS = ['auto_capture', 'prefer_hosted', 'ambient_context'];

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
  for (const f of CHECKS) $(f).checked = !!res.settings[f];
}

async function save() {
  const patch = {};
  for (const f of FIELDS) patch[f] = $(f).value.trim();
  for (const f of CHECKS) patch[f] = $(f).checked;
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

$('save').addEventListener('click', save);
$('test').addEventListener('click', testConnection);
$('migrate').addEventListener('click', migrate);
load();
