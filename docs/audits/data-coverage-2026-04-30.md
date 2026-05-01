# Data-coverage audit — 2026-04-30

**Lane:** research
**Author:** `pick-researcher` dispatch (read-only)
**Source script:** `docs/audits/data-coverage-2026-04-30.mjs` (re-runnable)
**DB:** Supabase (live), read-only queries

## Why this audit exists

The analysis layer was wiped today (2026-04-30) and is being rebuilt from scratch. Before any methodology proposal lands, we need a ground-truth inventory of what data is actually in Postgres — not what the migrations and backfill scripts say *should* be there. Proposals that assume features exist that don't will get DENIED at the gate or fail empirically; better to know now.

Scope: 2022-2024 historical (the moneyline v0 training window) + 2025/2026 (current-season serving substrate).

## Headline

**Joint training-row eligibility for moneyline v0 is 0% across all three seasons.** Not because most features are missing — because `batter_game_log` is empty. The table exists; the backfill (`scripts/backfill-db/08-batter-game-log.mjs`) has not run.

If batter coverage is brought to parity with pitcher coverage, eligible-game count would be roughly:
- 2022: ~1,950 games (~80% of finals — bottleneck: odds closing coverage on at least one book)
- 2023: ~1,950 games (~80%)
- 2024: ~1,600 games (~66% — additional bottleneck: 17% pitcher_game_log gap)

Plus a smaller but real serving-side problem: **0 closing moneyline snapshots for any 2026 game**. The live odds ingester writes rows but does not flag them as closing snapshots. Without this, current-season picks have no CLV ground truth.

## Inventory

### games

| metric | value |
|---|---|
| date range | 2022-04-07 → 2026-05-02 |
| total rows | 7,403 |
| final-status rows | 7,369 |
| 2022 finals | 2,430 |
| 2023 finals | 2,430 |
| 2024 finals | 2,427 (+ 1 cancelled) |
| 2025 | **none — gap** |
| 2026 | 82 final, 1 live, 32 scheduled |

`divisional_flag` distribution shifts hard between 2022 and 2023:
- 2022: 47% divisional (1,140 / 2,430) — old balanced schedule
- 2023-24: 32% divisional (~780 / 2,430) — new unbalanced schedule

This is a genuine regime change, not a data error. Any feature or model that conditions on divisional games must account for the schedule format change at the 2022→2023 boundary.

### odds (moneyline)

| season | DK closing | FD closing | row dupes | null prices |
|---|---|---|---|---|
| 2022 | 1,992 / 2,430 (82%) | 2,005 / 2,430 (82%) | 0 | 0 |
| 2023 | 2,026 / 2,430 (83%) | 1,994 / 2,430 (82%) | 0 | 0 |
| 2024 | 1,963 / 2,427 (81%) | 2,088 / 2,427 (86%) | 0 | 0 |

12,068 historical closing rows total. The unique partial index from migration 0026 is enforcing one-closing-per-(game,book,market) cleanly. No zero or null prices.

Other markets (`run_line`, `total`) have ~1,465 live rows each and **zero closing snapshots**. v0 is moneyline-only, so this is fine for now, but any extension to spreads or totals will need a closing-snapshot backfill for those markets.

`odds.source` is set on all live + historical rows; 22 ML rows have NULL source (pre-migration-0027). 2025 has zero rows. 2026 has live rows but no closing snapshots.

### pitcher_game_log

| season | finals | both-side ≥1 row | both starters present | starter rows | reliever rows | distinct pitchers |
|---|---|---|---|---|---|---|
| 2022 | 2,430 | 2,430 (100.0%) | 2,425 (99.8%) | 4,855 | 15,963 | 871 |
| 2023 | 2,430 | 2,430 (100.0%) | 2,428 (99.9%) | 4,858 | 15,696 | 863 |
| 2024 | 2,427 | 2,031 (83.7%) | 2,027 (83.5%) | 4,059 | 13,021 | 810 |

Avg IP and K per appearance look right (~1.97 IP, ~2.0 K). Starter-row count is ~2× finals-with-both-starters as expected (one per side). No multi-starter rows — the `is_starter = first pitcher listed` heuristic is producing exactly one starter per side per game.

**The 2024 gap is the priority pitcher-side fix.** 396 missing finals across 2024 — likely the partial-execution state from today's backfill. Re-run `07-pitcher-game-log.mjs` to close this.

