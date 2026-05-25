# mnueron memory benchmark harness

Plug mnueron into the same evaluation methodology Mem0, Zep, and Letta
publish their scores against — primarily the
[LoCoMo](https://github.com/snap-research/locomo) long-conversation memory
benchmark, and (coming) [LongMemEval](https://github.com/xiaowu0162/longmemeval).

This is a self-contained TypeScript harness that uses mnueron's
`LocalProvider` directly — no MCP subprocess overhead, full access to
search scores, and no patches to mnueron itself required.

## Quick start (no API key needed)

```bash
npm install
npm run build
npm run benchmark:smoke
```

Smoke mode uses a tiny 2-session fixture, a stub LLM judge (case-insensitive
keyword overlap), and verifies the whole pipeline runs end-to-end. Total
time: ~5 seconds. Total cost: $0.

If the smoke run prints a scorecard with non-zero hits, the adapter is
wired correctly.

## Full LoCoMo run

```bash
# 1. Download the dataset (~2.7 MB)
mkdir -p scripts/benchmark/data
curl -L -o scripts/benchmark/data/locomo10.json \
  https://github.com/snap-research/locomo/raw/refs/heads/main/data/locomo10.json

# 2. Set your OpenAI key (for answer-gen + LLM judge)
export OPENAI_API_KEY=sk-...

# 3. Run
npm run benchmark
```

Optional flags:

```bash
npm run benchmark -- --k 20            # retrieval depth (default 10)
npm run benchmark -- --limit 50        # cap QA per sample for cost control
npm run benchmark -- --judge gpt-4o    # stronger judge (~10x cost)
npm run benchmark -- --answer gpt-4o   # stronger answerer
npm run benchmark -- --dataset path/to/longmemeval.json   # different dataset
```

## Environment — disable entity extraction before benchmarking

**Always run the benchmark with entity extraction off.** This is the single
most important configuration detail and it is not the production default.

```powershell
# PowerShell (Windows)
$env:MNUERON_ENABLE_ENTITY_EXTRACTION = "false"
```

```bash
# bash / zsh
export MNUERON_ENABLE_ENTITY_EXTRACTION=false
```

Why this matters: when entity extraction is enabled, every memory save
above ~200 chars triggers a gpt-4o-mini call to extract people / projects /
technologies / decisions from the text. The benchmark adapter ingests
~700 memories per conversation × 10 conversations = ~7,000 extraction
calls per full run, none of which the benchmark adapter reads back. The
adapter retrieves via BM25 + sqlite-vec only — it never touches the
entity graph.

Leaving entity extraction on during a benchmark therefore:

- Burns ~7,000 LLM calls of irrelevant cost (in addition to the ~3,000
  answer-gen + judge calls the benchmark legitimately needs).
- Drives users into OpenAI's daily rate-limit cliff (RPD: 10,000 on
  Tier 1) mid-run, causing 429 storms and a `FATAL` exit.
- Adds non-deterministic write-path latency to ingestion, polluting any
  comparison of mnueron's retrieval latency against other systems.
- Makes the published numbers incomparable across contributor machines
  (whoever has entity extraction on gets a different ingestion time).

The benchmark's `MnueronAdapter` does *not* override this env var, on
purpose — production code paths share the same gate, and we don't want
the benchmark harness silently masking what a real user would experience.
Set the env var explicitly before each run.

If you do hit a 429 anyway (concurrent CLI work, leftover key usage from
earlier in the day), mnueron's entity extractor now ships with a
process-wide circuit breaker that auto-suspends extraction for the
cooldown window after the first 429. Saves continue with no entity
tags. See `src/store/entity-extractor.ts` for the cooldown logic.

## Cost estimate

Per full LoCoMo run (10 conversations, ~1,540 QA pairs total):

| Mode | Answer model | Judge model | Approx cost |
|---|---|---|---|
| Default | gpt-4o-mini | gpt-4o-mini | **~$10–15** |
| Mem0 paper config | gpt-4o | gpt-4o | ~$150–200 |
| Cheap dev iteration | --limit 50 | gpt-4o-mini | <$1 |

Mnueron contributes no LLM cost to recall itself (hybrid FTS5 + sqlite-vec
runs locally, no embedding API calls). The full cost is the answer-gen and
judge passes on the retrieved memories.

## What the scorecard reports

```
══════════════════════════════════════════════════════════════
  LoCoMo scorecard — mnueron
══════════════════════════════════════════════════════════════
  Overall (LLM judge):     XX.XX%  (n=1540)
  Avg retrieval latency:   XX.X ms
  Avg tokens retrieved:    XXXX
  ────────────────────────────────────────────────
  single-hop      XX.XX%  (n=...)
  multi-hop       XX.XX%  (n=...)
  temporal        XX.XX%  (n=...)
  commonsense     XX.XX%  (n=...)
  adversarial     XX.XX%  (n=...)
══════════════════════════════════════════════════════════════
  Mem0 reference (Apr 2026): 92.5%  ~7,000 tokens/query
  Zep reference:             ~94%
  Letta Filesystem baseline: 74.0%
══════════════════════════════════════════════════════════════
```

Mnueron's structural advantage is the "Avg tokens retrieved" column.
Mem0 averages ~7k tokens per query (multiple LLM passes + 729-token
chain-of-thought prompt); local SQLite hybrid recall is just the content
of the retrieved memories, no LLM in the loop. At equal accuracy that's
a ~50–100× cost advantage worth reporting independently.

## Important caveats (read before publishing numbers)

1. **LoCoMo's answer key is contested.** The
   [Penfield Labs audit](https://github.com/dial481/locomo-audit) found
   **6.4% of answers are wrong** and the standard LLM-judge **accepts up to
   63% of intentionally-bad answers**. Take any LoCoMo score as a band, not
   a point estimate. Publishing your judge prompt + model + seed alongside
   the number is the new norm; this harness writes them into the scorecard.

2. **Compare apples to apples.** Mem0's published 92.5% used `gpt-4o` as
   both answerer and judge. Running mnueron on `gpt-4o-mini` will produce
   a lower number that doesn't actually mean lower memory quality —
   it's a smaller LLM answering. Use `--answer gpt-4o --judge gpt-4o` for
   any number you intend to publish.

3. **The temporal category needs `metadata.timestamp` to round-trip.**
   The adapter passes LoCoMo's synthetic dialog timestamp through
   `metadata.timestamp`. The answer-gen prompt instructs the LLM to read
   timestamps from parenthesized prefixes. If mnueron ever drops metadata
   on save, temporal scores will collapse — that's the canary for any
   regression in this column.
