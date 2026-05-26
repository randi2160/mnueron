/**
 * `mnueron runbook capture` — interactive wizard for saving a runbook
 * after the user has solved a problem.
 *
 * Five-prompt sequence:
 *   1. The command that was failing
 *   2. The error text (gets redacted automatically; user sees what was scrubbed)
 *   3. The fix steps (multi-line, one step per line; blank line to end)
 *   4. Did the fix actually work?  (yes → verified; no → save as a failed-attempt note)
 *   5. Save as a new runbook? (with dedup-prompt if a fingerprint matches existing)
 *
 * Storage:
 *   - Fingerprint of the (redacted) error is computed and stored on the
 *     runbook so future `mnueron explain-error` matches it.
 *   - Steps land in steps_json. Failing command + redacted error in the
 *     new failing_command + error_text columns.
 *   - `verified` is set to true only when the user confirmed fix worked.
 *   - Dedup: if an existing runbook already has this fingerprint, we
 *     default to UPDATING (append step, bump counters) rather than
 *     creating a duplicate row.
 */

import { createInterface, type Interface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { platform } from 'node:os';
import { loadConfig } from '../config.js';
import { openLocalDb } from '../store/local-db.js';
import { recordRunbookOutcome } from '../store/procedural.js';
import { fingerprintError } from './fingerprint.js';

export async function cmdRunbookCapture(args: string[]): Promise<void> {
  const opts = parseArgs(args);
  const cfg = loadConfig();
  const db = openLocalDb(cfg.dbPath);
  // ensureProceduralSchema is called inside openLocalDb — no need to call here

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log('');
    console.log('mnueron runbook capture');
    console.log('───────────────────────');
    console.log('Five questions. Press Enter for blank to skip optional ones.');
    console.log('');

    const failingCommand = await ask(rl, '1. What command were you running?\n   > ');
    if (!failingCommand.trim()) {
      console.error('A failing command is required.');
      process.exit(1);
    }

    console.log('');
    console.log('2. What error did you hit? (paste multi-line, blank line to end)');
    const errorText = await askMultiLine(rl);
    if (!errorText.trim()) {
      console.error('Error text is required.');
      process.exit(1);
    }

    const fp = fingerprintError(errorText);
    console.log('');
    console.log(`   Fingerprint: ${fp.hash}${fp.tool ? `   (tool: ${fp.tool})` : ''}`);
    if (fp.redactedCount > 0) {
      console.log(
        `   Redacted ${fp.redactedCount} secret${fp.redactedCount > 1 ? 's' : ''}: ${fp.redactedKinds.join(', ')} — they won't be stored.`,
      );
    }

    // Dedup probe
    const dedup = db
      .prepare(
        `SELECT id, name, summary FROM procedural_memories
          WHERE error_fingerprints LIKE ?
          LIMIT 1`,
      )
      .get(`%"${fp.hash}"%`) as { id: string; name: string; summary: string } | undefined;

    if (dedup) {
      console.log('');
      console.log(`   ℹ Existing runbook matches this fingerprint: "${dedup.name}"`);
      console.log(`     ${dedup.summary}`);
      const choice = await ask(rl, '   Update it instead of creating new? [Y/n] ');
      if (choice.trim().toLowerCase() !== 'n') {
        await updateExisting(rl, dedup.id, fp, failingCommand);
        return;
      }
    }

    console.log('');
    console.log('3. What fix did you apply? (one step per line, blank line to end)');
    const steps = await askSteps(rl);
    if (steps.length === 0) {
      console.error('At least one step is required.');
      process.exit(1);
    }

    console.log('');
    const fixWorked = await askYesNo(rl, '4. Did this fix actually resolve the issue?', true);

    console.log('');
    const defaultName = suggestName(fp, failingCommand);
    const nameInput = await ask(rl, `5. Name for this runbook [${defaultName}]: `);
    const name = nameInput.trim() || defaultName;

    const summary = await ask(rl, `   One-line summary [${suggestSummary(fp, failingCommand)}]: `);

    const namespace = opts.namespace ?? cfg.defaultNamespace ?? 'mnueron';

    // Final confirmation
    console.log('');
    console.log('About to save:');
    console.log(`   namespace:  ${namespace}`);
    console.log(`   name:       ${name}`);
    console.log(`   summary:    ${summary || suggestSummary(fp, failingCommand)}`);
    console.log(`   tool:       ${fp.tool ?? '(unknown)'}`);
    console.log(`   fingerprint:${fp.hash}`);
    console.log(`   verified:   ${fixWorked ? 'yes' : 'no — saved as attempted fix'}`);
    console.log(`   steps:`);
    for (const [i, s] of steps.entries()) {
      console.log(`     ${i + 1}. ${s.step}${s.code ? `  →  ${s.code.slice(0, 60)}` : ''}`);
    }
    const proceed = await askYesNo(rl, 'Save? [Y/n]', true);
    if (!proceed) {
      console.log('Cancelled.');
      return;
    }

    const id = randomUUID();
    const now = Date.now();
    db.prepare(
      `INSERT INTO procedural_memories
        (id, namespace, name, summary, steps_json, tools_json, last_used_at, use_count, created_at,
         trigger_phrases, error_fingerprints, verified, verified_at, os, tool,
         success_count, failure_count, error_text, failing_command)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?,  ?, ?, ?, ?, ?, ?,  ?, ?, ?, ?)`,
    ).run(
      id,
      namespace,
      name,
      summary || suggestSummary(fp, failingCommand),
      JSON.stringify(steps),
      JSON.stringify(fp.tool ? [fp.tool] : []),
      now,
      now,
      JSON.stringify([]), // trigger_phrases empty for MVP — LLM-extracted in Phase 2
      JSON.stringify([fp.hash]),
      fixWorked ? 1 : 0,
      fixWorked ? now : null,
      platform(),
      fp.tool ?? null,
      fixWorked ? 1 : 0,
      fixWorked ? 0 : 1,
      fp.redactedOriginal,
      failingCommand,
    );

    console.log('');
    console.log(`✓ Saved runbook ${id.slice(0, 8)} — "${name}"`);
    if (fixWorked) {
      console.log('  Marked verified. Future explain-error matches will surface this.');
    } else {
      console.log('  Saved as attempted fix (failure_count=1). Capture again when you find the real fix.');
    }
  } finally {
    rl.close();
  }

  async function updateExisting(
    rl: Interface,
    runbookId: string,
    fp: ReturnType<typeof fingerprintError>,
    failingCommand: string,
  ): Promise<void> {
    console.log('');
    console.log('3. What additional fix step did you apply? (blank line when done)');
    const steps = await askSteps(rl);
    console.log('');
    const fixWorked = await askYesNo(rl, '4. Did this attempt resolve the issue?', true);
    recordRunbookOutcome(db, runbookId, {
      fingerprintHash: fp.hash,
      outcome: fixWorked ? 'success' : 'failure',
      verified: fixWorked ? true : undefined,
      os: platform(),
      tool: fp.tool,
      failingCommand,
      errorText: fp.redactedOriginal,
      extraSteps: steps.length > 0 ? steps : undefined,
    });
    console.log('');
    console.log(`✓ Updated runbook ${runbookId.slice(0, 8)}.`);
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

interface CaptureArgs {
  namespace?: string;
}

function parseArgs(args: string[]): CaptureArgs {
  const out: CaptureArgs = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--ns' || a === '--namespace') out.namespace = args[++i];
    else if (a === '--help' || a === '-h') {
      console.log(`mnueron runbook capture — save a runbook after fixing an issue.

  --ns <name>     Target namespace (default from config, falls back to "mnueron")
  -h, --help      Show this help`);
      process.exit(0);
    }
  }
  return out;
}

function ask(rl: Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, (a) => resolve(a)));
}

