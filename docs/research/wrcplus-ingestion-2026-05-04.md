# wRC+ Ingestion — Research Memo (Rev B)

**Date:** 2026-05-04
**Author:** mlb-research
**Scope:** How to populate `batter_game_log.wrc_plus` so the two zeroed v0 residuals (`team_wrcplus_l30_home/away`) can fit non-zero loadings — OR, if no source delivers, what to invest in instead.
**Comparison baseline:** v0 production (anchor + 11 standardized residuals, 2 of 11 zeroed). `models/moneyline/current/`.
**Direction signal:** CSO 2026-05-04 verdict pinned this as the next research priority. CEng condition `team_wrcplus_followup` in the cold-start sign-off is the same item.

---

## Revision summary

The original memo (proposal_id `wrcplus-ingestion-savant-2026-05-04`) recommended Baseball Savant per-player CSV as the source. That recommendation does not survive live HTTP probes:

1. **Savant per-player CSV's `wRC+` column is empty for every row** under all `selections=` variants (`wRC+`, `wrc_plus`, `wRC_plus`). Header is munged to `"wRC "`. Only wOBA / xwOBA / xBA actually populate. wRC+ is FanGraphs-derived; Savant exposes it only at team-aggregate level historically — and even that endpoint is currently 404.
2. **Savant team CSV** (`/leaderboard/team?year=YYYY&type=batter&csv=true`) cited in the original as proof of integration pattern: returns **HTTP 404** today. The existing `team-batting.ts` ingester is silently failing in production. Tracked separately as a `mlb-data-engineer` bug; does not block this revision but invalidates the "we already use this source successfully" claim.
3. **MLB Stats API season endpoint** (`/people/{id}/stats?stats=season`) — the second candidate offered: returns counting stats + AVG/OBP/SLG/OPS but **no `opsPlus` field** for Aaron Judge 2024 (`592450`). Path B is dead.

What changed under the new probes: the **MLB Stats API `stats=sabermetrics` endpoint** (NOT mentioned in the original memo) returns `wRcPlus` directly — and the values match FanGraphs to within rounding (Judge 2022/2023/2024: 206.2 / 173.5 / 219.8 vs FanGraphs 207 / 174 / 218). This is unblocked, free, and FanGraphs-quality. **But it is season-only and ignores `startDate`/`endDate` — which means as-of-game-date semantics are not directly achievable from this surface alone.**

This revision picks a fresh proposal_id (`wrcplus-ingestion-revB-2026-05-04`), re-evaluates three candidate paths against the probe evidence, and recommends ONE.

---

## Live-probe log (verifiable)

Probes run 2026-05-04 from a Windows / Git Bash curl session. Each command + first-200-bytes summarized:

