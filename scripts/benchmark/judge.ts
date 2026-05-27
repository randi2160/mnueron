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
        '\n\n' +
        'ABOUT THIS BENCHMARK: many questions are ADVERSARIAL. They are designed to look ' +
        'answerable from circumstantial or near-miss memories that mention related people, places, ' +
        'topics, or time periods but do NOT actually contain the specific fact asked about. ' +
        'The benchmark rewards "NO_ANSWER" when no answer exists in the memories and penalizes ' +
        'confident-but-wrong guesses equally with wrong answers. Refuse when in doubt. ' +
        '\n\n' +
        'BEFORE answering, run this 3-step verification: ' +
        '(1) Is the specific entity (person, place, thing, event) from the question present in the memories? ' +
        '(2) Is the specific attribute being asked about (color, number, date, name, preference, action, location) EXPLICITLY stated about that entity in the memories? ' +
        '(3) Would you have to guess between multiple plausible values, or fill in a value the memories don\'t actually contain? ' +
        '\n\n' +
        'If (1) or (2) is no, OR (3) is yes → reply exactly: NO_ANSWER ' +
        '\nOtherwise → answer concisely. ' +
        '\n\n' +
        'WHAT COUNTS AS "EXPLICITLY STATED": ' +
        '- A direct quote or paraphrase of the speaker saying the exact fact ("I love hiking" → yes, you can answer "what does X love"). ' +
        '- A clear factual statement about the entity ("Sarah is a vegan" → yes, you can answer "is Sarah vegetarian"). ' +
        '- A timestamp on a memory ("(2024-03-15) ...") → yes, you can answer "when did X happen" if X is the subject of that memory. ' +
        '\nNOT EXPLICITLY STATED: ' +
        '- The speaker mentions a related topic but never states the specific fact. ' +
        '- The memories show the speaker doing similar things in similar places but never the exact one asked. ' +
        '- You\'d need to assume the speaker\'s preference, motivation, or future action from partial evidence. ' +
        '\n\n' +
        'MULTI-HOP QUESTIONS — combining facts is ALLOWED only when each piece is explicitly stated: ' +
        '"Where does Sarah work + what did her boss say" → fine if both are in the memories. ' +
        '"What restaurant did Sarah recommend to her vegan friend" → only fine if the memories actually state Sarah recommended a restaurant to a vegan friend; not fine if you have to infer "Sarah is vegan + her friend ate at X → Sarah recommended X". ' +
        '\n\n' +
        'COMMONSENSE QUESTIONS — clear implication is OK: ' +
        'If memories establish "Sarah is a vegan" and the question asks "would Sarah enjoy a steakhouse", that is a clear implication and you should answer "no". ' +
        'But if the memories say "Sarah went out to dinner Friday" and the question asks "did Sarah enjoy her dinner", refuse — the memories don\'t state her enjoyment. ' +
        '\n\n' +
        'TEMPORAL QUESTIONS (when, how long ago, before/after, what date, how many days/weeks/months): ' +
        'Use the CURRENT DATE given below as "now" if provided; otherwise treat the most recent timestamp in the set as "now". ' +
        'For "how long ago did X happen", compute the difference between X\'s timestamp and "now" in the unit asked (days, weeks, months). ' +
        'For "when did X happen", give the actual date from X\'s timestamp, not a relative phrase. ' +
        'For "before/after Y", compare timestamps directly and state the order. ' +
        'Always show the timestamps you used in parentheses at the end. ' +
        'If the question asks about a date/duration the memories do not have timestamped evidence for, reply NO_ANSWER — do not guess. ' +
        '\n\n' +
        'MULTI-PART QUESTIONS (asking for multiple items, names, or a list): ' +
        'Enumerate ALL relevant items found across the retrieved memories. Do not stop at the first match. ' +
        'If the gold likely contains a count + a list (e.g. "3 things: A, B, C"), include both the count and the items. ' +
        'If only SOME of the requested items are in the memories, list those and don\'t fabricate the rest. ' +
        '\n\n' +
        'Be concise — one short sentence when possible. Do not pad with caveats or hedges like "based on the memories". ' +
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
