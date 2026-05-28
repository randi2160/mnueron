/**
 * Active-context entity extractor.
 *
 * Different from `src/store/entity-extractor.ts` — that one runs an LLM
 * call on saved memories to find people/orgs/products for the knowledge
 * graph. THIS extractor is regex-only, runs in <5ms, and pulls the
 * DEVELOPMENT-context entities the recall engine needs:
 *
 *   project    — namespace/repo name (from cwd or explicit mention)
 *   files      — referenced source files
 *   commands   — shell commands (git, npm, supabase, curl, etc.)
 *   errors     — error messages, codes, stack-trace prefixes
 *   technologies — frameworks, services, languages mentioned
 *
 * These feed the recall engine's namespace + filter selection:
 *   - project name → search namespace=`repo:<project>` first
 *   - files mentioned → boost memories that reference the same files
 *   - errors → check procedural_memories for matching fingerprints
 *   - technologies → expand search vocabulary
 *
 * Pure module — no I/O, no LLM. Same shape as date-anchors.ts.
 */

import { basename, dirname } from 'node:path';

export interface ContextEntities {
  /** Project / repo name. Best guess from cwd + explicit mentions. */
  project: string | null;
  /** Source files referenced (e.g. "src/billing/checkout.ts"). */
  files: string[];
  /** Shell commands invoked or referenced. */
  commands: string[];
  /** Error messages, exception types, error codes. */
  errors: string[];
  /** Technologies / frameworks / services mentioned. */
  technologies: string[];
  /** Free-form noun-phrase tags useful for tagging captured runbooks. */
  tags: string[];
}

const TECH_VOCAB = [
  // Languages
  'typescript', 'javascript', 'python', 'go', 'rust', 'java', 'c#', 'ruby', 'php', 'swift', 'kotlin',
  // Frameworks
  'react', 'next.js', 'next', 'vue', 'svelte', 'angular', 'express', 'fastify', 'nestjs', 'django',
  'flask', 'fastapi', 'rails', 'spring', '.net', 'dotnet',
  // Cloud / infra
  'aws', 'gcp', 'azure', 'vercel', 'netlify', 'cloudflare', 'fly.io', 'railway', 'heroku', 'render',
  'kubernetes', 'k8s', 'docker', 'terraform', 'ansible',
  // Databases
  'postgres', 'postgresql', 'mysql', 'sqlite', 'redis', 'mongodb', 'dynamodb', 'supabase', 'planetscale',
  'prisma', 'drizzle',
  // AI / ML
  'openai', 'anthropic', 'claude', 'gpt-4', 'gpt-4o', 'haiku', 'sonnet', 'opus', 'gemini', 'llama',
  'mistral', 'embeddings', 'pgvector', 'sqlite-vec', 'langchain', 'llamaindex',
  // Payment / billing
  'stripe', 'paypal', 'lemon squeezy', 'paddle',
  // Auth / identity
  'oauth', 'jwt', 'session', 'cookie', 'sso', 'saml',
  // MCP / mnueron-specific
  'mcp', 'mnueron', 'cowork', 'claude desktop', 'cursor', 'windsurf', 'cline',
  // Build / package
  'npm', 'pnpm', 'yarn', 'cargo', 'pip', 'composer', 'maven', 'gradle',
  // Test / CI
  'vitest', 'jest', 'mocha', 'pytest', 'github actions', 'circleci',
];

/**
 * Extract development entities from active context.
 *
 * @param text The active context — typically the last 500-2000 chars of
 *             what the user has been writing/typing/talking-about.
 * @param opts.cwd If provided, the working directory. Used to infer
 *                 `project` when not explicitly mentioned.
 * @param opts.explicitProject If the caller already knows the project
 *                              (e.g. from MCP-side namespace hints),
 *                              skip cwd inference.
 */
