# Building apps on mnueron

mnueron is a memory layer. You bring the LLM, the UI, and the use case;
mnueron handles persistent, searchable, multi-tenant memory across
providers and sessions. This guide is for developers building real apps on
top of mnueron — meeting-notes products, research assistants, customer
support bots, custom CRMs, anything where a model needs to remember.

If you just want mnueron in your own dev tools, read README.md. If you
want to build something other people will use, this file is for you.

---

## Mental model

```
your app ──► mnueron SDK ──► HTTP API ──► Postgres + pgvector
                                  │
              (or local SQLite when MNUERON_API_URL is unset)
```

The same SDK call (`mem.save(...)`) writes to either backend depending on
env vars. Develop locally against SQLite, ship to production against
hosted Postgres, never change a line of application code. This is THE
killer feature for building on mnueron and it's the convention you'll
write the rest of your app around.

---

## Namespace conventions

Namespaces are the single most important design call you'll make. Get
them right and search just works. Get them wrong and you spend the next
six months rewriting queries.

### Rules of thumb

- **One namespace per logical "owner"** of memories. For a single-user
  app: `default` is fine. For a multi-tenant SaaS: `user-{userId}` or
  `org-{orgId}`. For a meeting-notes product where each meeting is a
  silo: `meeting-{meetingId}`.

- **Don't put the user's data in a global namespace.** This is how data
  leaks across tenants. Worst case: the model's response to user A
  recalls user B's memory.

- **Use prefixes for app-scope.** If you might run multiple apps against
  the same mnueron account in dev, prefix: `notesapp-user-123`,
  `crm-user-123`. Production should usually run on separate accounts.

