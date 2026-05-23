#!/usr/bin/env node
/**
 * mnueron CLI.
 *   mnueron init                  — write Claude Desktop config entry
 *   mnueron import <file> [--ns]  — bulk import a Claude/OpenAI export
 *   mnueron stats                 — counts by namespace
 *   mnueron search <query>        — quick search from terminal
 *   mnueron namespaces            — list namespaces
 */
import { readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, makeProvider } from './config.js';
import { importClaudeExport } from './import/claude.js';
import { importOpenAIExport } from './import/openai.js';
import { runSetup, formatReport, type SetupOptions } from './setup.js';
import { extractEntities } from './store/entity-extractor.js';

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
    case 'rechunk':      return cmdRechunk(rest);
    case 'migrate-to-hosted': return cmdMigrateToHosted(rest);
    case 'plugin':       return cmdPlugin(rest);
    case 'primer':       return cmdPrimer(rest);
    case 'extract-entities': return cmdExtractEntities(rest);
    case 'entities':     return cmdEntities(rest);  // P2.3 — list/show/merge
    case 'graph':        return cmdGraph(rest);     // P3 + P4 — knowledge graph
    case 'consolidate':  return cmdConsolidate(rest); // P5 — detection-only review queue
    case 'watch':        return cmdWatch(rest);
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
  mnueron import --claude-desktop Probe + auto-import the local Claude Desktop app
       [--probe]                  Show what's found without importing
       [--ns <name>]              Target namespace (default: "claude-desktop")
  mnueron import --claude-cowork  Auto-import every Cowork (desktop "local agent")
       [--probe]                    chat. Walks platform-specific roots
       [--ns <name>]                (incl. the Microsoft Store sandboxed path);
       [--limit <n>]                each session becomes a chunked memory;
       [--dry-run]                  idempotent via source_ref dedup.
       Example: mnueron import --claude-cowork --probe
                mnueron import --claude-cowork --ns elevizio --limit 10
                mnueron import --claude-cowork --dry-run
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
  mnueron rechunk                 Split existing oversized memories (long backfilled
       [--threshold <n>]            chats) into per-turn atomic memories. Improves
       [--keep-original]            search granularity. Run once after first backfill.
       [--dry-run]
  mnueron migrate-to-hosted       Upload your local SQLite memories to a hosted
       --url <https://...>          mnueron backend. Idempotent via source_ref dedup.
       --token <mnu_...>            After completion, optionally flips the active provider
       [--batch <n>]                so all subsequent reads/writes go to hosted.
       [--namespace <name>]         Filter to one namespace if you only want a subset.
       [--dry-run]
       [--no-flip]                  Upload but don't change the active provider.
  mnueron plugin <action> [name]  Manage plugins enabled in ~/.mnueron/config.json
       list                         Show enabled + installed plugins.
       enable <name>                Add to enabledPlugins list.
       disable <name>               Remove from enabledPlugins list.
       add <name>                   Alias for enable; also reminds about npm install.
       remove <name>                Alias for disable.
  mnueron primer                  Output a markdown primer for CLAUDE.md / .cursorrules.
       [--ns <name>]                Only summarize one namespace (default: all).
       [--recent <n>]               Sample n most-recent memory titles (default: 12).
       [--out <file>]               Write to file instead of stdout.
       Example: mnueron primer > CLAUDE.md
  mnueron extract-entities        P2 — retroactively extract entities from existing memories.
       [--ns <name>]                Restrict to one namespace.
       [--since <epoch_ms>]         Only memories created on/after this time.
       [--limit <n>]                Cap how many to process (default 100, max 1000).
       [--force]                    Re-extract memories that already have entities.
       [--dry-run]                  Preview without making LLM calls.
       Requires ANTHROPIC_API_KEY or OPENAI_API_KEY in the environment.

  mnueron entities <sub>           P2.3 — Canonical entity browser (resolved across memories).
       list   [--type <t>] [--q <substr>] [--sort recent|mentions|alpha] [--limit <n>]
       show   <entity-id> [--memories <n>]
       merge  --winner <id> --loser <id>
       Example: mnueron entities list --type person --sort mentions

  mnueron graph <sub>              P3 + P4 — Knowledge graph (relationships + bi-temporal).
       show       <entity-id> [--as-of <ISO-date>]
       traverse   <entity-id> [--depth <n>] [--as-of <ISO-date>]
       relations  [--from <id>] [--to <id>] [--predicate <p>] [--as-of <ISO-date>]
       The --as-of flag enables "what was true at that point in time" recall.

  mnueron consolidate <sub>        P5 — Self-revising memory (phase 5a: detection only).
       detect   [--limit <n>] [--threshold <0..1>] [--ns <name>]
       list     [--status pending|approved|rejected|all]
       approve  <proposal-id>
       reject   <proposal-id>
       Detection scans for likely-duplicate memories via embedding similarity
       and surfaces them as proposals. Phase 5a does NOT auto-merge.

  mnueron watch                   Background sync — keep memory in step with new chats.
       --claude-cowork              Watch the on-disk Cowork transcripts and
       [--interval <minutes>]       incrementally import new/changed sessions.
       [--ns <name>]                Default interval 5m. State at
       [--once]                     ~/.mnueron/cowork-sync.json. Ctrl+C stops it.
       Example: mnueron watch --claude-cowork
                mnueron watch --claude-cowork --interval 2 --ns elevizio
                mnueron watch --claude-cowork --once

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
  // v0.2.6 — `--claude-cowork` mode auto-imports every Cowork chat
  // transcript from ~/.claude/projects/. No positional <file>.
  if (args.includes('--claude-cowork')) {
    const { probeClaudeCowork, autoImport } = await import('./import/claude_cowork.js');
    const probeOnly = args.includes('--probe') || args.includes('--probe-only');
    const dryRun = args.includes('--dry-run');
    let ns = 'claude-cowork';
    let limit: number | undefined;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--ns' && args[i + 1]) ns = args[++i];
      else if (args[i] === '--limit' && args[i + 1]) {
        const n = Number(args[++i]);
        if (Number.isFinite(n) && n > 0) limit = Math.floor(n);
      }
    }
    const probe = probeClaudeCowork();
    console.log('🧠  Claude Cowork probe');
    if (probe.scannedRoots.length > 0) {
      console.log(`    Scanned ${probe.scannedRoots.length} root(s):`);
      for (const r of probe.scannedRoots) console.log(`      - ${r}`);
    } else {
      console.log(`    Scanned 0 root(s) — none of the candidate paths exist.`);
      console.log(`    Paths attempted (${probe.pathsAttempted.length}):`);
      for (const p of probe.pathsAttempted) console.log(`      - ${p}`);
    }
    console.log(`    Cowork sessions: ${probe.sessions.length}`);
    if (probe.sessions.length > 0) {
      const preview = probe.sessions.slice(0, 5);
      console.log('    Latest sessions:');
      for (const s of preview) {
        const title = s.title ?? '(untitled)';
        const kb = (s.sizeBytes / 1024).toFixed(1);
        console.log(`      • ${title} — ${s.messageCount} msgs, ${kb} KB  [${s.sessionId.slice(0, 8)}…]`);
      }
      if (probe.sessions.length > preview.length) {
        console.log(`      … and ${probe.sessions.length - preview.length} more`);
      }
    }
    for (const h of probe.hints) console.log(`    ${h}`);

    if (probeOnly) {
      console.log('  (--probe mode — not importing anything)');
      return;
    }
    if (!probe.found || probe.sessions.length === 0) {
      console.error('✗ Nothing to import.');
      process.exit(1);
    }

    try {
      const provider = makeProvider(loadConfig());
      const result = await autoImport(provider, ns, { dryRun, limit });
      await provider.close();
      if (dryRun) {
        console.log(`  (--dry-run) Would import ${result.parsed} session(s), ` +
          `skip ${result.empty} empty, into namespace "${ns}".`);
      } else {
        console.log(`✓ Imported ${result.parsed} / ${result.totalSessions} session(s)`);
        console.log(`  Saved ${result.saved} memory item(s), empty ${result.empty}, errors ${result.errors}`);
        console.log(`  Namespace: "${ns}". Re-runs are idempotent (source_ref dedup).`);
      }
    } catch (e) {
      console.error(`✗ ${(e as Error).message}`);
      process.exit(1);
    }
    return;
  }

  // v0.2.5 — `--claude-desktop` mode probes for and auto-imports the
  // user's locally-installed Claude Desktop export. No positional <file>.
  if (args.includes('--claude-desktop')) {
    const { probeClaudeDesktop, autoImport } = await import('./import/claude_desktop.js');
    const probeOnly = args.includes('--probe') || args.includes('--probe-only');
    let ns = 'claude-desktop';
    let dirOverride: string | null = null;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--ns' && args[i + 1]) ns = args[++i];
      else if (args[i] === '--dir' && args[i + 1]) dirOverride = args[++i];
    }
    const probe = probeClaudeDesktop();
    console.log('🧠  Claude Desktop probe');
    console.log(`    Location: ${probe.path ?? 'NOT FOUND'}`);
    if (!probe.path) {
      console.log('    Paths tried:');
      for (const p of probe.pathsAttempted) console.log(`      - ${p}`);
    } else {
      console.log(`    Contents: ${probe.contents.length} entries`);
    }
    if (probe.exportCandidates.length > 0) {
      console.log('    Export candidates:');
      for (const e of probe.exportCandidates) console.log(`      • ${e}`);
    }
    if (probe.hints.length > 0) {
      console.log('    Notes:');
      for (const h of probe.hints) console.log(`      ${h}`);
    }
    if (probeOnly) {
      console.log('  (--probe mode — not importing anything)');
      return;
    }
    if (dirOverride) {
      console.log(`  --dir ${dirOverride}: custom-path import not yet implemented; use Settings → Privacy → Export data.`);
      return;
    }
    try {
      const provider = makeProvider(loadConfig());
      const result = await autoImport(provider, ns);
      await provider.close();
      console.log(`✓ Imported from ${result.path}`);
      console.log(`  Saved ${result.saved}, errors ${result.errors}, namespace="${ns}"`);
    } catch (e) {
      console.error(`✗ ${(e as Error).message}`);
      process.exit(1);
    }
    return;
  }

  if (args.length === 0) {
    console.error('Usage: mnueron import <file> [--ns <namespace>] [--format claude|openai]');
    console.error('       mnueron import --claude-desktop [--probe] [--ns <namespace>]');
    console.error('       mnueron import --claude-cowork  [--probe] [--ns <namespace>] [--limit N] [--dry-run]');
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

async function cmdRechunk(args: string[]) {
  let threshold = 6000;
  let keepOriginal = false;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--threshold' && args[i + 1]) {
      threshold = parseInt(args[++i], 10) || 6000;
    } else if (args[i] === '--keep-original') {
      keepOriginal = true;
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    }
  }

  const provider = makeProvider(loadConfig()) as any;
  if (typeof provider.findOversizedMemories !== 'function') {
    console.error('rechunk only supported in local mode.');
    process.exit(1);
  }

  const rows = provider.findOversizedMemories(threshold);
  if (rows.length === 0) {
    console.log(`\n  ✓ No memories larger than ${threshold} chars. Nothing to do.\n`);
    await provider.close();
    return;
  }

  // Sum bytes for the report
  const totalChars = rows.reduce((s: number, r: any) => s + (r.content?.length ?? 0), 0);
  console.log(`\n  🔪  Rechunk plan`);
  console.log(`      ${rows.length} memories over ${threshold} chars`);
  console.log(`      total content: ${(totalChars / 1024).toFixed(1)} KB`);
  console.log(`      strategy: transcript-aware split (per-turn) with sliding-window fallback`);
  console.log(`      mode: ${dryRun ? 'DRY RUN (no writes)' : keepOriginal ? 'split + keep originals' : 'split + delete originals'}\n`);

  const { chunkContent } = await import('./store/chunking.js');

  let oversize = 0, chunksMade = 0, deleted = 0, errors = 0;
  for (const row of rows) {
    oversize++;
    const chunks = chunkContent(row.content);
    if (chunks.length < 2) {
      // Couldn't split — content has no transcript shape AND fits the
      // sliding window. Skip rather than create a single useless duplicate.
      continue;
    }
    process.stdout.write(`  [${oversize}/${rows.length}] ${row.id.slice(0, 8)}… → ${chunks.length} chunks`);

    if (dryRun) {
      console.log(' (dry run)');
      continue;
    }

    try {
      const tags = JSON.parse(row.tags_json ?? '[]');
      const meta = row.meta_json ? JSON.parse(row.meta_json) : {};
      const parentRef = row.source_ref ?? `chunked:${row.id}`;

      // Build inputs for bulkSave
      const inputs = chunks.map((c, i) => ({
        content: c.content,
        namespace: row.namespace,
        tags: [...tags, 'chunk', 'rechunked', ...(c.role ? [`role:${c.role}`] : [])],
        source: row.source,
        source_ref: parentRef,
        metadata: {
          ...meta,
          parent_ref: parentRef,
          chunk_index: i,
          chunk_count: chunks.length,
          ...(c.role ? { role: c.role } : {}),
          original_id: row.id,
          original_created_at: row.created_at,
        },
      }));

      await provider.bulkSave(inputs);
      chunksMade += chunks.length;

      if (!keepOriginal) {
        await provider.delete(row.id);
        deleted++;
      }
      console.log(' ✓');
    } catch (e: any) {
      errors++;
      console.log(` ✗ ${e?.message ?? e}`);
    }
  }

  console.log(`\n  Done.`);
  console.log(`      ${chunksMade} new chunked memories created`);
  if (!dryRun && !keepOriginal) console.log(`      ${deleted} originals deleted`);
  if (errors > 0) console.log(`      ${errors} errors`);
  console.log(`\n  Next: run 'mnueron rebuild-embeddings' so the new chunks have vectors.\n`);
  await provider.close();
}

