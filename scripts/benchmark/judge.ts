/**
 * LLM-as-judge for memory-recall benchmarks.
 *
 * Two functions:
 *   - generateAnswer(question, retrieved, model) — produces the system's answer
 *     given retrieved memories
 *   - judgeAnswer(question, gold, predicted, model) — scores predicted vs gold
 *     on a {0, 0.5, 1} scale per Mem0's published LoCoMo methodology
 *
 * Set OPENAI_API_KEY to enable. If absent, both functions return synthetic
 * answers so the smoke test still runs end-to-end without paying anything.
 */

import { BenchHit } from './adapter.js';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

export interface JudgeResult {
  score: number;
  reasoning: string;
  llmAnswer: string;
}

/**
 * Client-side throttle.
 *
 * OpenAI's default tier limits gpt-4o at 500 RPM (~8.3 calls/sec).
 * The benchmark fires ~4000 calls back-to-back across 10 samples; without
 * throttling, that bursts past the per-minute window and triggers
 * cascading 429s that even 5x exponential backoff can't drain.
 *
 * The fix: insert a minimum gap between calls (default 150ms = max
 * 400 RPM, safely under Tier 1's 500 RPM cap). For higher tiers,
 * override via MNUERON_BENCH_MIN_CALL_GAP_MS. For Tier 5+ accounts you
 * can drop it to 50ms.
 *
 * Module-level state so the throttle works across ALL chat() callers
 * in this process — both `generateAnswer` and `judgeAnswer` share the
 * same rate-limit budget at the OpenAI side, so they share the same
 * throttle here.
 */
const MIN_CALL_GAP_MS = Number(process.env.MNUERON_BENCH_MIN_CALL_GAP_MS ?? 150);
let lastCallAt = 0;

async function throttle(): Promise<void> {
  const now = Date.now();
  const wait = lastCallAt + MIN_CALL_GAP_MS - now;
  if (wait > 0) {
    await new Promise(res => setTimeout(res, wait));
  }
  lastCallAt = Date.now();
}

