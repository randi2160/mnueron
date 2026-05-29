/**
 * Aggregation queries for the recall savings dashboard.
 *
 * Reads recall_events (capture lives in recall-event.ts) and produces
 * the shape the dashboard widget consumes. Time-windowed counts +
 * top-N savings + a daily sparkline series.
 *
 * Pure-SQLite — no LLM calls, fast enough to call on every dashboard
 * page load. If the recall_events table doesn't exist yet (very fresh
 * install), every query returns zeros so the UI renders cleanly.
 */

import type Database from 'better-sqlite3';
import { getModelPricing, tokensToDollars, DEFAULT_MODEL_ID } from './pricing.js';

export type Window = 'day' | 'week' | 'month' | 'all';

export interface SavingsSummary {
  window: Window;
  recalls_count: number;
  tokens_returned: number;
  tokens_baseline_capped: number;
  tokens_saved: number;
  dollars_saved: number;
  ide_crashes_avoided: number;
  default_model_id: string;
  /** 14-day rolling sparkline — [{ day, savings_usd }]. Most recent last. */
  trend: Array<{ day: string; savings_usd: number; recalls: number }>;
  /** Highest single-recall savings recently. */
  top_saves: Array<{
    namespace: string | null;
    client: string | null;
    tokens_returned: number;
    tokens_baseline_capped: number;
    dollars_saved: number;
    created_at: number;
  }>;
}

const WINDOW_MS: Record<Exclude<Window, 'all'>, number> = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
};

function windowSinceMs(window: Window): number {
  if (window === 'all') return 0;
  return Date.now() - WINDOW_MS[window];
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name = ?`)
    .get(name) as { ok?: number } | undefined;
  return Boolean(row?.ok);
}

function emptySummary(window: Window, modelId: string): SavingsSummary {
  return {
    window,
    recalls_count: 0,
    tokens_returned: 0,
    tokens_baseline_capped: 0,
    tokens_saved: 0,
    dollars_saved: 0,
    ide_crashes_avoided: 0,
    default_model_id: modelId,
    trend: [],
    top_saves: [],
  };
}

/**
 * Aggregate savings for `window`. `defaultModelId` is what cost-per-token
 * to apply to recalls where the captured row didn't know the caller's
 * model (the user picks this in their dashboard settings — we just take
 * it as input here).
 */
export function getSavingsSummary(
  db: Database.Database,
  window: Window = 'month',
  defaultModelId: string = DEFAULT_MODEL_ID,
): SavingsSummary {
  if (!tableExists(db, 'recall_events')) return emptySummary(window, defaultModelId);
  const since = windowSinceMs(window);

  // Aggregate over the window. We compute dollars saved in JS rather than
  // SQL because the model_id varies per row and we want per-row pricing.
  const rows = db
    .prepare(
      `SELECT namespace, client, tokens_returned, tokens_baseline_capped,
              model_id, context_limit, tokens_baseline_namespace, created_at
         FROM recall_events
        WHERE created_at >= ?`,
    )
    .all(since) as Array<{
      namespace: string | null;
      client: string | null;
      tokens_returned: number;
      tokens_baseline_capped: number;
      model_id: string | null;
      context_limit: number;
      tokens_baseline_namespace: number;
      created_at: number;
    }>;

  let tokens_returned = 0;
  let tokens_baseline_capped = 0;
  let dollars_saved = 0;
  let ide_crashes_avoided = 0;

  const perDay = new Map<string, { usd: number; recalls: number }>();
  const topSaves: SavingsSummary['top_saves'] = [];

  for (const r of rows) {
    tokens_returned += r.tokens_returned;
    tokens_baseline_capped += r.tokens_baseline_capped;
    const saved_tokens = Math.max(0, r.tokens_baseline_capped - r.tokens_returned);
    const model = r.model_id ?? defaultModelId;
    const saved_usd = tokensToDollars(saved_tokens, model);
    dollars_saved += saved_usd;
    if (r.tokens_baseline_namespace > r.context_limit) ide_crashes_avoided++;

    const day = new Date(r.created_at).toISOString().slice(0, 10);
    const bucket = perDay.get(day) ?? { usd: 0, recalls: 0 };
    bucket.usd += saved_usd;
    bucket.recalls += 1;
    perDay.set(day, bucket);

    topSaves.push({
      namespace: r.namespace,
      client: r.client,
      tokens_returned: r.tokens_returned,
      tokens_baseline_capped: r.tokens_baseline_capped,
      dollars_saved: saved_usd,
      created_at: r.created_at,
    });
  }

  topSaves.sort((a, b) => b.dollars_saved - a.dollars_saved);

  // Build a 14-day trend (most recent last). Fill missing days with zeros
  // so the sparkline doesn't have gaps.
  const trend: SavingsSummary['trend'] = [];
  const today = new Date();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    const bucket = perDay.get(key);
    trend.push({
      day: key,
      savings_usd: Math.round((bucket?.usd ?? 0) * 100) / 100,
      recalls: bucket?.recalls ?? 0,
    });
  }

  return {
    window,
    recalls_count: rows.length,
    tokens_returned,
    tokens_baseline_capped,
    tokens_saved: Math.max(0, tokens_baseline_capped - tokens_returned),
    dollars_saved: Math.round(dollars_saved * 100) / 100,
    ide_crashes_avoided,
    default_model_id: defaultModelId,
    trend,
    top_saves: topSaves.slice(0, 5),
  };
}
