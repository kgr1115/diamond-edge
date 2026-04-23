# ADR-002 — Market-Blend + Late-News Pipeline Architecture (B2 + B3)

**Status:** Accepted
**Date:** 2026-04-22
**Author:** mlb-architect
**Supersedes:** None. Extends `docs/api/ml-output-contract.md` v1 and the pipeline in `supabase/functions/pick-pipeline/index.ts`.

---

## Objective

Replace the predict-from-scratch v4 moneyline model (CLV +0.036%, no real alpha) with a market-blend delta model (B2/MKT-01) anchored to DK/FD novig probabilities, augmented by a Claude Haiku late-news extraction pipeline (B3/LINEUP-01) that injects structured news signals in the T-90min pre-game window.

---

## Context

### Why the current model has no alpha

v4 walk-forward cross-validation (documented in `worker/models/training-report-v1.md`) produced:

- CLV: +0.036% (meaningful threshold: +1.0%)
- Model outputs: 50% ± 8% std across all games — the model is essentially a market-prior tracker
- Root cause: With 25 LightGBM trees on 3,662 games, the model cannot diverge meaningfully from the market prior it consumes as its top SHAP feature (`market_implied_prob_home`, weight 0.11)

Predicting from scratch against an efficient MLB market at personal-use data budgets is not viable. The correct architectural response is to treat the market as an expert prior and model only the residual delta.

### Locked constraints driving this design

- Stack: locked. Next.js 15, Supabase (Postgres + Edge Functions), Fly.io worker (Python), Upstash Redis, Anthropic Claude only.
- Vercel Hobby cron: 2 jobs max. Pro: unlimited, $20/mo upgrade.
- Odds API: $59/mo entry tier, hard cap $100/mo.
- LLM: Claude Haiku 4.5 (default), Sonnet 4.6 (premium).
- Budget: <$300/mo total. Current infra baseline ~$150-180/mo before this ADR.
- Sportsbooks: DK + FD only in v1. Data model must accept more books without schema churn.

---

## Decision

### B2 — Market-Blend Delta Model (MKT-01)

#### Market prior source

Use the **DK/FD blend novig probability** as the prior. Formula:

```
novig_dk = 1 / (dk_home_decimal + dk_away_decimal)  # normalize to remove overround
novig_fd = 1 / (fd_home_decimal + fd_away_decimal)

# Home novig per book:
novig_home_dk = (1/dk_home_decimal) / (1/dk_home_decimal + 1/dk_away_decimal)
novig_home_fd = (1/fd_home_decimal) / (1/fd_home_decimal + 1/fd_away_decimal)

market_novig_prior = 0.5 * novig_home_dk + 0.5 * novig_home_fd
```

Rationale for equal-weight blend: DK and FD are the only v1 books; neither is consistently sharper than the other on MLB moneyline. If v1.1 adds Pinnacle or a third book, update weights using historical CLV-per-book correlation. The formula is parameterized and schema-safe — adding a third book is a weight parameter change, not a schema change.

#### Delta model target (continuous regression)

The delta model predicts:

```
y = outcome - market_novig_prior
```

Where `outcome` is binary (1 = home win, 0 = away win) and `market_novig_prior` is the blend computed above. This is a **continuous regression target**, not classification.

Rationale: A regression delta model directly answers "how much does our model believe the market has mispriced this game?" A classifier trained on (market_prior, features) → outcome would re-learn the prior from features and reproduce the same near-zero delta problem. Continuous regression on the residual forces the model to explain only variance the market has not already captured.

The final probability used for EV and pick generation:

```
model_delta = delta_model.predict(features)  # output clipped to [-0.15, +0.15]
final_prob = market_novig_prior + model_delta
final_prob = clip(final_prob, 0.05, 0.95)   # hard safety bounds
```

The clip bound of ±0.15 on the delta reflects the realistic ceiling of model edge in an efficient market. A predicted delta larger than ±0.15 is almost certainly noise or data error, not signal. The bound is a hyperparameter the ML agent may tune via backtesting but must document in `worker/models/moneyline/calibration.md`.

#### Training target construction

For each historical game in the training set:

```
market_novig_prior = blend formula above (applied to opening-line odds snapshot)
y_delta = actual_outcome - market_novig_prior
```

Both columns exist in the historical odds backfill (`data/historical-odds/`) and the `games` table. The ML agent must confirm that the historical odds snapshots represent **opening line** (not closing line) so the model is trained on the same information state that will exist at pick-generation time. If only closing lines are available in backfill, flag this as a training contamination risk — the model would be trained on information available after picks are generated.

#### Evaluation — beats-market baseline

The v5 model is declared fit for production if and only if it beats the market-novig baseline on the 2024 holdout:

| Metric | Beats-market baseline | Victory threshold |
|---|---|---|
| CLV | Market novig = 0% CLV by definition | >= +0.5% sustained over 200+ picks |
| Honest ROI | Market novig = 0% ROI (minus vig) | >= +2% sustained |
| Log-loss | Market novig baseline on 2024 holdout | Delta model log-loss strictly < market-only log-loss |
| Brier | Market novig baseline | Delta model Brier strictly < market-only Brier |

If `final_prob = market_novig_prior` always (model_delta = 0 always), the evaluation degenerates to 0% CLV and 0% ROI. If the B2 delta model achieves this degenerate result after implementation, the hypothesis that "our Statcast/pitcher/weather features add signal beyond an efficient MLB market" is falsified at personal-use data scale. In that case escalate to orchestrator before proceeding to B3.

---

### B3 — Late-News LLM Pipeline (LINEUP-01)

#### Signals Claude Haiku extracts

One structured extraction call per game, consuming all news items for that game's participants in the T-90min window. The extraction prompt targets:

| Signal type | Description | Schema field |
|---|---|---|
| `late_scratch` | Key player removed from posted lineup | `late_scratch` |
| `lineup_slot_change` | Player moved in batting order (1-2 spot = high impact; 8-9 = low) | `lineup_slot_change` |
| `surprise_starter` | Opener announced after probable SP listed | `surprise_starter` |
| `weather_flag` | Field-condition change material enough to affect total (rain, wind shift) | `weather_flag` |
| `injury_downgrade` | Probable → questionable, or worse, after lineup posted | `injury_downgrade` |
| `fatigue_signal` | Manager rest signal (e.g., scheduled day off delayed, key reliever unavailable) | `fatigue_signal` |

#### News signal output schema

The Haiku extraction produces one `NewsSignals` object per game:

```typescript
interface NewsSignalItem {
  present: boolean;
  confidence: 'confirmed' | 'rumor' | 'none';
  player_id: string | null;           // MLB Stats API player ID if applicable
  war_proxy: number | null;           // Season WAR or best available proxy
  probability_delta: number | null;   // Model's estimated impact on win prob, e.g. -0.04
  raw_text_excerpt: string;           // The source sentence from the news feed (grounding)
}

interface NewsSignals {
  game_id: string;
  extracted_at: string;               // ISO 8601
  late_scratch: NewsSignalItem;
  lineup_slot_change: NewsSignalItem;
  surprise_starter: NewsSignalItem;
  weather_flag: NewsSignalItem;
  injury_downgrade: NewsSignalItem;
  fatigue_signal: NewsSignalItem;
  signal_count: number;               // number of signals with present=true
  haiku_tokens_used: number;
  haiku_cost_usd: number;
}
```

The `probability_delta` fields are the ML agent's responsibility to derive from historical impact analysis — Haiku extracts the signal presence and grounding text; the delta magnitude is a lookup or small regression model trained separately. Haiku does not hallucinate probability adjustments.

#### Prompt caching

The extraction prompt structure is stable (it changes only when the schema above changes). Only the raw news text block changes per invocation. The Anthropic prompt caching API should cache the system prompt + schema portion. This is the AI Reasoning agent's implementation concern; the contract from this ADR is that only variable content (raw news text per game) is passed as the uncached user turn.

Estimated token cost at 15 games/day with a typical 400-token news block per game plus 600-token system prompt (cached after first call in a session):

