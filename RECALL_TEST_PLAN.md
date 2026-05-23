# mnueron — Recall Test Plan

The point of mnueron is *recall* — that previously-saved memories surface
again when an agent (or you) asks for them. This plan verifies recall
works end-to-end across every surface mnueron exposes, with the most
important target being Cowork chats imported via v0.2.6.

Run-time: **~30 minutes** if everything passes. Longer if you're
debugging.

Stop and fix at the first failure — later tests assume earlier ones
passed.

---

## 0. Pre-flight

Before starting, confirm:

```powershell
cd C:\Mnueron\Mnueron\mnueron-v0.1.0\mnueron

# CLI is built and current
npm run build
node dist/cli.js --version 2>$null ; node dist/cli.js stats

# Hosted credentials are loaded
echo $env:MNUERON_API_URL    # should be https://www.mnueron.com (or your URL)
echo $env:MNUERON_API_TOKEN  # should start with mnu_
```

Expected: `stats` prints counts by namespace, including `claude-cowork`
populated by the recent import. If `MNUERON_API_URL` is empty, you're in
local-only mode — set it now or skip the hosted sections later.

---

## 1. Local CLI recall

The fastest signal that imported memory is searchable at all.

### 1.1 Search by a phrase you know is in a Cowork chat

```powershell
node dist/cli.js search "claude-cowork" --ns claude-cowork --k 3
```

**Expected:** 3 results from the `claude-cowork` namespace, each printing
a preview that includes the matched phrase or nearby context.

**Pass criteria:**
- ≥ 1 result returned
- Each result shows `source: claude-cowork`
- Previews are bounded (~800 chars) — not the full chunked transcript

**Common failure:** zero results. Likely cause: namespace mismatch (you
imported into a different namespace) — re-run with the correct `--ns`
or drop the flag to search all namespaces.

### 1.2 Cross-namespace fuzzy search

Pick a topic you discussed across multiple chats (e.g. "Stripe", "pricing",
"RLS"):

```powershell
node dist/cli.js search "stripe pricing" --k 5
```

**Expected:** Results spanning multiple namespaces — at minimum some
from `claude-cowork`. Hybrid BM25 + vector means semantic neighbours
(e.g. "billing tier") should also surface.

### 1.3 Specific Cowork session recall

Recall a chunk from a specific Cowork session by its title or a unique
phrase:

```powershell
node dist/cli.js search "Microsoft Store sandbox" --k 3
```

**Expected:** at least one result from the recent Cowork import work
(this very session imported transcripts that mention the Store sandbox).

---

## 2. Local dashboard recall

```powershell
node dist/cli.js dashboard
```

Browser opens at `localhost:3122`. Verify:

| What | Expected |
|---|---|
| Left rail | `claude-cowork` namespace appears with a count > 0 |
| Click `claude-cowork` | List populates with one row per session/thread |
| Search bar — type a phrase | Results filter live; chat-bubble preview rendered with `User:` / `Claude:` pills |
| Click a thread | Right pane shows the full per-turn chat bubbles, code blocks syntax-highlighted |
| `j` / `k` keys | Navigate list up/down |
| Light/dark toggle | Theme switches |

**Pass criteria:** all six rows are green.

---

## 3. Hosted dashboard recall (mnueron.com)

Skip if you didn't push to hosted.

### 3.1 Dashboard list + search

Open `https://www.mnueron.com/dashboard`. Verify:

- Namespace list (left rail) shows `claude-cowork` with the expected count
- Search bar finds the same phrase you tested in §1.1
- Threading: a 200-message session shows as ONE entry (not 200 chunks) —
  click it, full thread expands

### 3.2 Import modal works

Click the **Import** button in the toolbar. Verify:

- Modal opens
- Three cards: "Upload export file", "Connect Chrome extension", "Import
  Cowork chats"
- Click each card; "back to all options" returns you to the menu
- Esc and click-outside both close the modal

### 3.3 Direct API recall

From your terminal:

```powershell
$token = $env:MNUERON_API_TOKEN
$headers = @{ Authorization = "Bearer $token" }

# Search via the same query string the dashboard uses
Invoke-RestMethod -Headers $headers `
  -Uri "https://www.mnueron.com/api/memories?q=microsoft+store&namespace=claude-cowork&limit=3" |
  Select-Object id, namespace, source, content_preview | Format-List
