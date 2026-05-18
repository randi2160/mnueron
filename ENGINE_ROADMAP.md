# mnueron Engine Roadmap

Status: **draft, not committed to public-facing roadmap yet**
Author: working doc, May 17, 2026
Audience: internal — randy + future contributors

---

## Why this doc exists

We just shipped a competitive-comparison section on the landing page. The
honest finding: mnueron is winning on **integration breadth + privacy +
developer ergonomics**, but trailing the "reasoning" engines (Mem0, Letta,
Zep) on four specific capabilities:

1. **Knowledge graph** — entity + relationship extraction into a navigable graph.
2. **Self-revising memory** — background loop where the LLM consolidates / rewrites its own memories.
3. **Temporal reasoning** — time-aware relationships (facts have validity windows).
4. **Cross-session entity resolution** — "John in memory #4 is the same John as memory #200."

This doc answers, for each capability:

- Is it achievable?
- What open-source tooling exists?
- What's the cheapest sensible path for us?
- How long? What does v1 look like?
- What does this break, and what does it unlock?

---

## TL;DR — the recommended sequence

| Phase | Capability | Effort | Unlocks |
|---|---|---|---|
| **P1** | Entity extraction (no graph yet) | 1 week | Foundation for everything below. Plus immediately useful for search ranking. |
| **P2** | Cross-session entity resolution | 1-2 weeks | "Show me all memories about John" works correctly. |
| **P3** | Knowledge graph (relationships) | 2-3 weeks | "What did we decide about X and who decided it?" |
| **P4** | Temporal reasoning (bi-temporal) | 1-2 weeks | "What did John think about X in Q1 vs now?" |
| **P5** | Self-revising memory loop | 3-4 weeks | Reduces duplicate-memory noise over time. |

**Total honest estimate:** ~10-12 weeks of dedicated work for the whole engine
upgrade. P1 alone (entity extraction) is a 1-week win that immediately improves
search and seeds everything that comes after.

All four are achievable. Every one has at least one viable open-source tool
that does most of the heavy lifting.

---

## Phase 1 — Entity extraction

### What it does

For every saved memory, extract a list of entities mentioned: people,
companies, projects, technologies, decisions. Store them as structured
metadata on the memory row.

### What competitors do here

- **Mem0** — uses GPT-4 to extract entities and relations in a single LLM call.
- **Zep / Graphiti** — extracts both entities and edges in one pass with an LLM.

### Open-source options for us

| Tool | License | Self-hostable? | Notes |
|---|---|---|---|
| **GLiNER** | Apache 2.0 | Yes, ~200MB | Zero-shot NER, runs locally on CPU. Excellent for our local-first story. |
| **spaCy** | MIT | Yes | Pre-trained NER models (`en_core_web_lg`). Mature, fast, no LLM cost. |
| **REBEL** | MIT | Yes, ~2GB | Joint entity + relation extraction (gives us both at once). |
| **LLM-based** (Haiku) | N/A | No — runs on Anthropic | Cheapest path: one Haiku call per memory. ~$0.001/save. We already do similar with auto-synopsis. |

### Recommended path

**Use Haiku 4.5 with a structured-output prompt.** Reasons:

1. We already do this for auto-synopsis and fact extraction — same pattern, same cost envelope.
2. Output quality is best in class — better than spaCy for "extract decisions and recommendations" which is a domain GLiNER doesn't cover.
3. BYOK already handles local-key users.

For users without an API key in local mode, fall back to **spaCy** with
`en_core_web_lg`. That gives the local-first story a working default even
without paid LLM calls.

### Data model

Add to `metadata`:

```ts
metadata: {
  entities: [
    { name: "Stripe", type: "company", canonical_id: "ent_a1b2c3" },
    { name: "Q3 roadmap", type: "project", canonical_id: "ent_x9y8z7" },
  ]
}
```

`canonical_id` is null at first — Phase 2 fills it in.

### Effort

- 1 day: prompt + JSON-schema response parsing
- 2 days: wire into save endpoint (gated like auto-synopsis)
- 1 day: spaCy fallback path
- 1 day: tests + docs
- **Total: ~1 week**

---

## Phase 2 — Cross-session entity resolution

### What it does

