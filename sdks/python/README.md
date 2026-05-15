# mnueron — Python SDK

```bash
pip install mnueron
```

```python
from mnueron import Mnueron

with Mnueron(api_key="mn_...") as client:
    # Save a memory
    mem = client.save(
        "User prefers concise replies over long explanations",
        namespace="my-app",
        tags=["preferences"],
    )

    # Semantic search
    results = client.search("how does the user like responses?", namespace="my-app", k=5)
    for r in results:
        print(r.content, r.score)

    # List recent memories
    recent = client.list(namespace="my-app", limit=20)

    # Delete
    client.delete(mem.id)

    # Bulk import
    client.bulk_save([
        {"content": "fact 1", "namespace": "my-app"},
        {"content": "fact 2", "namespace": "my-app"},
    ])
```

## Async version

```python
import asyncio
from mnueron import AsyncMnueron

async def main():
    async with AsyncMnueron(api_key="mn_...") as client:
        await client.save("...", namespace="my-app")
        results = await client.search("...", namespace="my-app")

asyncio.run(main())
```

## Configuration via env vars

```bash
export MNUERON_API_KEY=mn_xxxxxxxxxxxxxxxxxxxxx
export MNUERON_API_URL=https://api.your-mnueron.com   # optional, defaults to api.mnueron.dev
```

```python
from mnueron import Mnueron
client = Mnueron()   # picks up env vars
```

## API reference

| Method | Returns | Notes |
|---|---|---|
| `save(content, *, namespace, tags, source, source_ref, metadata)` | `Memory` | Single save |
| `bulk_save([{content, ...}, ...])` | `BulkResult` | Many at once |
| `search(query, *, namespace, k, tags)` | `List[Memory]` | Hybrid BM25 + vector |
| `list(*, namespace, limit, before)` | `List[Memory]` | Reverse chronological |
| `get(memory_id)` | `Memory \| None` | Lookup by id |
| `delete(memory_id)` | `None` | |
| `namespaces()` | `List[Namespace]` | Counts per namespace |

All methods raise `MnueronError(status, message)` on HTTP errors.

## Use with OpenAI / Anthropic clients

The SDK is provider-agnostic — call it before or after your LLM call:

```python
from openai import OpenAI
from mnueron import Mnueron

mem = Mnueron(api_key="mn_...")
llm = OpenAI()

# Retrieve relevant memories before calling the model
context = mem.search(user_message, namespace="user-123", k=5)
prompt_context = "\n".join(m.content for m in context)

response = llm.chat.completions.create(
    model="gpt-4o-mini",
    messages=[
        {"role": "system", "content": f"Relevant context:\n{prompt_context}"},
        {"role": "user", "content": user_message},
    ],
)

# Save anything worth remembering from this turn
mem.save(extract_facts(response), namespace="user-123", source="auto")
```

Same shape works with Anthropic, Mistral, Gemini, or any other client.

## License

MIT.
