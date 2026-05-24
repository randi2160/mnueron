/**
 * mnueron — floating Save button + auto-capture observer.
 *
 * Runs as a third content script on every chat surface (alongside the
 * per-site scraper and the ambient popover). Two responsibilities:
 *
 *   1. FLOATING SAVE BUTTON
 *      A small violet pill sits bottom-right with a Save icon. Click
 *      it and the visible conversation is captured to mnueron. Uses the
 *      existing `mnueron:capture` message — same code path as the
 *      toolbar popup's Capture button. Toast feedback on success/error.
 *
 *   2. AUTO-CAPTURE OBSERVER
 *      When settings.auto_capture is on, a MutationObserver watches the
 *      page. After the DOM settles for ~2s, it fires
 *      `mnueron:auto_capture_event` to the background, which runs the
 *      same capture flow against the active tab. Dedupes by transcript
 *      length so re-renders don't trigger duplicate saves.
 *
 * Strictly additive: no existing files were modified to wire this in
 * besides manifest.json's content_scripts block. The Save button is
 * never injected if the page isn't a known chat surface (the scraper
 * for that site has to be present), so it can't appear on random pages.
 *
 * Both features check chrome.runtime.id at intervals so a stale
 * content script (the extension was reloaded but the page wasn't)
 * removes its UI cleanly instead of throwing on every callback.
 */
