# mnueron — VS Code extension

Save, search, and inject AI memories from inside VS Code. Works
alongside GitHub Copilot, Cursor, Cline, or any other AI assistant —
mnueron is the *memory*, not the AI.

> **Already using Cursor or Cline?** Those AIs read mnueron natively via
> MCP — this extension is **complementary**, giving you a sidebar to
> browse memories and shortcuts to save selections. Useful even when
> your AI already has memory access.
>
> **Using GitHub Copilot?** Copilot doesn't speak MCP. This extension is
> how you give Copilot users mnueron — they can hit Cmd+Shift+R to
> recall context, paste it into the Copilot chat, and have it use the
> recalled memory.

## What you get

- **Sidebar memory list** (activity bar → mnueron). Shows your 25 most
  recent memories in the active namespace. Click any to open in a peek
  view.
- **Save selection** — `Cmd+Shift+M` (mac) / `Ctrl+Shift+M` (win).
  Saves the current editor selection as a memory, tagged with the file
  language. With no selection, prompts you for content via input box.
- **Recall** — `Cmd+Shift+R` / `Ctrl+Shift+R`. QuickPick search;
  picking a result inserts it at the cursor (or copies to clipboard
  with no editor).
- **Namespace switcher** in the status bar.
- **Ambient context** (optional): when you open a file, mnueron quietly
  searches for related memories and shows a count in the status bar.

## Setup

### Local mode (free, no account)

1. Install the [mnueron CLI](https://www.npmjs.com/package/mnueron):
   ```bash
   npm install -g mnueron
   ```
2. Start the local dashboard server in a terminal (or via the CLI's
   setup wizard):
   ```bash
   mnueron dashboard
   ```
3. In VS Code Settings → mnueron, leave `mnueron.mode` as `local`.

The extension talks to `127.0.0.1:3122` (no auth needed) — all your
memories stay on your machine at `~/.mnueron/memories.db`.

### Hosted mode (sync across machines)

1. Sign up at <https://www.mnueron.com>.
2. Issue a token at `/account-settings/tokens` (copy the `mnu_...` string).
3. In VS Code Settings → mnueron:
   - Set `mnueron.mode` to `hosted`.
   - Paste the token into `mnueron.apiToken`.

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `mnueron.mode` | `local` | `local` (CLI dashboard) or `hosted` (mnueron.com) |
| `mnueron.hostedUrl` | `https://www.mnueron.com` | Override for self-hosting |
| `mnueron.localUrl` | `http://127.0.0.1:3122` | Local CLI dashboard URL |
| `mnueron.apiToken` | `""` | Bearer token (hosted mode only) |
| `mnueron.activeNamespace` | `vscode` | Namespace for saves from this editor |
| `mnueron.ambientContext` | `false` | Search for related memories when opening files |

## Workflow examples

**Capture a design decision while you're editing:**
1. Select the relevant code lines.
2. Hit `Cmd+Shift+M` (or right-click → "mnueron: Save selection as memory").
3. Memory is saved with file path + language metadata; you can recall it later by file name or by content.

**Recall context before asking Copilot a question:**
1. Hit `Cmd+Shift+R`.
2. Type a few words ("auth approach", "rate limit").
3. Pick a result; it's inserted at the cursor (paste into Copilot's chat panel as context).

**Pull yesterday's notes into a fresh planning doc:**
1. Open `Cmd+Shift+P` → "mnueron: Open dashboard in browser".
2. From the dashboard, use the Context Builder to multi-select and
   copy-as-prompt.

## Building from source

```bash
git clone https://github.com/randi2160/mnueron.git
cd mnueron/sdks/vscode
npm install
npm run build
```

Then either:

- **Run a dev instance**: Open the folder in VS Code, press `F5` to launch an Extension Development Host.
- **Build a VSIX**: `npx vsce package` → install the resulting `.vsix` via "Install from VSIX…" in VS Code's command palette.

## What's NOT here yet

- No automatic git-commit capture (planned for v0.2)
- No CodeLens "you wrote N memories about this file" (planned for v0.2)
- No marketplace publication yet — install via VSIX for now
- No remote dev container support (works locally only)

PRs welcome.

## License

MIT.
