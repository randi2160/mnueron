# Installing MNUERON

Three install paths depending on what you want to do.

| You want to… | Use this section |
| --- | --- |
| Use it with Claude Desktop / Cursor / etc. on one machine (free, local) | [Path A](#path-a-local-mode-free-1-machine) |
| Use it across multiple machines / share with a team / build it into a SaaS | [Path B](#path-b-hosted-mode-multi-machine) |
| Use it from your own Python or .NET app | [Path C](#path-c-app-sdk) |

You can do A first, then add B and C later. Nothing locks you in.

---

## Prerequisites

| Need | Version | How to check |
| --- | --- | --- |
| Node.js | 20+ | `node --version` |
| npm | 10+ | `npm --version` |
| (For Path C, Python) Python | 3.9+ | `python --version` |
| (For Path C, .NET) .NET SDK | 6.0+ | `dotnet --version` |
| (For Path B) Supabase account or any Postgres 15+ with pgvector | — | Free tier at supabase.com |

If you don't have Node.js: install from https://nodejs.org/ (LTS version).

---

## Path A: Local mode (free, 1 machine)

This is the fastest path. Everything runs on your computer; nothing leaves it.
Memories live in `~/.mnueron/memories.db` (or `%USERPROFILE%\.mnueron\` on Windows).

### Step 1 — Install from source

```bash
git clone https://github.com/yourorg/mnueron.git
cd mnueron
npm install
npm run build
```

(Once we publish to npm, this becomes `npm install -g mnueron` and skip the rest.)

### Step 2 — Run the setup wizard

```bash
node dist/cli.js setup
```

The wizard scans for installed AI tools and configures each one. Expected output:

```
  🧠  mnueron — persistent memory for AI dev tools
      mode: local SQLite

Configured:
  ✓ Claude Desktop          added
  ✓ Cursor                  added

Not detected:
    Claude Code
    Windsurf
    Cline (VS Code)

✨ Done. Restart any running AI tool to load the memory plugin.
```

### Step 3 — Verify it works

Restart Claude Desktop (or any AI tool that was configured). In a new chat,
ask:

> "What memory tools do you have available?"

The AI should list `memory_save`, `memory_recall`, `memory_list`, `memory_delete`,
`memory_namespaces`, and `memory_import_chat`. If it doesn't, see [Troubleshooting](#troubleshooting).

### Step 4 — (Optional) Import your past chat history

```bash
# claude.ai → Settings → Privacy → Export data → wait for email
# Unzip the archive, find conversations.json

node dist/cli.js import ~/Downloads/conversations.json --ns personal
```

Each past Claude conversation becomes one searchable memory. Same command
works for ChatGPT exports — auto-detects format.

You're done with Path A.

---

## Path B: Hosted mode (multi-machine)

For when you want the same memories on your laptop, desktop, and work box —
or you're going to offer this as a service. The backend is multi-tenant by
design with row-level security per organization.

### Step 1 — Provision the database

Easiest path is Supabase free tier. **See `server/SUPABASE_SETUP.md` for the
full 15-minute walkthrough** — it covers:

- Creating the Supabase project
- Enabling the `vector` extension
- Applying the schema (`server/supabase_schema.sql`)
- Generating your first API token via the included `mnueron_signup()` function
- Getting the connection string

Skip ahead to Step 2 below when your database is ready.

### Step 2 — Run the backend

```bash
cd server
npm install express pg dotenv @types/pg @types/express

# Create server/.env with your connection string
cat > .env <<EOF
DATABASE_URL=postgresql://postgres.xxx:password@aws-0-region.pooler.supabase.com:6543/postgres
OPENAI_API_KEY=sk-...     # optional, omit to fall back to BM25-only search
PORT=3111
EOF

# Run it
npx tsx index.ts
```

You should see `mnueron-server listening on :3111`.

### Step 3 — Make the server publicly reachable

For "any computer, anywhere" access, the API needs a public HTTPS URL. Cheapest options:

- **Railway** — push the `server/` folder to GitHub, link to Railway, set env vars, done. ~$5/mo.
- **Lightsail** — $5/mo container, same shape as a Node app you'd deploy normally.
- **Fly.io** — $1.94/mo for a small VM.
- **Render** — $7/mo for always-on.

Whichever you pick, the result is a URL like `https://api.your-mnueron.com`.

### Step 4 — Point your local client at the hosted backend

```bash
node dist/cli.js setup --hosted https://api.your-mnueron.com --token mnu_xxxxxxxxxxxx
```

Repeat on every machine you want to use the hosted memory from. Same token = same memories everywhere.

---

## Path C: App SDK

For when you want your own Python or C# app to read and write memories. You
need a hosted backend (Path B) or you can hit the local server on
`http://localhost:3111` for development.

### Python

```bash
cd sdks/python
pip install -e .
```

Then in your app:

```python
from mnueron import Mnueron

with Mnueron(api_key="mnu_xxx", base_url="https://api.your-mnueron.com") as mem:
    mem.save("User prefers concise replies", namespace=f"user-{user_id}")
    results = mem.search("how does user like responses?", namespace=f"user-{user_id}")
    for r in results:
        print(r.content, r.score)
```

Or use the async version (`AsyncMnueron`) for `asyncio`-based apps.

### .NET / C#

Drop `sdks/csharp/MnueronClient.cs` into any .NET 6+ project. No NuGet package needed.

```csharp
using Mnueron;

using var mem = new MnueronClient("mnu_xxx", "https://api.your-mnueron.com");
await mem.SaveAsync("User prefers concise replies", $"user-{userId}");
var results = await mem.SearchAsync("how does user like responses?", $"user-{userId}");
```

---

## Configuration reference

| Variable | Used by | Purpose |
| --- | --- | --- |
| `MNUERON_API_URL` | CLI, MCP server | Hosted backend base URL. If unset, falls back to local SQLite. |
| `MNUERON_API_TOKEN` | CLI, MCP server | Bearer token for hosted mode. Required if `MNUERON_API_URL` is set. |
| `MNUERON_API_KEY` | Python SDK | Same as `MNUERON_API_TOKEN`. Both names work. |
| `MNUERON_DB_PATH` | CLI, MCP server (local mode) | Override the SQLite path. Default: `~/.mnueron/memories.db`. |
| `MNUERON_NAMESPACE` | CLI, MCP server | Default namespace when one isn't specified. Default: `default`. |
| `DATABASE_URL` | Backend (Path B) | Postgres connection string. |
| `OPENAI_API_KEY` | Backend (Path B) | Embedding provider. Optional — falls back to BM25-only search. |
| `PORT` | Backend (Path B) | Default 3111. |

---

## Uninstall

```bash
node dist/cli.js setup --uninstall
```

Removes mnueron from every tool's MCP config. Your local memories at
`~/.mnueron/` are preserved unless you delete the folder yourself.

---

## Troubleshooting

**Claude Desktop doesn't see the memory tools after setup.**
- Make sure you fully quit and restarted Claude Desktop (not just closed the window — quit the app).
- Check that the config file exists and is valid JSON:
  - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
  - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Look for a `mcpServers.mnueron` entry. If missing, re-run `setup`.

**`mnueron setup` says "tool not detected" but the tool is installed.**
- Run the tool once before setup so it creates its config directory.
- For Cursor, the detector looks for `~/.cursor/` — open Cursor once if it's a fresh install.

**Hosted mode: server returns 401 unauthorized.**
- Token mismatch. Check that `MNUERON_API_TOKEN` is set to the **raw** token (starts with `mnu_`), not the hash stored in the database.
- If you've lost the raw token, generate a new one and update the database `api_tokens.token_hash`.

**Hosted mode: server returns empty results for everything.**
- RLS is blocking. Check that `app.current_org_id` is being set per request. Look in `server/index.ts` for the `withTenantScope` helper.

**`pgvector` errors when applying the schema.**
- Extension not enabled. On Supabase: Dashboard → Database → Extensions → toggle `vector` on.
- On RDS or self-hosted Postgres: `sudo apt install postgresql-15-pgvector` then `CREATE EXTENSION vector;`.

**`bcrypt` or `better-sqlite3` errors during `npm install` on Windows.**
- These packages need a C++ build chain. Install `windows-build-tools` via npm or just use a Node version with prebuilt binaries (recent LTS works out of the box).

---

## Next steps after install

Once mnueron is working, the highest-value memories to save first:

1. **Project conventions** — `memory_save` with content like `"In this project: TypeScript strict mode, prettier with 2-space indent, no default exports, file names kebab-case"`.
2. **Tech stack facts** — `"Backend is FastAPI + Postgres + Redis. Frontend is Next.js 14 app router."`.
3. **Decisions and their rationale** — `"We chose pgvector over Pinecone for cost and self-host reasons (Mar 2026)."`.

The "click" moment — when mnueron feels indispensable — usually arrives about
two weeks in, when a new chat starts and the AI orients itself without you
re-explaining anything.

Anything else, file an issue or open a PR.
