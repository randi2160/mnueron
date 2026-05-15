# mnueron Chrome extension

Capture conversations from Claude, ChatGPT, and (eventually) Gemini into your
local mnueron memory layer.

## What it does

- Detects when you're on `claude.ai`, `chatgpt.com`, or `gemini.google.com`
- One-click "Capture chat" button in the toolbar popup
- Sends the captured transcript to your local mnueron backend (or hosted, if configured)
- Each capture becomes one memory in your namespace of choice — searchable from
  the dashboard, the CLI, and any MCP-connected AI tool

## Requirements

- Chrome (or any Chromium-based browser: Edge, Brave, Arc)
- mnueron running locally with the dashboard server up:
  ```bash
  node dist/cli.js dashboard
  ```
  (or `mnueron dashboard` if installed globally)

## Install (unpacked, dev mode)

This extension isn't published to the Chrome Web Store yet. To use it now:

1. Open `chrome://extensions`
2. Toggle **Developer mode** on (top-right)
3. Click **Load unpacked**
4. Pick the `extension/` folder inside this repo
5. The mnueron icon should appear in the toolbar. (Pin it via the puzzle-piece menu for easy access.)
6. On first install, the **Options** page opens automatically. The defaults assume
   `http://localhost:3122` (the mnueron dashboard) — change only if you've
   moved the backend or you want hosted mode.

## How to use

1. Make sure `mnueron dashboard` is running locally — the popup shows "connected"
   when it can reach the backend.
2. Have a conversation on Claude or ChatGPT.
3. When you want to save it, click the mnueron icon in the toolbar and click
   **Capture chat**.
4. A toast confirms how many messages were captured and which namespace
   they landed in. Open the dashboard to see it.

By default captures land in `web-claude` or `web-chatgpt` namespaces. Change
the prefix in **Settings**.

## Auto-capture (experimental)

The Options page has an "Auto-capture" toggle. When enabled, the extension
will save chats automatically without you clicking anything. Currently this
is an *opt-in stub* — the wiring is in place but the content scripts don't
yet emit auto-capture events. The next iteration adds idle-detection so
chats save after you stop typing for N seconds.

## Hosted backend

If you have the hosted mnueron backend running (see `server/`), set:

- **Hosted URL** → e.g. `https://api.your-mnueron.com`
- **Bearer token** → your `mnu_…` API token
- Check **Use hosted backend instead of local**

The extension is otherwise identical between modes.

## Troubleshooting

### "No scraper loaded on this page"
Reload the chat tab — the content script loads on `document_idle` and may
have missed a fresh navigation. If reloading doesn't fix it, check
`chrome://extensions` → click "Errors" on the mnueron card.

### "No messages found"
The site's DOM has likely changed. Open DevTools console on the chat page —
the scraper logs which selector strategies it tried (e.g. `[mnueron/claude]`).
PRs to add new selectors are welcome; the file to edit is
`extension/scrapers/<site>.js`.

### "Cannot reach backend"
Either `mnueron dashboard` isn't running, or you've moved it to a different
port. Check the URL in Options. The default is `http://localhost:3122`.

### Gemini "not yet implemented"
Correct — see `scrapers/gemini.js`. Gemini's heavily-shadowed DOM needs its
own implementation pass. Coming in a future version.

## File layout

```
extension/
├── manifest.json         MV3 manifest, host permissions, content script registration
├── background.js         service worker (HTTP to mnueron, message routing)
├── popup.html / popup.js toolbar UI
├── options.html / options.js settings page
└── scrapers/
    ├── claude.js         claude.ai DOM scraper
    ├── chatgpt.js        chatgpt.com / chat.openai.com DOM scraper
    └── gemini.js         placeholder (returns 0 messages)
```

## Privacy

- Captured chats never leave your machine unless **Use hosted backend** is
  checked. Local mode talks to `localhost` only.
- The extension stores its settings in `chrome.storage.sync`. The hosted
  token if you set one is in sync storage too — it follows your Chrome
  profile across signed-in devices.

## License

Same as the parent project: MIT.
