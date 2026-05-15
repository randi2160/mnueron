/**
 * Shared conversation observer.
 *
 * Both Claude and ChatGPT content scripts use this. Each provides a
 * site-specific `extractTurns(root)` function that knows how to read
 * messages out of that site's DOM. The observer:
 *
 *   1. Polls for the conversation root element to exist (these are SPAs,
 *      the DOM isn't ready when content_script runs).
 *   2. Sets up a MutationObserver on that root.
 *   3. On each mutation, re-extracts turns and emits only NEW ones.
 *   4. Debounces so partial streaming responses don't get half-sent.
 *
 * "New" is determined by a stable turn id, which is either the site's own
 * data-attribute or, as a fallback, a hash of (role + first 200 chars).
 */
(function () {
  if (window.__MNUERON_OBSERVER__) return;
  window.__MNUERON_OBSERVER__ = true;

  const STREAM_SETTLE_MS = 2000;     // how long to wait after the last DOM change before flushing
  const POLL_INTERVAL_MS = 500;
  const POLL_TIMEOUT_MS = 30_000;

  class ConversationObserver {
    constructor({ site, findRoot, extractTurns, conversationId, getTitle }) {
      this.site = site;                       // 'claude' | 'chatgpt'
      this.findRoot = findRoot;               // () => HTMLElement | null
      this.extractTurns = extractTurns;       // (root) => Turn[]
      this.conversationId = conversationId;   // () => string (URL-derived)
      this.getTitle = getTitle || (() => null); // () => string | null
      this.seenTurnIds = new Set();
      this.pendingFlushTimer = null;
      this.root = null;
      this.mo = null;
    }

    start() {
      console.debug('[MNUERON] starting observer on', this.site);
      this._pollForRoot();
    }

    _pollForRoot() {
      const startTime = Date.now();
      const tick = () => {
        const root = this.findRoot();
        if (root) {
          this._attach(root);
          return;
        }
        if (Date.now() - startTime > POLL_TIMEOUT_MS) {
          console.warn('[MNUERON] gave up waiting for conversation root');
          return;
        }
        setTimeout(tick, POLL_INTERVAL_MS);
      };
      tick();
    }

    _attach(root) {
      this.root = root;
      this.mo = new MutationObserver(() => this._scheduleFlush());
      this.mo.observe(root, { childList: true, subtree: true, characterData: true });
      console.debug('[MNUERON] attached to root', root);
      // Capture whatever's already on screen
      this._scheduleFlush();

      // Re-attach on full-page client-side navigations (claude.ai and chatgpt.com
      // are SPAs — opening a new chat replaces the root rather than the page).
      this._installUrlChangeListener();
    }

    _installUrlChangeListener() {
      let lastUrl = location.href;
      const check = () => {
        if (location.href !== lastUrl) {
          lastUrl = location.href;
          console.debug('[MNUERON] navigation detected — resetting');
          this.seenTurnIds.clear();
          if (this.mo) { this.mo.disconnect(); this.mo = null; }
          setTimeout(() => this._pollForRoot(), 500);
        }
      };
      setInterval(check, 1000);
    }

    _scheduleFlush() {
      if (this.pendingFlushTimer) clearTimeout(this.pendingFlushTimer);
      this.pendingFlushTimer = setTimeout(() => this._flush(), STREAM_SETTLE_MS);
    }

    _flush() {
      this.pendingFlushTimer = null;
      if (!this.root) return;
      let turns;
      try {
        turns = this.extractTurns(this.root);
      } catch (e) {
        console.warn('[MNUERON] extract failed:', e);
        return;
      }
      const fresh = turns.filter(t => !this.seenTurnIds.has(t.id));
      if (fresh.length === 0) return;

      for (const t of fresh) this.seenTurnIds.add(t.id);

      const conversation = {
        site: this.site,
        conversation_id: this.conversationId(),
        title: this.getTitle(),
        url: location.href,
        captured_at: Date.now(),
        turns: fresh,
      };

      chrome.runtime.sendMessage(
        { type: 'MNUERON_CAPTURE', payload: conversation },
        (resp) => {
          if (chrome.runtime.lastError) {
            console.warn('[MNUERON] sendMessage failed:', chrome.runtime.lastError.message);
            return;
          }
          if (resp?.ok) {
            console.debug(`[MNUERON] saved ${fresh.length} turn(s)`);
          } else {
            console.warn('[MNUERON] save failed:', resp?.error);
          }
        }
      );
    }
  }

  // Stable turn id: prefer DOM-provided id, fallback to hash of content.
  // We don't import a hash library — a cheap djb2 is fine for our purposes.
  function stableId(role, text) {
    const sample = (text ?? '').slice(0, 200);
    let h = 5381;
    for (let i = 0; i < sample.length; i++) h = ((h << 5) + h) + sample.charCodeAt(i);
    return `${role}-${h >>> 0}`;
  }

  // Helper: read URL pattern like /chat/<uuid> or /c/<uuid>
  function urlConversationId() {
    const m = location.pathname.match(/[\/_]([0-9a-f-]{20,})/i);
    return m ? m[1] : location.pathname;
  }

  // Export to window for the per-site content scripts to use.
  window.__MNUERON__ = {
    ConversationObserver,
    stableId,
    urlConversationId,
  };
})();
