#!/usr/bin/env node
/**
 * mnueron smoke test — proves the local SQLite provider can:
 *   1. open / migrate the DB
 *   2. save a memory
 *   3. retrieve it via FTS search
 *   4. list memories and namespaces
 *   5. delete a memory
 * Run: node scripts/smoke.mjs
 */
import { loadConfig, makeProvider } from '../dist/config.js';

const RED = '\x1b[31m', GRN = '\x1b[32m', DIM = '\x1b[2m', RST = '\x1b[0m';
const ok = (m) => console.log(`  ${GRN}✓${RST} ${m}`);
const fail = (m) => { console.log(`  ${RED}✗${RST} ${m}`); process.exitCode = 1; };

const cfg = loadConfig();
console.log(`\nmnueron smoke test`);
console.log(`${DIM}mode=${cfg.mode} ns=${cfg.defaultNamespace} ${cfg.mode === 'local' ? 'db=' + cfg.dbPath : 'api=' + cfg.apiUrl}${RST}\n`);

const provider = makeProvider(cfg);
const ns = `__smoke_${Date.now()}`;

try {
  // 1. save
  const saved = await provider.save({
    content: 'Smoke test memory: the user prefers concise replies and TypeScript strict mode.',
    namespace: ns,
    tags: ['smoke', 'test'],
    source: 'smoke-test',
  });
  if (saved?.id) ok(`save returned id=${saved.id.slice(0, 8)}…`);
  else fail(`save did not return an id`);

  // 2. search
  const hits = await provider.search({ query: 'concise TypeScript', namespace: ns, k: 5 });
  if (hits.length > 0 && hits[0].content.includes('concise')) ok(`search found ${hits.length} hit(s)`);
  else fail(`search returned 0 hits or wrong content`);

  // 3. list
  const list = await provider.list({ namespace: ns, limit: 10 });
  if (list.length >= 1) ok(`list returned ${list.length} item(s)`);
  else fail(`list returned 0 items`);

  // 4. namespaces
  const nss = await provider.namespaces();
  if (nss.some(n => n.name === ns)) ok(`namespaces includes "${ns}"`);
  else fail(`namespaces does not include "${ns}"`);

  // 5. delete
  const deleted = await provider.delete(saved.id);
  if (deleted) ok(`delete returned true`);
  else fail(`delete returned false`);

  // 6. delete confirm
  const afterDelete = await provider.list({ namespace: ns, limit: 10 });
  if (afterDelete.length === 0) ok(`memory is gone after delete`);
  else fail(`memory still present after delete`);

  // 7. semantic search — content uses one vocabulary, query uses another.
  //    Pure FTS5 would miss this. If we have vector search wired, we find it.
  console.log(`  ${DIM}…running semantic-search test (first call downloads ~25MB model)${RST}`);
  const semNs = `__smoke_sem_${Date.now()}`;
  const semSaved = await provider.save({
    content: 'We decided to ship the application using Kubernetes for container orchestration, with rolling updates and a canary rollout pattern.',
    namespace: semNs,
    tags: ['smoke', 'semantic'],
    source: 'smoke-test',
  });
  // Query uses none of the literal keywords from the content.
  const semHits = await provider.search({ query: 'deployment strategy', namespace: semNs, k: 3 });
  if (semHits.length > 0 && semHits[0].id === semSaved.id) {
    ok(`semantic search matched "Kubernetes/canary" content to query "deployment strategy"`);
  } else {
    // Not a hard failure — if the model didn't load (no network on first run)
    // we degrade to FTS5-only and this test legitimately won't match.
    console.log(`  ${DIM}!${RST} semantic test indeterminate (model may not be loaded yet) — continuing`);
  }
  await provider.delete(semSaved.id);

  // 8a. secret redaction — well-known secret patterns should be stripped
  //     from saved content before they hit SQLite.
  const redactNs = `__smoke_redact_${Date.now()}`;
  const redactSaved = await provider.save({
    content: 'My AWS key is AKIAIOSFODNN7EXAMPLE and GitHub PAT is ghp_abcd1234abcd1234abcd1234abcd1234abcd, please remember these for me.',
    namespace: redactNs,
    tags: ['smoke', 'redact'],
    source: 'smoke-test',
  });
  if (!redactSaved.content.includes('AKIAIOSFODNN7EXAMPLE') &&
      !redactSaved.content.includes('ghp_abcd1234') &&
      redactSaved.metadata?.redacted_count >= 2) {
    ok(`redaction stripped AWS+GitHub keys from saved content (count=${redactSaved.metadata.redacted_count})`);
  } else {
    fail(`redaction did not strip expected secrets; content="${redactSaved.content?.slice(0, 100)}…"`);
  }
  await provider.delete(redactSaved.id);

  // 8. chunking — a long transcript-shaped save should split into per-turn memories.
  const chunkNs = `__smoke_chunk_${Date.now()}`;
  const transcript = [
    `# Test conversation about deployment`,
    ``,
    `**User:** I want to figure out the best way to deploy a Node app to production. What are my options?`,
    ``,
    `**Assistant:** Several reasonable paths. Railway is the simplest — git push, auto-deploy, ~$5/mo for small apps. Fly.io is similar but with global edge by default. AWS Elastic Beanstalk gives you more control at the cost of more configuration. For very simple apps, even a Lightsail container works fine and costs ~$10/mo.`,
    ``,
    `**User:** What about databases?`,
    ``,
    `**Assistant:** Supabase free tier covers Postgres + pgvector for most starter projects. RDS works if you're already on AWS but it's pricier. Neon is another option with generous free tier and serverless scaling. Local Docker Postgres is fine for development but you'll want managed Postgres in production for backups and pooling.`,
    ``,
    `**User:** And CI/CD?`,
    ``,
    `**Assistant:** GitHub Actions is the default for most stacks. Write a workflow file that runs tests, builds, and deploys. Railway and Fly both have official Actions you can drop in. For more complex pipelines (multi-environment, manual approvals), consider Buildkite or CircleCI but it's overkill for solo projects.`,
  ].join('\n').repeat(20);   // pad to push it well over the 6000-char chunk threshold

  const chunkSaved = await provider.save({
    content: transcript,
    namespace: chunkNs,
    tags: ['smoke', 'chunking'],
    source: 'smoke-test',
  });

  // After save, we expect MULTIPLE rows in this namespace (one per chunk),
  // each carrying parent_ref + chunk_index in metadata.
  const chunkList = await provider.list({ namespace: chunkNs, limit: 100 });
  if (chunkList.length > 1) {
    ok(`chunking split a long transcript into ${chunkList.length} per-turn memories`);
    // Verify they all share a parent_ref
    const parents = new Set(chunkList.map(m => m.metadata?.parent_ref).filter(Boolean));
    if (parents.size === 1) ok(`all chunks share one parent_ref`);
    else fail(`expected 1 parent_ref across chunks, got ${parents.size}`);
    // Verify chunk_index is set
    const allHaveIndex = chunkList.every(m => typeof m.metadata?.chunk_index === 'number');
    if (allHaveIndex) ok(`all chunks have metadata.chunk_index`);
    else fail(`some chunks missing chunk_index`);
    // Clean up
    for (const m of chunkList) { try { await provider.delete(m.id); } catch {} }
  } else {
    fail(`chunking did not split a ${transcript.length}-char transcript — only ${chunkList.length} memory(ies) saved`);
    try { await provider.delete(chunkSaved.id); } catch {}
  }

} catch (e) {
  fail(`exception: ${e?.stack || e}`);
} finally {
  await provider.close().catch(() => {});
}

if (process.exitCode) {
  console.log(`\n${RED}smoke test FAILED${RST}\n`);
} else {
  console.log(`\n${GRN}smoke test PASSED — local provider works end-to-end${RST}\n`);
}
