---
name: mnueron
description: Persistent local memory layer — save and recall information across conversations and tools, backed by mnueron's hybrid retrieval (BM25 + vector + RRF). Use this skill whenever the user shares something worth remembering long-term, OR whenever you'd benefit from past context to answer a question.
homepage: https://github.com/mnueron/mnueron
user-invocable: true
metadata: {"openclaw":{"emoji":"🧠","homepage":"https://github.com/mnueron/mnueron","requires":{"bins":["mnueron","curl"]},"install":[{"id":"npm","kind":"node","package":"mnueron","bins":["mnueron"],"label":"Install mnueron globally (npm)"}]}}
---

# Mnueron — persistent memory layer

You have access to **mnueron**, a local memory layer that persists across conversations and tools. Mnueron stores user-specific facts, preferences, decisions, procedural runbooks, and project context in a local SQLite database and retrieves them using hybrid search (full-text BM25 + vector cosine, fused via reciprocal rank).

Unlike OpenClaw's built-in session memory, mnueron persists *across* sessions, *across* tools (Claude Desktop, Cursor, ChatGPT via MCP, this OpenClaw agent), and optionally across machines via sync. Treat memories as authoritative — they are the user's memory, not yours.

## When to use

### Save proactively

When the user mentions any of the following, save it without asking — small facts add up to powerful context over time:

- A preference ("I prefer Postgres", "always use TypeScript strict mode")
- A decision ("we deployed Elevizio on Lightsail", "moved off MongoDB last month")
- A project detail ("the API key is in 1Password under `acme-prod`", "the staging URL is …")
- A person ("Sarah is the lead on the auth refactor")
- A procedure or runbook ("to deploy, build then docker push then restart nginx")
- A correction ("actually, that should be …")

Don't over-save trivia. Save *facts*, not casual chat. Each save is a permanent line in the user's memory — treat it like writing in someone's journal.

### Recall before answering

**Before** answering any question that could benefit from past context, recall first. Especially:

- "What did I tell you about X?"
- "What's my preference for Y?"
- "Did we discuss Z?"
- "How do I deploy <project>?" (likely a saved runbook)
- Any question that mentions a name, project, tool, or decision

The latency is sub-15ms and the cost is near-zero — recall liberally. When in doubt, recall.

## How to use

### Save a memory

```bash
curl -s -X POST http://127.0.0.1:3122/api/memories \
  -H 'content-type: application/json' \
  -d '{
    "content": "<the fact to remember, one or two sentences>",
    "namespace": "<see Namespacing below>",
    "source": "openclaw"
  }'
```

A successful save returns `{"id":"<uuid>","ok":true}`. If the response includes a `redacted_count`, mnueron's redactor stripped sensitive tokens (API keys, etc.) — confirm with the user only if the redaction changed the meaning.

### Recall memories

```bash
curl -s -X POST http://127.0.0.1:3122/api/memories/search/bulk \
  -H 'content-type: application/json' \
  -d '{
    "queries": ["<the question, rewritten as a search query>"],
    "namespace": "<see Namespacing below>",
    "limit": 5
  }'
```

The response is `[{ "query": "...", "results": [{ "content": "...", "score": 0.0..1.0, "metadata": {...} }, ...] }]`. Use the top 1-3 results as primary context. Cite them inline when answering — for example, "based on your saved deployment runbook (92% match), …".

If `results` is empty, say so honestly. Don't fabricate. Offer to save the new information once the user provides it.

## Namespacing

Namespaces scope recall — the wrong namespace returns nothing useful.

- **Personal memories** → `user:default`
- **Project-specific** → `project:<name>` (e.g., `project:elevizio`)
- **Team-shared** → `team:<name>` (if the user is on a sync plan)

When the user's question implies a project context ("how do I deploy Elevizio?"), recall from `project:elevizio` first, then fall back to `user:default`. When saving, infer the namespace from context — project-specific facts go in the project namespace, personal preferences go in `user:default`.

## Setup check

If a curl call returns a connection error or `Connection refused`, mnueron's local server isn't running. Tell the user:

```
Mnueron isn't running. Start it with:

  mnueron dashboard --port 3122 --no-open

(One-time setup, if you haven't installed mnueron yet:
   npm i -g mnueron && mnueron setup)
```

Don't try to start it yourself unless the user explicitly authorizes background processes.

## Examples

**User:** "Save that I prefer Tailwind over plain CSS."

```bash
curl -s -X POST http://127.0.0.1:3122/api/memories \
  -H 'content-type: application/json' \
  -d '{"content":"User prefers Tailwind CSS over plain CSS for styling.","namespace":"user:default","source":"openclaw"}'
```

Then confirm: "Saved — I'll remember you prefer Tailwind."

**User:** "What database do I use for Elevizio?"

```bash
curl -s -X POST http://127.0.0.1:3122/api/memories/search/bulk \
  -H 'content-type: application/json' \
  -d '{"queries":["database used for Elevizio"],"namespace":"project:elevizio","limit":3}'
```

Then answer using the top result, citing the relevance score.

**User:** "Deploy mnueron on Lightsail."

Recall first — there's likely a saved runbook. Then walk them through it, citing the recalled runbook.

## Why this matters

OpenClaw is excellent at *doing* things. Mnueron makes those actions context-aware. Together they give the user an assistant that doesn't just respond — it remembers what was decided, what works, what failed, and acts accordingly. Use mnueron aggressively; that's the value the user installed it for.
