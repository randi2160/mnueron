# MNUERON — Product Plan & Roadmap

_Last updated: May 2026. Owner: this session._

This is the single source of truth for where mnueron stands today, what's
missing, and what to build next, in priority order. Update as we go.

---

## 1. What We Have Today — Functional Inventory

The honest version: only call something "we have it" if it has been verified
working end-to-end on a real machine. Code-in-repo-but-unwired is called out.

### 1.1 Local MCP Server — ✅ Verified working

- 6 MCP tools: `memory_save`, `memory_recall`, `memory_list`, `memory_delete`,
  `memory_namespaces`, `memory_import_chat`.
- Storage: SQLite + FTS5 at `~/.mnueron/memories.db`.
- Setup wizard detects + configures Claude Desktop, Claude Code, Cursor,
  Windsurf, Cline.
- Verified end-to-end against Claude Code: save → recall round-trip works,
  FTS5 search returns the right rows after the v0.1.0 bug fix.

### 1.2 Chrome Extension — ✅ Verified working

- Manual "Capture chat" button: captures the current claude.ai chat into
  mnueron via local POST `/api/memories`.
- "Backfill all history": pulls every past claude.ai chat via claude.ai's
  internal API; idempotent via UUID dedup in `chrome.storage.local`.
  Verified: 146 chats imported.
- Sites: claude.ai (full DOM + API), chatgpt.com (scraper untested),
  gemini.google.com (stub).
- Settings: local URL, optional hosted URL + bearer token, namespace prefix,
  auto-capture toggle.

### 1.3 Local Dashboard — ✅ Verified working

- `mnueron dashboard` starts a small HTTP server at `localhost:3122`.
- Browse memories, filter by namespace, full-text search, click to expand,
  delete with confirm, drag-drop import of Claude/OpenAI export JSON, stats
  card.
- UI is functional but visibly a "developer tool," not a polished product.
  See §3 for the upgrade plan.

### 1.4 Hosted Backend — 🟡 Code complete, not deployed

- Express server in `server/index.ts`.
- Postgres + pgvector schema with full Row-Level Security per org.
- Auth endpoints implemented this session: `POST /v1/auth/signup`,
  `/v1/auth/login`, `GET /v1/auth/me`, `GET/POST/DELETE /v1/auth/tokens`.
- Memory endpoints: save, search (hybrid BM25 + cosine), list, namespaces,
  delete, bulk-save.
- Sign-up / login HTML pages at `/signup` and `/login` served from
  `server/auth.html`.
- **NOT yet deployed against a real Postgres.** Code is ready; needs a
  Supabase project or equivalent to actually run. See §5.

### 1.5 SDKs — 🟡 Partial

- Python SDK (sync + async) — code complete in `sdks/python/`; not yet
  published to PyPI.
- C# SDK — single-file `MnueronClient.cs` in `sdks/csharp/`; not yet on NuGet.
- JS/TS SDK — does not exist.

### 1.6 Plugin System — 🟡 Code in repo, not wired

- `src/plugins/loader.ts` + `types.ts` pulled in from v0.1.9 merge.
- Example plugin at `examples/plugins/redact-pii/`.
- **NOT yet invoked by the MCP server runtime.** A user enabling a plugin
  today would see no effect. Wiring is a Phase B item.

### 1.7 Summarizer — 🟡 Code in repo, not wired

- `server/summarizer.ts` from v0.1.9 — calls Anthropic Haiku to compress
  long assistant responses to high-signal summaries (~10× storage reduction).
- **Not yet imported by `server/index.ts`.** No memory is currently being
  summarized.

### 1.8 Self-Healing Scrapers — 🟡 Library in extension, not wired

- `extension/lib/observer.js`, `self_healing.js`, `content_extractor.js` from
  v0.1.9 merge.
- Server endpoint `server/selector_repair.ts` for LLM-driven selector repair.
- **Manifest.json doesn't reference these files yet.** Our active scrapers
  are the simpler manual-capture ones we built this session.

### 1.9 Cloud Hosted Dashboard — ❌ Not built

- We have signup/login HTML pages on the API server.
- We do NOT have an authenticated multi-page web app for memory browsing,
  token management, billing, team management.
- A cloud user today would need to use the local dashboard pointed at the
  hosted API — which works but isn't a real product UX.

