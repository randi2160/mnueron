---
name: mnueron-recall
description: Recall any prior conversation, decision, or fact from mnueron memory. Use when the user references past work — "what did we decide about X", "find that chat where we set up Y", "what's the namespace for Z" — or any time prior context would help answer the current question.
---

# mnueron — Recall

mnueron is a persistent memory layer covering every Cowork chat, every
imported claude.ai conversation, every ChatGPT export, and anything
saved manually. This skill is the recall path.

## When to use

Always reach for this BEFORE asking the user to recap something they
might have discussed before. Signs the user expects you to recall:

- "We were working on…"
- "What did we decide about…"
- "Pick up where we left off."
- "What's the [URL / token / namespace / decision] for…"
- "Earlier you said…"
- Any reference to past chats, sessions, or work.

## How to use

Call the `memory_recall` MCP tool with a natural-language query and the
namespace the user works in (most commonly `elevizio` or
`claude-cowork`). Limit to 5 results unless the user asks for more.

```
memory_recall({
  query: "<the question, paraphrased>",
  namespace: "elevizio",
  k: 5
})
```

Each result has a `content` field (an excerpt) and metadata including
`title`, `session_id`, `parent_ref`, `chunk_index`, and
`first_timestamp`. The `content` is usually a transcript fragment in
`**User:** … **Claude:** …` format.

### Reassembling a long thread

If a recall result has `metadata.parent_ref` (it's a chunk of a longer
conversation), call `memory_get_thread` to pull every chunk in order:

```
memory_get_thread({ id_or_parent_ref: "<that parent_ref>" })
```

That gives you the full conversation, ordered, which lets you summarize
the actual arc of the discussion.

## How to present recall results

1. **Answer the user's question first** — using what recall returned as
   substance, not just citing that recall happened.
2. **Cite specifics.** If recall surfaces "we decided to use elevizio
   as the namespace because…", quote or paraphrase that decision
   directly. Don't be vague.
3. **Offer to dig deeper.** If recall returns 5 partial chunks from
   different threads, mention them briefly and offer to pull the full
   thread for whichever sounds most relevant.

## When recall returns nothing

If `memory_recall` returns 0 hits:

1. Try a broader query (drop adjectives, broaden the topic).
2. Try without the namespace filter — the memory might be in a
   different one.
3. Use `memory_namespaces()` to see what namespaces exist.
4. If still nothing, tell the user honestly — don't invent past
   context.

## Saving new memories during a session

If the user makes a decision or learns a fact worth remembering for
future sessions, call `memory_save`:

```
memory_save({
  content: "Decision: we use the 'elevizio' namespace for all mnueron + Cowork work because that's where the original import landed.",
  namespace: "elevizio",
  tags: ["decision", "namespace"]
})
```

Don't save tool output, raw transcripts, or boilerplate — only durable
facts the user (or a future Claude) would want to recall.