"John from memory #4" and "John from memory #200" get the same `canonical_id`.
This is the foundation for "show me everything about John."

### What competitors do here

- **Mem0** — embedding similarity + LLM tiebreak.
- **Zep** — embedding similarity + cosine threshold, LLM disambiguation for borderline cases.

### Open-source options

| Tool | License | Notes |
|---|---|---|
| **dedupe** (Python) | MIT | Mature record-linkage library. Active-learning-friendly. |
| **splink** | MIT | Larger-scale entity resolution. Probably overkill for us. |
| **Embedding similarity** (we already have it) | — | Use existing pgvector / sqlite-vec setup. Compute embedding for each entity name + context, cluster with cosine threshold. |
| **LLM tiebreak** (Haiku) | — | For borderline matches (sim > 0.85 but < 0.95), ask Haiku "are these the same entity?" |

### Recommended path

**Embedding-based clustering + LLM tiebreak.** We already have pgvector
infra, so this is incremental. Pseudocode:

```ts
async function resolveEntity(name: string, context: string, userId: string) {
  const emb = await embed(`${name} :: ${context}`);
  const candidates = await vectorSearch(emb, userId, "entities", topK=5);
  const high = candidates.filter(c => c.score > 0.95);
  if (high.length === 1) return high[0].canonical_id;
  if (high.length === 0) return createNewCanonical(name);
  // ambiguous — ask Haiku
  return await haikuDisambiguate(name, context, high);
}
```

### Data model

Add an `entities` table (or JSONB column on memories):

```sql
CREATE TABLE entities (
  canonical_id   text PRIMARY KEY,
  user_id        uuid,
  display_name   text,
  entity_type    text,
  aliases        text[],
  embedding      vector(384),
  first_seen_at  timestamptz,
  last_seen_at   timestamptz
);
```

### Effort

- 2 days: schema + migration
- 3 days: resolution algorithm + LLM tiebreak
- 2 days: backfill existing memories
- 2 days: tests
- **Total: ~1.5 weeks**

### What this unlocks

- "Show me all memories about [entity]"
- Entity-anchored recall: search by entity, not just keyword
- Foundation for Phase 3 graph edges

---

## Phase 3 — Knowledge graph

### What it does

Given a memory like *"After the Q3 review, John recommended we deprecate the
v1 API in favor of v2"*, extract:

- Nodes: `John`, `Q3 review`, `v1 API`, `v2 API`
- Edges:
  - `John -[recommended]-> deprecate v1 API`
  - `v1 API -[deprecated_for]-> v2 API`
  - `recommendation -[came_from]-> Q3 review`

Then let users query the graph: "What did John recommend in Q3?"

### What competitors do here

- **Mem0 Graph** — uses GPT to extract triples, stores them in Neo4j.
- **Zep / Graphiti** — joint entity + edge extraction, bi-temporal native, custom edge ontology per use case.

### Open-source options

