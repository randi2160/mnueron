/**
 * Unit tests for the Context Engine.
 *
 * Covers intent classification, entity extraction, runbook detection,
 * confidence scoring, and the analyzeContext orchestrator. These tests
 * are the foundation of trust — every downstream feature (MCP tools,
 * dashboard, VS Code extension) assumes these classifiers behave
 * deterministically.
 */
import { describe, it, expect } from 'vitest';
import { classifyIntent } from '../../src/lib/context-engine/intent.js';
import { extractEntities } from '../../src/lib/context-engine/entities.js';
import { detectRunbook } from '../../src/lib/context-engine/runbook-detector.js';
import {
  scoreCandidate,
  filterByConfidence,
  gateSurfacing,
  DEFAULT_CONFIG,
  type RankedCandidate,
} from '../../src/lib/context-engine/confidence.js';
import { analyzeContext } from '../../src/lib/context-engine/index.js';

describe('classifyIntent', () => {
  it('detects coding intent from fenced TS block', () => {
    const i = classifyIntent('```typescript\nexport async function foo() {}\n```');
    expect(i.kind).toBe('coding');
    expect(i.confidence).toBeGreaterThan(0.5);
  });

  it('detects deploying intent', () => {
    const i = classifyIntent('Need to push the CAB release to AWS rules server today');
    expect(i.kind).toBe('deploying');
    expect(i.confidence).toBeGreaterThan(0.5);
  });

  it('detects debugging intent from error mention', () => {
    const i = classifyIntent("Getting Error: Cannot find module './methods/wrappers' when running npm");
    expect(i.kind).toBe('debugging');
    expect(i.confidence).toBeGreaterThan(0.4);
  });

  it('detects testing intent', () => {
    const i = classifyIntent('writing a vitest spec for the new auth module');
    expect(i.kind).toBe('testing');
    expect(i.confidence).toBeGreaterThan(0.5);
  });

  it('detects documenting intent', () => {
    const i = classifyIntent('# Getting Started\n\nThis guide walks through installation and setup.');
    expect(i.kind).toBe('documenting');
    expect(i.confidence).toBeGreaterThan(0.3);
  });

  it('detects planning intent', () => {
    const i = classifyIntent('Architecture decision: we should use Postgres for the main store. Phase 1 milestone is ingestion.');
    expect(i.kind).toBe('planning');
    expect(i.confidence).toBeGreaterThan(0.3);
  });

  it('returns none for very short input', () => {
    const i = classifyIntent('hi');
    expect(i.kind).toBe('none');
  });

  it('returns none for prose with no specific signal', () => {
    const i = classifyIntent('I had a great time at the restaurant yesterday. The pasta was excellent.');
    // "yesterday" triggers temporal — that's fine. As long as it's not coding/deploying/etc.
    expect(['none', 'temporal']).toContain(i.kind);
  });
});

describe('extractEntities', () => {
  it('extracts source file paths', () => {
    const e = extractEntities('Editing src/billing/checkout.ts and src/lib/stripe.ts');
    expect(e.files).toContain('src/billing/checkout.ts');
    expect(e.files).toContain('src/lib/stripe.ts');
  });

  it('extracts shell commands', () => {
    const e = extractEntities('Run `npm run db:push` then `git push`');
    expect(e.commands.some(c => c.startsWith('npm run db:push'))).toBe(true);
    expect(e.commands.some(c => c.startsWith('git push'))).toBe(true);
  });

  it('extracts errors', () => {
    const e = extractEntities("ERROR: duplicate key value violates unique constraint (SQLSTATE 23505)");
    expect(e.errors.length).toBeGreaterThan(0);
  });

  it('extracts technologies', () => {
    const e = extractEntities('Using Next.js with Supabase and Stripe for billing');
    expect(e.technologies).toContain('next.js');
    expect(e.technologies).toContain('supabase');
    expect(e.technologies).toContain('stripe');
  });

  it('infers project from cwd', () => {
    const e = extractEntities('writing some code', { cwd: '/home/me/projects/mnueron' });
    expect(e.project).toBe('mnueron');
  });

  it('walks up cwd past generic dir names', () => {
    const e = extractEntities('writing some code', { cwd: '/home/me/projects/mnueron/src' });
    expect(e.project).toBe('mnueron');
  });

  it('prefers explicit project over cwd', () => {
    const e = extractEntities('writing some code', {
      cwd: '/home/me/projects/elsewhere',
      explicitProject: 'my-real-project',
    });
    expect(e.project).toBe('my-real-project');
  });

  it('extracts project from "in the X repo" phrasing', () => {
    const e = extractEntities('I am in the mnueron repo working on auth');
    expect(e.project).toBe('mnueron');
  });
});

