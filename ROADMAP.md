# mnueron Public Roadmap

_Last updated: May 25, 2026._

This is the contributor-facing roadmap for [mnueron](https://github.com/randi2160/mnueron).
It exists to answer two questions:

1. **Where is the project heading?** — so you can decide whether your time
   contributing here is well spent.
2. **What can I work on right now?** — concrete items with a `good first issue`
   or `help wanted` label, sized so you can ship one in a weekend.

If you're looking for the internal product strategy doc (pricing tiers,
revenue model, dashboard mockups), that lives in [`PLAN.md`](PLAN.md). This
file is the public subset — the parts that make sense for outside
contributors to pick up.

For setup and engineering conventions, see [`DEVELOPMENT.md`](DEVELOPMENT.md)
and [`CONTRIBUTING.md`](CONTRIBUTING.md).

---

## What mnueron is

A local-first, MCP-native, multi-tool persistent memory layer for AI tools.

- **Local SQLite** at `~/.mnueron/memories.db` — no account, no upload, no
  telemetry. Free forever.
- **Auto-wires** into Claude Desktop, Claude Code, Cursor, Windsurf, Cline,
  Continue, Zed, Aider, Goose, OpenCode, and Codex via MCP.
- **Captures from the web** via a Chrome extension for claude.ai and
  chatgpt.com.
