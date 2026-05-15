# MNUERON — Development Runbook & Engineering Log

A living document for anyone working on mnueron's source. If you're a user
trying to install and use the product, read `README.md` and `INSTALL.md`
instead. If you're trying to understand product direction, read `PLAN.md`.
If you're writing or reviewing code, this is your file.

**Convention:** when you fix a non-obvious bug or learn something the hard
way, append a dated note under the relevant section. The point of this
document is to spare the next engineer the time it took us.

---

## 1. Quick start (cold to working in ~5 minutes)

```powershell
# Prerequisites
node --version      # need ≥ 20 (24.x has been validated)
npm --version       # need ≥ 10

# 1. Install deps
cd mnueron
npm install

# 2. Build TypeScript
npm run build

# 3. Smoke test — proves the local SQLite + provider + hybrid search work
node scripts/smoke.mjs
# Expect: 7 green checks, "smoke test PASSED"
# The 7th check (semantic) may report "indeterminate" on the FIRST run
# because Transformers.js is still downloading the ~25MB ONNX model.
# Re-run and it'll pass.

# 4. Configure installed AI tools — wires mnueron into Claude Code,
#    Cursor, Cline, Windsurf, Claude Desktop (whichever are present).
node dist/cli.js setup

# 5. (One-time, only after upgrading from a pre-vector version) backfill
#    embeddings for memories that were saved without one.
node dist/cli.js rebuild-embeddings

# 6. Run the local dashboard
node dist/cli.js dashboard
# Browser opens to http://127.0.0.1:3122
```

## 2. Repo layout

```
mnueron/
├── src/                          Local MCP server (compiled into dist/)
│   ├── index.ts                  MCP server entry — stdio JSON-RPC
│   ├── cli.ts                    `mnueron` command (setup, import, search, dashboard, rebuild-embeddings, …)
│   ├── setup.ts                  Setup-wizard orchestration
│   ├── tools.ts                  MCP tool definitions (memory_save / recall / get / list / delete / namespaces / import_chat)
│   ├── config.ts                 Local vs remote provider switch
│   ├── detectors/                One file per supported AI tool (auto-config)
│   ├── store/
│   │   ├── provider.ts           Provider interface (the contract)
│   │   ├── local.ts              SQLite + FTS5 + sqlite-vec implementation
│   │   ├── remote.ts             HTTP client for hosted backend
│   │   └── embeddings.ts         Transformers.js wrapper — local ONNX embeddings
│   ├── dashboard/
│   │   └── server.ts             tiny http.createServer for the local dashboard
│   ├── import/                   Claude / OpenAI export parsers
│   └── plugins/                  Plugin loader (NOT YET WIRED — see PLAN.md Phase 3)
│
├── dashboard/                    Static UI files for the local dashboard
│   └── index.html                Single-page vanilla JS app
│
├── extension/                    Chrome extension (MV3)
│   ├── manifest.json
│   ├── background.js             Service worker — talks to mnueron HTTP API
│   ├── popup.html / popup.js     Toolbar UI: capture + backfill
│   ├── options.html / options.js Settings page
│   ├── scrapers/                 Per-site DOM scrapers (claude.ai, chatgpt.com, gemini stub)
│   └── lib/                      v0.1.9-merged: observer.js, content_extractor.js, self_healing.js, auth.js (NOT YET WIRED)
│
├── server/                       Hosted multi-tenant backend
│   ├── index.ts                  Express + Postgres + RLS + auth endpoints
│   ├── auth.html                 Browser-rendered signup/login page
│   ├── schema.sql / supabase_schema.sql
│   ├── summarizer.ts             Anthropic-Haiku summarizer (NOT YET WIRED — see PLAN.md Phase 3)
│   ├── selector_repair.ts        LLM-driven scraper-selector repair (NOT YET WIRED)
│   ├── extension_auth.ts         OAuth-style extension auth (NOT YET WIRED — competes with /v1/auth/* in index.ts)
│   ├── package.json
│   └── SUPABASE_SETUP.md         15-minute walkthrough to spin up Postgres
│
├── sdks/                         Python + C# client libraries
├── examples/                     Sample agents using mnueron (research, customer support, etc.)
├── scripts/
│   └── smoke.mjs                 End-to-end smoke test
├── PLAN.md                       Strategic roadmap (live document)
├── README.md                     User-facing product overview
├── INSTALL.md                    User install guide
├── ARCHITECTURE.md               Multi-tenant + threat-model design
└── DEVELOPMENT.md                THIS FILE
```

