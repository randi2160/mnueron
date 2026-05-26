/**
 * `mnueron explain-error` — paste-an-error → suggested fixes.
 *
 * The simplest, least-invasive entry point to the Terminal Copilot:
 * user copies an error from their terminal, pastes it into a prompt,
 * and gets back known fixes (with confidence labels) or a suggestion
 * to capture a new runbook if nothing matches.
 *
 * Usage:
 *   mnueron explain-error                              (reads stdin, ends on EOF)
 *   mnueron explain-error --file path/to/error.log     (reads file)
 *   mnueron explain-error --text "fatal: ..."          (one-liner via flag)
 *   mnueron explain-error --ns mnueron                 (namespace scope)
 *   mnueron explain-error --json                       (machine-readable output)
 */

import { readFile } from 'node:fs/promises';
import { loadConfig, makeProvider } from '../config.js';
import { openLocalDb } from '../store/local-db.js';
import { fingerprintError } from './fingerprint.js';
import { searchRunbooks } from './search.js';
import type { RunbookHit } from './types.js';

export async function cmdExplainError(args: string[]): Promise<void> {
  const opts = parseArgs(args);
  const errorText = await readErrorInput(opts);

  if (!errorText.trim()) {
    console.error('No error text provided. Pipe an error in, use --file, or --text "..."');
    process.exit(1);
  }

  const cfg = loadConfig();
  const provider = makeProvider(cfg);
  const db = openLocalDb(cfg.dbPath);

  const fp = fingerprintError(errorText);

  if (!opts.json) {
    console.log('');
    console.log(`Fingerprint: ${fp.hash}${fp.tool ? `   (tool: ${fp.tool})` : ''}`);
    if (fp.redactedCount > 0) {
      console.log(
        `Redacted ${fp.redactedCount} secret${fp.redactedCount > 1 ? 's' : ''}: ${fp.redactedKinds.join(', ')}`,
      );
    }
    console.log('');
  }

  const hits = await searchRunbooks(fp, {
    db,
    provider,
    namespace: opts.namespace,
  });

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          fingerprint: { hash: fp.hash, tool: fp.tool, normalized: fp.normalized },
          redacted: { count: fp.redactedCount, kinds: fp.redactedKinds },
          hits,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (hits.length === 0) {
    console.log('No matching runbooks found.');
    console.log('');
    console.log('If you solve this and want to remember the fix, run:');
    console.log('  mnueron runbook capture');
    return;
  }

  console.log(`Found ${hits.length} runbook${hits.length > 1 ? 's' : ''}:`);
  console.log('');
  for (const [i, hit] of hits.entries()) {
    renderHit(hit, i + 1);
  }
  console.log('');
  console.log('After you apply a fix that worked:');
  console.log('  mnueron runbook capture        (or update an existing one)');
}

function renderHit(hit: RunbookHit, index: number): void {
  const tag =
    hit.confidence === 'high'
      ? '★ high'
      : hit.confidence === 'medium'
      ? '○ medium'
      : '· low';
  console.log(`${index}. [${tag}] ${hit.name}${hit.verified ? ' ✓ verified' : ''}`);
  console.log(`   ${hit.summary || '(no summary)'}`);
  console.log(`   reason: ${hit.reason}`);
  if (hit.successCount + hit.failureCount > 0) {
    console.log(`   record: ${hit.successCount} success / ${hit.failureCount} failure`);
  }
  if (hit.steps.length > 0) {
    console.log('   steps:');
    for (const [j, step] of hit.steps.entries()) {
      console.log(`     ${j + 1}. ${step.step}`);
      if (step.code) {
        const trimmed = step.code.length > 200 ? step.code.slice(0, 197) + '...' : step.code;
        console.log(`        > ${trimmed.replace(/\n/g, '\n        > ')}`);
      }
    }
  }
  console.log('');
}

// ── Argument parsing + input reading ───────────────────────────────────────

interface ExplainArgs {
  file?: string;
  text?: string;
  namespace?: string;
  json: boolean;
}

function parseArgs(args: string[]): ExplainArgs {
  const out: ExplainArgs = { json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--file' || a === '-f') out.file = args[++i];
    else if (a === '--text' || a === '-t') out.text = args[++i];
    else if (a === '--ns' || a === '--namespace') out.namespace = args[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      printHelp();
      process.exit(1);
    }
  }
  return out;
}

function printHelp(): void {
  console.log(`mnueron explain-error — match a terminal error against known runbooks

  mnueron explain-error                          Read error from stdin
  mnueron explain-error --file <path>            Read error from a file
  mnueron explain-error --text "<error string>"  Pass error inline

Options:
  --ns <name>           Limit search to a namespace (default: search all)
  --json                Machine-readable output
  -h, --help            Show this help

Examples:
  git push 2>&1 | mnueron explain-error
  mnueron explain-error --file last-build.log
  mnueron explain-error --text "fatal: Unable to create '.git/index.lock'"`);
}

async function readErrorInput(opts: ExplainArgs): Promise<string> {
  if (opts.text) return opts.text;
  if (opts.file) {
    return readFile(opts.file, 'utf8');
  }
  // Stdin path
  if (process.stdin.isTTY) {
    console.log('Paste your error, then press Ctrl+D (Ctrl+Z on Windows) when done:');
  }
  return readStdin();
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}
