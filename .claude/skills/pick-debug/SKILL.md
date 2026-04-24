---
name: pick-debug
description: "Root-cause pick-quality regressions — ROI drop, calibration break, feature-coverage loss, rationale hallucination, tier/EV distribution collapse, CLV negative. Invoked by pick-tester on FAIL or directly when picks look wrong. Distinct from /debug (codebase) and /investigate-pick (ONE graded pick). Handles systematic pick-quality issues."
argument-hint: <symptom description>
---

Symptom: `$ARGUMENTS`

---

## Step 0 — State the symptom precisely

Rephrase as one sentence of observable behavior BEFORE touching files.

- Bad: "the model is off"
- Good: "ECE 0.08 on live picks last 30d; backtest ECE was 0.03; tier-5 actual win rate 48% vs calibrated 58%"

---

## Step 1 — Pick existing toolkit first

| Symptom class | Go-to tool |
|---|---|
| ROI trend negative | `/backtest` + `/calibration-check` + `/check-feature-gap` |
| Single pick under-performed | `/investigate-pick <pick_id>` |
| Game-level "why did model pick X" | `/explain <game_id>` |
| Feature coverage drop | `/check-feature-gap` |
| Calibration drift | `/calibration-check` |
| Rationale hallucination | `/rationale-eval` |
| Threshold sensitivity | `/tune-thresholds` |
| Pipeline anomaly | `/run-pipeline` |
| Morning baseline | `/daily-digest` |

If an existing tool solves your question, use it. If not, reason from the evidence and flag for `skill-writer`.

---

## Step 2 — Pick-specific symptom → evidence map

| Symptom | Evidence sources |
|---|---|
| ROI negative | `pick_clv` last 30d; `pick_outcomes` win-rate by tier; `/backtest`; `/check-feature-gap` |
| Calibration broken | `/calibration-check` per-tier reliability; `worker/models/calibration-spec.md`; `worker/app/predict.py` calibration wrapper |
| Too few LIVE picks | `picks` today; EV distribution; `SHADOW_EV_MIN`/`LIVE_EV_MIN`/`SHADOW_TIER_MIN`/`LIVE_TIER_MIN` constants in `supabase/functions/pick-pipeline/index.ts`; `/run-pipeline` |
| Too many LIVE picks | Same constants; odds-feed integrity (EV > 25% flag); `/tune-thresholds` |
| Tier distribution collapsed | Worker `/predict` for a fixture game; calibration wrapper; recent retrain delta |
| Degenerate probabilities | Worker `/health`; last retrain summary; `/check-feature-gap` (model seeing only imputed values) |
| Feature coverage dropped | `/check-feature-gap`; ingester logs; Upstash cache for affected source |
| CLV negative | `pick_clv` time-series; worker pick-time vs closing novig; retrain candidate? |
| Rationale hallucinating | `/rationale-eval`; compare cited stats to `feature_attributions[].label` |
| Rationale disclaimer missing | `worker/app/prompts/rationale-*.txt`; prompt cache state; worker deploy state |
| Rationale cost spike | Anthropic dashboard; prompt cache hit rate; recent prompt changes (structural changes invalidate cache) |
| Worker `/predict` crashing | `fly logs`, `fly status`; feature-vector assembly; NaN/null handling |
| Retrain auto-promoted worse model | `worker/models/retrain/reports/<latest>/summary.json`; `monthly.py` auto-promote rule; diff of `current_version.json` |

---

## Step 3 — Known failure modes (PF-table)

### PF1. Training-serving skew

**Symptom:** backtest good, live calibration off.
**Cause:** training-time feature assembler ≠ serving-time assembler (often unit/scaling / EWMA window / DST-UTC bug).
**Check:** recompute a graded pick's feature vector both ways; diff.
**Fix:** unify assembly via one shared function, or explicitly version both. Needs review.

### PF2. Rationale cache stuck after prompt change

**Symptom:** prompt edit shipped, rationales look old.
**Cause:** structural prompt hash unchanged → cache hits serve stale.
**Check:** Anthropic dashboard call volume post-edit. Flat = cache serving stale.
**Fix:** bump cache-version constant; old entries go cold. Safe.

### PF3. Odds-feed artifact → EV > 25%

**Symptom:** one pick daily with EV 0.30–0.50.
**Cause:** stale/props-mis-mapped/bad odds row; no sanity cap in pipeline.
**Check:** specific `odds` row vs live DK/FD line at that timestamp; ingester log.
**Fix:** cap EV at ~0.20 (reject as artifact) + fix ingester. Needs review.

### PF4, PF5, ... append as incidents happen.

---

## Step 4 — Sub-debugger decision

Decompose a big regression:
- Single market or all markets?
- Calibration / feature-coverage / rationale / ROI — independent threads?
- Edge Function vs worker vs training pipeline?

Spawn sub-debuggers when:
- Sub-investigations genuinely independent.
- Outputs mergeable.
- Cap at 3 parallel; recursion depth 2.

Don't spawn to grep a log.

---

## Step 5 — Safety rails

- **Never mutate `picks` / `pick_outcomes` / `pick_clv`.** Read-only. Mutations → "Needs user's approval."
- **Never auto-retrain / auto-promote.** `monthly.py` thresholds are deterministic; don't override.
- **Never deploy.** No `supabase functions deploy`, `fly deploy`, `vercel deploy --prod`.
- **Never run ingesters against live paid APIs** as diagnostics (The Odds API credits, Anthropic at Sonnet volume).
- **Never touch compliance rules** (RG hedge, architecture-keyword rule, tier-depth rule) as a "fix" — "Needs user's approval."
- **Never push to git.**

---

## Step 6 — Output format

```markdown
## Root cause
{One paragraph. Mechanism, not symptom.}

## Evidence
- {metric / query / file / line / calibration reading / rationale sample}

## Scope (who owns the fix)
- Threshold → pick-implementer, single file
- Feature eng / ingester → mlb-data-engineer via pick-implementer
- Model / calibration → mlb-ml-engineer via pick-implementer
- Rationale prompt / routing → mlb-ai-reasoning via pick-implementer
- Schema / DB / Edge Function → mlb-backend via pick-implementer

## Recommended fix
{Concrete. Name files. Trade-offs.}

## Safety assessment
Safe to apply (APPLIED) | Safe to apply (not yet) | Needs review | Needs user's approval
— reasoning

## Open questions
{empty is fine}
```

---

## Non-negotiables

- Never invent a root cause without evidence.
- Never push to git.
- Never mutate production pick rows, pipeline, or artifacts.
- Never deploy.
- Never touch compliance surfaces as a "fix."
