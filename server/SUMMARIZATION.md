# Assistant-response summarization

The `summarizer.ts` module compresses long AI assistant responses to ~10% of
their original size before storage, using Claude Haiku to extract the
high-signal information.

## Why this exists

Browser-captured conversations and agent-generated memory entries often
contain long AI responses (1000-5000 chars). Stored verbatim, these:

- Inflate storage 5-10x vs. user messages
- Dominate vector-search results because they have more keywords
- Risk storing hallucinations as if they were facts

Summarization at write time fixes all three. The summary is what gets
embedded and indexed for search; the original full text is preserved in
`metadata.original_content` (truncated to 4000 chars by default) so it's
never lost.

## Two-tier strategy

| Tier | What it does | When to call |
| --- | --- | --- |
| **Turn-level** (`summarizeMemory`) | Replaces long single-turn content with a 100-word summary. Preserves original in metadata. | On every `POST /v1/memories` and `/v1/memories/bulk` |
| **Conversation-level** (`summarizeConversation`) | Produces ONE high-level summary memory per conversation, saved alongside the turn-level ones. Answers "what did we work on this week?" | Once per conversation, after capture is complete |

## Cost

- Turn-level summary: ~$0.0015 each (Claude Haiku 4.5)
- Conversation-level summary: ~$0.005 each
- For a power user capturing 50 long turns/day: ~$2.25/month
- For a typical user: well under $1/month

You can cut these in half by submitting to Anthropic's Batch API for
async overnight processing — fine for analytics and dashboards, but for
live search you want inline summarization.

## Integration into server/index.ts

Two lines need to change in the existing save handler:

```typescript
// BEFORE
import { provider } from './store/provider.js';

app.post('/v1/memories', authMiddleware, async (req, res) => {
  const input = req.body;
  const memory = await provider.save(input);   // <-- raw save
  res.json(memory);
});
```

```typescript
// AFTER
import { provider } from './store/provider.js';
import { summarizeMemory } from './summarizer.js';

app.post('/v1/memories', authMiddleware, async (req, res) => {
  const input = req.body;
  const transformed = await summarizeMemory(input);   // <-- summarize first
  const memory = await provider.save(transformed);
  res.json(memory);
});
```

For the bulk endpoint, swap to `summarizeBatch` which parallelizes:

```typescript
import { summarizeBatch } from './summarizer.js';

app.post('/v1/memories/bulk', authMiddleware, async (req, res) => {
  const items = req.body.items;
  const transformed = await summarizeBatch(items);
  const results = await provider.saveBulk(transformed);
  res.json({ saved: results.length, errors: 0 });
});
```

That's the entire integration. ~6 lines changed.

## Conversation-level integration (optional but high-value)

After the browser extension captures a conversation, you'd call this once
to produce the high-level memory:

```typescript
import { summarizeConversation } from './summarizer.js';

// After saving turn-level memories...
const summary = await summarizeConversation({
  conversationId: payload.conversation_id,
  title: payload.title,
  turns: payload.turns,
  url: payload.url,
  capturedAt: payload.captured_at,
});

if (summary) {
  await provider.save({
    content: summary.content,
    namespace: namespace,
    tags: ['conversation-summary', site],
    source: `${site}-browser`,
    source_ref: payload.conversation_id,
    metadata: summary.metadata,
  });
}
```

Now searches for "what did I work on this week" can hit the
conversation-summary entries directly without wading through 200
individual turn memories.

## Tuning

Default config (in `summarizer.ts`):

```typescript
{
  enabled: true,
  minLength: 500,            // chars — below this, skip summarization
  rolesToSummarize: ['assistant'],
  keepOriginal: true,
  originalMaxLength: 4000,   // chars of original preserved in metadata
  model: 'claude-haiku-4-5',
  maxSummaryTokens: 200,     // output cap
}
```

Override per-request:

```typescript
await summarizeMemory(input, {
  minLength: 1000,           // only summarize REALLY long stuff
  rolesToSummarize: [],      // disable for this call
});
```

## Failure mode

If the LLM call fails (timeout, rate limit, network error), `summarizeMemory`
returns the original input unchanged. **Memory writes never fail because of
a summarization error.** You may end up with a few un-summarized long
memories in your store, which is fine — they're still searchable, just
not optimal.

## What this enables that you couldn't do before

- **"What did I decide last week?"** — conversation summaries make this answerable in one search instead of digging through 50 turn-level memories.
- **Smaller embedding bills** — embeddings cost per-token; 10x shorter content = 10x lower embedding cost.
- **Faster recall** — shorter memories load and rank faster.
- **Sharper RAG** — context windows fill with high-signal summaries instead of verbose preambles, so the LLM you're feeding it back into gets clearer signal.

## What's NOT in this version

Things that would be reasonable v0.3 enhancements:

- **Batch API submission** for async overnight summarization (50% cheaper)
- **Per-user model selection** (some users want Sonnet quality, accept the cost)
- **Configurable prompts** per namespace (different summarization rules for code-heavy vs. chat-heavy memories)
- **Re-summarization** when the underlying memory is updated
- **Quality eval loop** — periodically sample summarized vs. original and check that recall quality holds

None of those block launch.
