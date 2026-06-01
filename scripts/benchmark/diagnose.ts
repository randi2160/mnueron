/**
 * Retrieval-only LoCoMo diagnostic.
 *
 * This avoids answer-generation and judge cost. It ingests one LoCoMo sample,
 * runs retrieval, and reports whether retrieved turns/windows overlap the
 * dataset evidence ids. Use it before changing prompts or model choices.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MnueronAdapter, type BenchHit } from './adapter.js';
import { loadLoComo10, sessionsInOrder } from './datasets.js';

interface Args {
  datasetPath: string;
  sample: number;
  limit: number;
  k: number;
  rerank: boolean;
  neighborRadius?: number;
  tokenBudget?: number;
  rerankChars?: number;
}

function parseArgs(): Args {
  const raw = process.argv.slice(2);
  const out: Args = {
    datasetPath: process.env.LOCOMO_PATH ?? 'scripts/benchmark/data/locomo10.json',
    sample: 0,
    limit: 10,
    k: 20,
    rerank: false,
  };
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === '--dataset') out.datasetPath = raw[++i];
    else if (a === '--sample') out.sample = parseInt(raw[++i], 10);
    else if (a === '--limit') out.limit = parseInt(raw[++i], 10);
    else if (a === '--k') out.k = parseInt(raw[++i], 10);
    else if (a === '--rerank') out.rerank = true;
    else if (a === '--no-rerank') out.rerank = false;
    else if (a === '--neighbor-radius') out.neighborRadius = parseInt(raw[++i], 10);
    else if (a === '--token-budget') out.tokenBudget = parseInt(raw[++i], 10);
    else if (a === '--rerank-chars') out.rerankChars = parseInt(raw[++i], 10);
  }
  return out;
}

function diaNumber(id: string | undefined): number | null {
  const m = /^D\d+:(\d+)$/.exec(id ?? '');
  return m ? parseInt(m[1], 10) : null;
}

function sameSession(a: string | undefined, b: string | undefined): boolean {
  const ma = /^(D\d+):/.exec(a ?? '');
  const mb = /^(D\d+):/.exec(b ?? '');
  return !!ma && !!mb && ma[1] === mb[1];
}

function hitCoversEvidence(hit: BenchHit, evidenceId: string): boolean {
  if (hit.dia_id) return hit.dia_id === evidenceId;
  if (!hit.window_start_dia || !hit.window_end_dia) return false;
  if (!sameSession(hit.window_start_dia, evidenceId)) return false;
  const start = diaNumber(hit.window_start_dia);
  const end = diaNumber(hit.window_end_dia);
  const ev = diaNumber(evidenceId);
  return start != null && end != null && ev != null && ev >= start && ev <= end;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const samples = loadLoComo10(args.datasetPath);
  const sample = samples[args.sample];
  if (!sample) throw new Error(`No sample at index ${args.sample}`);

  const dbDir = mkdtempSync(join(tmpdir(), 'mnueron-bench-diag-'));
  const adapter = new MnueronAdapter({
    dbPath: join(dbDir, 'diag.db'),
    namespacePrefix: 'locomo-diag',
    ingestionMode: 'windows',
    windowSize: 5,
    rerank: args.rerank,
    speakers: [sample.speaker_a, sample.speaker_b].filter(Boolean),
    temporalSort: true,
    neighborRadius: args.neighborRadius,
    tokenBudget: args.tokenBudget,
    rerankChars: args.rerankChars,
  });

  let saved = 0;
  for (const [sessionKey, sessionTurns, sessionTs] of sessionsInOrder(sample)) {
    const idx = parseInt(sessionKey.replace('session_', ''), 10);
    saved += await adapter.add(
      sessionTurns.map(t => ({
        speaker: t.speaker,
        text: t.text,
        timestamp: sessionTs,
        session_idx: idx,
        dia_id: t.dia_id,
      })),
      sample.sample_id,
    );
  }

  console.log(`diagnose sample=${sample.sample_id} saved=${saved} k=${args.k} rerank=${args.rerank}`);
  const qa = sample.qa.slice(0, args.limit);
  let covered = 0;
  for (let i = 0; i < qa.length; i++) {
    const q = qa[i];
    const hits = await adapter.search(q.question, sample.sample_id, args.k);
    const evidence = q.evidence ?? [];
    const matched = evidence.filter(ev => hits.some(h => hitCoversEvidence(h, ev)));
    if (evidence.length > 0 && matched.length === evidence.length) covered++;
    console.log(`\n#${i + 1} cat=${q.category} ${matched.length}/${evidence.length} evidence`);
    console.log(`Q: ${q.question}`);
    console.log(`Gold: ${q.answer}`);
    console.log(`Evidence: ${evidence.join(', ') || '(none)'}`);
    console.log(`Matched: ${matched.join(', ') || '(none)'}`);
    for (const h of hits.slice(0, 6)) {
      const span = h.dia_id ?? `${h.window_start_dia ?? '?'}~${h.window_end_dia ?? '?'}`;
      console.log(`  - ${span} score=${h.score.toFixed(4)} ${h.timestamp ?? ''}`);
      console.log(`    ${h.content.replace(/\s+/g, ' ').slice(0, 180)}`);
    }
  }

  console.log(`\nEvidence coverage: ${covered}/${qa.filter(q => q.evidence?.length).length}`);
  await adapter.close();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
