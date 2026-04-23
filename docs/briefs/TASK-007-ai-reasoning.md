# TASK-007 — AI Reasoning: Prompt Design, Cost Model, Eval Harness

**Agent:** mlb-ai-reasoning
**Phase:** 2
**Date issued:** 2026-04-22
**Status:** Ready to start

---

## Objective

Design and implement the complete AI reasoning layer: system prompt, pick-rationale generation function, tier-routing logic (Haiku 4.5 for Pro, Sonnet 4.6 for Elite, NO call for Free), Anthropic prompt caching strategy, cost projection, output format contract, and a factuality eval harness — all living under `apps/web/lib/ai/` and `apps/web/lib/ai/evals/`.

---

## Context

- **LLM routing (locked):** Haiku 4.5 for Pro picks, Sonnet 4.6 for Elite/marquee picks, zero LLM call for Free tier. Do not deviate.
- **Free tier:** No rationale text. No Haiku call. The `rationale_text` field is omitted entirely from Free picks at the API layer (already enforced in `/api/picks/today/route.ts`). Your function must never be invoked for Free tier inputs.
- **Grounding rules (from `docs/api/ml-output-contract.md`):**
  1. Only cite facts present in `PickCandidate.feature_attributions` or `game_context`. No hallucinated stats.
  2. Lead with the strongest SHAP feature (highest absolute `shap_value`), using the `label` field verbatim.
  3. State EV and model probability explicitly for Elite. Model probability only for Pro. Neither for Free.
  4. Never claim certainty — use hedged language: "suggests," "tilts the edge toward," "model favors."
  5. Always end with one responsible-gambling hedge: "Past model performance does not guarantee future results. Bet responsibly."
  6. Never reference model architecture (gradient boosting, SHAP, LightGBM) — product voice is "statistical analysis."
- **Input schema:** `RationaleInput` (defined in `docs/api/ml-output-contract.md`). Includes `PickCandidate`, `game_context`, and `tier`.
- **Output schema:** `RationaleOutput` (defined in `docs/api/ml-output-contract.md`). Includes `rationale_text`, `rationale_preview`, `model_used`, `tokens_used`, `cost_usd`, `generated_at`.
- **Rationale depth by tier:**
  - Pro: 3–5 sentences, cites top 2–3 feature attributions
  - Elite: full paragraph + bullet breakdown of top 5 features
- **Prompt caching:** Stable system prompt + schema primer + grounding rules are cacheable (set as cache_control: ephemeral on the system message). Variable per-pick data (game context, feature attributions, pick side) go in the user message. This minimizes cache misses and Claude API cost.
- **Deduplication:** The pipeline checks `rationale_cache.prompt_hash` (SHA-256 of the assembled prompt) before calling the API. Your function must return the same output for the same input deterministically (temperature=0). The pipeline owns the DB dedup check; your function just needs to produce a stable hash input.
- **Storage:** `rationale_cache` table in Supabase (schema in `docs/schema/schema-v1.md`). The pipeline writes the row; your function returns `RationaleOutput` which the pipeline stores.
- **Fly.io vs. Next.js:** The `/rationale` endpoint on the Fly.io worker (per `worker/models/inference-runtime.md`) proxies Claude API calls. However, for Phase 2 implementation, wire the rationale function as a direct TypeScript module callable from both the Supabase Edge Function pick pipeline AND (for future flexibility) a Next.js API route. The Fly.io worker's `/rationale` endpoint can be a thin Python wrapper that POSTs to the Next.js API route or calls Claude directly — confirm the cleanest approach in your implementation notes.
- **Budget:** Claude API cost must stay within $300/mo total envelope. At 3–6 picks/day, Pro + Elite users, the cost projection must account for cache hit rates.

---

## Inputs

- `docs/api/ml-output-contract.md` — `RationaleInput`, `RationaleOutput`, grounding rules, seam diagram
- `docs/schema/schema-v1.md` — `rationale_cache` table schema
- `worker/models/pick_candidate_schema.py` — Python PickCandidate schema (understand the feature_attributions structure exactly)
- `docs/compliance/copy/responsible-gambling.md` — the responsible gambling hedge sentence must appear on every pick rationale
- `apps/web/lib/types/database.ts` — TypeScript types including `SubscriptionTier`
- `CLAUDE.md` — locked constraints (LLM routing, budget, brand voice)

---

## Deliverable Format

All artifacts under `apps/web/lib/ai/` unless noted otherwise. Commit when complete.

### 1. `apps/web/lib/ai/prompts/system-prompt.ts`
- Exported constant `RATIONALE_SYSTEM_PROMPT: string`
- Stable text only (no pick-specific data). Includes: role definition, grounding rules, output format instructions per tier, brand voice, responsible gambling requirement.
- Marked with a comment: `// Cache-eligible: this content changes only on model updates, not per pick`

### 2. `apps/web/lib/ai/prompts/user-prompt.ts`
- Exported function `buildUserPrompt(input: RationaleInput): string`
- Assembles the per-pick user message: game context, pick side, top N feature attributions (formatted for LLM consumption), tier indicator.
- Format: structured markdown block (not raw JSON) — the LLM should receive human-readable context, not machine JSON.
- Includes the `tier` to signal rationale depth and which fields to include/exclude.