async function cmdPlugin(args: string[]) {
  const action = args[0] ?? 'list';
  const name = args[1];

  const { listEnabledPlugins, enablePlugin, disablePlugin } = await import('./plugins/loader.js');

  switch (action) {
    case 'list': {
      const enabled = await listEnabledPlugins();
      if (enabled.length === 0) {
        console.log('No plugins enabled. Try:');
        console.log('  npm install -g mnueron-plugin-redact-pii    # install');
        console.log('  mnueron plugin enable mnueron-plugin-redact-pii');
        return;
      }
      console.log(`Enabled plugins (${enabled.length}):`);
      for (const n of enabled) {
        // Check whether the plugin's npm package is actually resolvable.
        let resolved: string | null = null;
        try {
          const { createRequire } = await import('node:module');
          const require = createRequire(import.meta.url);
          resolved = require.resolve(n + '/package.json');
        } catch { /* not installed */ }
        const status = resolved ? '✓ installed' : '✗ NOT installed (npm install ' + n + ')';
        console.log(`  ${n.padEnd(40)}  ${status}`);
      }
      return;
    }
    case 'enable':
    case 'add': {
      if (!name) {
        console.error('Usage: mnueron plugin enable <name>');
        process.exit(1);
      }
      await enablePlugin(name);
      console.log(`✓ Enabled ${name} in ~/.mnueron/config.json`);
      // Check whether it's installed; warn if not.
      try {
        const { createRequire } = await import('node:module');
        const require = createRequire(import.meta.url);
        require.resolve(name + '/package.json');
        console.log('  Plugin package is installed — will activate on next MCP server start.');
      } catch {
        console.log(`  Plugin package is NOT installed yet. Run:`);
        console.log(`    npm install -g ${name}`);
      }
      console.log(`  Restart any running mnueron processes (Claude Code, dashboard) to pick it up.`);
      return;
    }
    case 'disable':
    case 'remove': {
      if (!name) {
        console.error('Usage: mnueron plugin disable <name>');
        process.exit(1);
      }
      await disablePlugin(name);
      console.log(`✓ Disabled ${name} in ~/.mnueron/config.json`);
      console.log(`  Restart any running mnueron processes to drop it.`);
      return;
    }
    default:
      console.error(`Unknown action "${action}". Try: list | enable | disable | add | remove`);
      process.exit(1);
  }
}

