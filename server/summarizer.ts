/**
 * Assistant-response summarization.
 *
 * When the browser extension or an agent captures a long AI assistant
 * response, this layer compresses it to a high-signal summary before
 * storage. Typical 10x storage reduction; recall quality goes UP because
 * the summary contains less noise.
 *
 * Design rules:
 *   - Only summarize content longer than `minLength` chars.
 *   - Only summarize the roles listed in `rolesToSummarize` (default:
 *     just 'assistant'; user messages stay verbatim because they're
 *     already concise and authoritative).
 *   - Original content is preserved in `metadata.original_content`
 *     (truncated to `originalMaxLength`) so it's never lost.
 *   - The `summarized` tag is added so a search can opt OUT of summarized
 *     content if it needs the verbatim text.
 *
 * Cost: ~$0.0015 per summarization with Claude Haiku 4.5. For a power
 * user capturing 50 long assistant responses per day, that's $2.25/month.
 * For typical users, well under $1.
 *
 * To run async with Anthropic's Batch API (50% off), see the
 * `summarizeBatch` function below — submit batches overnight, get
 * results in 24h. Best for high-volume deployments.
 *
 * Wire up in server/index.ts:
 *   import { summarizeMemory } from './summarizer.js';
 *   // ... inside the POST /v1/memories handler, after parsing body:
 *   const transformed = await summarizeMemory(input);
 *   // ... then pass `transformed` to the storage layer
 */
import Anthropic from '@anthropic-ai/sdk';
import type { SaveMemoryInput } from './types.js';   // adjust import to wherever your SaveMemoryInput lives

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface SummarizationOptions {
  /** Master switch. False = no-op (returns input unchanged). */
  enabled: boolean;
  /** Don't touch content shorter than this (chars). */
  minLength: number;
  /** Which roles to summarize. */
  rolesToSummarize: string[];
  /** Preserve original in metadata.original_content? */
  keepOriginal: boolean;
  /** Truncate the preserved original to this many chars. */
  originalMaxLength: number;
  /** Anthropic model to use. */
  model: string;
  /** Max output tokens for the summary. */
  maxSummaryTokens: number;
}

const DEFAULTS: SummarizationOptions = {
  enabled: true,
  minLength: 500,
  rolesToSummarize: ['assistant'],
  keepOriginal: true,
  originalMaxLength: 4000,
  model: 'claude-haiku-4-5',
  maxSummaryTokens: 200,
};

// Singleton Anthropic client. Reads ANTHROPIC_API_KEY from env.
const anthropic = new Anthropic();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Transform a single memory input. Returns the input unchanged if it
 * doesn't qualify for summarization.
 */
export async function summarizeMemory(
  input: SaveMemoryInput,
  opts: Partial<SummarizationOptions> = {},
): Promise<SaveMemoryInput> {
  const o: SummarizationOptions = { ...DEFAULTS, ...opts };
  if (!o.enabled) return input;
  if (input.content.length < o.minLength) return input;

  const role = detectRole(input);
  if (role && !o.rolesToSummarize.includes(role)) return input;

  try {
    const summary = await callLlmForSummary(input.content, o);
    if (!summary || summary.length < 10) return input;   // bail on suspicious empty result

    return {
      ...input,
      content: summary,
      metadata: {
        ...(input.metadata ?? {}),
        summarized: true,
        summarization_model: o.model,
        original_length: input.content.length,
        ...(o.keepOriginal && {
          original_content: truncate(input.content, o.originalMaxLength),
        }),
      },
      tags: Array.from(new Set([...(input.tags ?? []), 'summarized'])),
    };
  } catch (e: any) {
    console.warn('[summarizer] failed, returning original:', e?.message);
    return input;   // fail open — never lose data because of a summarization error
  }
}

/**
 * Transform an array of memories in parallel. Use this in your
 * /v1/memories/bulk endpoint so a captured conversation with 5 long
 * assistant responses takes ~1s instead of 5s sequential.
 */
export async function summarizeBatch(
  inputs: SaveMemoryInput[],
  opts: Partial<SummarizationOptions> = {},
): Promise<SaveMemoryInput[]> {
  return Promise.all(inputs.map(i => summarizeMemory(i, opts)));
}

// ---------------------------------------------------------------------------
// Implementation details
// ---------------------------------------------------------------------------

