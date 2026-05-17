# Installing the VS Code extension (developer build)

The extension hasn't been published to the marketplace yet. Until then,
there are two ways to install it locally.

## Option 1 — Run from source (development)

Best for iterating on the extension itself.

```powershell
cd C:\Mnueron\Mnueron\mnueron-v0.1.0\mnueron\sdks\vscode
npm install
npm run build
```

Then open the folder in VS Code and press **F5**. A new "Extension
Development Host" window launches with the extension active.

## Option 2 — Build a VSIX and install it

Best for everyday use on your own machine (or sharing the file with a
teammate).

```powershell
cd C:\Mnueron\Mnueron\mnueron-v0.1.0\mnueron\sdks\vscode
npm install
npm install -g @vscode/vsce
npm run build
vsce package --no-dependencies --skip-license
```

That produces `mnueron-vscode-0.1.0.vsix` in the folder. Then in VS Code:

1. Open the command palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)
2. Run **"Extensions: Install from VSIX…"**
3. Pick the `.vsix` file
4. Reload VS Code if prompted

## After installing — first run

1. Open VS Code settings (`Cmd+,` / `Ctrl+,`).
2. Search for "mnueron".
3. **Local mode** (free, no account): leave `mnueron.mode` = `local`. Make
   sure the CLI's dashboard server is running on `127.0.0.1:3122`:
   ```powershell
   mnueron dashboard
   ```
   If you haven't installed the CLI yet: `npm install -g mnueron && mnueron setup`.

4. **Hosted mode** (sync across machines): set `mnueron.mode` = `hosted`
   and paste a bearer token into `mnueron.apiToken` (get one from
   `https://www.mnueron.com/account-settings/tokens`).

5. Click the **mnueron** icon in the activity bar (left sidebar). You
   should see the memory list.

6. Try saving: select some code, press **`Cmd/Ctrl+Shift+M`**.

7. Try recalling: press **`Cmd/Ctrl+Shift+R`**, type a few words, hit
   Enter to insert the result at the cursor.

## Publishing to the marketplace (later)

When you're ready to publish to the VS Code Marketplace under the
`mnueron` publisher:

```powershell
vsce login mnueron       # one-time — create publisher at marketplace.visualstudio.com first
vsce publish patch       # or minor / major
```

Marketplace publish requires:

- Azure DevOps PAT with "Marketplace > Manage" scope
- A 128×128 icon (already at `media/icon.png`)
- README.md with a marketplace-friendly description (already there)
- The extension to be tested on a real install (do the VSIX install
  flow above first)

See <https://code.visualstudio.com/api/working-with-extensions/publishing-extension> for the full publishing flow.
