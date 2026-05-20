/**
 * claude.ai content script.
 *
 * The DOM evolves; we try several selector strategies. Each strategy returns
 * an array of {role, content} or null. The first one that yields ≥1 message
 * wins. Logged failures help you update selectors when claude.ai changes.
 *
 * If you see "No messages found" in the popup despite being on a chat page,
 * check the console (DevTools) — we log which strategies attempted.
 */
(() => {
  const TAG = '[mnueron/claude]';

  // ─── Strategies, ordered by specificity ──────────────────────────────────
  //
  // claude.ai's DOM markers rotate every few months. Each strategy tries a
  // wider net than the last. If a strategy finds USER messages but no
  // ASSISTANT messages (or vice versa), we explicitly fall through to the
  // next strategy — a one-sided result is almost certainly wrong.

  function strat_testid() {
    // Cover every testid variant we've seen for both sides.
    const userNodes = document.querySelectorAll([
      '[data-testid="user-message"]',
      '[data-testid="human-message"]',
    ].join(', '));
    const asstNodes = document.querySelectorAll([
      '[data-testid="assistant-message"]',
      '[data-testid="claude-response"]',
      '[data-testid="claude-message"]',
      '[data-testid="model-response"]',
      '[data-testid="ai-message"]',
    ].join(', '));
    if (userNodes.length === 0 && asstNodes.length === 0) return null;
    // One-sided result → likely outdated selector. Bail and let the next
    // strategy try a broader sweep.
    if (userNodes.length === 0 || asstNodes.length === 0) {
      // Soft fail — log at debug so Chrome's chrome://extensions Errors
      // panel doesn't surface this as a bug. The fallback chain will
      // try the next strategy.
      console.debug(`${TAG} strat_testid one-sided: user=${userNodes.length} assistant=${asstNodes.length} — falling through`);
      return null;
    }
    const all = [
      ...[...userNodes].map(n => ({ el: n, role: 'user' })),
      ...[...asstNodes].map(n => ({ el: n, role: 'assistant' })),
    ].sort((a, b) => domOrder(a.el, b.el));
    return all.map(({ el, role }) => ({ role, content: extractText(el) })).filter(m => m.content);
  }

  function strat_fontClass() {
    // Newer DOM uses `font-user-message` / `font-claude-message`.
    // Also catches `font-claude-response` and any future `font-claude-*`.
    const userSel = 'div[class*="font-user-message"]';
    const asstSel = 'div[class*="font-claude-"]';
    const userNodes = [...document.querySelectorAll(userSel)];
    const asstNodes = [...document.querySelectorAll(asstSel)];
    if (!userNodes.length && !asstNodes.length) return null;
    if (userNodes.length === 0 || asstNodes.length === 0) {
      console.debug(`${TAG} strat_fontClass one-sided: user=${userNodes.length} assistant=${asstNodes.length} — falling through`);
      return null;
    }
    const combined = [
      ...userNodes.map(n => ({ el: n, role: 'user' })),
      ...asstNodes.map(n => ({ el: n, role: 'assistant' })),
    ].sort((a, b) => domOrder(a.el, b.el));
    return combined.map(({ el, role }) => ({ role, content: extractText(el) })).filter(m => m.content);
  }

  function strat_proseTurns() {
    // Last-resort: each message in claude.ai contains a `.prose` block.
    // We rely on order in the DOM and pattern-match the wrapping element to
    // distinguish user vs assistant. A user message is usually shorter and
    // sits in a "turn" container whose ancestor has a specific shape.
    const proses = [...document.querySelectorAll('main .prose, .prose')];
    if (!proses.length) return null;
    const msgs = proses.map(el => {
      const turn = el.closest('[data-test-render-count], [class*="turn"], [class*="group"]') || el.parentElement;
      const role = guessRoleFromTurn(turn);
      return { role, content: extractText(el) };
    }).filter(m => m.content);

    // Bail if results look like the well-known title-only failure mode:
    //   - all messages have role 'unknown' (couldn't tell user vs assistant)
    //   - OR every message is shorter than 30 chars (probably just headings)
    //   - OR fewer than 2 distinct messages (real chats have at least one turn)
    if (msgs.length < 2) {
      console.debug(`${TAG} strat_proseTurns only found ${msgs.length} message — falling through`);
      return null;
    }
    const knownRoles = msgs.filter(m => m.role === 'user' || m.role === 'assistant').length;
    if (knownRoles === 0) {
      console.debug(`${TAG} strat_proseTurns: all messages role=unknown — falling through`);
      return null;
    }
    const meaningful = msgs.filter(m => (m.content || '').trim().length >= 30).length;
    if (meaningful === 0) {
      console.debug(`${TAG} strat_proseTurns: every message < 30 chars (title-only?) — falling through`);
      return null;
    }
    return msgs;
  }

  function strat_articleWalk() {
    // Broader sweep: walk any element with role="article" or aria-label
    // containing "message". Catches a-b testing variants that don't use
    // the testid/font-class patterns yet.
    const nodes = [...document.querySelectorAll(
      '[role="article"], [aria-label*="message" i], [aria-label*="conversation turn" i]'
    )];
    if (nodes.length < 2) return null;
    const msgs = nodes.map(n => {
      const role = guessRoleFromTurn(n);
      return { role, content: extractText(n) };
    }).filter(m => m.content && m.content.length >= 30);
    const knownRoles = msgs.filter(m => m.role === 'user' || m.role === 'assistant').length;
    if (msgs.length < 2 || knownRoles === 0) return null;
    return msgs;
  }

  function guessRoleFromTurn(turn) {
    if (!turn) return 'unknown';
    const t = turn.outerHTML.slice(0, 800).toLowerCase();
    if (t.includes('user') || t.includes('human')) return 'user';
    if (t.includes('claude') || t.includes('assistant')) return 'assistant';
    return 'unknown';
  }

  function extractText(el) {
    if (!el) return '';
    // Strip code-block UI noise but preserve text content. Clone to avoid
    // mutating the live DOM.
    const clone = el.cloneNode(true);
    clone.querySelectorAll('button, [aria-hidden="true"]').forEach(n => n.remove());
    return clone.innerText.replace(/ /g, ' ').replace(/\s+\n/g, '\n').trim();
  }

  function domOrder(a, b) {
    if (a === b) return 0;
    const pos = a.compareDocumentPosition(b);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  }

  function getTitle() {
    // Try common sources for the chat title.
    const h = document.title.replace(/\s*[-|]\s*Claude\s*$/i, '').trim();
    if (h && h.toLowerCase() !== 'claude') return h;
    const headerEl = document.querySelector('header h1, main h1');
    if (headerEl) return headerEl.textContent.trim();
    return '';
  }

  function scrape() {
    const strategies = [
      ['testid', strat_testid],
      ['fontClass', strat_fontClass],
      ['articleWalk', strat_articleWalk],
      ['proseTurns', strat_proseTurns],
    ];
    for (const [name, fn] of strategies) {
      try {
        const out = fn();
        if (out && out.length > 0) {
          console.log(`${TAG} strategy "${name}" → ${out.length} messages`);
          return {
            site: 'claude',
            url: location.href,
            title: getTitle(),
            captured_at: Date.now(),
            messages: out,
          };
        }
      } catch (e) {
        console.warn(`${TAG} strategy "${name}" threw:`, e);
      }
    }
    console.warn(`${TAG} no strategy matched`);
    return { site: 'claude', url: location.href, title: getTitle(), captured_at: Date.now(), messages: [] };
  }

  // ─── Backfill via claude.ai internal API ─────────────────────────────────
  // These endpoints are not documented public API. They power claude.ai's own
  // UI, so they have the user's session via the cookie. We only read; we
  // never write back. If Anthropic changes these endpoints, backfill stops
  // working — manual capture still works through the DOM scraper above.
  async function api(path) {
    const r = await fetch(path, { credentials: 'include', headers: { 'Accept': 'application/json' } });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${path}`);
    return r.json();
  }

  async function backfillList() {
    try {
      const orgs = await api('/api/organizations');
      const orgId = Array.isArray(orgs) && orgs[0]?.uuid;
      if (!orgId) return { ok: false, error: 'no organization found — are you logged in to claude.ai?' };
      const convs = await api(`/api/organizations/${orgId}/chat_conversations`);
      if (!Array.isArray(convs)) return { ok: false, error: 'unexpected response shape' };
      return {
        ok: true,
        orgId,
        conversations: convs.map(c => ({
          uuid: c.uuid,
          name: c.name,
          summary: c.summary,
          created_at: c.created_at,
          updated_at: c.updated_at,
          model: c.model,
        })),
      };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  async function backfillGet(orgId, uuid) {
    try {
      const full = await api(`/api/organizations/${orgId}/chat_conversations/${uuid}`);
      return { ok: true, conversation: full };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  // ─── Inject text into the prompt input ──────────────────────────────────
  // Claude.ai's prompt is a ProseMirror contenteditable. Selector has shifted
  // over time, so try a few in order. Returns { ok, where, error }.
  function injectIntoPrompt(text) {
    if (!text) return { ok: false, error: 'no text' };
    const selectors = [
      'div.ProseMirror[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      'textarea',
    ];
    let el = null;
    for (const sel of selectors) {
      el = document.querySelector(sel);
      if (el && (el.offsetParent || el.tagName === 'TEXTAREA')) break;
      el = null;
    }
    if (!el) return { ok: false, error: 'prompt input not found' };

    el.focus();
    const prefix = (el.tagName === 'TEXTAREA' ? el.value : el.textContent)?.trim() ? '\n\n' : '';

    if (el.tagName === 'TEXTAREA') {
      el.value = (el.value || '') + prefix + text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      return { ok: true, where: 'textarea' };
    }
    // ProseMirror / contenteditable. execCommand is deprecated but still the
    // only reliable way to insert into React-managed editors without
    // confusing their state.
    try {
      document.execCommand('insertText', false, prefix + text);
      return { ok: true, where: 'contenteditable' };
    } catch {
      el.textContent = (el.textContent || '') + prefix + text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      return { ok: true, where: 'fallback' };
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'mnueron:scrape') {
      sendResponse(scrape());
      return true;
    }
    if (msg?.type === 'mnueron:backfill_list') {
      backfillList().then(sendResponse);
      return true;  // async
    }
    if (msg?.type === 'mnueron:backfill_get') {
      backfillGet(msg.orgId, msg.uuid).then(sendResponse);
      return true;  // async
    }
    if (msg?.type === 'mnueron:inject_prompt') {
      sendResponse(injectIntoPrompt(msg.text || ''));
      return true;
    }
  });

  console.log(`${TAG} content script ready`);
})();
