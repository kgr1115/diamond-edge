# Stuff+ Ingestion — Research Memo

**Date:** 2026-05-04
**Author:** mlb-research
**Scope:** Pivot from wRC+ (CSO Option C verdict). Spec a Stuff+ or Stuff+-comparable per-game pitcher-quality residual to add to v0. Honor the one-holdout-consumption hard cap.
**Comparison baseline:** v0 production (anchor + 11 standardized residuals, 2 wRC+ residuals zeroed). `models/moneyline/current/`.
**Direction signal:** CSO 2026-05-04 verdict on `wrcplus-ingestion-revB-2026-05-04-pause` selected Option C — pivot to Stuff+ via Savant `pitch-arsenal-stats`. This memo restarts the pipeline at Stage 1 per the verdict's first condition.

---

## TL;DR

**Source recommendation: drop "true Stuff+" entirely. Use MLB Stats API `stats=sabermetrics&group=pitching` for FanGraphs-parity `fipMinus` (season-aggregate; prior-year carry) PLUS byDateRange-computed L30 xFIP for in-season-as-of-date signal.** Savant's `stuff_plus` / `location_plus` / `pitching_plus` columns are still empty under live probe (matches the original memo's probe 8). Savant per-pitch movement aggregates ARE populated, but rolling our own Stuff+ from raw movement+velocity is a multi-week neural-net project and explicitly outside the one-holdout-consumption hard cap CSO set.

**The pivot is as much a NAMING change as a methodology one.** "Stuff+" the published metric isn't accessible. What IS accessible — xFIP and fipMinus — already addresses the same residual: pitcher process-quality decoupled from outcome luck. Both come free from MLB Stats API, both are FG-parity verifiable, both fit the existing `pitcher_game_log` ingestion pattern.

**Hard finding on the holdout-feature-count contract.** The pinned holdout's invalidation list trigger #6 (`docs/audits/moneyline-v0-validation-2026-05-04.md`'s upstream declaration) names "feature-spec change after training starts" as an invalidator. **Adding a new residual is a feature-spec change.** This memo treats the Stuff+ proposal as REPLACING the two zeroed wRC+ residuals with two pitcher-quality residuals — keeping feature count at 11 — to preserve the holdout. If CEng reads the contract as also broken by replacement, this becomes a fresh-holdout trigger; flagged in section 4.

**Honest impact read.** Pitcher-quality is the residual that already loads largest in v0 (`starter_fip_away` -0.085 — the single biggest non-anchor coefficient). Adding `starter_xfip_l30_*` and replacing the dead wRC+ slots gives the L2 a richer basis in the same pitcher-quality direction, which can EITHER pull weight (incremental signal beyond raw FIP) OR reveal that the existing FIP residual is already absorbing what xFIP would add (collinearity with FIP and the L2 redistributes near-zero). Expected ROI@+2% delta is **+0 to +2 pp** with material probability mass at the lower end. This is NOT the +1 to +4 pp the original memo's Path C bullet quoted — that was an optimistic read on TRUE Stuff+ via paid neural-net signal, not on free xFIP.

If CSO weighs that honest band against the one-holdout-consumption cost and finds it doesn't justify the consumption, the right call is to ESCALATE back to CSO before implementer touches the holdout. Section 8 makes that case explicit.

---

## Live-probe log (verifiable, 2026-05-04)

| # | Endpoint | Result | Bearing on proposal |
|---|---|---|---|
| 1 | `baseballsavant.mlb.com/leaderboard/custom?...&selections=stuff_plus,location_plus,pitching_plus,pitch_arsenal_score,bot_stf_overall&type=pitcher&csv=true` | 200 OK; **all five columns EMPTY** for every row (Burnes, Wacha, Gray, Webb 2024 confirmed) | Direct Stuff+ via Savant per-pitcher CSV: dead. Same gotcha as wRC+. |
| 2 | `baseballsavant.mlb.com/leaderboard/pitch-arsenal-stats?type=pitcher&year=2024&min=q&csv=true` (and 4 param variants) | 200 OK on HTML; **CSV download path returns the page HTML, not data**. Original memo's probe 9 cited this as populated; the endpoint may have changed access pattern, or the original probe used a logged-in session | Per-pitch arsenal data is NOT obtainable as a single CSV via the documented `csv=true` flag today. Re-architecting the access (scrape JSON from the page state, or per-player loop) is feasible but adds engineering weight. |
| 3 | `baseballsavant.mlb.com/leaderboard/custom?...&selections=p_run_value,run_value_per_100,xera,xwoba,xslg,whiff_percent,k_percent,bb_percent,hard_hit_percent&type=pitcher&csv=true` | 200 OK; **`p_run_value` and `run_value_per_100` EMPTY**; `xera` (3.29 for Burnes 2024), `xwoba`, `xslg`, `whiff_percent`, `k_percent`, `bb_percent`, `hard_hit_percent` all populated | xERA is available at season aggregate. Run-value rollups (the cleanest Stuff+-proxy input) are NOT available via this surface. |
| 4 | `baseballsavant.mlb.com/leaderboard/custom?...&selections=ff_avg_speed,ff_avg_break_x,ff_avg_break_z,ff_avg_spin,sl_avg_speed,sl_avg_break_x,sl_avg_break_z,ch_avg_speed,cu_avg_speed,si_avg_speed&csv=true` | 200 OK; **all per-pitch-type movement+velocity+spin columns POPULATED** (Burnes ff_avg_speed=96.3, ff_avg_spin=1805, sl_avg_break=8.3/-36.7, etc.) | If we wanted to roll our own Stuff+: inputs ARE here. Multi-week neural-net effort. Out of scope per CSO's one-holdout-consumption cap. Documented as future research lane. |
| 5 | `statsapi.mlb.com/api/v1/people/669203/stats?stats=sabermetrics&season=2024&group=pitching` | 200 OK; **returns `fip: 3.547`, `xfip: 3.546`, `fipMinus: 86.94`, `eraMinus: 73.60`** for Burnes 2024 | UNLOCKS season-aggregate FG-parity pitcher-quality. Same endpoint as wRC+ probe 5. |
| 6 | `statsapi.mlb.com/api/v1/people/669203/stats?stats=byDateRange,sabermetrics&group=pitching&season=2024&startDate=2024-04-01&endDate=2024-06-30` | 200 OK; byDateRange returns IP/HR/BB/K/HBP/BF/FO/GO/ER for the window; **sabermetrics block ignores date range** (returns full-season values) | Same date-range-ignored gotcha as wRC+. byDateRange counting stats are usable for COMPUTED L30 xFIP. |
| 7 | `statsapi.mlb.com/api/v1/people/669203/stats?stats=byDateRange&group=pitching&season=2024&startDate=2024-08-01&endDate=2024-08-30` (Burnes Aug 2024) | 200 OK; IP=25.2, HR=5, BB=7, K=22, HBP=0, BF=119, FO=14, GO=25, ER=21 | Per-window inputs for L30 xFIP/FIP computation are clean and per-pitcher available. |

