-- =============================================================================
-- mnueron docs — combined apply pack for migrations 022 + 023
--
-- Paste this ENTIRE file into Supabase SQL Editor → Run.
-- (Toggle "Enforce RLS" OFF first if it's on.)
--
-- What this does:
--   022 — publishes /docs/getting-started/pulling-memory
--         (the 3-pull-modes guide: manual recall, ambient, MCP)
--   023 — adds /docs/sdks/typescript page, fixes SDK section description
--         to include TypeScript, rewrites the SDK overview page to list
--         all 3 languages, and strips stale "publish pending" /
--         "code ready" phrasing from /docs/reference/everything
--
-- Both files are idempotent — running twice is safe.
-- =============================================================================

-- ▼▼▼ MIGRATION 022 BELOW ▼▼▼

-- =============================================================================
-- mnueron docs — "How MNUERON pulls memory into your AI" guide
--
-- The single most important conceptual page in the docs: explains that
-- MNUERON sits BESIDE your AI tools (claude.ai, ChatGPT, Claude Desktop,
-- Cursor, IDE plugins) rather than INSIDE them, and walks through the
-- three pull modes:
--
--   1. Manual recall    (Chrome extension popup)
--   2. Ambient suggest  (Chrome extension floating strip)
--   3. Agentic / MCP    (Claude Desktop / Code / Cursor — AI calls
--                        memory_recall itself when it needs context)
--
-- Includes step-by-step setup for each mode plus a "how to verify it
-- works" section and a troubleshooting table.
--
-- Lives under /docs/getting-started/pulling-memory so new users
-- understand the architecture before they touch any code.
--
-- Uses $DOC$ outer dollar-quote, $$ inner dollar-quote where needed,
-- and ${VAR} shell wrapping for env-var references inside code fences.
-- Idempotent via ON CONFLICT (section_id, slug) DO UPDATE.
--
-- HOW TO APPLY: Supabase SQL Editor → toggle Enforce RLS OFF → paste → Run.
-- =============================================================================

INSERT INTO doc_pages (section_id, slug, title, description, content_md, sort_order, published)
SELECT id, 'pulling-memory',
       'How MNUERON pulls memory into your AI',
       'Three ways memory gets into Claude, ChatGPT, Cursor, and other AI tools — and how to test each one.',
$DOC$
MNUERON is a memory layer. It sits **beside** the AI tools you already use
(claude.ai, ChatGPT, Claude Desktop, Cursor, IDE plugins) rather than
inside any of them. You don't replace claude.ai or build a new chat box —
MNUERON injects the right memory into the AI you already use, at the
moment it's needed.

There are three ways that happens. Pick whichever fits the situation.

## The three pull modes

| Mode | Where it works | Who initiates | How memory arrives |
| --- | --- | --- | --- |
| **1. Manual recall** | claude.ai, chatgpt.com | You click | You search MNUERON, pick memories, click Inject — they prepend to the prompt box |
| **2. Ambient suggest** | claude.ai, chatgpt.com | You type | A floating strip surfaces relevant memories as you type; one click injects |
| **3. Agentic (MCP)** | Claude Desktop, Claude Code, Cursor | The AI itself | Claude calls `memory_recall` as a tool when it decides it needs context |

Modes 1 and 2 use the Chrome extension. Mode 3 uses the MNUERON MCP
server. You can use any combination — they don't conflict.

---

## Mode 1 — Manual recall (the easiest test)

Takes about 3 minutes to verify end-to-end.

### Setup

1. **Install the Chrome extension.** Either from the Chrome Web Store
   listing, or as an unpacked extension: `chrome://extensions/` → enable
   Developer mode → "Load unpacked" → point at the extension folder.
2. **Click the MNUERON icon** in your browser toolbar.
3. Switch the toggle to **Hosted mode**.
4. **Sign in** with your mnueron.com account.

### Save a memory to recall later

Go to https://mnueron.com/dashboard → click **+ New memory** → paste
something memorable, e.g.

> My favorite competitor-analysis framework is the Wedge: pick a product
> wedge older competitors can't copy because of architecture or business
> model lock-in.

Save.

### Test the recall loop

1. Open https://claude.ai in a new tab. Start any conversation.
2. Click the **MNUERON icon** in the toolbar to open the Recall panel.
3. Search for something from your memory (e.g. `competitor wedge`).
4. Click the result → **Inject into prompt**.
5. The text appears in claude.ai's prompt box, prefixed with a
   `Context from MNUERON:` block.
6. Type your follow-up question and send. Claude answers using the
   memory you injected.

That's the loop working end-to-end.

---

## Mode 2 — Ambient suggest

Like Mode 1 but passive — you don't click a button, MNUERON listens to
what you're typing and surfaces relevant memories above the prompt box.

### Setup

1. Open the MNUERON extension Options page (right-click the icon → Options).
2. Toggle **Ambient context** on.
3. Optional: pick a namespace scope (default: all).

### Test

1. Open https://claude.ai.
2. Start typing a question that relates to a memory you've saved.
3. A floating strip appears above the prompt box with 1–3 matching memories.
4. Click one → it injects.
5. Send.

If nothing appears, your saved memories may not be semantically close to
what you're typing. Try a query that quotes phrases from your memory's
content.

---

## Mode 3 — Agentic (MCP)

The most powerful mode. You don't click anything; Claude itself decides
when to query MNUERON. Works in Claude Desktop, Claude Code, Cursor, and
any other tool that supports the Model Context Protocol.

### Prerequisites

- Node.js 18+ on PATH
- A clone or install of MNUERON (`npm install -g mnueron`, or a local
  source checkout)
- A fresh API token from https://mnueron.com/account-settings/tokens
  named something like `claude-desktop-mcp`

### Configure Claude Desktop (Windows example)

Edit `%APPDATA%\Claude\claude_desktop_config.json`. If the file doesn't
exist, create it. Add the `mnueron` entry to `mcpServers`:

```json
{
  "mcpServers": {
    "mnueron": {
      "command": "node",
      "args": ["C:\\Mnueron\\Mnueron\\mnueron-v0.1.0\\mnueron\\dist\\index.js"],
      "env": {
        "MNUERON_API_URL": "https://www.mnueron.com",
        "MNUERON_API_TOKEN": "mnu_YOUR_FRESH_TOKEN"
      }
    }
  }
}
```

Replace the path with wherever MNUERON is built, and the token with the
one you just created.

If you installed via npm (`npm install -g mnueron`), you can simplify to:

```json
{
  "mcpServers": {
    "mnueron": {
      "command": "mnueron-mcp",
      "env": {
        "MNUERON_API_URL": "https://www.mnueron.com",
        "MNUERON_API_TOKEN": "mnu_YOUR_FRESH_TOKEN"
      }
    }
  }
}
```

### Mac / Linux paths

The config file lives at:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

The JSON contents are identical.

### Restart Claude Desktop

Important: **fully quit** Claude Desktop. Closing the window isn't enough
— right-click the system tray icon and choose Quit (or `Cmd+Q` on Mac).
Then relaunch.

### Verify the connection

In Claude Desktop, start a new conversation and ask:

> What tools do you have available right now?

You should see a list including `memory_save`, `memory_recall`,
`memory_get`, `memory_get_thread`, `memory_list`, `memory_delete`,
`memory_namespaces`, and `memory_import_chat`. Those are MNUERON's MCP
tools.

### Test the agentic loop

Save a clearly identifiable memory in your dashboard first, then ask
Claude in Desktop:

> What is my favorite competitor analysis framework?

Watch the response — you should see a tool-use indicator (an expandable
"Used memory_recall" block) where Claude calls the search, sees the
results, and then writes the answer using what it found.

That's Mode 3 working end-to-end. **No popup, no copy/paste — Claude just
knows.**

---

## How to know which mode to use when

- **Quick one-off:** Mode 1 (manual recall). You know what memory you want.
- **Browsing / drafting:** Mode 2 (ambient suggest). You don't know what's
  relevant yet but want to see options as you type.
- **Long-running agentic work** (coding sessions, research deep-dives,
  ongoing tasks): Mode 3 (MCP). The AI saves and recalls memory at the
  right moments without you context-switching.

Most users end up running all three: ambient suggest in browser chats,
MCP in their IDE, and manual recall when they want surgical control.

---

## Troubleshooting

| Symptom | Mode | Probable cause |
| --- | --- | --- |
| Extension icon is grey / dimmed | 1, 2 | Not signed in to Hosted mode. Click icon → Sign in. |
| Recall panel shows "0 results" | 1, 2 | Wrong namespace selected, or memory was saved to a different account. Check Options. |
| Ambient strip never appears | 2 | Toggle isn't on in Options, or the page's prompt textarea isn't on the supported selector list. |
| Claude lists no `memory_` tools | 3 | Config file in wrong location, JSON syntax error, or Claude Desktop wasn't fully quit before relaunch. |
| Tools list but every call returns "unauthorized" | 3 | Token is from local dev DB / was revoked / `MNUERON_API_URL` is missing. |
| `command not found: node` in the MCP server | 3 | Node isn't on PATH for the Claude Desktop process. Replace `"command": "node"` with the full path: `"C:\\Program Files\\nodejs\\node.exe"` |
| Server starts then dies | 3 | `npm run build` not run since last code change. |

---

## Privacy note

In **Local mode**, memories live on your machine in `~/.mnueron/memories.db`
and never leave. The Chrome extension can still capture from claude.ai
and chatgpt.com — but it writes to your local MCP server, not our hosted
backend.

In **Hosted mode**, memories live in MNUERON's Postgres on Vercel and are
scoped to your org. Row-level security policies prevent cross-tenant
access.

You can switch between modes anytime in the extension options — and
migrate your local data to hosted (or back) with `mnueron migrate`.
$DOC$,
       5, true
FROM doc_sections WHERE slug = 'getting-started'
ON CONFLICT (section_id, slug) DO UPDATE SET
  title       = EXCLUDED.title,
  description = EXCLUDED.description,
  content_md  = EXCLUDED.content_md,
  sort_order  = EXCLUDED.sort_order,
  published   = EXCLUDED.published,
  updated_at  = now();


-- ▲▲▲ MIGRATION 022 ABOVE ▲▲▲
-- ─────────────────────────────────────────────────────────────────────────────
-- ▼▼▼ MIGRATION 023 BELOW ▼▼▼

-- =============================================================================
-- mnueron docs — TypeScript SDK page + sidebar/everything-page fixes
--
-- Closes the gap from migration 006: that migration only published
-- /docs/sdks/python and /docs/sdks/dotnet, but the TypeScript SDK
-- (@mnueron/sdk) has since shipped to npm and had no doc page.
--
-- This migration:
--   1. Updates the SDKs section description to include TypeScript
--   2. Adds a new /docs/sdks/typescript page mirrored on the SDK's README
--   3. Bumps the Python + .NET sort_order so TypeScript can slot in at 15
--      (between overview=10 and python=20)
--   4. Removes the stale "publish pending" / "code ready" phrases from
--      /docs/reference/everything now that npm + PyPI are both live
--
-- Uses $TS$ outer dollar-quote so the page body can embed ```ts fences,
-- backticks, dollar signs, and embedded $md$ from migration 006 without
-- conflict. Idempotent via ON CONFLICT (section_id, slug) DO UPDATE.
--
-- HOW TO APPLY: Supabase SQL Editor → toggle Enforce RLS OFF → paste → Run.
-- =============================================================================

-- ── 1. Section description: list all three SDKs ──────────────────────────
UPDATE doc_sections
   SET description = 'Official client libraries for TypeScript, Python, and .NET / C#.',
       updated_at  = now()
 WHERE slug = 'sdks';

-- ── 2. New TypeScript SDK page ───────────────────────────────────────────
INSERT INTO doc_pages (section_id, slug, title, description, sort_order, published, content_md)
SELECT id, 'typescript', 'TypeScript SDK',
       'npm install @mnueron/sdk — Node, Deno, Bun, Workers, browsers.',
       15, true,
$TS$
The TypeScript SDK is the lightest way to use mnueron from any JS
runtime. Zero runtime dependencies, dual ESM + CommonJS builds, works
in Node 18+, Deno, Bun, Cloudflare Workers, and browsers (CORS
permitting).

## Install

```bash
npm install @mnueron/sdk
```

## Quick start

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

Set the env var once and the constructor picks it up automatically:

```bash
export MNUERON_API_KEY=mnu_xxxxxxxxxxxxxxxxxxxxx
# Optional — default is https://www.mnueron.com
export MNUERON_API_URL=https://www.mnueron.com
```

```ts
const m = new Mnueron();   // reads env
```

## Date + metadata filters

Date values are epoch milliseconds. `metadata_filter` is passed to
Postgres' `@>` jsonb containment operator.

```ts
const yesterday = Date.now() - 24 * 60 * 60 * 1000;
const recent = await m.list({
  namespace: 'my-app',
  created_after: yesterday,
  metadata_filter: { speaker: 'sarah' },
});
```

## Bulk search

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

## Webhooks

Register a delivery endpoint:

```ts
const hook = await m.createWebhook('https://example.com/mnueron-hook', {
  events: ['memory.saved', 'memory.deleted'],
  description: 'forward saves into our event bus',
});
console.log('Store this once — won\'t appear again:', hook.secret);
```

Verify incoming deliveries — works in Node, Workers, Deno, Bun. The
verifier uses Node's `node:crypto` when available and falls back to
Web Crypto everywhere else, so the same code runs in any runtime.

```ts
import { verifyWebhookSignature } from '@mnueron/sdk';

// Express
app.post('/mnueron-hook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.header('X-Mnueron-Signature');
    const ok = await verifyWebhookSignature(secret, req.body, sig);
    if (!ok) return res.status(401).end();
    // ... handle payload
    res.status(200).end();
  },
);

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

