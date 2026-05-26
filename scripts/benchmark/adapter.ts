/**
 * mnueron adapter for memory benchmarks (LoCoMo, LongMemEval, etc.)
 *
 * Wraps mnueron's LocalProvider in the two-method interface the Mem0 / AMB
 * harnesses expect:
 *   add(messages, userId)         → bulk ingest a conversation
 *   search(query, userId, k=10)   → return top-k memories with scores
 *
 * Tier-1 retrieval improvements layered on top of raw hybrid retrieval:
 *   - Cross-encoder rerank (Xenova/ms-marco-MiniLM-L-6-v2) — oversample 2× then
 *     rerank to top-k. Adds ~5-10ms/query, expected +5-8pp on single-hop.
 *   - Speaker boost — if the query names a known conversation speaker, memories
 *     containing that speaker are boosted 1.4×. Sub-ms, +3-5pp on single-hop.
 *   - Temporal-intent chronological sort — when the query contains temporal
 *     markers (when/how long/before/after/ago/date), final hits are re-sorted
 *     by timestamp ascending so the LLM sees them in date order.
 *
 * Each enhancement is independently toggleable via constructor options so we
 * can ablate cleanly when interpreting benchmark deltas.
 *
 * Per-user namespace isolation (locomo:{userId}) so cross-user recall can't
 * inflate scores. Synthetic LoCoMo timestamps round-trip via metadata.
 *
 * Two ingestion modes:
 *   'turns'   — one memory per dialog turn
 *   'windows' — rolling N-turn windows, richer context per hit (default)
 *   'both'    — save both for maximum coverage
 *
 * LocalProvider is imported LAZILY so a --stub run can validate the
 * harness without needing better-sqlite3 / sqlite-vec native modules.
 */

import { StubProvider } from './stub-provider.js';

export interface BenchMessage {
  speaker: string;
  text: string;
  timestamp?: string;
  session_idx?: number;
  dia_id?: string;
}

export interface BenchHit {
  id: string;
  content: string;
  score: number;
  timestamp?: string;
  speaker?: string;
  session_idx?: number;
  dia_id?: string;
  kind?: 'turn' | 'window';
  window_index?: number;
  window_start_dia?: string;
  window_end_dia?: string;
}

export interface AdapterOptions {
  dbPath?: string;
  namespacePrefix?: string;
  useStub?: boolean;
  ingestionMode?: 'turns' | 'windows' | 'both';
  windowSize?: number;
  /** Cross-encoder rerank top oversample → top-k. Default true. */
  rerank?: boolean;
  /** Speaker names from the conversation; used for entity-boost on search. */
  speakers?: string[];
  /** Re-sort retrieved set chronologically when query has temporal markers. Default true. */
  temporalSort?: boolean;
}

interface ProviderLike {
  save(input: any): Promise<any>;
  search(args: { query: string; namespace?: string; k?: number }): Promise<any[]>;
  close(): Promise<void>;
}

// Query intent: temporal markers — when, how long, before/after, ago, dates.
const TEMPORAL_RE = /\b(when|how\s+long|how\s+many\s+(?:days|weeks|months|years)|before|after|ago|prior|earliest|latest|first\s+time|last\s+time|recent|date|month|week|year|day|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)\b/i;
const NEIGHBOR_RADIUS = 2;
const RETRIEVAL_TOKEN_BUDGET = 7000;

// Cached cross-encoder reranker — loaded lazily on first search.
//
// Model history:
//   - Xenova/ms-marco-MiniLM-L-6-v2 (initial): trained on MS MARCO web-passage
//     queries. On LoCoMo dialog text it scored lower than the no-rerank
//     baseline — the training distribution doesn't match "Speaker: utterance"
//     conversational chunks. Latency ~160 ms/query.
//   - Xenova/bge-reranker-base (current): BAAI multilingual retrieval
//     reranker. Trained on broader query<->document pairs including
//     conversational and instructional text. Same size class (~120 MB),
//     comparable latency, dialog-aware.
//
// Override via the MNUERON_BENCH_RERANKER_MODEL env var to A/B another model
// without editing code (e.g. Xenova/bge-reranker-v2-m3, Xenova/mxbai-rerank-xsmall-v1).
const RERANKER_MODEL =
  process.env.MNUERON_BENCH_RERANKER_MODEL ?? 'Xenova/bge-reranker-base';