| Tool | License | Notes |
|---|---|---|
| **Graphiti** (Zep's engine) | **MIT** | Zep open-sourced their KG engine. We could literally use it. Designed for agent memory. |
| **Apache AGE** | Apache 2.0 | Postgres extension that turns our existing DB into a graph DB. Cypher queries. Zero new infrastructure. |
| **Neo4j Community** | GPL-3.0 | Industry standard but requires new infrastructure. License is GPL, which is fine for self-hosted but messy for hosted SaaS. |
| **NetworkX** | BSD | In-memory graphs. Fine for local-first single-user use. |
| **LangChain `LLMGraphTransformer`** | MIT | Reusable chain for entity + edge extraction. Just the extraction step, not storage. |
| **REBEL** | MIT | Joint extraction model, runs locally. ~2GB. |

### Recommended path

**Apache AGE on the hosted Postgres + NetworkX for local SQLite mode.**

Reasoning:
1. AGE means zero new infrastructure for hosted users — same DB.
2. Cypher is the de facto graph query language; AGE supports it.
3. NetworkX for local keeps everything in-process, no extra installs.
4. For extraction, we'd reuse Phase 1 entity extraction + a second Haiku
   call for "given these entities, extract the relationships." Or REBEL
   if running locally without an API key.

**Don't pull in full Graphiti** — it's tightly coupled to Neo4j and brings
opinions we don't need. But we can borrow its prompts and ontology design.

### Data model

```sql
-- After loading apache_age extension:
SELECT * FROM ag_catalog.create_graph('mnueron_kg');

-- Then in Cypher:
CREATE (john:Person {canonical_id: 'ent_a1', name: 'John'})
CREATE (q3:Event {canonical_id: 'ent_q3', name: 'Q3 review'})
CREATE (john)-[:RECOMMENDED {memory_id: 'mem_123', confidence: 0.9}]->(v1:System {name: 'v1 API'})
```

Each edge carries `memory_id` (provenance) and `confidence` (extraction
quality).

### Effort

- 2 days: install AGE on Supabase (verify hosted compatibility), schema
- 3 days: relationship extraction prompts + integration with Phase 1 pipeline
- 3 days: Cypher query layer + SDK methods
- 2 days: dashboard UI for graph browse (simple force-directed visual)
- 3 days: tests + docs
- **Total: ~2-3 weeks**

### Risk

Supabase doesn't natively support AGE — we'd need to verify it can be loaded.
If not, fall back to a regular relational `edges` table with `from_canonical_id`,
`to_canonical_id`, `relation`, `properties` columns. Less queryable but works.

### What this unlocks

- "Who decided X and when?"
- "What's connected to [entity]?"
- Visual graph view in the dashboard
- Significantly stronger answers when recall is combined with graph traversal

---

## Phase 4 — Temporal reasoning

### What it does

Facts have **validity windows**. "John worked at Stripe (March 2022 – April 2025)."
Later memories can update facts: "John joined Anthropic in May 2025."

Query "where does John work?" gets the correct answer based on the asked-about
time period.

### What competitors do here

- **Zep / Graphiti** — bi-temporal model: `valid_from` / `valid_to` (when the
  fact was true) + `recorded_at` (when we learned about it). This is
  Graphiti's signature feature.
- **Mem0** — limited; mostly relies on timestamps + LLM reasoning at query time.

### Open-source options

This is mostly an extension of Phase 3, not a separate library. The pattern
is well-documented in the Graphiti paper. Tools that help:

| Tool | License | Notes |
|---|---|---|
| **Apache AGE** edge properties | Apache 2.0 | We can store `valid_from`, `valid_to`, `recorded_at` as edge properties. |
| **duckling** | Apache 2.0 | Facebook's natural-language time parser. Turns "last Tuesday" into a date range. |
| **dateparser** (Python) | BSD | Lightweight alternative to duckling. |

### Recommended path

Build on top of Phase 3:

1. When extracting relationships, ask the LLM to also extract:
   - When did this fact become true? (`valid_from`)
   - When did it stop being true? (`valid_to`, often null)
2. Use duckling or dateparser to resolve relative dates ("last month", "in Q3").
3. At query time, accept a `as_of` timestamp parameter.

### Effort

- 3 days: extend extraction prompts to pull validity windows
- 3 days: duckling integration
- 3 days: as-of query layer (filter graph edges by valid window)
- 2 days: tests
- **Total: ~1.5-2 weeks**

### What this unlocks

- "What did I think about X in January?"
- Automatic resolution of contradictory facts (newer fact wins)
- Stronger sense of narrative over time

---

## Phase 5 — Self-revising memory loop

### What it does

A background process that:

1. Periodically scans memories
2. Identifies duplicates, contradictions, or stale facts
3. Proposes merges or edits
4. Applies them with full audit trail

This is Letta's signature feature ("the LLM rewrites its own memory").

### What competitors do here

- **Letta** — the LLM has tools to read its own memory and call `core_memory_replace` or `archival_memory_insert`. The agent itself maintains its memory.
- **Mem0** — runs deduplication and contradiction-detection passes on writes.

### Open-source options

| Tool | License | Notes |
|---|---|---|
| **Letta** itself | Apache 2.0 | We could read their consolidation pipeline. Don't need their full stack. |
| **APScheduler / BullMQ** | MIT | Background job runners — for the periodic scan. |
| **LangGraph** | MIT | Stateful agent runtime — we could model the consolidation loop as a graph. |

This is more architectural pattern than tool. The risk isn't "can we build it"
— it's "can we trust it not to destroy good memories."

### Recommended path

**Phase it in carefully:**

**5a — Detection only (no writes).** Background job that flags
likely-duplicate memories. Surfaces them in the dashboard. User clicks
"merge" manually. No LLM autonomy.

**5b — LLM-proposed merges.** LLM proposes merge operations. Stored in a
review queue. User approves in dashboard.

**5c — Auto-merge for high-confidence cases.** Only after we've measured
quality of 5b for a few months.

### Effort

- 5a: ~1 week
- 5b: ~1.5 weeks
- 5c: ~1 week (mostly tuning thresholds)
- **Total: ~3-4 weeks but spread over months for safety**

### Risk

This is the riskiest phase. A bad consolidation pass could destroy a user's
memory. Hard requirement: **every edit is reversible** (we already have
`metadata.history`). Every merge keeps the originals as soft-deleted records
for 30 days.

### What this unlocks

- Storage stays clean as it grows
- "I told you this three times in different ways" gets consolidated
- Reduces recall noise

---

## What we'd keep / what we'd retire

### Keep

- **Auto-synopsis on save** — still useful even with KG. Synopsis is the
  human-readable summary; entities/edges are the structured layer.
- **Fact extraction** — already producing the seed data for Phase 1.
- **Hybrid search (FTS + vector)** — still our retrieval backbone.
  Graph augments search, doesn't replace it.

### Retire / refactor

- Nothing yet. KG layer is additive.

---

## Quick sanity check: which of these does Anthropic / OpenAI ship?

- **Anthropic Claude memory (projects, files)** — no KG, no temporal reasoning. Just context windows + file uploads.
- **OpenAI Memory** — opaque; some entity awareness in ChatGPT; no public APIs for it.

So even the big labs aren't in this space publicly. The startups (Mem0,
Letta, Zep) are the leaders here. Catching them is a real competitive moat —
not a "we have to do this just to keep up" play.