- **Optional hosted** mode at [mnueron.com](https://mnueron.com) for
  cross-machine sync.

If you're new, start with the [npm install one-liner](./README.md#install-in-one-command),
then come back here.

---

## Current release status

**Stable:** `mnueron@0.5.x` on [npm](https://www.npmjs.com/package/mnueron).
**SDKs shipped:** Python (PyPI), .NET (NuGet), TypeScript (npm).
**Editor extensions shipped:** VS Code (Marketplace) and Chrome
([Web Store, published 2026-05-20](https://chromewebstore.google.com/detail/fnjmcohdjmanpjjdjdkcgfkmgkjghjjp)).
Edge and Firefox use the same ZIP — submissions to those stores pending.

### What's verified working end-to-end

- Local MCP server with **ten tools** — six memory (`memory_save`,
  `memory_recall`, `memory_list`, `memory_get`, `memory_delete`,
  `memory_get_thread`) plus four procedural (`procedural_match`,
  `procedural_list`, `procedural_get`, `procedural_record_outcome`).
- **Procedural memory** — runbooks stored as memories with trigger
  phrases; `memory_recall` auto-surfaces matching runbooks alongside
  memory previews. AI agents can apply known fixes without re-deriving
  them. Hosted mode for now; local SQLite bridging is a follow-up.
- Hybrid keyword + semantic search via FTS5 + sqlite-vec, fused with
  reciprocal-rank.
- 10-IDE setup wizard (`mnueron setup`).
- Auto-chunking at save time for long captures.
- Server-side secret redaction (13 patterns).
- Chrome extension capture from claude.ai + chatgpt.com, history backfill,
  ambient-context pill.
- Hosted backend on Vercel + Supabase: signup, sessions, memory CRUD,
  webhooks, fact extraction, entity extraction, cross-session entity
  resolution.
- **Knowledge graph (P3)** — `relations` table (migration 029) + the
  relation extractor library + `/api/relations` endpoint + `/dashboard/graph`
  visualization. Lets recall answer "who recommended Stripe" using the
  edges built from your saved memories.
- **Bi-temporal reasoning (P4)** — `valid_from` / `valid_to` columns on
  every relation + `?asOf=<iso>` filter on `/api/relations`. Answers
  point-in-time questions like "who was Sarah's manager in March?"
- **Project Memory** — namespace convention (`repo:<name>` / `project:<name>`
  / `team:<name>`) for repo-aware context that persists across IDEs and
  AI sessions. Cross-tool replacement for `CLAUDE.md` / `.cursor/rules` /
  Aider's repo map. See
  [`/docs/getting-started/project-memory`](https://mnueron.com/docs/getting-started/project-memory).
- **Session Continuity** — auto-backup of Claude Desktop / Cowork sessions
  every 4 hours into mnueron, so "Resume from summary" no longer loses
  context. See
  [`/docs/getting-started/session-continuity`](https://mnueron.com/docs/getting-started/session-continuity).
- Memory Consolidation Phase 5a — `mnueron consolidate detect/list/approve/reject`.

---

## Themes — where the project is heading

The roadmap groups into six themes. Each one is a long-running area we'd
welcome contributions to; specific issues underneath are tagged on GitHub.

### 1. Memory Consolidation (active focus, 2026 Q2)

Phase 5a (detect-only) shipped. Closing out the full self-revising arc:
scheduling, auto-apply with confidence floors, 30-day soft-delete
quarantine, a dashboard review queue, and webhooks for run completion.
See [`docs/runbooks/memory-consolidation.md`](docs/runbooks/memory-consolidation.md)
for the operator's manual on what's already live.

**Why it matters:** every memory store gets worse over time. Consolidation
is the feature that makes mnueron get sharper instead. It's also a real
differentiator vs Mem0, Letta, and Zep — none of them ship a reflective
pass with an audit log.

### 2. Memory engine — structured, temporal, procedural, project-aware

The shape-of-memory workstreams, in one theme because they share the
same Postgres backing and the same recall pipeline.

**Shipped:**

- P1 entity extraction (hosted + local).
- P2 cross-session entity resolution (hosted; local SQLite is the one
  remaining gap — see `engine-p2-local-sqlite` below).
- **P3 knowledge graph** — `relations` table (migration 029) + relation
  extractor + `/api/relations` + `/dashboard/graph`. Edges have
  provenance so recall can cite which memory introduced each relation.
- **P4 bi-temporal reasoning** — `valid_from` / `valid_to` on edges +
  `?asOf=<iso>` filter for point-in-time queries.
- **Procedural memory** — runbooks as searchable memories with
  trigger-phrase matching. Auto-surfaces in `memory_recall` envelope. The
  natural next step here is a **shell-hook** that detects errors in your
  terminal, matches them against saved runbooks, and offers one-tap fixes
  — that's an open design discussion, not yet built.
- **Project Memory** — `repo:<name>` namespace convention shipped. The
  CLI (`mnueron project init / show / update`), the
  `/dashboard/projects` page, and auto-recall on working-directory match
  are still ahead.

**Next:** Apache AGE backing store for richer graph queries (multi-hop
traversal, path queries) without losing the simple Postgres-relations
fallback. Will need a `provider.ts` interface change so local and hosted
both serve graph queries. Discuss before coding.

### 3. Session Continuity (just shipped, expanding)

A pattern (and supporting docs) for backing up Claude Desktop / Cowork
sessions into mnueron on a 4-hour cadence, so "Resume from summary"
becomes "recall from mnueron — full thread is still here." The pattern +
docs page shipped 2026-05-25; the bulletproof Path-3 version (bake the
watcher into the MCP server so import happens continuously, plus an
OS-level cron for closed-app coverage) is ~2-3 days of work tracked as
`engine-session-continuity-v2`.

### 4. Editor and IDE coverage

Ten IDEs today. Active areas: a richer VS Code extension (sidebar memory
browser is in), an Edge / Firefox Chrome-extension port, and a JetBrains
plugin that wraps the MCP server.

### 5. Web chat capture breadth

Claude and ChatGPT today. Open opportunity: Gemini, Perplexity, Mistral
Le Chat, Copilot. Each is a self-healing scraper pattern documented in
`DEVELOPMENT.md §7`.

### 6. SDK coverage

Python, TypeScript, C# shipped. Open: Go, Rust, Ruby, Java. Each models
after the Python SDK in `sdks/python/`.

---

## Open for contributors

Items below are tracked as GitHub issues with the labels noted. Click the
label name to see all open issues in that bucket.

### Good first issues — `good first issue`

Small, well-scoped, no architecture decisions required. A weekend each.

- **New tool detectors for `mnueron setup`** — JetBrains IDEs (IntelliJ,
  PyCharm, GoLand), Helix, neovim with `mcp.nvim`. Pattern documented in
  `DEVELOPMENT.md §6`.
- **Edge Add-ons store submission** — same ZIP as Chrome, different
  publisher account. ~30 minutes once the listing copy is approved.
- **Firefox Add-ons store submission** — same ZIP, slight `manifest.json`
  tweak for MV2 fallback if needed.
- **Translation strings for the dashboard** — the German, Spanish,
  Portuguese, and French translations are open once we externalize
  English. The externalization itself is also a good first issue.
- **README / docs fixes** — typos, broken links, install steps that don't
  work on your platform. Always welcome.

### Help wanted — `help wanted`

Bigger pieces but well-defined. ~1-2 weeks each.

- **Memory Consolidation: hosted nightly runner** — add a `scheduled_tasks`
  table + Vercel cron worker that invokes the consolidator on a schedule.
  See `docs/runbooks/memory-consolidation.md` for the full operator spec
  including the data model.
- **Memory Consolidation: 30-day soft-delete quarantine** — `consolidate
  restore <id>` command, `consolidation-quarantine` namespace, sweeper
  job that purges after the window.
- **Detection rule: stale procedural breadcrumbs** — add a detector for
  short assistant chunks like "Now insert X" that aren't durable memory
  on their own. Surfaces in the pattern report so users can archive the
  full transcript instead.
- **Detection rule: scheduled-task prompt filter** — filter chunks that
  begin with `<scheduled-task name=...>` at import time so they don't
  become memories. Found in production after the first nightly run.
- **JetBrains plugin** — wraps the MCP server for IntelliJ / PyCharm /
  GoLand. Reference impl: the VS Code extension at `sdks/vscode/`.
- **Go SDK** — model after `sdks/python/`. The hosted API spec is in
  `docs/api/openapi.yaml`.
- **Rust SDK** — same as above. Embedded `mnueron-core` crate would also
  be welcome long-term but talk first.
- **Gemini scraper for the Chrome extension** — pattern in
  `DEVELOPMENT.md §7`. The selectors will need self-healing the same way
  the Claude one does.

### Advanced / discuss first — `discuss first`

These have real design surface. Open an issue describing your approach
before you code.

- **Knowledge graph backing store** — Apache AGE on Supabase plus a graph
  query API. Will need a `provider.ts` interface change so both local and
  hosted can serve graph queries. Coordinate with maintainers.
- **Bi-temporal edges on the graph** — `valid_from` / `valid_to` on
  edges; recall answers temporal questions ("changed jobs in March"). Builds
  on the graph item.
- **Provider interface expansions** — adding a new method to `Provider` in
  `src/store/provider.ts` cascades through local + hosted + every SDK.
  Always discuss before writing code.
- **Schema changes** — any new column or index strategy on the hosted side.
  Open an issue first; the migration ordering matters.
- **Replacing major dependencies** (better-sqlite3, Transformers.js,
  sqlite-vec). These each took weeks to tune; swapping them is a real
  conversation.

### Out of scope

Items we will not accept, even as well-written PRs:

- **Telemetry / analytics that phone home.** Breaks the local-first promise.
- **Required cloud accounts for basic use.** The free local path stays
  account-free forever.
- **Vendor lock-in.** Anything that only works with one LLM provider
  belongs as an optional plugin, not in core.

See `CONTRIBUTING.md §What's out of scope` for the full list.

---

## How to claim an item

1. Find an issue with one of the labels above on
   [github.com/randi2160/mnueron/issues](https://github.com/randi2160/mnueron/issues).
2. Comment "I'd like to take this." Maintainers respond within ~2 days.
3. Read `CONTRIBUTING.md` for the branch naming, CLA, and PR checklist.
4. Open a draft PR early — it signals you're working and saves duplicate
   effort.

If the item you want isn't filed yet but matches a theme above, open an
issue describing it and tag a maintainer. Faster than starting an
unsolicited PR.

---

## Release rhythm

We don't follow a strict cadence. Roughly:

- **Patch releases** (`0.5.1`, `0.5.2`) — bug fixes, ship within days.
- **Minor releases** (`0.6.0`, `0.7.0`) — new features, every 4-6 weeks.
- **Major releases** (`1.0`, `2.0`) — breaking changes, every 6-12 months
  with a deprecation window.

The CHANGELOG at the repo root has the per-release notes.

---

## Telemetry and your data

mnueron has none. Local mode never phones home. Hosted mode only stores
what you explicitly save via the API or extension; the privacy policy at
[mnueron.com/privacy](https://mnueron.com/privacy) is the binding version.

---

## See also

- [`PLAN.md`](PLAN.md) — internal product roadmap (pricing, dashboard
  mockups, full strategy). Read if you want maximum context; everything
  contributor-relevant is mirrored here.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — contribution flow, CLA, PR
  checklist, code of conduct.
- [`DEVELOPMENT.md`](DEVELOPMENT.md) — engineering runbook with
  verification recipes per subsystem.
- [`docs/runbooks/memory-consolidation.md`](docs/runbooks/memory-consolidation.md)
  — operator's manual for the consolidation engine.
- [mnueron.com/features/consolidation](https://mnueron.com/features/consolidation)
  — public explainer for the Memory Consolidation feature.
