---
name: Project State — Live
description: Current backlog, in-progress work, blockers, critical path, open questions
type: project
---

Last updated: 2026-05-03 (post-wipe rebuild merged to main; moneyline v0 cold-start lane in flight; picks pipeline still 501-stub awaiting v0 artifact)

## Status

**Operating mode:** personal-tool / portfolio. Paid-SaaS reopen is a future event; rationale work archived until then. Legal/commercial pre-launch blockers SKIPPED for current phase.

**Branch:** `main` at `582c067`. The `wipe-analysis-2026-04-30` branch was fast-forward merged 2026-05-03 (28 commits) and deleted locally. Two side instances on `instance/research` and `instance/frontend` worktrees.

**Production deployment:** `diamond-edge-beryl.vercel.app` (alias `diamond-edge.co` pending DNS). Supabase project `wdxqqoafigbnwfqturmv`. Upstash `famous-bunny-77949`. Stripe + Anthropic provisioned but Anthropic unused (rationale archived). Odds API on $119/5M tier as of 2026-04-30.

## What ships today

- **Ingestion:** schedule-sync, odds-refresh, news-poll, stats-sync crons running as expected.
- **Grading/CLV/calibration:** `outcome-grader` (08:00 UTC), `clv-compute` (09:00 UTC), `calibration-snapshot` (10:00 UTC) routes live on `main`. Will produce real rows the day v0 picks emit.
- **Pick generation:** `/api/cron/pick-pipeline` is a **501 stub** at 16:00 UTC. cron_runs marks it `failure / stub: not_implemented`. Replaces — does not extend — when v0 artifact lands.
- **ROI:** single-source `lib/roi/units.ts`. Bankroll + history surfaces use it.
- **Diagnostic skills:** `check-feature-gap` and `pipeline-anomaly-scan` wired into `pick-test`; dormant until v0 ships.
- **Existing picks in DB:** ~16 graded picks across 2026-04-23 → 2026-04-24 (live + shadow, mostly losses) from a pre-wipe pipeline run. Survived the wipe; usable for backfill ROI/CLV once a script bug is fixed (`pick_outcomes.pnl_units` column missing from `backfill-summary.mjs`).

## Moneyline v0 cold-start lane (in flight)

**Proposal:** `docs/proposals/moneyline-v0-model-2026-04-30-rev3.md` — logistic regression with de-vigged DK+FD consensus closing log-odds anchor + 11 residual features. Train = serve = grade source = DK+FD via The Odds API.

**Lens-holder verdicts:** all three approve-with-conditions on rev3, plus a coverage-gap Option A approval from CEng (drop rows where both DK and FD closes missing — same predicate train/holdout/serve).

**Cold-start specialist routing (per CLAUDE.md auto-chain):**
1. `mlb-data-engineer` — backfill 2022-09 → 2024 closing odds + game logs + lineups + weather
2. `mlb-feature-eng` — 12-feature snapshot-pinned pipeline + look-ahead canary + train/serve parity fixture
3. `mlb-model` — logistic regression (LightGBM fallback only on dual-gate failure)
4. `mlb-calibrator` — reliability audit + isotonic wrap if ECE > 0.04
5. `mlb-backtester` — holdout backtest, EV sweep +1/+2/+3%, 1000-iter bootstrap CIs
6. **CEng v0 sign-off** (bundled report — no `pick-tester` for cold-start)

**Status by step (uncommitted on main; needs commit then closure):**

| Step | Artifact | State |
|---|---|---|
| Schema | migrations 0023–0027 | Written, NOT committed (pinned_at, park_factor_runs, wind features view, closing_snapshot, v0 cluster audit cols) |
| Backfill execution | `scripts/backfill-db/01–09-*.mjs` + `02-weather-meteostat.py` | Run; ~7,402 games × weather populated, 18 wind_dir bad values residual |
| Coverage audit | `docs/audits/moneyline-v0-data-coverage-2026-04-30.md` | Written; 83.5% closing-odds coverage post-drop on 2022-09 → 2024 (~6,034 games) |
| Feature spec | `docs/features/moneyline-v0-feature-spec.md` | Written |
| Feature-eng brief | `docs/briefs/moneyline-v0-feature-eng-brief.md` | Written; spec'd to land `data/features/moneyline-v0/train.parquet` + serving fn |
| Backfill plan | `docs/runbooks/moneyline-v0-backfill-plan.md` | Written |
| ADR-003 | `docs/adr/ADR-003-moneyline-v0-schema-additions.md` | Written, NOT committed |
| `data/features/moneyline-v0/` | train.parquet + canary + parity fixture | NOT YET BUILT |
| `models/moneyline/current/` | logistic artifact + metrics.json + architecture.md | NOT YET BUILT |
| Bundled report → CEng | — | Pending all upstream |