### 3. `apps/web/lib/ai/generate-rationale.ts`
- Exported async function `generateRationale(input: RationaleInput): Promise<RationaleOutput>`
- Tier routing: Elite → Sonnet 4.6, Pro → Haiku 4.5, Free → throws `Error('Rationale not generated for free tier')`
- Anthropic SDK with prompt caching: system message uses `cache_control: { type: 'ephemeral' }`. User message is uncached (per-pick variable data).
- `temperature: 0` for deterministic output (required for prompt_hash deduplication to work).
- Computes `cost_usd` from token usage using current Anthropic pricing (include cache hit vs. miss cost paths).
- Returns `RationaleOutput` with all fields populated.
- Structured log on every call: `{ event, model_used, tokens_used, cost_usd, cache_hit, game_id, tier }`

### 4. `apps/web/lib/ai/types.ts`
- TypeScript types mirroring `RationaleInput` and `RationaleOutput` from `docs/api/ml-output-contract.md`.
- Also export: `PickCandidate`, `GameContext`, `FeatureAttribution`, `BestLine` TypeScript interfaces (match the Python schema field-for-field).

### 5. `apps/web/lib/ai/cost-model.ts`
- Exported function `estimateMonthlyCost(params: { picksPerDay: number; proFraction: number; eliteFraction: number; cacheHitRate: number }): CostEstimate`
- Models cache-hit and cache-miss paths separately.
- Returns monthly cost breakdown: total, per-pick average, by tier.
- Haiku 4.5 pricing: $0.80/M input, $4.00/M output (cache read: $0.08/M). Sonnet 4.6 pricing: $3.00/M input, $15.00/M output (cache read: $0.30/M). Use these prices; note them in a comment with the date so they can be updated.

### 6. `apps/web/lib/ai/evals/rationale-eval.ts`
- Exported function `evalRationale(input: RationaleInput, output: RationaleOutput): EvalResult`
- Factuality checks (all must pass for a non-failing eval):
  1. Every stat, number, or proper noun cited in `rationale_text` must appear in `input.pick.feature_attributions[*].label` or `input.game_context.*`. (Implement as: extract all numerics and team/player names from the rationale, check each against the input.)
  2. Responsible-gambling hedge sentence is present (check for "Bet responsibly" or "1-800-522-4700").
  3. No reference to model architecture keywords: "LightGBM", "gradient", "SHAP", "machine learning", "neural".
  4. For Elite tier: `rationale_text` contains the model probability (formatted as percentage).
  5. For Pro tier: `rationale_text` does NOT contain the EV value.
  6. Hedged language present: one of "suggests," "tilts," "favors," "indicates," "model" appears.
- Returns `{ passed: boolean; failures: string[] }`
- Include a `runEvalSuite(testCases: EvalTestCase[])` function that runs batch evals and prints a summary. Define 3 canned test cases covering: (a) clean Pro pick, (b) clean Elite pick, (c) hallucination injection (feature attribution with a stat not in the input — should fail eval).

### 7. `apps/web/lib/ai/evals/test-cases.ts`
- 3 canned `EvalTestCase` objects (not actual LLM calls — fixture inputs + expected eval outcomes).
- One Pro case, one Elite case, one hallucination-injected failure case.

### 8. `docs/briefs/TASK-007-cost-projection.md` (output artifact, not a brief)
- Cost projection at: 3 picks/day, 5 picks/day, 6 picks/day
- At each volume: assume 60% Pro, 40% Elite, 70% cache hit rate
- Show: monthly LLM cost, per-pick average cost, budget headroom against $300/mo total
- Flag: break-even usage where LLM cost alone hits $50/mo (10% of budget as a trip-wire)

---

## Definition of Done

- [ ] `generateRationale` rejects Free tier input at the function boundary (throws, does not call Claude).
- [ ] `generateRationale` routes Haiku 4.5 for Pro, Sonnet 4.6 for Elite — confirmed in code and in a comment.
- [ ] System prompt is stable (cache-eligible); user prompt is pick-specific (not cached).
- [ ] Temperature is 0 on all Claude API calls.
- [ ] `RationaleOutput.cost_usd` is populated from actual token usage on every call.
- [ ] All 6 factuality eval checks are implemented and tested against the 3 canned test cases.
- [ ] The hallucination test case fails eval (proves the eval catches hallucinations).
- [ ] Cost projection document shows monthly LLM cost < $30/mo at 6 picks/day, 100% users (i.e., cost does not threaten the $300/mo budget envelope even at ceiling).
- [ ] No import of `generateRationale` in any client-side bundle (server-only — verify with a comment or `'server-only'` import guard).
- [ ] TypeScript types in `apps/web/lib/ai/types.ts` match the Python schema field-for-field.
- [ ] All files pass `tsc --noEmit` (no TypeScript errors).

---

## Dependencies

**Requires (must exist before starting):**
- `docs/api/ml-output-contract.md` — DONE (TASK-001)
- `worker/models/pick_candidate_schema.py` — DONE (TASK-005): exact feature_attribution structure
- `worker/models/inference-runtime.md` — DONE (TASK-005): Fly.io confirmed, `/rationale` endpoint noted
- `apps/web/lib/types/database.ts` — DONE (TASK-003)
- `CLAUDE.md` — always present

**Does NOT require:**
- TASK-008 (Frontend) — frontend consumes `rationale_text` from the DB, not from this function directly
- TASK-010-pre (Pick pipeline) — pick pipeline calls this function; you define the function interface

**This task unblocks:**
- TASK-010-pre (Pick pipeline): the pipeline's rationale step calls `generateRationale` or the Fly.io `/rationale` endpoint
- TASK-008 (Frontend): can build rationale UI against the `RationaleOutput` type and the `rationale_text` field in the DB

**New secrets/env vars:**
- `ANTHROPIC_API_KEY` — already in secrets manifest for both Vercel and Supabase Vault. No new secrets needed.
- Add to `docs/infra/secrets-manifest.md` if you introduce any new env vars (you likely won't).
