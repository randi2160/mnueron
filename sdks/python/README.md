# mnueron — Python SDK

Wraps the hosted mnueron API at <https://www.mnueron.com>. Grab a bearer
token from `Settings → API Tokens` after signing up.

```bash
pip install mnueron
```

```python
from mnueron import Mnueron

with Mnueron(api_key="mnu_...") as client:
    # Save a memory
    mem = client.save(
        "User prefers concise replies over long explanations",
        namespace="my-app",
        tags=["preferences"],
    )

    # Full-text search (BM25 server-side)
    for r in client.search("how does the user like responses?",
                           namespace="my-app", k=5):
        print(r.content, r.score)

    # List recent memories
    recent = client.list(namespace="my-app", limit=20)

    # Partial update — metadata is MERGED, pass {"key": None} to remove
    client.update(mem.id, tags=["preferences", "tone"],
                  metadata={"confidence": 0.9})

    # Delete
    client.delete(mem.id)
```

## Async version

```python
import asyncio
from mnueron import AsyncMnueron

async def main():
    async with AsyncMnueron(api_key="mnu_...") as client:
        await client.save("...", namespace="my-app")
        results = await client.search("...", namespace="my-app")

asyncio.run(main())
```

## Configuration via env vars

```bash
export MNUERON_API_KEY=mnu_xxxxxxxxxxxxxxxxxxxxx
# Optional — default is https://www.mnueron.com
export MNUERON_API_URL=https://www.mnueron.com
```

```python
from mnueron import Mnueron
client = Mnueron()   # picks up env vars
```

## API reference

| Method | Returns | Notes |
|---|---|---|
| `save(content, *, namespace, tags, source, source_ref, metadata)` | `Memory` | Single save. Triggers backend redaction + fact extraction (if enabled) + `memory.saved` webhooks. |
| `search(query, *, namespace, k, created_after, created_before, updated_after, updated_before, metadata_filter)` | `List[Memory]` | BM25 search. All filters stack. |
| `bulk_search(queries, *, namespace, k, ...)` | `List[BulkSearchResult]` | v0.2.3 — up to 25 queries in one HTTP call. |
| `list(*, namespace, limit, offset, created_after, ...)` | `List[Memory]` | Newest-first list with date + metadata filters. |
| `get(memory_id)` | `Memory \| None` | Returns None on 404. |
| `update(memory_id, *, content, tags, namespace, metadata)` | `Memory` | v0.2.2 partial update. Metadata merged, history recorded under `metadata.history`. |
| `delete(memory_id)` | `None` | Fires `memory.deleted` webhook. |
| `namespaces()` | `List[Namespace]` | Counts per namespace. |
| `health()` | `bool` | Liveness probe. |
| `list_webhooks() / create_webhook(...) / get_webhook(id) / update_webhook(id, ...) / delete_webhook(id)` | — | v0.3.1 webhook management. `create_webhook()` returns the signing secret once. |

All methods raise `MnueronError(status, message)` on HTTP errors.

### Date filters

`created_after`, `created_before`, `updated_after`, `updated_before` are
epoch milliseconds (`int(time.time() * 1000)`). Inclusive on the boundary.

```python
import time
yesterday = int((time.time() - 86400) * 1000)
client.list(created_after=yesterday, namespace="my-app")
```

### Metadata filter (v0.2.4)

JSON object passed to Postgres `@>` containment. Top-level keys only.

```python
client.search("billing", metadata_filter={"speaker": "sarah"})
```

### Bulk search (v0.2.3)

```python
results = client.bulk_search(
    ["onboarding", "billing edge cases", "JWT setup"],
    namespace="work", k=5,
)
for r in results:
    print(r.query, "→", len(r.hits))
```

## Webhooks (v0.3.1)

mnueron can POST signed deliveries to your HTTPS endpoint on
`memory.saved`, `memory.updated`, `memory.deleted`, or `summary.created`.

```python
hook = client.create_webhook(
    "https://example.com/mnueron-hook",
    events=["memory.saved", "memory.deleted"],
    description="forward saves into our event bus",
)
print("Store this once — it won't appear again:", hook.secret)
```

Verify signatures on incoming deliveries:

```python
from mnueron import verify_webhook_signature

def handler(request):
    sig = request.headers["X-Mnueron-Signature"]
    if not verify_webhook_signature(secret, request.body, sig):
        return Response(status_code=401)
    # ... process payload
```

## Use with OpenAI / Anthropic clients

```python
from openai import OpenAI
from mnueron import Mnueron

mem = Mnueron()              # MNUERON_API_KEY in env
llm = OpenAI()

context = mem.search(user_message, namespace="user-123", k=5)
prompt_context = "\n".join(m.content for m in context)

response = llm.chat.completions.create(
    model="gpt-4o-mini",
    messages=[
        {"role": "system", "content": f"Relevant context:\n{prompt_context}"},
        {"role": "user", "content": user_message},
    ],
)

mem.save(response.choices[0].message.content,
         namespace="user-123", source="auto",
         metadata={"extract_facts": True})   # opt into v0.2.9 extraction
```

Same shape works with Anthropic, Mistral, Gemini, or any other client.

## Local mode

This SDK only speaks to the hosted backend. For local-only / no-account
mode, install the `mnueron` CLI from npm and run the MCP server directly:

```bash
npm install -g mnueron
mnueron setup
```

Same six MCP tools (`memory_save`, `memory_recall`, `memory_list`,
`memory_get`, `memory_delete`, `memory_get_thread`) are wired into Claude
Desktop, Claude Code, Cursor, Windsurf, Cline, Continue, Zed, Goose, and
OpenCode by the setup wizard.

## License

MIT.
