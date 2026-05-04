# wrcplus-ingestion-revB-2026-05-04 — implementer pause

**Stage:** pick-implementer (stage 3 of pick-improvement pipeline)
**Date:** 2026-05-04
**Status:** PAUSED at pre-flight verification gate (pause-point #1 per orchestrator brief)
**Files committed:** zero (partial module written then removed)
**Production state:** unchanged (`models/moneyline/current/` untouched; no DB writes; no cron added)

## Why paused

Pause-point #1 in the orchestrator brief: *"Verification gate fails (5-batter spot-check has any |Δ| > 3 vs sabermetrics) → data-engineer fixes constants/formula; do NOT advance to retrain."*

The verification gate is a **pre-flight** that runs against the formula module BEFORE backfill, BEFORE retrain, BEFORE pick-tester. I ran it before consuming any holdout. It failed. Per the pause rule, the chain stops here.

## What was tried — receipts

Five spot-checks against `statsapi.mlb.com/api/v1/people/{id}/stats?stats=sabermetrics&season=YYYY&group=hitting`. Targets:

| batter | season | sabermetrics wRcPlus | sabermetrics wOBA |
|---|---|---|---|
| Aaron Judge | 2024 | 219.784 | 0.4757 |
| Aaron Judge | 2023 | 173.466 | 0.4204 |
| Aaron Judge | 2022 | 206.155 | 0.4582 |
| Bobby Witt Jr | 2024 | 169.134 | 0.4097 |
| Mookie Betts | 2023 | 164.969 | 0.4165 |

Constants table transcribed from tangotiger.com/index.php/site/article/woba-year-by-year-coefficients (cross-referenced FanGraphs guts.aspx?type=cn). Five formula variants tested:

### Attempt 1 — canonical FG formula with `lg_wRC_per_PA_excl_pitchers` divisor, computed wOBA from byDateRange counting stats, park=1.00

```
case          | computed wRC+ | sabr wRC+ | delta
Judge 2024    | 203.1         | 219.78    | -16.68 FAIL
Judge 2023    | 166.5         | 173.47    | -6.97  FAIL
Judge 2022    | 190.5         | 206.16    | -15.66 FAIL
Witt  2024    | 158.9         | 169.13    | -10.23 FAIL
Betts 2023    | 163.8         | 164.97    | -1.17  PASS
```

1 of 5 PASS. Magnitudes scale with the player's wOBA — points to either (a) wrong constants for `lg_wRC_per_PA_excl_pitchers` or (b) wrong formula structure.

### Attempt 2 — same formula, with player-specific park factors (Yankee Stadium ~1.04, Kauffman ~1.03, Dodger ~0.99) for back-solving the divisor

Implied `lg_wRC_per_PA_excl_pitchers` per (player, season):

```
season | per-player implied lg_wRC/PA       | spread
2022   | 0.10887 (Judge only)               | n/a
2023   | 0.11431 (Judge), 0.12183 (Betts)   | 0.0075 (~6.5% — too wide for a constant)
2024   | 0.10866 (Judge), 0.11049 (Witt)    | 0.0018 (~1.6%)
```

The 2023 spread is 6.5% across Judge vs Betts — impossible if `lg_wRC_per_PA_excl_pitchers` were truly constant per season. The driver is FanGraphs's per-player park factor, which uses Statcast-derived multi-year regressed values that differ from our `park_factor_runs.runs_factor` source.

### Attempt 3 — simpler formula that divides by `lg_R_per_PA` (not `lg_wRC_per_PA_excl_pitchers`), using sabermetrics-published wOBA directly to isolate

```
case          | computed wRC+ | sabr wRC+ | delta
Judge 2024    | 217.12        | 219.78    | -2.67  PASS
Judge 2023    | 168.05        | 173.47    | -5.42  FAIL
Judge 2022    | 204.04        | 206.16    | -2.12  PASS
Witt  2024    | 169.89        | 169.13    | 0.75   PASS
Betts 2023    | 170.32        | 164.97    | 5.35   FAIL
```

3 of 5 PASS, 2 FAIL — even when I feed in FG's exact wOBA, I cannot reproduce wRC+ within ±3 because of park factor asymmetry. The Judge/Betts 2023 deltas have opposite signs (Judge underestimated, Betts overestimated) — a single park-factor adjustment cannot resolve both.

### Attempt 4 — park-neutral (park=1.00 for all), sabermetrics wOBA

```
case          | computed wRC+ | sabr wRC+ | delta
Judge 2024    | 221.12        | 219.78    | 1.33   PASS
Judge 2023    | 172.05        | 173.47    | -1.42  PASS
Judge 2022    | 208.04        | 206.16    | 1.88   PASS
Witt  2024    | 172.89        | 169.13    | 3.75   FAIL
Betts 2023    | 169.32        | 164.97    | 4.35   FAIL
```

3 of 5 PASS. Witt and Betts BOTH fail high — meaning FG is applying *something* (park, league, or a regressed component) to suppress their wRC+ that I am not capturing. **Verification gate requires all 5 PASS.**

## Root cause of the pause

Two compounding gaps:

1. **Park factor source mismatch.** FanGraphs computes wRC+ with multi-year Statcast-regressed park factors that are not what `park_factor_runs.runs_factor` (migration 0024, sourced from FG/B-Ref multi-year aggregates as of 2023) provides. Even if our `runs_factor` values match FG's published static park factors, FG's wRC+ uses a *different* park factor (specifically a per-team weighted home-park factor, possibly with components for HR rate / run environment split).

2. **wOBA computation drift.** My computed wOBA from MLB Stats API byDateRange counting stats is consistently ~0.005 wOBA below sabermetrics-published wOBA. This is likely because basic counting stats do not include **reached-base-on-error (RBOE)** which FG's wOBA optionally includes (depending on the era's wOBA variant), nor do they reconcile sacrifice-fly vs sacrifice-hit edge cases identically.

