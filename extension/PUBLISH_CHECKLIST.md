# Publishing the mnueron extension

Step-by-step from "code is ready" to "live in Chrome Web Store." Plan on
~30 minutes of human work plus 1-3 days of Google review (sometimes
same-day, occasionally up to 4 weeks).

---

## 1. Register a Chrome Web Store developer account ($5, once)

1. Visit https://chrome.google.com/webstore/devconsole.
2. Sign in with the Google account you want to publish from.
3. Accept the developer agreement.
4. Pay the **$5 one-time** registration fee (credit card).
5. Add a publisher display name (suggested: `mnueron`).
6. Verify your contact email.

This is a one-time cost for unlimited extensions. The display name shows
publicly under the extension on the store, so pick something brand-aligned.

---

## 2. Package the extension

The `extension/` directory contains BOTH the shippable extension files
AND publishing materials (CHROME_STORE_LISTING.md, PUBLISH_CHECKLIST.md,
SCREENSHOTS.md, store-assets/). We need to zip ONLY the shippable files.

From a PowerShell window:

```powershell
cd C:\Mnueron\Mnueron\mnueron-v0.1.0\mnueron\extension

# Explicit allowlist of what ships to Chrome. Anything not in this list
# (publishing docs, store-assets/, manifest.firefox.json) stays out.
$ship = @(
  'manifest.json',
  'background.js',
  'popup.html',  'popup.js',
  'options.html','options.js',
  'icons',
  'scrapers',
  'lib',
  'README.md',
  'PRIVACY.md'
)

# Sanity check: confirm each item exists before zipping.
$ship | ForEach-Object {
  if (-not (Test-Path $_)) { Write-Warning "MISSING: $_"; throw "stop" }
}

# Build the zip in the parent directory (so it's not inside `extension/`).
Compress-Archive -Path $ship -DestinationPath ..\mnueron-extension-v0.2.0.zip -Force

# Show what's inside so you can eyeball it before upload.
Expand-Archive -Path ..\mnueron-extension-v0.2.0.zip -DestinationPath ..\.tmp-zip-check -Force
dir ..\.tmp-zip-check -Recurse -File | Select-Object -ExpandProperty FullName
Remove-Item -Recurse ..\.tmp-zip-check
```

The resulting `mnueron-extension-v0.2.0.zip` should be under 1 MB and
contain ONLY the 7 top-level entries listed above. If the verification
listing shows anything extra (CHROME_STORE_LISTING.md, store-assets/,
PUBLISH_CHECKLIST.md, SCREENSHOTS.md, manifest.firefox.json), stop and
fix `$ship` before uploading.

**Smoke-test the zip locally before uploading:**

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (toggle, top right).
3. Click **Load unpacked** → select the `extension/` directory.
4. Confirm:
   - Icon shows in the toolbar (not a generic puzzle piece)
   - Popup opens cleanly when clicked
   - On `claude.ai`, the content script doesn't throw errors in the console
   - Options page loads and lets you set the API URL + token

If anything's broken, fix it before zipping for upload.

---

## 3. Create store-listing assets

You need **three things** before the Developer Dashboard will let you submit:

### a) Store icon (128 × 128)
Already shipped at `extension/icons/icon-128.png`. Upload as-is.

### b) Small promo tile (440 × 280, PNG)
Need to create. Quickest path: open any image editor (Photopea is free in
the browser), make a 440×280 canvas with the brand-gradient background
(`#5b2cff → #7b1fd1 → #f12a8c`), place the mnueron wordmark, save PNG.

### c) Screenshots (1280 × 800 or 640 × 400, PNG, 1–5 of them)
Recommend three:

1. **Popup capturing on claude.ai.** Take a screenshot with the mnueron
   popup open on a real Claude conversation. Annotate lightly with one
   arrow + caption ("Save this conversation").
2. **Options page.** Show the API token field with the value blurred or
   replaced with a fake `mnu_xxxx…`.
3. **The dashboard at mnueron.com.** Show captured memories in the
   list. Use a fresh demo account so the data looks tidy.

Use Snipping Tool / ShareX / similar. Crop to exactly 1280×800 if you can.
Chrome accepts 640×400 too, smaller but lower-quality on retina displays.

---

## 4. Submit in the Developer Dashboard

1. https://chrome.google.com/webstore/devconsole → **+ New item**.
2. Upload the ZIP from step 2.
3. Wait for parse — ~30 seconds. Manifest errors will surface here.
4. Fill in **Store listing** tab. Copy-paste from `CHROME_STORE_LISTING.md`:
   - Name, short description, detailed description
   - Category: Productivity
   - Language: English (US)
   - Upload icon, small promo tile, screenshots
5. Fill in **Privacy** tab:
   - Single purpose: paste the single-purpose declaration
   - For each permission: paste the matching justification
   - Tick the three required disclosures at the bottom
   - Privacy policy URL: `https://mnueron.com/privacy`
6. Fill in **Distribution** tab:
   - Visibility: Public
   - Distribution: All regions
   - Mature content: No
7. Click **Submit for review**.

You'll see status: **Pending review**. Typical review time is 1-3 days.
Google emails the publisher email when status changes.

---

## 5. Common rejection reasons (avoid these)

| Reason | Fix |
| --- | --- |
| Permissions broader than needed | We're using minimal — should be fine. If reviewer flags `tabs`, point them at the popup-context justification. |
| Missing privacy policy or doesn't match practices | Our /privacy is detailed; should pass. |
| Manifest declares permissions for sites not in description | We listed all four AI sites + mnueron + localhost in the description. |
| Code is obfuscated or uses remote code | Our code is plain JS, no eval, no remote loading. |
| Extension is too generic | "Capture AI chat into memory layer" is a clear single purpose. |
| `<all_urls>` permission | We don't use it. |

---

## 6. After approval

- The extension goes live at a URL like `https://chromewebstore.google.com/detail/mnueron-ai-chat-memory/<long-id>`.
- Copy that URL into:
  - The boilerplate's `mnueron-footer.tsx` (Resources column: "Chrome extension")
  - The mnueron repo README
  - mnueron.com/docs#integrations
- Tweet the announcement. Pin it.
- Watch the Developer Dashboard's "Stats" tab for installs and the "Reviews"
  tab for early feedback.

---

## 7. Edge + Firefox follow-ups (optional, free)

### Microsoft Edge Add-ons
Same ZIP works as Chrome. Visit https://partner.microsoft.com/dashboard/microsoftedge.
Free developer account, 1-2 day review. Same listing copy.

### Firefox Add-ons
Use `manifest.firefox.json` (already in the repo) — re-zip with that as
`manifest.json`. Submit at https://addons.mozilla.org/developers/. Free,
same-day automatic publish; manual review for "Recommended" status.

---

## Versioning policy

- Patch fixes (bugfix only): `0.2.1`, `0.2.2`…
- New feature (new site, new capture mode): `0.3.0`, `0.4.0`…
- Breaking change to user setup (new API contract, requires migration): `1.0.0`.

Always bump `manifest.json` → `version` before zipping. Chrome refuses
uploads with the same version as a live release.
