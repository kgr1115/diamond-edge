/**
 * Server-only: AI rationale generation for Diamond Edge picks.
 *
 * This module must NEVER be imported in client-side bundles.
 * It calls the Anthropic API with the server-side ANTHROPIC_API_KEY.
 *
 * Tier routing (locked — do not change without orchestrator approval):
 *   elite → claude-sonnet-4-6
 *   pro   → claude-haiku-4-5
 *   free  → throws immediately, no Claude call
 */
import 'server-only';

import Anthropic from '@anthropic-ai/sdk';
import type { RationaleInput, RationaleOutput } from '@/lib/ai/types';
import { RATIONALE_SYSTEM_PROMPT } from '@/lib/ai/prompts/system-prompt';
import { buildUserPrompt } from '@/lib/ai/prompts/user-prompt';

// ---------------------------------------------------------------------------
// Model routing (locked decision — matches CLAUDE.md LLM routing)
// ---------------------------------------------------------------------------

// Haiku 4.5 default (Pro tier picks)
const MODEL_PRO = 'claude-haiku-4-5' as const;
// Sonnet 4.6 for Elite/marquee picks
const MODEL_ELITE = 'claude-sonnet-4-6' as const;

// ---------------------------------------------------------------------------
// Pricing constants (as of 2026-04-22 — update when Anthropic changes pricing)
// Prices are per 1,000,000 tokens in USD.
// ---------------------------------------------------------------------------
const PRICING = {
  'claude-haiku-4-5': {
    input: 0.80,       // $0.80/M input tokens
    output: 4.00,      // $4.00/M output tokens
    cacheRead: 0.08,   // $0.08/M cached input tokens (cache hit)
    cacheWrite: 1.00,  // $1.00/M tokens written to cache (1.25x of input)
  },
  'claude-sonnet-4-6': {
    input: 3.00,       // $3.00/M input tokens
    output: 15.00,     // $15.00/M output tokens
    cacheRead: 0.30,   // $0.30/M cached input tokens (cache hit)
    cacheWrite: 3.75,  // $3.75/M tokens written to cache (1.25x of input)
  },
} as const;

// ---------------------------------------------------------------------------
// Client (lazy-initialized to avoid module-load failures in tests)
// ---------------------------------------------------------------------------
let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  }
  return _client;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Generate an AI rationale for a pick candidate.
 *
 * Throws if tier === 'free' — free tier picks never get LLM rationale.
 * Temperature is 0 for deterministic output (required for prompt_hash dedup).
 * Cost is computed from actual token usage on every call.
 */
export async function generateRationale(input: RationaleInput): Promise<RationaleOutput> {
  // Free tier guard — hard stop at the function boundary
  if ((input.tier as string) === 'free') {
    throw new Error(
      'Rationale not generated for free tier. This function must not be called for free-tier picks.'
    );
  }

  // Tier routing (locked decision)
  const model = input.tier === 'elite' ? MODEL_ELITE : MODEL_PRO;
  const userPrompt = buildUserPrompt(input);

  const client = getClient();

  const response = await client.messages.create({
    model,
    max_tokens: input.tier === 'elite' ? 1024 : 512,
    // temperature: 0 is required for deterministic output (prompt_hash dedup)
    // Note: temperature is not supported on Opus 4.6+ but IS supported on Haiku 4.5 and Sonnet 4.6
    temperature: 0,
    system: [
      {
        type: 'text',
        text: RATIONALE_SYSTEM_PROMPT,
        // Prompt cache on the stable system prompt.
        // Cache hit saves ~90% of input token cost.
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        // User message is pick-specific — NOT cached (changes every pick)
        content: userPrompt,
      },
    ],
  });

  // Extract rationale text from the first text block
  const rationaleText = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b: Anthropic.TextBlock) => b.text)
    .join('');

  if (!rationaleText) {
    throw new Error(
      `Claude returned empty rationale for game_id=${input.pick.game_id} tier=${input.tier}`
    );
  }

  // Extract rationale preview (first 1–2 sentences)
  const rationalePreview = extractPreview(rationaleText);

  // Compute cost from actual token usage
  const usage = response.usage;
  const pricing = PRICING[model];
  const cacheHit = (usage.cache_read_input_tokens ?? 0) > 0;

  const costUsd = computeCost(usage, pricing);

  // Structured log — consumed by pick pipeline and DevOps runbooks
  console.info(JSON.stringify({
    event: 'rationale_generated',
    model_used: model,
    game_id: input.pick.game_id,
    tier: input.tier,
    tokens_input: usage.input_tokens,
    tokens_output: usage.output_tokens,
    tokens_cache_read: usage.cache_read_input_tokens ?? 0,
    tokens_cache_write: usage.cache_creation_input_tokens ?? 0,
    cost_usd: costUsd,
    cache_hit: cacheHit,
  }));

  return {
    rationale_text: rationaleText,
    rationale_preview: rationalePreview,
    model_used: model,
    tokens_used: usage.input_tokens + usage.output_tokens,
    cost_usd: costUsd,
    generated_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the first 1–2 sentences from rationale text for preview cards. */
function extractPreview(text: string): string {
  // Match sentences ending in . ! ?
  const sentences = text.match(/[^.!?]+[.!?]+/g) ?? [];
  return sentences.slice(0, 2).join(' ').trim();
}

/** Compute cost in USD from Claude API usage object. */
function computeCost(
  usage: Anthropic.Usage,
  pricing: typeof PRICING[keyof typeof PRICING]
): number {
  const inputCost = (usage.input_tokens / 1_000_000) * pricing.input;
  const outputCost = (usage.output_tokens / 1_000_000) * pricing.output;
  const cacheReadCost = ((usage.cache_read_input_tokens ?? 0) / 1_000_000) * pricing.cacheRead;
  const cacheWriteCost = ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) * pricing.cacheWrite;

  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}
