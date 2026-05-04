---
proposal_id: moneyline-v0-2026-04-30-rev3-blocker-resolution
verdict: approve-with-conditions
lens: CSO
choice: C
date: 2026-05-03
---

# CSO verdict — moneyline v0 rev3 blocker resolution

## Choice: Option C (2024-only re-pull with corrected per-game snap timestamps)

## Reasoning

Rev3 was approved on one strategic premise — train source = serve source = CLV-grading
source. Option A breaks that premise within 72 hours of approving it. The Coordination
Note #6 proxy is a documented allowance, not a blessing; using it here means accepting a
training-time anchor (closing line) that differs from the serve-time anchor (T-60 pin)
and restoring the rev2-style monthly residual monitor I just voided. That is the exact
methodology cost rev3 was built to eliminate.

Option B has the right shape but the wrong confidence — the audit itself flags that the
Odds API archive may not return snaps near T-75 for every game. Spending 35K credits and
a day of wall-time on uncertain coverage when we have no users waiting is the wrong
trade. If B were cheap and certain it would win; it is neither.

Option C is the move. Personal-tool / portfolio phase explicitly de-prioritizes
time-to-first-picks in favor of methodology cleanliness. ~1,500 train games on a fully
clean per-game-pinned 2024 dataset preserves source parity, keeps the v0 promotion
package honest, and exercises the sub-300 variance-aware ship rule that CEng already
carried forward for exactly this case. If C fails the empirical bar, the failure is
informative — it tells us the methodology needs more than a sample fix. If A "passes,"
we have shipped a v0 with a known asymmetry that future picks compound against.

## Conditions

1. Re-pull 2024 with per-game snap timestamps targeting `game_time_utc - 75min`; cap at
   7K credits, post-pull reconciliation in `metrics.json` (COO sub-budget guard preserved).
2. Holdout pre-declaration must restate source parity in writing before training: train
   anchor = serve anchor = DK+FD T-60 pin via The Odds API on the 2024 re-pull. No proxy
   clause in `architecture.md`.
3. Sub-300 variance-aware ship rule (lower CI bound on ROI AND CLV >= -1%) is the
   operative gate; CEng owns the call on whether ~1,500-train / projected sub-300 graded
   picks clears.
4. If 2024 re-pull coverage on T-60 strict pin lands below 80% per game-date, escalate
   back to CSO before specialist dispatch — that signals the API archive itself is the
   blocker and Option B's coverage assumption was wrong, which changes the v0 question
   entirely.
5. LightGBM fallback path remains available per rev3 `approach_b_fallback` if logistic
   fails the variance-aware gate; do not silently widen the EV threshold to manufacture
   sample size.
6. `batter_game_log` backfill runs in parallel (free, 6h, no cost question) so features
   8 and 9 are ready when the re-pull lands.

## What this changes in the rev3 spec

- Training window narrows from 2022-09 through 2024 to 2024 only (≈1,500 train games,
  ≈400 holdout post-ASB).
- Sample-size projection drops; sub-300 ship rule is now the expected gate, not a
  contingency.
- COO reconciliation budget tightens from 100K credits to 7K credits.
- All other rev3 conditions (holdout discipline, look-ahead canary, anchor-coefficient
  reporting, variance-collapse guard, calibration spec, rollback path) carry forward
  unchanged.

## Cross-lens dependencies

- COO must confirm the 7K credit cap and the Odds API per-game timestamp endpoint
  behavior is understood before backfill kicks off.
- CEng must accept that the v0 sign-off package will report n in the 100-300 range and
  that the variance-aware sub-300 rule is the gate, not a fallback.
- Specialist dispatch order: `mlb-data-engineer` (Odds re-pull + batter backfill in
  parallel) → `mlb-feature-eng` → `mlb-model` → `mlb-calibrator` → `mlb-backtester` →
  bundled report to CEng.