export function extractEntities(
  text: string,
  opts: { cwd?: string; explicitProject?: string } = {},
): ContextEntities {
  if (!text) {
    return {
      project: opts.explicitProject ?? inferProjectFromCwd(opts.cwd),
      files: [],
      commands: [],
      errors: [],
      technologies: [],
      tags: [],
    };
  }

  const lower = text.toLowerCase();

  // ─── Files ────────────────────────────────────────────────────────────
  // Looks for path-like tokens: src/foo/bar.ts, ./components/X.tsx, etc.
  // Quoted paths in errors ('C:/foo/.git/index.lock') already captured
  // by the path regex.
  const fileRe = /(?<!\w)((?:[a-z0-9_-]+\/){0,5}[a-z0-9_.-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|cs|rb|php|swift|kt|sql|md|yaml|yml|json|sh|ps1|html|css))(?!\w)/gi;
  const files = Array.from(new Set(
    Array.from(text.matchAll(fileRe)).map(m => m[1]).filter(f => !f.startsWith('node_modules/') && f.length < 200),
  )).slice(0, 15);

  // ─── Commands ─────────────────────────────────────────────────────────
  // Recognize lines that LOOK like shell commands: starts with a known
  // CLI verb. Captures from fenced code blocks too.
  const cmdRe = /(?:^|\n|`{1,3}\s*|\$\s+)((?:git|npm|pnpm|yarn|node|npx|tsx|python|pip|cargo|rustc|go|docker|kubectl|terraform|ansible|aws|gcloud|az|supabase|stripe|vercel|netlify|gh|mnueron|curl|wget|psql|mysql|sqlite3|redis-cli|jq|sed|awk|grep|find|ls|cd|rm|cp|mv|mkdir|chmod|chown|sudo|systemctl|service|kill|ps|top|netstat|ssh|scp|rsync|tar|zip|unzip|cmake|make|gradle|mvn|bundle|gem)\s+[^\n`]{1,200})/g;
  const commands = Array.from(new Set(
    Array.from(text.matchAll(cmdRe)).map(m => m[1].trim()),
  )).slice(0, 10);

  // ─── Errors ───────────────────────────────────────────────────────────
  // Catches lines that look like error output. Conservative — we don't
  // want to mark every "failed" mention as an error entity.
  const errorPatterns = [
    /(?:^|\n)\s*(?:ERROR|FATAL|Error|Exception|Traceback)[: ][^\n]{5,200}/g,
    /\b(?:HTTP|status)\s+(?:4|5)\d{2}\b/g,
    /\bSQLSTATE\s+\d{5}\b/gi,
    /\bcannot find (?:module|file)\b[^\n]{0,100}/gi,
    /\b(?:is not recognized|not found|undefined|null pointer|access denied|permission denied)\b/gi,
  ];
  const errors: string[] = [];
  for (const re of errorPatterns) {
    for (const m of text.matchAll(re)) {
      errors.push(m[0].trim());
      if (errors.length >= 5) break;
    }
    if (errors.length >= 5) break;
  }

  // ─── Technologies ─────────────────────────────────────────────────────
  // Conservative vocabulary match. Avoids false positives on words like
  // "Go" by requiring word boundaries (so "Go" only matches as a token).
  const technologies = TECH_VOCAB.filter(t => {
    // Special handling for short tokens to avoid false positives
    if (t.length <= 2) {
      // "go", "k8s" — require word boundary on both sides + lowercase context
      return new RegExp(`\\b${escapeRe(t)}\\b`).test(lower);
    }
    return lower.includes(t);
  }).slice(0, 15);

  // ─── Project ──────────────────────────────────────────────────────────
  const project = opts.explicitProject ?? extractProjectFromText(text) ?? inferProjectFromCwd(opts.cwd);

  // ─── Tags ─────────────────────────────────────────────────────────────
  // Pull noun phrases from the first 200 chars as candidate tags.
  // Useful for stamping captured runbooks with relevant labels.
  const tags = Array.from(new Set([
    ...technologies.slice(0, 5),
    ...(project ? [`project:${project}`] : []),
    ...files.slice(0, 3).map(f => `file:${basename(f)}`),
  ])).slice(0, 10);

  return {
    project,
    files,
    commands,
    errors,
    technologies,
    tags,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Pull "in the foo repo" / "repo: foo" / "namespace=repo:foo" from text. */
function extractProjectFromText(text: string): string | null {
  // Order from most-specific-phrase to least. The "in the X repo" pattern
  // comes FIRST because it's the most natural English phrasing and the
  // most unambiguous about which word is the project name.
  const patterns = [
    // "in the mnueron repo" / "in mnueron project" / "in the foo codebase"
    /\bin\s+(?:the\s+)?([a-zA-Z0-9._-]{2,60})\s+(?:repo|project|codebase)\b/i,
    // "namespace=repo:mnueron" / "namespace: repo:foo"
    /\bnamespace[=:\s]+["`']?(repo:[a-zA-Z0-9._-]+)["`']?/i,
    // "project: mnueron" / "repo: foo" — REQUIRES `:` or `=` (NOT bare whitespace)
    // to avoid matching "repo working" or "project plan" as "working" or "plan".
    /\b(?:project|repo|repository)\s*[:=]\s*["`']?([a-zA-Z0-9._-]{2,60})["`']?\b/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return m[1].replace(/^repo:/, '');
  }
  return null;
}

/** Last dir name of cwd, e.g. "/home/me/projects/mnueron" → "mnueron". */
function inferProjectFromCwd(cwd?: string): string | null {
  if (!cwd) return null;
  try {
    let name = basename(cwd);
    // If cwd ends in `/src` or similar generic, walk up.
    while (['src', 'lib', 'app', 'packages', 'frontend', 'backend'].includes(name)) {
      const parent = dirname(cwd);
      if (parent === cwd) break;
      cwd = parent;
      name = basename(cwd);
    }
    return name || null;
  } catch {
    return null;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
