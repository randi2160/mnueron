# How to actually run the benchmark

This is the operational quickstart. For the *what and why* — methodology,
references, caveats — read `README.md` first.

## What just got scaffolded

| Path | Purpose |
| --- | --- |
| `scripts/benchmark/adapter.ts` | Wraps mnueron's `LocalProvider` in `add()` + `search()` |
| `scripts/benchmark/datasets.ts` | LoCoMo JSON loader + chronological session iterator |
| `scripts/benchmark/judge.ts` | OpenAI answer-gen + LLM-as-judge (falls back to stubs without an API key) |
| `scripts/benchmark/stub-provider.ts` | In-memory provider for harness validation |
| `scripts/benchmark/run.ts` | CLI entry — prints scorecard |
| `scripts/benchmark/sample/tiny-conversation.json` | 2-session fixture for stub smoke |
| `scripts/benchmark/README.md` | Methodology + references + caveats |

Three npm scripts now exist:
- `npm run benchmark` — full LoCoMo, real mnueron, real OpenAI judge
- `npm run benchmark:smoke` — tiny fixture, real mnueron, stubbed judge
- `npm run benchmark:stub` — tiny fixture, **stub** mnueron, stubbed judge

## Step 0 — Sanity check (~10 sec, $0)

Run this first to prove the harness loop works on your machine regardless
of native modules:

```bash
npm run benchmark:stub
```

Expected output: a scorecard showing 6 QA results, ~30-50% overall on
the tiny fixture. The number itself is meaningless (stub provider, stub
judge) — what you're checking is that the pipeline runs cleanly with no
errors. If you see a scorecard, every wire in the harness is connected.

I already ran this in the sandbox; it passes.

## Step 1 — Real-mnueron smoke (~30 sec, $0)

```bash
npm install              # if you haven't already
npm run build
npm run benchmark:smoke  # uses real LocalProvider on the tiny fixture
```

This uses the actual hybrid FTS5 + sqlite-vec recall path against the
6-question fixture. Still no OpenAI cost (answer-gen and judge fall back
to stubs without an API key). Expected: 50-80% on the fixture — real
mnueron should crush this tiny dataset.

If the build fails on Windows with a native-module error, run:

```bash
npm rebuild better-sqlite3 --build-from-source
```

## Step 2 — Download LoCoMo (~5 sec, 2.7 MB)

```bash
mkdir -p scripts/benchmark/data
curl -L -o scripts/benchmark/data/locomo10.json \
  https://github.com/snap-research/locomo/raw/refs/heads/main/data/locomo10.json
```

Verify:

```bash
node -e "const d=JSON.parse(require('fs').readFileSync('scripts/benchmark/data/locomo10.json','utf8')); console.log('samples:', d.length, '— first speakers:', d[0].conversation.speaker_a, '+', d[0].conversation.speaker_b)"
```

Should print `samples: 10 — first speakers: <name_a> + <name_b>`.

## Step 3 — Dev-iteration run (~$0.50)

Before paying for a full run, validate cost shape and one sample's worth
of scores:

```bash
export OPENAI_API_KEY=sk-...           # PowerShell: $env:OPENAI_API_KEY="sk-..."
npm run benchmark -- --limit 20        # 20 QA per sample × 10 samples = 200 graded queries
```

Cost: ~$0.30 - $0.80 on gpt-4o-mini. Time: ~3-5 min.

If category-level numbers look sane (single-hop > multi-hop, adversarial
non-zero meaning some abstentions register correctly), you're good for a
full run.

## Step 4 — Full LoCoMo run (~$10-15)

```bash
npm run benchmark
```

Cost: ~$10-15 on gpt-4o-mini × gpt-4o-mini.  Time: ~30-45 min.

For the headline-publishable number, mirror Mem0's paper config:

```bash
npm run benchmark -- --answer gpt-4o --judge gpt-4o
```

Cost: ~$150-200. Time: same. Don't run this until you've validated the
shape on `gpt-4o-mini` and are confident no obvious bugs remain.

## Step 5 — Save the scorecard

The scorecard prints to stdout. Capture it:

```bash
npm run benchmark > results-$(date +%Y-%m-%d).txt
```

Include in the saved file: mnueron git SHA, dataset hash, judge prompt
(`cat scripts/benchmark/judge.ts | grep -A 8 "You are scoring"`), and
the LLM models used. This is the minimum to make scores reproducible.

## Step 6 — Submit to AMB (optional)

[AMB](https://github.com/vectorize-io/agent-memory-benchmark) is the
neutral leaderboard. Their submission format expects a Python `MemoryBackend`
subclass — porting `adapter.ts` to Python is ~50 LOC and the call surface
is identical. PR target: their `submissions/` directory with your
`adapter.py`, results file, and a `RESULTS.md`.

I'll write the Python port and the AMB PR scaffold as a follow-up if you
want — say the word.

## What I expect mnueron to score (my prediction before we run)

Honest read of mnueron's architecture vs the field:

- **Single-hop**: 85-92%. Hybrid BM25 + cosine should crush direct-recall
  questions. If you're below 85% here, something is wrong with the
  ingestion (likely metadata not being indexed).
- **Multi-hop**: 65-78%. Mnueron returns ranked memories but doesn't
  synthesize across them — the answer-gen LLM does that. Mem0's
  knowledge-graph approach has an edge here.
- **Temporal**: 55-72%. This is the biggest risk. The metadata.timestamp
  approach round-trips the dialog timestamp but mnueron's recall ranking
  doesn't use it. If a temporal question can be answered from one
  memory's content alone, we'll do fine; if it requires comparing
  timestamps across memories, expect drops.
- **Commonsense**: 80-90%. Largely depends on the answer-gen LLM, less on
  retrieval. Should look similar to Mem0.
- **Adversarial**: 60-85%. Depends entirely on how strict the answer-gen
  prompt is about "NO_ANSWER". Our prompt is strict.
- **Overall**: 75-85% on first run, room to climb to 87-91% with prompt
  iteration. Mem0's 92.5% is reachable but probably needs a second
  pass tuning the answer-gen prompt and possibly adding a simple
  metadata.timestamp filter for temporal queries.

The number to feel best about, regardless of where we land on accuracy:
**avg tokens retrieved**. mnueron has no LLM in the recall path — should
be 600-1200 tokens vs Mem0's ~7,000. That's the column where the
local-first story is structurally unbeatable.
