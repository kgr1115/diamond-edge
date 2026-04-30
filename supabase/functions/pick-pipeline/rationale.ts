/**
 * Rationale cache check + generation for the pick pipeline.
 *
 * Strategy (per TASK-010-pre spec):
 *   1. Hash the canonical rationale prompt (pick + game_context + tier) → prompt_hash
 *   2. Check rationale_cache table for an existing row with that hash
 *   3. If cache hit: return the existing rationale_cache.id
 *   4. If miss: call /rationale on the Fly.io worker → insert into rationale_cache → return ID
 *
 * If rationale generation fails for any reason, the caller writes the pick
 * with rationale_id = null (pick is still published, rationale is missing).
 */

import { callRationale } from './worker-client.ts';
import type { PickCandidate, GameContext, RequiredTier } from './types.ts';

/**
 * Structural prompt version. Bump on any substantive change to the
 * worker's rationale system prompt, tier-depth rules, ban list, or
 * user-prompt shape. Must match RATIONALE_PROMPT_VERSION in
 * worker/app/rationale.py. Including this in the hash input guarantees
 * that stale cached rows generated under an older prompt contract are
 * not served after a prompt revision.
 *
 * History:
 *   v1 (2026-04-24) — first real Anthropic integration. Replaces stub.
 */
const PROMPT_CACHE_VERSION = 'v1';

/** Deterministic hash of the rationale input for dedup. */
async function hashRationaleInput(
  candidate: PickCandidate,
  gameContext: GameContext,
  tier: 'pro' | 'elite'
): Promise<string> {
  // Canonical JSON: stable key order, no timestamps that change between calls
  const payload = JSON.stringify({
    prompt_version: PROMPT_CACHE_VERSION,
    game_id: candidate.game_id,
    market: candidate.market,
    pick_side: candidate.pick_side,
    model_version: candidate.model_version,
    confidence_tier: candidate.confidence_tier,
    tier,
    // Include top 3 feature attributions (the most influential ones) — changes in attributions
    // mean we want a new rationale even if the pick itself is the same.
    top_attributions: candidate.feature_attributions
      .slice(0, 3)
      .map((a) => ({ name: a.feature_name, value: a.feature_value, dir: a.direction })),
    home_team: gameContext.home_team.abbreviation,
    away_team: gameContext.away_team.abbreviation,
  });

  const encoder = new TextEncoder();
  const data = encoder.encode(payload);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface RationaleResult {
  rationale_cache_id: string | null;
  cache_hit: boolean;
}

// Supabase client is passed in so we don't create a new one per call
// deno-lint-ignore no-explicit-any
type SupabaseClient = any;

export async function getOrGenerateRationale(
  candidate: PickCandidate,
  gameContext: GameContext,
  requiredTier: RequiredTier,
  supabase: SupabaseClient
): Promise<RationaleResult> {
  // Only pro/elite picks get rationale (locked decision: free tier = no LLM call)
  const rationaleTarget = requiredTier === 'elite' ? 'elite' : 'pro';

  const promptHash = await hashRationaleInput(candidate, gameContext, rationaleTarget);

  // 1. Check cache
  // Guard added 2026-04-29 (pick-research-2026-04-29.md P0): the legacy stub
  // rationale generator wrote rows with tokens_used = 0. Without this filter,
  // those stub rows are returned as cache hits forever, which is why no real
  // Anthropic call was ever observed in production despite ANTHROPIC_API_KEY
  // being configured. Real responses always have tokens_used > 0.
  const { data: existing } = await supabase
    .from('rationale_cache')
    .select('id')
    .eq('prompt_hash', promptHash)
    .gt('tokens_used', 0)
    .maybeSingle();

  if (existing?.id) {
    return { rationale_cache_id: existing.id, cache_hit: true };
  }

  // 2. Call the worker /rationale endpoint
  const rationaleResponse = await callRationale({
    pick: candidate,
    game_context: gameContext,
    tier: rationaleTarget,
  });

  // 3. Insert into rationale_cache
  const { data: inserted, error: insertError } = await supabase
    .from('rationale_cache')
    .insert({
      model_used: rationaleResponse.model_used,
      prompt_hash: promptHash,
      rationale_text: rationaleResponse.rationale_text,
      tokens_used: rationaleResponse.tokens_used,
      cost_usd: rationaleResponse.cost_usd,
      generated_at: rationaleResponse.generated_at,
    })
    .select('id')
    .single();

  if (insertError || !inserted) {
    throw new Error(`Failed to insert rationale_cache: ${insertError?.message}`);
  }

  return { rationale_cache_id: inserted.id, cache_hit: false };
}