async function cmdMigrateToHosted(args: string[]) {
  let url = '';
  let token = '';
  let batch = 100;
  let namespace: string | undefined;
  let dryRun = false;
  let noFlip = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url' && args[i + 1]) url = args[++i];
    else if (args[i] === '--token' && args[i + 1]) token = args[++i];
    else if (args[i] === '--batch' && args[i + 1]) batch = parseInt(args[++i], 10) || 100;
    else if (args[i] === '--namespace' && args[i + 1]) namespace = args[++i];
    else if (args[i] === '--dry-run') dryRun = true;
    else if (args[i] === '--no-flip') noFlip = true;
  }

  if (!url || !token) {
    console.error(`Usage: mnueron migrate-to-hosted --url <https://api.mnueron.com> --token <mnu_...>`);
    console.error(`Tip: sign up at the hosted dashboard to get your token, then paste here.`);
    process.exit(1);
  }

  // We migrate FROM local. Force local mode regardless of env vars so the
  // user can't accidentally migrate hosted-to-hosted.
  process.env.MNUERON_API_URL = '';
  process.env.MNUERON_API_TOKEN = '';
  const cfg = loadConfig();
  if (cfg.mode !== 'local') {
    console.error('migrate-to-hosted reads FROM local mode. Got mode=' + cfg.mode);
    process.exit(1);
  }
  const provider = makeProvider(cfg);

  // Pull every memory from local
  const namespaces = await provider.namespaces();
  const total = namespace
    ? (namespaces.find(n => n.name === namespace)?.count ?? 0)
    : namespaces.reduce((s, n) => s + n.count, 0);

  console.log(`\n  🚀  mnueron migrate-to-hosted`);
  console.log(`      source:  local SQLite (${total} memories${namespace ? ` in namespace ${namespace}` : ''})`);
  console.log(`      target:  ${url}`);
  console.log(`      batch:   ${batch}`);
  console.log(`      mode:    ${dryRun ? 'DRY RUN (no writes)' : 'live upload'}\n`);

  if (total === 0) {
    console.log(`  Nothing to migrate.`);
    await provider.close();
    return;
  }

  // Ping the target first
  if (!dryRun) {
    try {
      const ping = await fetch(`${url.replace(/\/+$/, '')}/health`);
      if (!ping.ok) throw new Error(`/health returned ${ping.status}`);
    } catch (e: any) {
      console.error(`Cannot reach ${url}/health: ${e.message}`);
      console.error(`Check the URL and that the hosted backend is running.`);
      await provider.close();
      process.exit(1);
    }
  }

  // Stream memories in chunks of `batch`, oldest first, so the hosted side
  // ends up with chronological order in dashboards.
  let cursor: number | undefined;
  let uploaded = 0, failed = 0;
  const start = Date.now();

  while (true) {
    const page = await provider.list({
      namespace,
      limit: batch,
      before: cursor,
    });
    if (page.length === 0) break;
    // list() returns DESC; we want to upload oldest first, but the hosted
    // side will reorder on display anyway, so just upload as-is.

    if (!dryRun) {
      try {
        const items = page.map(m => ({
          content: m.content,
          namespace: m.namespace,
          tags: m.tags,
          source: m.source,
          source_ref: m.source_ref,
          metadata: m.metadata,
        }));
        const res = await fetch(`${url.replace(/\/+$/, '')}/v1/memories/bulk`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ items }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`${res.status} ${res.statusText}${body ? `: ${body.slice(0, 200)}` : ''}`);
        }
        const data: any = await res.json().catch(() => ({}));
        uploaded += (data.saved ?? page.length);
        failed += (data.errors ?? 0);
      } catch (e: any) {
        failed += page.length;
        console.error(`  batch failed at cursor=${cursor}: ${e.message}`);
        // Stop on transport error so we don't retry forever
        if (`${e.message}`.includes('ECONNREFUSED') || `${e.message}`.includes('Cannot reach')) break;
      }
    } else {
      uploaded += page.length;
    }

    cursor = page[page.length - 1].created_at;
    const pct = Math.round((uploaded + failed) / total * 100);
    process.stdout.write(`\r  [${'█'.repeat(Math.floor(pct / 4)).padEnd(25, '░')}] ${pct}%  ${uploaded + failed}/${total}`);

    if (page.length < batch) break;
  }
  process.stdout.write('\n');

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n  ✓ Done in ${elapsed}s — ${uploaded} uploaded${failed ? `, ${failed} failed` : ''}.\n`);

  if (!dryRun && !noFlip && failed === 0) {
    await writeActiveProvider(url, token);
    console.log(`  🔁  Active provider switched to hosted.`);
    console.log(`      ~/.mnueron/config.json updated with MNUERON_API_URL + MNUERON_API_TOKEN.`);
    console.log(`      Restart any running mnueron processes (Claude Code, dashboard) to pick up the change.\n`);
  } else if (noFlip) {
    console.log(`  ℹ️  --no-flip set: active provider stays on local.`);
    console.log(`      Set MNUERON_API_URL=${url} and MNUERON_API_TOKEN=<your token> in your shell when ready.\n`);
  }

  await provider.close();
}

async function writeActiveProvider(url: string, token: string) {
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = join(homedir(), '.mnueron');
  await mkdir(dir, { recursive: true });
  const configPath = join(dir, 'config.json');
  let existing: any = {};
  try {
    const { readFile } = await import('node:fs/promises');
    existing = JSON.parse(await readFile(configPath, 'utf8'));
  } catch { /* fresh */ }
  existing.apiUrl = url;
  existing.apiToken = token;
  await writeFile(configPath, JSON.stringify(existing, null, 2), 'utf8');
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

// ─────────────────────────────────────────────────────────────────────────
// `mnueron primer` — print a markdown context primer for CLAUDE.md /
//                   .cursorrules / .windsurfrules / etc.
//
// Usage:
//   mnueron primer                       → write to stdout
//   mnueron primer > CLAUDE.md           → redirect to project root
//   mnueron primer --out CLAUDE.md       → same, no shell redirect
//   mnueron primer --ns work --recent 20 → scope + sample size
//
// Why this exists:
//   MCP-aware tools (Claude Desktop, Cursor, Claude Code, Windsurf, Cline)
//   ALREADY see mnueron's tools because of `mnueron setup`. The problem is
//   the AI doesn't always KNOW to call memory_recall. Dropping this primer
//   in a project root gives the AI an explicit invite + a sketch of what's
//   in your store, so it pulls context proactively.
// ─────────────────────────────────────────────────────────────────────────
async function cmdPrimer(args: string[]) {
  let ns: string | undefined;
  let recent = 12;
  let outFile: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--ns' && args[i + 1]) ns = args[++i];
    else if (args[i] === '--recent' && args[i + 1]) {
      const n = parseInt(args[++i], 10);
      if (Number.isFinite(n) && n > 0) recent = Math.min(n, 50);
    } else if (args[i] === '--out' && args[i + 1]) {
      outFile = args[++i];
    }
  }

  const provider = makeProvider(loadConfig());
  try {
    const allNs = await provider.namespaces();
    const filteredNs = ns ? allNs.filter((n) => n.name === ns) : allNs;
    const totalCount = filteredNs.reduce((s, n) => s + n.count, 0);
    const recentList = await provider.list({ namespace: ns, limit: recent });

    const primer = renderPrimer({
      namespaces: filteredNs,
      totalCount,
      recent: recentList,
      scope: ns,
    });

    if (outFile) {
      await writeFile(outFile, primer, 'utf8');
      // stderr so it doesn't pollute redirected output.
      process.stderr.write(`Wrote primer to ${outFile}\n`);
    } else {
      process.stdout.write(primer);
    }
  } finally {
    await provider.close();
  }
}

function renderPrimer(input: {
  namespaces: Array<{ name: string; count: number; last_updated: number }>;
  totalCount: number;
  recent: Array<{ id: string; namespace: string; content: string; created_at: number; metadata?: any }>;
  scope?: string;
}): string {
  const { namespaces, totalCount, recent, scope } = input;
  const lines: string[] = [];

  lines.push('# Project context — mnueron memory');
  lines.push('');
  lines.push(
    'You have access to **mnueron** memory tools via the Model Context Protocol. ' +
    'Use them PROACTIVELY — do not wait for the user to ask explicitly:',
  );
  lines.push('');
  lines.push(
    '- **`memory_recall`** — search the user’s memory store before answering any ' +
    'question that references past context, prior decisions, project conventions, ' +
    'or specific user preferences. Call it FIRST when the user uses vague references ' +
    '("the auth approach", "that bug we hit", "what did we decide about X").',
  );
  lines.push(
    '- **`memory_save`** — store anything worth remembering: decisions, preferences, ' +
    'finicky API details, project conventions, user-specific facts. Don’t over-save ' +
    '— prefer specific, durable facts over conversational chatter.',
  );
  lines.push(
    '- **`memory_list`** — browse by namespace when the user asks ' +
    '"what did we do last week?" or "summarize my recent context".',
  );
  lines.push(
    '- **`memory_get_thread`** — pull all chunks of a multi-turn conversation by ' +
    'its `parent_ref` when the user references one.',
  );
  lines.push('');
  lines.push(
    '**Heuristic:** if the user’s message would be easier to answer with prior ' +
    'context AND you have access to a memory layer, call recall first. The latency ' +
    'cost is small; the quality gain is large.',
  );
  lines.push('');

  // ── Store overview ──
  const scopeLabel = scope ? ` (scoped to \`${scope}\`)` : '';
  lines.push(`## Memory store overview${scopeLabel}`);
  lines.push('');
  lines.push(`- **${totalCount}** memories across **${namespaces.length}** namespace${namespaces.length === 1 ? '' : 's'}.`);
  lines.push('');
  if (namespaces.length > 0) {
    lines.push('| Namespace | Memories | Last updated |');
    lines.push('| --- | ---: | --- |');
    for (const n of namespaces.slice(0, 20)) {
      const date = n.last_updated ? new Date(n.last_updated).toISOString().slice(0, 10) : '—';
      lines.push(`| \`${n.name}\` | ${n.count} | ${date} |`);
    }
    if (namespaces.length > 20) {
      lines.push(`| … and ${namespaces.length - 20} more | | |`);
    }
    lines.push('');
  }

  // ── Recent anchors ──
  if (recent.length > 0) {
    lines.push('## Recent memory anchors');
    lines.push('');
    lines.push(
      'A small sample of what’s in the store — useful as a sanity check that ' +
      '`memory_recall` is hitting the right slice when you call it.',
    );
    lines.push('');
    for (const m of recent.slice(0, 15)) {
      const title =
        (m.metadata && typeof m.metadata === 'object' && (m.metadata as any).title) ||
        m.content.replace(/\s+/g, ' ').slice(0, 90) ||
        '(empty)';
      const date = new Date(m.created_at).toISOString().slice(0, 10);
      lines.push(`- ${date} · \`${m.namespace}\` · ${title}${title.length === 90 ? '…' : ''}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(
    '_Generated by `mnueron primer`. Re-run when your memory store changes ' +
    'substantially. Safe to check this file into git — it contains no secrets._',
  );
  lines.push('');

  return lines.join('\n');
}

/**
 * P2.4 — retroactive entity extraction for the local SQLite store.
 *
 * For each existing memory:
 *   1. Skip if metadata.entities already exists (unless --force).
 *   2. Extract entities via Haiku/OpenAI (whichever env key is set).
 *   3. Stamp the extracted list into metadata.entities via provider.update().
 *
 * Note: this only does P1 (extraction) for local. Cross-session entity
 * resolution (P2) on local SQLite is deferred — entities here are saved
 * as standalone lists per-memory without canonical_id linking yet.
 * Hosted-mode users get the full P1+P2 pipeline via /api/entities/backfill.
 */
async function cmdExtractEntities(args: string[]) {
  let ns: string | undefined;
  let since: number | undefined;
  let limit = 100;
  let force = false;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--ns' && args[i + 1]) ns = args[++i];
    else if (a === '--since' && args[i + 1]) since = parseInt(args[++i], 10);
    else if (a === '--limit' && args[i + 1]) {
      const v = parseInt(args[++i], 10);
      if (Number.isFinite(v)) limit = Math.max(1, Math.min(1000, v));
    } else if (a === '--force') force = true;
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: mnueron extract-entities [--ns <name>] [--since <epoch_ms>]\n' +
          '                                [--limit <n>] [--force] [--dry-run]',
      );
      return;
    }
  }

  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    console.error(
      'mnueron extract-entities requires ANTHROPIC_API_KEY or OPENAI_API_KEY in the environment.',
    );
    process.exit(1);
  }

  const provider = makeProvider(loadConfig());
  // update() is optional on the Provider interface — bail early with a
  // clear error so TypeScript narrows it for the rest of this function.
  if (typeof provider.update !== 'function') {
    console.error('This provider does not support memory.update — cannot persist extracted entities.');
    process.exit(1);
  }
  const updateFn = provider.update.bind(provider);
  try {
    // Pull candidates newest-first. The provider's list() honors namespace
    // and date filters and returns memories with their metadata.
    const memories = await provider.list({
      namespace: ns,
      created_after: since,
      limit,
      offset: 0,
    });

    if (memories.length === 0) {
      console.log('No memories matched. Nothing to do.');
      return;
    }

    console.log(
      `Found ${memories.length} candidate memor${memories.length === 1 ? 'y' : 'ies'}${ns ? ` in namespace "${ns}"` : ''}.`,
    );

    if (dryRun) {
      let withEntities = 0;
      for (const m of memories) {
        const meta = (m.metadata ?? {}) as Record<string, unknown>;
        if (Array.isArray(meta.entities) && (meta.entities as unknown[]).length > 0) {
          withEntities += 1;
        }
      }
      console.log(
        `[dry-run] Would extract for ${memories.length - withEntities} memories ` +
          `(skipping ${withEntities} that already have entities; pass --force to override).`,
      );
      return;
    }

    let processed = 0;
    let extracted = 0;
    let skipped = 0;
    let errors = 0;

    for (const m of memories) {
      const meta = (m.metadata ?? {}) as Record<string, unknown>;
      const hasExisting =
        Array.isArray(meta.entities) && (meta.entities as unknown[]).length > 0;
      if (hasExisting && !force) {
        skipped += 1;
        process.stdout.write('.');
        continue;
      }
      try {
        const ents = await extractEntities(m.content, {});
        processed += 1;
        if (ents.length === 0) {
          process.stdout.write('-');
          continue;
        }
        extracted += ents.length;
        // Merge into existing metadata; overwrite the entities key.
        await updateFn(m.id, {
          metadata: { ...meta, entities: ents },
        });
        process.stdout.write('+');
      } catch (e) {
        errors += 1;
        process.stdout.write('x');
        console.warn(
          '\n[extract-entities] memory',
          m.id,
          'failed:',
          e instanceof Error ? e.message : e,
        );
      }
    }

    process.stdout.write('\n');
    console.log(
      `extract-entities done — extracted=${extracted} processed=${processed} skipped=${skipped} errors=${errors}`,
    );
  } catch (e) {
    console.error('extract-entities failed:', e);
    process.exit(1);
  }
}

/**
 * P2.3 — `mnueron entities <list|show|merge>`
 *
 * Surfaces canonical entities the resolver has built up. Three subcommands:
 *
 *   list   — table view of entities, filtered by type / sorted by recent
 *            / most-mentioned / alphabetical.
 *   show   — full detail for one entity, including the linked memories.
 *   merge  — collapse two duplicate canonicals into one (winner keeps id;
 *            loser's memories + aliases absorbed into winner).
 *
 * All three only work with the local SQLite provider — hosted entity
 * resolution lives on the mnueron.com backend and the SDK's `entities`
 * namespace is the way to talk to it.
 */
async function cmdEntities(args: string[]) {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'list':  return cmdEntitiesList(rest);
    case 'show':  return cmdEntitiesShow(rest);
    case 'merge': return cmdEntitiesMerge(rest);
    case undefined:
    case '--help':
    case '-h':
      console.log(
        'Usage:\n' +
          '  mnueron entities list   [--type <t>] [--q <substr>] [--sort recent|mentions|alpha] [--limit <n>]\n' +
          '  mnueron entities show   <entity-id>  [--memories <n>]\n' +
          '  mnueron entities merge  --winner <id> --loser <id>\n\n' +
          'Examples:\n' +
          '  mnueron entities list --type person --sort mentions\n' +
          '  mnueron entities show ent-abc123 --memories 50\n' +
          '  mnueron entities merge --winner ent-abc --loser ent-def',
      );
      return;
    default:
      console.error(`Unknown entities subcommand: ${sub}`);
      process.exit(1);
  }
}

async function cmdEntitiesList(args: string[]) {
  let type: string | undefined;
  let q: string | undefined;
  let sort: 'recent' | 'mentions' | 'alpha' = 'recent';
  let limit = 50;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--type' && args[i + 1]) type = args[++i];
    else if (a === '--q' && args[i + 1]) q = args[++i];
    else if (a === '--sort' && args[i + 1]) {
      const s = args[++i];
      if (s === 'recent' || s === 'mentions' || s === 'alpha') sort = s;
    } else if (a === '--limit' && args[i + 1]) {
      const v = parseInt(args[++i], 10);
      if (Number.isFinite(v)) limit = Math.max(1, Math.min(500, v));
    }
  }

  const provider = makeProvider(loadConfig());
  if (typeof provider.listEntities !== 'function') {
    console.error('This provider does not support entities (hosted-only — use the SDK / dashboard).');
    process.exit(1);
  }

  const entities = await provider.listEntities({ type, q, sort, limit });
  if (entities.length === 0) {
    console.log('No entities yet. Save some memories with entity extraction enabled and they\'ll appear here.');
    return;
  }
  // Pretty table. Truncate display_name + alias preview so 80-col terminals stay clean.
  const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const fmt = (d: number) => new Date(d).toISOString().slice(0, 10);
  console.log(
    'id'.padEnd(38) +
      'type'.padEnd(14) +
      'name'.padEnd(30) +
      'mentions'.padStart(10) +
      '  last seen',
  );
  console.log('-'.repeat(110));
  for (const e of entities) {
    console.log(
      e.id.padEnd(38) +
        trunc(e.entity_type, 12).padEnd(14) +
        trunc(e.display_name, 28).padEnd(30) +
        String(e.mention_count).padStart(10) +
        '  ' +
        fmt(e.last_seen_at),
    );
  }
  console.log(`\n${entities.length} entit${entities.length === 1 ? 'y' : 'ies'} shown.`);
}

async function cmdEntitiesShow(args: string[]) {
  const id = args.find((a) => !a.startsWith('--'));
  if (!id) {
    console.error('Usage: mnueron entities show <entity-id> [--memories <n>]');
    process.exit(1);
  }
  let memLimit = 20;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--memories' && args[i + 1]) {
      const v = parseInt(args[++i], 10);
      if (Number.isFinite(v)) memLimit = Math.max(1, Math.min(200, v));
    }
  }

  const provider = makeProvider(loadConfig());
  if (typeof provider.getEntity !== 'function' || typeof provider.getEntityMemories !== 'function') {
    console.error('This provider does not support entities.');
    process.exit(1);
  }

  const entity = await provider.getEntity(id);
  if (!entity) {
    console.error(`Entity not found: ${id}`);
    process.exit(1);
  }

  console.log(`# ${entity.display_name}`);
  console.log(`  id:            ${entity.id}`);
  console.log(`  type:          ${entity.entity_type}`);
  console.log(`  mentions:      ${entity.mention_count}`);
  console.log(`  first seen:    ${new Date(entity.first_seen_at).toISOString()}`);
  console.log(`  last seen:     ${new Date(entity.last_seen_at).toISOString()}`);
  if (entity.aliases.length > 0) {
    console.log(`  aliases:       ${entity.aliases.join(', ')}`);
  }

  const memories = await provider.getEntityMemories(entity.id, memLimit);
  console.log(`\n## Linked memories (${memories.length}${memories.length >= memLimit ? '+' : ''})`);
  for (const m of memories) {
    const date = new Date(m.created_at).toISOString().slice(0, 10);
    const preview = m.content.replace(/\s+/g, ' ').slice(0, 100);
    const conf = m.confidence === 1 ? 'exact' : m.confidence.toFixed(2);
    console.log(`  - [${date}] (${conf}) "${m.surface_form}" — ${preview}${m.content.length > 100 ? '…' : ''}`);
    console.log(`      memory: ${m.id}  ns: ${m.namespace}`);
  }
}

async function cmdEntitiesMerge(args: string[]) {
  let winner: string | undefined;
  let loser: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--winner' && args[i + 1]) winner = args[++i];
    else if (args[i] === '--loser' && args[i + 1]) loser = args[++i];
  }
  if (!winner || !loser) {
    console.error('Usage: mnueron entities merge --winner <id> --loser <id>');
    process.exit(1);
  }
  if (winner === loser) {
    console.error('Winner and loser must be different entities.');
    process.exit(1);
  }

  const provider = makeProvider(loadConfig());
  if (typeof provider.mergeEntities !== 'function') {
    console.error('This provider does not support entities.');
    process.exit(1);
  }
  const merged = await provider.mergeEntities(winner, loser);
  if (!merged) {
    console.error('Merge failed — one or both entities not found.');
    process.exit(1);
  }
  console.log(`✅ Merged. Winner: ${merged.display_name} (${merged.id})`);
  console.log(`   aliases now:  ${merged.aliases.join(', ')}`);
  console.log(`   mention count: ${merged.mention_count}`);
}

/**
 * P3 + P4 — `mnueron graph <show|traverse|relations>`
 *
 *   show <entity-id>             — overview: entity + its direct relations.
 *   traverse <entity-id>         — BFS out to --depth hops (default 2).
 *   relations [--from <id>] [--to <id>] [--predicate <p>] [--as-of <iso>]
 *                                — raw edge query. Useful for scripting.
 *
 * All three accept `--as-of <ISO-date>` for bi-temporal queries: "what
 * relationships were valid at that point in time?" Falls through to "all
 * relations" when --as-of isn't passed.
 */
async function cmdGraph(args: string[]) {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'show':      return cmdGraphShow(rest);
    case 'traverse':  return cmdGraphTraverse(rest);
    case 'relations': return cmdGraphRelations(rest);
    case undefined:
    case '--help':
    case '-h':
      console.log(
        'Usage:\n' +
          '  mnueron graph show <entity-id> [--as-of <ISO-date>]\n' +
          '  mnueron graph traverse <entity-id> [--depth <n>] [--as-of <ISO-date>]\n' +
          '  mnueron graph relations [--from <id>] [--to <id>] [--predicate <p>] [--as-of <ISO-date>] [--limit <n>]\n\n' +
          'The --as-of flag enables bi-temporal recall ("what was true at that date").\n' +
          'Example: mnueron graph traverse ent-john --depth 3 --as-of 2025-04-01',
      );
      return;
    default:
      console.error(`Unknown graph subcommand: ${sub}`);
      process.exit(1);
  }
}

/** Parse --as-of <ISO> into epoch ms, or undefined when absent. */
function parseAsOf(args: string[]): number | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--as-of' && args[i + 1]) {
      const t = Date.parse(args[i + 1]);
      if (!Number.isFinite(t)) {
        console.error(`Invalid --as-of date: ${args[i + 1]}`);
        process.exit(1);
      }
      return t;
    }
  }
  return undefined;
}

