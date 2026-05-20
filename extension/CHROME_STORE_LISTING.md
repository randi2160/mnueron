# Chrome Web Store listing — mnueron extension

Everything you need to copy-paste into the Chrome Web Store Developer
Dashboard when submitting v0.2.0. Keep this file in sync with the live
listing so the next submission is one diff away from ready.

---

## Store identity

| Field | Value |
| --- | --- |
| **Name** | mnueron — AI chat memory |
| **Short description (≤132 chars)** | Save your Claude, ChatGPT, and Gemini conversations into a personal memory layer. Local-first; cloud sync optional. |
| **Category** | Productivity |
| **Language** | English (United States) |
| **Homepage URL** | https://mnueron.com |
| **Support email** | support@mnueron.com |
| **Privacy policy URL** | https://mnueron.com/privacy |

---

## Detailed description (paste into the "Description" field)

mnueron gives every AI tool a memory. Save your conversations from Claude,
ChatGPT, and Gemini into a single searchable memory layer that follows you
across every AI tool you use — Claude Desktop, Cursor, Windsurf, Cline, and
any app you build.

### What this extension does
• One-click "Save this chat" on claude.ai, chatgpt.com, and gemini.google.com.
• Optional background sync — capture new messages as you have them.
• History backfill — pull conversations you've already had.
• Choose where memories go: local mnueron CLI on your machine, or your
  hosted mnueron account at mnueron.com.

### Why use it
• **Local-first.** Your data lives on your computer by default. The extension
  doesn't phone home, doesn't send telemetry, doesn't have a third-party ad
  partner ecosystem.
• **Cross-tool memory.** Save a fact in Claude, recall it in Cursor. The
  memory layer is provider-agnostic.
• **Open source.** MIT-licensed extension code at github.com/randi2160/mnueron.

### How it works
1. Install the extension.
2. Open the popup, point it at either local mnueron (default
   http://127.0.0.1:3122) or your mnueron.com account API token.
3. Visit claude.ai / chatgpt.com / gemini.google.com — click the mnueron
   icon to capture the current conversation. Or enable background sync to
   capture automatically.

### What gets saved
• Message content of conversations you choose to save.
• Conversation title and timestamps.
• The source (which AI site).

### What does NOT get saved
• No browsing history outside the supported AI sites.
• No data from sites that aren't claude.ai, chatgpt.com, or gemini.google.com.
• No third-party tracking. No analytics. No ad targeting.

mnueron is fully open source under MIT. The hosted backend is source-available
(FSL-1.1-Apache-2.0). See https://github.com/randi2160/mnueron.

---

## Single purpose declaration

mnueron's single purpose is **to save and recall conversations from supported
AI websites (Claude, ChatGPT, Gemini) into a personal memory store that the
user controls**. The extension performs no other functions: no ad insertion,
no analytics, no content modification.

---

## Permission justifications

Paste each into the corresponding "Why do you need this permission?" field
during the submission flow.

### `storage`
Stores user preferences locally: which mnueron backend to use (local URL vs
hosted), the user's API token for the hosted service, and per-site capture
settings. Nothing in storage is sent off-device except the user-provided
API token, and only when contacting their own mnueron backend.

### `activeTab`
Required so the popup's "Capture this chat" button can read the current
tab's conversation when the user clicks. activeTab grants access only when
the user explicitly invokes the extension — not in the background.

### `scripting`
Required to inject the content-script "Capture now" action when the user
clicks the popup button. Scripts only run on the four supported AI domains
declared in `content_scripts`.

### `tabs`
Used to detect which supported AI site is open in the active tab so the
popup can show the correct capture options (e.g., "Capture this Claude
conversation" vs "Capture this ChatGPT conversation"). The extension reads
only the URL and title of the active tab, and only when the user opens
the popup.

### Host permissions

| Host | Why |
| --- | --- |
| `https://claude.ai/*` | Read conversation content for the user's explicit capture. |
| `https://chatgpt.com/*` | Same — ChatGPT. |
| `https://chat.openai.com/*` | Legacy ChatGPT URL, same purpose. |
| `https://gemini.google.com/*` | Same — Gemini. |
| `https://mnueron.com/*` | Send captured memories to the user's mnueron.com hosted account when configured. |
| `https://*.mnueron.com/*` | Self-hosted mnueron deployments at subdomains. |
| `http://localhost/*` | Send captured memories to a local mnueron CLI running on the user's own computer. This is the default "no account" path. |
| `http://127.0.0.1/*` | Same as localhost. |

The `http://localhost/*` and `http://127.0.0.1/*` permissions exist
specifically to support **local-first usage** — users who run the mnueron
CLI on their own machine and don't want to create a cloud account. No data
ever leaves the user's machine in this mode.

---

## Privacy-practices form answers

When Chrome Web Store asks the standardized privacy form:

| Question | Answer |
| --- | --- |
| Does this extension collect/transmit personally identifiable information? | No — except the user's own conversation content, which only goes to the user's own backend. |
| Health information? | No |
| Financial / payment info? | No |
| Authentication info? | Yes — API token the user provides. Stored locally in browser.storage.sync, transmitted only to the user's configured mnueron backend over HTTPS. |
| Personal communications (emails, messages)? | Yes — conversation content from the supported AI sites that the user explicitly chooses to capture. Transmitted only to the user's configured mnueron backend over HTTPS. |
| Location? | No |
| Web history / browsing activity? | No — extension only operates on the four supported AI domains. |
| User activity (clicks, mouse position, scrolling)? | No |
| Website content? | Yes — see "Personal communications" above. Strictly limited to the supported AI sites and only when the user invokes capture. |
| Personally identifiable info shared with third parties? | No |

### Required disclosures

- ☑ I do not sell or transfer user data to third parties, outside of the approved use cases.
- ☑ I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- ☑ I do not use or transfer user data to determine creditworthiness or for lending purposes.

---

## Visibility / distribution

- **Visibility:** Public
- **Distribution:** All regions
- **Pricing:** Free
- **Mature content:** No
- **Inappropriate content:** No

---

## Required assets (you supply during upload)

| Asset | Spec | Notes |
| --- | --- | --- |
| **Icon (Store)** | 128 × 128 PNG | We already ship this at `extension/icons/icon-128.png`. |
| **Small promo tile** | 440 × 280 PNG | Need to create. Use the brand-gradient hero from the marketing site as background; "mnueron — AI chat memory" wordmark on it. |
| **Marquee promo tile (optional)** | 1400 × 560 PNG | Only needed if Google picks the extension for a featured slot. Optional at submission. |
| **Screenshots** | 1280 × 800 or 640 × 400 PNG, 1–5 images | Three works: (1) popup open on a claude.ai tab, (2) options page with API token field, (3) the dashboard at mnueron.com with captured memories visible. |