| # | Endpoint | Result | Bearing on proposal |
|---|---|---|---|
| 1 | `baseballsavant.mlb.com/leaderboard/custom?...&selections=wRC+,xwoba,woba&csv=true` | 200 OK; `wRC+` column empty for every row; `xwoba`, `woba` populate | Original Path A dead |
| 2 | `baseballsavant.mlb.com/leaderboard/team?year=2024&type=batter&csv=true` | **HTTP 404** | Original integration-pattern claim invalidated; existing team-batting.ts is broken in prod (separate bug) |
| 3 | `statsapi.mlb.com/api/v1/people/592450/stats?stats=season&season=2024&group=hitting` | 200 OK; counting stats only — no `opsPlus`, no `wrcPlus` | Path B (OPS+ via season endpoint) dead |
| 4 | `statsapi.mlb.com/api/v1/people/592450/stats?stats=seasonAdvanced&season=2024&group=hitting` | 200 OK; advanced rate stats (BABIP, ISO, swing rates) — no OPS+ or wRC+ | seasonAdvanced does not help |
| 5 | `statsapi.mlb.com/api/v1/people/592450/stats?stats=sabermetrics&season=2024&group=hitting` | 200 OK; **returns `wRcPlus: 219.784`** + `woba: 0.476`, `wRaa: 93.8`, `wRc: 176.2`, full wWAR breakdown | NEW source unlocked — full FanGraphs parity, season-only |
| 6 | `statsapi.mlb.com/api/v1/people/592450/stats?stats=byDateRange,sabermetrics&startDate=2024-04-01&endDate=2024-08-15` | 200 OK; byDateRange honors filter; **sabermetrics block returns 2026 (current season), ignoring the date range** | Sabermetrics is season-only — no native as-of-date variant |
| 7 | (cross-check) Judge 2022 sabermetrics → wRcPlus 206.155; Judge 2023 → wRcPlus 173.466 | Matches FanGraphs published 2022=207 / 2023=174 to within rounding | Sabermetrics endpoint is FanGraphs-quality, not a different number |
| 8 | `baseballsavant.mlb.com/leaderboard/custom?...&selections=stuff_plus,location_plus,pitching_plus&type=pitcher&csv=true` | 200 OK; **all three columns empty** for every row (same pattern as wRC+) | If we pivot to Path C (Stuff+), Savant is also dead for it |
| 9 | `baseballsavant.mlb.com/leaderboard/pitch-arsenal-stats?type=pitcher&year=2024&csv=true` | 200 OK; populated per-pitch run-value, whiff%, xwOBA, hard-hit% | Stuff+-comparable inputs are available IF we want to roll our own pitcher-quality |

---

## 0. The state on disk (unchanged from original memo)

- `batter_game_log` (migration 0029) exists with `wrc_plus SMALLINT` and `wrc_plus_source TEXT DEFAULT 'ops_plus_proxy'`. PA backfilled by `scripts/backfill-db/08-batter-game-log.mjs`.
- `parseOpsPlus()` reads `seasonStats.batting.opsPlus` from boxscore — does not populate. `wrc_plus` is NULL on essentially every row. L30 PA-weighted average degrades to constant league-avg = 100; L2 zeros it cleanly.
- Serving (`apps/web/lib/features/moneyline-v0.ts:222-242`) and training (`scripts/features/build-moneyline-v0.py`) read `batter_game_log.pa + wrc_plus` filtered by team / 30-day window and PA-weight. **No code change needed once the column populates** — only ingestion changes.

---

## 1. Three candidate paths — re-evaluated against probes

### Path A (revised): MLB Stats API sabermetrics endpoint with prior-season carry

Use `statsapi.mlb.com/api/v1/people/{id}/stats?stats=sabermetrics&season=YYYY&group=hitting`. For each batter_game_log row at game_date:
- If `season(game_date)` ≥ 1: stamp the **prior season's full-year wRC+** (no look-ahead).
- After a player crosses a current-season PA threshold (e.g., 200 PA), switch to **current-season-to-date** sabermetrics — but the endpoint is season-only, so we'd be stamping the FULL current season including post-game-date data → **look-ahead leak**.

**Verdict on Path A revised: structurally broken.** The clean version (always-prior-season) is acceptable but stamps stale information for the entire season — a player who broke out in March carries his prior year's number all year. The mid-season-switch version leaks. Neither matches Interpretation B's "season-to-date as of game date" semantic in a defensible way.

What it WOULD give: zero new ingestion code beyond an MLB Stats API loop, FanGraphs-parity numbers, no ToS exposure, ~1,500 batters × N seasons calls.

What it gives up: the L30 rollup becomes "PA-weighted average of mostly-prior-season-stamps" — which is structurally similar to "last year's batter quality" rather than current-form batter quality. Diagnostic value: low. The thing v0 needs in the residual is a CURRENT-form signal that the market hasn't fully priced.

### Path A (compute true wRC+ from raw stats) — the option C from the original memo

Per-player byDateRange raw stats (singles, 2B, 3B, HR, BB, IBB, HBP, SF, AB, PA — already in MLB Stats API) → compute wOBA → divide by league wOBA → park-adjust → ×100 = wRC+.

