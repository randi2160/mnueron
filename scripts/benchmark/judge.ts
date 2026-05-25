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

async function chat(model: string, messages: any[], maxTokens = 300): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return '[no OPENAI_API_KEY — synthetic answer]';
  const body = JSON.stringify({ model, messages, temperature: 0, max_tokens: maxTokens });
  const headers = { 'authorization': `Bearer ${key}`, 'content-type': 'application/json' };
  let lastErr: unknown;
  // Retry on network errors, 429s, and 5xx. Bail immediately on 4xx (bad key, malformed request).
  for (let attempt = 1; attempt <= 5; attempt++) {
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
      lastErr = new Error(`OpenAI ${r.status} (attempt ${attempt}/5)`);
    } catch (e: any) {
      // Non-retryable 4xx thrown above re-throws here; only swallow transient network errors.
      if (e?.message?.startsWith('OpenAI ') && !e.message.includes('attempt')) throw e;
      lastErr = e;
    }
    const delayMs = Math.min(1000 * 2 ** (attempt - 1), 16000);
    console.warn(`  [judge] ${lastErr instanceof Error ? lastErr.message : lastErr} — waiting ${delayMs}ms then retrying`);
    await new Promise(res => setTimeout(res, delayMs));
  }
  throw new Error(`OpenAI chat failed after 5 attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
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
        'You answer questions about a conversation using the retrieved memories below as your primary source. ' +
        'The memories are dialog turns (or short windows of consecutive turns) prefixed with [N] and an optional (timestamp). ' +
        'For temporal questions the memories are pre-sorted in chronological order (oldest first). ' +
        'You may combine information across multiple memories to answer multi-hop questions. ' +
        'You may infer the answer when it is clearly implied by the memories, even if not stated word-for-word. ' +
        '\n\nTEMPORAL QUESTIONS (when, how long ago, before/after, what date, how many days/weeks/months): ' +
        'Use the CURRENT DATE given below as "now" if provided; otherwise treat the most recent timestamp in the set as "now". ' +
        'For "how long ago did X happen", compute the difference between X\'s timestamp and "now" in the unit asked (days, weeks, months). ' +
        'For "when did X happen", give the actual date from X\'s timestamp, not a relative phrase. ' +
        'For "before/after Y", compare timestamps directly and state the order. ' +
        'Always show the timestamps you used in parentheses at the end. ' +
        '\n\nMULTI-PART QUESTIONS (asking for multiple items, names, or a list): ' +
        'Enumerate ALL relevant items found across the retrieved memories. Do not stop at the first match. ' +
        'If the gold likely contains a count + a list (e.g. "3 things: A, B, C"), include both the count and the items. ' +
        '\n\nOnly reply with "NO_ANSWER" if zero retrieved memories touch the topic at all. ' +
        'Prefer a confident best-guess from partial evidence over a refusal. ' +
        'Be concise — one short sentence when possible, but include every detail the question asks for. Do not pad with caveats or hedges like "based on the memories".' +
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
