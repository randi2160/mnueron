/**
 * Error fingerprinting.
 *
 * A fingerprint is a stable, low-entropy hash designed to:
 *   - SURVIVE noise (paths, timestamps, UUIDs, hex IDs change every
 *     run; we strip them before hashing)
 *   - BREAK on category change (a git error and a typescript error
 *     should never share a fingerprint)
 *
 * Algorithm:
 *   1. Redact secrets first (reuses the existing `redact()` helper, so
 *      any API tokens or PEM blocks vanish before they touch the hash).
 *   2. Normalize: strip paths, UUIDs, hex digests, timestamps, line:col
 *      positions, and collapse whitespace + lowercase.
 *   3. SHA-256 the normalized string, take the first 12 hex chars as
 *      the fingerprint. 12 chars = 48 bits of entropy — enough to avoid
 *      collisions across a reasonable error vocabulary while staying
 *      short for human display.
 *   4. Detect the originating tool from keywords so the UI can hint
 *      "this looks like a git problem" before searching.
 *
 * Pure module — no I/O, no DB. Trivially unit-testable.
 */

import { createHash } from 'node:crypto';
import { redact } from '../store/redactor.js';
import type { Fingerprint } from './types.js';

/** Build a fingerprint from a raw error string. */
export function fingerprintError(raw: string): Fingerprint {
  const redaction = redact(raw);
  const normalized = normalize(redaction.content);
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 12);
  return {
    hash,
    normalized,
    tool: detectTool(normalized),
    redactedOriginal: redaction.content,
    redactedCount: redaction.count,
    redactedKinds: redaction.kinds,
  };
}

/**
 * Strip variable noise so the same root-cause error normalizes to the
 * same string regardless of where/when it happened.
 *
 * Order matters: do the most specific patterns first (URLs, UUIDs) so
 * less-specific ones (hex IDs, timestamps) don't eat their tokens.
 */
export function normalize(s: string): string {
  return (
    s
      // URLs first — they contain hex/UUID-looking substrings that
      // would otherwise be matched by the generic patterns below.
      .replace(/https?:\/\/[^\s'"<>]+/g, '<URL>')
      // Windows paths: C:\path\to\file or C:/path/to/file
      .replace(/[A-Z]:[\\/][\w\\/.~ \-+@]+(?=[\s'"`)\],]|$)/g, '<PATH>')
      // POSIX absolute paths: /usr/local/..., /Users/me/...
      .replace(/(?<![\w/])\/[\w./~+-]{2,}/g, '<PATH>')
      // UUIDs (8-4-4-4-12)
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<UUID>')
      // Long hex digests (git SHAs, content hashes, MD5, SHA-1, SHA-256)
      .replace(/\b[0-9a-f]{7,}\b/gi, '<HEX>')
      // ISO dates and times — 2026-05-25, 14:32:11, 14:32:11.456
      .replace(/\b\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?\b/g, '<DATETIME>')
      .replace(/\b\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?\b/g, '<TIME>')
      // file.ext:line:col patterns
      .replace(/:\d+:\d+/g, ':<L>:<C>')
      // Standalone bare line numbers in stack-trace format "at file:42"
      .replace(/:(\d{2,})\b/g, ':<L>')
      // PIDs and other ad-hoc numerics that vary run-to-run
      .replace(/\bpid[: ]?\d+/gi, 'pid:<N>')
      .replace(/\bport[: ]?\d+/gi, 'port:<N>')
      // Bracketed placeholder noise — strip the surrounding brackets so
      // `[<DATETIME>] fatal: ...` and `fatal: ...` normalize identically.
      // Only matches a placeholder we just produced (uppercase token), so
      // legitimate bracketed content like `error[42]:` survives... almost.
      // We do strip `error[42]:` too because [42] would normalize to <L> first.
      .replace(/\[<[A-Z_]+>\]\s*/g, '')
      // Quoted strings collapsed (paths leak through in quotes sometimes)
      .replace(/'([^']{0,200})'/g, (_, inner: string) =>
        // Keep short identifiers (likely keywords like 'main'), strip long ones
        inner.length > 30 ? `'<STR>'` : `'${inner}'`,
      )
      // Collapse whitespace
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
  );
}

/**
 * Best-effort tool detection from the normalized error text.
 *
 * Returns one of: 'git', 'npm', 'pnpm', 'yarn', 'typescript', 'postgres',
 * 'supabase', 'powershell', 'docker', 'kubectl', 'python', 'node', or
 * undefined if we can't tell.
 *
 * Used to:
 *   - Filter the search-by-tool branch
 *   - Display a friendly hint ("Looks like a git error") in `explain-error`
 *   - Stamp `tool` on captured runbooks so future "show me all my
 *     git runbooks" works cleanly
 */
export function detectTool(normalized: string): string | undefined {
  // Order matters — first match wins. Sort by SPECIFICITY of the pattern,
  // not by what tool is most common. PowerShell's "The term '...' is not
  // recognized" / "The token '...' is not a valid statement separator"
  // are essentially impossible to false-match, so they go first — they
  // catch the cases where surrounding text mentions other tools (e.g. a
  // PowerShell error inside a session that was running git commands).
  const sigs: Array<[string, RegExp]> = [
    [
      'powershell',
      /the term '[^']+' is not (recognized|valid)|the token '[^']+' is not (a valid|valid)|\bcmdlet\b|\bps[1-9]\b|\binvoke-\w+\b|parsererror|invalidendofline/,
    ],
    ['supabase', /\bsupabase\b|supabase_migrations/],
    ['postgres', /\bpostgres\b|sqlstate\b|\brelation\b.+\b(exists|does not exist)\b|duplicate key value|schema_migrations/],
    ['typescript', /\berror ts\d{4}\b|\bcannot find module\b|jsx element|tsconfig/],
    ['git', /\bfatal:|\bgit\b|\.git[/\\]|index\.lock|merge conflict|head[\^~]|origin\/main/],
    ['npm', /\bnpm err\b|\bnpm error\b|npm warn\b|package-lock\.json/],
    ['pnpm', /\bpnpm err\b|pnpm-lock/],
    ['yarn', /\byarn error\b|yarn\.lock/],
    ['docker', /\bdocker(d|fil)?\b|container\s+\w+|image\s+\w+:\w+|oci runtime/],
    ['kubectl', /\bkubectl\b|\bkube-?\w+\b|namespace .* not found|pod\/\w+/],
    ['python', /\btraceback\b|pip install|importerror|modulenotfound|python\d/],
    ['node', /\bnode:internal\b|cannot find module|err_module|process exited with code/],
  ];
  for (const [name, re] of sigs) {
    if (re.test(normalized)) return name;
  }
  return undefined;
}