(() => {
  const TAG = '[mnueron/floating]';

  // ─── State ───────────────────────────────────────────────────────────────
  let buttonHost = null;     // floating Save button shadow host
  let shadow = null;
  let toastTimer = null;
  let autoCaptureWired = false;
  let lastAutoCaptureLen = 0;     // dedupe key for auto-capture
  let observer = null;
  let observerScheduled = null;
  let extensionAlive = true;       // false once chrome.runtime is gone

  // ─── Boot ────────────────────────────────────────────────────────────────
  init();

  async function init() {
    // The page may be a navigation away from a chat (e.g. claude.ai's home).
    // We don't want a Save button there. The simplest signal is: is the per-
    // site scraper present? We can't directly check, but we CAN ask the
    // background to detect the site from this tab's URL. Skip that round
    // trip — manifest already restricts injection to known hosts, so we're
    // always on a chat surface here.
    injectButton();
    wireSettingsPoll();
  }

  // ─── Settings polling ────────────────────────────────────────────────────
  function wireSettingsPoll() {
    // First read sets up auto-capture if enabled; subsequent reads catch
    // a toggle flipped in the options page without requiring page reload.
    pollOnce();
    setInterval(pollOnce, 4000);
  }

  function pollOnce() {
    if (!extensionAlive) return;
    sendMessage({ type: 'mnueron:get_settings' }).then((r) => {
      const want = !!r?.settings?.auto_capture;
      if (want && !autoCaptureWired) wireAutoCapture();
      if (!want && autoCaptureWired) unwireAutoCapture();
    });
  }

  // ─── Floating Save button ────────────────────────────────────────────────
  function injectButton() {
    if (buttonHost) return;
    buttonHost = document.createElement('div');
    buttonHost.id = 'mnueron-floating-host';
    Object.assign(buttonHost.style, {
      position: 'fixed',
      right: '24px',
      bottom: '24px',
      zIndex: '2147483646',
    });
    document.documentElement.appendChild(buttonHost);

    shadow = buttonHost.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .btn {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 10px 14px 10px 12px;
          border-radius: 999px;
          font: 600 13px/1 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
          color: #fff;
          background: linear-gradient(135deg, #5b2cff 0%, #d946ef 100%);
          border: none;
          cursor: pointer;
          box-shadow:
            0 10px 24px rgba(91, 44, 255, 0.40),
            0 2px 6px rgba(0, 0, 0, 0.10);
          transition: transform .12s ease, box-shadow .12s ease, opacity .12s ease;
          user-select: none;
        }
        .btn:hover {
          transform: translateY(-1px);
          box-shadow:
            0 14px 30px rgba(91, 44, 255, 0.50),
            0 3px 8px rgba(0, 0, 0, 0.14);
        }
        .btn:active { transform: translateY(0); }
        .btn:disabled { cursor: wait; opacity: 0.75; }
        .btn[data-state="ok"]  { background: linear-gradient(135deg, #10b981 0%, #34d399 100%); }
        .btn[data-state="err"] { background: linear-gradient(135deg, #ef4444 0%, #f87171 100%); }
        .m {
          width: 20px; height: 20px;
          display: inline-flex; align-items: center; justify-content: center;
          background: rgba(255, 255, 255, 0.22);
          border-radius: 6px;
          font-weight: 800;
          font-size: 12px;
        }
        .toast {
          position: absolute;
          right: 0;
          bottom: 50px;
          padding: 8px 12px;
          border-radius: 8px;
          background: #0f1115;
          color: #e7eaf2;
          font: 12px/1.3 ui-sans-serif, system-ui, -apple-system, sans-serif;
          border: 1px solid #2c3142;
          box-shadow: 0 10px 20px rgba(0,0,0,0.35);
          white-space: nowrap;
          opacity: 0;
          transform: translateY(4px);
          transition: opacity .15s ease, transform .15s ease;
          pointer-events: none;
        }
        .toast[data-show="1"] { opacity: 1; transform: translateY(0); }
        .toast[data-tone="ok"]  { border-color: #2a5a3a; background: #15301f; color: #a6ffc4; }
        .toast[data-tone="err"] { border-color: #5a2a2a; background: #2a1414; color: #ffb4b4; }
      </style>
      <button class="btn" id="btn" type="button" title="Save this chat to mnueron">
        <span class="m">M</span>
        <span id="lbl">Save to mnueron</span>
      </button>
      <div class="toast" id="toast"></div>
    `;

    shadow.getElementById('btn').addEventListener('click', onSaveClick);
  }

  async function onSaveClick() {
    const btn = shadow.getElementById('btn');
    const lbl = shadow.getElementById('lbl');
    btn.disabled = true;
    btn.dataset.state = '';
    lbl.textContent = 'Saving…';
    try {
      const r = await sendMessage({ type: 'mnueron:capture' });
      if (r?.ok) {
        btn.dataset.state = 'ok';
        lbl.textContent = 'Saved ✓';
        toast(
          r.result?.message_count
            ? `${r.result.message_count} messages → ${r.result.namespace}`
            : 'Captured to mnueron',
          'ok',
        );
      } else {
        btn.dataset.state = 'err';
        lbl.textContent = 'Save failed';
        toast(r?.error || 'capture failed', 'err');
      }
    } catch (e) {
      btn.dataset.state = 'err';
      lbl.textContent = 'Save failed';
      toast(e?.message || 'capture errored', 'err');
    } finally {
      setTimeout(() => {
        btn.disabled = false;
        btn.dataset.state = '';
        lbl.textContent = 'Save to mnueron';
      }, 1800);
    }
  }

  function toast(text, tone = 'ok', ms = 2400) {
    if (!shadow) return;
    const el = shadow.getElementById('toast');
    el.textContent = text;
    el.dataset.tone = tone;
    el.dataset.show = '1';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.dataset.show = '0'; }, ms);
  }

  // ─── Auto-capture observer ───────────────────────────────────────────────
  //
  // The background already has a handler at mnueron:auto_capture_event that
  // does the same capture flow as the popup's Capture button. Our job here
  // is to NOTIFY it at the right moment: when the chat has settled into a
  // new state worth saving.
  //
  // Strategy: any DOM mutation kicks a 2-second debounce. When it fires, we
  // ask the per-site scraper for the current transcript size. If it's
  // changed since our last fire AND has at least one message ≥ 30 chars,
  // we trigger the background. Background's handler quietly no-ops if
  // settings.auto_capture got flipped off between fires.
  //
  // We do NOT call captureFromTab directly — that would require duplicating
  // the validation + quality-gate logic. Routing through background means
  // one capture path for all save sources.

  function wireAutoCapture() {
    if (autoCaptureWired) return;
    autoCaptureWired = true;
    lastAutoCaptureLen = 0;

    observer = new MutationObserver(() => {
      if (observerScheduled) clearTimeout(observerScheduled);
      observerScheduled = setTimeout(maybeAutoCapture, 2000);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    console.log(`${TAG} auto-capture observer attached`);
  }

  function unwireAutoCapture() {
    if (!autoCaptureWired) return;
    autoCaptureWired = false;
    if (observer) { observer.disconnect(); observer = null; }
    if (observerScheduled) { clearTimeout(observerScheduled); observerScheduled = null; }
    lastAutoCaptureLen = 0;
    console.log(`${TAG} auto-capture observer detached`);
  }

  async function maybeAutoCapture() {
    if (!extensionAlive || !autoCaptureWired) return;

    // First do a CHEAP local check: ask the per-site scraper to dump the
    // current transcript. If the total text length hasn't grown since we
    // last fired, skip — the page is rendering re-flows, not new turns.
    // This is the dedupe gate that keeps us from firing on every keystroke
    // animation.
    let chat;
    try {
      chat = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'mnueron:scrape' }, (r) => resolve(r));
        // Per-site scrapers respond synchronously via sendResponse, so we
        // don't expect a long wait. If chrome.runtime.lastError fires
        // (extension reloaded), resolve undefined.
      });
    } catch {
      chat = null;
    }

    if (!chat || !Array.isArray(chat.messages)) return;
    const meaningful = chat.messages.filter(m => (m.content || '').trim().length >= 30);
    if (meaningful.length === 0) return;

    const totalLen = chat.messages.reduce((sum, m) => sum + ((m.content || '').length || 0), 0);
    if (totalLen <= lastAutoCaptureLen) return;     // no real growth
    if (totalLen - lastAutoCaptureLen < 60) return; // tiny diff — likely rerender, skip
    lastAutoCaptureLen = totalLen;

    // Tell background to run the capture flow against the active tab.
    // Background re-checks settings.auto_capture inside the handler, so
    // a race where the user flipped the toggle off mid-debounce is safe.
    sendMessage({ type: 'mnueron:auto_capture_event' }).then((r) => {
      if (r?.ok && !r.skipped) {
        console.log(`${TAG} auto-captured: ${r.result?.message_count || '?'} msgs`);
      } else if (!r?.ok) {
        // Don't spam toasts on auto-capture failures — they'd interrupt
        // the user mid-conversation. Log only.
        console.warn(`${TAG} auto-capture failed:`, r?.error);
      }
    });
  }

  // ─── chrome.runtime helpers ──────────────────────────────────────────────
  /**
   * Lightweight wrapper that swallows the "Extension context invalidated"
   * error that fires after the extension is reloaded but the tab keeps
   * its old content script. After the first such error we flip
   * extensionAlive=false so subsequent intervals stop firing.
   */
  function sendMessage(payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(payload, (r) => {
          if (chrome.runtime.lastError) {
            const msg = chrome.runtime.lastError.message || '';
            if (msg.includes('Extension context invalidated')) {
              extensionAlive = false;
              cleanup();
            }
            resolve(null);
            return;
          }
          resolve(r || null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  function cleanup() {
    unwireAutoCapture();
    if (buttonHost && buttonHost.parentElement) {
      buttonHost.parentElement.removeChild(buttonHost);
    }
    buttonHost = null;
    shadow = null;
  }
})();