describe('detectRunbook', () => {
  it('detects a 3-item numbered list as runbook', () => {
    const r = detectRunbook(`
1. Open Chrome settings
2. Navigate to extensions
3. Toggle developer mode on
4. Click Load unpacked
    `);
    expect(r.isRunbook).toBe(true);
    expect(r.confidence).toBeGreaterThan(0.5);
    expect(r.steps.length).toBeGreaterThan(2);
  });

  it('detects fenced-code-sequence as runbook', () => {
    const r = detectRunbook(`
First, build the project:

\`\`\`bash
npm run build
\`\`\`

Then publish to npm:

\`\`\`bash
npm publish
\`\`\`

Finally, push the git tag:

\`\`\`bash
git push --tags
\`\`\`
    `);
    expect(r.isRunbook).toBe(true);
    expect(r.steps.length).toBeGreaterThan(0);
  });

  it('rejects continuous prose as runbook', () => {
    const r = detectRunbook(`
I was thinking about how memory layers work in modern AI applications.
There are a few different approaches. Some systems use vector databases
directly, others build their own retrieval pipelines on top of relational
stores. The trade-offs are interesting and worth exploring.
    `);
    expect(r.isRunbook).toBe(false);
    expect(r.confidence).toBeLessThan(0.5);
  });

  it('rejects dialog as runbook', () => {
    const r = detectRunbook(`
You: how do I deploy this?
Claude: First, run npm build. Then git push.
You: thanks!
    `);
    expect(r.isRunbook).toBe(false);
    expect(r.signals).toContain('dialog-demote');
  });

  it('extracts suggested title from markdown heading', () => {
    const r = detectRunbook(`# Deploy to AWS Rules Server

1. Build artifact
2. Upload to S3
3. Trigger CodeDeploy
4. Verify on staging
    `);
    expect(r.suggestedTitle).toBe('Deploy to AWS Rules Server');
  });
});

describe('confidence scoring', () => {
  const dummyEntities = {
    project: 'mnueron',
    files: ['src/foo.ts'],
    commands: [],
    errors: [],
    technologies: ['typescript'],
    tags: [],
  };

  it('scores higher for verified runbooks with successful uses', () => {
    const c1: RankedCandidate = {
      id: '1', kind: 'runbook', rawScore: 0.7, content: 'foo runbook for mnueron typescript',
      verified: true, successCount: 5, failureCount: 0,
    };
    const c2: RankedCandidate = {
      id: '2', kind: 'runbook', rawScore: 0.7, content: 'foo runbook for mnueron typescript',
      verified: false, successCount: 0, failureCount: 0,
    };
    const s1 = scoreCandidate(c1, { kind: 'deploying', confidence: 0.8, signals: [] }, dummyEntities);
    const s2 = scoreCandidate(c2, { kind: 'deploying', confidence: 0.8, signals: [] }, dummyEntities);
    expect(s1.confidence).toBeGreaterThan(s2.confidence);
  });

  it('filters at conservative threshold 0.75', () => {
    const cs = [
      { id: '1', kind: 'memory' as const, rawScore: 0.9, content: 'mnueron typescript', confidence: 0.85, reason: '' },
      { id: '2', kind: 'memory' as const, rawScore: 0.5, content: 'mnueron typescript', confidence: 0.65, reason: '' },
      { id: '3', kind: 'memory' as const, rawScore: 0.95, content: 'mnueron typescript', confidence: 0.92, reason: '' },
    ];
    const out = filterByConfidence(cs, DEFAULT_CONFIG);
    expect(out.length).toBe(2);
    expect(out[0].id).toBe('3');
    expect(out[1].id).toBe('1');
  });

  it('gates empty list when intent is none and entities are empty', () => {
    const cs: RankedCandidate[] = [
      { id: '1', kind: 'memory', rawScore: 0.99, content: 'anything' },
    ];
    const out = gateSurfacing(
      cs,
      { kind: 'none', confidence: 0, signals: [] },
      { project: null, files: [], commands: [], errors: [], technologies: [], tags: [] },
      null,
    );
    expect(out).toEqual([]);
  });
});

describe('analyzeContext (orchestrator)', () => {
  it('produces a complete ContextSignal for a deploy query', () => {
    const sig = analyzeContext(
      'I need to deploy the CAB rules release to AWS today using `aws deploy push`',
      { cwd: '/home/me/projects/cab-rules' },
    );
    expect(sig.intent.kind).toBe('deploying');
    expect(sig.entities.project).toBe('cab-rules');
    expect(sig.entities.technologies).toContain('aws');
    expect(sig.namespaceHints).toContain('repo:cab-rules');
    expect(sig.worthSearching).toBe(true);
  });

  it('marks worthSearching=false for thin input', () => {
    const sig = analyzeContext('hello there');
    expect(sig.worthSearching).toBe(false);
  });

  it('detects runbook + populates suggested title', () => {
    const sig = analyzeContext(`# Deploy to AWS

1. Build artifact
2. Push to S3
3. Trigger CodeDeploy
4. Verify`);
    expect(sig.runbookDetection.isRunbook).toBe(true);
    expect(sig.runbookDetection.suggestedTitle).toBe('Deploy to AWS');
    expect(sig.intent.kind).toBe('deploying');
  });
});
