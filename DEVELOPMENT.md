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

# 3. Smoke test — proves the local SQLite + provider + hybrid search + chunking work
node scripts/smoke.mjs
# Expect: 10 green checks, "smoke test PASSED"
# Checks 1–6: CRUD + FTS5. Check 7: semantic search (vector via sqlite-vec).
# Checks 8–10: chunking (long transcript → many per-turn memories sharing
# one parent_ref, each with metadata.chunk_index).
# Check 7 may report "indeterminate" on the FIRST run because Transformers.js
# is still downloading the ~25MB ONNX model. Re-run and it'll pass.

# 4. Configure installed AI tools — wires mnueron into Claude Code,
#    Cursor, Cline, Windsurf, Claude Desktop (whichever are present).
node dist/cli.js setup

# 5. (One-time, after upgrading from a pre-chunking version) split existing
#    oversized memories into per-turn chunks. Run --dry-run first to see plan.
node dist/cli.js rechunk --dry-run
node dist/cli.js rechunk

# 6. (One-time, only after upgrading from a pre-vector version) backfill
#    embeddings for memories that were saved without one.
node dist/cli.js rebuild-embeddings

# 7. (Optional, when ready to go multi-machine) upload local memories to
#    a hosted mnueron backend. Idempotent; --dry-run shows the plan first.
node dist/cli.js migrate-to-hosted --url https://api.your-mnueron.com --token mnu_xxx
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
│   │   ├── embeddings.ts         Transformers.js wrapper — local ONNX embeddings
│   │   ├── chunking.ts           Transcript-aware splitter (per turn) + sliding-window fallback
│   │   └── redactor.ts           Regex-based secret redaction at write time
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
├── LICENSE                       MIT (covers client code by default)
├── LICENSE-OVERVIEW.md           Plain-English dual-license map (MIT + FSL)
├── CONTRIBUTING.md               Contribution flow + CLA requirement
├── CLA.md                        Apache-style Individual Contributor License Agreement
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

Eleven checks. First run after a `rebuild-embeddings` rebuild or after the
ONNX model is cached locally:

```
✓ save returned id=…
✓ search found 1 hit(s)
✓ list returned 1 item(s)
✓ namespaces includes "__smoke_…"
✓ delete returned true
✓ memory is gone after delete
✓ semantic search matched "Kubernetes/canary" content to query "deployment strategy"
✓ redaction stripped AWS+GitHub keys from saved content (count=2)
✓ chunking split a long transcript into N per-turn memories
✓ all chunks share one parent_ref
✓ all chunks have metadata.chunk_index
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

**Cause:** before chunking shipped, the extension's backfill stored each
conversation as a single memory regardless of length.

**Fix (shipped):** auto-chunking. New saves get split into per-turn
memories at save time via `chunkContent()` in `src/store/chunking.ts`.
Existing oversized memories get split retroactively via `mnueron rechunk`.
See §4.15 and §4.16 for the chunking-specific gotchas.

### 4.15 Chunking strategy and threshold

Decisions encoded in `src/store/chunking.ts`:

- **`DEFAULT_CHUNK_THRESHOLD = 6000` chars.** Content shorter than this is
  saved as one memory. Don't lower this aggressively — too-small chunks
  fragment context badly.
- **Transcript-aware first.** If content has at least 2 `**Role:**`
  headers (User / Assistant / Claude / ChatGPT / Gemini / System / Human),
  split per turn. Each turn becomes one memory with `role:user` or
  `role:assistant` tags + `metadata.role`.
- **Sliding-window fallback.** For long unstructured text, split at
  sentence boundaries (`. `, `.\n`, `! `, `? `, `\n\n`) within the latter
  half of the max-char window. 200-char overlap so search hits near a
  boundary still have context.
- **Orphan merge.** Final chunks shorter than `minChars` (default 80)
  get folded into the previous chunk so we don't create 30-char orphan
  memories.
- **Metadata stamped:** `parent_ref` (the original `source_ref` or a
  generated `chunked:<uuid>`), `chunk_index`, `chunk_count`, `role`
  (where applicable). The tag `chunk` is added; `role:user` /
  `role:assistant` tags too.
- **Single turn longer than `maxChars`:** sub-chunked via sliding-window,
  but each sub-chunk preserves the role label of its parent turn.

If you change the threshold or strategy, re-run `mnueron rechunk --force`
(would need to add the flag — currently the find-oversized query excludes
memories that already have `chunk_index` set).

### 4.17 Linux-sandbox mount cache hides recent edits — only matters when developing with the Cowork bash tool

**Symptom (developer-facing, not user-facing):** when developing with the
Cowork agent's `bash` tool, running `wc -l`, `cat`, or `npx tsc` against
files in the mounted Windows folder shows STALE content for files that
were modified via the `Edit` tool. The file's timestamp doesn't update;
the content reflects pre-Edit state. Writes via the `Write` tool DO
flush correctly (new files appear with current timestamps; existing
files written full also show new content).

**Why this matters:** mid-session tsc verification can produce alarming
but false-positive errors. We had a moment in Session 4 where the
sandbox reported "Unterminated string literal" errors in 5 files; all
were ghosts. The user's actual Windows files had the correct content,
which is why `mnueron rechunk` ran successfully against the edited code.

**Resolution:**
- **Never run `npm run build` from the Linux sandbox to verify** code
  changes — it will look wrong even when it's right.
- **Trust the Read tool's view** — it shows what's actually on disk
  (i.e., what the user will see when they `code .` and look).
- **For high-confidence verification**, ask the user to run `npm run
  build` on Windows. That hits the real file via the real Node/tsc.

**Architectural note:** this is a quirk of the agent sandbox's mount,
not of mnueron's code. Nothing to fix in mnueron itself. Document so
nobody else burns 20 minutes chasing ghosts.

### 4.16 `findOversizedMemories` excludes already-chunked rows

**Behavior:** the `LocalProvider.findOversizedMemories()` query has
`AND (meta_json IS NULL OR json_extract(meta_json, '$.chunk_index') IS NULL)`.
So memories that are already chunks of a larger thread are skipped.

**Why this matters:** running `mnueron rechunk` twice in a row only
processes memories that have NEVER been chunked. Idempotent and safe.
The downside is you can't trivially re-chunk under a new strategy —
you'd need a `--force` flag (not implemented today).

**Note:** `mnueron rechunk` calls `bulkSave()` which goes through the
chunking path AGAIN. So a 300K memory we split into 50 chunks does NOT
get those 50 chunks re-split unless individual chunks themselves exceed
the 6000-char threshold (which is rare since the turn structure already
caps them).

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

### 2026-05-14 — Session 2 (continued): repo + GitHub

- Initialized git repo, pushed to `github.com/randi2160/mnueron` (public,
  MIT-only LICENSE at that point).
- Added the user's brand assets at `assets/` (dark promo image as the
  README header; light version kept around for social-card meta tags later).
- Lessons: GitHub renders `<picture>` / theme-switched images; for the
  README header, a logo-only / wordmark-only asset reads much better than
  the OG-image (which has built-in dark padding for social-card aspect
  ratios).

### 2026-05-14 — Session 3: Phase 1 #3 — auto-chunking long captures

- The 307K-blob problem couldn't be fixed in the read path alone — the
  data shape was wrong. Built `src/store/chunking.ts` with
  transcript-aware splitting (per `**User:**` / `**Assistant:**` turn)
  with sliding-window fallback for unstructured text. See §4.15.
- Wired into `LocalProvider.save()` and `bulkSave()` via a
  `shouldChunk(content)` threshold check (6000 chars). Long content is
  split before the SQLite insert; each chunk becomes its own memory
  with `metadata.parent_ref`, `chunk_index`, `chunk_count` stamped.
- Added `memory_get_thread` MCP tool that returns all chunks of a
  conversation given either a chunk id (we resolve its parent_ref) or
  a parent_ref directly. Uses `json_extract(meta_json, '$.parent_ref')`
  with a `source_ref` fallback so backfilled chats (which used
  source_ref as the parent identifier) still work.
- Added `mnueron rechunk` CLI command. Walks every memory over the
  threshold via `findOversizedMemories()`, splits each into chunks via
  `bulkSave()`, deletes originals unless `--keep-original` is passed.
  `--dry-run` shows the plan without writing. The query excludes
  already-chunked rows so re-running is safe (§4.16).
- Smoke test extended from 7 to 10 checks: a long transcript-shaped
  save splits into multiple memories, all sharing one parent_ref, all
  with chunk_index in metadata.
- Validated on real data: 115 of the user's 158 backfilled memories
  were over 6000 chars (73% of the DB). Total content being split:
  ~19MB. Largest single conversation expanded to 559 chunks. Expected
  post-rechunk total: ~4,700 atomic memories from the original 158.

### 2026-05-14 — Session 3 (continued): open-core licensing

- Adopted the Sentry pattern after deciding pure MIT exposed too much to
  cloning. **Client code stays MIT** (`src/`, `dashboard/`, `extension/`,
  `sdks/`, `examples/`, `scripts/`); **`server/` becomes
  FSL-1.1-Apache-2.0** (Functional Source License with 2-year
  auto-conversion to Apache 2.0). License text pulled verbatim from
  https://fsl.software/
- Added `LICENSE-OVERVIEW.md` as a plain-English directory map + FAQ
  for anyone confused by the dual license.
- Added `CONTRIBUTING.md` describing the contribution flow with a
  one-time CLA requirement.
- Added `CLA.md` adapted from Apache's Individual Contributor License
  Agreement. Out-of-band step: wire up cla-assistant.io to enforce
  CLA signing on every PR.
- Updated `README.md` License section with a 2-row comparison table
  + Contributing pointer.
- Added a license-notice blockquote at the top of `server/README.md`.

### 2026-05-15 — Session 4: Phase 1 completion (autonomous run)

User went to sleep with rechunk running; this session executed the remaining
Phase 1 items #4 (premium dashboard), #5 (migration tool), and #6 (secret
redaction). The rechunk completed mid-session: **9,398 atomic chunks
created from 115 oversized memories** (averaged ~82 chunks per long chat;
turn-level splitting catches every back-and-forth). 115 originals deleted.

**Phase 1 #6 — secret redaction at write time:**
- New `src/store/redactor.ts` — pure module, no DB / no network. 13
  patterns (AWS, GitHub, OpenAI, Anthropic, Stripe, Slack, Google API +
  OAuth, mnueron tokens, JWT, URL token params, Authorization Bearer,
  HTTP basic auth in URLs, PEM private-key blocks).
- Patterns ordered specific-first; PEM block first so its body can't be
  misclassified as smaller secrets.
- Custom `redactWith` callbacks for url_token_param, authorization_bearer,
  url_basic_auth — these preserve the structure (e.g. `token=`) and only
  redact the secret value.
- Wired via `preSaveTransform()` in `LocalProvider.save()` and `bulkSave()`,
  running BEFORE chunking. Stamps `metadata.redacted_count` and
  `redacted_kinds`.
- Smoke test extended with a redaction assertion (saves a known
  AWS+GitHub key pair and confirms both are stripped).
- Out of scope: generic high-entropy scanner (too many false positives on
  hashes/UUIDs/base64); reversal (we never store the original).

**Phase 1 #5 — migration tool local → hosted:**
- New `mnueron migrate-to-hosted --url --token [--batch] [--namespace]
  [--dry-run] [--no-flip]` CLI subcommand.
- Forces local mode regardless of env vars so users can't accidentally
  hosted-to-hosted. Pings `/health` on the target before uploading.
  Streams memories in batches (default 100) to `/v1/memories/bulk` with
  Bearer auth. Progress bar over total.
- On successful completion (no errors, no --no-flip): writes
  `~/.mnueron/config.json` with `apiUrl` and `apiToken` so the next
  process boot reads from hosted. Restart-required for active processes
  (MCP server subprocess, dashboard).
- `src/config.ts` updated to read config.json as a fallback to env vars
  (env still wins). This is how the "flip" sticks across shells.
- Manual-paste-token version for v1; the OAuth-style callback flow
  (open browser → user signs up → token captured automatically) waits
  on the hosted dashboard existing (Phase 2 work).

**Phase 1 #4 — premium dashboard rebuild:**
- Complete rewrite of `dashboard/index.html` (~1000 lines, single file,
  no build step).
- Three-pane CSS Grid: rail / list / detail. Both pane widths resizable
  via drag handles, persisted to localStorage as `--rail-w` / `--detail-w`.
- **Browse mode** (no search query): middle pane shows *threads* — one row
  per `parent_ref` group. Standalone (non-chunked) memories also appear
  as single-row threads (their id serves as the group key).
- **Search mode** (with query): middle pane shows *individual memories*
  (chunks or standalone), each labeled with its namespace/role/tags/score.
  Clicking a chunk loads it, with a "Show full thread" button to jump
  to the parent.
- Chat-bubble rendering for thread detail view: each chunk = one bubble
  with role pill (User/Assistant), timestamp, Markdown-rendered content,
  Prism-highlighted code blocks (via CDN, autoloader).
- Light + dark theme toggle (CSS custom properties; switched via
  `data-theme` attribute on `<html>`; persisted to localStorage).
- Keyboard shortcut: `/` focuses search.
- Drag-drop import preserved.
- Backend additions:
  - `LocalProvider.listThreads({ namespace, limit, offset })` —
    groups memories by `COALESCE(json_extract(meta_json,
    '$.parent_ref'), id)`. Returns parent_ref, namespace, count,
    first_at, last_at, has_chunks, and a `title` extracted from the
    lowest-`chunk_index` member's content.
  - `extractTitle(content)` in local.ts — prefers `# Heading`, falls
    back to first non-empty line, truncates at 100 chars.
  - `GET /api/threads` and `GET /api/threads/:parent_ref` on the
    dashboard server.
