/**
 * Cost modeling for Diamond Edge AI rationale generation.
 *
 * Used by the pick pipeline and cost projection tooling to estimate
 * monthly Claude API spend at various pick volumes and user tier mixes.
 *
 * Pricing constants are as of 2026-04-22. Update when Anthropic changes pricing.
 * Source: https://www.anthropic.com/pricing
 */

// ---------------------------------------------------------------------------
// Pricing per 1M tokens (USD) — as of 2026-04-22
// ---------------------------------------------------------------------------

const PRICING_HAIKU_4_5 = {
  model: 'claude-haiku-4-5',
  input: 0.80,       // $0.80/M input tokens (cache miss)
  output: 4.00,      // $4.00/M output tokens
  cacheRead: 0.08,   // $0.08/M cached input tokens (cache hit, ~10% of input price)
  cacheWrite: 1.00,  // $1.00/M tokens written to cache (1.25x of input = $1.00)
} as const;

const PRICING_SONNET_4_6 = {
  model: 'claude-sonnet-4-6',
  input: 3.00,       // $3.00/M input tokens (cache miss)
  output: 15.00,     // $15.00/M output tokens
  cacheRead: 0.30,   // $0.30/M cached input tokens (cache hit, ~10% of input price)
  cacheWrite: 3.75,  // $3.75/M tokens written to cache (1.25x of input = $3.75)
} as const;

// ---------------------------------------------------------------------------
// Token budget estimates per rationale call
// (system prompt tokens are stable and cache-eligible)
// ---------------------------------------------------------------------------

/** System prompt token count (approximately stable across all picks). */
const SYSTEM_PROMPT_TOKENS = 600;

/** Per-pick user prompt token count (game context + attributions). */
const USER_PROMPT_TOKENS_PRO = 350;    // Pro: fewer attributions
const USER_PROMPT_TOKENS_ELITE = 500;  // Elite: more attributions + context

/** Output tokens per rationale. */
const OUTPUT_TOKENS_PRO = 200;   // 3–5 sentences
const OUTPUT_TOKENS_ELITE = 450; // paragraph + 5 bullet points

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CostParams {
  /** Picks published per day (after EV ≥ 4% filter). Expected: 3–6. */
  picksPerDay: number;
  /** Fraction of picks consumed by Pro tier users (0.0–1.0). */
  proFraction: number;
  /** Fraction of picks consumed by Elite tier users (0.0–1.0). */
  eliteFraction: number;
  /**
   * Cache hit rate for the system prompt (0.0–1.0).
   * A cache hit means the system prompt tokens are charged at cacheRead price.
   * First call per day = miss; subsequent calls = hit.
   * Realistic steady-state: 0.7–0.9.
   */
  cacheHitRate: number;
}

export interface TierCost {
  tier: 'pro' | 'elite';
  model: string;
  callsPerDay: number;
  callsPerMonth: number;
  costPerCall: number;
  monthlyTotal: number;
}

export interface CostEstimate {
  params: CostParams;
  pro: TierCost;
  elite: TierCost;
  totalMonthly: number;
  perPickAverage: number;
  budgetHeadroom: number; // against $300/mo total budget
  budgetUsedPct: number;
  /** Days until monthly LLM cost hits $50 (trip-wire = 10% of $300/mo budget). */
  daysToTripWire: number | null;
}

const TOTAL_BUDGET_USD = 300;
const LLM_TRIPWIRE_USD = 50; // 10% of budget — flag if monthly LLM cost reaches this

/**
 * Estimate monthly Claude API cost for the rationale generation layer.
 *
 * proFraction + eliteFraction should sum to 1.0 (or less if some picks
 * are not consumed by any paid tier, which would be unusual).
 */
export function estimateMonthlyCost(params: CostParams): CostEstimate {
  const { picksPerDay, proFraction, eliteFraction, cacheHitRate } = params;

  const proCalls = picksPerDay * proFraction;
  const eliteCalls = picksPerDay * eliteFraction;

  const proMonthly = proCalls * 30;
  const eliteMonthly = eliteCalls * 30;

  const proCostPerCall = computeCallCost(
    PRICING_HAIKU_4_5,
    USER_PROMPT_TOKENS_PRO,
    OUTPUT_TOKENS_PRO,
    cacheHitRate
  );

  const eliteCostPerCall = computeCallCost(
    PRICING_SONNET_4_6,
    USER_PROMPT_TOKENS_ELITE,
    OUTPUT_TOKENS_ELITE,
    cacheHitRate
  );

  const proMonthlyTotal = proMonthly * proCostPerCall;
  const eliteMonthlyTotal = eliteMonthly * eliteCostPerCall;
  const totalMonthly = proMonthlyTotal + eliteMonthlyTotal;

  const totalPicksPerMonth = (proCalls + eliteCalls) * 30;
  const perPickAverage = totalPicksPerMonth > 0 ? totalMonthly / totalPicksPerMonth : 0;

  const budgetHeadroom = TOTAL_BUDGET_USD - totalMonthly;
  const budgetUsedPct = (totalMonthly / TOTAL_BUDGET_USD) * 100;

  // How many days at this burn rate until we hit the $50 LLM trip-wire?
  const dailyCost = totalMonthly / 30;
  const daysToTripWire = dailyCost > 0
    ? Math.ceil(LLM_TRIPWIRE_USD / dailyCost)
    : null;

  return {
    params,
    pro: {
      tier: 'pro',
      model: PRICING_HAIKU_4_5.model,
      callsPerDay: proCalls,
      callsPerMonth: proMonthly,
      costPerCall: proCostPerCall,
      monthlyTotal: proMonthlyTotal,
    },
    elite: {
      tier: 'elite',
      model: PRICING_SONNET_4_6.model,
      callsPerDay: eliteCalls,
      callsPerMonth: eliteMonthly,
      costPerCall: eliteCostPerCall,
      monthlyTotal: eliteMonthlyTotal,
    },
    totalMonthly,
    perPickAverage,
    budgetHeadroom,
    budgetUsedPct,
    daysToTripWire: daysToTripWire !== null && daysToTripWire > 365 ? null : daysToTripWire,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type Pricing = typeof PRICING_HAIKU_4_5 | typeof PRICING_SONNET_4_6;

/**
 * Compute the USD cost for a single rationale API call.
 *
 * On a cache hit: system prompt tokens are charged at cacheRead rate.
 * On a cache miss: system prompt tokens are charged at input rate + cacheWrite rate.
 */
function computeCallCost(
  pricing: Pricing,
  userPromptTokens: number,
  outputTokens: number,
  cacheHitRate: number
): number {
  // Input tokens = user prompt only (system prompt is the cached prefix)
  const inputCost = (userPromptTokens / 1_000_000) * pricing.input;

  // System prompt: cache hit path vs cache miss path
  const systemCostHit = (SYSTEM_PROMPT_TOKENS / 1_000_000) * pricing.cacheRead;
  const systemCostMiss =
    (SYSTEM_PROMPT_TOKENS / 1_000_000) * pricing.input +
    (SYSTEM_PROMPT_TOKENS / 1_000_000) * pricing.cacheWrite;
  const systemCost = cacheHitRate * systemCostHit + (1 - cacheHitRate) * systemCostMiss;

  // Output
  const outputCost = (outputTokens / 1_000_000) * pricing.output;

  return inputCost + systemCost + outputCost;
}
