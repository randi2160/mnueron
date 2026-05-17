# Chrome Web Store submission — step by step

The submission zip is in this folder as
`mnueron-extension-clean-v0.2.0.zip` (~54 KB, 21 files, manifest v3).

> **Note about the other zip in this folder.** `mnueron-extension-0.2.0.zip`
> exists as a 0-byte placeholder due to a sandbox filesystem quirk —
> ignore it. Use only `mnueron-extension-clean-v0.2.0.zip`.

## Prerequisites (one-time)

1. **Chrome Web Store Developer account** — $5 one-time signup at
   <https://chrome.google.com/webstore/devconsole>. Use the same Google
   account you'll want long-term for support emails.
2. **Two screenshots** at 1280×800 or 640×400 (see "Screenshots" section
   below for exactly what to capture).
3. **Privacy policy URL**. Either:
   - `https://www.mnueron.com/privacy` (already exists, confirm content
     covers extension data handling), or
   - A new sub-page like `/privacy/chrome-extension` if you want
     extension-specific wording.

## Step-by-step

### 1. Upload the zip

1. Sign in to <https://chrome.google.com/webstore/devconsole>.
2. Click **New item**.
3. Drag `mnueron-extension-clean-v0.2.0.zip` into the upload box.
4. Wait for the upload to complete (~10 seconds).

### 2. Fill in the listing

Use the exact copy below — proven format that survives review.

**Name:** `mnueron — AI chat memory`

**Short description** (132 chars max):
```
Capture conversations from Claude, ChatGPT, and Gemini into a personal memory layer your AI tools can recall later.
```

**Detailed description** (paste verbatim):
```
mnueron is a memory layer for every AI you use. The Chrome extension
captures conversations from Claude, ChatGPT, and Gemini directly into
your mnueron store — local or cloud — so the next AI you talk to can
recall what you discussed yesterday, even if it's a different model in
a different tab.

WHAT IT DOES

• One-click capture from claude.ai, chatgpt.com, and gemini.google.com
• Backfill your entire chat history into mnueron in the background
• Recall past memories without leaving the chat — type a few words in
  the popup and insert the matching memory into your prompt
• Ambient context (opt-in) — as you type, a small pill above the
  prompt shows when relevant past memories exist
• Multi-select "Copy as prompt" — turn 3-5 memories into a clean
  markdown context block to paste into any AI

LOCAL OR HOSTED

• Local mode (free, no account): your data stays on your machine in
  ~/.mnueron/memories.db. Works with the mnueron CLI.
• Hosted mode: signs in to your mnueron.com account for cross-machine
  sync. Free tier available.

PRIVACY

• No telemetry. No data sale. No ads.
• Captured chats only leave your browser to reach the destination YOU
  pick (your own computer in local mode, or your account at
  mnueron.com in hosted mode).
• The extension never reads or sends data from sites other than the AI
  chat sites you've authorized.
• Built-in secret redaction strips 13 common credential patterns
  (API keys, AWS credentials, OAuth tokens, etc.) before saving.

OPEN SOURCE

Full source at https://github.com/randi2160/mnueron — MIT licensed.

GET STARTED

1. Install the extension.
2. Click the icon and pick Local or Hosted mode in the popup.
3. Visit claude.ai or chatgpt.com — captures begin automatically.
4. To recall: click the icon, search, and "Insert" into the prompt.

Questions or feedback: khemlall.mangal@gmail.com
```

**Category:** Productivity

**Language:** English

### 3. Privacy practices

This is the part most submissions get bounced on. Be deliberate.

**Single purpose:** "Capture conversations from AI chat sites into a
user-controlled memory store for later recall."

**Permission justifications** (Chrome will ask for each):

| Permission | Justification (paste verbatim) |
| --- | --- |
| `storage` | Store user preferences (local vs hosted mode, active namespace, sign-in token) in chrome.storage.local. |
| `activeTab` | Detect which AI chat site is currently focused so the popup can offer the right "capture" or "recall" actions. |
| `scripting` | Inject recall-and-insert UI into the active AI chat page when the user clicks the popup. |
| `tabs` | Detect when the user switches between AI chat tabs to update capture progress. |
| host permission for `claude.ai`, `chatgpt.com`, `gemini.google.com` | Read conversation DOM to capture messages the user is having with their AI. |
| host permission for `mnueron.com` | Sync captures to the user's hosted mnueron account when they enable cloud mode. |
| host permission for `localhost` / `127.0.0.1` | Talk to the mnueron CLI's local dashboard server on the user's own machine. |

