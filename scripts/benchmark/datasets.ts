/**
 * LoCoMo dataset loader. Expects the file at ./data/locomo10.json (download
 * from github.com/snap-research/locomo/raw/refs/heads/main/data/locomo10.json
 * — 2.7 MB).
 *
 * One LoCoMo sample = one full conversation, ~300 turns across up to 35
 * sessions, ~9k tokens, with QA pairs annotated across 5 categories:
 *   1. single-hop  — answer is in one dialog turn
 *   2. multi-hop   — synthesize across 2+ turns
 *   3. temporal    — when did X happen? requires dialogue timestamps
 *   4. commonsense — world knowledge + recall
 *   5. adversarial — answer not present; system must abstain
 */

import { readFileSync } from 'node:fs';

export interface LoComoTurn {
  speaker: string;
  dia_id: string;
  text: string;
  /** Some turns reference images; LoCoMo provides BLIP captions we ingest as text. */
  img_file?: string[];
  img_url?: string[];
  blip_caption?: string;
}

export interface LoComoSample {
  /** Conversation index, "0" through "9". */
  sample_id: string;
  speaker_a: string;
  speaker_b: string;
  /** Map of "session_1" → [turns], plus matching "session_1_date_time" keys. */
  sessions: Record<string, LoComoTurn[]>;
  sessionTimestamps: Record<string, string>;
  sessionSummaries: Record<string, string>;
  sessionObservations: Record<string, string[]>;
  qa: LoComoQA[];
}

export interface LoComoQA {
  question: string;
  answer?: string;
  category: number;
  /** Dialog ids that contain the evidence. Format: "D{session}:{turn}". */
  evidence?: string[];
  /** Adversarial flag — when true, the answer should be "I don't know" or similar. */
  adversarial?: boolean;
}

export function loadLoComo10(path: string): LoComoSample[] {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(raw)) {
    throw new Error(`Expected LoCoMo to be an array; got ${typeof raw}`);
  }
  return raw.map((sample: any, idx: number) => normalizeSample(sample, idx));
}

function normalizeSample(raw: any, idx: number): LoComoSample {
  const conv = raw.conversation ?? raw;
  const sessions: Record<string, LoComoTurn[]> = {};
  const timestamps: Record<string, string> = {};
  const summaries: Record<string, string> = {};
  const observations: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(conv)) {
    if (k.endsWith('_date_time') && typeof v === 'string') {
      timestamps[k.replace('_date_time', '')] = v;
    } else if (k.endsWith('_summary') && typeof v === 'string') {
      summaries[k.replace('_summary', '')] = v;
    } else if (k.startsWith('session_') && Array.isArray(v)) {
      sessions[k] = v as LoComoTurn[];
    }
  }
  if (raw.session_summary && typeof raw.session_summary === 'object') {
    for (const [k, v] of Object.entries(raw.session_summary)) {
      if (!k.endsWith('_summary') || typeof v !== 'string') continue;
      summaries[k.replace('_summary', '')] = v;
    }
  }
  if (raw.event_summary && typeof raw.event_summary === 'object') {
    for (const [k, v] of Object.entries(raw.event_summary)) {
      if (!k.startsWith('events_session_') || !v || typeof v !== 'object') continue;
      const sessionKey = k.replace('events_', '');
      const eventText = flattenEventSummary(v as Record<string, unknown>);
      if (!eventText) continue;
      summaries[sessionKey] = summaries[sessionKey]
        ? `${summaries[sessionKey]}\nKey events: ${eventText}`
        : `Key events: ${eventText}`;
    }
  }
  if (raw.observation && typeof raw.observation === 'object') {
    for (const [k, v] of Object.entries(raw.observation)) {
      if (!k.endsWith('_observation') || !v || typeof v !== 'object') continue;
      const sessionKey = k.replace('_observation', '');
      observations[sessionKey] = flattenObservations(v as Record<string, unknown>);
    }
  }
  return {
    sample_id: String(raw.sample_id ?? idx),
    speaker_a: conv.speaker_a ?? 'A',
    speaker_b: conv.speaker_b ?? 'B',
    sessions,
    sessionTimestamps: timestamps,
    sessionSummaries: summaries,
    sessionObservations: observations,
    qa: Array.isArray(raw.qa) ? raw.qa : [],
  };
}

function flattenEventSummary(event: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(event)) {
    if (k === 'date' && typeof v === 'string') {
      parts.push(`date: ${v}`);
    } else if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === 'string' && item.trim()) parts.push(`${k}: ${item.trim()}`);
      }
    }
  }
  return parts.join('; ');
}

function flattenObservations(observation: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [speaker, rows] of Object.entries(observation)) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (Array.isArray(row) && typeof row[0] === 'string') {
        const evidence = typeof row[1] === 'string' ? ` (${row[1]})` : '';
        out.push(`${speaker}: ${row[0]}${evidence}`);
      } else if (typeof row === 'string') {
        out.push(`${speaker}: ${row}`);
      }
    }
  }
  return out;
}

/**
 * Iterate sessions in chronological order. Returns [sessionKey, turns,
 * timestamp]. Order is critical for LoCoMo temporal questions: ingesting
 * sessions out of order pollutes the temporal signal.
 */
export function sessionsInOrder(s: LoComoSample): Array<[string, LoComoTurn[], string]> {
  const keys = Object.keys(s.sessions).sort((a, b) => {
    const na = parseInt(a.replace('session_', ''), 10);
    const nb = parseInt(b.replace('session_', ''), 10);
    return na - nb;
  });
  return keys.map(k => [k, s.sessions[k], s.sessionTimestamps[k] ?? '']);
}