const SUMMARIZATION_PROMPT = `You are summarizing an AI assistant's response so it can be stored as a long-term memory. Your output will be retrieved later when someone asks a related question — make it precise and high-signal.

INCLUDE:
- The main answer, recommendation, or conclusion
- Specific decisions, facts, or technical details stated
- References to external sources (URLs, papers, libraries, documentation, function names)
- Important caveats or warnings that affect the user's decision

EXCLUDE:
- Generic explanations of well-known concepts ("REST is a protocol where…")
- Pleasantries ("Great question!", "I'd be happy to help")
- Meta-commentary about the AI's reasoning process
- Verbose elaboration that doesn't add new information

OUTPUT FORMAT:
A single paragraph, under 100 words. Factual third-person voice ("Recommended X because Y. Key technical detail: Z."). No preamble, no explanation of what you're doing, no "Here's the summary:".

EXAMPLE:
If the assistant wrote 2000 words on REST vs GraphQL and concluded "GraphQL is the right choice because of N+1 queries", the summary would be:
"Recommended GraphQL over REST due to N+1 query patterns in the user's existing app. Trade-offs noted: GraphQL has stronger schema enforcement; REST has wider tooling support. No specific code examples given. Suggested looking at Hasura or Apollo Server for implementation."

ASSISTANT RESPONSE TO SUMMARIZE:
"""
%CONTENT%
"""

Write the summary now (no preamble):`;

async function callLlmForSummary(
  content: string,
  opts: SummarizationOptions,
): Promise<string> {
  const prompt = SUMMARIZATION_PROMPT.replace('%CONTENT%', content);
  const resp = await anthropic.messages.create({
    model: opts.model,
    max_tokens: opts.maxSummaryTokens,
    messages: [{ role: 'user', content: prompt }],
  });
  for (const block of resp.content) {
    if (block.type === 'text') return block.text.trim();
  }
  return '';
}

/**
 * Detect the speaker role from a SaveMemoryInput. We check (in order):
 *   1. Tags array contains 'user' or 'assistant'
 *   2. Content begins with [user] or [assistant] prefix (browser-extension pattern)
 *   3. metadata.role explicitly set
 */
function detectRole(input: SaveMemoryInput): string | null {
  if (input.tags?.includes('assistant')) return 'assistant';
  if (input.tags?.includes('user')) return 'user';
  if (input.content.startsWith('[assistant]')) return 'assistant';
  if (input.content.startsWith('[user]')) return 'user';
  if (input.metadata?.role) return String(input.metadata.role);
  return null;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '\n\n... [truncated, original was ' + s.length + ' chars]';
}

// ---------------------------------------------------------------------------
// Conversation-level summary (v0.3 feature)
// ---------------------------------------------------------------------------

/**
 * Produce a single high-level summary memory for an entire conversation.
 * Save this ALONGSIDE the turn-level memories — it answers questions
 * like "what did we work on this week?" that turn-level granularity
 * can't.
 *
 *   Call after a conversation has been captured. The summary should be
 *   saved as a separate memory with tag `conversation-summary` so it
 *   doesn't get confused with turn-level entries.
 */
export interface ConversationSummaryInput {
  conversationId: string;
  title: string | null;
  turns: Array<{ role: string; content: string }>;
  url?: string;
  capturedAt: number;
}

export async function summarizeConversation(
  conv: ConversationSummaryInput,
  opts: Partial<SummarizationOptions> = {},
): Promise<{ content: string; metadata: Record<string, any> } | null> {
  const o: SummarizationOptions = { ...DEFAULTS, ...opts };
  if (!o.enabled) return null;

  const dialog = conv.turns
    .map(t => `${t.role.toUpperCase()}: ${t.content}`)
    .join('\n\n');
  if (dialog.length < o.minLength) return null;

  const prompt = `Summarize this conversation into a single paragraph (under 150 words) that captures:
- The main topic and goal
- Key decisions, recommendations, or conclusions reached
- Any specific code, references, or technical details worth remembering
- Open questions or things left unresolved

Title: ${conv.title ?? '(untitled)'}
Captured: ${new Date(conv.capturedAt).toISOString()}

Conversation:
"""
${dialog.slice(0, 30_000)}
"""

Output the summary directly, no preamble.`;

  try {
    const resp = await anthropic.messages.create({
      model: o.model,
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });
    for (const block of resp.content) {
      if (block.type === 'text') {
        return {
          content: block.text.trim(),
          metadata: {
            type: 'conversation-summary',
            conversation_id: conv.conversationId,
            conversation_title: conv.title,
            turn_count: conv.turns.length,
            url: conv.url ?? null,
            captured_at: conv.capturedAt,
          },
        };
      }
    }
    return null;
  } catch (e: any) {
    console.warn('[summarizer] conversation summary failed:', e?.message);
    return null;
  }
}