The 5-PASS gate was designed as the pre-flight before consuming the holdout, and it has correctly flagged that the formula path will not produce FG-quality numbers. Pushing past this would consume the pinned holdout (`moneyline-v0-holdout-2026-05-03`) on a candidate trained against a known-biased feature.

## What unblocks this

Per the proposal's risk-and-rollback section, when verification fails the data-engineer fixes constants/formula. Concretely, three options that would let the chain resume:

### Option A: relax the gate

CSO call. Move the spot-check tolerance from ±3 to ±10. With ±10, attempt 4 (park-neutral, sabermetrics wOBA) passes 5/5. Trade-off: a wRC+ that is systematically biased ±10 on extreme hitters is structurally similar to the OPS+ proxy already in place — the residual lift expectation drops below the |coef| ≥ 0.02 floor, and we ship an ingester that won't change v0's fit. **Cost-effective only if CSO is okay with "ingested but probably doesn't pull weight."**

### Option B: switch the source path

Drop the compute-from-raw approach. Instead, pull `wRcPlus` from MLB Stats API sabermetrics endpoint per-season (so we get FG-parity values exactly) and use the **prior-season carry** semantic from the original memo's "Path A revised."

This was rejected in the memo (§1, "Path A revised: structurally broken") because of the look-ahead-or-stale tradeoff. It IS structurally broken for in-season-as-of-game-date wRC+ — but as a near-term unblock it would get FG-quality numbers into the column and let the retrain happen. The wRC+ residual would represent "last year's batter quality," which is structurally similar to v0's `starter_fip` (a 30-day rolling stat that runs partially on prior-year data early in a season).

CSO call: is "FG-quality but stale" better than "currently zero"? Probably yes for a personal-tool/portfolio phase, and the ingester ships either way.

### Option C: pivot to the Stuff+ proxy from Savant `pitch-arsenal-stats`

