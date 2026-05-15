# mnueron architecture

## The two-mode design

The MCP server is **storage-agnostic**. It depends on a `Provider` interface
with five methods (`save`, `search`, `list`, `delete`, `namespaces`). Two
implementations satisfy it:

| Provider | When | Storage | Cost |
| --- | --- | --- | --- |
| `LocalProvider` | Default | SQLite + FTS5 in `~/.mnueron/memories.db` | $0 |
| `RemoteProvider` | When `MNUERON_API_URL` + `MNUERON_API_TOKEN` are set | HTTPS → hosted Postgres + pgvector | Whatever you charge |

Flipping modes is **one env-var change** on the client. The MCP tool surface
and behavior stay identical. This is the property that makes the local repo
both a free OSS giveaway *and* the on-ramp to the hosted product.

## Tenancy model (hosted mode)

The hosted backend is multi-tenant by design. The unit of isolation is `org`:

```
        ┌────────────────────────────────────────┐
        │  org (a company)                        │
        │  ┌──────────────┐  ┌──────────────┐    │
        │  │ namespace A  │  │ namespace B  │    │  ← e.g. one per app
        │  │ memories…    │  │ memories…    │    │
        │  └──────────────┘  └──────────────┘    │
        │                                         │
        │  users (1..N belong via org_members)    │
        │  api_tokens (each bound to user+org)    │
        └────────────────────────────────────────┘
```

- **Users** can belong to multiple orgs (personal + work, multiple clients,
  contractors). The `org_members` table holds the M:N relation with a role
  per (org, user).
- **API tokens** are bound to `(user, org)`. The token itself decides which
  org's memories you see. A user with three orgs has three different tokens.
- **Namespaces** are sub-buckets inside an org. The two apps you mentioned —
  Claude-app and OpenAI-app under the same company — get two namespaces
  under one org. Same billing, separate memory pools.
- **Memories** are scoped to one `(org_id, namespace_id)`. The `org_id` is
  the load-bearing isolation column.

## Three layers of isolation (defense in depth)

Even if app code has a bug, cross-org leaks should not be possible.

### 1. Token resolution

Every request carries `Authorization: Bearer mn_…`. The middleware hashes the
token, looks it up in `api_tokens`, and gets back `(user_id, org_id, token_id)`.
That triple is stored on the request object and is the only source of truth
for "which org are we acting as." Headers, query params, and request bodies
are never trusted to specify the org.

### 2. Postgres Row-Level Security

After resolving the token, the backend runs:

```sql
SELECT set_config('app.current_org_id', '<the resolved org_id>', false);
SET ROLE mnueron_app;
```

Then it runs the actual query. The `mnueron_app` role has RLS policies that
make every read/write `WHERE org_id = current_setting('app.current_org_id')`.
A `SELECT * FROM memories` from within that role returns only this org's
rows. If `app.current_org_id` isn't set, the policy returns zero rows by
default — fail-closed, not fail-open.

```sql
CREATE POLICY p_memories_isolation ON memories
    USING (org_id::text = current_setting('app.current_org_id', true));
```

This means the **database** enforces the boundary, not the application. A
forgotten `WHERE org_id = ?` in app code can't leak data.

### 3. Audit log

Every mutation writes a row to `audit_log` with `(org_id, user_id, token_id,
action, target_id, metadata)`. Companies that ask "who touched our data
when" can be answered from one table. Cheap to write, expensive not to have
when an enterprise customer asks for it.

## Multi-app, multi-LLM

The storage layer is provider-agnostic and LLM-agnostic. Three concrete
patterns:

**Two apps under one company.** One org, two API tokens (one per app), each
defaulting to its own namespace. Memories tagged by app are separate but
queryable across both if you ever want a cross-app view.

**Claude-app and OpenAI-app sharing memory.** Both apps hit the same
`/v1/memories/search` endpoint. The HTTP API is the contract; the agent
framework on top doesn't matter. Use the Anthropic SDK for one, OpenAI SDK
for the other, but they both pull from the same memory pool.

**Different companies (multi-tenant SaaS).** Each company gets an `org`.
Their users sign up under it. Token-bound-to-org guarantees one company's
memories never reach another's tools or eyes.

## What's open-core

| | OSS (MIT, free forever) | Hosted (paid) |
| --- | --- | --- |
| Local MCP server | ✓ | (uses same client) |
| SQLite local store | ✓ | — |
| Importers (Claude, OpenAI) | ✓ | ✓ |
| CLI | ✓ | ✓ |
| Hosted Postgres backend | — | ✓ |
| Multi-device sync | — | ✓ |
| Web dashboard | — | ✓ |
| Team sharing | — | ✓ |
| SSO + audit | — | Enterprise tier |
| BAAs / compliance posture | — | Enterprise tier |

The `server/` directory in this repo is the hosted backend reference
implementation. It's yours; the open-core licensing convention is to keep
the server source-available but not OSI-OSS, so competitors can't repackage
your hosting as their own product. (See PostHog, Sentry, Mattermost for
established versions of this.)

## Performance notes

- **Recall latency target: <300ms p95.** The hosted server's hybrid search
  uses BM25 (tsvector) + cosine (pgvector HNSW) and fuses with reciprocal
  rank. Both indexes are HNSW/GIN, so 10K-row scans aren't a problem until
  ~10M rows per org. Past that, partition by org_id.
- **Embeddings on the write path are blocking in the current skeleton.** In
  production, move them to a worker queue: respond 200 immediately, queue the
  embedding job, fill `embedding` async. Recall still works on tsvector while
  embedding is pending.
- **Summarization (LLM compression) is always async.** Run nightly via the
  Anthropic Batch API for 50% off list price. Users don't notice.

## Cost at scale (recap)

| Users | Monthly infra | Monthly LLM (Haiku batch) | Total | Revenue @ $12/mo | Margin |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | $130 | $20 | $150 | $1,200 | 88% |
| 1,000 | $640 | $115 | $760 | $12,000 | 94% |
| 10,000 | $4,200 | $1,100 | $5,300 | $120,000 | 96% |

The dominant variable cost is LLM compression (session summarization). Use
prompt caching for repeated context and the Batch API for non-realtime
summarization to cut that ~50–60%.

## Threat model (one paragraph)

The realistic threats are: (a) token theft via compromised dev machine, (b)
cross-tenant leak via app-layer bug, (c) malicious memory content trying to
prompt-inject downstream agents. Mitigations: short-lived tokens with
rotation + last-used tracking; RLS at the DB layer (covered above); strip
control sequences and tag user-provided memory clearly when returning to
agents so prompt-injection at recall time is contained, not silent. Secret
redaction at write time (regex + entropy scanner) before content hits storage
catches the most common "agent accidentally captured an AWS key" failure.
