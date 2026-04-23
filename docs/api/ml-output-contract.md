# Diamond Edge — ML/AI Output Contract v1

**Status:** Draft — requires ML engineer and AI Reasoning engineer sign-off
**Date:** 2026-04-22
**Author:** mlb-architect
**Purpose:** Defines the interface between the ML model output and the AI Reasoning (LLM) layer

---

## Overview

The ML model produces a structured `PickCandidate` object per game/market combination. The AI Reasoning agent consumes this object to generate a human-readable rationale. The pick pipeline (Supabase Edge Function or Fly.io worker job) orchestrates this flow:

```
[Game schedule + odds] → [ML model] → PickCandidate → [AI Reasoning] → rationale_text → [DB write]
```

---

## PickCandidate (ML Model Output)

The ML model produces one `PickCandidate` per market per game where EV > 0 and confidence meets the publication threshold.

```typescript
interface PickCandidate {
  // Identity
  game_id: string;            // matches games.id in Supabase
  market: 'moneyline' | 'run_line' | 'total' | 'prop';
  pick_side: string;          // 'home' | 'away' | 'over' | 'under' | prop description

  // Model outputs
  model_probability: number;  // 0.0–1.0, calibrated win probability for pick_side
  implied_probability: number; // 1 / (best available American odds converted to decimal)
  expected_value: number;     // (model_prob * net_payout) - (1 - model_prob)
                              // e.g., EV of 0.042 = 4.2 cents per $1 wagered

  confidence_tier: 1 | 2 | 3 | 4 | 5; // derived from EV and calibration uncertainty
                                         // 5 = highest confidence; see calibration spec

  // Best line used for EV computation
  best_line: {
    price: number;            // American odds, e.g. -110
    sportsbook_key: string;   // 'draftkings' | 'fanduel'
    snapshotted_at: string;   // ISO 8601 — when this line was pulled
  };

  // Feature attributions (SHAP-style: top N features driving this pick)
  feature_attributions: Array<{
    feature_name: string;     // human-readable: 'starter_era_last_30d', 'bullpen_usage_2d_rest'
    feature_value: number | string;  // actual value of the feature, e.g. 2.87 or 'left'
    shap_value: number;       // contribution to log-odds; positive = toward pick_side
    direction: 'positive' | 'negative'; // toward or against the pick
    label: string;            // human-readable label for rationale: 'Starter ERA (30-day): 2.87'
  }>;

  // Raw feature snapshot (full feature vector for audit/retraining)
  features: Record<string, number | string | null>;

  // Model metadata
  model_version: string;      // e.g., 'moneyline-v1.2.0'
  generated_at: string;       // ISO 8601
}
```

---

## AI Reasoning Prompt Contract

The AI Reasoning agent receives a `PickCandidate` plus game context and produces a `RationaleOutput`.

### Input to AI Reasoning Agent

```typescript
interface RationaleInput {
  pick: PickCandidate;
  game_context: {
    home_team: { name: string; abbreviation: string; record: string; };
    away_team: { name: string; abbreviation: string; record: string; };
    game_time_local: string;       // local ET time, e.g. '7:05 PM ET'
    venue: string;
    probable_home_pitcher: { full_name: string; } | null;
    probable_away_pitcher: { full_name: string; } | null;
    weather: { condition: string; temp_f: number; wind_mph: number; wind_dir: string } | null;
  };
  tier: 'free' | 'pro' | 'elite';  // determines which LLM model and rationale depth
}
```

### AI Reasoning Agent Output

```typescript
interface RationaleOutput {
  rationale_text: string;       // Full markdown rationale. Length varies by tier:
                                // free: 1–2 sentences (teaser only, if rationale shown at all)
                                // pro: 3–5 sentences, cites top 2–3 feature attributions
                                // elite: full paragraph + bullet breakdown of top 5 features

  rationale_preview: string;   // First 1–2 sentences. Always generated. Used for pro+ card previews.

  model_used: string;           // 'claude-haiku-4-5' or 'claude-sonnet-4-6'
  tokens_used: number;
  cost_usd: number;
  generated_at: string;
}
```