async function cmdGraphShow(args: string[]) {
  const id = args.find((a) => !a.startsWith('--'));
  if (!id) {
    console.error('Usage: mnueron graph show <entity-id> [--as-of <ISO-date>]');
    process.exit(1);
  }
  const asOf = parseAsOf(args);

  const provider = makeProvider(loadConfig());
  if (
    typeof provider.getEntity !== 'function' ||
    typeof provider.getRelations !== 'function'
  ) {
    console.error('This provider does not support the knowledge graph.');
    process.exit(1);
  }

  const entity = await provider.getEntity(id);
  if (!entity) {
    console.error(`Entity not found: ${id}`);
    process.exit(1);
  }
  console.log(`# ${entity.display_name}  (${entity.entity_type})`);
  console.log(`  id: ${entity.id}`);
  if (asOf) console.log(`  as of: ${new Date(asOf).toISOString()}`);

  const outgoing = await provider.getRelations({ fromEntityId: id, asOf, limit: 200 });
  const incoming = await provider.getRelations({ toEntityId: id,  asOf, limit: 200 });

  console.log(`\n## Outgoing (${outgoing.length})`);
  for (const rel of outgoing) {
    const target = await provider.getEntity!(rel.to_entity_id);
    const targetName = target?.display_name ?? rel.to_entity_id;
    console.log(`  -[${rel.predicate}]-> ${targetName}  (conf ${rel.confidence.toFixed(2)}${formatWindow(rel)})`);
  }

  console.log(`\n## Incoming (${incoming.length})`);
  for (const rel of incoming) {
    const source = await provider.getEntity!(rel.from_entity_id);
    const sourceName = source?.display_name ?? rel.from_entity_id;
    console.log(`  ${sourceName} -[${rel.predicate}]-> ${entity.display_name}  (conf ${rel.confidence.toFixed(2)}${formatWindow(rel)})`);
  }
}

