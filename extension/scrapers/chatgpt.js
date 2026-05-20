/**
 * chatgpt.com / chat.openai.com content script.
 *
 * ChatGPT's DOM has been stable enough that messages live in
 * `[data-message-author-role]` blocks. We fall back to `.markdown` blocks
 * if the attribute is missing.
 */
(() => {
  const TAG = '[mnueron/chatgpt]';

  // Each strategy bails (returns null) if it finds messages of only ONE
  // role — a one-sided extract is almost certainly an outdated selector
  // and silently truncates the conversation. Let the next strategy try.

  function strat_authorRole() {
    const nodes = document.querySelectorAll('[data-message-author-role]');
    if (!nodes.length) return null;
    const out = [...nodes].map(n => {
      const role = n.getAttribute('data-message-author-role') || 'unknown';
      const inner = n.querySelector('[data-message-text-content], .markdown, .text-message') || n;
      return { role, content: extractText(inner) };
    }).filter(m => m.content);
    if (out.length === 0) return null;
    const haveUser = out.some(m => m.role === 'user');
    const haveAsst = out.some(m => m.role === 'assistant');
    if (!haveUser || !haveAsst) {
      // Soft fail — strategy didn't see both sides yet (e.g. assistant
      // is still streaming, or DOM hadn't fully rendered when we ran).
      // We bail so the next strategy can try. console.debug instead of
      // console.warn so this doesn't show up in chrome://extensions
      // Errors panel — Chrome treats warn as an error there, and these
      // "falling through" cases are normal flow, not bugs.
      console.debug(`${TAG} strat_authorRole one-sided: user=${haveUser} asst=${haveAsst} — falling through`);
      return null;
    }
    return out;
  }

  function strat_markdown() {
    const nodes = document.querySelectorAll('main .markdown, main [data-message-text-content]');
    if (!nodes.length) return null;
    const out = [...nodes].map(el => {
      // Walk up to find the role attribute, if any
      let role = 'unknown';
      let cur = el;
      for (let i = 0; i < 6 && cur; i++) {
        const r = cur.getAttribute && cur.getAttribute('data-message-author-role');
        if (r) { role = r; break; }
        cur = cur.parentElement;
      }
      return { role, content: extractText(el) };
    }).filter(m => m.content);
    if (out.length === 0) return null;
    const haveUser = out.some(m => m.role === 'user');
    const haveAsst = out.some(m => m.role === 'assistant');
    if (!haveUser || !haveAsst) {
      // Same soft-fail reasoning as strat_authorRole.
      console.debug(`${TAG} strat_markdown one-sided: user=${haveUser} asst=${haveAsst} — falling through`);
      return null;
    }
    return out;
  }

  // Last-resort fallback: walk every <article> in main. Each article in
  // chatgpt.com is typically one message; we infer role by structural cues.
  function strat_articleWalk() {
    const articles = document.querySelectorAll('main article');
    if (!articles.length) return null;
    const out = [];
    for (const art of articles) {
      // Role detection: prefer attributes, fall back to class hints.
      const explicit = art.querySelector('[data-message-author-role]')?.getAttribute('data-message-author-role');
      let role = explicit || (() => {
        const cls = (art.className || '').toLowerCase();
        if (cls.includes('user'))   return 'user';
        if (cls.includes('assist') || cls.includes('model') || cls.includes('chatgpt')) return 'assistant';
        return 'unknown';
      })();
      const inner = art.querySelector('.markdown, [data-message-text-content], .text-message') || art;
      const content = extractText(inner);
      if (content) out.push({ role, content });
    }
    if (out.length === 0) return null;
    return out;
  }

  function extractText(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);
    clone.querySelectorAll('button, [aria-hidden="true"]').forEach(n => n.remove());
    return clone.innerText.replace(/ /g, ' ').replace(/\s+\n/g, '\n').trim();
  }

  function getTitle() {
    const t = document.title.replace(/\s*[-|]\s*ChatGPT\s*$/i, '').trim();
    if (t && t.toLowerCase() !== 'chatgpt') return t;
    const h = document.querySelector('header h1, main h1');
    return h ? h.textContent.trim() : '';
  }

  function scrape() {
    for (const [name, fn] of [
      ['authorRole', strat_authorRole],
      ['markdown', strat_markdown],
      ['articleWalk', strat_articleWalk],
    ]) {
      try {
        const out = fn();
        if (out && out.length > 0) {
          console.log(`${TAG} strategy "${name}" → ${out.length} messages`);
          return {
            site: 'chatgpt',
            url: location.href,
            title: getTitle(),
            captured_at: Date.now(),
            messages: out,
          };
        }
      } catch (e) {
        // A thrown exception IS a real bug — keep this as warn so it
        // surfaces in chrome://extensions Errors for debugging.
        console.warn(`${TAG} strategy "${name}" threw:`, e);
      }
    }
    // All three strategies returned null. This is the only case where
    // the user actually loses data — keep as warn so it shows up if
    // ChatGPT changes their DOM and we need to ship a fix.
    console.warn(`${TAG} no strategy matched`);
    return { site: 'chatgpt', url: location.href, title: getTitle(), captured_at: Date.now(), messages: [] };
  }

  // ─── Inject text into the prompt input ─────────────────────────────────
  // ChatGPT's prompt is either a #prompt-textarea or a ProseMirror
  // contenteditable depending on the deploy. Try in order.
  function injectIntoPrompt(text) {
    if (!text) return { ok: false, error: 'no text' };
    const selectors = [
      '#prompt-textarea',
      'div.ProseMirror[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'textarea[data-id="root"]',
      'textarea',
      'div[contenteditable="true"]',
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
    if (msg?.type === 'mnueron:inject_prompt') {
      sendResponse(injectIntoPrompt(msg.text || ''));
      return true;
    }
  });

  console.log(`${TAG} content script ready`);
})();
