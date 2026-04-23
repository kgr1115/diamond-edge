---
name: Morning Briefing — 2026-04-23
description: Overnight progress summary for Kyle's check-in. What happened while he slept + decisions awaiting him.
type: project
---

**For Kyle's check-in on 2026-04-23 (morning).**

## TL;DR

The app is deployed, you're logged in as Elite. Overnight, three background agents ran in parallel:
- Research v1: broad MLB edge catalog
- Research v2: bankroll/props/data-source depth
- ML engineer v2: trained models + built FastAPI worker + backtested

**The model works.** Moneyline and run line calibrate cleanly on the 2024 holdout; run line shows ~18% ROI on backtest (moneyline ROI numbers have a home-side bias bug a narrow fix agent is patching now). Totals calibration fails (needs more training data — a v1.1 item).

**The worker is ready to deploy** but needs your explicit OK because it spends real money (~$3-5/mo on Fly.io) and is a shared system per Auto Mode rules.

## What shipped overnight (11 commits)

1. `5f6c38a` — Research v1 (edge catalog, `docs/research/mlb-edge-research.md`)
2. `1859326` — Handedness park factor engineering (ignore order — these interleaved)
3. `cde82bc` — Data pipelines (MLB Stats, Statcast, odds)
4. `a9f432c` — Python project scaffold
5. `8a06540` — FastAPI `/predict` + `/rationale` endpoints + Dockerfile
6. `61b57b1` — Training pipelines + backtest harness
7. `a8670b9` — Opener detection + TTOP weighting features
8. `12131b2` — Backtest + 2024 holdout metrics
9. `5c1ac27` — gitignore cleanup on artifacts
10. `2f88af9` — Research v2 (bankroll/Statcast/props/data, `docs/research/mlb-edge-research-v2.md`)
11. `f3c9cbd` — CLAUDE.md pricing correction

(ROI bias fix commit pending — late-night agent still running when this file was written.)

## Backtest headline (2024 holdout, pre-bias-fix)

| Market | Log-loss | Brier | ECE | Calibration | ROI (flat staking) |
|---|---|---|---|---|---|
| Moneyline | 0.689 | 0.248 | 0.019 | ✅ PASS | INFLATED (bias bug) |
| Run line | 0.655 | 0.225 | 0.016 | ✅ PASS | **~18%** (credible) |
| Totals | 0.679 | 0.243 | 0.035 | ❌ FAIL (max dev 0.065) | not applicable |

The bias-fix agent should have corrected moneyline numbers by the time you check in.

## Decisions awaiting you

1. **Totals gating.** ML engineer recommends: gate to Tier 4+ only until calibration is fixed in v1.1 (needs more training data — Retrosheet umpire features from Research v2 will help).
2. **Kelly sizing approach.** Research v2: ramp 0.10 → 0.15 → 0.25 over first 500 picks, not flat 0.25. Plus a ~50-LOC simultaneous-Kelly solver for multi-pick slates (cuts variance 30–40%). Approve?
3. **Fly.io worker deploy.** Required before real picks land. ~$3-5/mo on scale-to-zero. Your explicit OK needed before I run `flyctl deploy`.
4. **/rationale endpoint.** Currently a stub. Full Claude Haiku integration is ~1 hour of focused ML engineer work. Ship in v1 or defer to v1.1?
5. **LINEUP-01 late-news LLM pipeline.** Research v1 + v2 both call this the highest-ROI post-v1 addition. Requires ~$30/mo RotoWire/FantasyLabs aggregator for X/beat-writer lineup news. Approve for v1.1?
6. **Odds API tier jump.** Currently $59/100K. Adding F5 markets + 30-min polling would need $119/5M. Cross that bridge after F5 backtest results come in?
7. **AAA Statcast integration.** Now public via Baseball Savant minors. v1 or v1.1?

## What I can do while waiting for your answers

- **Deploy Fly.io worker** — only on explicit "yes, deploy it" from you
- **Trigger a test run of the full pipeline end-to-end** — only if the worker is deployed
- **Implement the simultaneous-Kelly solver in a future ML task** — zero cost, waiting on your Kelly approval
- **Gate totals in the Edge Function pipeline** — code change, no cost, follows your decision on gating strategy

## Recently Completed Reference

- Deployment state: `project_state.md`
- Research v1: `docs/research/mlb-edge-research.md`
- Research v2: `docs/research/mlb-edge-research-v2.md`
- Training report: `worker/models/training-report-v1.md`
- Backtest details: `worker/models/artifacts/backtest_summary.json` (gitignored, on disk)