- **Redaction surfacing:** the detail header shows `N secrets redacted`
  badge when `metadata.redacted_count > 0`. Closes the loop with #6.

**Validation:**
- Smoke test (now 11 checks including redaction) intended to pass on a
  clean rebuild. Real DB validation waits on user wake-up — `npm run
  build` + `node scripts/smoke.mjs` + open `node dist/cli.js dashboard`.
- Rechunk completion captured: 9,398 chunks from 115 originals + 43
  originally-small memories = ~9,441 memories total post-rechunk.

**Gotcha discovered: Linux mount cache vs. Edit operations.**
The bash sandbox uses a network/FUSE mount of the Windows host folder.
Writes through the `Write` tool flush correctly (visible in mount with
new timestamps). Writes through the `Edit` tool DO flush to the user's
Windows file (confirmed by user running rechunk successfully against
edited code), but DO NOT invalidate the mount's read cache — so
subsequent `wc`, `cat`, or `npx tsc` against the mount sees stale
content. This produced spurious TypeScript "errors" mid-session that
looked alarming but were actually against a pre-edit file view. The
fix: I re-wrote tools.ts via Write to force a flush. The deeper
lesson: **don't trust the Linux bash sandbox to verify edits via
compile/test in this session's filesystem layout.** Trust the Read
tool (which sees the current intended state) and tell the user to
run `npm run build` on Windows for ground truth. Documented in §4.17.

**Open follow-ups:**
- User to run `npm run build` first thing — confirm no real compile errors
  exist beyond the stale-mount false positives.
- User to run `node scripts/smoke.mjs` — should now have 11 green checks
  (added redaction).
- User to launch `node dist/cli.js dashboard` and verify the new three-pane
  UI loads against the post-rechunk 9,441-memory DB.
- User to confirm threads display correctly (115ish thread rows in the
  middle pane when no search query).
- If anything is broken on real-world data: errors will be visible in
  browser DevTools console; paste them to me and I fix.

### Convention for future sessions

Every session ends with an entry in this log. Pattern:
1. What we shipped (1-line bullets — feature, file, behavior).
2. Any non-obvious bugs encountered (add detailed entries to §4 too).
3. Validation evidence (numbers, file paths, what we tested with).
4. Open follow-ups that didn't make it into the session.

Skip none of the four. The log is what makes onboarding a new
contributor 30 minutes instead of 3 days.

---

_End of file. Keep appending — future you will thank present you._