```
Uncached input:   600 tokens × 1 call/day = 600 (first call, system prompt)
                  400 tokens × 15 games   = 6,000 (news text per game)
Cache read input: 600 tokens × 14 calls   = 8,400 (cached system prompt, subsequent calls)
Output:           150 tokens × 15 games   = 2,250

Haiku pricing (2026): $0.80/M input, $0.08/M cache read, $4.00/M output
Daily cost: (6,600/1M × $0.80) + (8,400/1M × $0.08) + (2,250/1M × $4.00)
          = $0.00528 + $0.00067 + $0.009
          = ~$0.015/day → ~$0.45/mo
```

Budget impact: negligible. Even at 5x underestimate = $2.25/mo. Well within headroom.

---

### Pipeline Architectural Changes

#### Intraday refresh problem

The current pipeline runs once daily (12pm ET via Vercel Cron). Late-news signals require a second run at **T-90min before each game's first pitch**. MLB game times are distributed across the day (7:05pm ET most common, but afternoon games exist).

#### Recommended cron strategy: Supabase pg_cron (no Vercel Pro upgrade needed)

**Option A — Vercel Pro ($20/mo):** Unlimited crons. Simple. But adds $20/mo for an infrastructure problem that has a free solution.

**Option B — Supabase pg_cron (recommended):** Supabase includes pg_cron in all plans at no additional cost. Schedule two jobs:

```sql
-- Job 1: Morning pipeline (12pm ET = 16:00 UTC)
-- Pulls schedule, odds, team features. Generates initial picks.
SELECT cron.schedule('morning-pipeline', '0 16 * * *',
  'SELECT net.http_post(url := ''https://<project>.supabase.co/functions/v1/pick-pipeline'', ...)'
);

-- Job 2: Intraday late-news sweep (runs 5:30pm, 6:30pm, 7:30pm ET = 21:30, 22:30, 23:30 UTC)
-- Covers most 7:05pm ET first pitches. Afternoon games handled by morning run.
SELECT cron.schedule('late-news-sweep', '30 21,22,23 * * *',
  'SELECT net.http_post(url := ''https://<project>.supabase.co/functions/v1/late-news-pipeline'', ...)'
);
```

This uses two Supabase Edge Functions instead of Vercel Crons. No Vercel Pro upgrade needed. Vercel Hobby's 2 cron slots are preserved for other uses (e.g., outcome grading after games end).

**Option C — GitHub Actions (free):** Workflow_dispatch on schedule. Works, but introduces a dependency on GitHub availability and adds latency from Actions runner cold start (~30-60s). Not recommended unless pg_cron is unavailable.

**Option D — Accept once-daily:** Valid only if we decide not to ship B3. B3 is the late-news pipeline; if we don't run near first pitch, we lose the T-90min window entirely. Not acceptable if B3 ships.

**Decision: Option B.** Use pg_cron with two Supabase Edge Functions. No cost increase.

#### New Edge Function: `late-news-pipeline`

A second Edge Function (`supabase/functions/late-news-pipeline/`) is added. Its stages:

```
1. game_window_fetch    — load games with first_pitch between now and now+120min
2. news_fetch           — pull news from RotoWire feed for involved teams/players
3. haiku_extract        — call /rationale-news on worker for structured extraction
4. news_signals_write   — upsert news_signals per game to DB
5. pick_update          — for any previously-written picks for these games:
                          recompute final_prob with news deltas applied
                          update picks.model_probability, picks.news_signals_applied
6. cache_invalidate     — invalidate Redis picks:today:* if any picks changed
```

This function runs in Supabase Edge Functions (Deno, 150s limit — sufficient for 5-game batches). The worker gains a new `/rationale-news` endpoint for Haiku extraction; this is separate from `/rationale` (which generates human-readable rationale text).

---

## Data Model Changes

### New table: `news_events`

Stores raw ingested news items before LLM processing. Source-agnostic to accommodate more feeds in v1.1+.

