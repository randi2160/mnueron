#!/usr/bin/env node
/**
 * mnueron CLI.
 *   mnueron init                  — write Claude Desktop config entry
 *   mnueron import <file> [--ns]  — bulk import a Claude/OpenAI export
 *   mnueron stats                 — counts by namespace
 *   mnueron search <query>        — quick search from terminal
 *   mnueron namespaces            — list namespaces
 */
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, makeProvider } from './config.js';
import { importClaudeExport } from './import/claude.js';
import { importOpenAIExport } from './import/openai.js';
import { runSetup, formatReport, type SetupOptions } from './setup.js';

const HERE = dirname(fileURLToPath(import.meta.url));

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case 'setup':        return cmdSetup(rest);
    case 'init':         return cmdSetup(rest);   // alias kept for older docs
    case 'import':       return cmdImport(rest);
    case 'stats':        return cmdStats();
    case 'search':       return cmdSearch(rest);
    case 'namespaces':   return cmdNamespaces();
    case 'dashboard':    return cmdDashboard(rest);
    case 'rebuild-embeddings': return cmdRebuildEmbeddings(rest);
    case 'help':
    case '--help':
    case '-h':
    case undefined:      return printHelp();
    default:
      console.error(`Unknown command: ${cmd}\n`);
      printHelp();
      process.exit(1);
  }
}

function printHelp() {
  console.log(`mnueron — persistent memory for AI agents

Commands:
  mnueron setup                   Detect installed AI tools and configure each one
       [--only <tool>]            Only configure one tool (claude-desktop|claude-code|cursor|windsurf|cline)
       [--hosted <url> --token <t>]   Configure for hosted mode (default: local SQLite)
       [--dry-run]                Show what would change without writing
       [--uninstall]              Remove mnueron from all detected tools
  mnueron import <file>           Bulk-import a Claude or OpenAI export
       [--ns <name>]              Target namespace (default: "default")
       [--format claude|openai]   Skip format auto-detection
  mnueron search <query>          Search memories from the terminal
       [--ns <name>] [--k <n>]
  mnueron stats                   Show counts by namespace
  mnueron namespaces              List all namespaces
  mnueron dashboard               Launch the local web dashboard
       [--port <n>]               Port to bind (default 3122)
       [--no-open]                Don't open the browser automatically
  mnueron rebuild-embeddings      Generate vector embeddings for memories saved
                                  before semantic-search support was added. Run
                                  once after upgrading to v0.2+.

Environment:
  MNUERON_DB_PATH    Local SQLite location (default: ~/.mnueron/memories.db)
  MNUERON_API_URL    Hosted backend URL (enables remote mode)
  MNUERON_API_TOKEN  Token for remote mode
  MNUERON_NAMESPACE  Default namespace (default: "default")
`);
}

async function cmdSetup(args: string[]) {
  const opts: SetupOptions = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--only' && args[i + 1]) {
      opts.only = (opts.only ?? []).concat(args[++i]);
    } else if (a === '--hosted' && args[i + 1] && args[i + 2] && args[i + 2] !== '--token') {
      // tolerate `--hosted URL --token TOKEN` and `--hosted URL --token TOKEN`
      const url = args[++i];
      const next = args[i + 1];
      if (next === '--token' && args[i + 2]) {
        i++;
        opts.hosted = { url, token: args[++i] };
      } else {
        console.error('--hosted requires --token <value>');
        process.exit(1);
      }
    } else if (a === '--hosted' && args[i + 1]) {
      // alt parse: --hosted URL --token TOKEN
      const url = args[++i];
      const tokenIdx = args.indexOf('--token', i);
      if (tokenIdx === -1 || !args[tokenIdx + 1]) {
        console.error('--hosted requires --token <value>');
        process.exit(1);
      }
      opts.hosted = { url, token: args[tokenIdx + 1] };
    } else if (a === '--dry-run') {
      opts.dryRun = true;
    } else if (a === '--uninstall') {
      opts.uninstall = true;
    } else if (a === '--yes' || a === '-y') {
      opts.yes = true;
    }
  }

  const banner =
    `\n  🧠  mnueron — persistent memory for AI dev tools\n` +
    `      mode: ${opts.hosted ? 'hosted (' + opts.hosted.url + ')' : 'local SQLite'}\n` +
    (opts.dryRun ? `      DRY RUN — no files will be changed\n` : '') +
    (opts.uninstall ? `      REMOVING — will unregister from detected tools\n` : '');
  console.log(banner);

  const reports = await runSetup(opts);
  console.log(formatReport(reports));

  const ok = reports.some(r => r.status === 'configured' || r.status === 'updated' || r.status === 'uninstalled');
  if (ok && !opts.dryRun && !opts.uninstall) {
    console.log(`\n✨ Done. Restart any running AI tool to load the memory plugin.`);
    console.log(`   Then ask it: "What memory tools do you have?"\n`);
  } else if (!opts.dryRun && !opts.uninstall) {
    console.log(`\n  No supported AI tools detected on this machine.`);
    console.log(`  Install one of: Claude Desktop, Claude Code, Cursor, Windsurf, Cline\n`);
  }
}

