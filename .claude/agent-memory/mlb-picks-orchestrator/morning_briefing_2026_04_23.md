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

## Backtest headline (2024 holdout) — IMPORTANT: NUMBERS ARE NOT TRUSTWORTHY

Bias-fix agent (`41faa99`) found TWO bugs in the simulator:
1. `simulate_roi` only evaluated home side (away picks invisible)
2. Away RL / under prices were missing from the data pipeline — all opposing-side odds fell back to default -110

### Corrected numbers

| Market | Before (bugged) | After (corrected) | Picks | Calibration |
|--------|----------------|-------------------|-------|---|
| Moneyline | 118.1% | **112.7%** | 1,475 | ✅ ECE 0.019 |
| Run line | 18.1% (was credible?) | **41.0%** | 2,178 | ✅ ECE 0.016 |
| Totals | 23.8% | **26.0%** | 924 | ❌ FAIL |

### ⚠️ HONEST READ from the fix agent

> "Do NOT use these ROI numbers for Kelly sizing. The simulation is fixed; the underlying model is not generating real alpha."

**Why**: fixing the simulator made the pick volume explode (run line 237 → 2,178). That means the model thinks it has edge on nearly every game, which is a sign of **miscalibration** rather than real alpha. Specific issues:
- **Moneyline** pushes probabilities to 0.90 extremes — overconfident
- **Run line** mean P(home cover) = 0.349 vs true ~0.43 on 2024 → mean-probability drift between training and holdout
- At a 4% EV threshold, the drift creates phantom edge on the away side of almost every RL line

**Realistic expectation for a working model**: 2–5% ROI with ~100–200 picks per season, not 41%.

The 4% EV threshold and calibration both need re-work before any real picks ship. This is **not a bug fix — it's model v2** work.

## Update 2026-04-23 afternoon — ML v3 shipped, deploy self-blocked

Commits `9327d7f`, `d51ee1c`, `7298f3b`, `e212372`, `dd8d3b1`:
- **Vig removal** implemented in the backtest simulator
- **CLV harness** added (limitation: only 1 snapshot/day in the backfill — not true closing lines; meaningful for moneyline only)
- **Run-line architecture bug identified**: model outputs league-average 36% home-cover regardless of game state, bets away 96% of time harvesting base rate → not real alpha
- **Temp gate**: pipeline set to EV≥8%, Tier≥5 (from 4%/Tier 3)

### Honest vig-removed ROI (2024 holdout)

| Market | @ 4% EV | @ 8% EV | Mean CLV | Verdict |
|---|---|---|---|---|
| Moneyline | +8.4% (920 picks) | +10.4% (713 picks) | +2.19% | **Plausible** — pending data corruption fix |
| Run line | +41% | (base-rate echo) | -0.27% | **No alpha** — needs architectural rewrite |
| Totals | +37% | suspicious | +0.09% | **No confirmed alpha** — likely base-rate artifact |

### Deploy status

**Worker redeploy self-blocked** by v3 agent — correct behavior. Won't push new code while numbers are above the >10% sanity threshold. Kyle's v1/v2 artifacts still serving at `diamond-edge-worker.fly.dev`.

### Data corruption flagged

`worker/models/pipelines/load_historical_odds.py` has ~8% row corruption (run-line prices appearing in h2h field). Data engineer dispatched 2026-04-23 to fix. Critical because moneyline's +8.4% ROI may be artifact of corruption — or may survive and be real alpha. Cannot tell until rerun.

---

## Decisions awaiting you — RE-PRIORITIZED AFTER BIAS-FIX FINDINGS

**The #1 decision has shifted.** Before the fix: "gate totals, ship MLine + RL." After the fix: **the model itself needs v2 work before publishing any picks is honest**.

### Primary fork

1. **Model v2 before shipping ANY picks** — spend ~1 day fixing calibration and drift:
   - Re-calibrate with isotonic on a broader validation window
   - Investigate why run line mean-prob drifted 2023→2024 (schedule changes? rule changes? data leak?)
   - Add monotonicity constraints / stronger regularization to prevent 0.90 extremes
   - Narrow pick volume via tighter EV thresholds (6–8% instead of 4%)
   - **Expected outcome:** honest 2–5% ROI on 100–200 picks/year, not fake 41% on 2,178
2. **Ship v1 with heavy gating** — publish only picks above 8% EV AND Tier 5 confidence AND run line only (not ML or totals). Volume drops to ~30 picks/year. Risk: still miscalibrated; the 8% threshold is a band-aid.
3. **Ship v1 as "training wheels" mode** — publish picks but mark as "unvalidated model" with prominent disclaimer. Track real-world CLV. Adjust thresholds live. Not ideal for trust.

**Recommendation**: Option 1. The honest read from the bias-fix agent is clear — the numbers are not ROI signals, they're calibration artifacts. Better to spend a day fixing the model than ship unreliable picks.

### Secondary decisions (less urgent, apply post model v2)

4. **Kelly sizing.** Research v2: ramp 0.10 → 0.15 → 0.25 over first 500 picks. Approve for when the model is ready?
5. **Fly.io worker deploy.** Still required before real picks land. Can be deployed NOW even though picks won't publish — pipeline would just write zero picks through conservative thresholds until model v2 lands. ~$3-5/mo scale-to-zero. Your explicit OK needed.
6. **/rationale endpoint.** Currently a stub. Moot until model produces trustworthy picks. Defer to v1.1 unless you want it ready in parallel.
7. **LINEUP-01 ($30/mo RotoWire).** Still the highest-ROI post-v1 addition per both research docs.
8. **Odds API tier.** Hold at $59 until F5 is proven useful.
9. **AAA Statcast.** Useful feature for v1.1 model robustness.

## What I can do while waiting for your answers

- **Spawn ML engineer v3 focused on calibration repair** — zero cost, best use of time if you pick Option 1. Scope: isotonic recalibration, drift investigation, tighter EV threshold sensitivity analysis.
- **Deploy Fly.io worker** — only on explicit "yes, deploy it" from you. Works even before model v2 lands; pipeline would write zero picks under conservative thresholds.
- **Gate totals / all picks in the Edge Function pipeline** — small code change, no cost.
- **Implement simultaneous-Kelly solver** — waiting on your Kelly approval.

## Recently Completed Reference

- Deployment state: `project_state.md`
- Research v1: `docs/research/mlb-edge-research.md`
- Research v2: `docs/research/mlb-edge-research-v2.md`
- Training report: `worker/models/training-report-v1.md`
- Backtest details: `worker/models/artifacts/backtest_summary.json` (gitignored, on disk)