### 1.10 Marketing site / Pricing page — ❌ Not built

- No landing page, no pricing page, no docs site.

---

## 2. Known Gaps vs. Competitors

From the agentmemory analysis. Each is a real product hole — listed in order
of how visible it is in a side-by-side eval.

1. **Local semantic / vector search.** We do FTS5 keyword-only. agentmemory
   does hybrid BM25 + vector. This is the biggest functional gap.
2. **Confidence scoring + memory lifecycle.** Their memories decay; conflicting
   facts get downgraded. Ours are flat-equal-forever.
3. **Knowledge graph layer.** They model relationships between memories.
   Ours are flat documents with tags.
4. **Memory governance / retention policies.** They have explicit retention
   and audit. We have a basic `audit_log` table; no retention engine.
5. **Multi-agent coordination.** They handle concurrent agent writes
   explicitly. We let both rows exist.
6. **Public benchmarks.** They claim "#1 based on real-world benchmarks." We
   have none. Counter by publishing once #1 is closed.
7. **Async worker framework.** They use iii-engine; we'd bolt on a queue.
8. **LLM-curated memory** (the "Karpathy LLM Wiki" pattern). They actively
   organize; we capture raw and let search figure it out.

---

## 3. Dashboard Upgrade Plan (Premium UX)

The current dashboard works but reads as a dev tool. Premium means it feels
like Linear, Notion, or Raycast — not phpMyAdmin.

### Specific shortcomings of the current dashboard

- Chat transcripts render as one long markdown blob inside a row preview;
  hard to read.
- No User/Assistant turn-by-turn rendering.
- No syntax highlighting for code blocks inside transcripts.
- Stats are basic (3 numbers); no chart of memory growth over time.
- No grouping (146 backfilled claude.ai chats show as 146 flat rows).
- No tag management UI.
- No multi-select / bulk delete.
- No inline editing.
- No export.
- Search has no faceted filters (date range, source, tags combined).
- One theme (dark); no light option.

### Premium improvements, priority order

1. **Chat-bubble rendering for transcript memories.** When a memory's content
   has `**User:** ... **Assistant:** ...` structure, parse it and render
   each turn as a styled bubble with the role badge, timestamp if metadata
   has it, and code blocks syntax-highlighted with Prism or highlight.js.
   This alone shifts the perceived quality dramatically.
2. **Three-pane layout (Mail.app / Linear style).** Left rail: namespaces
   + saved searches. Middle pane: memory list with smart previews. Right
   pane: full memory view + metadata + actions. Resizeable panes, remembered
   in localStorage.
3. **Faceted search.** Combinable filters: date range, source (claude-extension,
   claude-code, manual, claude-backfill), tags, namespace. Show match count.
4. **Stats dashboard.** Bar chart of memories saved per day (last 30 days),
   top namespaces by size, recent-activity timeline, search activity if
   we log queries.
5. **Group-by-source view.** When viewing backfilled chats, group by date
   bucket (today, this week, last month, 2024, etc.) instead of a flat list.
6. **Inline edit + tag management.** Click pencil icon, edit content,
   add/remove tags, save.
7. **Markdown rendering** for memory content (Markdown-it or remark).
8. **Light/Dark theme toggle.**
9. **Keyboard shortcuts.** `/` focus search, `j`/`k` next/previous,
   `Enter` open, `Delete` delete with confirm, `?` show shortcuts overlay.
10. **Per-memory permalink.** `localhost:3122/m/{id}` deep-links to a memory.

### Tech for the upgraded dashboard

Two options worth considering:
- **Stay with single-file vanilla** — bigger HTML, but still no build step,
  drag-drop replaces current `dashboard/index.html`. Good for local dashboard
  staying lightweight.
- **Rebuild as React + Tailwind + shadcn/ui** in a `dashboard-web/` folder,
  Vite build. Shares the most with the future cloud dashboard.

Recommendation: build the cloud dashboard in React + Tailwind + shadcn/ui
(see §4), and *port back* the most important polish (chat bubbles, three-pane)
to the local dashboard as a v2. Local stays lightweight; cloud is the
premium one.

---

## 4. Cloud Dashboard (Login-Walled Web App)

### Why we need a separate web app