async function cmdImport(args: string[]) {
  if (args.length === 0) {
    console.error('Usage: mnueron import <file> [--ns <namespace>] [--format claude|openai]');
    process.exit(1);
  }
  const file = args[0];
  let ns = 'default';
  let format: 'claude' | 'openai' | 'auto' = 'auto';
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--ns' && args[i + 1]) { ns = args[++i]; }
    else if (args[i] === '--format' && args[i + 1]) {
      const f = args[++i];
      if (f === 'claude' || f === 'openai') format = f;
    }
  }

  if (!existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }
  const sz = (await stat(file)).size;
  console.log(`Reading ${file} (${(sz / 1024).toFixed(1)} KB)...`);

  if (format === 'auto') {
    const head = (await readFile(file, 'utf8')).slice(0, 4000);
    if (head.includes('"chat_messages"')) format = 'claude';
    else if (head.includes('"mapping"')) format = 'openai';
    else format = 'claude';
    console.log(`Detected format: ${format}`);
  }

  const items = format === 'claude'
    ? await importClaudeExport(file, ns)
    : await importOpenAIExport(file, ns);

  console.log(`Parsed ${items.length} conversations. Saving...`);
  const provider = makeProvider(loadConfig());
  const result = await provider.bulkSave(items);
  await provider.close();
  console.log(`✓ Saved ${result.saved}, errors ${result.errors}, namespace="${ns}"`);
}

async function cmdStats() {
  const provider = makeProvider(loadConfig());
  const namespaces = await provider.namespaces();
  await provider.close();
  if (namespaces.length === 0) {
    console.log('No memories yet.');
    return;
  }
  const total = namespaces.reduce((s, n) => s + n.count, 0);
  console.log(`Total: ${total} memories across ${namespaces.length} namespaces\n`);
  for (const ns of namespaces) {
    const date = ns.last_updated ? new Date(ns.last_updated).toISOString().slice(0, 10) : '—';
    console.log(`  ${ns.name.padEnd(24)} ${String(ns.count).padStart(6)}  last: ${date}`);
  }
}

async function cmdSearch(args: string[]) {
  if (args.length === 0) {
    console.error('Usage: mnueron search <query> [--ns <namespace>] [--k <n>]');
    process.exit(1);
  }
  let ns: string | undefined;
  let k = 5;
  const queryParts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--ns' && args[i + 1]) { ns = args[++i]; }
    else if (args[i] === '--k' && args[i + 1]) { k = parseInt(args[++i], 10) || 5; }
    else queryParts.push(args[i]);
  }
  const query = queryParts.join(' ');
  const provider = makeProvider(loadConfig());
  const hits = await provider.search({ query, namespace: ns, k });
  await provider.close();
  if (hits.length === 0) {
    console.log('No matches.');
    return;
  }
  for (const m of hits) {
    const date = new Date(m.created_at).toISOString().slice(0, 10);
    const preview = m.content.replace(/\s+/g, ' ').slice(0, 200);
    console.log(`\n[${date}] ${m.namespace}${m.tags.length ? ` #${m.tags.join(' #')}` : ''}`);
    console.log(`  ${preview}${m.content.length > 200 ? '…' : ''}`);
    console.log(`  id: ${m.id}`);
  }
}

async function cmdNamespaces() {
  const provider = makeProvider(loadConfig());
  const namespaces = await provider.namespaces();
  await provider.close();
  for (const ns of namespaces) console.log(ns.name);
}