```sql
CREATE TABLE news_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source        text NOT NULL,            -- 'rotowire', 'mlb_api', 'manual'
  source_item_id text,                    -- provider's own ID for dedup
  headline      text NOT NULL,
  body          text,
  published_at  timestamptz NOT NULL,
  team_id       uuid REFERENCES teams(id),
  player_id     uuid REFERENCES players(id),  -- nullable; null if team-level news
  game_id       uuid REFERENCES games(id),    -- nullable; resolved in extraction
  ingested_at   timestamptz NOT NULL DEFAULT now(),
  processed     boolean NOT NULL DEFAULT false
);

CREATE INDEX news_events_published_at_idx ON news_events (published_at DESC);
CREATE INDEX news_events_game_id_idx ON news_events (game_id) WHERE game_id IS NOT NULL;
CREATE INDEX news_events_processed_idx ON news_events (processed) WHERE NOT processed;
```

RLS: `news_events` is internal-only (no user-facing reads). No user RLS policy needed. Service role only.

### New table: `news_signals`

Stores the structured LLM extraction output per game, one row per pipeline run.

```sql
CREATE TABLE news_signals (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id               uuid NOT NULL REFERENCES games(id),
  extracted_at          timestamptz NOT NULL,
  late_scratch          jsonb,    -- NewsSignalItem
  lineup_slot_change    jsonb,    -- NewsSignalItem
  surprise_starter      jsonb,    -- NewsSignalItem
  weather_flag          jsonb,    -- NewsSignalItem
  injury_downgrade      jsonb,    -- NewsSignalItem
  fatigue_signal        jsonb,    -- NewsSignalItem
  signal_count          smallint NOT NULL DEFAULT 0,
  haiku_tokens_used     integer,
  haiku_cost_usd        numeric(8,6),
  pipeline_run_id       uuid      -- correlates with pick pipeline invocation (for audit)
);

CREATE INDEX news_signals_game_id_extracted_idx ON news_signals (game_id, extracted_at DESC);
```

RLS: internal-only. Service role only.

### New table: `market_priors`

Stores the computed novig blend per game per market at pipeline run time. Required for training data reconstruction and CLV measurement.

```sql
CREATE TABLE market_priors (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id               uuid NOT NULL REFERENCES games(id),
  market                text NOT NULL,          -- 'moneyline' | 'run_line' | 'total'
  snapshotted_at        timestamptz NOT NULL,   -- when the underlying odds were fetched
  computed_at           timestamptz NOT NULL DEFAULT now(),
  novig_home_prob_dk    numeric(5,4),           -- DK home novig probability
  novig_home_prob_fd    numeric(5,4),           -- FD home novig probability
  market_novig_blend    numeric(5,4) NOT NULL,  -- 50/50 blend, the actual prior used
  dk_home_price         integer,                -- raw American odds at snapshot time
  fd_home_price         integer,
  dk_away_price         integer,
  fd_away_price         integer
);

CREATE INDEX market_priors_game_id_market_idx ON market_priors (game_id, market, snapshotted_at DESC);
```

RLS: internal-only. Service role only.

### Extensions to `picks` table

Three columns added (backend agent writes migration from this spec):

```sql
ALTER TABLE picks ADD COLUMN market_novig_prior    numeric(5,4);   -- blend at pick time
ALTER TABLE picks ADD COLUMN model_delta           numeric(6,4);   -- raw model output before clip
ALTER TABLE picks ADD COLUMN news_signals_applied  boolean NOT NULL DEFAULT false;
ALTER TABLE picks ADD COLUMN news_signals_id       uuid REFERENCES news_signals(id);
ALTER TABLE picks ADD COLUMN market_prior_id       uuid REFERENCES market_priors(id);
```

These columns are nullable for backward compatibility. v4 picks written before this ADR land with nulls in these columns; pick display and grading logic must handle null `market_novig_prior` gracefully.

### Extensions to `odds` table

The novig computation runs at query time from raw prices — no stored derived column needed. The `market_priors` table is the canonical store for computed novig values. Avoids redundancy and keeps the `odds` table to raw-from-source data only.

---

## Feature Schema Additions

### Market-derived features (added to `/predict` request payload)

```typescript
interface MarketFeatures {
  market_novig_prior: number;          // blend novig prob for home team, this market
  market_novig_prob_dk: number;        // DK novig alone (for divergence detection)
  market_novig_prob_fd: number;        // FD novig alone
  market_implied_volatility: number;   // |novig_dk - novig_fd| — book disagreement
  line_movement_pct_24h: number | null; // (opening_price - current_price) / opening_price
}
```

