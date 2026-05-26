# Recall & Consolidation

How to **recall** memories from mnueron inside Claude, and how to set up a
**nightly consolidation** pass so the store stays sharp instead of bloating
with near-duplicates.

If you only read one thing: see [Gotcha: auto-memory vs mnueron](#gotcha-claudes-auto-memory-is-not-the-mnueron-store)
first. It's the single most common confusion.

---

## Recall in Claude

Once mnueron is installed and wired into Claude (see `INSTALL.md`), Claude
has these MCP tools available at the `mcp__mnueron__*` prefix:

| Tool             | Use for                                                              |
|------------------|----------------------------------------------------------------------|
| `memory_recall`  | Hybrid keyword + semantic search. Returns previews (~800 chars) + ids. |
| `memory_get`     | Fetch the full text of one memory by id.                              |
| `memory_list`    | Browse recent memories in a namespace. Previews only.                 |
| `memory_namespaces` | List every namespace and its current count.                        |
| `memory_get_thread` | Pull a whole imported chat thread by its anchor id.                |
| `memory_save`    | Write a new memory.                                                   |
| `memory_delete`  | Remove a memory by id.                                                |

You usually don't call these directly — you ask Claude in natural language
and it picks the right tool. The examples below show the prompts that
reliably trigger each one.

### Example 1 — "What did we decide about X?"

> Recall from mnueron what we decided about Stripe webhook handling.

Claude calls `memory_recall({ query: "stripe webhook handling decision" })`,
gets previews, then `memory_get(id)` on the top hits and answers from the
full text.

### Example 2 — Scope to one namespace

> Search the `elevizio` namespace for anything about Chrome Web Store
> submission status.

Claude calls `memory_recall({ query: "chrome web store submission status",
namespace: "elevizio", k: 10 })`. Scoping helps when one namespace dominates
the store (e.g. imported chat chunks).

### Example 3 — Browse a namespace without searching

> What's been added to the `mnueron-plan` namespace recently?

Claude calls `memory_list({ namespace: "mnueron-plan", limit: 20 })` and
summarizes the previews in order of recency.

### Example 4 — Pull a whole thread back

> Recall the full Cowork thread where we worked on the Vercel deploy.

Claude recalls to find an entry from that thread, reads `source_ref`
(e.g. `cowork:641d54bc-…`), then calls `memory_get_thread` on it to get
the entire chain.

### Example 5 — Tag-filtered recall

> Find anything I've saved with the tag `architecture` about embeddings.

Claude calls `memory_recall({ query: "embeddings", tags: ["architecture"] })`.

### Tips

- **Say "from mnueron" explicitly** when you want recall. Otherwise Claude
  may answer from its own context window or from auto-memory (see gotcha
  below).
- **Previews are truncated at ~800 chars by design.** If the answer needs
  the full text, ask Claude to "fetch the full memory" — that triggers
  `memory_get`.
- **Recall is hybrid (FTS5 + sqlite-vec, RRF-fused).** Natural-language
  queries work — you don't need to match exact keywords.

---

## Nightly consolidation

The mnueron store grows fast, especially if you're importing chats from
Cowork, ChatGPT, or the Chrome extension. Without periodic pruning,
recall quality drifts: the same fact appears six times, time-bound notes
(“fix this by Friday”) stay around long after Friday, and procedural
chat chunks (“paste the output here”) crowd out durable knowledge.

The fix is a scheduled task that does a reflective pass each night.

### What it does each run

1. Lists every namespace and notes which are active.
2. For each namespace, runs broad recall queries to find duplicate
   clusters.
3. Reads the full text of candidates with `memory_get`.
4. Merges complementary fragments into one entry, deletes superseded
   status updates, rewrites relative time refs ("by Friday") to absolute
   dates, drops pure-procedural chat chunks.
5. Writes a summary memory into the `mnueron` namespace tagged
   `consolidation-log` and posts the same summary as a notification.

It explicitly **does not** touch:

- The `preferences` namespace
- Anything tagged `decision` or `architecture`
- Plan/status documents in `mnueron` or `mnueron-plan`

Safety cap: max 50 deletes per run. If the task would exceed that, it
bails and reports instead.

### Setup (Claude Desktop, via Cowork)

Cowork ships with a scheduled-tasks system. In a chat, ask:

> Set up a nightly mnueron consolidation pass at 3am that uses
> `mcp__mnueron__*` tools to merge duplicates, fix stale time
> references, and drop low-value chat chunks across all namespaces.
> Cap deletes at 50 per run. Hard-protect `preferences`,
> `mnueron-plan`, and anything tagged `decision` or `architecture`.
> Log a summary into the `mnueron` namespace tagged
> `consolidation-log`.

Cowork creates a task file at
`%USERPROFILE%\Documents\Claude\Scheduled\<task-id>\SKILL.md` containing
a self-contained prompt — each run starts fresh, no carryover.

### Tuning the cadence

In the same chat:

- **Less frequent:** "Switch the consolidation task to weekly,
  Sunday 3am." (cron `0 3 * * 0`)
- **More aggressive cap:** "Raise the per-run delete cap to 200."
- **Narrower scope:** "Only run consolidation against the `elevizio`
  namespace."

The cron expression is interpreted in **local time**, not UTC.

### Pre-approving tool permissions

The task will call `mcp__mnueron__memory_save`, `memory_delete`,
`memory_get`, etc. The first run pauses on permission prompts. To avoid
this — especially since the task runs at 3am while you're asleep — click
**Run now** once from the Scheduled sidebar. Approvals granted during
that run are stored on the task and auto-applied to future runs.

### What if my app is closed at 3am?

The task runs on next launch. Cowork won't silently skip it.

### Editing the prompt later

The full prompt lives in the task's `SKILL.md`. Open it, edit, save —
the next run picks up the change. Or just ask in chat:
"Update the consolidation task to also retire entries older than
six months in the `web-claude` namespace."

---

## Gotcha: Claude's auto-memory is not the mnueron store

Claude Desktop and Claude Code both have a built-in **auto-memory**
feature — Claude writes markdown topic files into a memory directory
and maintains a `MEMORY.md` index. There's a separate `consolidate-memory`
skill from Anthropic that does a reflective pass over those files.

That is **not** the same system as mnueron.

| | Claude auto-memory | mnueron |
|---|---|---|
| Storage | Markdown files + `MEMORY.md` index | SQLite (`~/.mnueron/memories.db`) |
| Surface | Read implicitly by Claude each turn | MCP tools: `memory_recall`, `memory_get`, etc. |
| Scope | Per-Claude-app | Cross-tool: Claude Desktop, Code, Cursor, Windsurf, Cline, your apps |
| Search | None — Claude scans files | Hybrid FTS5 + sqlite-vec with RRF fusion |
| Consolidation | Anthropic's `consolidate-memory` skill | Your nightly scheduled task (above) |
| Namespaces | None | Yes: `mnueron`, `elevizio`, `default`, etc. |

**Why it matters:** if you ask Claude to "consolidate my memory" without
saying which one, you might get Anthropic's skill, which won't touch the
mnueron SQLite store at all. Conversely, asking Claude to "recall from
memory" without saying "from mnueron" may pull from the auto-memory
markdown files instead of doing an MCP recall.

**Rule of thumb:** say "mnueron" out loud (or in your prompt) whenever
you mean the SQLite-backed cross-tool store. Say "auto-memory" or
"Claude's memory files" when you mean Anthropic's per-app markdown
system.

---

## Related docs

- `INSTALL.md` — Wiring mnueron into Claude Desktop, Claude Code, Cursor,
  Windsurf, Cline.
- `RECALL_TEST_PLAN.md` — End-to-end recall verification across CLI,
  hosted API, and every IDE surface.
- `ARCHITECTURE.md` — Storage, search, and chunking internals.
- `BUILDING_APPS.md` — Using mnueron from your own apps via SDK.
