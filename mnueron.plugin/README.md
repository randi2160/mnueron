# mnueron — Cowork plugin

Persistent memory for every Cowork session. Once installed, every Claude
chat in Cowork can recall any memory you've previously saved — including
imported Cowork transcripts, claude.ai history, ChatGPT exports, and
manual notes.

## What this plugin gives you

Installing this plugin registers mnueron's local MCP server with Cowork.
That adds these tools to every Cowork session:

| Tool | What it does |
|---|---|
| `memory_save` | Save a fact, decision, or note into mnueron memory |
| `memory_recall` | Search memory by natural-language query (BM25 + vector) |
| `memory_get` | Fetch a full memory by id |
| `memory_get_thread` | Reassemble a chunked conversation by `parent_ref` |
| `memory_list` | Browse recent memories in a namespace |
| `memory_delete` | Remove a memory by id |
| `memory_namespaces` | List all namespaces + counts |
| `memory_import_chat` | Import a Claude / OpenAI conversation export JSON |
| `memory_import_cowork` | Auto-discover and import every Cowork chat on disk |

## Pre-requisites

1. **mnueron built locally.** This plugin points at
   `C:\Mnueron\Mnueron\mnueron-v0.1.0\mnueron\dist\index.js`. If that path
   doesn't exist, run:
   ```powershell
   cd C:\Mnueron\Mnueron\mnueron-v0.1.0\mnueron
   npm install
   npm run build
   ```
2. **An API token from mnueron.com.** Generate at
   `https://www.mnueron.com/account-settings/tokens`. Then set it as a
   user-wide environment variable so Cowork sees it on startup:
   ```powershell
   [Environment]::SetEnvironmentVariable("MNUERON_API_TOKEN", "mnu_…", "User")
   ```

## Installation

This package is a Cowork plugin directory. To install:

1. Open Cowork. In any chat, install the `cowork-plugin-management`
   plugin (search "Plugins" from the menu).
2. Run the `cowork-plugin-customizer` skill and point it at this
   directory: `C:\Mnueron\Mnueron\mnueron-v0.1.0\mnueron\mnueron.plugin\`.
3. The skill will:
   - Validate the manifest and `mcp-servers.json`.
   - Rename `mcp-servers.json` → `.mcp.json` (Cowork's expected name).
   - Bundle the directory into a `.plugin` archive.
   - Install it into your Cowork environment.
4. Fully quit and reopen Cowork.
5. In a new chat, ask: **"What memory tools do you have available?"** You
   should see all nine `memory_*` tools listed.

## Configuration

Default mode is **hosted** — every save and recall goes through
`https://www.mnueron.com`. To switch to **local-only** (SQLite at
`~/.mnueron/memories.db`), edit `mcp-servers.json` and remove the
`MNUERON_API_URL` and `MNUERON_API_TOKEN` entries from `env`.

Override the default namespace by changing `MNUERON_NAMESPACE` in
`mcp-servers.json` — currently set to `elevizio`. Set it to whatever
matches the namespace your Cowork imports live in.

## Verifying recall works

After install + restart, in a fresh Cowork chat ask:

> "Use `memory_recall` to search for the Microsoft Store sandbox path
> discussion in namespace `elevizio`. Summarize what we figured out."

Expected: Claude calls `memory_recall` with that query, gets back
chunks from the imported Cowork transcripts, and summarises the
`%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\local-agent-mode-sessions\`
discovery. If you get a generic answer with no specifics, recall isn't
hitting — re-check the install steps above.

## Related

- mnueron CLI: `mnueron import --claude-cowork` (one-shot import)
- mnueron watch: `mnueron watch --claude-cowork` (incremental sync)
- Hosted dashboard: `https://www.mnueron.com/dashboard`
- Local dashboard: `mnueron dashboard` (localhost:3122)