async function cmdGraphTraverse(args: string[]) {
  const id = args.find((a) => !a.startsWith('--'));
  if (!id) {
    console.error('Usage: mnueron graph traverse <entity-id> [--depth <n>] [--as-of <ISO-date>]');
    process.exit(1);
  }
  let depth = 2;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--depth' && args[i + 1]) {
      const v = parseInt(args[++i], 10);
      if (Number.isFinite(v)) depth = Math.max(0, Math.min(5, v));
    }
  }
  const asOf = parseAsOf(args);

  const provider = makeProvider(loadConfig());
  if (typeof provider.traverseGraph !== 'function') {
    console.error('This provider does not support the knowledge graph.');
    process.exit(1);
  }
  const hops = await provider.traverseGraph(id, { depth, asOf });
  if (hops.length === 0) {
    console.error(`Entity not found: ${id}`);
    process.exit(1);
  }
  console.log(`# Traversal from ${hops[0].entity.display_name}  depth=${depth}${asOf ? `  as-of=${new Date(asOf).toISOString()}` : ''}`);
  for (const hop of hops) {
    const indent = '  '.repeat(hop.depth);
    if (hop.depth === 0) {
      console.log(`${indent}● ${hop.entity.display_name} (${hop.entity.entity_type})`);
    } else {
      const arrow = hop.direction === 'out' ? '→' : '←';
      const pred = hop.via?.predicate ?? '?';
      console.log(`${indent}${arrow} [${pred}] ${hop.entity.display_name} (${hop.entity.entity_type})${formatWindow(hop.via)}`);
    }
  }
  console.log(`\n${hops.length} node${hops.length === 1 ? '' : 's'} visited.`);
}

