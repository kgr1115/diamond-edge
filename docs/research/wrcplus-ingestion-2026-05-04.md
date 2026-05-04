# wRC+ Ingestion — Research Memo

**Date:** 2026-05-04
**Author:** mlb-research
**Scope:** How to populate `batter_game_log.wrc_plus` so the two zeroed v0 residuals (`team_wrcplus_l30_home/away`) can fit non-zero loadings.
**Comparison baseline:** v0 production (anchor + 11 standardized residuals, 2 of 11 zeroed). `models/moneyline/current/`.
**Direction signal:** CSO 2026-05-04 verdict pinned this as the next research priority. CEng condition `team_wrcplus_followup` in the cold-start sign-off is the same item.

---

## 0. The state on disk

- `batter_game_log` (migration 0029) exists with `wrc_plus SMALLINT` and `wrc_plus_source TEXT DEFAULT 'ops_plus_proxy'`. Backfilled by `scripts/backfill-db/08-batter-game-log.mjs` (PA + season-to-date OPS+ from MLB Stats API `/game/{id}/boxscore`).
- The OPS+-proxy plan is functionally dead: `parseOpsPlus()` reads `seasonStats.batting.opsPlus`, which the boxscore endpoint **does not populate** in practice. The fallback path returns NULL. Net: PA is filled, `wrc_plus` is NULL on essentially every row, the L30 PA-weighted average degrades to the league-avg (=100) imputation, and the residual is constant → L2 zeros it cleanly.
- Serving (`apps/web/lib/features/moneyline-v0.ts:222-242`) and training (`scripts/features/build-moneyline-v0.py`) both read `batter_game_log.pa + wrc_plus` filtered by team / 30-day window and PA-weight. No code change needed once the column populates — only the ingestion changes.
- A different code path **already pulls Savant team-level wRC+** for the season aggregate in `apps/web/lib/ingestion/stats/team-batting.ts` (`fetchSavantTeamBatting`). The Savant team CSV exposes `wrc_plus` per team-season. The team CSV is not what v0 needs — v0 needs per-batter-per-window — but it confirms Savant's CSV surface is already integrated, vetted, and free to call.

This is an ingestion gap, not a feature-engineering or modeling gap.

---

## 1. Source candidates

