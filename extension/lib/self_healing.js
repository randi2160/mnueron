/**
 * Self-healing layer for the observer.
 *
 * Wraps a regular ConversationObserver and adds:
 *
 *   1. Staleness detection — if we've been on the page long enough,
 *      seen plenty of DOM mutations, but haven't extracted any turns,
 *      our selectors are probably broken.
 *
 *   2. Repair flow — sends a sanitized HTML sample to the MNUERON
 *      backend, which calls an LLM to identify new selectors.
 *
 *   3. Validation — the proposed selectors must actually produce
 *      turns when applied. Bad proposals are rejected.
 *
 *   4. Persistence — accepted repairs are stored in chrome.storage so
 *      future page loads use the healed selectors immediately.
 *
 * Drop alongside lib/observer.js. The per-site content scripts can
 * use either ConversationObserver (rigid) or SelfHealingObserver (auto-repair).
 */
(function () {
  if (window.__MNUERON_HEALER__) return;
  window.__MNUERON_HEALER__ = true;

  const STALE_THRESHOLD = {
    minTimeMs: 30_000,
    minMutations: 20,
    maxTurns: 0,
  };
  const REPAIR_BACKOFF_MS = 30 * 60 * 1000;   // don't ask for a repair more than once / 30 min

  class SelfHealingObserver {
    /**
     * @param opts.site            'claude' | 'chatgpt'
     * @param opts.defaultSelectors The hardcoded fallback selectors object
     * @param opts.makeFindRoot    (selectors) => () => HTMLElement | null
     * @param opts.makeExtractTurns (selectors) => (root) => Turn[]
     * @param opts.conversationId  () => string
     */
    constructor(opts) {
      this.opts = opts;
      this.mutationCount = 0;
      this.startTime = Date.now();
      this.healingInProgress = false;
      this.lastRepairAttempt = 0;
      this.currentSelectors = null;
      this.observer = null;
    }

    async start() {
      // Load any previously-healed selectors for this site
      this.currentSelectors = await this._loadHealedSelectors() ?? this.opts.defaultSelectors;
      this._installInnerObserver();
      this._installMutationCounter();
      this._installStalenessCheck();
    }

    _installInnerObserver() {
      const { ConversationObserver } = window.__MNUERON__;
      this.observer = new ConversationObserver({
        site: this.opts.site,
        findRoot: this.opts.makeFindRoot(this.currentSelectors),
        extractTurns: this.opts.makeExtractTurns(this.currentSelectors),
        conversationId: this.opts.conversationId,
      });
      this.observer.start();
    }

    _installMutationCounter() {
      const mo = new MutationObserver(muts => {
        this.mutationCount += muts.length;
      });
      mo.observe(document.body, { childList: true, subtree: true });
    }

    _installStalenessCheck() {
      setInterval(() => this._checkStaleness(), 10_000);
    }

    async _checkStaleness() {
      if (this.healingInProgress) return;

      const elapsed = Date.now() - this.startTime;
      const turnsFound = this.observer?.seenTurnIds?.size ?? 0;
      const stale =
        elapsed > STALE_THRESHOLD.minTimeMs &&
        this.mutationCount > STALE_THRESHOLD.minMutations &&
        turnsFound <= STALE_THRESHOLD.maxTurns;

      if (!stale) return;

      // Back off — don't pester the backend if we just tried
      if (Date.now() - this.lastRepairAttempt < REPAIR_BACKOFF_MS) return;
      this.lastRepairAttempt = Date.now();

      console.warn('[MNUERON heal] selectors appear stale, requesting repair');
      this.healingInProgress = true;
      try {
        await this._requestRepair();
      } finally {
        this.healingInProgress = false;
      }
    }

    async _requestRepair() {
      const htmlSample = this._captureStructuralHtml();
      const proposed = await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          {
            type: 'MNUERON_HEAL_SELECTORS',
            payload: {
              site: this.opts.site,
              current_selectors: this.currentSelectors,
              html: htmlSample,
            },
          },
          (resp) => resolve(resp?.ok ? resp.selectors : null)
        );
      });

      if (!proposed) {
        console.warn('[MNUERON heal] backend rejected the repair request');
        return;
      }

      // Validate by testing the proposed selectors
      if (!this._validateProposal(proposed)) {
        console.warn('[MNUERON heal] proposed selectors did not pass validation', proposed);
        return;
      }

      console.log('[MNUERON heal] healed selectors!', proposed);
      this.currentSelectors = proposed;
      await this._saveHealedSelectors(proposed);

      // Re-attach the inner observer with new selectors
      this.observer = null;
      this._installInnerObserver();
    }

    /**
     * Validation: do the proposed selectors actually produce turns on this page?
     * We require finding at least one root and at least one user OR assistant message.
     */
    _validateProposal(proposed) {
      try {
        for (const rootSel of proposed.root ?? []) {
          if (document.querySelector(rootSel)) {
            // Found a root candidate; check messages
            const root = document.querySelector(rootSel);
            const userHits = (proposed.userMessage ?? []).some(s => root.querySelector(s));
            const aiHits = (proposed.assistantMessage ?? []).some(s => root.querySelector(s));
            if (userHits || aiHits) return true;
          }
        }
      } catch (e) {
        console.warn('[MNUERON heal] validation threw:', e);
      }
      return false;
    }

    /**
     * Capture the page's structural HTML, stripped of text content.
     * The backend strips again to be safe, but doing it here too
     * means we never put conversation content on the wire.
     */
    _captureStructuralHtml() {
      const main = document.querySelector('main') ?? document.body;
      const clone = main.cloneNode(true);
      // Remove script/style nodes entirely
      clone.querySelectorAll('script, style, svg').forEach(n => n.remove());
      // Replace text nodes with placeholders
      const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
      const texts = [];
      let node;
      while ((node = walker.nextNode())) texts.push(node);
      for (const t of texts) {
        const len = (t.nodeValue ?? '').trim().length;
        t.nodeValue = len > 0 ? `[TEXT:${len}]` : '';
      }
      return clone.outerHTML.slice(0, 50_000);
    }

    async _loadHealedSelectors() {
      const key = `healed_selectors_${this.opts.site}`;
      return new Promise(resolve => {
        chrome.storage.local.get([key], data => {
          const entry = data[key];
          if (!entry) return resolve(null);
          // Expire healed selectors after 30 days — re-validate fresh
          if (entry.savedAt && Date.now() - entry.savedAt > 30 * 86400_000) {
            return resolve(null);
          }
          resolve(entry.selectors);
        });
      });
    }

    async _saveHealedSelectors(selectors) {
      const key = `healed_selectors_${this.opts.site}`;
      return new Promise(resolve => {
        chrome.storage.local.set(
          { [key]: { selectors, savedAt: Date.now() } },
          resolve
        );
      });
    }
  }

  window.__MNUERON_HEAL__ = { SelfHealingObserver };
})();
