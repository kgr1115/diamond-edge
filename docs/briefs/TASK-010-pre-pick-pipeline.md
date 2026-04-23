# TASK-010-pre — Pick Pipeline: Supabase Edge Function Orchestration

**Agent:** mlb-backend (with coordination from mlb-ml-engineer on worker HTTP contract)
**Phase:** 2
**Date issued:** 2026-04-22
**Status:** Ready to start

---

## Objective

Implement the daily pick pipeline as a Supabase Edge Function that orchestrates: read today's games + latest odds → call Fly.io worker `/predict` → filter EV ≥ 4% candidates → call rationale generation for Pro/Elite variants → write picks rows to Supabase → invalidate Redis cache — all with structured logging and observable error paths per the DevOps runbooks.

---

## Context

- **Pipeline seam diagram** is defined in `docs/api/ml-output-contract.md`. Implement it exactly.
- **Fly.io worker `/predict` endpoint** is defined in `worker/models/inference-runtime.md`. The contract is:
  - `POST https://diamond-edge-worker.fly.dev/predict`
  - Header: `Authorization: Bearer {WORKER_API_KEY}`
  - Body: `{ game_id: string, markets: string[], features: Record<string, number | string | null> }`
  - Response: `PickCandidate[]` (per `worker/models/pick_candidate_schema.py`)
  - Timeout budget: 30 seconds (Edge Function) total; worker warm response < 1 second; cold start < 7 seconds
- **Feature vector assembly:** The Edge Function must build the feature vector for each game. For Phase 2, implement a best-effort feature assembly from the available DB tables (`games`, `odds`, `players`). Full Statcast features require the Fly.io worker's own DB queries — use a simplified feature set for the initial pipeline, flag the gap to the orchestrator.
- **EV filter (locked decision):** Only candidates with `expected_value >= 0.04` (EV ≥ 4%) are written to the `picks` table as publications. Candidates below this threshold are dropped silently (log at debug level).
- **Rationale generation:**
  - Free tier: NO rationale call. `rationale_id` is NULL on `picks` rows with `required_tier = 'free'`.
  - Pro/Elite: call the rationale endpoint. The pipeline calls the Fly.io worker `/rationale` endpoint which wraps the Claude API (per TASK-007 design). In Phase 2, if TASK-007's rationale endpoint is not yet deployed to Fly.io, substitute a direct Supabase Edge Function call to the Claude API using `apps/web/lib/ai/generate-rationale.ts` logic adapted for Deno/TypeScript.
  - Cache: check `rationale_cache.prompt_hash` before calling. If a matching hash exists, reuse the cached `rationale_cache.id` and skip the Claude API call.
- **`picks` table writes:** The pipeline must determine `required_tier` for each pick:
  - `confidence_tier >= 5` (EV > 9%): `required_tier = 'elite'`
  - `confidence_tier >= 3` (EV 4–9%): `required_tier = 'pro'`
  - Below publication threshold: dropped, not inserted
  - Note: all published picks (tier 3+) have `required_tier` of at least 'pro'. There are no free-tier published picks from the pipeline. Free users see a limited subset on the slate (the `/api/picks/today` route already handles this by returning only `required_tier = 'free'` picks for free users — if no free picks exist, the free slate is empty and shows the zero state).
- **Redis invalidation:** After all picks are written, invalidate `picks:today:{date}:*` cache keys (all tier variants) using the Upstash Redis REST API. Keys: `picks:today:{date}:anon`, `picks:today:{date}:free`, `picks:today:{date}:pro`, `picks:today:{date}:elite`.
- **Trigger:** The pipeline is triggered by `/api/cron/pick-pipeline` (already scaffolded in `apps/web/app/api/cron/` per TASK-003). The cron route calls the Supabase Edge Function via `supabase.functions.invoke('pick-pipeline')` and returns immediately. The Edge Function owns the heavy work.
- **Supabase Edge Functions** run in Deno TypeScript. The function has access to Supabase natively and reads secrets from Supabase Vault (`Deno.env.get(...)`).
- **Observability:** Every significant step must emit a structured log line (JSON). Stages: game_fetch, odds_fetch, worker_call, ev_filter, rationale_call, db_write, cache_invalidate. Each log line includes: `{ event, game_id?, stage, duration_ms, ok: boolean, error?: string }`. These logs flow to the pick-pipeline runbook at `docs/runbooks/pick-pipeline-failure.md` — your error paths must match what that runbook expects to see.

---

## Inputs

- `docs/api/ml-output-contract.md` — pipeline seam diagram, `PickCandidate` and `RationaleInput`/`RationaleOutput` schemas
- `worker/models/inference-runtime.md` — Fly.io worker `/predict` HTTP contract
- `worker/models/pick_candidate_schema.py` — exact PickCandidate field structure
- `docs/schema/schema-v1.md` — `picks`, `rationale_cache`, `games`, `odds`, `sportsbooks` table schemas
- `docs/schema/caching-strategy.md` — Redis key patterns for picks
- `apps/web/app/api/picks/today/route.ts` — understand the `required_tier` logic (reference only)
- `apps/web/lib/redis/cache.ts` — Redis key naming conventions (use the same patterns)
- `docs/runbooks/pick-pipeline-failure.md` — your structured logs must match what this runbook expects
- `docs/infra/secrets-manifest.md` — Supabase Vault secrets available to the Edge Function
- `CLAUDE.md` — locked constraints