**Formula** (from FanGraphs glossary, Tango/Lichtman/Dolphin's "The Book"):
```
wOBA = (uBB×wBB + HBP×wHBP + 1B×w1B + 2B×w2B + 3B×w3B + HR×wHR) / (AB + BB - IBB + SF + HBP)
wRAA = ((wOBA - lg_wOBA) / wOBA_scale) × PA
wRC = wRAA + (lg_R/PA × PA)
wRC+ = (((wRAA/PA) + lg_R/PA) + (lg_R/PA - park_factor × lg_R/PA)) / (lg_wRC/PA_excluding_pitchers) × 100
```

The five wOBA linear weights (`wBB, wHBP, w1B, w2B, w3B, wHR`), `wOBA_scale`, `lg_wOBA`, `lg_R/PA`, and `lg_wRC/PA_excluding_pitchers` are PER SEASON. FanGraphs publishes them at `fangraphs.com/guts.aspx?type=cn`.

**Constants source — the honest accounting:**
- FanGraphs guts page: scrapeable but the FanGraphs Members & Contributors Agreement bars systematic redistribution. Pulling 5 rows once and committing them as a static table is a defensible reading (it's reference data, not a redistribution feed) — but it's not zero legal exposure.
- **Cleaner alternative**: hand-transcribe the 5-7 constants per season into a hardcoded TS/Python table and cite the public-knowledge source (Tom Tango's blog `tangotiger.com/index.php/site/article/woba-year-by-year-coefficients` publishes the same constants; "The Book" Appendix is the original derivation). This is what every public sabermetrics codebase does (pybaseball, Tom Tango's own community calculators). Per-season the constants change by 2-5% — the 2024 values are already published.
- Verification: the MLB Stats API sabermetrics endpoint (probe 5) RETURNS the exact wRC+ FanGraphs publishes. We can use it as a SPOT-CHECK source — compute our own wRC+ for Aaron Judge full-season 2024 from raw, compare against `wRcPlus: 219.78` from sabermetrics. If our number is within ±3, our formula + constants are correct. If it's off by 10+, the constants table or the formula has a bug. **This is the verification step** — and it's free.

**Park factors:** already in `park_factor_runs` (migration 0024). Reuse.

**Per-game raw counting stats:** already pulled by `08-batter-game-log.mjs` from boxscore; the AB/BB/HBP/SF/1B/2B/3B/HR breakdown is in `seasonStats.batting`. We're already storing PA. Adding the rest is one boxscore-field-extraction change to the same script, OR a parallel script that pulls byDateRange (`startDate=season-open, endDate=game_date-1`) per (player, date) — that gives true season-to-date raw stats with no look-ahead.

**Granularity decision:** byDateRange per (player, game_date) is the clean season-to-date variant. Cost: 1,500 batters × ~150 game-dates per season × 3 seasons = ~675,000 calls. **MLB Stats API rate limit is unofficial but ~10 req/sec sustained**; that's ~19 hours of backfill wall time. Not great. Optimization: batch per game_date by team-roster (only call players who actually played in the prior 30 days for that team) → cuts to ~50K calls = ~1.5 hours. Manageable.

**Cost / effort:** Free API. ~3-4 days dev (constants table, formula module, byDateRange loop with team-roster pruning, unit tests against sabermetrics endpoint, wire into `batter_game_log.wrc_plus`). Backfill ~1.5h wall once tuned.

**Risks specific to this path:**
- Constants source brittleness — when 2027 lands, mlb-data-engineer must transcribe the new wOBA constants from FG/Tango. Document the source in code comments.
- MLB Stats API rate-limit headroom — if backfill thrashes the API, COO budget impact is zero (still free) but `mlb-data-engineer`'s other ingesters share the same rate envelope. Schedule the backfill for an off-peak window.
- Formula correctness — verify against sabermetrics endpoint full-season; if the 2024 spot-check passes for 5 random qualified hitters, ship.

### Path C (pivot): drop wRC+, invest in the next-best residual

Three candidates from the original memo's risks log + new research:

| Candidate | Source feasibility (live-probe) | Expected impact | Effort |
|---|---|---|---|
| **Handedness-split park factors** | MLB Stats API + Statcast can be aggregated by (park, batter_hand). Park-runs-by-hand has been computed by FG ("park factors handedness splits") but we'd compute our own from per-PA outcomes. | Moderate. Park factors are already coef +0.0283 in v0; splitting by handedness adds nuance for lineup-platoon spots. Expected residual loading similar magnitude. | ~2-3 days. |
| **Stuff+ / Location+ / Pitching+** | Probe 8: Savant per-player CSV columns are EMPTY (same gotcha as wRC+). Probe 9: pitch-arsenal-stats returns per-pitch run-value, whiff%, xwOBA, hard-hit% — Stuff+-COMPARABLE inputs but NOT Stuff+ itself. Rolling our own Stuff+ is a research project (Eno Sarris's original Stuff+ uses neural nets on per-pitch movement; recreating it is multi-week). FG paid API exposes Stuff+ but breaches budget. | High in principle (pitcher-quality residual is THE biggest gap in current v0 — `starter_fip_away` already loads at -0.085, the largest residual). But the **proxy**, not Stuff+ itself, is the realistic ask: per-pitch run-value rollup is 80% of Stuff+'s information at 5% the dev effort. | ~1 week if going for the proxy; multi-week if going for true Stuff+. |
| **Opener detection / TTOP (times-through-order penalty)** | MLB Stats API exposes batting-order position + pitcher-faced sequence. TTOP is computable from boxscore + play-by-play. Opener flag is a heuristic (starter pulled in 1st-2nd inning). Both are feature-engineering, not new ingestion. | Moderate. TTOP is well-documented edge (Tango ~2014); markets price it imperfectly. Effect concentrated on 3rd-time-through-order outcomes. Probably worth |0.04| as a residual loading. | ~3-4 days. |
| **Lineup-adjusted hitting metrics** | Requires lineup ingestion (already exists in `lineup_entries` per migration 0023). | Low-to-moderate. Mostly redundant with wRC+ — both proxy team batting quality. | ~2 days. |

**Recommended pivot if Path C**: Stuff+ proxy from Savant `pitch-arsenal-stats`. Highest expected impact (pitcher-quality is the residual that already loads largest in v0; making it richer is the highest-leverage feature add), and the data is live + populated. The trade is dev effort (1 week vs 3-4 days for true wRC+), but the residual lift expectation is meaningfully larger.

---

## 2. Coverage requirement (carries forward unchanged)

- **Backfill window:** 2022-09-01 → 2024-12-31. Pinned by `models/moneyline/holdout-declaration.json` (declaration_id `moneyline-v0-holdout-2026-05-03`).
- **Coverage target:** ≥98% feature coverage at the team-rollup level (cold-start lane bar). Practically: ≥95% non-NULL `wrc_plus` per row (because the team rollup needs ≥50 PA in the L30 window, which needs ≥5 batters per team-rollup populated).
- **Ongoing serve:** T-60min picks. Daily refresh at 06:00 ET; rollup reads freshest available value.

---

## 3. Cost / effort / impact summary

| Path | Source viability | Dev effort | Backfill wall | Recurring cost | Expected ROI lift on holdout | Confidence in lift |
|---|---|---|---|---|---|---|
| Path A revised (sabermetrics season-only, prior-year carry) | Probe 5+7 confirm | ~0.5 day | ~30 min | $0 | Near zero — stale info | Low |
| Path A compute true wRC+ from raw | All inputs probed live | ~3-4 days | ~1.5 hr | $0 | 0 to +2 pp ROI@+2% (matches original memo's expected band) | Moderate |
| Path C pivot — Stuff+ proxy | Probe 9 confirms inputs | ~5-7 days | ~2 hr | $0 | +1 to +4 pp ROI@+2% (pitcher-quality is current biggest residual; richer signal here is highest expected leverage) | Moderate-to-high |
| Path C pivot — handedness park factors | Compute from existing data | ~2-3 days | ~1 hr | $0 | 0 to +1 pp ROI@+2% | Low-moderate |
| Path C pivot — TTOP / opener | Compute from existing data | ~3-4 days | ~30 min | $0 | 0 to +1.5 pp ROI@+2% | Low-moderate |

None of these breach the Misc/overhead sub-budget ($15/mo target / $30/mo cap). Engineering effort is the discriminator.

---

## 4. Recommendation

**Recommend Path A "compute true wRC+ from raw stats"** — option C in the original memo, now elevated to primary because the cleaner-source paths are gone.

Rationale:
1. **It actually unblocks the documented gap.** Both CSO's verdict (`research_priority_next: wRC+ ingestion`) and CEng's `team_wrcplus_followup` condition name wRC+ specifically. Pivoting to Path C without first attempting wRC+ would re-open a cross-lens decision; staying on wRC+ executes the standing direction.
2. **Inputs are all live + free.** Per-game raw stats: MLB Stats API byDateRange. League constants: hand-transcribed from public sources, 5-7 numbers per season, one-time effort. Park factors: already in `park_factor_runs`. Verification target: MLB Stats API sabermetrics endpoint (full season match should be within ±3 wRC+).
3. **The verification path is exact.** We compute Aaron Judge's full-season 2024 wRC+ from our raw + constants pipeline. Sabermetrics endpoint says 219.78. If our number is in [217, 223], formula + constants are correct. If it's off by 10+, we have a bug to fix. This is a tight gate.
4. **Honest expected impact: 0 to +2pp ROI@+2%.** Same as the original memo's expectation. The market prices L30 batter quality reasonably efficiently; the residual is what's LEFT after the anchor. Floor case (residuals come back |coef| < 0.02) is still a positive result — it eliminates "we never tried" and re-points research at Path C (Stuff+ proxy) with stronger justification.
5. **Dev effort is bounded.** ~3-4 days to ship — not a multi-week investment. Personal-tool/portfolio phase tolerates this.

**What I am NOT recommending and why:**
- Path A revised (sabermetrics with prior-year carry) — the look-ahead-or-stale tradeoff has no good answer; the residual would be structurally weaker than current v0's residuals.
- Direct pivot to Path C (Stuff+ proxy) — bigger expected impact but skips the standing CSO direction. **If Path A's verification step fails (computed wRC+ doesn't match sabermetrics) or implementation slips beyond a week, escalate to CSO with Stuff+ proxy as the recommended pivot.**

---

## 5. Locked-invariant impact (carries forward unchanged)

**None of the locked invariants are touched by this proposal.** Specifically:
- **Calibrated probabilities:** preserved. Same logistic + raw sigmoid; calibrator gates re-run.
- **Holdout discipline:** the pinned `moneyline-v0-holdout-2026-05-03` declaration applies; the retrained candidate is evaluated on it ONCE; the retrain after this one needs a fresh declaration (CEng's call at that point).
- **Comparison-against-current:** explicit per the pick-test gate below.
- **Market-prior awareness:** anchor stays as feature [0]; expected anchor coef stays in [0.93, 1.02].
- **Methodology-agnosticism:** this is a feature-change, not a model-class change. LightGBM and richer-residual proposals remain deferred per CSO direction.

---

## 6. Holdout consumption (carries forward unchanged)

A retrain that activates wRC+ residuals consumes the v0 production holdout (2024-07-19 → 2024-12-31, declaration_id `moneyline-v0-holdout-2026-05-03`). The next walk-forward holdout for the FOLLOWING retrain needs to be either (a) 2025 once 2025 backfills land, or (b) a pre-declared sub-slice of 2024 not yet touched. **CEng decision at retrain time, not now.**

---

## 7. Independence from the team-batting Savant 404 bug

The recommended path uses MLB Stats API (`statsapi.mlb.com/api/v1/people/{id}/stats?stats=...`), which is a different code path entirely from `apps/web/lib/ingestion/stats/team-batting.ts:89-160`. **Path A revB does NOT depend on the broken Savant team CSV endpoint.** That bug is being surfaced separately to mlb-data-engineer; nothing in this proposal blocks on its resolution.

---

## Experiment proposal

```yaml
proposal_id: wrcplus-ingestion-revB-2026-05-04
proposer: mlb-research
kind: feature-change
lens: cross-lens  # CEng owns residual interpretation; COO owns rate-limit; CSO has directed
claim: >
  Populate batter_game_log.wrc_plus by computing true wRC+ from MLB Stats
  API per-game raw counting stats + per-season league wOBA constants
  (hand-transcribed from public sources, verified against MLB Stats API
  sabermetrics endpoint) + park factors already in park_factor_runs.
  Backfill 2022-09 through 2024-12-31 for the ~135K batter_game_log rows
  in the v0 training+holdout window. Add a daily-refresh Vercel cron for
  ongoing serving. After backfill, mlb-model retrains v0 against the
  pinned holdout; pick-tester gates the candidate vs current. The
  original Savant per-player CSV path (proposal_id wrcplus-ingestion-
  savant-2026-05-04) is rescinded — the wRC+ column on Savant's per-
  player CSV is empty under live probe, and the team CSV cited as
  integration-pattern proof returns HTTP 404.
evidence:
  - "v0 production has 2 of 11 residuals at exact zero (`team_wrcplus_l30_*`) because batter_game_log.wrc_plus is unfilled. L2 zeros constant features cleanly."
  - "Live HTTP probes 2026-05-04 confirm: Savant per-player CSV wRC+ column EMPTY for every row (probe 1); Savant team CSV returns HTTP 404 (probe 2); MLB Stats API season endpoint returns no opsPlus/wrcPlus (probe 3)."
  - "MLB Stats API sabermetrics endpoint returns wRcPlus directly with FanGraphs parity (Judge 2024: 219.784 vs FanGraphs 218; 2023: 173.466 vs 174; 2022: 206.155 vs 207). HOWEVER it is season-only — startDate/endDate are silently ignored (probe 6). Used as VERIFICATION TARGET for our computed wRC+, NOT as the live ingestion source."
  - "All raw inputs for the wRC+ formula are live + free: per-player byDateRange counting stats from MLB Stats API; league wOBA constants hand-transcribed from public sources (Tom Tango's tangotiger.com tables, FanGraphs guts page); park factors already in park_factor_runs."
  - "Candidate retrain on 99.6%-coverage SAME features (`docs/audits/moneyline-v0-candidate-retrain-2026-05-04-comparison.md`) confirmed train-size is NOT the constraint — feature gap is."
  - "CSO 2026-05-04 verdict directed wRC+ as next research priority (`research_priority_next` condition); CEng cold-start sign-off named team_wrcplus_followup as standing follow-up."
comparison:
  - approach_a: "v0 current — anchor + 11 residuals, 2 zeroed. ROI@+2% +11.33% on holdout (n=416). ECE 0.0304. sum_abs_residuals 0.2952."
  - approach_b: "v0 retrained on same architecture, same holdout, same drop predicate, with computed wRC+ residuals populated."
  - delta_metrics: >
      Targets: ROI@+2% in [+9%, +14%] (within ±2pp of current); ECE point
      estimate ≤ 0.04; both wRC+ residual |coef| ≥ 0.02; sum_abs_residuals
      ≥ 0.32; no sign flips on the other 9 residuals. 7d-block bootstrap
      lower bound for ROI@+2% must remain above -2.5%. If wRC+ residuals
      come back at |coef| < 0.02 after non-NULL data, the ingester ships
      regardless; CSO is escalated with "ingested but not pulling weight"
      and the recommended pivot becomes Path C (Stuff+ proxy from Savant
      pitch-arsenal-stats).
  - verification_gate_pre_retrain: >
      Before mlb-model retrains, mlb-feature-eng spot-checks the computed
      wRC+ for 5 known-quantity qualified batters across 2022-2024 against
      the MLB Stats API sabermetrics endpoint values. Acceptance: every
      spot-check within ±3 of sabermetrics value. If ANY spot-check
      misses by >5, the constants table or formula has a bug; mlb-data-
      engineer fixes before chain advances.
risks:
  - "Constants source brittleness: 2027 league wOBA constants must be hand-transcribed when 2027 season opens. Document source URL + transcription date in the constants module's comments. Owner: mlb-data-engineer; calendar reminder via project_state."
  - "Park-factor double-count: wRC+ is park-adjusted; park_factor_runs is a separate residual. L2 redistributes; if park_factor_runs collapses to |value| < 0.005 post-retrain, stop promotion and surface to CEng."
  - "MLB Stats API rate-limit shared envelope: backfill ~50K calls (after team-roster pruning) at ~10 req/sec sustained = ~1.5h wall time. Schedule for off-peak; coordinate with mlb-data-engineer on existing cron windows. COO sign-off implicit (no $ impact, just rate-share)."
  - "Holdout consumption: this retrain uses pinned moneyline-v0-holdout-2026-05-03. Next retrain after this one needs a fresh post-2024-12-31 declaration before training runs (CEng follow-up at that retrain's pick-test verdict)."
  - "Train/serve parity: backfill mode and daily mode share the same compute_wrc_plus() function, parameterized by date window. Parity fixture (tests/fixtures/feature-parity/moneyline-v0-2024-08-15-nyyvsboston.json) regenerated against new wrc_plus values."
  - "Interpretation B (season-to-date stamp PA-weighted) carries forward — same as serving + training code expect. NOT switching to Interpretation A (true L30 wRC+) — separate proposal."
  - "Formula correctness: verification gate (5 spot-checks within ±3 of sabermetrics endpoint) catches formula or constants bugs BEFORE retrain consumes the holdout."
rollback:
  - "Revert PR; batter_game_log.wrc_plus rows can stay populated (no schema change), they're orthogonal to a model rollback. Production v0 in models/moneyline/current/ remains in place; if the retrained candidate fails pick-test, candidate goes to models/moneyline/candidate-wrcplus-revB-2026-05-04/ and current/ stays."
  - "Time-to-detect regression: pick-test runs immediately on retrain. If retrained model passes pick-test but live-cron ECE breaches 0.04 spec at the 200-pick re-check, isotonic wrap fits in-place per the standing live_ece_recheck_at_200_picks condition."
  - "If the verification gate fails (formula bug not caught in dev), backfill table can be re-truncated on wrc_plus column and re-run; no upstream model dependency until the post-backfill chain advances."
scope:
  - markets_affected: [moneyline]
  - user_facing: no
  - irreversible: no
attachments:
  - "docs/research/wrcplus-ingestion-2026-05-04.md (this memo, rev B)"
  - "scripts/backfill-db/08-batter-game-log.mjs (existing — to be supplemented, not replaced)"
  - "supabase/migrations/0024_park_factor_runs.sql (park factors source for the formula)"
  - "apps/web/lib/features/moneyline-v0.ts:222-242 (serving fetchTeamWrcPlus — no change needed)"
  - "scripts/features/build-moneyline-v0.py (training side — no change needed)"
  - "models/moneyline/holdout-declaration.json (pinned holdout this retrain consumes)"
  - "docs/audits/moneyline-v0-candidate-retrain-2026-05-04-comparison.md (more-data-of-same-shape evidence)"
  - "docs/proposals/moneyline-v0-validation-2026-05-04-verdict-cso.md (CSO direction this proposal executes)"
  - "docs/proposals/moneyline-v0-2026-04-30-rev3-bundled-report-verdict-ceng.md (CEng team_wrcplus_followup condition)"
```

### What APPROVED unlocks (specialist routing)

1. **mlb-data-engineer**:
   - Write `scripts/lib/wrc-plus-formula.ts` (or `.py`) — pure compute module: inputs (per-player counting stats over a window + season + park_factor) → output (wRC+). Includes a hardcoded `LEAGUE_WOBA_CONSTANTS` table covering 2022, 2023, 2024 (and forward as seasons land). Constants sourced from public references; source URL + transcription date in comments. Unit tests against the verification target (5 known qualified batters' full-season 2024 wRC+ within ±3 of MLB Stats API sabermetrics endpoint values).
   - Write `scripts/backfill-db/08b-batter-wrcplus-compute.mjs` — per-(player, game_date) byDateRange call to MLB Stats API for season-to-date raw counting stats, compute wRC+ via the formula module, UPDATE `batter_game_log.wrc_plus` matched on `(mlb_player_id, game_date)`. Set `wrc_plus_source = 'mlb_computed_v1'`. Team-roster pruning to limit to ~50K total calls. Reuse `mlbFetch`-style retry pattern.
   - Write `apps/web/app/api/cron/wrcplus-refresh/route.ts` — daily 06:00 ET cron, batch-compute wRC+ for yesterday's batter_game_log rows (only players with prior-30d activity for active teams). CRON_SECRET bearer per existing `apps/web/app/api/cron/odds-refresh/route.ts:17-30` pattern. Schedule `"0 11 * * *"` (06:00 ET = 11:00 UTC). `maxDuration: 60` in `vercel.json` functions block.
   - Write `scripts/run-migrations/check-v0-wrcplus-coverage.mjs` — % non-NULL `wrc_plus` per season, target ≥95%.
   - Execute backfill (off-peak window, coordinated), monitor, write coverage report to `docs/audits/wrcplus-backfill-results-2026-05-04.json`.
2. **mlb-feature-eng**:
   - Run the verification gate: pull MLB Stats API sabermetrics wRcPlus for 5 known-quantity qualified batters across 2022-2024 (Judge 2022/2023/2024, Bobby Witt Jr 2024, Mookie Betts 2023). Compute the same via the new formula module on full-season 2024 raw stats. PASS = all 5 within ±3 of sabermetrics value. FAIL = chain stops, mlb-data-engineer debugs constants/formula.
   - On verification PASS: re-run `scripts/features/build-moneyline-v0.py` against the now-populated `batter_game_log.wrc_plus`. Same predicate, same holdout pin, same audit. Verify look-ahead audit still clean and parity fixture regenerated.
3. **mlb-model**:
   - Retrain logistic + L2 (C=1.0) on the new feature parquet. Save to `models/moneyline/candidate-wrcplus-revB-2026-05-04/`. Do NOT touch `current/`.
   - Report new feature-coefficients.json, metrics.json, sum_abs_residuals, anchor coef + CI, variance-collapse check.
4. **mlb-calibrator**:
   - Re-run /calibration-check on candidate's holdout predictions. Confirm ECE point ≤ 0.04 absolute. Report 7d-block bootstrap CI per the post-2026-05-04 reporting standard.
5. **mlb-backtester**:
   - Re-run backtest with EV sweep at +1/+2/+3% on candidate. Report ROI + CLV + i.i.d. + 7d-block CIs side-by-side with v0 production at `docs/audits/moneyline-v0-wrcplus-revB-comparison-2026-05-04.md`.
6. **pick-tester**:
   - Standard pick-tester gate (post-cold-start): ROI ≥ -0.5% vs current, CLV ≥ -0.1% vs current, ECE ≤ +0.02 vs current. Plus the wRC+-specific gate: both wrc_plus residual coefs |value| ≥ 0.02 (otherwise → escalate to CSO with "ingested but not pulling weight"; ship ingester, do NOT promote retrained model). Plus the park-factor diagnostic: if `park_factor_runs` coef collapses to |value| < 0.005 post-retrain, stop promotion and surface to CEng before swapping `current/`.