The local dashboard at `localhost:3122` has zero auth — fine for "your laptop,
your data," wrong for a hosted product. The cloud product needs sign-up,
login, multi-tenant isolation enforcement at the UI, plus all the SaaS
plumbing (billing, team, audit).

### Recommended stack

- **Framework:** Next.js (App Router).
- **Styling:** Tailwind CSS + shadcn/ui (radix + Tailwind primitives).
- **Hosting:** Vercel (free tier to start).
- **Auth UI:** custom forms POSTing to our existing `/v1/auth/*` endpoints —
  no NextAuth needed for v1.
- **Session:** httpOnly cookie set by the cloud dashboard server, holding
  an API token bound to (user, org). Cookie → backend bearer token on every
  request.
- **Charts:** Recharts for stats.
- **State:** React Query for server state, Zustand if any local state is
  needed.

### Page map

- `/` — marketing landing (hero, features, pricing, social proof, CTA)
- `/pricing` — pricing details
- `/docs` — docs (eventually own subdomain)
- `/signup` — sign-up form
- `/login` — log-in form
- `/app` — authenticated dashboard root (memories list + search)
- `/app/memory/[id]` — single memory view
- `/app/namespaces` — namespace management
- `/app/tokens` — API token management
- `/app/team` — team / invitations / roles
- `/app/billing` — Stripe-backed subscription state
- `/app/settings` — defaults, retention policy, etc.
- `/app/audit` — audit log viewer (Pro+ only)

### Build order

1. Marketing landing `/` (high-leverage; needed before any signups)
2. Sign-up + login + session cookie
3. Authenticated `/app` shell with memories list (port chat-bubble UI from §3)
4. Search + filters
5. Stats overview
6. Token management UI
7. Pricing page `/pricing`
8. Billing — Stripe subscription, webhook to update `orgs.plan`
9. Team / invitations
10. Audit log viewer
11. Settings (retention, defaults)

Estimated total: 4–6 focused sessions.

---

## 5. Cloud Setup / Deployment Runbook

### What's needed

| Component | Service | Cost at start |
| --- | --- | --- |
| Postgres + pgvector | Supabase free tier | $0 |
| API server | Railway or Fly.io | $5–10/mo |
| Web dashboard | Vercel free tier | $0 |
| Domain | Cloudflare Registrar | ~$10/yr |
| Email (verification, password reset) | Resend free tier | $0 |
| Embeddings (optional) | OpenAI API | pay-as-you-go (~$0.02 per 1M tokens) |
| Billing | Stripe | 2.9% + $0.30 per txn |

Total cold-start: roughly **$10–25/month** to keep the lights on with no
users, scaling linearly with usage.

### Concrete steps to bring up hosted backend (first time)

1. **Create Supabase project** at supabase.com. Pick the closest region.
2. **Enable pgvector**: Dashboard → Database → Extensions → search "vector",
   toggle on.
3. **Apply schema**: SQL Editor → paste `server/supabase_schema.sql` → Run.
4. **Get connection strings** from Project Settings → Database:
   - `DATABASE_URL`: pooler URI (port 6543), used for app queries.
   - `ADMIN_DATABASE_URL`: same with the service role pooler when available,
     used for auth writes that need to bypass RLS. If on a non-Supabase
     deploy, this is just the postgres superuser connection.
5. **Install deps**: `cd server && npm install`.
6. **Create `server/.env`**:
   ```
   DATABASE_URL=postgres://...
   ADMIN_DATABASE_URL=postgres://...
   OPENAI_API_KEY=sk-...   # optional, for hybrid search
   BCRYPT_ROUNDS=12
   PORT=3111
   ```
7. **Run locally first**: `npx tsx index.ts`. Test:
   ```
   curl -X POST http://localhost:3111/v1/auth/signup \
     -H 'content-type: application/json' \
     -d '{"email":"you@example.com","password":"correct-horse-battery"}'
   ```
   Should return user/org/token JSON.
8. **Push `server/` to GitHub** as its own repo (or subdir).
9. **Connect Railway/Fly** to that repo. Set the same env vars. Deploy.
10. **Point DNS**: `api.mnueron.com` → Railway/Fly URL.
11. **Verify production health**: `curl https://api.mnueron.com/health`.

### Concrete steps to bring up cloud dashboard

