# @mnueron/sdk — TypeScript SDK

```bash
npm install @mnueron/sdk
```

Works in Node 18+, Deno, Bun, Cloudflare Workers, browsers (CORS-permitting).
Both ESM and CommonJS builds shipped. No runtime dependencies.

Grab a bearer token at <https://www.mnueron.com/account-settings/tokens>.

## Quickstart

```ts
import { Mnueron } from '@mnueron/sdk';

const m = new Mnueron({ apiKey: 'mnu_...' });   // or set MNUERON_API_KEY env

// Save
const mem = await m.save('User prefers concise replies', {
  namespace: 'my-app',
  tags: ['preferences'],
});

// Full-text search (BM25 server-side)
const hits = await m.search('how does the user like responses?', {
  namespace: 'my-app',
  k: 5,
});
for (const r of hits) console.log(r.content, r.score);

// Partial update — metadata MERGED (pass null in values to delete a key)
await m.update(mem.id, {
  tags: ['preferences', 'tone'],
  metadata: { confidence: 0.9 },
});

await m.delete(mem.id);
```

## Configuration

```bash
export MNUERON_API_KEY=mnu_xxxxxxxxxxxxxxxxxxxxx
# Optional — default is https://www.mnueron.com
export MNUERON_API_URL=https://www.mnueron.com
```

```ts
const m = new Mnueron();   // picks up env vars
```

## Date + metadata filters (v0.2.1 / v0.2.4)

```ts
const yesterday = Date.now() - 24 * 60 * 60 * 1000;
const recent = await m.list({
  namespace: 'my-app',
  created_after: yesterday,
  metadata_filter: { speaker: 'sarah' },
});
```

## Bulk search (v0.2.3)

Up to 25 queries in one HTTP round-trip:

```ts
const results = await m.bulkSearch(
  ['onboarding', 'billing edge cases', 'JWT setup'],
  { namespace: 'work', k: 5 },
);

for (const r of results) {
  console.log(r.query, '→', r.hits.length, 'hits');
}
```

## Webhooks (v0.3.1)

Register a delivery endpoint:

```ts
const hook = await m.createWebhook('https://example.com/mnueron-hook', {
  events: ['memory.saved', 'memory.deleted'],
  description: 'forward saves into our event bus',
});
console.log('Store this once — wont appear again:', hook.secret);
```

Verify incoming deliveries — works in Node, Workers, Deno, Bun:

```ts
import { verifyWebhookSignature } from '@mnueron/sdk';

// Express
app.post('/mnueron-hook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.header('X-Mnueron-Signature');
  const ok = await verifyWebhookSignature(secret, req.body, sig);
  if (!ok) return res.status(401).end();
  // ... handle payload
  res.status(200).end();
});

// Next.js App Router
export async function POST(req: Request) {
  const raw = new Uint8Array(await req.arrayBuffer());
  const sig = req.headers.get('x-mnueron-signature');
  if (!(await verifyWebhookSignature(secret, raw, sig))) {
    return new Response('invalid signature', { status: 401 });
  }
  // ... handle JSON.parse(new TextDecoder().decode(raw))
  return new Response(null, { status: 204 });
}
```

The verifier uses Node's `node:crypto` when available and falls back to
Web Crypto everywhere else.

## Use with an LLM client

```ts
import OpenAI from 'openai';
import { Mnueron } from '@mnueron/sdk';

const m = new Mnueron();
const llm = new OpenAI();

const context = await m.search(userMessage, { namespace: 'user-123', k: 5 });
const promptContext = context.map((r) => r.content).join('\n');

const reply = await llm.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [
    { role: 'system', content: `Relevant context:\n${promptContext}` },
    { role: 'user', content: userMessage },
  ],
});

// Opt into v0.2.9 fact extraction on this save
await m.save(reply.choices[0].message.content!, {
  namespace: 'user-123',
  source: 'auto',
  metadata: { extract_facts: true },
});
```

Same shape works with `@anthropic-ai/sdk`, Mistral, Gemini, or any
other client.

## API reference

| Method | Returns | Notes |
|---|---|---|
| `save(content, opts?)` | `Memory` | Single insert. Fires `memory.saved` webhooks. |
| `search(query, opts?)` | `Memory[]` | BM25 search with stacking filters. |
| `bulkSearch(queries, opts?)` | `BulkSearchResult[]` | v0.2.3 — up to 25 queries per batch. |
| `list(opts?)` | `Memory[]` | Newest-first with date + metadata filters. |
| `get(id)` | `Memory \| null` | Returns null on 404. |
| `update(id, patch)` | `Memory` | v0.2.2 partial update. Metadata merged. |
| `delete(id)` | `void` | Fires `memory.deleted` webhook. |
| `namespaces()` | `Namespace[]` | Counts per namespace. |
| `health()` | `boolean` | Liveness probe. |
| `listWebhooks() / createWebhook / getWebhook / updateWebhook / deleteWebhook` | — | v0.3.1 webhook management. |
| `verifyWebhookSignature(secret, body, header)` | `Promise<boolean>` | Constant-time HMAC-SHA256 check. |

All methods throw `MnueronError` on non-2xx. The class exposes
`status` (HTTP code) and `message` (server's error field if it provided
one, else raw body / status text).

## Local-only mode

This SDK only speaks to the hosted backend. For a free local mode (no
account, data never leaves your machine), install the `mnueron` CLI:

```bash
npm install -g mnueron
mnueron setup
```

The CLI wires an MCP server into Claude Desktop, Claude Code, Cursor,
Windsurf, Cline, Continue, Zed, Goose, and OpenCode automatically.

## License

MIT.