---

## 0. The state on disk

- `pitcher_game_log` (migration 0028) exists with per-appearance IP/HR/BB/HBP/K from MLB Stats API boxscores, populated 2022-09 through 2024. is_starter flag set. Already feeding `starter_fip_*`, `starter_days_rest_*`, `bullpen_fip_l14_*` residuals.
- Serving (`apps/web/lib/features/moneyline-v0.ts:151-216`) computes `fetchStarterFip` from `pitcher_game_log` over a 30-day window. **The same fetch shape works for xFIP** with a one-line formula change + one league-constant addition.
- Production v0 has `team_wrcplus_l30_home/away` slots in the feature payload, both at coefficient 0 because `batter_game_log.wrc_plus` is unfilled. Two zeroed slots in the L2 architecture.
- `models/moneyline/holdout-declaration.json` invalidator #6: "Any feature-spec change that lands AFTER training starts (re-train with the new spec, re-declare)." **This is the binding contract this proposal must work within.**

---

## 1. Source feasibility — pass with caveat

**True Stuff+ from Baseball Savant: DEAD.** Probe 1 confirms `stuff_plus`, `location_plus`, `pitching_plus`, `pitch_arsenal_score`, `bot_stf_overall` columns are empty for qualified pitchers in 2024 — exact same gotcha as the wRC+ column on Savant.

**Per-pitch arsenal aggregate access: BROKEN via documented `csv=true`.** Probe 2 returns the page HTML when CSV is requested. Original memo probe 9 cited this as populated; the endpoint behavior has shifted since (or the original probe used an unrecorded session pattern). Recovery would require either scraping the page-embedded JSON state or a different per-player endpoint — both add engineering weight.