async function askMultiLine(rl: Interface): Promise<string> {
  const lines: string[] = [];
  while (true) {
    const line = await ask(rl, '   ');
    if (line === '') break;
    lines.push(line);
  }
  return lines.join('\n');
}

async function askSteps(rl: Interface): Promise<Array<{ step: string; code?: string }>> {
  const steps: Array<{ step: string; code?: string }> = [];
  let n = 1;
  while (true) {
    const line = await ask(rl, `   ${n}. `);
    if (line.trim() === '') break;
    // Support "description → code" or "description: code"
    const sepMatch = line.match(/^(.+?)\s*(?:→|->|:)\s*(.+)$/);
    if (sepMatch) {
      steps.push({ step: sepMatch[1].trim(), code: sepMatch[2].trim() });
    } else {
      steps.push({ step: line.trim() });
    }
    n++;
  }
  return steps;
}

async function askYesNo(rl: Interface, prompt: string, defaultYes: boolean): Promise<boolean> {
  const ans = await ask(rl, prompt + ' ');
  if (!ans.trim()) return defaultYes;
  return /^y(es)?$/i.test(ans.trim());
}

function suggestName(fp: ReturnType<typeof fingerprintError>, failingCommand: string): string {
  // Heuristic: "fix-<tool>-<first-word-of-command>"
  const cmd = failingCommand.trim().split(/\s+/)[0] || 'cmd';
  const tool = fp.tool ?? cmd;
  return `fix-${tool}-${fp.hash.slice(0, 6)}`;
}

function suggestSummary(fp: ReturnType<typeof fingerprintError>, failingCommand: string): string {
  const cmd = failingCommand.trim().split(/\s+/).slice(0, 2).join(' ');
  return fp.tool
    ? `Fix ${fp.tool} error when running '${cmd}'`
    : `Fix error when running '${cmd}'`;
}