---

## 3. Verification recipes (one per subsystem)

Run each of these top to bottom whenever you touch the corresponding code.

### 3.1 Local MCP server

```powershell
node dist/index.js
# Expect ONE line of stderr:
#   [mnueron] mode=local ns=default db=C:\Users\...\.mnueron\memories.db
# It then hangs waiting for JSON-RPC. Ctrl+C to exit.
```

### 3.2 Local provider (CRUD + hybrid search)

```powershell
node scripts/smoke.mjs
```

Seven checks. First run after a `rebuild-embeddings` rebuild or after the
ONNX model is cached locally:

```
✓ save returned id=…
✓ search found 1 hit(s)
✓ list returned 1 item(s)
✓ namespaces includes "__smoke_…"
✓ delete returned true
✓ memory is gone after delete
✓ semantic search matched "Kubernetes/canary" content to query "deployment strategy"
```

If check 7 says "indeterminate", the model is still downloading — re-run.

### 3.3 Setup wizard

```powershell
node dist/cli.js setup --dry-run
```

Lists which AI tools would be configured. Then drop `--dry-run` to apply.
On Windows the paths the wizard checks are:

| Tool | Config path |
| --- | --- |
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` |
| Claude Code | `~/.claude/settings.json` (fallback) or `~/.claude.json` via `claude mcp add` if CLI on PATH |
| Cursor | `~/.cursor/mcp.json` |
| Cline (VS Code) | `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |

### 3.4 Dashboard

```powershell
node dist/cli.js dashboard
# Browser opens to http://127.0.0.1:3122
```

Manually verify: stats card populated, namespaces in sidebar, click a memory
to expand, search bar narrows, delete with confirm removes the row and
decrements stats.

### 3.5 Chrome extension

1. `chrome://extensions` → Developer mode → Load unpacked → pick `extension/`
2. Pin the icon, open popup. Backend should read "connected" if the
   dashboard server is running.
3. Open `https://claude.ai/chat/<any>` and click **Capture chat**. Toast
   should report N messages saved to `web-claude` namespace.
4. **Backfill flow:** click **Backfill all history** on a claude.ai tab.
   Progress bar should populate; dedup is on UUID via
   `chrome.storage.local.imported_chat_uuids`.

### 3.6 MCP integration in Claude Code

```powershell
claude mcp list
# Expect: mnueron: node C:\…\dist\index.js - ✓ Connected

claude
# in the prompt:
#   what memory tools do you have available?
# Expect six tools listed: memory_save / memory_recall / memory_get /
# memory_list / memory_delete / memory_namespaces / memory_import_chat
```

### 3.7 Hosted backend (when deployed)

Not yet deployed to anywhere public. To run locally against Supabase or
local Postgres, see `server/README.md`.

---

## 4. Common issues and fixes (institutional memory)

Append to this as you hit new ones.

### 4.1 `better-sqlite3` build fails on `npm install`

**Symptom:** `npm install` fails on Windows with
`MSB8020: The build tools for ClangCL cannot be found` or similar
`node-gyp` errors. Almost always because the version pinned in
`package.json` doesn't have a prebuilt binary for your Node version.

**Fix:**

```powershell
npm install better-sqlite3@latest
```

Then re-run `npm install`. We currently track `^12.10.0` because Node 24
needed it. Older docs that say `^11.5.0` are stale.

### 4.2 TypeScript: backticks inside template literals

**Symptom:** `src/store/local.ts:NN:NN - error TS1005: ',' expected.`
pointing at a SQL comment that contains an unescaped backtick.

**Fix:** SQL comments inside JS template literals must not use ``backticks``
for emphasis. Either drop the backticks or escape them with `\``. We hit
this once with the FTS5 sync comment.

### 4.3 TypeScript implicit-any self-referential initializer

**Symptom:** `TS7022: 'node' implicitly has type 'any' because it does not
have a type annotation and is referenced directly or indirectly in its own
initializer.`