**Per-pitch movement+velocity at season aggregate: POPULATED.** Probe 4 confirms `ff_avg_speed`, `ff_avg_break_x/z`, `ff_avg_spin`, slider/changeup/curve/sinker equivalents — all present at the season-per-player level. **This is the input you would need to ROLL YOUR OWN Stuff+ via neural net** (Eno Sarris's published approach). Multi-week effort; explicitly out of scope for the one-holdout-consumption cap.

**MLB Stats API sabermetrics endpoint for pitching: UNLOCKED.** Probe 5 returns `fip`, `xfip`, `fipMinus`, `eraMinus` per-season with FG parity (Burnes 2024 fipMinus 86.94 ≈ FG published value). Same season-only / date-range-ignored gotcha as wRC+ (probe 6).

**Per-window counting stats for computed xFIP: POPULATED via byDateRange.** Probe 7 confirms IP, HR, BB, K, HBP, BF, FO (flyouts), GO (groundouts), ER all per-window per-pitcher. xFIP is computable from these with one league-average HR/FB constant per season. **This is the recommended path.**

### What this means

The naming changes from "Stuff+" to "xFIP / fipMinus." The intent is the same — a pitcher-quality signal less luck-contaminated than raw FIP. Both replacements come free from MLB Stats API. True Stuff+ is shelved as a future research lane.

**Per CSO's guardrail, this counts as the source-feasibility outcome.** The Stuff+ source IS available indirectly (per-pitch movement aggregates), but rolling-your-own is a bigger scope change than the orchestrator brief framed. The escalation Kyle's brief told me to make IF the source was unavailable is partially triggered. **Recommendation: proceed with xFIP/fipMinus as the Stuff+-comparable target, and EXPLICITLY flag in the proposal that this is not literal Stuff+.** If CSO reads "Stuff+ specifically or nothing" as the directive, escalate before implementer.

---

## 2. Formula / aggregation

### Recommended metric: xFIP at L30 (in-season-as-of-date) via computation

**Why xFIP over fipMinus:**
- fipMinus from sabermetrics endpoint is season-only (probe 6). At T-60min on a July game, the value would be either (a) full 2024 season including post-game-date data (look-ahead) or (b) 2023 full-year (stale, prior-year carry). Both have the same problems Path A revised had for wRC+.
- xFIP computed from byDateRange counting stats over a true L30 window is in-season-as-of-date with no look-ahead — same shape as the existing `starter_fip` 30-day rolling residual.

### Formula

```
xFIP = ((13 × FB × lgHRperFB) + 3 × (BB + HBP) − 2 × K) / IP + xFIP_const
```

Where:
- `FB` = flyouts in the window (from byDateRange `flyOuts`)
- `lgHRperFB` = season-level league HR-per-FB rate (~0.115 in 2024; published by FG annually; one constant per season, hand-transcribed same as the wRC+ memo's constants pattern)
- `BB`, `HBP`, `K`, `IP` = byDateRange counting stats (same source as `starter_fip`)
- `xFIP_const` = league-wide constant set so league-average xFIP equals league-average ERA (~3.10 in 2024; published by FG annually)

The two constants per season (lgHRperFB, xFIP_const) are hand-transcribed from FanGraphs leaders pages (free, public reference data — same legal posture as the wRC+ memo's constants table). 2022, 2023, 2024 values transcribed at backfill time.

### Window choice

**L30 IP-weighted, mirroring `starter_fip`.** Same window as the existing FIP residual. Same `≥3 IP minimum` floor for triggering vs. league-average fallback. Same fallback value pattern (use league-average xFIP ≈ 3.10 if the pitcher has insufficient L30 data).

This is intentional — keeping the window aligned with `starter_fip` means the L2 sees both FIP and xFIP on the same temporal slice; their difference (xFIP - FIP) isolates pitcher HR/FB luck, which is the residual signal the new feature is supposed to add.

### Alternative considered: L30 fipMinus (computed)

Compute fipMinus the same way: FIP from byDateRange / league FIP × 100. **Rejected** because it's a monotone transformation of FIP — adds zero information beyond what `starter_fip` already encodes. xFIP is the orthogonal signal.

### Alternative considered: per-pitch run-value rollup as the true Stuff+ proxy

Per probe 2, this surface is broken via documented CSV access. Recovery requires scraping page-state JSON or a different access pattern. **Rejected on engineering-weight grounds within the one-holdout-consumption cap.** Documented as future research lane in section 9.

---

## 3. Schema fit

### No new table. No new columns. No new migration.

xFIP is computed FROM existing `pitcher_game_log` rows (HR, BB, HBP, K, IP) plus a league-constant table loaded in code. The constants are 2 floats × 3 seasons = 6 values; a TS object literal is fine.

Adding flyouts (FB) to `pitcher_game_log` IS a one-column extension. The existing `07-pitcher-game-log.mjs` parses boxscore pitching stats but doesn't currently capture flyouts — extending parsePitcherStats to add `fb` (parseInt(pit.flyOuts) or `airOuts` minus popups, depending on what boxscore returns) is one line. Migration 0029-pitcher-game-log-fb adds `fb SMALLINT NOT NULL DEFAULT 0`. The existing 7,290 rows backfill on the same script run; idempotent upsert on (pitcher_id, game_id).

**Migration size:** trivial. One ALTER TABLE ADD COLUMN.

**Idempotency:** yes — upsert pattern identical to existing `07-pitcher-game-log.mjs`.

### Serving function signature

Add to `apps/web/lib/features/moneyline-v0.ts`:

```ts
const LG_HR_PER_FB = { 2022: 0.117, 2023: 0.121, 2024: 0.115 } as const;
const XFIP_CONST = { 2022: 3.18, 2023: 3.20, 2024: 3.13 } as const;
const LEAGUE_AVG_XFIP = 4.20; // fallback when L30 IP < 3

export async function fetchStarterXfip(
  db: SupabaseClient, pitcherId: string | null, asOfIso: string,
): Promise<number> {
  if (!pitcherId) return LEAGUE_AVG_XFIP;
  const asOfDate = asOfIso.slice(0, 10);
  const seasonYear = parseInt(asOfDate.slice(0, 4), 10);
  const lgHRperFB = LG_HR_PER_FB[seasonYear] ?? 0.115;
  const xfipConst = XFIP_CONST[seasonYear] ?? 3.15;
  const { data, error } = await db
    .from('pitcher_game_log')
    .select('ip, fb, bb, hbp, k')
    .eq('pitcher_id', pitcherId)
    .gte('game_date', subtractDays(asOfDate, 30))
    .lt('game_date', asOfDate);
  if (error) throw error;
  if (!data || data.length === 0) return LEAGUE_AVG_XFIP;
  let sumIp = 0, sumNum = 0;
  for (const r of data) {
    const ip = Number(r.ip ?? 0);
    sumIp += ip;
    sumNum += 13 * Number(r.fb ?? 0) * lgHRperFB
            + 3 * (Number(r.bb ?? 0) + Number(r.hbp ?? 0))
            - 2 * Number(r.k ?? 0);
  }
  if (sumIp < 3) return LEAGUE_AVG_XFIP;
  return sumNum / sumIp + xfipConst;
}
```

**Mirror change in `scripts/features/build-moneyline-v0.py`** — same formula in Python. Train/serve parity is the recurring risk; the formula module pattern from the wRC+ pause should be applied here (one source-of-truth constants file referenced by both the TS and Python sides, OR a parity fixture re-checked every change).

---

## 4. Integration with v0 — REPLACEMENT, not addition

This is the section CSO and CEng must read carefully.

### The holdout-feature-count constraint

`models/moneyline/holdout-declaration.json` invalidator #6: "Any feature-spec change that lands AFTER training starts." Adding two NEW residuals (e.g., `starter_xfip_l30_home/away`) on top of the existing 11-feature payload would expand the feature spec from 12 features to 14 features (1 anchor + 13 residuals). This IS a feature-spec change.

**Two readings of the contract:**
1. **Strict reading:** ANY change to the feature list triggers a re-declaration. Then xFIP requires a fresh holdout slice (which doesn't exist yet for post-2024-12-31 — backfills haven't landed). This makes the proposal blocked on data backfill, not on Stuff+ feasibility. CSO escalation.
2. **Pragmatic reading:** The intent of invalidator #6 is to prevent selection-tuning the feature list based on holdout performance. REPLACING two zero-coefficient slots (the wRC+ residuals) with two non-zero pitcher-quality residuals is structurally a SWAP, not an additive expansion — feature count stays 12; no new dimension; no L2 renorm to re-tune. The wRC+ slots have never carried weight (coef = 0 from the start). Swapping them for slots that might carry weight is functionally equivalent to "the model uses 9 active residuals + 2 new active ones" instead of "9 active + 2 dead."

**Recommendation: REPLACEMENT.** Feature payload becomes:

| slot | current | proposed |
|---|---|---|
| 0 | market_log_odds_home (anchor) | unchanged |
| 1 | starter_fip_home | unchanged |
| 2 | starter_fip_away | unchanged |
| 3 | starter_days_rest_home | unchanged |
| 4 | starter_days_rest_away | unchanged |
| 5 | bullpen_fip_l14_home | unchanged |
| 6 | bullpen_fip_l14_away | unchanged |
| 7 | **team_wrcplus_l30_home (zeroed)** | **starter_xfip_l30_home** |
| 8 | **team_wrcplus_l30_away (zeroed)** | **starter_xfip_l30_away** |
| 9 | park_factor_runs | unchanged |
| 10 | weather_temp_f | unchanged |
| 11 | weather_wind_out_mph | unchanged |

Total feature count: **12 unchanged**. Active-residual count: 9 → 11 (the two new slots are expected to load).

**This is the proposal's central claim.** If CEng reads invalidator #6 strictly enough that even REPLACING zero-coefficient slots triggers re-declaration, this becomes a fresh-holdout escalation and the chain stops at scope-gate. Flagged here so the gate has the contract-interpretation question in front of it.

### Why xFIP and FIP don't fully redundant

Both encode pitcher run-prevention. The difference is HR-rate luck:
- FIP charges actual home runs at the pitcher's expense.
- xFIP normalizes to league-average HR/FB rate.

A pitcher with abnormal HR/FB luck in the L30 window has FIP and xFIP that diverge meaningfully. The L2 sees both; if collinear, one collapses; if orthogonal, both load. **The expected value of the new feature is the SECOND-order signal: pitcher process quality decoupled from outcome luck.** This is structurally similar to why FG publishes both metrics — they answer different questions.

If both wRC+ slots were dead and the swap leaves the slots dead too (xFIP also fails to load), that's a real signal that pitcher-quality residual is saturated by `starter_fip` alone — and the next research direction shifts to a different residual class (TTOP, handedness park splits, lineup composition).

---

## 5. Coverage requirements

- **Backfill window:** 2022-09-01 → 2024-12-31. Same as v0 training+holdout window.
  - `pitcher_game_log` already has all rows in this window (per migration 0028 backfill).
  - Adding `fb` column: re-run `07-pitcher-game-log.mjs` with the parser update, idempotent upsert hits all existing 7,290 game-day rows. Wall time: ~6-8 hours (rate-limited at 2 req/sec).
- **Coverage target:** ≥95% non-NULL `fb` per row. Boxscores reliably include `flyOuts` since 2017; 2022-2024 should be 100%. If <95%, fall back to league-avg xFIP for affected rows (same pattern as `starter_fip`).
- **Ongoing serve:** T-60min picks. The existing nightly pitcher-game-log refresh extends naturally to populate `fb`. **No new cron required** — the refresh job's parser gets one extra field. xFIP is computed live from L30 window at serving time, identical to `starter_fip`.

---

## 6. Cost / effort

| Item | Hours / cost |
|---|---|
| Migration: `0029_pitcher_game_log_fb.sql` (ADD COLUMN) | 0.5h |
| Update `07-pitcher-game-log.mjs` parser to extract `flyOuts` | 0.5h |
| Re-run backfill (idempotent upsert on 7,290 games at 2 req/sec) | ~6-8h wall, ~0.5h dev oversight |
| Constants module: `LG_HR_PER_FB` + `XFIP_CONST` for 2022/2023/2024, hand-transcribed from FG | 1h (transcription + cite) |
| Serving: `fetchStarterXfip` in `apps/web/lib/features/moneyline-v0.ts` | 1h (mirror of `fetchStarterFip`) |
| Training: equivalent change in `scripts/features/build-moneyline-v0.py` | 1h |
| Train/serve parity fixture re-generation + spot-check | 1h |
| Verification gate: spot-check computed xFIP vs MLB sabermetrics endpoint xFIP for 5 known pitchers (Burnes 2024, Wheeler 2024, Skubal 2024, deGrom 2023, Verlander 2022) full-season values within ±0.20 xFIP | 1h |
| Feature-spec doc update + look-ahead audit re-run | 1h |
| Re-train v0 candidate; pick-tester gate | 2h (mostly mlb-model + mlb-backtester time) |
| Coverage audit script | 0.5h |
| **Total dev:** | **~10 hours** spread across mlb-data-engineer + mlb-feature-eng + mlb-model |

**Cost:**
- One-time backfill: $0 (MLB Stats API free; rate-shared envelope)
- Ongoing monthly: $0 incremental (existing nightly refresh extends naturally)
- No paid API. No new infra. COO sub-budget impact: zero.

This is meaningfully smaller effort than the (now-abandoned) wRC+ path. The reason is structural: we're computing FROM data we already store, not ingesting a new feed.

---

## 7. Methodology risks

1. **Train/serve parity (the recurring risk).** The xFIP formula module must be byte-identical between `apps/web/lib/features/moneyline-v0.ts` and `scripts/features/build-moneyline-v0.py`. Constants table the same. Parity fixture (`tests/fixtures/feature-parity/moneyline-v0-2024-08-15-nyyvsboston.json`) regenerated against new feature values; CI parity test catches drift. **Mitigation:** the wRC+ pause's lesson — verification gate runs BEFORE backfill consumes anything downstream.

2. **Collinearity with `starter_fip` collapsing both residuals.** L2 redistributes correlated features. If xFIP and FIP correlate >0.85 in the training set, L2 will likely zero one. **Mitigation:** include a pre-train collinearity check on the training feature parquet; if Pearson(starter_fip_home, starter_xfip_home) > 0.85, surface the diagnostic but DO NOT block the train. The L2 outcome IS the test of whether xFIP adds signal.

3. **Park-factor entanglement.** xFIP is NOT park-adjusted in the FG variant we're computing — same as raw FIP. We DO have `park_factor_runs` as a separate residual. No double-count. (This is cleaner than the wRC+ pause's park-factor source mismatch — xFIP's formula has no park-factor component to mismatch.)

4. **League-pitching-environment drift.** The two annual constants (lgHRperFB, xFIP_const) lag the season. For mid-season 2025 serving, we'd be using 2024 constants until the new ones are transcribed. **Mitigation:** league averages move ~2-5% year over year; using prior-year constants on early-season serving introduces ~0.05 xFIP units of bias — well below the noise floor. Re-transcribe at season start.

5. **Holdout-feature-count contract** (section 4). The replacement framing assumes CEng reads invalidator #6 to permit zero-slot swaps. If CEng reads it strictly, fresh holdout required and chain stops. **Mitigation:** scope-gate holds the contract-interpretation question; if uncertain, escalate to CEng before implementer touches anything.

6. **Pitcher-handedness double-count.** Bullpen FIP and starter FIP do NOT include handedness splits. xFIP doesn't either. No new double-count introduced.

7. **byDateRange ignored on sabermetrics block.** Same gotcha as wRC+ memo — confirmed in probe 6. We're explicitly NOT relying on sabermetrics for the L30 value; we COMPUTE xFIP from byDateRange counting stats. This risk is recorded so the next ingester author doesn't re-trip on it.

8. **Ingestion-rate envelope.** Adding `fb` parsing to the existing 07-script doesn't add API calls. The one-time backfill re-runs the existing 7,290-game loop at the existing 2 req/sec. COO rate-share impact: identical to the existing FIP backfill. Zero net new envelope use after initial run.

9. **Source dependency on FanGraphs constants page.** Hand-transcribed reference data. If FG changes the published constants format or the page is paywalled later, transcription becomes harder. **Mitigation:** Tom Tango's blog (`tangotiger.com`) publishes the same constants; cross-reference both. Comment the source URL + transcription date in the constants module.

---

## 8. Honest impact read

### What the residual lift looks like, realistically

**v0's largest existing residual is `starter_fip_away` at coefficient -0.085** (post-scaling). That's the size of effect a single pitcher-quality residual achieves when the market hasn't fully priced the pitcher-quality information.

The proposal adds two NEW residuals that target the same pitcher-quality direction (xFIP for both starters). Possible outcomes:

**Floor case:** xFIP is highly collinear with FIP (>0.85 in the training set). L2 redistributes; one or both new slots collapse to coef ~0. Net residual lift: zero. ROI delta: ±0.5pp (within noise). Feature ships, doesn't move the needle. Reading: "pitcher quality is saturated by raw FIP at this market depth."

**Median case:** xFIP and FIP correlate 0.65-0.80 (typical from FG-published correlations across seasons). L2 redistributes some weight from FIP to xFIP; new residuals load |coef| 0.02-0.05 each; sum_abs_residuals rises from 0.295 to 0.34-0.38. ROI@+2% delta: **+0.5 to +1.5 pp**. ECE point: stable in [0.025, 0.040].

**Ceiling case:** xFIP captures HR-rate-luck signal that FIP misses. New residuals load |coef| 0.05+ each; sum_abs_residuals rises to 0.40+. ROI@+2% delta: **+1.5 to +2.5 pp**. ECE: stable.

**Realistic expected band: +0 to +2 pp ROI@+2%.** Most probability mass between +0 and +1 pp.

### Comparison to what the original memo's Path C bullet quoted

The original wRC+ memo's Path C bullet quoted "+1 to +4 pp ROI@+2% (pitcher-quality is current biggest residual; richer signal here is highest expected leverage), Confidence: Moderate-to-high." **That was an optimistic read on TRUE Stuff+ via per-pitch neural-net signal**, which is NOT what this proposal delivers. The published Stuff+ would in principle add information FIP and xFIP cannot capture (movement quality decoupled from results entirely). xFIP adds only HR/FB-luck decoupling — a meaningful but smaller signal class.

**The honest expected impact for the achievable path is roughly half of what the original memo quoted for true Stuff+.**

### What this means for the holdout-consumption decision

CSO set a one-holdout-consumption hard cap: if Stuff+ also fails residual loading, declare a new holdout slice and escalate. The honest expected impact band (**+0 to +2 pp, mass at the lower end**) puts non-trivial probability on the "fails to materially move ROI" outcome.

Two CSO-level questions to surface BEFORE implementer touches the holdout:

1. **Does the +0 to +2 pp expected band justify consuming the pinned holdout, given that the next post-2024-12-31 holdout slice is undeclared and 2025 backfill timing is open?** In personal-tool/portfolio phase, an alternative read is: ship the xFIP ingester as infra (pure feature plumbing, no holdout touched) and DEFER the retrain until either (a) 2025 data lands and a fresh holdout is available, or (b) live-pick evidence on the existing v0 surfaces a clearer signal that the pitcher-quality residual is the binding constraint.

2. **Is "xFIP/fipMinus" what CSO meant by "Stuff+"?** The verdict's literal language was "Stuff+ via Savant pitch-arsenal-stats." Savant pitch-arsenal-stats is broken via documented CSV access (probe 2) and the Stuff+ column itself is empty (probe 1). xFIP is the closest free, available, FG-parity, in-season-as-of-date-computable substitute — but it is a NAMING substitution, not literal Stuff+. If CSO reads "literal Stuff+ or escalate," the pivot is to roll-our-own from per-pitch movement (multi-week, out of scope) OR to a paid feed (budget breach, COO escalation) OR to xFIP (this proposal).

**Recommendation: bring proposal to scope-gate. If scope-gate APPROVED, the auto-chain fires CEng + COO in parallel per CSO's verdict's second condition. CEng's vote on the feature-count contract reading is the binding signal. If ANY lens-holder reads the impact band as too low to justify holdout consumption, route back to CSO with the "ship as infra, defer retrain" alternative.**

---

## 9. Future research lanes (recorded, not actioned)

Per CSO's verdict's flag-for-next-research-cycle list plus this memo's findings:

1. **Park-factor source mismatch** (carried forward from wRC+ verdict). FG uses Statcast-regressed multi-year per-team factors; we use `park_factor_runs.runs_factor` from FG/B-Ref aggregates. Latent across any future park-adjusted feature. Not triggered by xFIP (no park component) but would reactivate on a future xWOBA-against or Pythagorean-runs-derived feature.

2. **MLB Stats API sabermetrics ignoring intra-season `startDate`/`endDate`** (carried forward). Re-confirmed this memo's probe 6 for pitching. Structural constraint on any future "pull FG-parity season-aggregate" path. Documented twice now — fold into the research index next cycle.

3. **True Stuff+ via per-pitch movement.** Probe 4 confirms inputs are populated at season-aggregate level. Re-architecting access to per-game per-pitch movement (Statcast pitch-by-pitch ingestion) is a multi-week project that would unlock the published Stuff+ signal AND a wider class of pitch-quality features (Location+, arsenal-mix entropy, velocity-decay-in-game). Worth a dedicated research memo if the v0-with-xFIP retrain shows pitcher-quality residuals are still the binding gap. Estimated effort: 2-4 weeks; storage: ~50GB for 2022-2024 pitch-by-pitch; Statcast API rate envelope: ~1 req/sec, ~80 pitches/game × 7,290 games = ~580K requests, ~7 days backfill.

4. **csw_percent / chase_percent / o_swing_percent populated emptiness on Savant custom leaderboard** (probe 3). These are well-documented pitcher-process metrics; if Savant ever populates them at the per-player CSV level, they're a cheaper alternative to per-pitch ingestion for the same residual class.

---

## 10. Locked-invariant impact

None of the locked methodology invariants are touched by this proposal:

- **Calibrated probabilities:** preserved. Same logistic + raw sigmoid; calibrator gates re-run.
- **Holdout discipline:** the pinned `moneyline-v0-holdout-2026-05-03` declaration applies; the retrained candidate is evaluated on it ONCE; the next walk-forward holdout for the FOLLOWING retrain needs a fresh declaration. **Section 4's contract-interpretation question is the open item.**
- **Comparison-against-current:** explicit in the experiment proposal's `comparison` block.
- **Market-prior awareness:** anchor stays as feature [0]; expected anchor coef stays in [0.93, 1.02].
- **Methodology-agnosticism:** this is a feature-change, not a model-class change. LightGBM and richer-residual proposals remain deferred per CSO direction.

---

## 11. Independence from wRC+ work product

The wRC+ work product (`docs/proposals/wrcplus-ingestion-revB-2026-05-04-implementer-pause.md`) is preserved per CSO's verdict's fourth condition. This proposal does NOT use:

- The wRC+ formula module attempt (deleted per pause)
- The `batter_game_log.wrc_plus` column (still NULL; will remain NULL post-this-proposal)
- The wRC+ constants table (irrelevant to xFIP)

This proposal DOES use:
- The `pitcher_game_log` table (existing, unchanged shape)
- The MLB Stats API byDateRange pattern (proven via existing FIP ingester)
- The hand-transcribed-constants pattern (LESSON learned from wRC+ pause: keep the source-citation discipline; don't depend on FG-quality verification when the formula has different structural assumptions than the verification target)

---

## Experiment proposal

```yaml
proposal_id: stuff-plus-ingestion-2026-05-04
proposer: mlb-research
kind: feature-change
lens: cross-lens  # CEng owns residual interpretation + holdout-contract reading; COO owns rate-share; CSO has directed pivot
claim: >
  Pivot the wRC+-residual-fix work to a Stuff+-comparable signal:
  REPLACE the two zeroed wRC+ residuals (team_wrcplus_l30_home/away) in
  the v0 feature payload with two pitcher-quality residuals
  (starter_xfip_l30_home/away). xFIP is computed from MLB Stats API
  byDateRange counting stats over a 30-day window per starter, using
  hand-transcribed per-season league constants (lgHRperFB, xFIP_const).
  Source verification target: MLB Stats API sabermetrics endpoint's
  full-season fip/xfip values, FG-parity. Feature count stays at 12; no
  new dimension. Add `fb` column to pitcher_game_log; re-run idempotent
  backfill (~6-8h wall) to populate flyouts; build ingester +
  serving + training in parallel. After verification gate PASS,
  mlb-model retrains v0 against the pinned holdout
  (moneyline-v0-holdout-2026-05-03); pick-tester gates the candidate vs
  current. Per CSO verdict, this is the SINGLE allowed pinned-holdout
  consumption on the Stuff+ pivot — if xFIP residuals also fail
  residual loading (|coef| < 0.02 on both starter_xfip slots), do NOT
  attempt a third feature pivot on this holdout; declare a new holdout
  slice and escalate to user.
evidence:
  - "v0 production has 2 of 11 residuals at exact zero (`team_wrcplus_l30_*`) because batter_game_log.wrc_plus is unfilled (CSO's Option C verdict)."
  - "Live HTTP probes 2026-05-04 confirm: Savant `stuff_plus`/`location_plus`/`pitching_plus`/`pitch_arsenal_score`/`bot_stf_overall` columns EMPTY for every row (probe 1, matches original memo probe 8); Savant `pitch-arsenal-stats?csv=true` returns page HTML not data (probe 2 — original memo's probe 9 evidence appears to no longer reproduce); per-pitch movement+velocity columns POPULATED at season aggregate (probe 4) but per-game access requires a multi-week pitch-by-pitch ingestion project, out of scope for the one-holdout-consumption cap."
  - "MLB Stats API sabermetrics endpoint for pitching returns `fip`, `xfip`, `fipMinus`, `eraMinus` with FG-parity (Burnes 2024 fipMinus 86.94; probe 5). Used as VERIFICATION TARGET for our computed xFIP (full-season match within ±0.20 xFIP units), NOT as live ingestion source — same date-range-ignored gotcha as wRC+ (probe 6)."
  - "byDateRange endpoint returns IP/HR/BB/K/HBP/BF/FO/GO/ER per-window per-pitcher (probe 7) — sufficient inputs for L30 xFIP computation."
  - "Pitcher-quality is the existing largest residual class in v0 (`starter_fip_away` coef -0.085 — biggest non-anchor coefficient). Adding xFIP gives the L2 a richer basis in the same pitcher-quality direction; if it adds orthogonal signal (HR/FB-luck decoupling), residuals load; if collinear with FIP, L2 redistributes near-zero (a real signal that pitcher-quality is saturated by raw FIP at this market depth)."
  - "CSO 2026-05-04 verdict on `wrcplus-ingestion-revB-2026-05-04-pause` selected Option C (pivot to Stuff+); first condition: 'Restart the pipeline at Stage 1 with mlb-research spec'ing Stuff+ source/formula/coverage.' This memo executes that restart."
  - "Original wRC+ memo's Path C ROI lift estimate (+1 to +4 pp) was framed for true Stuff+ via per-pitch neural-net signal. This proposal delivers xFIP/fipMinus, a related but smaller signal class. Honest expected band: +0 to +2 pp ROI@+2%, with material probability mass at the lower end (section 8)."
comparison:
  - approach_a: "v0 current — anchor + 11 residuals, 2 zeroed. ROI@+2% +11.33% on holdout (n=416). ECE 0.0304. sum_abs_residuals 0.2952. starter_fip_away coef -0.085."
  - approach_b: "v0 retrained on same architecture, same holdout, same drop predicate, with team_wrcplus_l30_home/away REPLACED by starter_xfip_l30_home/away in the feature payload."
  - delta_metrics: >
      Targets: ROI@+2% in [+9%, +14%] (within ±2pp of current point estimate);
      ECE point ≤ 0.04; both starter_xfip residual |coef| ≥ 0.02; OR if
      collinearity with starter_fip drives the L2 to redistribute, the
      diagnostic that BOTH starter_fip AND starter_xfip together carry
      |coef| ≥ 0.10 (i.e., pitcher-quality direction is loaded ≥+15%
      vs current 0.085 baseline). sum_abs_residuals expected to rise
      modestly (current 0.2952 → 0.32-0.38 median case). No sign flips
      on the other 9 residuals. 7d-block bootstrap lower bound for
      ROI@+2% must remain above -2.5%. If both xFIP slots come back at
      |coef| < 0.02 AND combined-with-FIP pitcher-quality coefficient
      doesn't rise meaningfully, ingester ships regardless; CSO is
      escalated with "ingested but pitcher-quality residual class
      saturated" + recommendation to declare fresh holdout (per CSO's
      hard-cap condition).
  - verification_gate_pre_retrain: >
      Before mlb-model retrains, mlb-feature-eng spot-checks the computed
      xFIP for 5 known-quantity qualified starters (Burnes 2024,
      Wheeler 2024, Skubal 2024, deGrom 2023, Verlander 2022) against
      the MLB Stats API sabermetrics endpoint's full-season xfip values.
      Acceptance: every spot-check within ±0.20 xFIP units of
      sabermetrics value (xFIP scale is ~3.0-5.0; ±0.20 is ~5%, tighter
      than wRC+'s ±3 because xFIP has a smaller dynamic range). If ANY
      spot-check misses by >0.40, the constants table or formula has a
      bug; mlb-data-engineer fixes before chain advances.
risks:
  - "Holdout-feature-count contract reading. Migration 0029 + new feature slots is a feature-spec change. Section 4 argues REPLACEMENT preserves invalidator #6 (no new dimension); if CEng reads strict, fresh-holdout required → chain stops, escalate. SCOPE-GATE MUST RAISE THIS QUESTION TO CENG IN ITS APPROVED ROUTING."
  - "Train/serve parity on the new xFIP formula. Recurring risk; mitigated by parity fixture + the verification gate (which catches BOTH formula bugs AND constant-table bugs before retrain consumes the holdout)."
  - "Collinearity with starter_fip. L2 redistributes; xFIP and FIP correlate 0.65-0.85 typical. Outcome IS the test of whether xFIP adds orthogonal signal."
  - "Constants source brittleness. Two floats × N seasons hand-transcribed from FG. 2025 transcription needed at season open. Documented in code comments per the wRC+ pause's lesson."
  - "MLB Stats API rate envelope. Backfill re-runs existing 07-script at 2 req/sec for 7,290 games (~6-8h wall). No incremental ongoing rate beyond existing nightly refresh. COO impact: zero new $."
  - "Naming substitution risk. CSO's verdict said 'Stuff+ via Savant pitch-arsenal-stats.' That literal source path is broken (probes 1+2). xFIP is the closest free, FG-parity, in-season-as-of-date-computable substitute. If CSO reads 'literal Stuff+ or escalate,' chain should stop at scope-gate routing for CSO re-confirmation BEFORE CEng+COO fire."
  - "Holdout consumption on a +0 to +2 pp expected band. Section 8 argues alternative: ship xFIP ingester as pure infra (no holdout touched), defer retrain until 2025 data lands or live-pick evidence makes the pitcher-quality binding constraint clearer. CSO has the call."
rollback:
  - "Revert PR; pitcher_game_log.fb column can stay populated (no schema rollback needed). Production v0 in models/moneyline/current/ remains in place; if the retrained candidate fails pick-test, candidate goes to models/moneyline/candidate-stuffplus-2026-05-04/ and current/ stays."
  - "Time-to-detect regression: pick-test runs immediately on retrain. If retrained model passes pick-test but live-cron ECE breaches 0.04 spec at the 200-pick re-check, isotonic wrap fits in-place per the standing live_ece_recheck_at_200_picks condition."
  - "If verification gate fails (formula bug not caught in dev), fb column repopulation runs idempotent; no upstream model dependency until post-backfill chain advances. wRC+ pause-pattern preserved: zero downstream commits until the gate passes."
  - "If CSO escalation triggers (xFIP residuals fail loading + combined pitcher-quality unchanged), the ingester ships standalone; v0 production unchanged; the next research cycle pivots to a different residual class (TTOP, handedness park splits, lineup composition) on a fresh holdout."
scope:
  - markets_affected: [moneyline]
  - user_facing: no
  - irreversible: no
attachments:
  - "docs/research/stuff-plus-ingestion-2026-05-04.md (this memo)"
  - "docs/proposals/wrcplus-ingestion-revB-2026-05-04-pause-verdict-cso.md (CSO direction this proposal executes)"
  - "docs/proposals/wrcplus-ingestion-revB-2026-05-04-implementer-pause.md (preserved work product the wRC+ verdict required)"
  - "docs/research/wrcplus-ingestion-2026-05-04.md (rev B memo — Path C bullet's expected-impact band carried over with honest correction in section 8)"
  - "supabase/migrations/0028_pitcher_game_log.sql (existing table; ADD COLUMN fb in new migration 0029)"
  - "scripts/backfill-db/07-pitcher-game-log.mjs (existing — extend parsePitcherStats to capture flyOuts; idempotent re-run)"
  - "apps/web/lib/features/moneyline-v0.ts:151-216 (existing fetchStarterFip pattern to mirror as fetchStarterXfip)"
  - "scripts/features/build-moneyline-v0.py (training side — mirror change)"
  - "models/moneyline/holdout-declaration.json (pinned holdout this retrain consumes; section 4 contract-interpretation question)"
  - "models/moneyline/current/feature-coefficients.json (current 11-residual baseline)"
  - "docs/audits/moneyline-v0-validation-2026-05-04.md (validation evidence the v0 residual stack still pulls weight on post-ASB; pre-ASB anchor-only ties or beats v0 — context for the swap's expected ceiling)"
```

### What APPROVED unlocks (specialist routing)

1. **mlb-data-engineer:**
   - Write `supabase/migrations/0029_pitcher_game_log_fb.sql` — `ALTER TABLE pitcher_game_log ADD COLUMN fb SMALLINT NOT NULL DEFAULT 0;`. Index unchanged.
   - Update `scripts/backfill-db/07-pitcher-game-log.mjs` `parsePitcherStats()` to extract `pit.flyOuts` (or `pit.airOuts - pit.popOuts` if MLB API returns those separately — confirm boxscore field name during dev). Same idempotent upsert; `fb` field added to UPDATE SET.
   - Write `scripts/lib/xfip-formula.ts` (and `.py` mirror) — pure compute module: inputs (per-window IP, FB, BB, HBP, K + season-year) → output (xFIP). Includes hardcoded `LG_HR_PER_FB` + `XFIP_CONST` tables for 2022, 2023, 2024. Constants sourced from FanGraphs leaders + tangotiger.com cross-reference; source URLs + transcription date in comments.
   - Re-run backfill (off-peak, coordinated). Coverage report at `docs/audits/xfip-backfill-results-2026-05-04.json`. Target: ≥95% non-NULL `fb` per row.
   - **Optional ongoing cron:** none required — existing nightly pitcher_game_log refresh extends naturally.
2. **mlb-feature-eng:**
   - Run the verification gate: pull MLB Stats API sabermetrics xfip for 5 known-quantity qualified starters across 2022-2024. Compute the same via the new formula module on full-season counting stats. PASS = all 5 within ±0.20 xFIP units of sabermetrics. FAIL = chain stops; mlb-data-engineer debugs constants/formula.
   - On verification PASS: write `apps/web/lib/features/moneyline-v0.ts` `fetchStarterXfip` (mirror of `fetchStarterFip` at lines 151-170). Update the `MoneylineV0Features` type and `buildMoneylineV0Row` Promise.all to call it for both starters. **Replace** `team_wrcplus_l30_home/away` slots in the type AND in `buildMoneylineV0Row` return — these fields are removed from the payload, replaced by `starter_xfip_l30_home/away`.
   - Update `scripts/features/build-moneyline-v0.py` equivalent. Drop the wRC+ feature columns; add the xFIP feature columns. Re-generate the parity fixture (`tests/fixtures/feature-parity/moneyline-v0-2024-08-15-nyyvsboston.json`) against the new payload shape.
   - Re-run look-ahead audit; the canary leakage feature must still trigger on the new feature parquet.
   - Update `docs/features/moneyline-v0-feature-spec.md` with the swap (mark wRC+ slots as REPLACED, document xFIP slots, cite this proposal_id).
3. **mlb-model:**
   - Retrain logistic + L2 (C=1.0) on the new feature parquet (12 features, same shape; xFIP slots replace wRC+ slots). Save to `models/moneyline/candidate-stuffplus-2026-05-04/`. Do NOT touch `current/`.
   - Report new `feature-coefficients.json`, `metrics.json`, sum_abs_residuals, anchor coef + CI, variance-collapse check.
   - Pre-train collinearity check: report Pearson(starter_fip_home, starter_xfip_home) and Pearson(starter_fip_away, starter_xfip_away) on the training set. Inform interpretation, don't block.
4. **mlb-calibrator:**
   - Re-run `/calibration-check` on candidate's holdout predictions. Confirm ECE point ≤ 0.04 absolute. Report 7d-block bootstrap CI.
5. **mlb-backtester:**
   - Re-run backtest with EV sweep at +1/+2/+3% on candidate. Report ROI + CLV + i.i.d. + 7d-block CIs side-by-side with v0 production at `docs/audits/moneyline-v0-stuffplus-comparison-2026-05-04.md`.
6. **pick-tester:**
   - Standard pick-tester gate (post-cold-start): ROI ≥ -0.5% vs current, CLV ≥ -0.1% vs current, ECE ≤ +0.02 vs current. Plus the xFIP-specific gate: BOTH starter_xfip slots OR combined-pitcher-quality (starter_fip + starter_xfip same side) load |coef| sum ≥ +0.10 each side (vs 0.085 current FIP-only baseline). If both fail, ingester ships, retrained model does NOT promote, CSO escalation per the hard-cap clause.

---

## Open question routed at scope-gate

CEng must confirm one of:
- **Reading 1:** REPLACING two zero-coefficient slots is structurally equivalent to "the model uses the same 12-feature payload with different content in slots 7-8" — invalidator #6 not triggered; pinned holdout valid.
- **Reading 2:** ANY change to the named features in the feature-spec doc triggers re-declaration — invalidator #6 IS triggered; fresh holdout required; chain pauses pending 2025 backfill or pre-declared 2024 sub-slice.

This is the binding question. The proposal as written assumes Reading 1; the rollback path covers Reading 2.