---

## Recommended ship order (revised)

If we have to pick **the single highest-leverage thing**, it's **Phase 1 + 2
combined** (entity extraction + resolution). One month of work. Unlocks:

- "Show me everything about [project / person / decision]"
- Improved search ranking (entity-aware)
- Foundation for everything else
- Honest claim of "we have entities" on the comparison matrix

Phase 3 (graph) is the marquee feature for marketing — but Phase 1+2 is
where the real product improvement happens.

---

## Decisions needed from randy

1. **Pursue this roadmap?** Or focus on something else (sample apps, Elevizio
   integration, Chrome Web Store submission)?
2. **Hosted-only or local-too?** Phase 3 (KG) is much harder to deliver in
   SQLite. Acceptable to make it a hosted-tier feature?
3. **Timeline?** All-in 10-12 weeks. Or phase 1+2 only for a 4-week sprint
   that closes the biggest credibility gap?
4. **BYOK posture?** Phase 1 extraction adds ~$0.001 per save in Haiku cost.
   Do we keep it gated behind opt-in like current auto-synopsis, or default-on
   for paid tier?

---

## Open-source survey (one-stop reference)

| Need | Tool | License | Local-friendly? |
|---|---|---|---|
| Entity extraction (NER) | GLiNER | Apache 2.0 | Yes |
| Entity extraction (NER) | spaCy | MIT | Yes |
| Entity + relation joint | REBEL | MIT | Yes (2GB) |
| Entity + relation via LLM | Haiku 4.5 | Anthropic API | No |
| Entity resolution | dedupe | MIT | Yes |
| Entity resolution | splink | MIT | Yes |
| Graph DB on Postgres | Apache AGE | Apache 2.0 | Yes |
| Graph DB | Neo4j Community | GPL-3.0 | Yes |
| In-memory graph | NetworkX | BSD | Yes |
| KG extraction chain | LangChain LLMGraphTransformer | MIT | Yes |
| KG agent memory | Graphiti | MIT | Yes (tightly Neo4j-coupled) |
| Bi-temporal model | (pattern, not a tool) | — | — |
| Time parsing | duckling | Apache 2.0 | Yes |
| Time parsing | dateparser | BSD | Yes |
| Background jobs | BullMQ / APScheduler | MIT | Yes |
| Agent state machine | LangGraph | MIT | Yes |
| Self-revising agent runtime | Letta | Apache 2.0 | Yes |