async function chat(model: string, messages: any[], maxTokens = 300): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return '[no OPENAI_API_KEY — synthetic answer]';
  const body = JSON.stringify({ model, messages, temperature: 0, max_tokens: maxTokens });
  const headers = { 'authorization': `Bearer ${key}`, 'content-type': 'application/json' };
  let lastErr: unknown;
  // Retry on network errors, 429s, and 5xx. Bail immediately on 4xx (bad key, malformed request).
  for (let attempt = 1; attempt <= 6; attempt++) {
    // Throttle BEFORE each attempt so retries also respect the cap.
    await throttle();
    try {
      const r = await fetch(OPENAI_URL, { method: 'POST', headers, body });
      if (r.ok) {
        const data: any = await r.json();
        return data.choices?.[0]?.message?.content ?? '';
      }
      if (r.status !== 429 && r.status < 500) {
        const errBody = await r.text().catch(() => '');
        throw new Error(`OpenAI ${r.status}: ${errBody.slice(0, 400)}`);
      }
      // 429: honor the Retry-After header if present (in seconds OR as
      // an HTTP-date). OpenAI's gateway sets this on rate-limit blocks
      // and it tells us EXACTLY how long the bucket needs to refill.
      // Without honoring it, we burn through retries before the window
      // resets and bail unnecessarily.
      if (r.status === 429) {
        const retryAfter = r.headers.get('retry-after');
        let suggestedDelayMs = 0;
        if (retryAfter) {
          const asNum = Number(retryAfter);
          if (Number.isFinite(asNum)) {
            suggestedDelayMs = asNum * 1000;
          } else {
            const asDate = Date.parse(retryAfter);
            if (!Number.isNaN(asDate)) suggestedDelayMs = Math.max(0, asDate - Date.now());
          }
        }
        if (suggestedDelayMs > 0) {
          const cappedDelayMs = Math.min(suggestedDelayMs, 60_000);
          console.warn(`  [judge] OpenAI 429 — Retry-After=${retryAfter} — waiting ${cappedDelayMs}ms`);
          await new Promise(res => setTimeout(res, cappedDelayMs));
          lastErr = new Error(`OpenAI 429 (attempt ${attempt}/6, honored Retry-After)`);
          continue;
        }
      }
      lastErr = new Error(`OpenAI ${r.status} (attempt ${attempt}/6)`);
    } catch (e: any) {
      // Non-retryable 4xx thrown above re-throws here; only swallow transient network errors.
      if (e?.message?.startsWith('OpenAI ') && !e.message.includes('attempt')) throw e;
      lastErr = e;
    }
    // Exponential backoff for non-Retry-After cases (network errors, 5xx).
    // Slightly more headroom: capped at 32s instead of 16s.
    const delayMs = Math.min(1000 * 2 ** (attempt - 1), 32_000);
    console.warn(`  [judge] ${lastErr instanceof Error ? lastErr.message : lastErr} — waiting ${delayMs}ms then retrying`);
    await new Promise(res => setTimeout(res, delayMs));
  }
  throw new Error(`OpenAI chat failed after 6 attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

export async function generateAnswer(
  question: string,
  retrieved: BenchHit[],
  model = 'gpt-4o-mini',
  currentDate?: string,
): Promise<string> {
  if (!process.env.OPENAI_API_KEY) {
    return retrieved[0]?.content ?? '[no retrieval results]';
  }
  const ctx = retrieved
    .map((h, i) => `[${i + 1}] ${h.timestamp ? `(${h.timestamp}) ` : ''}${h.content}`)
    .join('\n');
  const nowAnchor = currentDate
    ? `\n\nCURRENT DATE for any temporal computation: ${currentDate}. Treat this as "now".`
    : '';
  return chat(model, [
    {
      role: 'system',
      content:
        'You answer questions about a conversation using the retrieved memories below. ' +
        'The memories are dialog turns (or short windows of consecutive turns) prefixed with [N] and an optional (timestamp). ' +
        'For temporal questions the memories are pre-sorted in chronological order (oldest first). ' +
        '\n\n' +
        'YOUR DEFAULT IS TO ANSWER. The memories contain a real answer in most cases. Find it, paraphrase to be concise, deliver it. ' +
        'Paraphrased questions are fine — if memories say "I love hiking" and the question is "what hobby does X enjoy?", answer "hiking" confidently. ' +
        '\n\n' +
        'ANSWER CONFIDENTLY WHEN: ' +
        '- A memory directly states the fact (single-hop — most common case). ' +
        '- Multiple memories together provide the answer through composition (multi-hop). ' +
        '- A general trait clearly implies the answer (commonsense: memories say "Sarah is vegan" → "she would dislike a steakhouse"). ' +
        '- A memory mentions a date or relative time ("last March I changed jobs", "two weeks ago"), use it for temporal questions even without a (timestamp) prefix. ' +
        '- A (timestamp) on a memory provides the temporal answer directly. ' +
        '\n\n' +
        'REPLY "NO_ANSWER" ONLY WHEN: ' +
        '1. The memories don\'t mention the topic at all. ' +
        '2. The memories discuss a RELATED topic but never the specific fact asked. ' +
        '   Example: memories describe Sarah visiting several restaurants but never which one she RECOMMENDED → refuse. ' +
        '   Example: memories describe John\'s preferences for hiking gear but the question asks about his car → refuse. ' +
        '3. You would have to invent a value the memories never contain (specific number, name, place). ' +
        '4. The question hinges on a distinction the memories don\'t make (e.g. asks about "Sarah\'s sister" but memories only mention "Sarah\'s family member" generically). ' +
        '\n\n' +
        'ADVERSARIAL-PATTERN DETECTION (apply LAST, only when you\'re about to answer): ' +
        'Pause and ask: "Is the specific fact asked about LITERALLY in the memories, or would I be filling in a plausible-but-unsupported value?" ' +
        'If filling in unsupported value → switch to NO_ANSWER. ' +
        'But this is NOT permission to refuse direct facts on stylistic grounds. "I love hiking" answers "what hobby does X like" — that\'s direct, answer it. ' +
        '\n\n' +
        'TEMPORAL QUESTIONS (when, how long ago, before/after, what date, how many days/weeks/months): ' +
        'Use the CURRENT DATE given below as "now" if provided; otherwise treat the most recent timestamp in the set as "now". ' +
        'Use both (timestamp) prefixes AND in-memory date phrases ("Last March", "two weeks ago", "yesterday"). ' +
        'For "how long ago did X happen", compute the difference between X\'s time-anchor and "now" in the unit asked. ' +
        'For "when did X happen", give the actual date if you can compute it; a relative phrase ("about a month ago") is acceptable if only relative time is given. ' +
        'For "before/after Y", compare time-anchors and state the order. ' +
        'Show timestamps or date phrases in parentheses at the end when you used them. ' +
        'Reply NO_ANSWER only if neither timestamp metadata NOR in-content date phrases can resolve the question. ' +
        '\n\n' +
        'MULTI-PART QUESTIONS (asking for multiple items, names, or a list): ' +
        'Enumerate every relevant item found across the retrieved memories. Do not stop at the first match. ' +
        'If the gold likely contains a count + a list (e.g. "3 things: A, B, C"), include both the count and the items. ' +
        'If only SOME of the requested items are in the memories, list those and don\'t fabricate the rest. ' +
        '\n\n' +
        'MULTI-HOP COMBINATION (e.g. "What did Sarah\'s boss say about her vacation request?"): ' +
        'Combine facts across memories when each piece is supported. ' +
        'Do not refuse just because the answer requires combining 2-3 memories — that\'s the point of multi-hop. ' +
        'Only refuse multi-hop if one or more of the required pieces is missing from the memories. ' +
        '\n\n' +
        'Be concise — one short sentence when possible. Don\'t pad with caveats or hedges like "based on the memories". ' +
        'When refusing, reply EXACTLY "NO_ANSWER" — no other text, no explanation.' +
        nowAnchor,
    },
    {
      role: 'user',
      content: `Retrieved memories:\n${ctx}\n\nQuestion: ${question}\nAnswer:`,
    },
  ], 250);
}

export async function judgeAnswer(
  question: string,
  gold: string,
  predicted: string,
  model = 'gpt-4o-mini',
): Promise<JudgeResult> {
  if (!process.env.OPENAI_API_KEY) {
    const overlap = gold.toLowerCase().split(/\s+/).filter(w => w.length > 3 &&
      predicted.toLowerCase().includes(w)).length;
    const score = overlap >= 2 ? 1 : overlap === 1 ? 0.5 : 0;
    return { score, reasoning: `[stub] keyword overlap = ${overlap}`, llmAnswer: predicted };
  }
  const out = await chat(model, [
    {
      role: 'system',
      content:
        'You are scoring whether a predicted answer matches a gold answer for a ' +
        'memory-recall benchmark. Output ONLY a JSON object: ' +
        '{"score": <0|0.5|1>, "reasoning": "<one sentence>"}. ' +
        'Score 1 if predicted captures the same fact as gold (paraphrase OK). ' +
        'Score 0.5 if partially correct (right entity, wrong detail; or vice versa). ' +
        'Score 0 if wrong, hallucinated, or refused when an answer existed.',
    },
    {
      role: 'user',
      content: `Question: ${question}\nGold: ${gold}\nPredicted: ${predicted}\n\nScore:`,
    },
  ], 150);
  try {
    const cleaned = out.replace(/```json\s*|\s*```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      score: typeof parsed.score === 'number' ? parsed.score : 0,
      reasoning: parsed.reasoning ?? '',
      llmAnswer: predicted,
    };
  } catch {
    return { score: 0, reasoning: `[parse failed] ${out.slice(0, 200)}`, llmAnswer: predicted };
  }
}
