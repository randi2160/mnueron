# Capturing the Chrome Web Store screenshots

You need **1–3 screenshots** at **1280 × 800** PNG (Chrome accepts 640×400
too, but 1280×800 looks crisper on retina displays).

Tools that work for sized screenshots on Windows:
- **Snipping Tool** (built-in): hit Win+Shift+S, draw a rectangle, save.
  Best for capturing a specific browser viewport area.
- **ShareX** (free): supports preset capture sizes, region selection,
  cleaner annotations. Recommended if you'll do this regularly.
- **Browser DevTools device-emulator**: F12 → toggle device toolbar →
  set viewport to 1280×800 → screenshot via the three-dots menu →
  "Capture screenshot". Pixel-perfect, no cropping needed.

For maximum consistency, **set Chrome's window to exactly 1280×800**
before each capture:

1. F12 to open DevTools.
2. Click the device-toolbar icon (Ctrl+Shift+M).
3. Top dropdown → "Responsive" → set dimensions to 1280×800.
4. Take screenshots within that viewport.

---

## Screenshot 1 — Popup open on Claude.ai

**What it shows:** the extension actually working on a supported AI site.
This is the most important screenshot — it tells reviewers and users at
a glance what the extension does.

1. Open `https://claude.ai` and start any conversation (a few back-and-forth
   messages — meaningful but anonymous, no real names/codenames).
2. Click the mnueron extension icon in the toolbar (the colored "M" pin).
3. The popup opens showing "Capture this chat" or similar.
4. Capture the full 1280×800 viewport: Claude's chat on the left, mnueron
   popup overlapping at the top right.
5. **Optionally** annotate: draw a thin violet arrow from the popup to
   the chat with a small label "Save this conversation." Keep
   annotations minimal — reviewers reject overly busy promotional images.

Save as `screenshot-1-popup-on-claude.png`.

## Screenshot 2 — Options page configured

**What it shows:** the extension is configurable; users control where
their memories go.

1. Right-click the extension icon → **Options** (or click the gear in the
   popup if there is one).
2. The options page opens. It should have:
   - "Backend URL" field (we ship `http://127.0.0.1:3122` as default)
   - "API Token" field (for hosted users to paste their `mnu_...` token)
   - Toggle / dropdown for namespace prefix
3. Fill in BOTH fields with **demo values**, not real credentials:
   - Backend URL: `https://mnueron.com`
   - API Token: `mnu_demo_xxxxxxxxxxxxxxxxxxxxxx` (clearly fake)
4. Capture the full page at 1280×800.

Save as `screenshot-2-options.png`.

## Screenshot 3 — Memories appearing in the dashboard

**What it shows:** captured chats end up somewhere useful — the mnueron
dashboard with real-looking memories. Closes the loop visually.

1. Sign in at `https://mnueron.com/dashboard`.
2. If you don't have demo memories yet, save a few via the dashboard
   (or by running the extension's "Capture this chat" on a real Claude
   conversation).
3. Make sure 5–10 memories are visible in the left rail. Vary the
   namespaces a bit (`work`, `personal`, `code`) for visual richness.
4. Open one memory in the right detail pane to show content.
5. Capture the full 1280×800 viewport.

Save as `screenshot-3-dashboard.png`.

---

## After capture

Put all three into `extension/store-assets/`:

```powershell
# In a PowerShell window — adjust paths if you save screenshots elsewhere
copy C:\Users\kheml\Pictures\screenshot-1-popup-on-claude.png `
     C:\Mnueron\Mnueron\mnueron-v0.1.0\mnueron\extension\store-assets\

copy C:\Users\kheml\Pictures\screenshot-2-options.png `
     C:\Mnueron\Mnueron\mnueron-v0.1.0\mnueron\extension\store-assets\

copy C:\Users\kheml\Pictures\screenshot-3-dashboard.png `
     C:\Mnueron\Mnueron\mnueron-v0.1.0\mnueron\extension\store-assets\
```

Then in Chrome Web Store Developer Dashboard → Store listing →
**Screenshots** section → upload each PNG in order.

---

## Avoiding rejection

- **Don't show third-party logos prominently.** Claude/ChatGPT logos
  are OK incidentally in the screenshot (they ARE the integration point),
  but don't put them on the promo tile or as the main subject. Google
  reviews flag "implies endorsement by Anthropic / OpenAI" issues.
- **Don't show real API tokens.** Use `mnu_demo_xxxx…` placeholders.
- **Don't show real user data.** Demo conversations only — no actual
  names, emails, or anything you'd be uncomfortable seeing in a public
  store listing.
- **No misleading text overlays.** Don't write "5-star rated!" or "Free
  forever!" if those claims aren't strictly true on day 1.
- **Crop tightly.** Don't leave 200px of empty toolbar around the
  capture; 1280×800 should be filled with relevant UI.