let cachedReranker: any = null;
async function getReranker(): Promise<any> {
  if (cachedReranker) return cachedReranker;
  const { pipeline } = await import('@xenova/transformers');
  cachedReranker = await pipeline('text-classification', RERANKER_MODEL);
  return cachedReranker;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class MnueronAdapter {
  private providerPromise: Promise<ProviderLike>;
  private prefix: string;
  private ingestionMode: 'turns' | 'windows' | 'both';
  private windowSize: number;
  private rerankEnabled: boolean;
  private speakers: string[];
  private temporalSortEnabled: boolean;
  private windowCache = new Map<string, BenchHit[]>();

  constructor(opts: AdapterOptions) {
    this.prefix = opts.namespacePrefix ?? 'bench';
    this.ingestionMode = opts.ingestionMode ?? 'windows';
    this.windowSize = opts.windowSize ?? 5;
    this.rerankEnabled = opts.rerank ?? true;
    this.speakers = opts.speakers ?? [];
    this.temporalSortEnabled = opts.temporalSort ?? true;
    if (opts.useStub) {
      this.providerPromise = Promise.resolve(new StubProvider());
    } else {
      if (!opts.dbPath) throw new Error('dbPath required when useStub is false');
      const dbPath = opts.dbPath;
      this.providerPromise = import('../../src/store/local.js').then(
        m => new m.LocalProvider(dbPath),
      );
    }
  }

  private async provider(): Promise<ProviderLike> {
    return this.providerPromise;
  }

  private ns(userId: string): string {
    return `${this.prefix}:${userId}`;
  }

  async add(messages: BenchMessage[], userId: string): Promise<number> {
    const provider = await this.provider();
    let saved = 0;
    const ns = this.ns(userId);

    if (this.ingestionMode === 'turns' || this.ingestionMode === 'both') {
      for (const m of messages) {
        await provider.save({
          content: `${m.speaker}: ${m.text}`,
          namespace: ns,
          source: 'benchmark-turn',
          source_ref: m.dia_id,
          metadata: {
            speaker: m.speaker,
            timestamp: m.timestamp ?? null,
            session_idx: m.session_idx ?? null,
            dia_id: m.dia_id ?? null,
            kind: 'turn',
          },
        });
        saved++;
      }
    }

    if (this.ingestionMode === 'windows' || this.ingestionMode === 'both') {
      for (let i = 0; i < messages.length; i += 1) {
        const window = messages.slice(i, i + this.windowSize);
        if (window.length === 0) continue;
        const content = window.map(m => `${m.speaker}: ${m.text}`).join('\n');
        const first = window[0];
        const last = window[window.length - 1];
        const savedRow = await provider.save({
          content,
          namespace: ns,
          source: 'benchmark-window',
          source_ref: `${first.dia_id ?? i}~${last.dia_id ?? i + window.length}`,
          metadata: {
            timestamp: first.timestamp ?? null,
            session_idx: first.session_idx ?? null,
            window_index: i,
            window_start_dia: first.dia_id ?? null,
            window_end_dia: last.dia_id ?? null,
            turn_count: window.length,
            kind: 'window',
          },
        });
        this.rememberWindow(userId, {
          id: savedRow.id,
          content,
          score: 0,
          timestamp: first.timestamp ?? undefined,
          session_idx: first.session_idx ?? undefined,
          kind: 'window',
          window_index: i,
          window_start_dia: first.dia_id ?? undefined,
          window_end_dia: last.dia_id ?? undefined,
        });
        saved++;
      }
    }

    return saved;
  }

  async search(query: string, userId: string, k = 10): Promise<BenchHit[]> {
    const provider = await this.provider();
    // Oversample 2x when reranking — gives the cross-encoder real signal to work with.
    const fetchK = this.rerankEnabled ? Math.min(k * 2, 80) : k;
    const raw = await provider.search({ query, namespace: this.ns(userId), k: fetchK });
    let hits: BenchHit[] = raw.map((h: any) => ({
      id: h.id,
      content: h.content,
      score: typeof h.score === 'number' ? h.score : 0,
      timestamp: h.metadata?.timestamp ?? undefined,
      speaker: h.metadata?.speaker ?? undefined,
      session_idx: h.metadata?.session_idx ?? undefined,
      dia_id: h.metadata?.dia_id ?? undefined,
      kind: h.metadata?.kind ?? undefined,
      window_index: h.metadata?.window_index ?? undefined,
      window_start_dia: h.metadata?.window_start_dia ?? undefined,
      window_end_dia: h.metadata?.window_end_dia ?? undefined,
    }));

    // Speaker boost — if the query names a known speaker, prefer memories containing them.
    if (this.speakers.length > 0) {
      const mentioned = this.speakers.filter(s =>
        new RegExp(`\\b${escapeRegex(s)}\\b`, 'i').test(query),
      );
      if (mentioned.length > 0) {
        hits = hits
          .map(h => ({
            ...h,
            score: h.score * (mentioned.some(s => h.content.includes(`${s}:`)) ? 1.4 : 1.0),
          }))
          .sort((a, b) => b.score - a.score);
      }
    }

    // Cross-encoder rerank — top fetchK → top k by query↔doc relevance.
    if (this.rerankEnabled && hits.length > 0) {
      try {
        hits = await this.rerankHits(query, hits, k);
      } catch (e) {
        // Reranker failure (e.g. model download failed offline) — fall back to lexical/vector order.
        console.warn(`  [rerank] skipped this query: ${(e as Error).message}`);
        hits = hits.slice(0, k);
      }
    } else {
      hits = hits.slice(0, k);
    }

    hits = this.expandWindowNeighbors(userId, hits);

    // Temporal-intent chronological re-sort — easier date math for the LLM downstream.
    if (this.temporalSortEnabled && TEMPORAL_RE.test(query)) {
      hits = hits.slice().sort((a, b) => {
        const ta = a.timestamp ? Date.parse(a.timestamp) : 0;
        const tb = b.timestamp ? Date.parse(b.timestamp) : 0;
        return ta - tb;
      });
    }

    return hits;
  }

  private rememberWindow(userId: string, hit: BenchHit): void {
    const existing = this.windowCache.get(userId) ?? [];
    existing.push(hit);
    this.windowCache.set(userId, existing);
  }

  /**
   * LoCoMo answers often need the turn immediately before/after the hit
   * the retriever found. Add neighboring rolling windows around each top hit
   * until we reach a Mem0-like context budget (~7k tokens/query).
   */
  private expandWindowNeighbors(userId: string, hits: BenchHit[]): BenchHit[] {
    const windows = this.windowCache.get(userId);
    if (!windows || windows.length === 0 || hits.length === 0) return hits;

    const bySessionAndIndex = new Map<string, BenchHit>();
    for (const w of windows) {
      if (w.session_idx == null || w.window_index == null) continue;
      bySessionAndIndex.set(`${w.session_idx}:${w.window_index}`, w);
    }

    const out: BenchHit[] = [];
    const seen = new Set<string>();
    let approxTokens = 0;
    const push = (hit: BenchHit) => {
      if (seen.has(hit.id)) return;
      const nextTokens = hit.content.length / 4;
      if (out.length > hits.length && approxTokens + nextTokens > RETRIEVAL_TOKEN_BUDGET) return;
      seen.add(hit.id);
      approxTokens += nextTokens;
      out.push(hit);
    };

    for (const h of hits) {
      push(h);
      if (h.session_idx == null || h.window_index == null) continue;
      for (let delta = -NEIGHBOR_RADIUS; delta <= NEIGHBOR_RADIUS; delta++) {
        if (delta === 0) continue;
        const neighbor = bySessionAndIndex.get(`${h.session_idx}:${h.window_index + delta}`);
        if (neighbor) {
          push({ ...neighbor, score: h.score * 0.75 });
        }
      }
    }

    return out;
  }

  private async rerankHits(query: string, hits: BenchHit[], topK: number): Promise<BenchHit[]> {
    const reranker = await getReranker();
    // Some xenova versions accept paired input as { text, text_pair }; others as
    // [query, doc]. Try paired-object form first, fall back to per-hit sequential calls.
    let scores: number[];
    try {
      const pairs = hits.map(h => ({ text: query, text_pair: h.content.slice(0, 512) }));
      const out: any = await reranker(pairs);
      scores = (Array.isArray(out) ? out : [out]).map((r: any) => {
        const item = Array.isArray(r) ? r[0] : r;
        return typeof item?.score === 'number' ? item.score : 0;
      });
    } catch {
      scores = await Promise.all(
        hits.map(async h => {
          const out: any = await reranker(query, { text_pair: h.content.slice(0, 512) } as any);
          const item = Array.isArray(out) ? out[0] : out;
          return typeof item?.score === 'number' ? item.score : 0;
        }),
      );
    }
    return hits
      .map((h, i) => ({ ...h, score: scores[i] ?? h.score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  async close(): Promise<void> {
    const provider = await this.provider();
    await provider.close();
  }
}