`market_implied_volatility` captures DK/FD disagreement, which is a weak but real signal that one book has seen sharp action the other hasn't. It is not the same as MKT-02 (line movement velocity, which requires multiple intraday polls).

### News-derived features (added to `/predict` request payload at T-90min)

```typescript
interface NewsFeatures {
  has_late_scratch: boolean;
  late_scratch_war_impact: number | null;   // positive = home team lost player, negative = away
  has_surprise_starter: boolean;
  surprise_starter_confidence: 'confirmed' | 'rumor' | 'none';
  has_injury_downgrade: boolean;
  injury_downgrade_war_impact: number | null;
  has_lineup_slot_change: boolean;
  has_weather_flag: boolean;
  news_signal_count: number;                // total signals present (0 if no news)
  news_extracted_at: string | null;         // ISO 8601; null if news pipeline hasn't run yet
}
```

When `news_extracted_at` is null (morning pipeline runs before late news is available), news features default to all-false/null/0. The delta model must handle this state correctly — the ML agent must verify the model degrades gracefully to market-prior-only mode when news is absent.

---

## Worker Contract Changes

### New `/predict` request shape (v2)

The existing `/predict` endpoint receives an extended payload. The ML agent may version the endpoint (`/predict/v2`) or accept both shapes via optional fields. Recommend versioned path to allow A/B comparison.

```typescript
// POST /predict/v2
interface PredictRequestV2 {
  game_id: string;
  markets: Array<'moneyline' | 'run_line' | 'total'>;
  market_features: MarketFeatures;        // NEW: required
  news_features: NewsFeatures;            // NEW: optional at morning run, present at T-90min
  features: Record<string, number | string | null>;  // existing Statcast/pitcher/weather features
  model_version_target?: string;          // 'v4' | 'v5-delta' — for A/B routing
}

// Response shape — extends existing PickCandidate
interface PickCandidateV2 extends PickCandidate {
  market_novig_prior: number;    // the prior used
  model_delta: number;           // raw delta before clip
  model_version: string;         // 'moneyline-v5-delta' or 'moneyline-v4'
}
```

### Backward compatibility

The v4 worker (`/predict`) remains deployable. The v5 delta model exposes `/predict/v2`. The pipeline Edge Function routes to v2 when `WORKER_MODEL_VERSION=v5` env var is set. This enables A/B: run both endpoints in parallel during staging, compare CLV before cutting over.

**Cut-over decision:** v4 is retired when v5 demonstrates CLV >= +0.5% on >= 50 live picks. If B2 fails the evaluation threshold, revert to v4 (still deployed) and escalate.

### New `/rationale-news` endpoint

```typescript
// POST /rationale-news
interface NewsExtractionRequest {
  game_id: string;
  news_items: Array<{
    headline: string;
    body: string | null;
    published_at: string;
    source: string;
  }>;
  game_context: {
    home_team_name: string;
    away_team_name: string;
    home_players: Array<{ player_id: string; name: string; war: number | null; }>;
    away_players: Array<{ player_id: string; name: string; war: number | null; }>;
    game_time_utc: string;
  };
}

// Response
interface NewsExtractionResponse {
  game_id: string;
  signals: NewsSignals;   // matches the DB schema above
}
```

---

## Evaluation Framework

### A/B: v4 vs v5 delta model

Both models run simultaneously in staging for the first 50 live picks:

| Metric | v4 (control) | v5-delta target |
|---|---|---|
| CLV | Baseline (expected ~+0.036%) | >= +0.5% |
| Honest ROI | Baseline (expected ~0%) | >= +2% over 200 picks |
| Log-loss vs market novig | Baseline | Strictly lower |
| Picks with model_delta > ±0.02 | Baseline distribution | Higher count = model is differentiating |

If v5 still shows 0% CLV after 100 live picks, escalate to orchestrator. Possible conclusions:

1. B2 hypothesis falsified — no Statcast feature adds signal above market at personal-use data scale. Options: accept market-novig as pick generator (product changes significantly), or invest in additional data sources (Statcast xFIP, release-point variability from v2 research Track B).
2. Training data contamination — opening vs closing odds issue in backfill must be investigated.
3. Delta clip bounds too tight — model is clipping real signal. Loosen ±0.15 bound and re-evaluate.