Per the original memo's Path C and the orchestrator brief's wRC+-specific gate ("ingester ships regardless; CSO gets the 'ingested but not pulling weight' verdict + Stuff+ pivot recommendation").

Stuff+ proxy has higher expected ROI lift (pitcher-quality is the largest existing residual), and the data is live + populated per probe 9 in the original memo. Effort ~1 week vs the (now-broken) 3-4 day wRC+ path.

This is a cross-lens decision (CSO direction + CEng on residual interpretation + COO on rate-share). The orchestrator brief named Stuff+ as the pivot pre-authorized for the post-retrain "didn't pull weight" failure mode — escalating it now (instead of after building+failing the residual) saves the holdout consumption.

## Recommendation

**Escalate to CSO with Option C as the recommended pivot.**

Rationale:
1. Option A (relax gate) ships an ingester that probably won't move the model and uses up the v0 holdout in the process. The next post-2024-12-31 holdout slice is undeclared; consuming the current pinned holdout on a low-confidence candidate is not a good trade.
2. Option B (prior-year carry) ships FG-quality numbers but with structurally weak as-of-date semantics. It would be useful as a "fix the zeroed residual without breaking anything" placeholder — but the L30-rolling residual it produces will be near-constant (each player's L30 average is just last year's wRC+ × PA-weight ≈ a slowly-changing team-level constant). Low residual loading expected.
3. Option C (Stuff+ proxy) is the orchestrator brief's pre-authorized pivot, has higher expected ROI lift than wRC+ ever did, and uses already-live Savant data. This is the highest-EV pivot.

## What is preserved

- `models/moneyline/current/` — untouched. Production v0 still serves with the 11-residual logistic.
- `models/moneyline/holdout-declaration.json` — declaration_id `moneyline-v0-holdout-2026-05-03` unchanged. Pinned holdout has not been consumed.
- `models/moneyline/candidate-wrcplus-revB-2026-05-04/` — not created.
- `apps/web/vercel.json` — unmodified.
- `batter_game_log.wrc_plus` — still NULL (production state); `wrc_plus_source = 'ops_plus_proxy'` from the original 08-batter-game-log.mjs.
- No new files committed. No DB writes. No cron added.

## Next action owners

- **CSO** — pick the unblock path (A / B / C / something else). Reads this report + the orchestrator brief.
- **mlb-data-engineer** — if Option B, write the simpler MLB Stats API season-pull script. If Option C, write the Stuff+ proxy from `baseballsavant.mlb.com/leaderboard/pitch-arsenal-stats` per-pitch run-value rollup.
- **mlb-research** — owns the Option C source-validation re-probe (the orchestrator brief noted probe 9 from the original memo confirmed the inputs are populated).

## Implementer notes for the next attempt

- The byDateRange MLB Stats API endpoint (`stats=byDateRange&group=hitting&season=YYYY&startDate=...&endDate=...`) is alive and returns counting stats including singles (= hits - 2B - 3B - HR), doubles, triples, HR, BB, IBB, HBP, SF, AB, PA. Confirmed by HTTP 200 and parsed sample for Judge April 2024.
- The sabermetrics endpoint (`stats=sabermetrics&group=hitting&season=YYYY`) returns season-level wRcPlus, woba, wRaa, and FG's full WAR breakdown. Useful as a verification target IF the gate is relaxed, OR as the primary source IF Option B is picked.
- The constants table in the (now-deleted) `scripts/lib/wrc-plus-formula.ts` was structured correctly per the verdict's annotations (source URL + transcription date in comments above declaration; 2025 refresh TODO; record covering 2022/2023/2024). On any future formula-based attempt, copying that scaffolding and only swapping the formula structure is the right move.

---

**Audit trail:** This pause leaves the production v0 unchanged. The implementer made zero commits. The pinned holdout (`moneyline-v0-holdout-2026-05-03`) was not consumed. No specialist downstream of mlb-data-engineer was invoked. The chain stops cleanly per pause-point #1 of the orchestrator brief.