**Data usage disclosures** (check the matching boxes in the dev console):

- ✓ Personally identifiable information — user email (for hosted account auth)
- ✓ Authentication information — bearer tokens stored in chrome.storage
- ✓ User activity — the user's own AI chat content (this IS the product)
- ✓ Website content — the AI chat conversations on supported sites

Then for each, certify:
- We do not sell or transfer user data to third parties outside the
  approved use cases.
- We do not use or transfer user data for purposes unrelated to our
  item's single purpose.
- We do not use or transfer user data to determine creditworthiness or
  for lending purposes.

**Privacy policy URL:** `https://www.mnueron.com/privacy`

### 4. Screenshots

You need at least **one** screenshot. Two or three look more
professional. Sizes: **1280×800 or 640×400 PNG/JPEG**.

Recommended captures (capture from real mnueron usage):

1. **Popup with search results** — open claude.ai, click the mnueron
   icon, type a search, show the top-5 results with checkboxes.
2. **Ambient context pill above the prompt** — claude.ai with a few
   messages in history, mnueron's small pill visible above the
   prompt input.
3. **Backfill progress** — popup showing "Imported 38 of 142
   conversations…" mid-backfill.
4. (Optional) **Cloud dashboard** view at mnueron.com showing memories
   that were captured by the extension.

Crop each to 1280×800 with a bit of dark background space around the
UI element so it doesn't feel cramped. PowerToys Screen Ruler +
ShareX work well on Windows.

### 5. Promo tile (optional but recommended)

The 440×280 promo tile is already in
`extension/store-assets/promo-440x280.png`. Upload it under the
"Store icon and promotional images" section. Boost click-through ~30%.

### 6. Submit for review

Once everything's filled:

1. Click **Submit for review**.
2. Wait 1-3 business days. Email notifications go to your dev account.
3. If rejected, the email lists the specific item — common ones are
   permission justifications too vague, screenshots that don't show
   the actual functionality, or privacy disclosures missing.

### 7. Publish (visibility)

When approved, you can choose:

- **Public** — anyone can find and install (recommended)
- **Unlisted** — only people with the direct link can install (good for
  early access to friends without going through full marketing)
- **Private** — only specific Google accounts can install (good for
  internal testing first)

Start **Unlisted** if you want to do a friends-and-family test for a
day or two before going Public.

## After it's live

1. Update the landing page CTA on mnueron.com from "Coming to Chrome
   Web Store" to "Install for Chrome" with the marketplace URL.
2. Update the README in the mnueron repo with the install link.
3. Update the docs page at `/docs/chrome-extension/overview` with the
   one-click install path.
4. Post to:
   - Hacker News (Show HN)
   - r/ClaudeAI, r/ChatGPT, r/LocalLLaMA
   - Twitter / LinkedIn
   - Your own audience (if any)

## Future submissions

For version bumps (0.2.1, 0.3.0, etc.):

1. Increment `version` in `extension/manifest.json`.
2. Rebuild the zip:
   ```powershell
   cd C:\Mnueron\Mnueron\mnueron-v0.1.0\mnueron\extension
   Compress-Archive -Path .\* -DestinationPath ..\chrome-webstore-package\mnueron-extension-X.Y.Z.zip -Force
   ```
   (Skip docs and marketing assets — they don't need to ship in the
   runtime zip.)
3. Upload the new zip to the existing listing → "Package" → "Upload
   new package".
4. If permissions haven't changed, review is faster (often hours
   instead of days).

## Submitting from your Windows machine if you want to rebuild the zip

The sandbox-generated zip excludes docs and marketing assets. If you
want to recreate it on your Windows side (say, with a different
version number):

```powershell
cd C:\Mnueron\Mnueron\mnueron-v0.1.0\mnueron\extension
$exclude = @('*.md', '*.firefox.json', 'store-assets', 'PRIVACY.md',
             'SCREENSHOTS.md', 'README.md', 'PUBLISH_CHECKLIST.md',
             'CHROME_STORE_LISTING.md')
$tmp = Join-Path $env:TEMP "mnueron-ext-package"
if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
New-Item -ItemType Directory -Path $tmp | Out-Null
Get-ChildItem -Path . | Where-Object {
    $_.Name -notin $exclude -and
    ($exclude | ForEach-Object { $_.Name -like $_ }) -notcontains $true
} | Copy-Item -Destination $tmp -Recurse -Force
Compress-Archive -Path "$tmp\*" -DestinationPath ..\chrome-webstore-package\mnueron-extension-0.2.0.zip -Force
Remove-Item -Recurse -Force $tmp
```
