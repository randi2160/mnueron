/**
 * Options page: read current settings, write back on Save, ping backend on Test.
 */
const $ = (id) => document.getElementById(id);

const FIELDS = ['local_url', 'hosted_url', 'hosted_token', 'namespace_prefix'];
const CHECKS = ['auto_capture', 'prefer_hosted'];

async function load() {
  const res = await chrome.runtime.sendMessage({ type: 'mnueron:get_settings' });
  if (!res?.ok) return;
  for (const f of FIELDS) {
    if (res.settings[f] != null) $(f).value = res.settings[f];
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

$('save').addEventListener('click', save);
$('test').addEventListener('click', testConnection);
load();
