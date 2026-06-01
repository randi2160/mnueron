/**
 * Memory benchmark entry point. Ingests LoCoMo conversations into mnueron,
 * runs each QA pair through retrieval + answer-gen + LLM judge, prints a
 * scorecard.
 *
 * Usage:
 *   npm run benchmark                          # full LoCoMo10 (~$10 on gpt-4o-mini)
 *   npm run benchmark:smoke                    # tiny fixture, real LocalProvider, no API key
 *   npm run benchmark -- --stub                # stub provider (in-memory) for harness validation
 *   npm run benchmark -- --limit 20            # cap QA per sample for cost control
 *   npm run benchmark -- --k 20                # retrieval depth (default 20)
 *   npm run benchmark -- --k 10 --token-budget 2000
 *                                                # cheaper retrieval profile
 *   npm run benchmark -- --ingestion turns     # per-turn memories (previous baseline)
 *   npm run benchmark -- --ingestion windows   # rolling 5-turn windows (default)
 *   npm run benchmark -- --ingestion both      # save both kinds
 *   npm run benchmark -- --window-size 10      # change window size
 *   npm run benchmark -- --judge gpt-4o        # stronger judge (now the default)
 *   npm run benchmark -- --no-rerank           # ablate: disable cross-encoder rerank
 *   npm run benchmark -- --no-speaker-boost    # ablate: disable speaker boost
 *   npm run benchmark -- --no-temporal-sort    # ablate: disable temporal chronological sort
 *
 * Env:
 *   OPENAI_API_KEY    required for non-stub graded runs
 *   LOCOMO_PATH       override dataset location
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MnueronAdapter } from './adapter.js';
import { loadLoComo10, sessionsInOrder, LoComoSample } from './datasets.js';
import { generateAnswer, judgeAnswer } from './judge.js';

interface CliArgs {
  smoke: boolean;
  stub: boolean;
  limit?: number;
  k: number;
  judgeModel: string;
  answerModel: string;
  datasetPath: string;
  ingestion: 'turns' | 'windows' | 'both';
  windowSize: number;
  rerank: boolean;
  speakerBoost: boolean;
  temporalSort: boolean;
  neighborRadius?: number;
  tokenBudget?: number;
  rerankChars?: number;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const out: CliArgs = {
    smoke: false,
    stub: false,
    k: 20,            // balanced default: enough breadth for multi-hop/temporal without Mem0-sized context
    judgeModel: 'gpt-4o',         // stronger judge — neutralizes mini-judging-mini leniency
    answerModel: 'gpt-4o-mini',   // product-realistic — most users won't pay for 4o on every answer
    datasetPath: process.env.LOCOMO_PATH ?? 'scripts/benchmark/data/locomo10.json',
    ingestion: 'windows',
    windowSize: 5,
    rerank: true,
    speakerBoost: true,
    temporalSort: true,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--smoke') out.smoke = true;
    else if (a === '--stub') { out.stub = true; out.smoke = true; }
    else if (a === '--limit') out.limit = parseInt(args[++i], 10);
    else if (a === '--k') out.k = parseInt(args[++i], 10);
    else if (a === '--judge') out.judgeModel = args[++i];
    else if (a === '--answer') out.answerModel = args[++i];
    else if (a === '--dataset') out.datasetPath = args[++i];
    else if (a === '--ingestion') {
      const v = args[++i];
      if (v === 'turns' || v === 'windows' || v === 'both') out.ingestion = v;
      else throw new Error(`--ingestion must be turns | windows | both, got ${v}`);
    }
    else if (a === '--window-size') out.windowSize = parseInt(args[++i], 10);
    else if (a === '--no-rerank') out.rerank = false;
    else if (a === '--no-speaker-boost') out.speakerBoost = false;
    else if (a === '--no-temporal-sort') out.temporalSort = false;
    else if (a === '--neighbor-radius') out.neighborRadius = parseInt(args[++i], 10);
    else if (a === '--token-budget') out.tokenBudget = parseInt(args[++i], 10);
    else if (a === '--rerank-chars') out.rerankChars = parseInt(args[++i], 10);
  }
  if (out.smoke && !process.env.LOCOMO_PATH) {
    out.datasetPath = 'scripts/benchmark/sample/tiny-conversation.json';
  }
  return out;
}

interface QAResult {
  question: string;
  category: number;
  gold: string;
  predicted: string;
  score: number;
  reasoning: string;
  retrievalLatencyMs: number;
  tokensRetrieved: number;
}

async function runSample(sample: LoComoSample, args: CliArgs): Promise<QAResult[]> {
  const dbDir = mkdtempSync(join(tmpdir(), 'mnueron-bench-'));
  const dbPath = join(dbDir, 'bench.db');
  const speakers = args.speakerBoost
    ? [sample.speaker_a, sample.speaker_b].filter((s): s is string => typeof s === 'string' && s.length > 0)
    : [];
  const adapter = new MnueronAdapter({
    dbPath,
    namespacePrefix: 'locomo',
    useStub: args.stub,
    ingestionMode: args.ingestion,
    windowSize: args.windowSize,
    rerank: args.rerank,
    speakers,
    temporalSort: args.temporalSort,
    neighborRadius: args.neighborRadius,
    tokenBudget: args.tokenBudget,
    rerankChars: args.rerankChars,
  });
  const userId = sample.sample_id;

  let saved = 0;
  for (const [sessionKey, sessionTurns, sessionTs] of sessionsInOrder(sample)) {
    const idx = parseInt(sessionKey.replace('session_', ''), 10);
    const messages = sessionTurns.map(t => ({
      speaker: t.speaker,
      text: t.text,
      timestamp: sessionTs,
      session_idx: idx,
      dia_id: t.dia_id,
    }));
    saved += await adapter.add(messages, userId);
  }
  console.log(`  ingested ${saved} memories across ${Object.keys(sample.sessions).length} sessions`);

  const qa = args.limit ? sample.qa.slice(0, args.limit) : sample.qa;
  const results: QAResult[] = [];
  for (let i = 0; i < qa.length; i++) {
    const q = qa[i];
    const t0 = Date.now();
    const retrieved = await adapter.search(q.question, userId, args.k);
    const retrievalLatencyMs = Date.now() - t0;
    const tokensRetrieved = retrieved.reduce((sum, h) => sum + h.content.length / 4, 0);
    // Current-date anchor for temporal questions: the latest timestamp in the retrieved set.
    // This gives the LLM an explicit "now" to compute deltas against.
    const latestTs = retrieved.reduce<number>((max, h) => {
      const t = h.timestamp ? Date.parse(h.timestamp) : NaN;
      return Number.isFinite(t) && t > max ? t : max;
    }, 0);
    const currentDate = latestTs > 0 ? new Date(latestTs).toISOString().slice(0, 10) : undefined;
    const predicted = await generateAnswer(q.question, retrieved, args.answerModel, currentDate);
    const judged = await judgeAnswer(q.question, q.answer, predicted, args.judgeModel);
    results.push({
      question: q.question,
      category: q.category,
      gold: q.answer,
      predicted,
      score: judged.score,
      reasoning: judged.reasoning,
      retrievalLatencyMs,
      tokensRetrieved: Math.round(tokensRetrieved),
    });
  }
  await adapter.close();
  return results;
}

function scorecard(all: QAResult[]): void {
  const total = all.reduce((s, r) => s + r.score, 0);
  const avg = total / all.length;
  const byCategory = new Map<number, { sum: number; n: number }>();
  for (const r of all) {
    const bucket = byCategory.get(r.category) ?? { sum: 0, n: 0 };
    bucket.sum += r.score;
    bucket.n += 1;
    byCategory.set(r.category, bucket);
  }
  const catNames: Record<number, string> = {
    1: 'single-hop', 2: 'multi-hop', 3: 'temporal',
    4: 'commonsense', 5: 'adversarial',
  };
  const avgLatency = all.reduce((s, r) => s + r.retrievalLatencyMs, 0) / all.length;
  const avgTokens = all.reduce((s, r) => s + r.tokensRetrieved, 0) / all.length;

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  LoCoMo scorecard — mnueron');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`  Overall (LLM judge):     ${(avg * 100).toFixed(2)}%  (n=${all.length})`);
  console.log(`  Avg retrieval latency:   ${avgLatency.toFixed(1)} ms`);
  console.log(`  Avg tokens retrieved:    ${avgTokens.toFixed(0)}`);
  console.log('  ────────────────────────────────────────────────');
  for (const [cat, { sum, n }] of Array.from(byCategory.entries()).sort()) {
    const pct = (sum / n) * 100;
    console.log(`  ${(catNames[cat] ?? `cat ${cat}`).padEnd(14)} ${pct.toFixed(2)}%  (n=${n})`);
  }
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  Reference scores (independent runs vary by judge/model/seed):');
  console.log('  Mem0 (Apr 2026):    92.5%   ~7,000 tokens/query');
  console.log('  Zep:                ~94%');
  console.log('  Letta Filesystem:   74.0%');
  console.log('══════════════════════════════════════════════════════════════\n');
}

async function main(): Promise<void> {
  const args = parseArgs();
  console.log('\nmnueron memory benchmark');
  console.log(`  provider:       ${args.stub ? 'STUB' : 'LocalProvider (real mnueron)'}`);
  console.log(`  mode:           ${args.smoke ? 'SMOKE' : 'FULL (LoCoMo10)'}`);
  console.log(`  dataset:        ${args.datasetPath}`);
  console.log(`  retrieval k:    ${args.k}`);
  console.log(`  neighbor radius: ${args.neighborRadius ?? 'adapter default'}`);
  console.log(`  token budget:   ${args.tokenBudget ?? 'adapter default'}`);
  console.log(`  rerank chars:   ${args.rerankChars ?? 'adapter default'}`);
  console.log(`  rerank:         ${args.rerank ? 'on (cross-encoder, 2x oversample)' : 'off'}`);
  console.log(`  speaker boost:  ${args.speakerBoost ? 'on (1.4x for named speakers)' : 'off'}`);
  console.log(`  temporal sort:  ${args.temporalSort ? 'on (chronological re-sort on temporal queries)' : 'off'}`);
  console.log(`  ingestion:      ${args.ingestion}${args.ingestion !== 'turns' ? ` (window=${args.windowSize})` : ''}`);
  console.log(`  answer model:   ${args.answerModel}`);
  console.log(`  judge model:    ${args.judgeModel}`);
  console.log(`  api key:        ${process.env.OPENAI_API_KEY ? '✓' : '✗ (stub)'}`);
  console.log('');
  const samples = loadLoComo10(args.datasetPath);
  console.log(`Loaded ${samples.length} conversation(s) from ${args.datasetPath}\n`);
  const all: QAResult[] = [];
  for (const s of samples) {
    console.log(`Sample ${s.sample_id} (${s.speaker_a} & ${s.speaker_b})`);
    const results = await runSample(s, args);
    all.push(...results);
  }
  scorecard(all);
}

main().catch(e => {
  console.error('\nFATAL:', e?.stack ?? e);
  process.exit(1);
});
