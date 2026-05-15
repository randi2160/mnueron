/**
 * Secret redaction at write time.
 *
 * Why: an AI agent that captures conversations will inevitably ingest a
 * conversation where the user pasted an API key. That key now sits in
 * plaintext SQLite at ~/.mnueron/memories.db. Bad. Redact at write time,
 * before content hits storage.
 *
 * Strategy:
 *   1. Pattern-match well-known secret formats (AWS, GitHub, OpenAI,
 *      Anthropic, Stripe, Slack, Google, JWT, etc.) and replace with
 *      stable placeholders like [REDACTED:aws_access_key].
 *   2. Catch private-key blocks (-----BEGIN ... PRIVATE KEY-----).
 *   3. Stamp metadata.redacted_count + metadata.redacted_kinds so the
 *      dashboard / agent can show "3 secrets redacted from this memory."
 *
 * Out of scope (for v1):
 *   - Generic high-entropy scanner. Tempting but creates false positives
 *     on hashes, UUIDs, base64-encoded data, etc. Most actual leaks are
 *     in known-format keys, so pattern matching covers the 90% case.
 *   - Reversing redaction (we never store the original).
 *
 * This module is intentionally pure (no DB / no network) so it can be
 * called from any save path and unit-tested trivially.
 */

export interface RedactResult {
  /** Content with all matched secrets replaced by placeholders. */
  content: string;
  /** Number of secrets redacted across all patterns. */
  count: number;
  /** Unique secret kinds found (for the dashboard's "what was redacted" badge). */
  kinds: string[];
}

interface Pattern {
  name: string;
  /** Must be a global RegExp — we rely on .replace's global behavior. */
  re: RegExp;
  /** Optional: if the secret should be partially preserved (e.g. prefix shown), set here. */
  redactWith?: (match: string) => string;
}

// Ordered most-specific-first. The first pattern that matches wins; later
// patterns won't see content that's already been replaced (because the
// placeholder doesn't look like any other pattern).
const PATTERNS: Pattern[] = [
  // Private key blocks (PEM format) — must run before single-line patterns
  // since the body of a key block can match many other regexes.
  {
    name: 'private_key',
    re: /-----BEGIN\s+(?:RSA|DSA|EC|OPENSSH|PGP|ENCRYPTED|PRIVATE)\s*(?:PRIVATE\s+)?KEY-----[\s\S]+?-----END\s+(?:RSA|DSA|EC|OPENSSH|PGP|ENCRYPTED|PRIVATE)\s*(?:PRIVATE\s+)?KEY-----/g,
  },

  // Anthropic
  { name: 'anthropic_key', re: /\bsk-ant-(?:api03|admin01)-[A-Za-z0-9_-]{80,120}\b/g },

  // OpenAI — handle both legacy sk-... and project-scoped sk-proj-...
  { name: 'openai_key', re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{40,255}\b/g },

  // GitHub: classic, fine-grained, server-to-server, user-to-server, refresh, OAuth
  { name: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9_]{36,255}\b/g },

  // AWS access key + secret pair
  { name: 'aws_access_key', re: /\b(?:AKIA|ASIA|AIDA|AROA|ANPA|AGPA|AIPA|ANVA|ABIA|ACCA)[0-9A-Z]{16}\b/g },

  // Stripe — sk_live_, sk_test_, pk_live_, pk_test_, rk_live_, rk_test_
  { name: 'stripe_key', re: /\b(?:sk|pk|rk)_(?:test|live)_[A-Za-z0-9]{24,255}\b/g },

  // Slack — xoxb-, xoxp-, xoxa-, xoxr-, xoxs-
  { name: 'slack_token', re: /\bxox[abprs]-[0-9]{10,13}-[0-9]{10,13}-[A-Za-z0-9]{24,}\b/g },

  // Google API keys (AIza...) and OAuth
  { name: 'google_api_key', re: /\bAIza[A-Za-z0-9_-]{35}\b/g },
  { name: 'google_oauth_token', re: /\bya29\.[A-Za-z0-9_-]{40,}\b/g },

  // mnueron tokens (these end up in user-pasted commands; redact our own)
  { name: 'mnueron_token', re: /\bmnu_[A-Za-z0-9_-]{30,}\b/g },

  // JWTs — three base64url-encoded segments separated by dots
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },

  // Bearer-in-URL — common in cURL examples pasted into chats
  // Group 1 is what we keep ("token=" / "api_key=" etc), group 2 is redacted.
  {
    name: 'url_token_param',
    re: /\b(token|api[_-]?key|access[_-]?token|auth[_-]?token|bearer)=([A-Za-z0-9_.\-+/=]{16,})/gi,
    redactWith: (match: string) => {
      const eq = match.indexOf('=');
      return match.slice(0, eq + 1) + '[REDACTED:url_token_param]';
    },
  },

  // Generic Bearer header in HTTP/cURL: "Authorization: Bearer xxx"
  {
    name: 'authorization_bearer',
    re: /\bAuthorization:\s*Bearer\s+([A-Za-z0-9_.\-+/=]{16,})/gi,
    redactWith: (match: string) => {
      const idx = match.toLowerCase().indexOf('bearer ');
      const head = match.slice(0, idx + 7);
      return head + '[REDACTED:authorization_bearer]';
    },
  },

  // DSN-style secrets: https://USER:PASSWORD@host
  {
    name: 'url_basic_auth',
    re: /\b(https?:\/\/)([^:@\s]+):([^@\s]+)@/g,
    redactWith: (match: string) => match.replace(/:[^:@\s]+@/, ':[REDACTED:url_basic_auth]@'),
  },
];

/**
 * Run every pattern over `content`, replacing matches. Returns the
 * redacted content + count + kinds found.
 */
export function redact(content: string): RedactResult {
  if (!content) return { content: content ?? '', count: 0, kinds: [] };

  let out = content;
  let count = 0;
  const kinds = new Set<string>();

  for (const p of PATTERNS) {
    // Reset lastIndex in case the same regex object is reused.
    p.re.lastIndex = 0;
    out = out.replace(p.re, (match: string) => {
      count++;
      kinds.add(p.name);
      return p.redactWith ? p.redactWith(match) : `[REDACTED:${p.name}]`;
    });
  }

  return { content: out, count, kinds: [...kinds] };
}

/**
 * Convenience for callers that just want yes/no.
 */
export function containsSecret(content: string): boolean {
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    if (p.re.test(content)) return true;
  }
  return false;
}
