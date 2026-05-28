/**
 * Date-anchor extraction tests.
 *
 * These are the foundation of Tier 3+4 temporal handling. If extraction
 * is wrong, every downstream proximity score is wrong. Tests cover the
 * most common LoCoMo-style phrasings.
 */
import { describe, it, expect } from 'vitest';
import {
  extractDateAnchors,
  extractQueryAnchor,
} from '../../src/lib/date-anchors.js';
import {
  classifyTemporal,
  isTemporalQuery,
  temporalProximityScore,
} from '../../src/lib/temporal-intent.js';

const ANCHOR = new Date(Date.UTC(2024, 4, 15)); // 2024-05-15 (Wed)

describe('extractDateAnchors — absolute formats', () => {
  it('ISO 8601 date', () => {
    const a = extractDateAnchors('Met on 2024-03-15 for lunch', ANCHOR);
    expect(a.length).toBe(1);
    expect(a[0].kind).toBe('absolute-date');
    expect(new Date(a[0].resolved_ms).getUTCMonth()).toBe(2); // March
  });

  it('Written date "March 15, 2024"', () => {
    const a = extractDateAnchors('Met on March 15, 2024 for lunch', ANCHOR);
    expect(a.length).toBeGreaterThanOrEqual(1);
    const md = a.find(x => x.kind === 'absolute-date');
    expect(md).toBeDefined();
    expect(new Date(md!.resolved_ms).getUTCMonth()).toBe(2);
    expect(new Date(md!.resolved_ms).getUTCDate()).toBe(15);
  });

  it('Numeric MM/DD/YYYY', () => {
    const a = extractDateAnchors('3/15/2024 was a big day', ANCHOR);
    const md = a.find(x => x.kind === 'absolute-date');
    expect(md).toBeDefined();
    expect(new Date(md!.resolved_ms).getUTCMonth()).toBe(2);
    expect(new Date(md!.resolved_ms).getUTCDate()).toBe(15);
  });

  it('Month + year only', () => {
    const a = extractDateAnchors('Things changed in March 2024', ANCHOR);
    expect(a.length).toBeGreaterThanOrEqual(1);
    const md = a.find(x => x.kind === 'absolute-month');
    expect(md).toBeDefined();
  });

  it('Quarter "Q1 2024"', () => {
    const a = extractDateAnchors('Q1 2024 was rough', ANCHOR);
    expect(a.length).toBeGreaterThanOrEqual(1);
    const q = a.find(x => x.kind === 'quarter');
    expect(q).toBeDefined();
    expect(new Date(q!.resolved_ms).getUTCMonth()).toBe(0); // January = month 0
  });
});

describe('extractDateAnchors — relative formats', () => {
  it('"two weeks ago" (anchored to 2024-05-15)', () => {
    const a = extractDateAnchors('I saw her two weeks ago', ANCHOR);
    expect(a.length).toBe(1);
    expect(a[0].kind).toBe('relative');
    // 2024-05-15 - 14 days = 2024-05-01
    const d = new Date(a[0].resolved_ms);
    expect(d.getUTCMonth()).toBe(4); // May
    expect(d.getUTCDate()).toBe(1);
  });

  it('"yesterday"', () => {
    const a = extractDateAnchors('We met yesterday', ANCHOR);
    expect(a.length).toBe(1);
    expect(a[0].kind).toBe('relative');
    const d = new Date(a[0].resolved_ms);
    expect(d.getUTCDate()).toBe(14);
  });

  it('"last March" — resolves to most recent March before anchor', () => {
    // Anchor is May 2024, so "last March" = March 2024
    const a = extractDateAnchors('Last March I changed jobs', ANCHOR);
    expect(a.length).toBeGreaterThanOrEqual(1);
    const r = a.find(x => x.kind === 'relative');
    expect(r).toBeDefined();
    const d = new Date(r!.resolved_ms);
    expect(d.getUTCMonth()).toBe(2); // March
    expect(d.getUTCFullYear()).toBe(2024);
  });

  it('"last March" before March in same year — resolves to PREVIOUS year', () => {
    const anchor = new Date(Date.UTC(2024, 1, 15)); // 2024-02-15
    const a = extractDateAnchors('Last March I changed jobs', anchor);
    const r = a.find(x => x.kind === 'relative');
    expect(r).toBeDefined();
    const d = new Date(r!.resolved_ms);
    expect(d.getUTCMonth()).toBe(2);
    expect(d.getUTCFullYear()).toBe(2023); // not 2024 — March 2024 hasn't happened yet
  });

  it('"a week ago"', () => {
    const a = extractDateAnchors('A week ago we had the meeting', ANCHOR);
    expect(a.length).toBe(1);
    expect(a[0].kind).toBe('relative');
    const d = new Date(a[0].resolved_ms);
    expect(d.getUTCDate()).toBe(8); // 2024-05-15 minus 7 days
  });
});

describe('extractQueryAnchor', () => {
  it('returns the highest-confidence anchor', () => {
    const a = extractQueryAnchor('When did Sarah change jobs in March 2023?', ANCHOR);
    expect(a).not.toBeNull();
    expect(new Date(a!.resolved_ms).getUTCFullYear()).toBe(2023);
  });

  it('returns null when no temporal anchor in query', () => {
    const a = extractQueryAnchor('What hobbies does Sarah enjoy?', ANCHOR);
    expect(a).toBeNull();
  });
});

describe('classifyTemporal', () => {
  it('classifies "when did X happen" as temporal/when', () => {
    const i = classifyTemporal('When did Sarah change jobs?');
    expect(i.isTemporal).toBe(true);
    expect(i.kind).toBe('when');
  });

  it('classifies "how long ago" as temporal/duration', () => {
    const i = classifyTemporal('How long ago did the meeting happen?');
    expect(i.isTemporal).toBe(true);
    expect(i.kind).toBe('duration');
  });

  it('classifies "before / after" as temporal/ordering', () => {
    const i = classifyTemporal('Did the meeting happen before Tuesday?');
    expect(i.isTemporal).toBe(true);
    expect(i.kind).toBe('ordering');
  });

  it('classifies plain semantic questions as non-temporal', () => {
    const i = classifyTemporal('What does Sarah like for breakfast?');
    expect(i.isTemporal).toBe(false);
    expect(i.kind).toBeNull();
  });

  it('classifies date-only mentions as date-mention', () => {
    const i = classifyTemporal('Tell me about the March meeting');
    expect(i.isTemporal).toBe(true);
    expect(i.kind).toBe('date-mention');
  });
});

describe('temporalProximityScore', () => {
  const queryAnchor = {
    phrase: 'March 2024',
    resolved_ms: Date.UTC(2024, 2, 1),
    kind: 'absolute-month' as const,
    confidence: 0.9,
  };

  it('returns 1.0 for exact match', () => {
    const score = temporalProximityScore(Date.UTC(2024, 2, 1), queryAnchor);
    expect(score).toBe(1.0);
  });

  it('decays with distance (half-life 30 days)', () => {
    // 30 days off = 0.5
    const score = temporalProximityScore(Date.UTC(2024, 1, 1), queryAnchor);
    expect(score).toBeLessThan(0.9);
    expect(score).toBeGreaterThan(0.3);
  });

  it('returns 0 when memory has no timestamp', () => {
    expect(temporalProximityScore(null, queryAnchor)).toBe(0);
    expect(temporalProximityScore(undefined, queryAnchor)).toBe(0);
  });

  it('returns 0 when no query anchor', () => {
    expect(temporalProximityScore(Date.now(), null)).toBe(0);
  });
});
