/**
 * gemini.google.com content script — STUB.
 *
 * Gemini's DOM uses heavily-shadowed custom elements and chunked rendering
 * that don't match the patterns Claude/ChatGPT use. Doing this right takes
 * its own pass. For v1 we ship a stub so the page is recognized and the
 * popup can show a clean "not yet supported" message instead of failing
 * with a confusing error.
 *
 * Pull requests welcome — the structure to return is:
 *   { site, url, title, captured_at, messages: [{ role, content }] }
 */
(() => {
  const TAG = '[mnueron/gemini]';

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'mnueron:scrape') {
      sendResponse({
        site: 'gemini',
        url: location.href,
        title: document.title,
        captured_at: Date.now(),
        messages: [],
        _note: 'gemini scraper not yet implemented',
      });
      return true;
    }
  });

  console.log(`${TAG} stub content script loaded`);
})();