### B3 evaluation (LINEUP-01)

Evaluate after 4 weeks of live late-news runs:

- Win rate on games where `news_signal_count >= 1` vs games with no signals (expect higher win rate on confirmed-signal games).
- CLV delta on confirmed-scratch games specifically (most reliable signal type).
- Haiku cost vs budget: must remain < $5/mo.

---

## Budget Impact

| Line item | Monthly cost | Notes |
|---|---|---|
| RotoWire feed | $30–50 | Kyle approved. Data engineer selects plan. |
| Vercel Pro upgrade | $0 | Avoided by using Supabase pg_cron |
| Anthropic Haiku (news extraction) | ~$0.45 | Estimated above at 15 games/day with caching |
| Anthropic Haiku (rationale, unchanged) | existing | No change to rationale pipeline |
| Odds API (unchanged) | $59 | No poll frequency increase needed for B2 |
| All other infra (unchanged) | ~$90–110 | Supabase Pro, Vercel Hobby, Upstash, Fly.io |
| **Total projected** | **~$180–220/mo** | Well within $300 envelope |

Risk: If RotoWire is $50/mo and existing infra runs at high end (~$110), total = $160.45. Ample headroom.

---

## Implementation Sequence

### Phase 1 — Architecture (this ADR)

Owner: mlb-architect. DONE when committed.

### Phase 2 — Data ingestion and market prior computation

Owner: mlb-data-engineer.
Inputs: This ADR, `docs/schema/` specs.
Deliverables:
- RotoWire feed ingestion into `news_events` table
- `market_priors` table population from historical odds backfill (required for v5 training data construction)
- `market_novig_blend` computation logic, tested against known DK/FD prices
- pg_cron schedule for `late-news-pipeline` invocations
Dependency: None. Can start immediately after ADR committed.

### Phase 3 — AI Reasoning: Haiku extraction prompt

Owner: mlb-ai-reasoning.
Inputs: This ADR (`NewsSignals` schema, `/rationale-news` contract), news_events sample data from Phase 2.
Deliverables:
- System prompt for Haiku extraction (with prompt caching structure)
- Eval harness: 20 sample news items with ground-truth labels (confirmed scratch / not scratch)
- `/rationale-news` endpoint implementation on Fly.io worker
- Cost measurement on sample slate (validate ~$0.015/day estimate)
Dependency: `news_events` must have sample rows (Phase 2 partial deliverable).

### Phase 4 — ML Engineer: B2 delta model

Owner: mlb-ml-engineer.
Inputs: This ADR (delta model spec, feature schema), `market_priors` table populated with backfill data.
Deliverables:
- Confirm historical odds backfill = opening lines (or flag contamination risk)
- Construct `y_delta = outcome - market_novig_blend` training targets for 2021-2023 games
- Train LightGBM delta model with walk-forward CV (temporal, not random k-fold)
- Evaluate against beats-market baseline on 2024 holdout (must beat market on log-loss AND Brier)
- Update `worker/models/moneyline/calibration.md` with delta clip bounds and tier mapping
- Expose `/predict/v2` on Fly.io worker
Dependency: `market_priors` backfill from Phase 2.

### Phase 5 — Backend: Pipeline v2 with intraday refresh

Owner: mlb-backend.
Inputs: This ADR, Phase 2–4 deliverables.
Deliverables:
- Supabase migration for `news_events`, `news_signals`, `market_priors` tables and `picks` column additions
- `late-news-pipeline` Edge Function (new, per pipeline stages above)
- Updates to existing `pick-pipeline` Edge Function: route to `/predict/v2`, write `market_novig_prior` and `model_delta` to picks
- pg_cron job registration for both functions
- RLS policies: internal-only on all new tables (no user-facing reads)
Dependency: Phases 2, 3, 4 all complete.

### Phase 6 — QA: End-to-end validation, staging gate