## Combine with an LLM client

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

## Edge runtimes

The SDK is bundler-friendly and ships no Node-only code in the import
path. It runs unmodified in:

- Cloudflare Workers
- Vercel Edge Functions
- Deno Deploy
- Bun's edge-style handlers
- Modern browsers (set `apiKey` explicitly — no `process.env` there)

## API reference

| Method | Returns | Notes |
| --- | --- | --- |
| `save(content, opts?)` | `Memory` | Single insert. Fires `memory.saved` webhooks. |
| `search(query, opts?)` | `Memory[]` | BM25 search with stacking filters. |
| `bulkSearch(queries, opts?)` | `BulkSearchResult[]` | Up to 25 queries per batch. |
| `list(opts?)` | `Memory[]` | Newest-first; supports date + metadata filters. |
| `get(id)` | `Memory \| null` | Returns null on 404. |
| `update(id, patch)` | `Memory` | Partial; `metadata` is merged. |
| `delete(id)` | `void` | Fires `memory.deleted` webhooks. |
| `namespaces()` | `string[]` | All namespaces in your org. |
| `health()` | `{ ok: true }` | Liveness probe. |
| `listWebhooks()` / `createWebhook()` / `getWebhook()` / `updateWebhook()` / `deleteWebhook()` | — | Full CRUD over webhook subscriptions. |
| `verifyWebhookSignature(secret, body, sigHeader)` | `Promise<boolean>` | Constant-time HMAC-SHA256 check. Exported as a standalone function too. |