```

**Expected:** 1-3 rows of JSON, each with `source: claude-cowork` and
a preview that contains the phrase.

---

## 4. MCP recall — the most important test

This is what closes the loop on "remember context across sessions". You'll
need Claude Desktop, Claude Code, or Cursor configured against mnueron
(`mnueron setup` did this for you).

### 4.1 Fresh session, no context

Open a new conversation in Claude (Desktop OR Code). Don't reference any
prior chat. Just ask:

> "What memory tools do you have?"

**Expected:** Claude lists `memory_save`, `memory_recall`, `memory_get`,
`memory_list`, `memory_delete`, `memory_namespaces`, `memory_import_chat`,
`memory_import_cowork`. The last one is the v0.2.6 addition — its
presence is your signal that the new MCP tool definition deployed.

### 4.2 Recall from a Cowork chat

Without telling Claude what you talked about previously, ask:

> "Search my mnueron memory for what we decided about Stripe pricing tiers."

**Expected:** Claude calls `memory_recall` with the right query, gets
back 1-5 results from `claude-cowork`, and summarises what was decided.
The summary should match the actual prior conversation.

**Pass criteria:** The summary references *specific* prior decisions —
not a generic "Stripe has pricing tiers" answer. If it's generic, Claude
either didn't call the tool or got 0 hits.

### 4.3 Thread reassembly

> "Open the thread where we set up the Cowork importer and show me the
> first three turns."

**Expected:** Claude calls `memory_recall` → gets a chunk with
`parent_ref` → calls `memory_get_thread` → shows the first three turns
in order.

### 4.4 New cross-session memory

> "Remember that the launch date is June 30. Save that to mnueron."

Then start a *new* conversation. Ask:

> "When is the launch?"

**Expected:** The new session recalls "June 30" via `memory_recall`. This
is the simplest possible end-to-end save-and-recall proof.

---

## 5. SDK recall (smoke check for developers)

If you've published or installed the SDK:

```powershell
node -e @"
const { Mnueron } = require('@mnueron/sdk');
const c = new Mnueron({ apiKey: process.env.MNUERON_API_TOKEN });
(async () => {
  const hits = await c.search({ q: 'cowork', namespace: 'claude-cowork', limit: 3 });
  console.log(`got ${hits.length} hits`);
  console.log(hits[0]?.content_preview?.slice(0, 240));
})();
"@
```

```python
python -c "
import os
from mnueron import Mnueron
m = Mnueron(api_key=os.environ['MNUERON_API_TOKEN'])
hits = m.search('cowork', namespace='claude-cowork', k=3)
print(f'got {len(hits)} hits')
print(hits[0].content_preview[:240] if hits else 'no hits')
"
```

**Expected:** ≥ 1 hit, preview text printed.

---

## 6. Watch mode + incremental recall

Verifies the v0.2.6 `mnueron watch` keeps memory current.

In one terminal:

```powershell
node dist/cli.js watch --claude-cowork --interval 1
```

In the Claude desktop app, start a brand-new Cowork chat. Send a unique,
trackable message like "Test phrase: blue elephant in March 2026."
Continue the chat for ~30 seconds so the JSONL flushes.

Wait 60-90 seconds for the watcher's tick. Stop the watcher (Ctrl+C).
Then search:

```powershell
node dist/cli.js search "blue elephant" --k 3
```

**Expected:** ≥ 1 hit pointing back at the chat you just had.

**Pass criteria:** the watcher detected the new session, imported its
transcript, and recall finds the phrase. Confirms the live-sync loop.

---

## 7. Recall quality benchmark (optional, for launch readiness)

A precision/recall sanity check before publishing benchmarks.

1. Pick 10 specific facts you remember discussing in past Cowork chats
   (e.g. "we decided X, Y, Z"). Write each as a one-sentence query.
2. For each query, run:

   ```powershell
   node dist/cli.js search "<query>" --ns claude-cowork --k 5
   ```

3. Score: does the top-5 contain the chunk that actually answers it?

**Pass criteria:**
- ≥ 7/10 correct in top-5 → recall is healthy
- 5-6/10 → tune the chunker or rebuild embeddings (`mnueron
  rebuild-embeddings`)
- < 5/10 → something's wrong (embeddings missing, wrong namespace, etc.)

This number is the floor for publishing a benchmark vs agentmemory/Mem0.

---

## Pass/fail summary

Record results below; copy into a HANDOFF on the way out:

```
§1 Local CLI recall          [ pass / fail ]
§2 Local dashboard recall    [ pass / fail ]
§3 Hosted dashboard recall   [ pass / fail / skipped ]
§4 MCP recall (new session)  [ pass / fail ]
§5 SDK recall                [ pass / fail / skipped ]
§6 Watch mode incremental    [ pass / fail / skipped ]
§7 Top-5 recall quality      [ NN / 10 ]
```

A passing run across §1-§4 is the bar for "launch-ready memory recall."
§5-§7 are nice-to-haves before public announcement.
