```yaml
proposal_id: moneyline-v0-2026-04-30-rev3-bundled-report
verdict: approve-with-conditions
lens: CEng
reasoning: >
  Cold-start lane terms are met. Holdout was pre-declared 2026-05-03T22:00Z
  (declaration_id moneyline-v0-holdout-2026-05-03), predates the re-pull, and
  has not been re-used for selection. ROI at +2% EV is +11.33% with bootstrap
  CI lower bound +0.67% on n=416 picks — clears the cold-start positive ROI
  bar without the sub-300 rule applying. ECE point estimate 0.0304 is under
  the 0.04 absolute spec; middle three reliability bins (90% of holdout
  volume) sit within |diff| <= 0.026. Variance-collapse guard PASS:
  anchor coefficient 0.977 with CI containing 1.0, sum |residuals| 0.2952
  vs 0.05 floor, 9 of 11 residuals load non-zero. Look-ahead canary fires
  58x on anchor — audit is alive. Train/serve parity 13/13. Log-loss delta
  vs market is positive in point estimate (CI spans zero — accepted as a
  secondary signal; ROI is the primary). Two yellow items get conditioned,
  not blocked. The n=3,282 train shortfall is 6.2% under the 3,500 floor and
  driven by the documented 2024-09-30 loader stall plus the Option A drop
  predicate working as designed; the 12-feature model is not under-trained
  at this n. The ECE bootstrap CI upper bound (0.0747) reflects holdout-size
  uncertainty (n=609), not a calibration failure — the live-slate re-check
  with isotonic fallback infrastructure already wired is the right control.
  Logistic stays as v0; LightGBM fallback is reserved for a real failure,
  not a marginal log-loss CI. team_wrcplus zero residuals are an ingester
  follow-up (column unpopulated), not a model failure — L2 zeroed two
  constant features cleanly and the active 9 residuals carry the lift.
conditions:
  - waive_3500_train_floor_one_time: Acknowledged for v0 only. Next training
    cycle MUST re-pull the 231 stalled 2024-09-30+ games and report the
    refreshed train n + holdout calibration in the retrain commit. Failure
    to re-pull on cycle 2 is a hard send-back at that point.
  - live_ece_recheck_at_200_picks: After 200-400 graded live picks
    accumulate, re-run /calibration-check on the live slate. If live ECE
    breaches 0.04, fit isotonic on the live graded set and ship the wrapped
    calibrator.joblib in-place — no model retrain needed. Mark this as a
    pinned follow-up the orchestrator owns; do not let it slip past the
    400-pick mark.
  - team_wrcplus_followup: batter_game_log.wrc_plus ingester fix is a
    standing follow-up for mlb-data-engineer. Not a v0 ship blocker.
    When wrc_plus populates, mlb-feature-eng re-runs the build and
    mlb-model retrains; the two zero residuals should load non-trivially
    and the calibration should tighten in the small bins.
  - league_avg_temp_resync: Trivial follow-up — sync serving lib's
    LEAGUE_AVG_TEMP_F (72) to the training-computed actual (73.3) before
    the next retrain. Not blocking; affects only NULL-weather games which
    are essentially zero in train and rare in serve.
  - weather_captured_at_column: When the next look-ahead audit runs, add
    a weather_captured_at column on games so the audit pins weather tightly
    instead of flagging on updated_at bumps. Not blocking.
  - cold_start_lane_consumed: This verdict consumes the moneyline cold-start
    lane. Every subsequent moneyline promotion runs the standard pick-tester
    gates (ROI >= -0.5%, CLV >= -0.1%, ECE <= +0.02 vs current). No second
    bypass.
escalation_target: n/a
```

## What I'm explicitly approving

The artifact at `models/moneyline/current/` (logistic regression, 1 anchor +
11 standardized residuals, raw sigmoid, no isotonic wrap) ships as the
moneyline v0 production model.

## What I'm explicitly NOT approving

- Skipping the live ECE re-check. The 0.04 spec is real; the bootstrap CI
  upper bound is the warning that the holdout-only measurement is thin.
- A second cold-start bypass on any future moneyline retrain.
- Promoting LightGBM as a "while we're here" swap. The fallback path stays
  reserved for an actual failure.

## What pick-publisher should do next

1. Commit `models/moneyline/current/` artifact + `metrics.json` +
   `architecture.md` + `feature-coefficients.json` +
   `holdout-predictions.parquet` + `holdout-declaration.json` per the
   normal pick-publisher recipe with model-artifact size guard.
2. Open a follow-up tracking item for the four conditions above. The
   live_ece_recheck and waive_3500_train_floor conditions are the two that
   matter for the next cycle; the others are housekeeping.
3. Deploy remains user-invoked (`vercel:deploy prod`) per CLAUDE.md pause
   point #4.