async function cmdDashboard(args: string[]) {
  let port = 3122;
  let openBrowser = true;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[++i], 10) || 3122;
    } else if (args[i] === '--no-open') {
      openBrowser = false;
    }
  }
  const { startDashboard } = await import('./dashboard/server.js');
  const provider = makeProvider(loadConfig());
  const handle = await startDashboard(provider, port).catch((e: any) => {
    if (e?.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Try --port <other>.`);
      process.exit(1);
    }
    throw e;
  });

  console.log(`\n  🧠  mnueron dashboard`);
  console.log(`      ${handle.url}\n`);
  console.log(`  Ctrl+C to stop.`);

  if (openBrowser) openInBrowser(handle.url);

  const shutdown = async () => {
    await handle.close().catch(() => {});
    await provider.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // wait forever
  await new Promise(() => {});
}

async function openInBrowser(url: string) {
  const { exec } = await import('node:child_process');
  const cmd =
    process.platform === 'win32' ? `cmd /c start "" "${url}"` :
    process.platform === 'darwin' ? `open "${url}"` :
    `xdg-open "${url}"`;
  exec(cmd, () => { /* ignore errors — user can open manually */ });
}

async function cmdRebuildEmbeddings(args: string[]) {
  const force = args.includes('--force');
  const provider = makeProvider(loadConfig());
  // Only LocalProvider exposes rebuildEmbeddings — type-guard accordingly.
  const local = provider as any;
  if (typeof local.rebuildEmbeddings !== 'function') {
    console.error('rebuild-embeddings only supported in local mode.');
    process.exit(1);
  }

  // Diagnostics — reach into the DB so we can see what's actually there.
  // sqlite-vec virtual tables don't always answer LEFT JOIN questions the
  // way you'd expect, so we print counts directly.
  const db = local.db;
  const memCount = db?.prepare('SELECT COUNT(*) c FROM memories').get()?.c ?? 0;
  let vecCount = 0;
  let vecOk = false;
  try {
    vecCount = db?.prepare('SELECT COUNT(*) c FROM memories_vec').get()?.c ?? 0;
    vecOk = true;
  } catch (e: any) {
    console.log(`  memories_vec not queryable: ${e.message}`);
  }
  const missing = local.countMissingEmbeddings?.() ?? 0;

  console.log(`\n  📊  Embeddings diagnostic`);
  console.log(`      memories table:      ${memCount} rows`);
  console.log(`      memories_vec table:  ${vecOk ? vecCount + ' rows' : 'not available'}`);
  console.log(`      missing embeddings:  ${missing}`);
  if (!vecOk) {
    console.log(`\n  sqlite-vec extension is not loaded. Aborting.\n`);
    await provider.close();
    return;
  }

  if (missing === 0 && !force) {
    if (vecCount >= memCount) {
      console.log(`\n  ✓ All memories already have embeddings. Nothing to do.\n`);
    } else {
      console.log(
        `\n  countMissingEmbeddings returns 0 but vec table has fewer rows than memories.\n` +
        `  Run with --force to re-embed all memories.\n`,
      );
    }
    await provider.close();
    return;
  }

  // If --force was passed, wipe the vec table first so rebuildEmbeddings
  // re-embeds everything (its built-in query only catches missing rows).
  if (force && vecOk) {
    console.log(`\n  --force: wiping memories_vec and re-embedding all ${memCount} memories...`);
    try { db.prepare(`DELETE FROM memories_vec`).run(); } catch (e: any) {
      console.log(`  (could not wipe via DELETE: ${e.message}; trying DROP+CREATE)`);
      db.exec(`
        DROP TABLE IF EXISTS memories_vec;
        CREATE VIRTUAL TABLE memories_vec USING vec0(memory_id TEXT PRIMARY KEY, embedding float[384]);
      `);
    }
  }
  const total = force ? memCount : missing;

  console.log(`\n  🧠  Rebuilding embeddings for ${missing} memories...`);
  console.log(`      First run downloads the all-MiniLM-L6-v2 model (~25MB).`);
  console.log(`      Cached to ~/.mnueron/models/ for subsequent runs.\n`);

  const start = Date.now();
  let lastLog = 0;
  const result = await local.rebuildEmbeddings((done: number, total: number, _current?: string) => {
    // Throttle progress output to once per 250ms or every 16 items.
    const now = Date.now();
    if (now - lastLog < 250 && done < total) return;
    lastLog = now;
    const pct = Math.round((done / total) * 100);
    const bar = '█'.repeat(Math.floor(pct / 4)).padEnd(25, '░');
    process.stdout.write(`\r  [${bar}] ${pct}%  ${done}/${total}`);
  });
  process.stdout.write('\n');

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(
    `\n  ✓ Done in ${elapsed}s — ${result.updated} embedded, ` +
    `${result.skipped} skipped, ${result.errors} errors.\n`,
  );
  await provider.close();
}

main().catch(e => {
  console.error(e?.stack ?? e);
  process.exit(1);
});