---

## Rationale Grounding Rules (for AI Reasoning Agent)

The AI Reasoning agent must:
1. **Only cite facts present in `PickCandidate.feature_attributions` or `game_context`.** No hallucinated stats.
2. **Lead with the strongest SHAP feature** (highest absolute `shap_value`), translated via the `label` field.
3. **State the EV and model probability explicitly** in elite-tier rationale. For pro tier, state model probability. For free tier, omit both.
4. **Never claim certainty.** Use hedged language: "suggests," "tilts the edge toward," "model favors."
5. **Always include one responsible-gambling hedge sentence** at the end: "Past model performance does not guarantee future results. Bet responsibly."
6. **Do not reference the model architecture** (gradient boosting, SHAP, etc.) in the rationale text — the product voice is "statistical analysis," not "machine learning."

---

## Pick Pipeline Orchestration (Seam Diagram)

```
Supabase Edge Function: pick-pipeline
│
├── 1. Fetch today's scheduled games (games table)
├── 2. Fetch latest odds per game (odds table or Redis)
├── 3. For each game:
│       └── HTTP POST to Fly.io worker: /predict
│               Payload: { game_id, features: {...} }
│               Response: PickCandidate[]
│
├── 4. Filter: keep candidates where EV > 0 and confidence_tier >= threshold
│
├── 5. For each PickCandidate:
│       ├── Check rationale_cache (prompt_hash lookup) — skip LLM if cached
│       └── POST to Fly.io worker: /rationale
│               Payload: RationaleInput
│               Response: RationaleOutput
│
├── 6. Write to Supabase:
│       ├── INSERT INTO rationale_cache
│       └── INSERT INTO picks (with rationale_id FK)
│
└── 7. Invalidate Redis: picks:today:* for all tiers
```

---

## Confidence Tier Derivation

The ML agent is responsible for calibrating the mapping from EV + uncertainty to `confidence_tier`. The following is a suggested starting point — ML agent must validate against backtests:

| Tier | EV Range | Notes |
|---|---|---|
| 1 | 0% < EV ≤ 2% | Low edge; free-tier eligible |
| 2 | 2% < EV ≤ 4% | Moderate edge |
| 3 | 4% < EV ≤ 6% | Good edge; pro-tier gated |
| 4 | 6% < EV ≤ 9% | Strong edge |
| 5 | EV > 9% | Premium pick; elite-tier gated |

The ML agent must define the final mapping and document it in `models/*/calibration.md`.

---

## Open Questions for Orchestrator

1. **Free-tier rationale:** Should free-tier users see any rationale text, or just the pick side + confidence tier? If free users see a 1-sentence teaser, Haiku still runs per pick. If no rationale for free, no LLM cost for free-tier picks. Recommend: no LLM call for free-tier picks (saves cost). Escalate to user to confirm.
2. **Confidence threshold for publication:** What minimum confidence_tier ships as a pick? Publishing tier-1 picks (EV 0–2%) may dilute the product's credibility. Recommend: minimum tier 2 for publication, tier 4+ for elite picks. ML agent must validate threshold against backtest ROI. User input needed on product positioning.
3. **Fly.io worker vs. Edge Function for inference:** If the ML model is lightweight (logistic regression, ~100ms inference), it could run in a Supabase Edge Function (Deno, no Python). If it requires scikit-learn or numpy, it needs Fly.io. ML agent must decide and tell DevOps before infra is provisioned.
4. **Rationale cache invalidation:** The `prompt_hash` deduplication assumes the same game + features = same rationale prompt. If features change between pick pipeline runs (e.g., lineup update), the hash changes and a new LLM call fires. This is correct behavior but means LLM costs scale with re-runs. ML agent should specify how often features change per game.