async function cmdGraphRelations(args: string[]) {
  let from: string | undefined;
  let to: string | undefined;
  let predicate: string | undefined;
  let limit = 100;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--from' && args[i + 1]) from = args[++i];
    else if (args[i] === '--to' && args[i + 1]) to = args[++i];
    else if (args[i] === '--predicate' && args[i + 1]) predicate = args[++i];
    else if (args[i] === '--limit' && args[i + 1]) {
      const v = parseInt(args[++i], 10);
      if (Number.isFinite(v)) limit = Math.max(1, Math.min(1000, v));
    }
  }
  const asOf = parseAsOf(args);

  const provider = makeProvider(loadConfig());
  if (typeof provider.getRelations !== 'function') {
    console.error('This provider does not support the knowledge graph.');
    process.exit(1);
  }
  const rels = await provider.getRelations({ fromEntityId: from, toEntityId: to, predicate, asOf, limit });
  console.log(JSON.stringify(rels, null, 2));
}

/** Human-readable validity window: " (valid 2022→2025)" or "" if none. */
function formatWindow(rel: { valid_from: number | null; valid_to: number | null } | null | undefined): string {
  if (!rel) return '';
  if (rel.valid_from == null && rel.valid_to == null) return '';
  const f = rel.valid_from ? new Date(rel.valid_from).toISOString().slice(0, 10) : '?';
  const t = rel.valid_to   ? new Date(rel.valid_to).toISOString().slice(0, 10)   : 'now';
  return `  (${f}→${t})`;
}

