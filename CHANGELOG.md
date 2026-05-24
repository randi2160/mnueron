# Changelog

All notable changes to mnueron. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/) — version blocks list
the user-facing changes, deeper engineering rationale lives in commit
messages and PR descriptions.

## [Unreleased]

In the repo on `main` but not yet published.

## [0.5.0] — 2026-05-23

Major release. Procedural memory + entity resolution + knowledge graph +
self-revising memory + four new MCP tools that wire runbooks into every
AI tool that talks to mnueron.

### Added (MCP — procedural tools for AI agents)
- **Four new MCP tools** — `procedural_match` (trigger-phrase lookup),
  `procedural_list`, `procedural_get`, `procedural_record_outcome`. AI
  agents (Claude Desktop, Cursor, Windsurf, Cline) can now query saved
  runbooks directly. Hosted mode only for now; local SQLite procedural
  bridging is a follow-up.
- **`memory_recall` auto-surfaces runbooks.** When an agent calls
  `memory_recall("ship to vercel")`, any saved runbook whose
  `trigger_phrases` match is returned alongside memory previews in a new
  `procedurals` field. Invisible to old clients (response stays flat
  array when no runbooks match); new clients get the richer envelope.
- **`/api/recall/unified`** — new hosted endpoint the MCP layer calls.
  Runs BM25 against memories AND trigger-phrase + ILIKE against
  procedural_memories in parallel, returns both in one round trip.
  Auto-logs recall events so the analytics dashboard's `recall_count`
  stays accurate.

### Added (Multi-provider LLM fallback)
- **OpenAI fallback everywhere** — summarizer, entity-extractor,
  relation-extractor, entity-resolver, and consolidator-merge all now
  follow the same four-step chain: BYOK Anthropic → BYOK OpenAI →
  server Anthropic → server OpenAI. Set `OPENAI_API_KEY` and every LLM
  feature in mnueron runs on GPT-4o-mini without needing an Anthropic
  account.
- **Structured merge failures** — `mergeMemoriesWithLLM` now returns
  `{ ok: false, reason, message }` with the real upstream error
  (4xx/5xx, model name, rate limit) instead of `null`. The
  consolidate UI surfaces the real reason.

### Added (Procedural memory — Mem0 leapfrog)
- **Procedural memory** — a third memory type alongside semantic + episodic.
  Captures step-by-step runbooks ("how to deploy the API") that can be
  recalled by name. Mem0/Letta/Zep don't ship this; this is a competitive
  differentiator.
- **`mnueron procedural <save|list|show|recall|delete>`** — CLI surface.
  Save explicit steps from a JSON file or LLM-extract a runbook from an
  existing memory via `--from-memory <id>`.
- New table: `procedural_memories` (id, namespace, name, summary,
  steps_json, tools_json, last_used_at, use_count). Unique on
  (namespace, lower(name)) so each name resolves deterministically.
- Provider methods: `saveProcedural`, `getProcedural`, `listProcedural`,
  `recallProcedural` (bumps last_used_at + use_count), `deleteProcedural`.

### Added (P2.3 — Entity-resolution backfill CLI)
- **`mnueron entities backfill`** — retro-fit canonical IDs onto memories
  saved before the resolver shipped. Flags: `--ns`, `--limit`, `--since`,
  `--extract` (also run extraction for memories with no entities),
  `--dry-run`, `--force` (re-resolve already-resolved).
- New provider method `backfillResolveMemory` — runs the resolver against
  an existing memory's entities and writes the resulting canonical_ids
  back to metadata.
- Verbose error reporting on backfill failures (silent failures hid a
  schema bug previously — see fix below).

### Fixed
- **Local update() referenced wrong column names.** `tags` / `metadata`
  → `tags_json` / `meta_json`. Pre-existing bug surfaced by the
  backfill path. Silent SQLite "no such column" was eating every
  metadata-only update.

### Tightened
- **Entity extractor prompt** (both local and hosted). Added strong
  inclusion criteria + explicit exclusion list to cut noise like
  "Step 1 view file", "DB-backed", "server-side validation", and
  hostnames classified as "place". Returns [] when fewer than 2
  high-quality entities exist — better to skip than fill with noise.