**Fix:** add an explicit type annotation. Example from
`src/import/openai.ts`:

```ts
const node: OpenAINode | undefined = mapping[cursor];
```

### 4.4 FTS5 returns 0 hits for sane natural-language queries

**Symptom:** `memory_recall` finds nothing even when the saved content
clearly matches. Pattern: query is multi-word and natural-language.

**Cause:** FTS5 defaults to AND across tokens with no stemming. "how
mnueron stores memories" requires every token to appear; if the saved
content uses "stored" or "storage" instead of "stores", or doesn't have
the word "how", you get nothing.

**Fix already in place:** `buildFtsQuery` in `src/store/local.ts` strips
control characters, drops stop words, prefix-matches each token, ORs them
together. BM25 still ranks multi-hit rows higher. If you ever rewrite
search, keep this transform — natural-language queries against raw FTS5
will silently disappoint users.

### 4.5 sqlite-vec rejects LEFT JOIN with `IS NULL`

**Symptom:** `countMissingEmbeddings` returns 0 even though many memories
clearly have no vec entry.

**Cause:** vec0 virtual tables don't support `LEFT JOIN … WHERE memory_id
IS NULL` the way regular tables do — its `xBestIndex` rejects the plan
silently.

**Fix:** use a `NOT IN` subquery against `memories_vec`. This works in
`countMissingEmbeddings` and `rebuildEmbeddings` today.

### 4.6 sqlite-vec rejects KNN queries without a `k = ?` constraint

**Symptom:** `[mnueron] vector search skipped: A LIMIT or 'k = ?'
constraint is required on vec0 knn queries.`

**Cause:** sqlite-vec requires the k value to be expressed *inside* the
`WHERE` clause as `AND k = ?`, not as a SQL `LIMIT`. JOINing into the same
statement also confuses the planner.

**Fix in place:** do the bare KNN query with `AND k = ?` first, then
filter namespace in a second SELECT against the regular `memories` table.
See `src/store/local.ts` `search()`.

### 4.7 Chrome MV3 service worker runs stale code after extension reload

**Symptom:** popup sends a new message type, background returns
`unknown message type`. Or popup looks right but behavior is old.

**Cause:** Chrome's 🔄 button on the extension card doesn't always restart
the service worker — it can keep running the prior compilation in memory.

**Fix (in order of reliability):**

1. On the extension card click `service worker` link → DevTools → Stop button.
2. Toggle the extension off and on.
3. Remove the extension and Load unpacked again pointing at the same folder.

Then **also reload the page** the content script runs on (claude.ai etc.)
because content scripts are injected at navigation time, not extension
reload time. This is a separate gotcha — see 4.8.

### 4.8 Content scripts don't re-inject when extension is reloaded

**Symptom:** "Cannot establish connection. Receiving end does not exist."
when background calls `chrome.tabs.sendMessage` to ask a content script
to scrape.

**Cause:** content scripts are bound to the page navigation that loaded
them. Reloading the extension doesn't re-inject them into already-open
tabs.

**Fix:** reload the page (F5 / Ctrl+R) on each tab that should receive the
new content script.

### 4.9 Claude Code uses the wrong settings file

**Symptom:** wizard says `would write to ~/.claude/settings.json`, but
Claude Code never lists the mnueron tools after restart.

**Cause:** modern Claude Code reads user-scope MCP servers from
`~/.claude.json` (single file), set via `claude mcp add --scope user …`.
The `~/.claude/settings.json` path is a fallback that some versions don't
read at all.

**Fix:** make sure `claude --version` works (CLI on PATH). The detector
in `src/detectors/claude_code.ts` will then use `claude mcp add` instead
of writing JSON directly.

### 4.10 Claude Desktop not detected on Windows

**Symptom:** setup wizard says `Not detected: Claude Desktop` even though
the app is installed.

**Cause:** the detector checks `%APPDATA%\Claude\` which doesn't exist
until the app has been launched at least once.

**Fix:** launch Claude Desktop, quit it (right-click tray → Quit, NOT
just close window — see 4.11), then re-run `node dist/cli.js setup --only
claude-desktop`.

### 4.11 Claude Desktop won't pick up new MCP servers after wizard

**Symptom:** wizard configured the server fine, but Claude Desktop's chat
doesn't see the tools.

**Cause:** closing the Claude Desktop window doesn't quit the process —
it minimizes to the system tray. MCP servers only load at app *startup*.

**Fix:** right-click the Claude icon in the system tray → Quit. Verify in
Task Manager that no Claude process is running. Then relaunch.

### 4.12 MaxListenersExceededWarning from the dashboard server

**Symptom:** `MaxListenersExceededWarning: Possible EventEmitter memory
leak detected. 11 close listeners added to [Server].`

**Cause:** the popup polls every 600ms and the dashboard tab also keeps
connections alive — concurrent keep-alive connections exceed Node's
default cap of 10.

**Fix:** `server.setMaxListeners(0)` after `createServer` in
`src/dashboard/server.ts`. Already applied; if you split the server, don't
forget this on the new instances.

### 4.13 `memory_recall` returns megabytes of content and crashes the agent

**Symptom:** Claude Code reports "memory_recall returned a massive
1.4M-character result" and delegates the whole response to a subagent.

**Cause:** previously `memory_recall` returned the FULL content of each
of K matches. For backfilled chats, a single transcript can be 300K+
chars, so 5 matches = 1.5M of agent context.

**Fix in place:** `memory_recall` and `memory_list` now return previews
(first 800 chars) plus `content_full_length`, `content_truncated`. A new
`memory_get(id, max_chars=8000, offset=0)` tool returns the full content,
or a windowed slice if the agent doesn't need everything.

### 4.14 Single backfilled chat is 300K+ chars

**Symptom:** even with `memory_get` paging, one memory is 300K characters
because a long claude.ai session was captured as one memory.

**Cause:** the extension's backfill stores each conversation as a single
memory regardless of length.

**Proper fix (NOT YET DONE):** chunk long captures into ~5–10 atomic
memories at save time. Each chunk is searchable independently; the
parent conversation is linked via metadata. See `PLAN.md` Phase 1 #3.

**Current workaround:** the `max_chars` + `offset` paging on `memory_get`
lets agents read long memories in windows without context blowup.

---

## 5. Things sitting in the repo but not yet wired

These exist as code but aren't called by anything running today. See
`PLAN.md` for sequencing.

| Thing | Where | Wire it in |
| --- | --- | --- |
| Plugin system | `src/plugins/loader.ts` | Call from `src/index.ts` at startup; invoke processors from `tools.ts` save/recall handlers |
| Summarizer | `server/summarizer.ts` | Import in `server/index.ts` POST /v1/memories handler |
| Selector-repair endpoint | `server/selector_repair.ts` | Mount routes in `server/index.ts` |
| Extension OAuth flow | `server/extension_auth.ts` | Mount routes; reconcile with our `/v1/auth/*` endpoints |
| Self-healing scrapers | `extension/lib/{observer,content_extractor,self_healing}.js` | Add to `manifest.json` content_scripts; refactor `extension/scrapers/*.js` to use the observer |
| Firefox manifest | `extension/manifest.firefox.json` | Build script that swaps manifests by browser |
| Hosted dashboard | nowhere yet | New `dashboard-web/` Next.js app — see PLAN.md §4 |

---

## 6. Adding a new AI tool to the setup wizard

Pattern, in order:

1. Create `src/detectors/<tool>.ts` extending `JsonMcpDetector` if it uses
   JSON config, or extending `ToolDetector` directly if it's TOML or some
   other format. Implement `configPath()` and `isInstalled()`.
2. Register it in `src/detectors/index.ts` `allDetectors()`.
3. Add an entry to the wizard's supported list in `src/setup.ts`.
4. Test: `node dist/cli.js setup --only <tool-id> --dry-run`.

OpenAI's Codex CLI uses TOML and would need its own detector class —
this is currently the highest-value detector to add (see PLAN.md).

---

## 7. Adding a new chat-site scraper to the extension

1. Add a content script under `extension/scrapers/<site>.js`. The file
   must export (well, register via `chrome.runtime.onMessage.addListener`)
   handlers for `mnueron:scrape` at minimum. If you support backfill, also
   handle `mnueron:backfill_list` and `mnueron:backfill_get`.
2. Add the site to `manifest.json` under `content_scripts` and to
   `host_permissions`.
3. Update the popup's `SUPPORTED` map in `extension/popup.js`.
4. If the site has a usable internal API, prefer that over DOM scraping
   for backfill — much faster and more accurate. Use cookie-credentialed
   `fetch('/api/…', { credentials: 'include' })` from the content script.

---

## 8. Engineering log (append-only, dated)

### 2026-05-13 — Session 1: foundation + Chrome extension + cloud auth code

- Initial install fight: `better-sqlite3@^11.5.0` didn't have prebuilts for
  Node 24. Bumped to `@latest` (12.x). Documented in §4.1.
- First TS compile error: backticks inside template literal in `local.ts`
  SQL comment. Fix documented in §4.2.
- Second TS error: implicit-any on `mapping[cursor]` in `openai.ts`. Fixed
  with explicit type annotation. §4.3.
- Discovered FTS5 default AND semantics + no stemming → silently returns
  zero hits for natural queries. Added `buildFtsQuery` with stop words +
  prefix matching + OR. §4.4.
- Built local dashboard (`mnueron dashboard`), Chrome extension scaffold,
  Claude.ai backfill via internal API (`/api/organizations/.../chat_conversations`).
  146 chats backfilled successfully end-to-end.
- Added cloud-auth endpoints to `server/index.ts` (signup, login, me,
  tokens). Schema additions for `password_hash`, `email_verified_at`,
  `last_login_at`. Not yet deployed.
- Pulled v0.1.9 additive files (plugins, examples, summarizer,
  self-healing libs, Firefox manifest, mneme.py). Build still passes.
  Wiring deferred to Phase B/C.

### 2026-05-14 — Session 2: Phase 1 #1 — local semantic search

- Added `@xenova/transformers` + `sqlite-vec` deps. Tree pulled ~46
  transitive packages; 3 high + 1 critical CVE warnings, all in transitive
  ML-toolkit deps not exposed to user input. Acceptable for now.
- Created `src/store/embeddings.ts`: lazy-loaded `all-MiniLM-L6-v2`
  through Transformers.js, ONNX runtime on CPU, model cached to
  `~/.mnueron/models/`. Provides `embed()` (single) and `embedBatch()`
  (batched forward pass for `rebuildEmbeddings`).
- Wired `sqlite-vec.load(db)` and a `memories_vec` vec0 virtual table
  into `LocalProvider.migrate()`. Embeddings generated on save and
  bulkSave. Search rewrites use reciprocal-rank fusion (k=60) over FTS5
  results + vector results.
- Two sqlite-vec gotchas surfaced: LEFT JOIN with IS NULL is unsupported
  (§4.5), KNN queries need `AND k = ?` in WHERE (§4.6). Both fixed.
- Added `mnueron rebuild-embeddings` CLI command with diagnostics
  (memories count, vec count, missing count) and a `--force` flag for
  destructive re-embed. Smoke test extended to assert semantic match.
- Validated end-to-end: query "deployment strategy" semantically matched
  a memory containing only "Kubernetes / canary rollout" wording with
  zero literal overlap.
- Validated against real data: the user's 158-memory backfill (146
  claude.ai chats + earlier captures) now searchable by topic, not just
  keyword.

### 2026-05-14 — Session 2: Phase 1 #2 — sane MCP tool surface

- `memory_recall` was returning full content for K matches. Total
  response size hit 1.4M characters on a "hosting/deployment" query,
  forcing Claude Code to fan out to subagents to triage. §4.13.
- Refactored `memory_recall` + `memory_list` to return previews (first
  800 chars + length + truncated flag). Default `k` dropped 10→5,
  default `list limit` dropped 50→20.
- Added new `memory_get(id, max_chars=8000, offset=0)` tool with paging.
  Agent can window into long memories without context blowup.
- Validated against real data: same hosting query now retrieves five
  small previews in seconds; agent selectively fetches the relevant
  one(s), pages through a 307K memory in 6K windows. Real product-grade
  UX.
- Open follow-up: backfill chunking (PLAN.md Phase 1 #3) — a 307K chat
  should be ~30 atomic memories, not one giant blob.

---

_End of file. Keep appending — future you will thank present you._