/**
 * P5 — `mnueron consolidate <detect|review|list|approve|reject>`
 *
 * Phase 5a is detection-only — no automatic mutation of memories. The
 * detector finds likely-duplicate pairs via embedding similarity and
 * enqueues them as proposals. The user reviews from the dashboard or
 * via these CLI commands.
 *
 *   detect              run the duplicate scan
 *   list                show pending proposals
 *   approve <id>        mark approved (5b will act on this; 5a just records the decision)
 *   reject  <id>        mark rejected
 */
async function cmdConsolidate(args: string[]) {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'detect':   return cmdConsolidateDetect(rest);
    case 'list':     return cmdConsolidateList(rest);
    case 'approve':  return cmdConsolidateReview(rest, 'approved');
    case 'reject':   return cmdConsolidateReview(rest, 'rejected');
    case undefined:
    case '--help':
    case '-h':
      console.log(
        'Usage:\n' +
          '  mnueron consolidate detect   [--limit <n>] [--threshold <0..1>] [--ns <name>]\n' +
          '  mnueron consolidate list     [--status pending|approved|rejected] [--limit <n>]\n' +
          '  mnueron consolidate approve <proposal-id>\n' +
          '  mnueron consolidate reject  <proposal-id>\n\n' +
          'Phase 5a — DETECTION ONLY. Approving a proposal records the decision\n' +
          'but does not yet merge memories. Phase 5b will action approved merges.',
      );
      return;
    default:
      console.error(`Unknown consolidate subcommand: ${sub}`);
      process.exit(1);
  }
}