**Residue from pre-wipe (do NOT reuse):** `worker/` directory (Fly.io FastAPI scaffold) + `data/training/*.parquet` + `data/historical-odds/`. The wipe `git rm`'d these but the working-tree files stuck. The rev3 plan rebuilds under Vercel-only collapse; the old worker has the wrong architecture and the old training parquets have the wrong feature set.

## Auto-chain pause points active right now

None blocking. The cold-start lane is mid-flight; specialist dispatches resume from `mlb-feature-eng` (data-engineer's backfill is effectively complete pending a few wind_dir cleanups).

## Done (post-wipe)

- 2026-04-30: analysis-system wipe executed on `wipe-analysis-2026-04-30` branch
- 2026-04-30: rebuild — three-lens governance + methodology-agnostic mandate landed (commit `a01f078`)
- 2026-04-30: skill-creation flow + skill-writer authorization (commit `ed41a3a`)
- 2026-04-30: moneyline v0 backfill scripts + partial execution (commit `7fd2704`)
- 2026-04-30: pitcher/batter game-log tables + wind_dir fix (commit `37f012d`)
- 2026-05-03: rebuild merged to `main`; wipe branch deleted
- 2026-05-03: outcome-grader cron at `/api/cron/outcome-grader` with void path + regrade path (commits `66c7171`, `52bb73e`, `08c09d1`)
- 2026-05-03: clv-compute cron + writer (commit `1f695c2`)
- 2026-05-03: calibration-snapshot cron (commit `a0cdfa6`)
- 2026-05-03: ROI single-sourced in `lib/roi/units.ts` (commit `bf114ad`)
- 2026-05-03: diagnostic skills `check-feature-gap` + `pipeline-anomaly-scan` (commits `90aa54e`, `582c067`)

## In-progress (this session)

1. Refresh `project_state.md` against current main *(this file)*
2. Audit moneyline v0 in-flight work + lens-holder rev3 conditions
3. Drive cold-start lane to v0 sign-off (commit migrations + run feature-eng → model → calibrator → backtester → CEng bundled report)
4. Replace `/api/cron/pick-pipeline` 501 stub with v0 artifact-driven generator
5. Fix `backfill-summary.mjs` (missing `pick_outcomes.pnl_units` reference) and confirm pre-wipe pick grading state

## Blocked

- USPTO trademark clearance — pre-launch only (not build-blocking; deferred for personal-tool phase)
- LLC formation — pre-launch only
- Attorney compliance review — pre-launch only

## Critical path (ordered)

1. [DONE] Wipe + rebuild merged to main
2. [DONE] Grading/CLV/calibration/ROI infra landed
3. **[NEXT] Commit migrations 0023–0027 + ADR-003 + v0 docs** (currently uncommitted on main)
4. **[NEXT] Run `mlb-feature-eng`** — produce `train.parquet`, canary, parity fixture, holdout declaration
5. **[NEXT] Run `mlb-model`** — train logistic, export joblib + metrics.json + architecture.md
6. **[NEXT] Run `mlb-calibrator`** — reliability audit, isotonic wrap if needed
7. **[NEXT] Run `mlb-backtester`** — holdout backtest + bootstrap CIs
8. **[NEXT] CEng v0 sign-off** on bundled report
9. **[NEXT] Wire `/api/cron/pick-pipeline`** — load artifact → infer → EV/tier filter → write picks
10. **[NEXT] Verify outcome-grader settles new picks; fix backfill-summary script for ROI visibility**
11. Launch (after pre-launch blockers clear — separate track)

## Open questions for user

None blocking. Course-corrections welcome on any of the above as the cold-start lane lands.

## Locked decisions (carried)

- Stack: Vercel-only collapse (no Fly.io worker, no Supabase Edge Functions). All compute on Vercel Fluid Compute.
- Methodology-agnostic on architecture; calibrated probability + holdout discipline + CLV-aware ROI + comparison-against-current as the bar are non-negotiable.
- Cold-start lane is single-use per market; subsequent promotions go through `pick-tester`.
- Free tier: NO LLM call. Tier mapping: confidence ≥5 → Elite, 3–4 → Pro, <3 not published. v0 ships side + EV + tier only (rationale archived).
- 21+ age gate, geo-block, RG disclaimer surfaces are compliance-locked.
- Sub-budgets per CLAUDE.md table; Odds API target $119/mo (hard cap $130). Anthropic archived.
