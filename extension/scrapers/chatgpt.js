/**
 * chatgpt.com / chat.openai.com content script.
 *
 * ChatGPT's DOM has been stable enough that messages live in
 * `[data-message-author-role]` blocks. We fall back to `.markdown` blocks
 * if the attribute is missing.
 */
(() => {
  const TAG = '[mnueron/chatgpt]';

  function strat_authorRole() {
    const nodes = document.querySelectorAll('[data-message-author-role]');
    if (!nodes.length) return null;
    return [...nodes].map(n => {
      const role = n.getAttribute('data-message-author-role') || 'unknown';
      const inner = n.querySelector('[data-message-text-content], .markdown, .text-message') || n;
      return { role, content: extractText(inner) };
    }).filter(m => m.content);
  }

  function strat_markdown() {
    const nodes = document.querySelectorAll('main .markdown, main [data-message-text-content]');
    if (!nodes.length) return null;
    return [...nodes].map(el => {
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
    for (const [name, fn] of [['authorRole', strat_authorRole], ['markdown', strat_markdown]]) {
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
        console.warn(`${TAG} strategy "${name}" threw:`, e);
      }
    }
    console.warn(`${TAG} no strategy matched`);
    return { site: 'chatgpt', url: location.href, title: getTitle(), captured_at: Date.now(), messages: [] };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'mnueron:scrape') {
      sendResponse(scrape());
      return true;
    }
  });

  console.log(`${TAG} content script ready`);
})();
