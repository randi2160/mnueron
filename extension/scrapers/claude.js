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
  function strat_testid() {
    const nodes = document.querySelectorAll('[data-testid="user-message"], [data-testid="assistant-message"]');
    if (!nodes.length) return null;
    return [...nodes].map(n => ({
      role: n.getAttribute('data-testid') === 'user-message' ? 'user' : 'assistant',
      content: extractText(n),
    })).filter(m => m.content);
  }

  function strat_fontClass() {
    // Newer DOM uses `font-user-message` / `font-claude-message`
    const userSel = 'div[class*="font-user-message"], div.font-user-message';
    const asstSel = 'div[class*="font-claude-message"], div.font-claude-message, div[class*="font-claude-response"]';
    const userNodes = [...document.querySelectorAll(userSel)];
    const asstNodes = [...document.querySelectorAll(asstSel)];
    if (!userNodes.length && !asstNodes.length) return null;
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
    return proses.map(el => {
      const turn = el.closest('[data-test-render-count], [class*="turn"], [class*="group"]') || el.parentElement;
      const role = guessRoleFromTurn(turn);
      return { role, content: extractText(el) };
    }).filter(m => m.content);
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
  });

  console.log(`${TAG} content script ready`);
})();
