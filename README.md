<p align="center">
  <img src="https://raw.githubusercontent.com/randi2160/mnueron/main/assets/promo-large-dark.png" alt="mnueron — memory for every AI" width="420" />
</p>

<p align="center"><strong>One memory layer. Every LLM. Every dev tool. Every app you build.</strong></p>
<p align="center"><sub>Persistent memory for Claude Desktop · Claude Code · Codex · Cursor · Windsurf · Cline — local-first, free forever, open source (MIT).</sub></p>

---

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│   Dev tools:                                                            │
│   Claude Desktop · Claude Code · Codex · Cursor · Windsurf · Cline ──► MCP ─┐   │
│                                                                     │   │
│   Your apps:                                                        ├─► │
│   Python SDK · C# SDK · TypeScript · REST ─────────────────────────┘   │
│                                                                         │
│            mnueron ──► [local SQLite]   FREE                            │
│                    ──► [hosted Postgres] $ optional                     │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## Why this exists

AI tools and AI apps are stateless by default. Every new chat session, your
AI starts from zero — you re-explain the same conventions, the same project
context, the same user preferences, every time. MNUERON gives your AI a
persistent memory that follows you across sessions, across machines, across
tools, and across LLM providers.

What changes day-to-day:

- **In Claude Desktop / Cursor:** A new chat starts knowing your project conventions, past decisions, and where you left off.
- **In your apps:** When a user comes back, the AI already knows their preferences — without you wiring it up per-provider.
- **Across providers:** Switch from OpenAI to Claude to Mistral without losing your customer's history. The memory layer is the constant.

## What's new

See [CHANGELOG.md](CHANGELOG.md) for the full history. Headlines:

- **Codex officially supported** — `mnueron setup --only codex` writes `~/.codex/config.toml` and the nine `memory_*` tools plus the procedural/runbook surface light up after a clean Codex restart. See [INSTALL.md](INSTALL.md#troubleshooting) for the Windows multi-process restart gotcha.
- **`mnueron primer`** — emit a CLAUDE.md / cursorrules-style memory primer (`mnueron primer > CLAUDE.md`)
- **5 more IDE detectors** — Continue, Zed, Aider, Goose, OpenCode
- **Platform API gaps closed** — date-range filter, PATCH update, bulk search, metadata-field filter
- **Webhook subscriptions** — HMAC-signed POSTs on memory events
- **Fact extraction** — long assistant responses get distilled into searchable facts
- **Backend secret redaction** — defense in depth on top of the client-side redactor
- **Chrome extension v0.2.0** — Local/Hosted toggle, recall + inject, ambient context, build-prompt multi-select
- **SDKs refreshed** — Python `0.3.1` + .NET `0.3` cover the new endpoints (date filters, PATCH, bulk search, webhook CRUD, HMAC verifier)
- **Claude Desktop import** — `mnueron import --claude-desktop` probes for and ingests Claude Desktop's export JSON

Full API docs at [mnueron.com/docs/api/overview](https://mnueron.com/docs/api/overview).

## What you get out of the box — free, forever

Run `mnueron setup` and every single one of these is yours. No account, no credit card, no telemetry. Your data lives at `~/.mnueron/memories.db` and never leaves your computer unless you explicitly opt into hosted mode.

| ✓ | What | Why it matters |
| :-: | --- | --- |
| ✓ | **Local MCP server** with six tools (`memory_save`, `memory_recall`, `memory_get`, `memory_list`, `memory_delete`, `memory_namespaces`) | Wires into Claude Desktop, Claude Code, Cursor, Windsurf, Cline. One memory layer, every tool. |
| ✓ | **One-command setup wizard** | Auto-detects every installed AI dev tool and configures each. Restart, you're live. |
| ✓ | **Hybrid local search** — BM25 keyword (SQLite FTS5) + semantic vector (Transformers.js + sqlite-vec) | Find memories by meaning, not just keywords. No OpenAI API key, no cloud calls, runs on CPU. |
| ✓ | **Web dashboard** (`mnueron dashboard`) | Browse, search, delete, drag-drop import — all from `localhost:3122`. |
| ✓ | **Chrome extension** for claude.ai and chatgpt.com | One-click **Capture chat** button. One-click **Backfill all history** — pulls your entire past claude.ai conversation list via their internal API in ~60 seconds. |
| ✓ | **Bulk importer** for Claude and ChatGPT export JSON files | Bring months of conversation history in one command. |
| ✓ | **Python + C# SDKs** | Use mnueron from your own apps with three lines of code. Provider-agnostic (works with OpenAI, Anthropic, Mistral, anything). |
| ✓ | **Plugin system** | Bring your own processors — PII redaction example included. |
| ✓ | **Self-host the hosted backend** | The multi-tenant Postgres + pgvector + RLS code in `server/` is yours. Run it on your own VPC if you want all the features below without paying us. |

All MIT-licensed. Fork, embed, modify, sell — whatever.

## Optional upgrade — hosted plan

When you want cross-machine sync or are running this for a team, the hosted plan handles it. Same client code; one env-var flip.

| Feature | Local (free) | Hosted |
| --- | :-: | :-: |
| All the local capabilities above | ✓ | ✓ |
| Cross-machine sync (laptop / desktop / work box) | — | ✓ |
| Hosted web dashboard with login | — | ✓ |
| Team / org-shared namespaces, role-based access | — | ✓ |
| Audit log + retention policies | — | ✓ |
| Embedding into your own SaaS (multi-tenant API) | self-host | ✓ |
| SSO / SAML, BAAs, SLAs | — | enterprise tier |

Pricing: **$9/mo Personal · $25/user/mo Team · custom Enterprise**. Full plan details at [mnueron.com/pricing](https://mnueron.com/pricing).

To flip a machine to hosted mode:

```bash
mnueron setup --hosted https://api.your-mnueron.com --token mnu_xxx
```

## Install

### Prerequisites

You need **Node.js 20 or newer** and **npm 10 or newer**. Check what you have:

```bash
node --version    # need v20.x or higher
npm --version     # need 10.x or higher
```

Don't have Node? Install from **<https://nodejs.org/en/download>** (pick LTS).
On macOS you can also use `brew install node@20`; on Ubuntu/Debian `sudo apt install nodejs`.

### Install mnueron

```bash
npm install -g mnueron
mnueron setup
```

That's it. Published on npm: <https://www.npmjs.com/package/mnueron>.

#### From source (for contributors)

If you want to hack on mnueron itself, the contributor quick start is one screen:

```bash
# 1. Clone + install
git clone https://github.com/randi2160/mnueron.git
cd mnueron
npm install

# 2. Build + smoke test (~30 seconds — verifies your environment)
npm run build
npm test                # runs scripts/smoke.mjs end-to-end

# 3. Make your local build the global `mnueron` command
npm link
mnueron setup           # wire it into your AI tools

# 4. Iterate
npm run dev             # tsx watch mode — re-runs on save
npm run typecheck       # tsc --noEmit, catches type errors fast
```

To switch back to the published version: `npm unlink -g mnueron && npm install -g mnueron`.

**Your first PR in 5 minutes:** read [`CONTRIBUTING.md`](CONTRIBUTING.md) (branch
naming, CLA, PR checklist) and [`DEVELOPMENT.md`](DEVELOPMENT.md) (engineering
runbook, verification recipes per subsystem). Both are short and assume you've
already done the steps above.

### What `mnueron setup` does

The setup wizard detects every AI dev tool you have installed, configures
each one, and reports back. Restart your tools and your AI remembers.

```
  🧠  mnueron — persistent memory for AI dev tools
      mode: local SQLite

Configured:
  ✓ Claude Desktop          added
  ✓ Claude Code             added via `claude mcp add`
  ✓ Cursor                  added

Not detected:
    Windsurf
    Cline (VS Code)

✨ Done. Restart any running AI tool to load the memory plugin.
```

## What your AI gets

Six new tools available to any MCP-compatible AI:

| Tool | What it does |
| --- | --- |
| `memory_save` | Save a memory (content, namespace, tags). |
| `memory_recall` | Search by relevance — called when you reference prior context. |
| `memory_list` | List recent memories, optionally filtered. |
| `memory_delete` | Delete by id. |
| `memory_namespaces` | List namespaces and their counts. |
| `memory_import_chat` | Bulk-import a Claude/ChatGPT export file. |

## Import your existing chat history

Bring months of Claude or ChatGPT conversations into your memory in one shot:

```bash
# Export from claude.ai → Settings → Privacy → Export data
# Export from chatgpt.com → Settings → Data Controls → Export

mnueron import ~/Downloads/conversations.json --ns my-project
```

Auto-detects Claude vs OpenAI format. Each conversation becomes a searchable
memory tagged `imported`.

### Import your Claude Cowork sessions

If you use Claude's "Cowork" mode (the desktop app's local agent mode), every
chat is already on disk as a JSONL transcript. mnueron can find and import
all of them with no export step.

#### CLI — one-shot import

```bash
# See what would be imported without saving anything
mnueron import --claude-cowork --probe

# Import every Cowork session into the default namespace ("claude-cowork")
mnueron import --claude-cowork

# Import into a custom namespace (e.g. group with one of your projects)
mnueron import --claude-cowork --ns elevizio

# Only import the 10 most recent Cowork sessions
mnueron import --claude-cowork --limit 10 --ns elevizio

# Parse everything but do NOT save — useful to confirm the parse is clean
mnueron import --claude-cowork --dry-run
```

Re-runs are safe: each session is upserted by `source_ref="cowork:<sessionId>"`,
so importing twice just refreshes any sessions whose transcripts have changed.

Where mnueron looks for transcripts:

| OS | Paths scanned |
|---|---|
| Windows (regular install) | `%APPDATA%\Claude\local-agent-mode-sessions\` |
| Windows (Microsoft Store install) | `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\local-agent-mode-sessions\` |
| macOS | `~/Library/Application Support/Claude/local-agent-mode-sessions/` |
| Linux | `~/.config/Claude/local-agent-mode-sessions/` |
| All | `~/.claude/projects/` (regular Claude Code) |

Each Cowork session becomes one memory. The chunker then splits long
transcripts per-turn so search returns the specific exchange, not the whole
6000-message session.

#### CLI — background watcher

Long-running mode: keeps Cowork in step with mnueron memory by re-importing
any session whose transcript file changes.

```bash
# Default: poll every 5 minutes, save into the "claude-cowork" namespace,
# run forever (Ctrl+C to stop).
mnueron watch --claude-cowork

# Custom interval (poll every 2 minutes) and namespace
mnueron watch --claude-cowork --interval 2 --ns elevizio

# Run exactly one sync tick and exit — useful for cron / Task Scheduler
mnueron watch --claude-cowork --once
```

The watcher persists last-synced mtimes per session at
`~/.mnueron/cowork-sync.json`, so restarting it doesn't re-import everything.

#### Dashboard — one-click import

```bash
# Open the dashboard at localhost:3122 in your browser
mnueron dashboard
```

Then click the **Import Cowork** button in the toolbar (next to the existing
**Import…** button). You'll get a confirmation showing the session and
message count before the import runs.

#### MCP — trigger from inside any Claude session

mnueron's MCP server exposes a `memory_import_cowork` tool. Once mnueron is
wired into Claude Desktop / Claude Code (`mnueron setup`), just say:

> "Import my cowork chats."

Claude will call the tool with sensible defaults. To pass specific options:

> "Use the `memory_import_cowork` tool with `namespace="elevizio"` and `limit=5`."

The tool accepts:
- `namespace` (string, default `"claude-cowork"`) — where to save the memories
- `limit` (number, optional) — cap how many sessions to import in this call
- `probe_only` (boolean, default `false`) — report what would be imported, don't save

#### Daily scheduled task

The Claude desktop app's scheduled-tasks feature can run the import on a
cron. Example: every weekday at 7am.

- Cron expression: `0 7 * * 1-5`
- Prompt for the scheduled task:

  ```
  Run the daily mnueron Cowork sync by calling the memory_import_cowork
  MCP tool with no arguments. Report a one-line digest of saved chunks
  vs total sessions.
  ```

This runs while the Claude app is open; if it's closed when the task is
due, it fires on next launch.

## Use it in your apps (Python)

```bash
pip install mnueron
```

```python
from mnueron import Mnueron
from openai import OpenAI

mem = Mnueron(api_key="mnu_...")
llm = OpenAI()

# Pull memory before the LLM call — provider-agnostic
context = mem.search(user_message, namespace=f"user-{user.id}", k=5)
context_str = "\n".join(m.content for m in context)

# Use any LLM you want — OpenAI shown here, swap for anthropic/mistral/gemini freely
resp = llm.chat.completions.create(
    model="gpt-4o-mini",
    messages=[
        {"role": "system", "content": f"What you know about this user:\n{context_str}"},
        {"role": "user", "content": user_message},
    ],
)

# Save anything worth remembering — same call regardless of provider
mem.save(extract_facts(resp), namespace=f"user-{user.id}", source="auto")
```

The same pattern works with Anthropic, Mistral, Gemini, or any other client —
mnueron doesn't know or care which LLM you're using.

## Use it in your apps (.NET / C#)

```csharp
using Mnueron;

using var mem = new MnueronClient("mnu_...");
var context = await mem.SearchAsync(question, $"user-{userId}", k: 5);
// Call any LLM API with `context` injected into the prompt
await mem.SaveAsync(newFact, $"user-{userId}");
```

Single-file C# client. Drop `MnueronClient.cs` into any .NET 6+ project. No
NuGet package required.

## CLI reference

```
mnueron setup                       Detect and configure all installed AI tools
       [--only <tool>]                claude-desktop | claude-code | codex | cursor | windsurf | cline
       [--hosted <url> --token <t>]   Hosted mode instead of local SQLite
       [--dry-run]                    Show what would change
       [--uninstall]                  Remove from all detected tools
mnueron import <file>               Bulk-import a Claude/OpenAI export
mnueron search <query>              Quick terminal search
mnueron stats                       Counts by namespace
mnueron namespaces                  List namespaces
```

## Self-host the hosted backend

The hosted backend in `server/` is yours — multi-tenant Postgres + pgvector
with row-level security. Step-by-step on Supabase free tier in
`server/SUPABASE_SETUP.md` (~15 minutes from empty database to working API).

```bash
# Quick start (Supabase recommended over RDS — see SUPABASE_SETUP.md)
psql $DATABASE_URL < server/supabase_schema.sql
cd server && npm install && npx tsx index.ts
```

## Supported AI dev tools

| Tool | Auto-configured | Notes |
| --- | --- | --- |
| Claude Desktop | ✓ | All platforms (macOS, Windows, Linux) |
| Claude Code | ✓ | Uses `claude mcp add` CLI when available |
| Codex | ✓ | `~/.codex/config.toml` |
| Cursor | ✓ | `~/.cursor/mcp.json` |
| Windsurf | ✓ | `~/.codeium/windsurf/mcp_config.json` |
| Cline (VS Code) | ✓ | VS Code globalStorage |
| Aider, OpenCode, Goose, Continue.dev, Zed | manual | All speak MCP |

`mnueron setup` is the intended out-of-the-box path. If a tool changes its MCP
config format or needs manual verification, see the exact config file paths and
JSON block in [INSTALL.md](INSTALL.md#manual-mcp-config-fallback).

## Repo layout

```
mnueron/
├── src/                        Local MCP server (Node, stdio)
│   ├── index.ts                Server entry point
│   ├── cli.ts                  setup | import | search | stats
│   ├── setup.ts                1-click wizard orchestration
│   ├── detectors/              One file per supported dev tool
│   ├── tools.ts                MCP tool definitions + handlers
│   ├── config.ts               Local vs remote provider switch
│   ├── store/                  Storage providers (SQLite local, HTTP remote)
│   └── import/                 Claude / OpenAI export parsers
├── server/                     Hosted multi-tenant backend
│   ├── schema.sql              Standalone Postgres schema
│   ├── supabase_schema.sql     Supabase-adapted schema
│   ├── index.ts                Express reference implementation
│   ├── README.md
│   └── SUPABASE_SETUP.md       15-minute step-by-step
├── sdks/
│   ├── python/                 Python SDK (sync + async)
│   │   ├── mnueron.py
│   │   ├── pyproject.toml
│   │   └── README.md
│   └── csharp/                 .NET / C# SDK
│       ├── MnueronClient.cs
│       └── README.md
├── INSTALL.md                  Full install guide (this is what most users read)
├── ARCHITECTURE.md             Multi-tenant design + threat model
├── LICENSE                     MIT
└── README.md                   You're here
```

## License

mnueron uses an **open-core** model. Full details in [`LICENSE-OVERVIEW.md`](LICENSE-OVERVIEW.md).

| Directory | License | What it means |
| --- | --- | --- |
| `src/`, `dashboard/`, `extension/`, `sdks/`, `examples/`, `scripts/` | **MIT** | Use, fork, embed, sell — no restrictions. Drop the SDK into commercial products freely. |
| `server/` (and future `dashboard-web/`) | **[FSL-1.1-Apache-2.0](server/LICENSE)** | Read, modify, contribute, self-host for your own use. You cannot launch a competing commercial memory-as-a-service. Each version auto-converts to Apache 2.0 two years after release. |

In short: **the client is fully open source. The hosted backend is source-available.** This is the same model Sentry uses, and it lets us welcome contributions while keeping a viable hosted business.

## Contributing

Contributions welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md). All contributors sign a one-time [Contributor License Agreement](CLA.md) (same pattern as Apache, Google, Microsoft).

## Status

Pre-alpha — works end-to-end but is still being shaped. If you find a rough
edge, file an issue; if you fix it, PRs welcome.