Owner: mlb-qa.
Inputs: Phase 5 deployed to staging.
Deliverables:
- Staging pipeline smoke test: morning run produces picks with non-null `market_novig_prior`
- Late-news sweep: inject synthetic news event, verify `news_signals` row appears and pick is updated
- A/B validation: v4 and v5 both produce picks; verify v5 `model_delta` != 0 for >= 30% of picks (if it's 0 for all, the model is degenerate)
- CLV logging validation: closing-line fetch happens after game and CLV is recorded in picks table

### Phase 7 — Deploy + live A/B

Owner: mlb-devops.
Gate: Phase 6 staging sign-off.
Deliverables:
- Production deploy with `WORKER_MODEL_VERSION=v5` env var
- Monitoring: Supabase log stream for `late-news-pipeline` function; alert if haiku_cost_usd > $0.10/day
- Dashboard: CLV vs market-novig-baseline, updated daily

---

## Consequences

### Enables

- A falsifiable hypothesis: either B2+B3 produce measurable CLV above market, or we know this approach doesn't work at personal-use scale and can pivot early.
- Market-novig prior as a legitimate pick generator even if the delta model fails (at 0% ROI minus vig, but calibrated picks).
- Intraday news signals feeding pick updates — this is the mechanism through which T-90min market inefficiency (if it exists) is captured.
- Backward compatibility: v4 remains deployable; A/B routing means no big-bang cutover risk.
- RLS-clean new tables: all new tables are internal-only, no user-facing policy needed.

### Closes off

- Predict-from-scratch models with no market anchor. The v4 approach is retired by this ADR for v1 production. Research models can still train without market priors in `worker/models/research/`.
- Single daily pipeline for all pick generation. The morning pipeline covers team/pitcher features; T-90min pipeline covers news. Picks generated before late news runs are amended in place, not regenerated.

---

## Open Questions

1. **Historical odds = opening lines?** The `market_priors` backfill from `data/historical-odds/` must be confirmed to represent opening lines, not closing lines. If closing lines were used, the delta model is trained on information not available at pick time — a temporal contamination equivalent to the v2 random k-fold problem. **Data engineer must confirm before Phase 4 starts.** This is the highest-priority unresolved question.

2. **RotoWire plan selection:** RotoWire offers multiple tiers. Data engineer should select the minimum plan that includes intraday lineup updates and injury news. Confirm price is in $30-50 range Kyle approved before subscribing.

3. **Odds API opening-line access:** Does the $59/mo Odds API tier return historical opening lines, or only current lines? If only current, we have closing lines in backfill, not opening lines. This feeds directly into Open Question 1. Data engineer must check API documentation.

4. **Delta clip bounds:** The ±0.15 cap on model_delta is an architectural default. ML agent must validate this bound against the backtest delta distribution — if 95th-percentile deltas are ±0.08, the cap is too loose and could pass noise. If 99th-percentile deltas are ±0.18, the cap clips real signal. ML agent owns this tuning.

5. **News extraction confidence threshold:** When Haiku returns `confidence: 'rumor'` for a late scratch, should the delta be applied at full magnitude, half magnitude, or zero? This ADR leaves the answer to the AI Reasoning agent and ML agent to co-determine based on the Phase 3 eval harness results. Default until determined: apply rumor signals at 50% of confirmed magnitude.

6. **pg_cron availability on Kyle's Supabase plan:** pg_cron requires the `pg_cron` extension to be enabled. On Supabase Pro this is available; on Free tier it may require manual enabling. DevOps agent must confirm before Phase 5.

---

## Appendix — Seam Diagram

```
[Morning pipeline, 12pm ET]
  pg_cron → pick-pipeline Edge Function
    → odds table (latest odds) → market_priors (novig computation)
    → games table (schedule)
    → Fly.io /predict/v2 (Statcast + market features, no news features)
    → picks table (INSERT with market_novig_prior, model_delta, news_signals_applied=false)
    → Redis invalidate

[Late-news sweep, 5:30-7:30pm ET]
  pg_cron → late-news-pipeline Edge Function
    → news_events table (items since last sweep)
    → Fly.io /rationale-news (Haiku extraction)
    → news_signals table (UPSERT)
    → picks table for games in window (UPDATE model_probability, news_signals_applied=true)
    → Redis invalidate if any picks changed
```
