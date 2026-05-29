/**
 * Model pricing + context-limit lookup table.
 *
 * Used by the savings dashboard to translate token deltas into dollar
 * savings, and to compute "IDE crashes avoided" (recalls where the
 * baseline namespace token count would have exceeded the model's
 * context window).
 *
 * Prices are **input** tokens per 1M, in USD, as of model-card publication.
 * Update quarterly or when a provider publishes new pricing. Static lookup
 * is the right shape here — no need for a live API hit on every recall.
 *
 * Keys are normalized lowercase model IDs. Aliases below cover the
 * common shorthands different clients send (e.g. "claude-3-5-sonnet"
 * vs "claude-sonnet-4-5"). Adding a new provider: append to MODELS
 * and any aliases to MODEL_ALIASES.
 */

export interface ModelPricing {
  /** USD per 1,000,000 input tokens. */
  input_per_1m: number;
  /** Model's maximum context window in tokens. */
  context_limit: number;
  /** Provider family for grouping in UI. */
  family: 'openai' | 'anthropic' | 'google' | 'meta' | 'other';
  /** Human-readable display name. */
  display: string;
}

export const MODELS: Record<string, ModelPricing> = {
  // OpenAI — gpt-4o family
  'gpt-4o': { input_per_1m: 2.5, context_limit: 128_000, family: 'openai', display: 'GPT-4o' },
  'gpt-4o-mini': { input_per_1m: 0.15, context_limit: 128_000, family: 'openai', display: 'GPT-4o mini' },
  'gpt-4-turbo': { input_per_1m: 10.0, context_limit: 128_000, family: 'openai', display: 'GPT-4 Turbo' },
  'o1': { input_per_1m: 15.0, context_limit: 200_000, family: 'openai', display: 'o1' },
  'o1-mini': { input_per_1m: 3.0, context_limit: 128_000, family: 'openai', display: 'o1-mini' },

  // Anthropic — Claude 4.5 / 4.6 family
  'claude-opus-4-6': { input_per_1m: 15.0, context_limit: 200_000, family: 'anthropic', display: 'Claude Opus 4.6' },
  'claude-sonnet-4-6': { input_per_1m: 3.0, context_limit: 200_000, family: 'anthropic', display: 'Claude Sonnet 4.6' },
  'claude-haiku-4-5': { input_per_1m: 0.8, context_limit: 200_000, family: 'anthropic', display: 'Claude Haiku 4.5' },
  'claude-opus-4-5': { input_per_1m: 15.0, context_limit: 200_000, family: 'anthropic', display: 'Claude Opus 4.5' },
  'claude-sonnet-4-5': { input_per_1m: 3.0, context_limit: 200_000, family: 'anthropic', display: 'Claude Sonnet 4.5' },

  // Google — Gemini 2 family
  'gemini-2-flash': { input_per_1m: 0.075, context_limit: 1_000_000, family: 'google', display: 'Gemini 2 Flash' },
  'gemini-2-pro': { input_per_1m: 1.25, context_limit: 2_000_000, family: 'google', display: 'Gemini 2 Pro' },
  'gemini-2-flash-thinking': { input_per_1m: 0.15, context_limit: 1_000_000, family: 'google', display: 'Gemini 2 Flash (thinking)' },
};

/** Aliases — alternate IDs that map to a canonical key in MODELS. */
export const MODEL_ALIASES: Record<string, string> = {
  'gpt-4': 'gpt-4-turbo',
  'gpt-4-turbo-preview': 'gpt-4-turbo',
  'gpt4o': 'gpt-4o',
  'gpt4omini': 'gpt-4o-mini',
  'claude': 'claude-sonnet-4-5',
  'claude-3-5-sonnet': 'claude-sonnet-4-5',
  'claude-3-5-sonnet-20241022': 'claude-sonnet-4-5',
  'claude-3-7-sonnet': 'claude-sonnet-4-5',
  'gemini-pro': 'gemini-2-pro',
  'gemini-flash': 'gemini-2-flash',
};

export const DEFAULT_MODEL_ID = 'gpt-4o';

/** Resolve any model identifier (case-insensitive, alias-aware) to a pricing row. */
export function getModelPricing(modelId?: string | null): ModelPricing {
  if (!modelId) return MODELS[DEFAULT_MODEL_ID];
  const lower = modelId.toLowerCase().trim();
  const canonical = MODEL_ALIASES[lower] ?? lower;
  return MODELS[canonical] ?? MODELS[DEFAULT_MODEL_ID];
}

/** Dollars saved given an input-token delta. */
export function tokensToDollars(tokenDelta: number, modelId?: string | null): number {
  if (tokenDelta <= 0) return 0;
  const pricing = getModelPricing(modelId);
  return (tokenDelta / 1_000_000) * pricing.input_per_1m;
}

/**
 * Returns true if the namespace token count would have exceeded the
 * model's context limit. This is the "we just saved your IDE from
 * crashing" signal — without mnueron, the user literally couldn't fit
 * the conversation/file context into a single prompt.
 */
export function wouldHaveExceededContext(
  baselineTokens: number,
  modelId?: string | null,
): boolean {
  const pricing = getModelPricing(modelId);
  return baselineTokens > pricing.context_limit;
}