async function cmdConsolidateDetect(args: string[]) {
  let limit = 200;
  let threshold: number | undefined;
  let namespace: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) {
      const v = parseInt(args[++i], 10);
      if (Number.isFinite(v)) limit = Math.max(1, Math.min(5000, v));
    } else if (args[i] === '--threshold' && args[i + 1]) {
      const v = parseFloat(args[++i]);
      if (Number.isFinite(v) && v >= 0 && v <= 1) threshold = v;
    } else if (args[i] === '--ns' && args[i + 1]) {
      namespace = args[++i];
    }
  }
  const provider = makeProvider(loadConfig());
  if (typeof provider.detectConsolidation !== 'function') {
    console.error('This provider does not support consolidation (hosted-only — use the SDK).');
    process.exit(1);
  }
  console.log(`Scanning up to ${limit} memories${namespace ? ` in namespace "${namespace}"` : ''}...`);
  const result = await provider.detectConsolidation({ limit, threshold, namespace });
  console.log(
    `consolidate detect done — scanned=${result.scanned} created=${result.proposalsCreated} already_known=${result.proposalsAlreadyKnown}`,
  );
  if (result.proposalsCreated > 0) {
    console.log(`\nRun "mnueron consolidate list" to review pending proposals.`);
  }
}

async function cmdConsolidateList(args: string[]) {
  let status: 'pending' | 'approved' | 'rejected' | undefined = 'pending';
  let limit = 50;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--status' && args[i + 1]) {
      const s = args[++i];
      if (s === 'pending' || s === 'approved' || s === 'rejected') status = s;
      else if (s === 'all') status = undefined;
    } else if (args[i] === '--limit' && args[i + 1]) {
      const v = parseInt(args[++i], 10);
      if (Number.isFinite(v)) limit = Math.max(1, Math.min(500, v));
    }
  }
  const provider = makeProvider(loadConfig());
  if (typeof provider.proposalsList !== 'function') {
    console.error('This provider does not support consolidation.');
    process.exit(1);
  }
  const props = await provider.proposalsList({ status, limit });
  if (props.length === 0) {
    console.log(`No ${status ?? ''} proposals.`);
    return;
  }
  const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  console.log(
    'id'.padEnd(38) +
      'kind'.padEnd(14) +
      'score'.padStart(6) +
      '  ' +
      'memory_a → memory_b',
  );
  console.log('-'.repeat(110));
  for (const p of props) {
    console.log(
      p.id.padEnd(38) +
        trunc(p.kind, 12).padEnd(14) +
        p.score.toFixed(2).padStart(6) +
        '  ' +
        `${p.memory_a_id.slice(0, 8)} → ${p.memory_b_id.slice(0, 8)}` +
        (p.status !== 'pending' ? `  [${p.status}]` : ''),
    );
  }
  console.log(`\n${props.length} proposal${props.length === 1 ? '' : 's'}.`);
}

async function cmdConsolidateReview(
  args: string[],
  decision: 'approved' | 'rejected',
) {
  const id = args.find((a) => !a.startsWith('--'));
  if (!id) {
    console.error(`Usage: mnueron consolidate ${decision === 'approved' ? 'approve' : 'reject'} <proposal-id>`);
    process.exit(1);
  }
  const provider = makeProvider(loadConfig());
  if (typeof provider.proposalReview !== 'function') {
    console.error('This provider does not support consolidation.');
    process.exit(1);
  }
  const updated = await provider.proposalReview(id, decision);
  if (!updated) {
    console.error(`Proposal not found: ${id}`);
    process.exit(1);
  }
  console.log(`✅ Proposal ${id} marked ${decision}.`);
}

async function cmdWatch(args: string[]) {
  // For now the only mode is `--claude-cowork`. Future modes can dispatch here.
  if (!args.includes('--claude-cowork')) {
    console.error('Usage: mnueron watch --claude-cowork [--interval <minutes>] [--ns <name>] [--once]');
    process.exit(1);
  }
  let intervalMs: number | undefined;
  let ns = 'claude-cowork';
  let once = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--interval' && args[i + 1]) {
      const n = Number(args[++i]);
      if (Number.isFinite(n) && n > 0) intervalMs = Math.floor(n * 60 * 1000);
    } else if (a === '--ns' && args[i + 1]) {
      ns = args[++i];
    } else if (a === '--once') {
      once = true;
    }
  }

  const { runCoworkWatch } = await import('./watch/cowork.js');
  const provider = makeProvider(loadConfig());
  try {
    await runCoworkWatch(provider, { intervalMs, namespace: ns, once });
  } finally {
    await provider.close();
  }
}

main().catch((e) => {
  console.error(e?.stack ?? e);
  process.exit(1);
});