1. **Create `dashboard-web/` Next.js project** (don't replace local dashboard).
2. **Set env var**: `MNUERON_API_URL=https://api.mnueron.com`.
3. **Build pages per the page map above.**
4. **Deploy to Vercel**: connect GitHub, set env vars, push.
5. **Point DNS**: `app.mnueron.com` → Vercel.
6. **Set redirect**: `mnueron.com` → either the landing page in the same Next
   app, or a separate static site.

### Migration: local users → hosted

Build a CLI subcommand `mnueron migrate-to-hosted`:
1. Opens browser to `https://app.mnueron.com/signup?return-to=cli`.
2. After sign-up, dashboard prints the user's token and a "click to return
   to your terminal" button that hits a localhost callback.
3. CLI captures the token, writes it to `~/.mnueron/config.json`.
4. CLI reads every memory from local SQLite, posts in batches to
   `/v1/memories/bulk` with `upsert_by: source_ref` so re-runs are safe.
5. CLI reports counts: "1,247 memories uploaded, 0 failures."
6. CLI offers to flip the active provider to hosted by setting
   `MNUERON_API_URL` + `MNUERON_API_TOKEN` in shell config.

---

## 6. Pricing Model

### Tiers

| Tier | Price | Who | What they get |
| --- | --- | --- | --- |
| **Free Local** | $0 forever | Anyone | Full local mode: MCP server, dashboard, Chrome extension, SDKs, import/export. Self-hosting allowed but unsupported. |
| **Personal** | $9/mo or $90/yr | Individuals who want sync | Everything in Free + hosted backend, cross-machine sync, hosted dashboard, web extension auto-sync, 5K memories soft cap |
| **Pro** | $19/mo or $190/yr | Power users | Everything in Personal + unlimited memories, retention policies, audit log access, priority support, daily backups |
| **Team** | $25/user/mo, min 3 | Small teams | Everything in Pro + shared org namespaces, team invitations, role-based access, central billing |
| **Enterprise** | Custom | Companies w/ compliance needs | Everything in Team + SSO/SAML, BAA, SLA, dedicated support, optional on-prem, audit retention >90d |

### Pricing principles

- **Local is free forever, no asterisks.** That's the funnel and the trust
  builder. Never gate basic memory tools behind a paywall.
- **Hosted starts at the price of one cup of coffee** ($9/mo). Easy yes.
- **No per-memory pricing** — that creates anxiety. Soft caps + fair-use
  language.
- **Annual discount is 17% off (2 months free)** — industry standard.
- **Team tier requires minimum 3 seats** to disqualify single-user gaming.

### Pricing positioning

vs. Mem0 ($79/mo Pro), Supermemory ($25/mo): we're cheaper and you can
self-host or stay local for $0. vs. OpenAI's free built-in memory: we work
across providers and don't lock you in. vs. agentmemory free OSS: we offer
the optional hosted upgrade they don't.

---

## 7. End-to-End User Journey

### Free local user (most users start here)

1. Discover via dev blog, Reddit, GitHub, HN.
2. `npm install -g mnueron && mnueron setup`.
3. Wizard configures every installed AI tool. Restart them.
4. Memory layer is now live in Claude Code / Cursor / etc.
5. (Optional) Install Chrome extension, run backfill on claude.ai history.
6. (Optional) `mnueron dashboard` to browse.
7. Use AI tools normally for weeks. Memories accumulate.
8. Either stay free forever (fine!) or upgrade.

### Free local → Hosted upgrade

1. `mnueron migrate-to-hosted` opens browser at `app.mnueron.com/signup`.
2. User signs up (or logs in if they already have an account).
3. Token issued, captured back by CLI.
4. Local memories (deduped) uploaded to hosted.
5. Active provider flips to hosted. AI tools now read/write hosted.
6. On second machine: `mnueron setup --hosted https://api.mnueron.com --token mnu_...` — sync works.

### Direct cloud user (skips local entirely)

1. Land on `mnueron.com`. Hit sign-up.
2. Sign up at `app.mnueron.com/signup`. Token shown once.
3. From `/app`, install instructions: copy CLI command pre-filled with token.
4. Run `npm install -g mnueron && mnueron setup --hosted ...`.
5. AI tools configured for hosted.
6. Install Chrome extension, paste token in Options. Auto-sync turns on.

### Team admin

1. Sign up as a Team plan.
2. Invite colleagues via email; each receives a sign-up link bound to the org.
3. Set per-namespace permissions (e.g. shared `team-decisions` everyone reads/writes;
   private `personal-{user}` namespaces).
4. Pay via Stripe; central invoice.

---

## 8. Build Order — What Comes Next

Phases reflect both engineering risk and product value.

### Phase 1 — Polish foundation + close biggest gap (2–3 sessions)

1. **Local semantic search via Transformers.js or sentence-transformers
   bundle.** Closes the #1 gap vs agentmemory. Local, no API calls.
   **✓ shipped** — Transformers.js + sqlite-vec + RRF fusion, 158 memories indexed.
2. **MCP tool surface: previews + memory_get with paging.** ✓ shipped —
   fixes the runaway 1.4M-char response problem.
3. **Auto-chunking long captures at save time.** A 38-message claude.ai
   chat shouldn't be one 320KB memory — it should be ~5–10 atomic memories
   (per-turn or per-topic-shift). Both forward (extension + backfill) and
   retroactive (split existing oversized memories). This is the *proper*
   fix for the recall context-blowup issue. ~1 session.
4. **Premium chat-bubble dashboard rendering.** Biggest visible quality jump.
5. **Migration tool: local → hosted.** Blocks every upgrade conversation.
6. **Secret redaction at write time.** Closes the gap our own docs flag.

### Phase 2 — Cloud product (4–6 sessions)

5. **Cloud dashboard scaffold** (Next.js + Tailwind + shadcn/ui): signup,
   login, memories list, token management, settings.
6. **Marketing landing + pricing page** on the same Next.js app.
7. **Stripe billing integration** + plan-tier enforcement in the API.
8. **Email verification + password reset** via Resend.
9. **Deploy hosted backend** on Supabase + Railway.

### Phase 3 — Differentiation + scale (later)

10. **Confidence scoring + memory lifecycle.** agentmemory parity.
11. **Knowledge graph view** in the dashboard.
12. **Document ingestion** (drag .docx / .pdf / .xlsx → memory) on the dashboard.
13. **Inject-into-claude.ai** via the Chrome extension (read-side capability).
14. **Self-healing scrapers wired** (extension restructure, v0.1.9 Phase B).
15. **Summarizer wired** into POST `/v1/memories` (v0.1.9 Phase C).
16. **JS/TS SDK** published to npm.
17. **Team / invites flow** in cloud dashboard.
18. **Audit log viewer** for Pro+ tiers.
19. **JetBrains / native VS Code plugin** for IDEs without MCP.
20. **Published benchmarks** vs. agentmemory, Mem0, etc.

---

## 9. Risks to Track

- **claude.ai internal API changes** break the backfill feature. Mitigation:
  self-healing scrapers (Phase 3 #14) plus fall back to manual export import.
- **Anthropic / OpenAI add native cross-tool memory** and we become redundant.
  Mitigation: local-first + multi-provider + open-source bury this fear.
- **Pricing competition with free tools** (agentmemory free, OpenAI free
  built-in). Mitigation: hosted-only features (cross-machine sync, team,
  audit) compete on different axis than OSS.
- **Postgres + pgvector ops cost** scales with users. Mitigation: cap free
  trial, encourage local-first for solo users, monetize sync.
- **Compliance asks from enterprise** (BAA, SOC 2). Mitigation: Enterprise
  tier as the high-touch sales motion that funds these certifications.

---

## 10. Definition of Done for "v1.0 public launch"

Before announcing publicly we need at least:

- [ ] Local: all of §1.1–1.5 working (today: §1.1–1.3 verified).
- [ ] Local semantic search shipping (§8 Phase 1 #1).
- [ ] Premium dashboard (§3 priorities 1–4).
- [ ] Migration tool (§5, §8 Phase 1 #3).
- [ ] Hosted backend deployed (§5).
- [ ] Cloud dashboard scaffold (§4 build order steps 1–6).
- [ ] Marketing landing + pricing page (§4 build order step 7, §6).
- [ ] Stripe billing live (§8 Phase 2 #7).
- [ ] Email flows working (§8 Phase 2 #8).
- [ ] Documentation site at `docs.mnueron.com`.
- [ ] Published benchmark vs. one major competitor.

Everything beyond that is post-launch iteration.