### Added (P2.3 — Local SQLite entity resolution)
- **Local entity resolution** matches the hosted `/api/entities` capability:
  when entity extraction (P1) stamps `metadata.entities` on a save, the
  resolver now assigns a `canonical_id` to each one. Same person mentioned
  across 30 memories collapses to one entity row.
- **Embedding-similarity resolver** — local impl uses sqlite-vec cosine
  similarity instead of pg_trgm (hosted's tool). More semantically robust
  than trigrams; "JS" and "JavaScript" cluster as the same entity.
  Thresholds: ≥0.85 = auto-reuse, 0.65–0.85 = LLM tiebreak via Haiku,
  < 0.65 = create new canonical.
- **New tables** (idempotent CREATE IF NOT EXISTS, no migration script):
  `entities`, `entities_vec`, `memory_entities`. Created on first
  `LocalProvider` construction.
- **`mnueron entities <list|show|merge>`** — CLI to browse and curate.
  List with `--type`, `--q`, `--sort recent|mentions|alpha`. Show prints
  full details + linked memories with surface forms. Merge collapses two
  canonicals into one (aliases + edges absorbed).
- Provider interface gained `listEntities`, `getEntity`,
  `getEntityMemories`, `mergeEntities` (optional methods — hosted will
  mirror these on the SDK side).

### Added (P3 — Knowledge graph)
- **Relationship extraction** — after entity resolution succeeds, a second
  Haiku call extracts triples (`from_entity`, `predicate`, `to_entity`)
  from the memory text. Each edge carries provenance (`memory_id`) +
  `confidence`. New `relations` table with indexes on from/to/predicate.
- **Predicate normalization** — snake_case lowercase verb phrases (e.g.
  `recommended`, `works_at`, `deprecated_for`). Self-loops dropped.
  Confidence floor 0.5.
- **`mnueron graph <show|traverse|relations>`** — CLI to query the graph.
  `show` lists incoming + outgoing edges for one entity. `traverse` does
  BFS out to `--depth N` (capped 5). `relations` is the raw query layer
  for scripting.
- Provider interface gained `getRelations` and `traverseGraph`.
- Gated by `MNUERON_ENABLE_RELATION_EXTRACTION=true` env var or
  per-call `metadata.extract_relations: true` (mirrors entity gating).
  Adds ~$0.001 per save when active.

### Added (P4 — Temporal reasoning / bi-temporal)
- **Validity windows on relations** — extraction prompt also asks for
  `valid_from` / `valid_to`. Stored as nullable epoch-ms columns on
  `relations`. Null on both = "fact has no known time bounds, treat as
  always valid."
- **`--as-of <ISO-date>` filter** on `getRelations` and `traverseGraph`.
  Returns only edges that were valid at that point in time. Powers
  queries like "what did John recommend in Q1?" or "who reported to
  whom in 2024?".
- The `valid_from`/`valid_to` columns were added in the P3 schema rev
  already, so no separate migration was needed for P4.

### Added (P5 — Self-revising memory loop, phase 5a)
- **Detection-only consolidation** — `mnueron consolidate detect` walks
  recent memories, vector-searches top-K neighbors per memory, and
  enqueues `consolidation_proposals` rows for pairs above a similarity
  threshold (default 0.92). No automatic merges — safe to run any time.
- Idempotent via a `(memory_a_id, memory_b_id, kind)` UNIQUE INDEX —
  re-scans don't multiply proposals.
- **`mnueron consolidate <list|approve|reject>`** — review queue. Phase
  5a just records the decision; phase 5b will action approved merges
  with full audit + reversal support.
- Provider gained `detectConsolidation`, `proposalsList`,
  `proposalReview`.

### Added (Cowork local import)
- **`mnueron import --claude-cowork`** — auto-import every Claude Cowork
  ("local agent" desktop mode) session transcript from disk. Walks all
  platform-specific roots including the Microsoft Store sandboxed location
  (`%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\local-agent-mode-sessions\`),
  recursively finds JSONL transcripts, filters by the `local-agent-mode-sessions`
  cwd marker, and dedups by sessionId. Each session is saved as one memory
  in the `claude-cowork` namespace (the chunker then splits per-turn).
  Idempotent via `source_ref="cowork:<sessionId>"`. Flags: `--probe`,
  `--ns <name>`, `--limit <n>`, `--dry-run`.
- **`memory_import_cowork` MCP tool** — same logic exposed to any
  MCP-connected agent so users can say "import my cowork chats" inside a
  Claude session and have it run end-to-end. Accepts `namespace`, `limit`,
  and `probe_only` parameters.
- **Dashboard "Import Cowork" button** — local dashboard at `localhost:3122`
  gains a one-click import. Backed by new endpoints `GET /api/import/claude-cowork`
  (probe) and `POST /api/import/claude-cowork` (run). Confirms session +
  message count before saving.
- **`mnueron watch --claude-cowork`** — long-running incremental sync.
  Polls every `--interval <minutes>` (default 5) and re-imports any session
  whose transcript mtime has advanced. State persists at
  `~/.mnueron/cowork-sync.json`. `--once` runs a single tick and exits;
  Ctrl+C is caught and flushes state cleanly.

### Fixed
- **Microsoft Store Claude Desktop install now detected.** `mnueron setup
  --only claude-desktop` used to say "Claude Desktop not detected" for
  users running the Microsoft Store build, because the detector only
  looked at `%APPDATA%\Claude\`. The Store sandboxes app writes into
  `%LOCALAPPDATA%\Packages\Claude_<sfx>\LocalCache\Roaming\Claude\`. The
  detector (and the Cowork importer's probe) now walk both paths.
- **`RemoteProvider` migrated `/v1/*` → `/api/*`.** The CLI was pointing at
  the unshipped standalone `server/index.ts` route prefix. The actual
  deployed hosted backend is the Next.js app under `ai-boilerplate-pro`,
  which exposes `/api/memories`, `/api/namespaces`, etc. Re-wired
  + added pre-chunking, 1-write/sec throttle, 429 backoff, retry-on-5xx.

### Added (P1+P2 — Entity layer)
- **Entity extraction on save.** When `metadata.extract_entities: true` is
  set per-call (or `MNUERON_ENABLE_ENTITY_EXTRACTION=true` is exported),
  the local provider runs Claude Haiku 4.5 (or gpt-4o-mini with BYOK) over
  the memory content and stamps `metadata.entities = [{name, type, context}]`.
  Types: person, organization, project, technology, place, decision, event,
  concept, other. Fail-open: save still succeeds even if extraction errors.
  Cost: ~$0.001/save at Haiku pricing. No new dependencies — uses raw
  fetch to keep the CLI install lean.
- `mnueron extract-entities` — CLI subcommand to retroactively extract
  entities from existing memories. Flags: `--ns <name>`, `--since <epoch_ms>`,
  `--limit <n>` (default 100, max 1000), `--force` (re-extract memories
  that already have entities), `--dry-run`. Requires `ANTHROPIC_API_KEY`
  or `OPENAI_API_KEY` in the environment.
- Cross-session entity resolution is hosted-only for v1 — see the
  `ai-boilerplate-pro` repo's `/api/entities` endpoints. Local SQLite
  gets the resolution layer in a future release.

### Added (CLI)
- `mnueron primer` — emit a CLAUDE.md / cursorrules-style primer that
  tells your AI it has memory tools available and sketches the current
  store. Drop the output in your repo root so Claude Code / Cursor /
  Windsurf use `memory_recall` proactively.
  - Flags: `--ns <name>`, `--recent <n>`, `--out <file>`
- v0.2.7 detectors: Continue, Zed, Aider, Goose, OpenCode. `mnueron setup`
  now covers ten dev tools out of the box. Zed uses a custom non-mcpServers
  config key (`context_servers`). Aider is detected as "present, manual
  integration only" — Aider doesn't speak MCP natively yet.
- Provider interface gained `bulkSearch(input)` and `update(id, patch)`
  with full filter support: `created_after`, `created_before`,
  `updated_after`, `updated_before`, `metadata_filter`.
- Local SQLite provider honors all the new filters via `json_extract`
  (top-level metadata k=v matches) + `created_at` / `updated_at` bounds.
- Local dashboard HTTP server (`mnueron dashboard`) now exposes
  `GET /api/memories` with date + metadata filter query params,
  `POST /api/memories/search/bulk`, and `PATCH /api/memories/:id`.

### Added (hosted backend on mnueron.com)
- **v0.4 — auto-synopsis on save.** Long-content memories (>800
  chars) get a 1-2 sentence summary stamped into
  `metadata.summary` via Claude Haiku (~$0.0015/call). Triggers:
  `ENABLE_AUTO_SUMMARY=true` env var (paid tier), per-call
  `metadata.summarize: true` (opt-in), or per-call
  `metadata.byok_anthropic_key` (bring-your-own-key; the key is
  used once and stripped before persisting). Fail-open.
- **v0.2.1 — date-range filter.** `GET /api/memories` accepts
  `created_after`, `created_before`, `updated_after`, `updated_before`
  (epoch ms). Stacks with `q`, `namespace`, `metadata_filter`.
- **v0.2.2 — PATCH `/api/memories/:id`.** Partial update. Logs change to
  `metadata.history`. Metadata patches are MERGED (pass `null` to
  remove a key).
- **v0.2.3 — `POST /api/memories/search/bulk`.** Multi-query search in
  one HTTP round-trip. Max 25 queries per batch, max k=50 per query.
- **v0.2.4 — metadata field filtering.** `metadata_filter=<url-encoded JSON>`
  on GET memories + bulk search. Translates to Postgres `@>` operator.
- **v0.2.9 — fact extraction.** Memories with content > 500 chars trigger
  a Haiku 4.5 call that extracts 1-5 discrete facts (decisions /
  recommendations / facts / action items). Each fact saved as its own
  child memory tagged `extracted-fact` with `metadata.derived_from =
  parent_id`. Cost ~$0.002 per extraction. Gated on `ENABLE_FACT_EXTRACTION`
  env var or `metadata.extract_facts: true` per-call.
- **v0.3.1 — webhook subscriptions.** Register HTTPS endpoints to receive
  HMAC-SHA256-signed POSTs on `memory.saved`, `memory.updated`,
  `memory.deleted`. Auto-disable after 20 consecutive failures.
  30-day delivery log. Manage via `/api/webhooks` (GET/POST) and
  `/api/webhooks/:id` (GET/PUT/DELETE).
- **Backend-side secret redaction.** Defense in depth: the same 13-pattern
  redactor that runs in the CLI also runs at hosted save time. Stamps
  `metadata.redacted_count` + `metadata.redacted_kinds` when matches
  fire. Means a leaky SDK can't bypass redaction.
- **`/api/health`.** Public liveness probe. Returns `{ ok: true }`.
  Used by the Chrome extension's "connected" indicator.
- **`/api/auth/tokens`.** Site-wide UI for issuing + revoking bearer
  tokens (`mnu_...`) for the extension or SDKs. New page at
  `/account-settings/tokens`.
- **`/api/threads`.** Real Postgres aggregation (was stubbed empty).
  Groups memories by `metadata.parent_ref`; single-memory threads still
  appear in the browse view.

### Added (Chrome extension v0.2.0)
- **Local / Hosted toggle** in the popup. Single segmented control —
  same UI either way; just routes to `127.0.0.1:3122` vs `mnueron.com`.
- **Sign-in deep link.** Popup "Sign in to mnueron.com" button opens
  `/account-settings/tokens` for one-click token issue.
- **Stop / Resume backfill.** Pausable mid-run; resume picks up where
  it left off (idempotent on chat UUID).
- **Recall + inject.** Popup search box → top-5 matches → "Insert" drops
  the memory into the active page's prompt input. Works on claude.ai
  and chatgpt.com.
- **Ambient context** (opt-in). As you type, mnueron searches your store
  and shows a small floating pill above the prompt input when relevant
  past memories exist. Click to expand + insert. Scoped by namespace
  via the new options dropdown.
- **Multi-select "Copy as prompt".** Recall results have checkboxes;
  click "Copy N as prompt" to get a Cowork-style markdown block in
  clipboard for pasting into any AI chat.
- **Migrate local → hosted.** Options-page button that bulk-uploads
  every local memory to your hosted account. Idempotent on `source_ref`.
- **Robust extraction.** Both Claude and ChatGPT scrapers now bail on
  one-sided results (user-only or assistant-only) instead of silently
  truncating. New `articleWalk` fallback for ChatGPT. API backfill
  extractor handles `text` / `content[]` / `thinking` / `tool_use` /
  `tool_result` / `parts[]` shapes and inserts a visible placeholder
  instead of skipping when nothing extracts.

### Added (SDKs)
- **Python SDK 0.3.1 (`pip install mnueron`).** Rewritten to target the
  production `https://www.mnueron.com/api/*` surface (was `/v1/*` on
  `api.mnueron.dev`). New methods: `update`, `bulk_search`, webhook CRUD
  (`list_webhooks`, `create_webhook`, `get_webhook`, `update_webhook`,
  `delete_webhook`), `health`. `search` and `list` accept the v0.2.1 date
  filters (`created_after`, `created_before`, `updated_after`,
  `updated_before`) and the v0.2.4 `metadata_filter` dict. Ships
  `verify_webhook_signature(secret, body, header)` helper for HMAC-SHA256
  constant-time check.
- **.NET / C# SDK 0.3 (`MnueronClient.cs`, single-file).** Same surface as
  Python. Targets `https://www.mnueron.com`. New: `UpdateAsync`,
  `BulkSearchAsync`, `HealthAsync`, webhook CRUD,
  `VerifyWebhookSignature()`. `IAsyncDisposable` support. Env var
  pickup via `MNUERON_API_KEY` / `MNUERON_API_URL`.
- Both SDK READMEs rewritten with end-to-end examples for webhooks,
  bulk search, and date / metadata filters.

### Added (mnueron.com web app)
- **Production deploy.** mnueron.com is live, SSL, served from Vercel
  with Supabase Postgres backend. Express server retired in favor of
  Next.js API routes.
- **Auth.** Signup, login, logout via httpOnly session cookies.
  `/account-settings/tokens` for API token CRUD.
- **Memory dashboard.** Threads + memories list, search, namespace
  filter, hash-based deep-linking (`/dashboard#memory=<id>`).
- **Context Builder.** New `/dashboard/context-builder` page. Multi-
  select memories, render as Cowork-friendly or ChatGPT-friendly markdown
  block, copy to clipboard.
- **Docs CMS.** Supabase-backed sections + pages with split-pane markdown
  editor at `/admin/docs`. Site renders dynamically at
  `/docs/[section]/[slug]`. Postgres full-text search across all
  published content.
- **Admin landing.** `/admin` gateway page with feature cards for
  every admin tool. Settings gear icon in the top nav, visible only to
  site admins.
- **Marketing site rebrand.** New N-in-orbit logo across hero, footer,
  favicons, and Chrome extension icons. Real content on /pricing,
  /about, /contact. Added /docs, /privacy, /terms.

### Fixed
- Login redirect spinner: uses `window.location.assign` after auth POST
  to avoid a Set-Cookie / middleware race condition.
- `/api/threads` stub returning `[]` made the dashboard appear empty
  even with memories saved — now does a real Postgres aggregate.
- **Hosted auth accepts `Authorization: Bearer` header** in addition to
  the session cookie. Previously every SDK / curl / extension hosted-mode
  call returned 401 because `requireAuth()` only read the cookie. Now
  tokens issued at `/account-settings/tokens` work in both channels.
- **RLS disabled on auth tables** (`users`, `orgs`, `org_members`,
  `api_tokens`, `audit_log`) via migration `007_fix_rls_auth_tables.sql`.
  These tables are never exposed directly to clients — the app's session
  / token layer is the gate. RLS being on caused the deployed server to
  see zero rows on `SELECT password_hash`, surfacing as 401 "invalid
  email or password" with a guaranteed-correct password. Tenant-data
  tables (`memories`, `namespaces`, `doc_pages`, `webhook