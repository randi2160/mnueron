/**
 * mnueron ambient context — search-as-you-type strip.
 *
 * Runs alongside the per-site scrapers (claude.js, chatgpt.js). Watches the
 * page's prompt input. When the user has typed enough text, debounce-fires
 * a search against mnueron and shows a small floating pill near the input
 * with relevant past memories. Click to expand, Insert to drop the memory
 * into the prompt.
 *
 * Off by default — toggle in extension options page. The point is to feel
 * helpful, not pushy. If a user disables it once they stay disabled until
 * they explicitly re-enable.
 *
 * Implementation notes:
 *   - Uses Shadow DOM so the page's CSS can't touch our element.
 *   - Polls for prompt-input element existence every 1500ms because SPAs
 *     replace DOM nodes as the user navigates between conversations.
 *   - Caches the last query so we don't re-fire on identical text.
 *   - Hides itself when the prompt is empty, too short, or the page sends.
 */
(() => {
  const TAG = '[mnueron/ambient]';
  const DEBOUNCE_MS = 1100;          // wait this long after last keystroke
  const MIN_QUERY_CHARS = 20;         // ignore short / probably-incomplete prompts
  const PROMPT_SELECTORS = [
    'div.ProseMirror[contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    '#prompt-textarea',
    'textarea[data-id="root"]',
    'textarea',
    'div[contenteditable="true"]',
  ];

  // ─── State ─────────────────────────────────────────────────────────────
  let host = null;
  let shadow = null;
  let promptEl = null;
  let debounceTimer = null;
  let lastQuery = '';
  let lastResults = [];
  let visible = false;
  let enabled = false;          // gated on settings.ambient_context

  // ─── Init ──────────────────────────────────────────────────────────────
  async function init() {
    const settings = await getSettingsViaBackground();
    enabled = !!settings?.ambient_context;
    if (!enabled) {
      console.log(`${TAG} disabled in settings`);
      // Still listen for re-enable in case the user flips it without
      // refreshing the page.
      pollSettings();
      return;
    }
    bootUi();
    attachPromptListener();
    pollPrompt();
    pollSettings();
    console.log(`${TAG} active`);
  }

  function pollSettings() {
    // Re-check every 3s in case the user changes the toggle in options.
    setInterval(async () => {
      const settings = await getSettingsViaBackground();
      const want = !!settings?.ambient_context;
      if (want !== enabled) {
        enabled = want;
        if (enabled) {
          bootUi();
          attachPromptListener();
          pollPrompt();
        } else {
          tearDown();
        }
      }
    }, 3000);
  }

  function getSettingsViaBackground() {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type: 'mnueron:get_settings' }, (r) => {
          resolve(r?.settings || null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  // ─── UI ────────────────────────────────────────────────────────────────
  function bootUi() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'mnueron-ambient-host';
    Object.assign(host.style, {
      position: 'fixed',
      zIndex: '2147483647',
      pointerEvents: 'auto',
      // Initial off-screen placement; positionRelativeToPrompt() snaps it
      // to the real coords as soon as the prompt input is found.
      top: '-1000px',
      left: '-1000px',
    });
    document.documentElement.appendChild(host);

    // Reposition on viewport changes. rAF coalesces frequent scrolls.
    let scheduled = false;
    const reposition = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        positionRelativeToPrompt();
      });
    };
    window.addEventListener('scroll', reposition, { passive: true, capture: true });
    window.addEventListener('resize', reposition, { passive: true });
    // SPAs swap their layout often — poll position too.
    setInterval(positionRelativeToPrompt, 800);

    shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .pill {
          font: 13px/1.4 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
          background: #11141c;
          color: #e7eaf2;
          border: 1px solid #2c3142;
          border-radius: 999px;
          padding: 9px 14px;
          box-shadow: 0 12px 28px rgba(0,0,0,0.45), 0 0 0 1px rgba(91, 44, 255, 0.25);
          cursor: pointer;
          display: none;
          align-items: center;
          gap: 8px;
          user-select: none;
          transition: transform .12s ease, opacity .12s ease;
        }
        .pill:hover { transform: translateY(-1px); }
        .pill.show { display: inline-flex; }
        .dot {
          width: 7px; height: 7px; border-radius: 50%;
          background: linear-gradient(135deg, #5b2cff, #f12a8c);
          box-shadow: 0 0 7px #5b2cff80;
        }
        .panel {
          display: none;
          font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
          width: 360px;
          max-height: 60vh;
          overflow-y: auto;
          background: #0f1115;
          color: #d6dae3;
          border: 1px solid #2c3142;
          border-radius: 14px;
          box-shadow: 0 18px 40px rgba(0,0,0,0.55), 0 0 0 1px rgba(91, 44, 255, 0.20);
          padding: 14px 14px 12px;
        }
        .panel.show { display: block; }
        .panel header {
          display: flex; justify-content: space-between; align-items: center;
          margin-bottom: 8px;
        }
        .panel h4 {
          margin: 0;
          font-size: 13px; font-weight: 600; color: #fff;
          display: flex; align-items: center; gap: 6px;
        }
        .panel .close {
          background: none; border: none; cursor: pointer;
          color: #6c7488; font-size: 18px; line-height: 1;
          padding: 0 4px;
        }
        .panel .close:hover { color: #d6dae3; }
        .card {
          background: #161a26;
          border: 1px solid #1f2330;
          border-radius: 10px;
          padding: 10px 12px;
          margin-top: 8px;
        }
        .card .title {
          font-weight: 600; color: #fff; font-size: 12.5px;
          margin-bottom: 2px;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .card .meta {
          color: #6c7488; font-size: 11px; margin-bottom: 6px;
        }
        .card .preview {
          color: #8a92a6; font-size: 12px;
          display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
          overflow: hidden;
          margin-bottom: 8px;
        }
        .card .actions { display: flex; gap: 6px; }
        button.btn {
          font: 12px/1 inherit;
          padding: 6px 10px;
          border-radius: 6px;
          border: 1px solid #3a5cf0;
          background: #3a5cf0;
          color: #fff;
          cursor: pointer;
        }
        button.btn:hover { background: #4a6bff; }
        button.btn.secondary {
          background: #1d2230;
          border-color: #2c3142;
          color: #d6dae3;
        }
        button.btn.secondary:hover { background: #232938; }
        .toast {
          position: absolute; right: 14px; bottom: 14px;
          background: #15301f; color: #a6ffc4;
          border: 1px solid #2a5a3a;
          padding: 7px 10px; border-radius: 8px; font-size: 12px;
          opacity: 0; transition: opacity .15s;
        }
        .toast.show { opacity: 1; }
        .empty { color: #6c7488; font-size: 12px; padding: 10px 4px; }
        .footer-note {
          margin-top: 10px; font-size: 11px; color: #6c7488;
        }
      </style>
      <div class="pill" id="pill">
        <span class="dot"></span>
        <span id="pill-text">3 related memories</span>
      </div>
      <div class="panel" id="panel">
        <header>
          <h4><span class="dot"></span> mnueron · context</h4>
          <button class="close" id="close-btn" title="dismiss">×</button>
        </header>
        <div id="list"></div>
        <div class="footer-note">
          Click <strong>Insert</strong> to drop a memory into your prompt.
          Turn this off in mnueron Settings → Capture behavior.
        </div>
      </div>
    `;
    shadow.getElementById('pill').addEventListener('click', togglePanel);
    shadow.getElementById('close-btn').addEventListener('click', hidePanel);
  }

  function tearDown() {
    if (host && host.parentElement) host.parentElement.removeChild(host);
    host = null; shadow = null;
    if (promptEl) promptEl.removeEventListener('input', onPromptInput);
    promptEl = null;
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  }

  function showPill(n) {
    if (!shadow) return;
    const pill = shadow.getElementById('pill');
    const text = shadow.getElementById('pill-text');
    text.textContent = n === 1 ? '1 related memory' : `${n} related memories`;
    pill.classList.add('show');
    visible = true;
  }

  function hidePill() {
    if (!shadow) return;
    shadow.getElementById('pill').classList.remove('show');
    hidePanel();
    visible = false;
  }

  function togglePanel() {
    if (!shadow) return;
    const p = shadow.getElementById('panel');
    const pill = shadow.getElementById('pill');
    if (p.classList.contains('show')) {
      p.classList.remove('show');
    } else {
      pill.classList.remove('show');
      renderList();
      p.classList.add('show');
    }
  }

  function hidePanel() {
    if (!shadow) return;
    shadow.getElementById('panel').classList.remove('show');
    if (lastResults.length) shadow.getElementById('pill').classList.add('show');
  }

  function renderList() {
    const list = shadow.getElementById('list');
    if (!lastResults.length) {
      list.innerHTML = '<div class="empty">No matches for that prompt.</div>';
      return;
    }
    list.innerHTML = '';
    lastResults.forEach((m, i) => {
      const card = document.createElement('div');
      card.className = 'card';
      const title = (m.metadata?.title || m.namespace || `memory ${i + 1}`);
      const meta = m.namespace ? m.namespace : '';
      const preview = (m.content || m.content_preview || '')
        .replace(/\s+/g, ' ')
        .slice(0, 260);
      card.innerHTML = `
        <div class="title">${esc(title)}</div>
        <div class="meta">${esc(meta)}</div>
        <div class="preview">${esc(preview)}</div>
        <div class="actions">
          <button class="btn" data-action="insert">Insert</button>
          <button class="btn secondary" data-action="open">Open</button>
        </div>
      `;
      card.querySelector('[data-action="insert"]').addEventListener('click', () => insertResult(m));
      card.querySelector('[data-action="open"]').addEventListener('click', () => openResult(m));
      list.appendChild(card);
    });
  }

  function toast(text) {
    const t = document.createElement('div');
    t.className = 'toast show';
    t.textContent = text;
    shadow.getElementById('panel').appendChild(t);
    setTimeout(() => t.remove(), 1600);
  }

  // ─── Prompt detection + search ─────────────────────────────────────────
  function pollPrompt() {
    setInterval(() => {
      if (!enabled) return;
      if (promptEl && document.contains(promptEl)) return;
      attachPromptListener();
    }, 1500);
  }

  function attachPromptListener() {
    if (promptEl) promptEl.removeEventListener('input', onPromptInput);
    promptEl = null;
    for (const sel of PROMPT_SELECTORS) {
      const el = document.querySelector(sel);
      if (el && (el.offsetParent || el.tagName === 'TEXTAREA')) {
        promptEl = el;
        promptEl.addEventListener('input', onPromptInput);
        promptEl.addEventListener('blur', () => {
          // small delay so the user can click the pill before blur-hides it
          setTimeout(() => {
            if (document.activeElement !== promptEl) {
              // keep pill if results exist; just close any open panel
              if (shadow) shadow.getElementById('panel').classList.remove('show');
            }
          }, 150);
        });
        positionRelativeToPrompt();
        break;
      }
    }
  }

  /**
   * Anchor the host element 12px above the prompt input, right-aligned to
   * the prompt's right edge. Falls back to a sane bottom-right if there's
   * no prompt input found yet. Clamps to viewport so the panel can't slide
   * off-screen on narrow windows.
   */
  function positionRelativeToPrompt() {
    if (!host) return;
    const PILL_HEIGHT = 40;       // approximate; gives us room for the pill
    const MARGIN = 12;

    if (promptEl && document.contains(promptEl)) {
      const rect = promptEl.getBoundingClientRect();
      // Compute desired top so the pill sits ABOVE the input. If that would
      // push it off the top of the viewport, drop it to BELOW the input.
      let top = rect.top - PILL_HEIGHT - MARGIN;
      if (top < 8) top = rect.bottom + MARGIN;

      // Right-align the pill to the prompt's right edge. The panel that
      // expands is 360px wide; make sure it fits within the viewport.
      const PANEL_WIDTH = 360;
      const desiredRight = window.innerWidth - rect.right;
      const minRight = 12;
      const maxRight = window.innerWidth - PANEL_WIDTH - 12;
      const right = Math.max(minRight, Math.min(maxRight, desiredRight));

      Object.assign(host.style, {
        top: `${Math.max(8, top)}px`,
        right: `${right}px`,
        left: 'auto',
        bottom: 'auto',
      });
    } else {
      // Fallback when prompt not yet found — sit bottom-right where the
      // chat input usually is.
      Object.assign(host.style, {
        top: 'auto',
        left: 'auto',
        right: '24px',
        bottom: '120px',
      });
    }
  }

  function readPrompt() {
    if (!promptEl) return '';
    return (promptEl.tagName === 'TEXTAREA' ? promptEl.value : promptEl.textContent) || '';
  }

  function onPromptInput() {
    if (!enabled) return;
    const text = readPrompt().trim();
    if (text.length < MIN_QUERY_CHARS) {
      hidePill();
      lastQuery = '';
      return;
    }
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => doSearch(text), DEBOUNCE_MS);
  }

  async function doSearch(text) {
    // Use the last sentence (or last 200 chars) as the search query —
    // typing a long prompt shouldn't keep re-searching with the full thing.
    const q = lastSentence(text).slice(0, 200);
    if (!q || q === lastQuery) return;
    lastQuery = q;
    try {
      // Use the unified endpoint so matching runbooks surface alongside
      // memories. background.js's recallUnified() auto-falls back to
      // legacy if the backend's older — see background.js for details.
      const res = await sendMessage({ type: 'mnueron:recall_unified', q, k: 5 });
      if (!res?.ok) { hidePill(); return; }

      // Support both shapes: new ({memories, procedurals}) and legacy
      // flat array. Procedurals are surfaced as runbook cards above the
      // memory cards in the panel.
      let combined = [];
      if (Array.isArray(res.result)) {
        combined = res.result;
      } else if (res.result && typeof res.result === 'object') {
        const procedurals = Array.isArray(res.result.procedurals) ? res.result.procedurals : [];
        const memories    = Array.isArray(res.result.memories)    ? res.result.memories    : [];
        combined = [...procedurals.map(synthRunbook), ...memories];
      }

      lastResults = combined;
      if (lastResults.length === 0) {
        hidePill();
      } else {
        showPill(lastResults.length);
      }
    } catch {
      hidePill();
    }
  }

  /**
   * Build a memory-shaped object from a procedural memory so the existing
   * renderList() card pipeline can display it. Same convention as
   * popup.js's synthRunbookCard.
   */
  function synthRunbook(p) {
    const stepText = (p.steps || [])
      .map((s, i) => {
        const desc = (s.description || '').trim();
        const cmd  = s.command ? `\n   $ ${String(s.command).trim()}` : '';
        return `${i + 1}. ${desc}${cmd}`;
      })
      .join('\n');
    const content = [(p.summary || '').trim(), stepText].filter(Boolean).join('\n\n').trim();
    return {
      id: p.id,
      namespace: 'runbook',
      content,
      metadata: { title: `▶ ${p.title || 'Untitled runbook'}`, runbook: true, runbook_id: p.id },
      _isRunbook: true,
    };
  }

  function lastSentence(text) {
    const m = text.match(/([^.!?\n]+[.!?]?)\s*$/);
    return (m ? m[1] : text).trim();
  }

  function sendMessage(payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(payload, (r) => resolve(r));
      } catch {
        resolve(null);
      }
    });
  }

  // ─── Insert + open ─────────────────────────────────────────────────────
  function insertResult(m) {
    const content = m.content || m.content_preview || '';
    if (!content || !promptEl) return;
    promptEl.focus();
    const prefix = (promptEl.tagName === 'TEXTAREA' ? promptEl.value : promptEl.textContent)?.trim()
      ? '\n\n' : '';
    if (promptEl.tagName === 'TEXTAREA') {
      promptEl.value = (promptEl.value || '') + prefix + content;
      promptEl.dispatchEvent(new InputEvent('input', { bubbles: true }));
    } else {
      try {
        document.execCommand('insertText', false, prefix + content);
      } catch {
        promptEl.textContent = (promptEl.textContent || '') + prefix + content;
        promptEl.dispatchEvent(new InputEvent('input', { bubbles: true }));
      }
    }
    toast('Inserted ✓');
    setTimeout(hidePanel, 700);
  }

  async function openResult(m) {
    const settings = await getSettingsViaBackground();
    const base = settings?.prefer_hosted
      ? (settings.hosted_url || 'https://mnueron.com').replace(/\/$/, '')
      : (settings?.local_url || 'http://localhost:3122').replace(/\/$/, '');
    window.open(`${base}/dashboard#memory=${encodeURIComponent(m.id)}`, '_blank', 'noopener');
  }

  // ─── Utils ─────────────────────────────────────────────────────────────
  function esc(s) {
    return (s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ─── Boot ──────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
