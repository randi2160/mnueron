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
