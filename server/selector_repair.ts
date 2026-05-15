/**
 * Selector repair endpoint.
 *
 * Mount this on your MNUERON server at POST /v1/extension/heal-selectors.
 * The browser extension calls it when its hardcoded selectors stop
 * finding messages on claude.ai or chatgpt.com. The endpoint passes the
 * structural HTML to an LLM, gets back new selectors, validates the
 * shape, caches the result, and returns selectors to the extension.
 *
 * Cost: one LLM call per repair, ~$0.005 with Haiku. Triggered roughly
 * once per UI change on the upstream sites — single-digit times per month
 * across the whole user base.
 *
 * Wire up in server/index.ts:
 *   import { healSelectorsHandler } from './selector_repair.js';
 *   app.post('/v1/extension/heal-selectors', authMiddleware, healSelectorsHandler);
 */
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';

// In-memory cache. For production, back this with Redis or a Postgres
// table — multiple users hitting the same repair shouldn't re-pay the
// LLM cost.
const cache = new Map<string, CachedRepair>();
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // 7 days
const MAX_HTML_BYTES = 50_000;                  // truncate aggressively
const ALLOWED_SITES = new Set(['claude', 'chatgpt']);

interface CachedRepair {
  selectors: ProposedSelectors;
  llmConfidence: number;
  expiresAt: number;
}

interface ProposedSelectors {
  root: string[];
  userMessage: string[];
  assistantMessage: string[];
  notes?: string;
}

interface HealRequest {
  site: string;
  current_selectors?: ProposedSelectors;
  html: string;   // structural HTML, with text content stripped
}

interface HealResponse {
  ok: boolean;
  cached: boolean;
  selectors?: ProposedSelectors;
  confidence?: number;
  error?: string;
}

const anthropic = new Anthropic();   // reads ANTHROPIC_API_KEY from env

export async function healSelectorsHandler(req: Request, res: Response) {
  const body = req.body as HealRequest;
  if (!body || !ALLOWED_SITES.has(body.site)) {
    res.status(400).json({ ok: false, error: 'invalid site' });
    return;
  }
  if (!body.html || typeof body.html !== 'string') {
    res.status(400).json({ ok: false, error: 'html sample required' });
    return;
  }

  const sanitized = sanitizeHtml(body.html);
  const cacheKey = `${body.site}:${hashFor(sanitized)}`;

  // Check cache
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    res.json({
      ok: true,
      cached: true,
      selectors: cached.selectors,
      confidence: cached.llmConfidence,
    } satisfies HealResponse);
    return;
  }

  // Call the LLM
  try {
    const proposal = await askLlmForSelectors(body.site, body.current_selectors, sanitized);
    if (!isValidShape(proposal.selectors)) {
      res.status(502).json({ ok: false, error: 'LLM returned malformed selectors' });
      return;
    }
    cache.set(cacheKey, {
      selectors: proposal.selectors,
      llmConfidence: proposal.confidence,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    res.json({
      ok: true,
      cached: false,
      selectors: proposal.selectors,
      confidence: proposal.confidence,
    } satisfies HealResponse);
  } catch (e: any) {
    console.warn('selector repair failed:', e);
    res.status(500).json({ ok: false, error: e?.message ?? 'unknown' });
  }
}

// ---------------------------------------------------------------------------
// HTML sanitization — strip actual conversation content, keep structure
// ---------------------------------------------------------------------------

/**
 * Replace text nodes with placeholders so we never send conversation
 * content to the LLM. Also truncate aggressively to keep tokens low.
 *
 * The LLM doesn't need the actual words to identify selectors — just the
 * tag names, classes, data-attributes, and structural nesting.
 */
function sanitizeHtml(html: string): string {
  // Strip <script>, <style>, <svg> contents (noisy + can leak)
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, '<script></script>')
    .replace(/<style[\s\S]*?<\/style>/gi, '<style></style>')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '<svg></svg>');

  // Replace text content between tags with placeholders
  s = s.replace(/>([^<]+)</g, (_m, txt: string) => {
    const trimmed = txt.trim();
    if (!trimmed) return '><';
    return `>[TEXT:${trimmed.length}]<`;
  });

  // Truncate to a reasonable size — front + back ensures we keep both
  // the early DOM structure (root container) and message structure.
  if (s.length > MAX_HTML_BYTES) {
    const half = Math.floor(MAX_HTML_BYTES / 2);
    s = s.slice(0, half) + '\n\n<!-- ... truncated ... -->\n\n' + s.slice(-half);
  }
  return s;
}

function hashFor(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function isValidShape(s: ProposedSelectors | undefined): boolean {
  if (!s) return false;
  for (const key of ['root', 'userMessage', 'assistantMessage'] as const) {
    const arr = s[key];
    if (!Array.isArray(arr) || arr.length === 0) return false;
    for (const sel of arr) {
      if (typeof sel !== 'string') return false;
      // Crude safety check: no scripty stuff
      if (/[<>;{}]/.test(sel)) return false;
      if (sel.length > 200) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// The LLM call
// ---------------------------------------------------------------------------

async function askLlmForSelectors(
  site: string,
  current: ProposedSelectors | undefined,
  html: string,
): Promise<{ selectors: ProposedSelectors; confidence: number }> {
  const sitePretty = site === 'claude' ? 'claude.ai' : 'chatgpt.com';
  const currentBlock = current
    ? `Previous selectors that stopped working:\n${JSON.stringify(current, null, 2)}\n\n`
    : '';

  const prompt = `
You are a web-scraping selector identifier. The browser extension that
captures conversations on ${sitePretty} is no longer finding messages —
the site's HTML has changed. Your job is to look at the current HTML
structure and propose new CSS selectors.

${currentBlock}Sanitized HTML sample (text content replaced with [TEXT:N] placeholders):

${html}

Identify selectors for:
  - root: the container that holds the conversation
  - userMessage: elements representing turns the user wrote
  - assistantMessage: elements representing turns the AI wrote

For each, return AN ARRAY of candidate selectors ordered from
highest to lowest confidence. Multiple candidates let the extension fall
back if one doesn't match.

Strict rules:
  - Selectors must be valid CSS (no XPath, no jQuery extensions like :contains)
  - Prefer stable signals: data-attributes (data-testid, data-message-author-role,
    data-message-id), then ARIA roles, then class names. Avoid generated
    Tailwind-style hashes if possible.
  - No selector longer than 200 chars.

Respond with ONLY this JSON object, no prose:
{
  "selectors": {
    "root": ["selector1", "selector2"],
    "userMessage": ["selector1", "selector2"],
    "assistantMessage": ["selector1", "selector2"],
    "notes": "optional one-line note explaining your choices"
  },
  "confidence": 0.0-1.0
}
`.trim();

  const resp = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 600,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = resp.content[0]?.type === 'text' ? resp.content[0].text : '';
  // The model sometimes wraps in ```json ... ```. Strip those.
  const cleaned = text.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(cleaned);
  return {
    selectors: parsed.selectors,
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
  };
}