---

## Deliverable Format

### 1. `supabase/functions/pick-pipeline/index.ts`

The Supabase Edge Function. Deno TypeScript.

Structure:
```
supabase/functions/pick-pipeline/
  index.ts          ← main entry point
  types.ts          ← TypeScript types (PickCandidate, RationaleInput, RationaleOutput, etc.)
  feature-builder.ts ← assembles feature vector from DB data for each game
  worker-client.ts   ← HTTP client for Fly.io worker /predict and /rationale
  rationale.ts       ← rationale cache check + Claude call (or worker proxy)
  redis.ts           ← Upstash Redis REST client for cache invalidation
```

**Main pipeline flow (in `index.ts`):**

```typescript
// Pseudocode — implement with proper error handling and structured logging

export default async function handler(req: Request): Promise<Response> {
  const today = todayInET(); // 'YYYY-MM-DD'
  
  // 1. Fetch today's scheduled games
  const games = await fetchTodaysGames(today);
  log({ event: 'game_fetch', count: games.length, ok: true });
  
  // 2. For each game: fetch latest odds snapshot
  const gamesWithOdds = await fetchOddsForGames(games);
  log({ event: 'odds_fetch', count: gamesWithOdds.length, ok: true });
  
  // 3. For each game: assemble feature vector + call /predict
  const allCandidates: PickCandidate[] = [];
  for (const game of gamesWithOdds) {
    const features = buildFeatureVector(game);
    const candidates = await callPredict(game.id, features);
    allCandidates.push(...candidates);
    log({ event: 'worker_call', game_id: game.id, candidates: candidates.length, ok: true });
  }
  
  // 4. Filter: EV >= 4%
  const qualified = allCandidates.filter(c => c.expected_value >= 0.04);
  log({ event: 'ev_filter', total: allCandidates.length, qualified: qualified.length });
  
  // 5. For each qualified candidate: generate/fetch rationale (Pro/Elite only)
  const picksToInsert = [];
  for (const candidate of qualified) {
    const requiredTier = candidate.confidence_tier >= 5 ? 'elite' : 'pro';
    let rationaleId: string | null = null;
    
    // Generate rationale for Pro/Elite
    const rationaleResult = await getOrGenerateRationale(candidate, requiredTier);
    rationaleId = rationaleResult.rationale_cache_id;
    log({ event: 'rationale_call', game_id: candidate.game_id, cache_hit: rationaleResult.cache_hit });
    
    picksToInsert.push({ ...candidate, requiredTier, rationaleId });
  }
  
  // 6. Write picks to DB (batch insert)
  if (picksToInsert.length > 0) {
    await insertPicks(picksToInsert, today);
    log({ event: 'db_write', count: picksToInsert.length, ok: true });
  }
  
  // 7. Invalidate Redis cache
  await invalidatePicksCache(today);
  log({ event: 'cache_invalidate', date: today, ok: true });
  
  return new Response(JSON.stringify({ picks_written: picksToInsert.length }), { status: 200 });
}
```

**Error handling requirements:**
- If `/predict` fails for a game: log the error with `game_id`, skip that game, continue with others. Do not abort the entire pipeline for one game's failure.
- If rationale generation fails for a candidate: log the error, write the pick row with `rationale_id = null` (the pick is still published; rationale is missing). Do not drop the pick.
- If DB write fails: log with full error, return 500. This is a hard failure — the pipeline must not silently succeed with no picks written.
- If Redis invalidation fails: log warning, return 200 anyway (stale cache for up to TTL is acceptable).

### 2. `supabase/functions/pick-pipeline/feature-builder.ts`

Feature vector assembly for the `/predict` endpoint.

For Phase 2, implement a **simplified feature set** using only data available in the current DB schema (`games`, `odds`, `players`, `teams`). Full Statcast features require data ingestion work that may not be complete.

Minimum feature set to implement (these must be non-null for `/predict` to produce results):
- `home_team_id`, `away_team_id` (team identity)
- `home_ml_price`, `away_ml_price` (from latest odds for moneyline market, best across DK/FD)
- `home_rl_price`, `away_rl_price` (from run_line market)
- `over_price`, `under_price`, `total_line` (from total market)
- `weather_temp_f`, `weather_wind_mph`, `weather_wind_dir` (from `games` table)
- `home_pitcher_id`, `away_pitcher_id` (from `games.probable_*_pitcher_id`)
- `venue_state` (from `games.venue_state`)

Flag in a top-of-file comment: "Phase 2 simplified feature set. Full Statcast integration (ERA, WHIP, SHAP-ready features) requires data pipeline completion from TASK-004. The ML worker will return empty candidates until training data is available — this is expected in staging."

### 3. Worker HTTP contract (`supabase/functions/pick-pipeline/worker-client.ts`)

