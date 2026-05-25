/**
 * In-memory stub provider for sandbox/CI smoke tests. Implements the bare
 * minimum of mnueron's LocalProvider interface (save/search/close) using a
 * Map + naive token-overlap scoring. Useful for validating the benchmark
 * harness end-to-end without needing better-sqlite3 / sqlite-vec native
 * modules to load.
 *
 * Real benchmark runs (the kind whose scores you'd publish) use the
 * actual LocalProvider — see adapter.ts.
 */

interface StubMemory {
  id: string;
  namespace: string;
  content: string;
  source?: string;
  source_ref?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at: number;
  updated_at: number;
}

function score(query: string, content: string): number {
  const qt = new Set(query.toLowerCase().match(/\w+/g) ?? []);
  const ct = new Set(content.toLowerCase().match(/\w+/g) ?? []);
  if (qt.size === 0 || ct.size === 0) return 0;
  let overlap = 0;
  for (const t of qt) if (ct.has(t)) overlap++;
  // Jaccard-ish — penalize purely-frequent content.
  return overlap / Math.sqrt(qt.size * ct.size);
}

export class StubProvider {
  private mems: StubMemory[] = [];
  private idCounter = 0;

  async save(input: any): Promise<StubMemory> {
    const now = Date.now();
    const id = `stub-${++this.idCounter}`;
    const m: StubMemory = {
      id,
      namespace: input.namespace ?? 'default',
      content: input.content,
      source: input.source,
      source_ref: input.source_ref ?? null,
      metadata: input.metadata ?? null,
      created_at: now,
      updated_at: now,
    };
    this.mems.push(m);
    return m;
  }

  async search(args: { query: string; namespace?: string; k?: number }): Promise<any[]> {
    const k = args.k ?? 10;
    const ns = args.namespace;
    const scored = this.mems
      .filter(m => !ns || m.namespace === ns)
      .map(m => ({ ...m, score: score(args.query, m.content) }))
      .filter(m => m.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
    return scored;
  }

  async close(): Promise<void> {
    this.mems = [];
  }
}