### batter_game_log

**Empty.** 0 rows for 2022, 2023, 2024.

The table and indexes exist (migration 0029 ran). The backfill script `08-batter-game-log.mjs` is committed but has not been executed. Wall time estimate from the script comment: 5-8 hours at 2 req/sec for ~7,290 games.

### Drop reasons by season — the bottleneck per season

| season | missing DK close | missing FD close | missing home starter | missing away starter | missing home lineup | missing away lineup |
|---|---|---|---|---|---|---|
| 2022 | 438 | 425 | 2 | 3 | 2,430 | 2,430 |
| 2023 | 404 | 436 | 1 | 1 | 2,430 | 2,430 |
| 2024 | 464 | 340 | 396 | 398 | 2,427 | 2,427 |

Lineup is universal (every game blocked). Pitcher gap is concentrated in 2024. Odds gap is fairly stable per season — about 18-19% of finals lack a closing snapshot on at least one of DK/FD.

## Implications for the new analysis layer

**Before any methodology proposal can be backtested.**

1. **Run `08-batter-game-log.mjs` for 2022-2024.** Required for any v0 feature that touches lineup quality (team_wrcplus_l30_*). Until this runs, joint eligibility is 0%, full stop.
2. **Re-run `07-pitcher-game-log.mjs` to close the 2024 gap.** ~396 games of starter data missing.
3. **Backfill closing moneyline odds for the missing ~18%.** This may or may not be possible from the cached `data/historical-odds/` JSON — the matcher's gap output should be inspected. If the gaps are systematic (matcher false negatives), tune the matcher; if the gaps are real (Odds API didn't snapshot those games), accept ~80% as the v0 ceiling.
4. **Decide what to do about the 2025 gap.** No 2025 games means: (a) the model can train on 2022-2024 and validate on 2024-late or 2026 only, (b) holdout-vs-training balance is constrained, (c) any feature that needs a 2024-2025 transition (rule changes, schedule format) cannot be empirically tested through that boundary. This is a CSO-shaped question.
5. **Fix the closing-snapshot flagger for current-season odds.** Live `odds_api_live` rows are never marked `closing_snapshot = true`. Without this, no CLV computation is possible for 2026 picks. Either the odds-refresh ingester needs a "promote to closing within T-5min of game_time_utc" pass, or a separate cron does it post-game.

**Methodology constraints surfaced.**

- Schedule-format change at 2022→2023 (47% → 32% divisional) means any cross-season feature that reads "is_divisional" must either (a) include `season` as a feature, (b) condition on it, or (c) drop 2022 from training.
- 2024 has both more pitcher gaps and similar odds gaps — the smallest *clean* training season is 2024. If a model needs full coverage, 2022-2023 + 2024-partial is the realistic pool.
- v0 markets other than moneyline have no closing-line history at all. Any proposal to extend to run_line / total needs a separate odds backfill discussion.

## What this audit does *not* cover

- Feature-construction correctness (leakage, training/serving parity) — that's `mlb-feature-eng`'s domain on a per-feature basis.
- Park factors, weather, lineup ingestion freshness — separate audit if needed.
- Statcast / Baseball Savant — not in v0 schema; not audited.
- Pinnacle archive — `odds.source = 'pinnacle_archive'` returns 0 rows. Not present.
- Whether 2024 closing-line gaps are matcher false negatives or genuine Odds API holes — would require diffing `data/historical-odds/2024/*.json` against matched DB rows.

## Re-running

```bash
# from C:/AI/Public/diamond-edge-research
node docs/audits/data-coverage-2026-04-30.mjs
```

The script is idempotent and read-only. It loads `.env` from the pipeline-owner worktree at `C:/AI/Public/diamond-edge/.env` because the research worktree has no DB credentials. If anything in the schema or data shifts, the same script run a week from now will surface the diff.

## Handoff

This audit informs — but does not author — the next research artifacts. The natural follow-ups are:

1. A research memo on candidate methodology approaches for moneyline v0, scoped to the *actually-available* feature set above.
2. A proposal-set (in the schema from `CLAUDE.md`) that sequences (a) batter-log backfill, (b) 2024 pitcher-log gap closure, (c) closing-snapshot flagger fix, (d) the methodology pick.

Both go to the pipeline-owner instance to execute. The research lane stops here.
