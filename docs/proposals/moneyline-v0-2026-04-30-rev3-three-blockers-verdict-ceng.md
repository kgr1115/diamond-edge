```yaml
proposal_id: moneyline-v0-2026-04-30-rev3-three-blockers
verdict: approve-with-conditions
lens: CEng
choice: B
reasoning: >
  Option A is a real train/serve asymmetry, not a documented one I can wave
  through. Anchor at training time would be the closing line; anchor at serve
  time is the T-60 snapshot. Different distributions on the single feature
  carrying most of the weight. The model learns coefficients tuned to the
  sharper signal and gets the noisier one in production. That is the exact
  invariant rev3 was built to lock — train source = serve source = CLV-grading
  source. Coordination Note #6 anticipated the case but did not pre-authorize
  it; CEng signoff still required. Bootstrap CIs and the sub-300 lower-CI rule
  cover sample variance, not a feature distribution shift on the anchor.
  Option B costs ~12 extra hours and ~35K credits (≈0.7% of the 5M monthly
  tier, $0 incremental dollars). It fixes the root cause: the historical
  backfill stored the wrong timestamp. Re-pull with a per-game snapshot param
  near game_time_utc - 75min and let the API return the nearest archived snap.
  Where the API has no near-T-60 snap and falls back to the close, those rows
  are exactly the rows option A would have used anyway — B degrades to A on a
  subset, no worse. Where the API has near-T-60 snaps, B clears the asymmetry
  and recovers coverage toward the original ≈5,000-row target. Option C trades
  sample for cleanliness with no offsetting gain.
conditions:
  - per_game_snapshot_param: backfill script computes the snapshot timestamp param as `game_time_utc - 75 minutes` per game, not a per-batch wall-clock. mlb-data-engineer documents the chosen offset and rationale in the script header.
  - response_timestamp_recorded: store the Odds API response's actual archived snap timestamp (whatever field the API returns) in `snapshotted_at`, not the request timestamp. If the API returns multiple snaps in one response, store each row's true snap timestamp. This is the underlying defect; the verdict does not approve B without it being fixed.
  - coverage_floor_after_repull: if post-repull coverage at strict `snapshotted_at <= game_time_utc - interval '60 minutes'` clears ≥ 3,500 graded train rows post-warmup-and-drop, proceed. If not, escalate to me before falling back to A's proxy interpretation. I want to see the post-repull coverage table before any fallback decision.
  - drop_predicate_unchanged: rev3-coverage-gap conditions still apply on the repulled set. Rows with no real DK+FD close at T-60 get dropped train/holdout/serve, no anchor imputation.
  - holdout_predeclared_before_repull: pre-declare 2024 post-ASB holdout in writing before the repull starts, not after. The repull touches both train and holdout windows; declaring after lets selection bias creep in.
  - leakage_canary_runs_on_repulled_data: the deliberate-leakage canary feature audit runs on the new train slice. A canary that doesn't fire on the repulled data invalidates the audit.
  - batter_backfill_in_parallel: run scripts/backfill-db/08-batter-game-log.mjs in parallel with the odds repull. Both must complete before specialist dispatch resumes.
  - credit_ceiling: hard cap the repull at 100K credits per the existing COO rev3 condition. Month-by-month chunking with credit reconciliation per chunk in metrics.json. If the pull approaches 100K with substantial date range remaining, halt and surface to COO.
  - audit_script_filter_unchanged: look-ahead audit continues to use `<= as_of` as the strict filter. The whole point of B is to make `as_of` (T-60) the right pin. No audit-script tuning to `<= game_time_utc` for the anchor.
escalation_target: n/a
```

## Per-question summary

1. **Pick: B.** Train/serve asymmetry under A is real, not paper. The anchor is the one feature whose distribution must match between train and serve, and A breaks it on every night game in the historical window.
2. **Why not A:** Coordination Note #6 anticipated the case. It did not pre-authorize it. The note says "use the closing line as proxy with documentation" — documentation does not collapse a distribution shift. The model trained on the close will mis-weight the T-60 snap at serve time, and the bootstrap CIs cannot detect this because they sample from the training distribution, which is the wrong one.
3. **Why not C:** ~1,500 train rows is worse on every axis than A's ~1,790 with no offsetting cleanliness gain (A's drop predicate already gives a clean sample). C is dominated.
4. **Why B's risk is bounded:** worst case for B is the API returns the close for every snap-param request. That degrades B to A on every row and we re-evaluate. Best case B recovers most of the 5,339 finals at strict T-60 pin. The downside is one extra wall-day, not a methodology compromise.
5. **What I am NOT approving:** any path that ships v0 with the anchor distribution mismatched between train and serve. The whole point of rev3 was to lock that invariant. B is the path that preserves it.