Throws a typed `MnueronError` on non-2xx responses with the server's
error message attached.

## Source

[github.com/randi2160/mnueron/tree/main/sdks/typescript](https://github.com/randi2160/mnueron/tree/main/sdks/typescript)
$TS$
FROM doc_sections WHERE slug = 'sdks'
ON CONFLICT (section_id, slug) DO UPDATE SET
  title       = EXCLUDED.title,
  description = EXCLUDED.description,
  content_md  = EXCLUDED.content_md,
  sort_order  = EXCLUDED.sort_order,
  published   = EXCLUDED.published,
  updated_at  = now();

-- ── 3. Update overview page: add TypeScript row + correct env var name ───
UPDATE doc_pages SET content_md = $OV$
mnueron ships three official client libraries that wrap the hosted
REST API:

| Language | Install | Source |
| --- | --- | --- |
| TypeScript (Node 18+, Deno, Bun, Workers, browsers) | `npm install @mnueron/sdk` | [sdks/typescript](https://github.com/randi2160/mnueron/tree/main/sdks/typescript) |
| Python (3.9+) | `pip install mnueron` | [sdks/python](https://github.com/randi2160/mnueron/tree/main/sdks/python) |
| .NET / C# (6+) | Drop [`MnueronClient.cs`](https://github.com/randi2160/mnueron/blob/main/sdks/csharp/MnueronClient.cs) into any project | Single-file, no NuGet |

All three speak the same REST surface as the MCP server and the Chrome
extension, so mixing clients in one project is fine — they all read
and write the same Postgres rows under your org.

## When NOT to use the SDKs

If you only want **local, free, no-account** memory for Claude Desktop,
Cursor, Windsurf, Cline, etc., you don't need an SDK at all. Install
the CLI from npm and let `mnueron setup` wire MCP into your tools:

```bash
npm install -g mnueron
mnueron setup
```

The SDKs are for **building your own apps** that read/write mnueron
memory programmatically — e.g. a meeting-notes recorder, a CRM
enrichment job, a custom Slack bot, a backend that captures user
preferences across sessions.

## What's covered

All three SDKs expose the same methods:

- `save` / `search` / `list` / `get` / `update` / `delete`
- `bulkSearch` / `bulk_search` — up to 25 queries in one HTTP round-trip
- Date filters on search + list (`created_after`, `created_before`, `updated_after`, `updated_before`) — epoch ms
- `metadata_filter` — JSON containment on the `metadata` jsonb column
- `namespaces` + `health`
- Webhook CRUD: `listWebhooks` / `createWebhook` / `getWebhook` / `updateWebhook` / `deleteWebhook`
- `verifyWebhookSignature` — constant-time HMAC-SHA256 check for incoming deliveries

All raise / throw a typed `MnueronError` / `MnueronException` on
non-2xx responses with the server's error message attached.

## Auth

Grab a token at [/account-settings/tokens](/account-settings/tokens).
Set it once via env var and every SDK will pick it up automatically:

```bash
export MNUERON_API_KEY=mnu_xxxxxxxxxxxxxxxxxxxxx
```

Pick a language below for end-to-end examples.
$OV$,
updated_at = now()
WHERE section_id = (SELECT id FROM doc_sections WHERE slug = 'sdks')
  AND slug = 'overview';

-- ── 4. Strip stale "publish pending" / "code ready" lines from kitchen-sink ──
UPDATE doc_pages SET
  content_md = REPLACE(
    REPLACE(
      REPLACE(
        content_md,
        '`npm install @mnueron/sdk` (publish pending)',
        '`npm install @mnueron/sdk` (live on npm as 0.3.1)'
      ),
      'TypeScript SDK published to npm (code ready)',
      'TypeScript SDK live on npm as @mnueron/sdk'
    ),
    '(publish pending)',
    '(live)'
  ),
  updated_at = now()
WHERE section_id = (SELECT id FROM doc_sections WHERE slug = 'reference')
  AND slug = 'everything';

-- ▲▲▲ MIGRATION 023 ABOVE ▲▲▲
