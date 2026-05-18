# Changelog

All notable changes to mnueron. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/) — version blocks list
the user-facing changes, deeper engineering rationale lives in commit
messages and PR descriptions.

## [Unreleased]

These are in the repo on `main` but not yet published to npm. The next
`npm publish` will bundle them as a minor or patch bump.

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