- **Tag liberally inside a namespace.** Tags are cheap; namespace
  changes are expensive (memories don't migrate automatically).

### Examples

| Use case | Namespace pattern |
| --- | --- |
| Solo dev assistant | `default` |
| Meeting-notes SaaS | `meeting-{meetingId}` |
| Per-user CRM | `user-{userId}` |
| Internal team wiki | `org-{orgSlug}` |
| Mixed (per-user + per-meeting) | `user-{userId}-meeting-{meetingId}` |

---

## Multi-tenant patterns

If your app has multiple users, ALWAYS scope every save/recall by user.
The hosted backend enforces tenant isolation via Postgres Row-Level
Security at the org level — but WITHIN your org, all memories share a
data plane. The application is responsible for not mixing users.

### The wrong way

```python
# ❌ All users dump into one namespace. Search hits across users.
mem.save(content, namespace="default")
context = mem.search(query)  # could return any user's memory
```

### The right way

```python
# ✅ Per-user namespace; queries are scoped automatically.
mem.save(content, namespace=f"user-{current_user.id}")
context = mem.search(query, namespace=f"user-{current_user.id}", k=5)
```

### A pattern you'll find yourself wanting

For apps that operate across users (e.g., admin search, dataset analysis,
RAG over the whole corpus), keep a SECOND namespace per user with
**anonymized** content and use that for global queries. Never index
real per-user content globally.

```python
mem.save(content, namespace=f"user-{user_id}")             # private
mem.save(anonymize(content), namespace="global-anonymized") # global
```

---

## Recall patterns

Saving is the easy half. Recall is where most apps either feel
magical or feel like they're hallucinating. The patterns below
are the ones that hold up at scale.

For end-user recall via Claude itself (Claude Desktop, Claude Code,
Cursor, etc.), see [`RECALL_AND_CONSOLIDATION.md`](RECALL_AND_CONSOLIDATION.md).
This section is about calling recall from your own application code.

### Pattern 1 — Bounded context injection

The most common shape: before calling your LLM, recall the top-k
most relevant memories for the current turn and inject them into
the prompt.

```python
# At every LLM call, scope to the user and limit context size.
results = mem.search(
    query=user_message,
    namespace=f"user-{user_id}",
    k=5,
)
context = "\n\n".join(r.content for r in results)
prompt = f"Relevant prior context:\n{context}\n\nUser: {user_message}"
```

**Tune `k` to your token budget.** Each result is the full memory
content, not the preview. 5 is a safe default for chat-sized
memories; 2–3 for long documents.

### Pattern 2 — Preview-first, fetch-on-demand

For interactive UIs (search bars, "what do I know about X" panels),
don't fetch full content up-front. The hybrid search returns
previews (~800 chars) plus ids; let the user click through to
expand.

```python
hits = mem.search(query=q, namespace=ns, k=20)  # previews only
# render hits[i].content_preview in the UI
# on click → mem.get(hits[i].id) for the full text
```

This keeps recall latency low and avoids paying for content the
user never reads.

### Pattern 3 — Tag-scoped recall

Tags are how you carve a namespace into facets without exploding
your namespace count. Useful when one logical owner has multiple
kinds of memory.

```python
# Save with type tags
mem.save(meeting_transcript, namespace=f"user-{uid}", tags=["meeting", "transcript"])
mem.save(decision_log,       namespace=f"user-{uid}", tags=["decision"])

# Recall only decisions, not transcripts
results = mem.search(
    query="why did we pick Postgres",
    namespace=f"user-{uid}",
    tags=["decision"],
)
```

### Pattern 4 — Thread reconstruction

For chat-import sources, each saved memory has a `source_ref`
linking back to its parent thread. To get the full conversation
back from any single hit:

```python
hit = mem.search(query=q, namespace=ns, k=1)[0]
thread = mem.get_thread(hit.source_ref)  # full chain in order
```

This is the right call when one memory is interesting but you
need the surrounding turns to make sense of it.

### Pattern 5 — Hybrid search is doing real work — let it

mnueron's recall fuses FTS5 keyword search and sqlite-vec
semantic similarity via Reciprocal Rank Fusion. **You don't need
to pre-process the query.** Natural-language queries beat
keyword-extracted ones in almost every benchmark we've run.

```python
# ✅ Just pass the user's message through
mem.search(query=user_message, namespace=ns)

# ❌ Don't do this — you lose semantic signal
keywords = extract_keywords(user_message)
mem.search(query=" ".join(keywords), namespace=ns)
```

### Anti-patterns

- **Recalling from a global namespace.** Same data-leak risk as the
  save side; see "Multi-tenant patterns".
- **Caching recall results across users.** Recall is cheap;
  cross-user cache hits are a security incident.
- **Re-embedding the query yourself.** mnueron handles embedding on
  the server side. Sending pre-embedded queries breaks the hybrid
  fusion.
- **Using `memory_list` as search.** `list` is for browsing recency,
  not relevance. Use `search` for "what do we know about X".

---

## Audio + LLM integration

Common stack for transcription apps:

```
Audio in ──► Deepgram / AssemblyAI ──► transcript text
                                            │
                                            ▼
                                   Claude / GPT-4o / Mistral
                                            │
                       ┌────────────────────┼──────────────────┐
                       ▼                    ▼                  ▼
                action items            decisions          questions
                       │                    │                  │
                       └────────► mem.save(...) ◄──────────────┘
                                            │
                                            ▼
                       Later: mem.search("our pricing approach")
```

Three minimum mnueron calls per meeting:

```python
# 1. Save the raw transcript (one memory, long-form)
mem.save(
    content=transcript,
    namespace=f"meeting-{meeting_id}",
    tags=["raw-transcript"],
    metadata={"duration_s": 1800, "attendees": ["sarah", "ali"]},
)

# 2. Save each decision/action separately so they're individually retrievable
for decision in extract_decisions(transcript):
    mem.save(
        content=decision.text,
        namespace=f"meeting-{meeting_id}",
        tags=["decision", *decision.tags],
        metadata={"speaker": decision.speaker, "ts_s": decision.timestamp},
    )

# 3. Save a one-paragraph summary for "what did we talk about?" queries
mem.save(
    content=summarize(transcript),
    namespace=f"meeting-{meeting_id}",
    tags=["summary"],
)
```

Then at query time:

```python
results = mem.search(
    query="what did sarah want to do about pricing",
    metadata_filter={"speaker": "sarah"},   # v0.2.4
    namespace=f"meeting-{meeting_id}",
    k=5,
)
```

---

## Performance notes

- **Hosted search latency**: ~50-150ms for a 5K-memory namespace, ~200-400ms
  for 100K. Vector index is `vector_cosine_ops` on pgvector; BM25 is the
  Postgres FTS index. Both are pre-built when mnueron creates the table.
- **Bulk save**: use `mem.save_bulk([...])` (v0.2.x SDK) for >5 memories
  in one shot. One HTTP round-trip instead of N. The server inserts in a
  single transaction.
- **Bulk search**: `POST /api/memories/search/bulk` (v0.2.3) for multiple
  queries in one request. Same savings; useful for apps that scatter
  many context fetches per user action.
- **Pagination**: list endpoints take `limit` (max 500) + `offset`. For
  cursor-style pagination, use `updated_before` + `limit` and sort by
  `updated_at DESC`.
- **Date-range filter** (v0.2.1): use `created_after` / `created_before`
  to scope queries temporally without indexing by date manually.
- **Embeddings** (local mode): mnueron uses Transformers.js with
  `all-MiniLM-L6-v2` on CPU. First save downloads the model (~25 MB,
  cached). Subsequent calls are ~30ms each.
- **Embeddings** (hosted mode): currently BM25 only; semantic embedding
  generation lands in a background worker tier in v0.3. Until then,
  queries against the hosted backend use FTS5/Postgres FTS only.

---

## Practical patterns

### Pattern: "context primer" before each LLM call

```python
def answer(user_message: str, user_id: str) -> str:
    # Pull the 5 most-relevant past memories for this user.
    context = mem.recall(user_message, namespace=f"user-{user_id}", k=5)
    context_str = "\n\n".join(m.content for m in context)

    completion = llm.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content":
                f"What you know about this user:\n{context_str}"},
            {"role": "user", "content": user_message},
        ],
    )
    answer = completion.choices[0].message.content

    # Save anything worth remembering about this exchange.
    facts = extract_facts(answer)
    for fact in facts:
        mem.save(fact, namespace=f"user-{user_id}", source="auto-extract")

    return answer
```

### Pattern: "did we already cover this?" before adding context

```python
def maybe_add_context(query: str, user_id: str) -> str | None:
    hits = mem.recall(query, namespace=f"user-{user_id}", k=3)
    if not hits or hits[0].score < 0.6:
        return None     # nothing relevant — don't pollute the prompt
    return "\n\n".join(h.content for h in hits)
```

### Pattern: provider-agnostic call site

```python
# Switch LLM with a one-line change — mnueron doesn't care.
context = mem.recall(query, namespace=ns, k=5)

# response = openai_client.chat.completions.create(...)
# response = anthropic_client.messages.create(...)
response = mistral_client.chat.complete(...)
```

---

## Worked example: meeting-notes app

See `examples/apps/meeting_notes_skeleton.py` in this repo for a minimal
end-to-end implementation:

- Reads a transcript file (you supply the Deepgram / AssemblyAI part)
- Extracts decisions + action items via Anthropic Claude
- Saves each as its own memory
- Exposes a `recall(query)` function for the UI / next conversation

It's <100 lines, ships nothing fancy, and exists specifically as a
"copy this, modify, ship something real" starting point. Run it
locally with `MNUERON_API_TOKEN=mnu_... python meeting_notes_skeleton.py
some_transcript.txt`.

---

## What's NOT in this version

(For honesty's sake — these will land in v0.3+ and are tracked in PLAN.md.)

- Webhook subscriptions for memory.saved / .updated / .deleted events
- Time-decay / relevance boosting per namespace
- Multi-namespace search (one query spans many namespaces)
- Audit logs exposed at the API level for compliance customers
- Fact-extraction at save time (saved as a v0.2.9 task)

If you're building something that needs one of these, file an issue —
real customer pull is what we'll prioritize on.

---

## Pricing reminder

| Mode | Cost |
| --- | --- |
| Local-only (your own SQLite, your own machine) | $0 forever |
| Hosted, Personal plan | $9/mo per user |
| Hosted, Team plan | $25/mo per seat |
| Self-host the hosted server | $0 (your own infra) |

The free local path stays viable forever as the architecture's load-bearing
"never lose your data" guarantee. Build accordingly.

---

## Questions

The fastest channel is GitHub Issues:
<https://github.com/randi2160/mnueron/issues>

For commercial / contract work, see [mnueron.com/contact](https://mnueron.com/contact).