| Source | Granularity | Cost | ToS posture | Actually delivers what v0 needs? |
|---|---|---|---|---|
| **Baseball Savant per-player CSV leaderboard** (`baseballsavant.mlb.com/leaderboard/custom?...&type=batter&player_type=batter&csv=true`) | Per-player **season-to-date** wRC+ for any season + date window | $0 — public CSV, no key, ~1 req per season+team+window | Public-facing CSV the same project already uses for team-level pulls; no auth, no rate-limit signaling beyond standard 429 backoff | **Yes for serving.** Per-player season-to-date wRC+ as of "today" rolls into a PA-weighted team L30 with the PAs already in `batter_game_log`. Backfill: per-day re-pull of the leaderboard with `endDate=YYYY-MM-DD` is exactly the per-game snapshot. |
| **FanGraphs leaders** (web table → CSV) | Per-player season-to-date wRC+ (same shape as Savant) | $0 (free tier) but public ToS bars systematic scraping; FG paid API exists but is enterprise-priced | Hostile-to-scrape posture historically. Members & contributors agreement explicitly prohibits scraping for redistribution. | Yes technically, but the legal envelope is worse than Savant's for the same data. **Skip unless Savant fails.** |
| **Pybaseball** (Python wrapper around Savant + BR + FG) | Per-player season-to-date or per-game | $0 | MIT license; defers to underlying source ToS. For the FG-backed calls, the same FG ToS issue applies. The Savant-backed calls are the same surface as direct Savant. | Useful as an implementation accelerator if we choose Python. Not a separate source; it's the Savant + BR + FG layer with friendlier ergonomics. |
| **Baseball Reference per-player** | Per-player season-to-date OPS+ (NOT wRC+ directly) | $0 | Stathead paid tier required for bulk; free public pages allow modest scraping but rate-limited | OPS+ is the documented v0 fallback already attempted via MLB Stats API. Same proxy logic (OPS+ ≠ wRC+ but correlates ~0.95 at season aggregate). Would unblock v0 at a known-correlated approximation. |
| **Compute true wRC+ from raw stats** | Per-player per-game | $0 + dev effort | n/a | wRC+ formula needs per-season league wOBA constants + per-park factors. The wOBA constants are publicly available (FG publishes them, Tango's blog has them, Wikipedia documents the formula). Park factors we already have in `park_factor_runs`. The per-game raw components (singles, 2B, 3B, HR, BB, IBB, HBP, SB, CS, AB, PA) are in MLB Stats API boxscore — same source we're already calling. **This is the most defensible long-term path, highest dev effort.** |
| **MLB Stats API `/people/{id}/stats?stats=season&season=YYYY`** | Per-player season aggregate, includes some advanced stats but not wRC+ | $0 | Public | OPS+ is sometimes returned at the season-aggregate level (different endpoint than boxscore — the season endpoint returns it more reliably). Worth verifying; if true, this is the same OPS+ proxy with a more reliable endpoint and the same correlation. |

**Sources cited.** Baseball Savant Statcast leaderboard CSV endpoint behavior is documented in the existing `apps/web/lib/ingestion/stats/team-batting.ts:89-160` integration. FanGraphs ToS: fangraphs.com/about (Members and Contributors Agreement, "Use of Site Content" section). Pybaseball: github.com/jldbc/pybaseball (MIT). wRC+ formula: Tango/Lichtman/Dolphin "The Book" (2007) and FanGraphs glossary. League-wOBA constants: fangraphs.com/guts.aspx (year-by-year table, scraped commonly).

---

## 2. Computation strategy per source

The v0 residual is `team_wrcplus_l30_home = sum(pa * wrc_plus) / sum(pa)` over the team's batter_game_log rows in the trailing 30 days at T-60min.

There are two interpretations and they affect ingestion shape:

- **Interpretation A — per-game wRC+:** each batter_game_log row stores the wRC+ that batter posted **in that specific game**. PA-weighted over the 30-day window gives a true L30 batter-quality signal.
- **Interpretation B — per-game stamp of season-to-date wRC+:** each row stores "what was this batter's season-to-date wRC+ as of this game's date." PA-weighted over the 30-day window gives "average season-to-date batter quality, weighted by recent PA." This is what the existing OPS+-proxy backfill comment in `08-batter-game-log.mjs:24-30` documents as the intended semantics ("season-to-date stats... as of that game date... acceptable rolling proxy").

**Interpretation B is what v0 was actually built against.** The serving and training code do not compute per-game wRC+; they aggregate stored wrc_plus column values weighted by per-game PA. The brief in `08-batter-game-log.mjs:13-30` explicitly documents the season-to-date-as-of-game-date semantics. mlb-feature-eng signed off on this in the v0 cold-start. Interpretation A is the stricter and more defensible version, but switching to it is an architecture change, not just an ingestion change — the L30 window definition shifts from "average of season-to-date stamps weighted by recent PA" to "true L30 wRC+ per batter weighted by L30 PA," and the residual loadings will be different in magnitude.

**Recommendation: ship Interpretation B (matches code as-is); flag Interpretation A as a follow-up worth its own proposal once we know the residual is non-trivial.**

Per-source serving recipe under Interpretation B:

| Source | Backfill recipe | Daily-refresh recipe |
|---|---|---|
| **Savant per-player CSV** | One CSV pull per season per "as-of date" window. For 2022-09 → 2024 we'd hit `?year=YYYY&player_type=batter&csv=true&endDate=YYYY-MM-DD` for each unique game_date in the training window (~600 dates). Each pull returns ~700 rows (one per qualified batter). Match on `mlb_player_id`. ~600 CSV pulls @ 1-2s each + parse = 30-60 min wall-time once. | One CSV pull per day at 6am ET with `endDate=yesterday`. Update every batter_game_log row from yesterday to fill `wrc_plus`. ~1 req/day, <5s. |
| **MLB Stats API season endpoint OPS+** | One `/people/{id}/stats?stats=season&season=YYYY&group=hitting` call per (player, season) — but practically loop unique batter_ids in our existing `batter_game_log`. For ~1,500 distinct batters × 3 seasons = 4,500 calls @ 500ms = ~40 min. **OPS+ proxy, not true wRC+.** Document `wrc_plus_source = 'ops_plus_proxy_v2'`. | Refresh active-roster batters daily, ~750 calls. Already inside MLB API rate envelope. |
| **Compute true wRC+ from raw stats** | One-time: pull league wOBA constants per season (FG guts page or hardcode the 5 known values for 2022-2024). Per-batter-per-game: pull raw counting stats from boxscore (already in MLB API), compute wOBA, look up park factor (already in `park_factor_runs`), normalize by league-wOBA. Wall time: dominated by re-running the boxscore pulls, ~5-8h (same as the existing batter_game_log backfill). Code complexity: ~200 lines new Python or TS, plus a `league_wOBA_constants` static table or migration. | Daily refresh during the regular season. |

---

## 3. Coverage requirement

- **Backfill window:** 2022-09-01 → 2024-12-31. This is the v0 training+holdout window per `models/moneyline/holdout-declaration.json`. ~5,300 final games × ~26 batter rows/game = ~135K batter_game_log rows currently exist.
- **Coverage target:** to clear v0's "≥98% feature coverage" bar implicit in the cold-start lane, every game in the window needs a non-NULL team-level rollup. A team-level rollup needs ≥50 PA in the 30-day window (the existing imputation floor in serving + training code). Practically that means we need wrc_plus populated for ≥5 distinct batters per team-rollup, which means ~95%+ of `batter_game_log` rows need a non-NULL wrc_plus value to be safe.
- **Ongoing serve:** Diamond Edge runs T-60min picks. Yesterday's batter_game_log rows populate overnight, so the daily refresh runs at 06:00 ET and the L30 rollup at T-60 reads the freshest available value.

---

## 4. Cost estimate

Locked envelope: $300/mo total, Misc/overhead $15/mo target / $30/mo cap (CLAUDE.md).

| Source | One-time backfill cost | Ongoing monthly | Fits envelope? |
|---|---|---|---|
| Savant per-player CSV | $0 + 30-60 min wall | $0 + ~30s/day cron | Yes — same surface team-batting.ts already uses. |
| MLB Stats API season OPS+ | $0 + ~40 min wall | $0 + ~5 min/day | Yes. |
| Compute true wRC+ from raw | $0 + ~8h wall (re-uses boxscore data already pulled) + ~2 days dev | $0 + same as boxscore daily refresh | Yes. |
| FanGraphs scrape | $0 + dev cost + legal exposure | $0 + ToS risk | Skip on legal grounds. FG paid API breaches the $30 sub-budget. |

No source pushes Misc/overhead toward the cap. Cost is not a discriminator. Engineering effort is.

---

## 5. Effort estimate (mlb-data-engineer's lane)

| Source | Schema change? | New ingester | Cron registration | Coverage audit | Backfill exec | Total dev |
|---|---|---|---|---|---|---|
| **Savant per-player CSV** | No. Reuse `batter_game_log.wrc_plus` + bump `wrc_plus_source` value (`'savant_szn_to_date'`). | New script `scripts/backfill-db/08b-batter-wrcplus-savant.mjs`. ~150 LOC. | 1 cron entry: daily 06:00 ET refresh. New Vercel cron route `apps/web/app/api/cron/wrcplus-refresh/route.ts` (~80 LOC). | ~30 LOC variation of `check-v0-batter-progress.mjs`. | 30-60 min wall, monitored. | **~1.5 day dev + 1h backfill.** |
| **MLB Stats API season OPS+ v2** | No. Same column, `wrc_plus_source = 'mlb_szn_ops_plus'`. | New script ~200 LOC. | 1 cron entry, daily. | Same audit script. | ~40 min wall. | ~1 day dev + 1h backfill. **OPS+ proxy, not true wRC+.** |
| **Compute true wRC+** | Yes — new `league_wOBA_constants` table (5 rows for 2022-2026) + park-factor join (already exists). | Larger refactor of `08-batter-game-log.mjs` to compute wOBA inline + new computation module ~250 LOC. | Existing daily cron. | Existing audit + new league-constant freshness check. | ~8h wall (re-pulls boxscore). | ~3-4 day dev + 8h backfill. |

**Recommendation:** Savant per-player CSV. Lowest dev effort, highest data quality (this IS the FG/Savant wRC+ that everyone else cites — same number), zero new infra, fits the project's existing Savant integration pattern.

---

## 6. Methodology risks

1. **Train/serve mismatch.** If backfill uses Savant-as-of-date snapshots (per-day endDate pulls) and live-serving uses Savant's current-day endpoint, the values are byte-identical for the same date. The risk is if we conflate Savant-backfill with a different daily-source. Mitigation: same script powers both; backfill mode just iterates dates, daily mode hits today.
2. **Interpretation B residual semantics.** PA-weighting season-to-date stamps means early-season games get noisy stamps. April games carry the prior season's tail signal in some readings. The L30 rolling PA window mitigates this — only the recent batters (recent PA) contribute weight.
3. **Park-factor double-count.** wRC+ is park-adjusted. The model already has `park_factor_runs` as a separate residual (currently coef +0.0283). Including team-wRC+ that's already park-corrected with park_factor as a separate feature DOES partly redundantize the park signal. The L2 regularization will redistribute the load between them. This is the same situation gradient-boosted offense models routinely live with — not a blocker. Diagnostic: after retrain, both `park_factor_runs` coef and `team_wrcplus_l30_*` coefs should remain meaningful (neither zeroed). If `park_factor_runs` collapses to zero post-wRC+, we'd want to know — that's the double-count showing.
4. **wRC+ vs OPS+ proxy regress.** If we shipped OPS+ proxy (option B in source table) and later switched to true wRC+, the residual coefficient magnitudes shift — a methodology change that would re-trigger pick-test. Recommendation: ship Savant wRC+ once, don't intermediate via OPS+.
5. **Holdout consumption.** A retrain that activates wRC+ residuals consumes the v0 production holdout (2024-07-19 → 2024-12-31). The pinned `models/moneyline/holdout-declaration.json` flagged this. The next walk-forward holdout for the FOLLOWING retrain needs to be either (a) 2025 once 2025 backfills land, or (b) a pre-declared sub-slice of 2024 not yet touched. This is a CEng decision at retrain time, NOT a wRC+ ingestion decision.
6. **Savant CSV schema drift.** The team-level CSV reader at `team-batting.ts:124-156` uses positional column lookup by header name. The per-player endpoint uses the same convention. Mitigation: same defensive `idx(name) === -1 → null` pattern.

---

## 7. Expected impact on v0

**Honest read.** The market anchor (de-vigged closing line) absorbs essentially all of the market's view of offense. The `team_wrcplus_l30` residual is what's left over — i.e., where do we have an offense view DIFFERENT from the market's offense view, AND is that delta predictive?

Quantitative anchors:
- v0 candidate retrain on a 99.6%-coverage build with the SAME features did not move ROI (`docs/audits/moneyline-v0-candidate-retrain-2026-05-04-comparison.md`). More data of the same shape → essentially same edge.
- Two of 11 residuals are exact zero (`team_wrcplus_l30_home/away`); the other 9 carry coefficients in the [-0.09, +0.05] range. The biggest residual loading is `starter_fip_away` at -0.085. If wRC+ residuals load at similar magnitude (a generous assumption — offense-vs-pitching is the textbook split), they'd add 1-2 standardized residual units of signal.
- Plausible outcome: ROI@+2% holdout shifts by 0 to +2 percentage points. Calibration tightens slightly in the small-prob bins (where lineup quality matters more — underdogs win on offense). ECE point estimate moves by 0 to -0.005.
- Ceiling case: residual loadings hit |0.10|, anchor coef adjusts down to ~0.93, sum_abs_residuals grows from 0.295 to ~0.40. ROI@+2% point estimate +13-14% on the same holdout. **This is a ceiling, not a forecast.**
- Floor case: residual loadings stay near zero even with non-NULL data, because the market already prices L30 batter quality efficiently. ROI@+2% holdout unchanged. **In this case the diagnostic value is "we now know L30 batter quality is in the market" — which is itself a valid result.**

**Definition of "wRC+ activated and pulling weight":** post-retrain, both `team_wrcplus_l30_home` and `team_wrcplus_l30_away` residual coefficients have |value| ≥ 0.02 (i.e., on the same order as `weather_wind_out_mph` in current v0). Sum_abs_residuals ≥ 0.32 (+10% over current 0.295). No sign-flip anywhere else in the residual stack.

**Definition of "wRC+ ingested but not pulling weight":** both wRC+ coefs |value| < 0.02 AFTER non-NULL data. Sum_abs_residuals essentially unchanged. Verdict in that case: ship the ingester anyway (it's right and cheap), document the residual as "load tested, market already prices this," then escalate to CSO that the next research priority should be lineup handedness or pitcher Stuff+ rather than more team-aggregate offense features.

---

## Recommendation

Do the work. Savant per-player CSV is the cheapest, cleanest path. The proposal below routes the ingester, the cron, the coverage audit, and the post-retrain pick-test through the existing pipelines.

If the post-retrain residuals stay at zero, that's still a positive result — it eliminates "we never tried" as a hypothesis and re-points research at orthogonal signals (handedness splits, Stuff+, recent-form pitcher residuals).

**This is worth doing. It's not a high-confidence ROI lift; it's a moderate-confidence diagnostic that closes a known structural gap and lets the residual stack be honestly evaluated.**

---

## Experiment proposal

```yaml
proposal_id: wrcplus-ingestion-savant-2026-05-04
proposer: mlb-research
kind: feature-change
lens: cross-lens  # CEng owns the residual interpretation; COO owns cron+rate-limit; CSO has already directed this
claim: >
  Populate batter_game_log.wrc_plus from Baseball Savant's per-player season-
  to-date CSV leaderboard (same surface team-batting.ts already uses for the
  team-aggregate). Backfill 2022-09 through 2024 to clear the two zero
  residuals (team_wrcplus_l30_home/away) in the v0 model. Add a daily-refresh
  Vercel cron for ongoing serving. After backfill, mlb-model retrains v0
  against the same pinned holdout; pick-tester gates the candidate vs current.
evidence:
  - "v0 production has 2 of 11 residuals at exact zero (`team_wrcplus_l30_*`) because batter_game_log.wrc_plus is unfilled. L2 zeros constant features cleanly."
  - "OPS+-proxy ingester at scripts/backfill-db/08-batter-game-log.mjs runs through parseOpsPlus() which returns NULL on essentially every row — boxscore endpoint omits opsPlus."
  - "Savant per-player wRC+ CSV is the same surface team-batting.ts:89-160 uses for team aggregates. Free, public, no auth, ~1-2s per CSV pull."
  - "Candidate retrain on 99.6%-coverage SAME features (`docs/audits/moneyline-v0-candidate-retrain-2026-05-04-comparison.md`) confirmed train-size is NOT the constraint — feature gap is."
  - "CSO 2026-05-04 verdict explicitly directed wRC+ as next research priority and deferred richer residuals + LightGBM fallback until this lands."
  - "CEng cold-start sign-off (`moneyline-v0-2026-04-30-rev3-bundled-report-verdict-ceng.md` `team_wrcplus_followup` condition) named this as standing follow-up."
comparison:
  - approach_a: "v0 current — anchor + 11 residuals, 2 zeroed. ROI@+2% +11.33% on holdout (n=416). ECE 0.0304. sum_abs_residuals 0.2952."
  - approach_b: "v0 retrained on same architecture, same holdout, same drop predicate, with wRC+ residuals populated."
  - delta_metrics: >
      Targets: ROI@+2% in [+9%, +14%] (within the comparison-against-current
      ±2pp band on either side); ECE point estimate ≤ 0.04; both wRC+ residual
      |coef| ≥ 0.02; sum_abs_residuals ≥ 0.32; no sign flips on the other 9
      residuals. Bootstrap 7d-block CI lower bound for ROI@+2% must remain
      above -2.5% (matching v0's lower bound). If wRC+ residuals come back at
      |coef| < 0.02 after non-NULL data, the proposal is "ingester ships
      regardless; methodology direction re-prioritizes."
risks:
  - "Park-factor double-count: wRC+ is park-adjusted; park_factor_runs is a separate residual. L2 redistributes; if park_factor_runs collapses to zero post-retrain, that's the double-count signal."
  - "Holdout consumption: this retrain uses the pinned moneyline-v0-holdout-2026-05-03 declaration. Next retrain after wRC+ needs a fresh declaration (CEng decision at that retrain, not now)."
  - "Train/serve parity: backfill mode and daily mode share the same Savant call, parameterized by endDate. Parity fixture (tests/fixtures/feature-parity/moneyline-v0-2024-08-15-nyyvsboston.json) regenerated against new wrc_plus values."
  - "Savant CSV schema drift: defensive parsing same as team-batting.ts:124-156 (header-name positional lookup, NULL on missing column)."
  - "Interpretation B (season-to-date stamp PA-weighted) is what serving + training code expect. NOT switching to Interpretation A (true L30 wRC+) — that's an architecture change worth its own future proposal."
rollback:
  - "Revert PR; batter_game_log.wrc_plus rows can stay populated (no schema change), they're orthogonal to a model rollback. Production v0 in models/moneyline/current/ remains in place; if the retrained candidate fails pick-test, candidate goes to models/moneyline/candidate-wrcplus-2026-05-04/ and current/ stays."
  - "Time-to-detect regression: pick-test runs immediately on retrain. If the retrained model passes pick-test but live-cron ECE breaks the 0.04 spec at the 200-pick re-check (unchanged from v0's pinned condition), isotonic wrap fits in-place per the standing live_ece_recheck_at_200_picks condition."
scope:
  - markets_affected: [moneyline]
  - user_facing: no  # ingestion + retrain. Pick UI surface unchanged.
  - irreversible: no
attachments:
  - "docs/research/wrcplus-ingestion-2026-05-04.md (this memo)"
  - "scripts/backfill-db/08-batter-game-log.mjs (existing, to be supplemented not replaced)"
  - "apps/web/lib/ingestion/stats/team-batting.ts:89-160 (Savant CSV pattern to copy)"
  - "apps/web/lib/features/moneyline-v0.ts:222-242 (serving fetchTeamWrcPlus — no change needed)"
  - "scripts/features/build-moneyline-v0.py (training side — no change needed)"
  - "models/moneyline/holdout-declaration.json (pinned holdout this retrain consumes)"
  - "docs/audits/moneyline-v0-candidate-retrain-2026-05-04-comparison.md (evidence that more data of same shape ≠ enough)"
  - "docs/proposals/moneyline-v0-validation-2026-05-04-verdict-cso.md (CSO direction this proposal executes)"
```

### What APPROVED unlocks (specialist routing)

1. **mlb-data-engineer**:
   - Write `scripts/backfill-db/08b-batter-wrcplus-savant.mjs` — Savant per-player CSV puller, parameterized by `endDate`. Per-day iteration over the 2022-09-01 → 2024-12-31 window, UPDATE `batter_game_log.wrc_plus` matched on `(mlb_player_id, game_date)`. Set `wrc_plus_source = 'savant_szn_to_date_v1'`. Reuse `mlbFetch`-style retry pattern from existing scripts.
   - Write `apps/web/app/api/cron/wrcplus-refresh/route.ts` — daily cron at 06:00 ET, single Savant CSV pull with `endDate=yesterday`, batch UPDATE yesterday's batter_game_log rows.
   - Register cron in `vercel.json` (or `supabase/migrations/00XX_register_wrcplus_refresh_cron.sql` if pg_cron is the chosen path — match the existing pattern).
   - Write `scripts/run-migrations/check-v0-wrcplus-coverage.mjs` — % of batter_game_log rows with non-NULL wrc_plus per season, target ≥95%.
   - Execute backfill, monitor, write coverage report to `docs/audits/wrcplus-backfill-results-2026-05-04.json`.
2. **mlb-feature-eng**:
   - Re-run `scripts/features/build-moneyline-v0.py` against the now-populated `batter_game_log.wrc_plus`. Same predicate, same holdout pin, same audit. Verify look-ahead audit still clean and parity fixture regenerated.
3. **mlb-model**:
   - Retrain logistic + L2 (C=1.0) on the new feature parquet. Save to `models/moneyline/candidate-wrcplus-2026-05-04/`. Do NOT touch `current/`.
   - Report new feature-coefficients.json, metrics.json, sum_abs_residuals, anchor coef + CI, variance-collapse check.
4. **mlb-calibrator**:
   - Re-run /calibration-check on candidate's holdout predictions. Confirm ECE point ≤ 0.04 absolute. Report 7d-block CI per the post-2026-05-04 reporting standard.
5. **mlb-backtester**:
   - Re-run backtest with EV sweep at +1/+2/+3% on candidate. Report ROI + CLV + i.i.d. + 7d-block CIs side-by-side with v0 production at `docs/audits/moneyline-v0-wrcplus-comparison-2026-05-04.md`.
6. **pick-tester**:
   - Standard pick-tester gate (post-cold-start): ROI ≥ -0.5% vs current, CLV ≥ -0.1% vs current, ECE ≤ +0.02 vs current. Plus the wRC+-specific gate from this proposal: both wrc_plus residual coefs |value| ≥ 0.02 (otherwise → escalate to CSO with "ingested but not pulling weight" verdict, ship ingester, do NOT promote retrained model).

### Locked-invariant impact

**None of the locked invariants are touched by this proposal.** Specifically:
- **Calibrated probabilities:** preserved. Same logistic + raw sigmoid; calibrator gates re-run.
- **Holdout discipline:** the pinned `moneyline-v0-holdout-2026-05-03` declaration applies; the retrained candidate is evaluated on it ONCE; the next retrain after this one needs a fresh declaration (CEng's call at that point — flagged here, not decided here).
- **Comparison-against-current:** explicit per the pick-test gate above.
- **Market-prior awareness:** anchor stays as feature [0]; expectation is anchor coef stays in [0.93, 1.02].
- **Methodology-agnosticism:** this is a feature-change, not a model-class change. LightGBM and richer-residual proposals remain deferred per CSO direction.

The single dependency to flag: **the next retrain after wRC+ activates will need a fresh holdout declaration.** The pinned 2026-05-03 declaration covers this retrain (it's the immediate-next consumer). The retrain after that — whether triggered by 2025 backfill, by lineup-handedness residuals, or by a LightGBM fallback — must declare a fresh post-2024-12-31 holdout BEFORE running. CEng should treat this as a pinned follow-up at the time of this retrain's pick-test verdict, not now.