**`/predict` request:**
```typescript
interface PredictRequest {
  game_id: string;
  markets: ('moneyline' | 'run_line' | 'total')[];
  features: Record<string, number | string | null>;
}

interface PredictResponse {
  candidates: PickCandidate[];
}
```

**Auth header:** `Authorization: Bearer ${Deno.env.get('WORKER_API_KEY')}`

**Timeout:** 30 seconds (use AbortController with 30s timeout)

**`/rationale` request:**
```typescript
interface RationaleRequest {
  pick: PickCandidate;
  game_context: GameContext;
  tier: 'pro' | 'elite';
}

interface RationaleResponse {
  rationale_text: string;
  rationale_preview: string;
  model_used: string;
  tokens_used: number;
  cost_usd: number;
  generated_at: string;
}
```

**Error handling:** Wrap all worker calls in try/catch. On timeout or non-2xx: log `{ event: 'worker_error', endpoint, status_code, error }`, throw to caller.

### 4. Supabase Edge Function registration

Add deployment config in `supabase/functions/pick-pipeline/` and ensure it appears in the GitHub Actions workflow (`.github/workflows/ci.yml`). Coordinate with DevOps runbook `docs/runbooks/pick-pipeline-failure.md` — your log event names must match what that runbook references.

### 5. Updated cron route (`apps/web/app/api/cron/pick-pipeline/route.ts`)

The cron route is already scaffolded. Update it to call the Supabase Edge Function via `supabase.functions.invoke('pick-pipeline', { method: 'POST' })` and return immediately after triggering. Log the trigger event. Do not await the full pipeline completion.

### 6. Secrets additions to `docs/infra/secrets-manifest.md`

Add to Supabase Vault section:
- `MODEL_ENDPOINT_URL` — Fly.io worker base URL (`https://diamond-edge-worker.fly.dev`)
- `WORKER_API_KEY` — Shared secret for Fly.io worker authentication

(These are already in the Fly.io secrets section from TASK-006; add them to Supabase Vault section since the Edge Function also needs them.)

---

## Definition of Done

- [ ] `supabase/functions/pick-pipeline/index.ts` exists and implements all 7 pipeline stages.
- [ ] Pipeline does not abort on a single-game `/predict` failure — it logs and skips.
- [ ] Pipeline does not drop a pick when rationale generation fails — it logs and writes the pick with `rationale_id = null`.
- [ ] EV filter `>= 0.04` is enforced before any DB write.
- [ ] `required_tier` is set correctly: `confidence_tier >= 5` → `elite`, else → `pro`. No free-tier picks are generated by the pipeline.
- [ ] Rationale cache dedup: existing `prompt_hash` in `rationale_cache` is reused (no duplicate Claude API calls).
- [ ] Redis cache invalidation fires after successful DB write: all 4 tier keys invalidated for today's date.
- [ ] Structured log line emitted at each stage with `event`, `ok`, and relevant IDs/counts.
- [ ] Cron route calls Edge Function and returns immediately (does not await pipeline completion).
- [ ] Worker HTTP contract (`/predict` and `/rationale`) is explicitly defined in `worker-client.ts` with TypeScript types.
- [ ] Feature builder clearly flags Phase 2 simplified scope vs. full Statcast scope.
- [ ] No TypeScript errors in Edge Function (`deno check supabase/functions/pick-pipeline/index.ts` or equivalent).
- [ ] Secrets additions are reflected in `docs/infra/secrets-manifest.md`.
- [ ] Log event names match what `docs/runbooks/pick-pipeline-failure.md` expects.

---

## Dependencies

**Requires:**
- `docs/api/ml-output-contract.md` — DONE (TASK-001): pipeline seam + schemas
- `worker/models/inference-runtime.md` — DONE (TASK-005): worker HTTP contract
- `worker/models/pick_candidate_schema.py` — DONE (TASK-005): PickCandidate types
- `docs/schema/schema-v1.md` — DONE (TASK-001): `picks`, `rationale_cache` schemas
- `apps/web/lib/redis/cache.ts` — DONE (TASK-003): Redis key patterns
- `docs/runbooks/pick-pipeline-failure.md` — DONE (TASK-006): log event names

**Does NOT require:**
- TASK-007 (AI Reasoning) being complete — the worker's `/rationale` endpoint handles LLM calls; you call it by HTTP. If TASK-007 TypeScript module isn't available yet, call the worker endpoint directly.
- TASK-008 (Frontend) — frontend is independent
- TASK-009 (Stripe billing) — independent

**This task unblocks:**
- TASK-011 (QA): needs the full pipeline to run end-to-end
- TASK-012 (DevOps provisioning): needs the Edge Function deployed

**Coordination with mlb-ml-engineer:**
- The `/predict` request `features` dict keys must match what the deployed model expects. For Phase 2, the simplified feature set is acceptable; flag the gap so the ML engineer can validate when model training begins.
- The ML engineer must confirm whether the Phase 2 simplified features produce any non-empty `PickCandidate[]` responses or whether staging will always return an empty array until full Statcast data is loaded. Escalate to orchestrator if this blocks staging validation.
