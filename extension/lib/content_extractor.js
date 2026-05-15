/**
 * Shared content extraction utilities.
 *
 * Both content scripts use these to capture:
 *   1. Conversation title — from document.title or DOM
 *   2. Code blocks — extracted from each message turn, with language hint
 *
 * Both signals are added to the turn payload as structured metadata so
 * downstream consumers (your memory tools, your dashboard) can filter
 * and search them precisely.
 */
(function () {
  if (window.__MNUERON_EXTRACT__) return;

  /**
   * Best-effort conversation title.
   *
   * Strategy:
   *   1. Look at the sidebar item that's marked active/selected (usually
   *      the most accurate — matches what the user sees).
   *   2. Fall back to document.title minus the site suffix.
   *   3. Return null if neither yields anything useful.
   */
  function extractConversationTitle(site) {
    // Site-specific sidebar selectors — most accurate signal.
    const sidebarSelectors = site === 'claude' ? [
      'a[aria-current="page"]',
      'nav a[class*="bg-"][class*="active"]',
      'nav [class*="selected"]',
    ] : [
      'a[aria-current="page"]',
      'nav [class*="active"]',
      'li[class*="selected"] a',
    ];

    for (const sel of sidebarSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        const txt = (el.innerText || el.textContent || '').trim();
        if (txt && txt.length < 200) return cleanTitle(txt);
      }
    }

    // Fall back to <title>
    const t = (document.title || '').trim();
    if (!t) return null;
    // Strip common suffixes
    const cleaned = t
      .replace(/\s*[-|–—]\s*(Claude|ChatGPT|OpenAI).*$/i, '')
      .replace(/^Claude\s*[-|–—]?\s*/i, '')
      .replace(/^ChatGPT\s*[-|–—]?\s*/i, '')
      .trim();
    if (!cleaned || /^(New chat|Untitled|Chat)$/i.test(cleaned)) return null;
    return cleanTitle(cleaned);
  }

  function cleanTitle(s) {
    return s.replace(/\s+/g, ' ').slice(0, 200);
  }

  /**
   * Extract code blocks from a single message element.
   *
   * Returns an array of:
   *   { language: string|null, code: string }
   *
   * Detects:
   *   - Standard <pre><code class="language-xxx">code</code></pre>
   *   - Claude artifacts: <div data-testid="artifact-*">...
   *   - ChatGPT markdown-code-block components
   */
  function extractCodeBlocks(messageEl) {
    const blocks = [];

    // Standard markdown rendering: <pre><code class="language-xxx">
    const preCodeNodes = messageEl.querySelectorAll('pre code');
    for (const codeEl of preCodeNodes) {
      const langClass = Array.from(codeEl.classList)
        .find((c) => c.startsWith('language-'));
      const language = langClass ? langClass.replace('language-', '') : null;
      const code = codeEl.innerText.trim();
      if (code) blocks.push({ language, code });
    }

    // Claude artifact blocks (e.g. inline tool/code panes)
    const artifactNodes = messageEl.querySelectorAll('[data-testid^="artifact"], [class*="artifact"]');
    for (const art of artifactNodes) {
      const langAttr = art.getAttribute('data-language') ||
                       art.getAttribute('data-lang') ||
                       null;
      // Avoid double-capturing if it already contains a <pre><code> we grabbed
      if (art.querySelector('pre code')) continue;
      const code = (art.innerText || '').trim();
      if (code && code.length > 20) blocks.push({ language: langAttr, code });
    }

    return blocks;
  }

  /**
   * Watch document.title for changes — both sites update the title once
   * a conversation gets named. Callback fires with the new title.
   */
  function onTitleChange(callback) {
    let last = document.title;
    const titleEl = document.querySelector('title');
    if (!titleEl) {
      // Fallback: poll
      setInterval(() => {
        if (document.title !== last) {
          last = document.title;
          callback(last);
        }
      }, 2000);
      return;
    }
    const obs = new MutationObserver(() => {
      if (document.title !== last) {
        last = document.title;
        callback(last);
      }
    });
    obs.observe(titleEl, { childList: true });
  }

  window.__MNUERON_EXTRACT__ = {
    extractConversationTitle,
    extractCodeBlocks,
    onTitleChange,
  };
})();
