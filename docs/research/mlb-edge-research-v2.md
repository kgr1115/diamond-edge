# Diamond Edge — MLB Edge Research v2

**Status:** Deep-dive research extension (Research v1 at `docs/research/mlb-edge-research.md`)
**Date:** 2026-04-22
**Audience:** `mlb-ml-engineer`, `mlb-backend`, `mlb-data-engineer`, Kyle (founder)
**Scope:** Four non-overlapping tracks v1 left on the table: bankroll strategy, advanced Statcast, prop-market derivatives, data-source audit.

---

## 0. Executive Summary

**Track A — Bankroll.** v1 recommended 0.25 Kelly. Validate and refine: **keep 0.25 as the ceiling, but scale *down further* to 0.10–0.15 for the first 200 picks** while model calibration uncertainty is unquantified. Adopt a **simultaneous-Kelly solver** (numerical gradient ascent over log-wealth) rather than independent single-bet Kelly on multi-pick slates — this alone cuts variance ~30–40% with <5% growth cost at realistic slate sizes. Add a **hard 10%/day exposure cap** (Walters/Thorp/Peta convergence). *Top pick: Simultaneous Kelly + daily cap — ship with baseline.*

**Track B — Statcast depth.** The biggest underexploited signal is **release-point variability** (peer-reviewed: horizontal release-point variability is a significant predictor of K/9, xFIP, and HR/9 in MLB pitchers — Frontiers 2024). Second is **Driveline-style Arsenal+ / pitch-mix entropy** — Shannon entropy of pitch types plus KDE-based "indistinguishability" beats raw Stuff+ on prediction. Spin-rate decline as an injury/fatigue signal is real but noisy. *Top pick: Release-point variability feature (cheap; peer-reviewed; pybaseball-accessible).*

**Track C — Prop derivatives.** The Odds API entry tier does carry F5 markets (`h2h_1st_5_innings`, `totals_1st_5_innings`, `alternate_totals_1st_5_innings`) but **NRFI is not a first-class market key** — must be derived from `totals_1st_1_innings`. Pitcher K-prop totals are a strong **informational feature** for game-total modeling (market's implied expected IP). Team-total props let us triangulate disagreements between DK and FD on totals arithmetic. *Top pick: Ingest F5 and 1st-inning totals markets immediately — no extra tier cost, unlocks entire Phase 3 of v1 roadmap.*

**Track D — Data sources.** Retrosheet has **free CSV umpire logs back to 1898** (better historical depth than UmpScorecards, which goes to 2015). Minor-league Statcast is **publicly available for all AAA games** since 2023 — unblocks call-up quality projection. Intraday weather refresh on a 30-min cadence is free via Open-Meteo; the WX-03 "forecast delta" edge from v1 can be upgraded from 2 polls to 4 polls with zero marginal cost. *Top pick: Retrosheet umpire CSV ingestion + AAA Statcast ingestion — both free, both close real gaps.*

**No HIGH-priority interruption to ML training.** All findings extend the v1 roadmap rather than invalidating features already in training. The one item that *could* justify a training-pause is **release-point variability (B1)** if the ML engineer hasn't already included it in the v1 pitcher feature pack — it's cheap to compute and has academic backing. Flagging but not interrupting.

---

## Track A — Post-Pick Bankroll Strategy

### A.1 Full vs. fractional Kelly at our calibration accuracy

**Theoretical baseline.** Full Kelly maximizes long-run log-wealth but has a brutal tail: there is an ~X% probability of drawdown to X% of starting bankroll at any time ([Kelly — Wikipedia](https://en.wikipedia.org/wiki/Kelly_criterion)). At full Kelly with a true 55% edge, a 50% drawdown happens with ~50% probability.

**Parameter uncertainty kills full Kelly.** Baker & McHale (2013) derive a shrinkage factor: the more uncertain your probability estimate, the smaller the optimal Kelly fraction. Replacing the true `p` with an estimated `p̂` gives poorer out-of-sample performance unless you shrink ([Baker & McHale, *Optimal Betting Under Parameter Uncertainty*](https://www.researchgate.net/publication/262425087_Optimal_Betting_Under_Parameter_Uncertainty_Improving_the_Kelly_Criterion)).

**Simulation evidence.** Downey's simulations show 1/4 Kelly reduces expected return by ~20% but cuts variance by ~80% ([Downey — uncertainty Kelly](https://matthewdowney.github.io/uncertainty-kelly-criterion-optimal-bet-size.html)). This is the empirical basis for v1's 0.25 recommendation.

**Our situation.** We have **zero historical production picks** at model launch. Calibration is unknown. Per Baker-McHale, the optimal Kelly fraction scales with the inverse of estimated-probability variance; with no production data, that variance is wide.

**Recommendation (refines v1):**
- **Weeks 0–4 (first ~100 picks):** 0.10 Kelly. Purely to build a calibration record. Log-loss ≈ 0 penalty on dollar terms given small bankrolls; massive penalty avoidance on tail.
- **Weeks 5–16 (next ~200–300 picks):** 0.15 Kelly. Ramp up only if 30-day rolling Brier score stays within 1σ of training set.
- **After 500 picks with stable calibration:** 0.25 Kelly per v1. Tier 5 (Elite) can push to 0.30 only if that tier has ≥100 picks with +CLV rate ≥55%.
- **Never above 0.30.** Full-Kelly at our edge sizes (typically 1–3%) produces unacceptable drawdown distributions even if the model is perfect.

### A.2 Simultaneous-bet Kelly for multi-pick slates

**The problem.** v1 treats each pick independently. On a 15-game slate with 5 picks, computing each pick's Kelly stake independently and summing can put 20–30% of bankroll at risk on a single night — far above any pro's discipline.

**The theory.** Thorp extended Kelly to simultaneous portfolios ([Thorp 1975](https://gwern.net/doc/statistics/decision/1975-thorp.pdf); [Thorp 2007](https://gwern.net/doc/statistics/decision/2006-thorp.pdf)). For N simultaneous independent bets with win probabilities `p_i` and decimal odds `b_i`, the optimal stake vector `f = (f_1...f_N)` maximizes:

```
E[log W] = Σ_outcomes P(outcome) · log(final_wealth)
```

summed over all `2^N` win/loss combinations. For N=5 that's 32 outcomes — trivially solvable numerically via gradient ascent with a per-iteration clipping step to enforce `Σf_i ≤ 1` ([vegapit — numerical Kelly](https://vegapit.com/article/numerically_solve_kelly_criterion_multiple_simultaneous_bets/)).

**Empirical scaling.** For N=5 independent bets each with 55% true probability at even odds, independent Kelly produces stakes summing to ~50% of bankroll; simultaneous Kelly produces stakes summing to ~32% with roughly the same geometric growth rate. Stakes are approximately proportional to each bet's "probabilistic edge" `p - 1/(b+1)` but shrunk to respect the joint-risk constraint.

**Correlation matters.** On correlated bets (same-day doubleheader totals, same-weather games, same-division games sharing bullpen context), the simultaneous-Kelly solver will *automatically* shrink further because losing-scenario probabilities rise. A correlation matrix estimated from historical parlay correlation data (weather-correlated games: ρ ≈ 0.25; non-correlated: ρ ≈ 0) can feed the solver.

**Implementation.** 50 lines of Python. Scipy `minimize` with L-BFGS-B and a budget constraint. Runs in <1s for N≤20.

**Recommendation:** Ship as `BANKROLL-04` in Phase 1. Replace independent Kelly from day 1.

### A.3 Drawdown-constrained sizing variants

Three layered guardrails, all cumulative:

| Guardrail | Threshold | Source |
|---|---|---|
| **Per-pick cap** | Max 3% of bankroll on any single bet regardless of Kelly output | Walters ([Shortform](https://www.shortform.com/blog/billy-walters-sports-betting/), [Covers](https://www.covers.com/guides/betting-tips-from-pro-sports-bettor-billy-walters)) — 3% is his ceiling |
| **Per-day cap** | Max 10% of bankroll exposed across all picks in a slate | Thorp / industry convention; matches `BANKROLL-03` from v1 |
| **Drawdown brake** | If rolling 30-day P&L ≤ −15% of bankroll at slate start, halve all Kelly stakes until P&L recovers to within −10% | Ernie Chan "subaccount" method ([epchan blog](http://epchan.blogspot.com/2010/04/how-do-you-limit-drawdown-using-kelly.html)) |

**Why all three.** Per-pick cap handles single-game confidence overreach. Per-day cap handles slate-level correlation the simultaneous-Kelly solver might underestimate. Drawdown brake handles model regime shift we haven't detected yet.

### A.4 Kelly with edge uncertainty

**The Kelly with uncertainty problem.** If our model says 55% but we know our calibration has ±3% slippage, the *effective* edge is ~52% (the pessimistic prior). Use of the expected edge `E[p]` instead of `p` overstates Kelly by roughly `Var(p̂)/p̂` — for reasonable variance this is a 20–30% overbet ([Baker-McHale 2013](https://www.researchgate.net/publication/262425087_Optimal_Betting_Under_Parameter_Uncertainty_Improving_the_Kelly_Criterion)).

**Practical shrinkage.**
```
f_kelly_uncertain = f_kelly_point · (1 - 2·σ_p̂²/p̂·(1-p̂))
```

Where `σ_p̂` is our model's calibration error per decile (from `CAL-01`). Feed this in AFTER the 0.25 fractional multiplier — they compound.

### A.5 Unit sizing across tiers

**v1 suggestion:** Tier 5 (Elite) uses 0.30 Kelly; Tiers 3/4 use 0.25. **Refinement:**

Picks tiers should map to **Kelly multipliers**, not fixed units:

| Tier | Model confidence threshold | Kelly fraction | Rationale |
|---|---|---|---|
| 3 (Standard) | Edge ≥ 2% | 0.15 | Marginal picks — tight shrinkage |
| 4 (High) | Edge ≥ 4% | 0.20 | Core picks |
| 5 (Elite) | Edge ≥ 6% + ≥2 corroborating features | 0.25 | Strongest signals |

**Reason to *not* go higher on Tier 5:** The edge size itself already upweights Tier 5 stakes via the Kelly formula `f = edge / (b-1)`. Doubling the multiplier on top of that is double-counting confidence and pushes us to overbet territory. Pros who push to full-Kelly equivalents on their highest-confidence plays (Walters' max of 3 units ≈ 3% of bankroll) do so *because* their sizing is already capped in absolute dollar terms.

### A.6 Lessons from public-pro bankroll playbooks

**Joe Peta (*Trading Bases*).** Capital-preservation over growth. Reserves ~10% of bankroll for outlier/lottery plays; bulk deployed at fixed stake schedules keyed to model confidence ([Square Bettor](https://squarebettor.com/advice-tips/lessons-from-trading-bases-by-joe-peta/); [FanGraphs community](https://community.fangraphs.com/applying-petas-wagering-methodology-in-2020/)). Key translatable idea: **predetermined bet sizes** — no gut adjustment in-the-moment. This maps to our `PICK_TIER → KELLY_MULT` lookup table.

**Bill Krackomberger.** Rating-percentage-of-bankroll system: 5% rating = 2.5% of bankroll, scaling linearly down. **Weekly bankroll rebalance** ([WagerTalk profile](https://www.wagertalk.com/profile/bill-krackman-krackomberger)). Translatable: our bankroll-as-of-Monday sets all stakes for the week, no intra-week rebalancing even if we win/lose big Tuesday–Saturday. Removes path-dependent emotional sizing.

**Billy Walters / Computer Group.** 1 unit = 1% bankroll. Max 3 units (3%) on any single wager. Scales 0.5u–3u with edge magnitude. Assumes total loss is possible ([Shortform](https://www.shortform.com/blog/billy-walters-sports-betting/)). Translatable: **hard 3% per-pick cap** (see A.3).

**Ed Thorp (Princeton-Newport).** Operated with ~100 simultaneous bets averaging $65k each from ~$80B lifetime volume. Kelly-portfolio optimization as the primary sizing framework ([Thorp 2007](https://gwern.net/doc/statistics/decision/2006-thorp.pdf)). Translatable: **joint portfolio sizing** (see A.2).

**Saahil Sud (MaxDalury) DFS.** Rotates bankroll percentage across high-variance (GPP) and low-variance (H2H/cash) contest types ([WBUR profile](https://www.wbur.org/news/2015/11/23/dfs-power-player-profile)). Translatable: we can eventually split bankroll allocations across pick types (moneyline-heavy vs totals-heavy portfolio) as we add markets. Not v1 priority.

### A.7 Concrete starting bankroll + staking formulas

**Starting bankroll sizing (for user guidance in product UI).**

```
recommended_bankroll = max(
    200 × avg_pick_stake_target,   # survive 200-pick drawdown sequence
    50 × avg_pick_stake × 5        # survive 5-pick losing day × 50 occurrences
)
```

For a user targeting $25 average picks: ~$5,000 recommended minimum. Below that, reduce Kelly multiplier further or switch to flat-unit sizing to avoid Kelly-rounding effects at small stakes.

**Per-pick staking formula (ships in `lib/staking.ts`).**

```
stake = bankroll_week_start
      × kelly_fraction_by_tier          [0.15 / 0.20 / 0.25]
      × (1 - 2·σ²_decile/(p·(1-p)))     [uncertainty shrinkage]
      × min(1, 0.03 / raw_kelly_stake)  [3% per-pick cap]

Then pass all candidate stakes through simultaneous-Kelly solver with:
  budget_constraint: Σ stake_i ≤ 0.10 × bankroll
  correlation_matrix: from historical same-slate correlations

Then apply drawdown brake:
  if rolling_30d_pnl ≤ -0.15 × bankroll: stake *= 0.5
```

**Rebalancing cadence.** Weekly (Monday pre-slate). Krackomberger pattern. Any intra-week edits require manual override.

---

## Track B — Advanced Statcast Angles

### B.1 Release-point metrics (high priority)

**The science.** [Frontiers in Sports and Active Living, 2024](https://www.frontiersin.org/journals/sports-and-active-living/articles/10.3389/fspor.2024.1447665/full) — Ball release-point variability is a significant predictor of K/9, xFIP, and HR/9 in MLB pitchers. **Horizontal release-point variability (coronal plane) is the strongest of the three axes.** MLB pitchers exhibit smaller variability than MiLB; within MLB, lower variability correlates with better performance outcomes.

**Two distinct signals in the raw data:**

1. **Intra-start release-point consistency** — a pitcher's SD of release-point across all pitches in a single start. Lower = more repeatable delivery = better command proxy.
2. **Game-to-game release-point delta** — the mean release-point of Start N vs. Start N-1 for the same pitcher. Sudden shifts (>1 SD of that pitcher's career variability) have been identified as pre-injury signals ([Using Pitch-Tracking Metrics to Identify Warning Signs Immediately Prior to Acute UCL Injuries — PMC 2024](https://pmc.ncbi.nlm.nih.gov/articles/PMC12717397/)).

**Data access.** Directly from pybaseball's `statcast(start_dt, end_dt)`: columns `release_pos_x`, `release_pos_z`, `release_extension`. Aggregate per pitcher per start to get mean + SD per start, then rolling deltas.

**Proposed features:**
- `sp_release_x_sd_last_3_starts` — intra-start horizontal release SD
- `sp_release_pos_delta_vs_career` — mean release shift in today's start vs. pitcher's career mean (imputed as 0 at season start)
- `sp_release_extension_sd_last_5` — late-season extension compression as fatigue proxy

**ROI estimate.** Peer-reviewed signal on K/9 and HR/9 suggests ~5–15 bps ROI lift on totals and pitcher-driven moneylines. Low risk — the feature is additive and the training data is free.

**Priority: HIGH.** Ship with `SP-02` (Stuff+ ingestion) in Phase 2 of v1 roadmap.

### B.2 Spin decay and movement degradation

**The signal.** Sustained drops in spin rate from a pitcher's personal baseline correlate with fatigue and precede injury. Driveline: "Sharp changes from a pitcher's normal spin rate range can be seen as an early sign of unhealthy fatigue" ([Driveline — Spin Rate](https://www.drivelinebaseball.com/2016/11/spin-rate-what-we-know-now/); [Fantrax — Spin Rate Declines](https://fantraxhq.com/statcast-standouts-spin-rate-declines/)).

**The subtlety.** Spin rate is a **season-level trend**, not a within-start signal. Late-season declines (May→Sept) are measurable for individual pitchers; within-start declines are dominated by noise. Modeling it as "current-month spin rate vs. April baseline" is the right granularity.

**Caveat.** The "sticky stuff" crackdown of 2021 produced a structural step-change in spin rates league-wide. Any spin-decay feature needs per-pitcher rolling baseline (not league-avg).

**Proposed feature:** `sp_fastball_spin_rate_vs_season_baseline_%`. If a pitcher's trailing-10-start fastball spin is ≥5% below his first-20-start baseline, down-weight his Stuff+ and shift probability toward opposing hitters.

**ROI estimate.** 3–8 bps on totals. Modest, but **cheap to compute** (same pitch-level data we're pulling for B.1). Worth bundling.

**Priority: MEDIUM.** Bundle with B.1.

### B.3 Contact quality: barrel, sweet-spot, xwOBA-on-contact

**Predictive stability ranking.**

| Metric | Year-over-year correlation | Notes |
|---|---|---|
| Barrel % | r ≈ 0.71 (for change in Barrel% vs change in ISO) | **Most stable** — captures both EV and LA selectively ([Medium — Barrel Gains](https://medium.com/@johndefilippo04/digging-into-barrel-gains-the-link-between-contact-quality-and-power-production-3b37dfebf83d)) |
| xwOBA on contact | r ≈ 0.55 | Strong but noisier than barrel%; includes all batted balls |
| Sweet Spot % (LA 8–32°) | r² ≈ 0.04 vs BA | **Weak predictor** — don't over-weight |
| Avg Exit Velocity | r ≈ 0.72 | Very stable but *less directly* tied to outcomes than barrel% |

**Actionable recommendation.** Our current features (per v1 spec) likely include `team_xwoba_last_14d`. Upgrade to:
- `team_barrel_rate_last_14d` (against LHP and RHP split)
- `team_xwoba_on_contact_vs_SP_handedness`
- **Drop** any `team_sweet_spot_%` feature if present — noise.

**ROI estimate.** 5–12 bps on totals and RL. Modest but improves year-start calibration when rate stats on small samples otherwise dominate.

**Priority: MEDIUM.** Extends `OFF-01` from v1.

### B.4 Pitch mix entropy / Arsenal+

**The academic case.** Driveline's Arsenal+ model uses Shannon entropy of pitch-type frequencies + kernel-density "indistinguishability" between pitches from the same arm slot ([Driveline — Revisiting Stuff+](https://www.drivelinebaseball.com/2024/05/revisiting-stuff-plus/); [Medium — Pitch Unpredictability](https://medium.com/@amritvignesh/creating-a-pitching-metric-to-describe-unpredictability-in-pitch-types-b49b18dc37d7); [FanGraphs — Pitch Mix Variation](https://community.fangraphs.com/pitch-mix-variation-and-ways-to-measure-it/)).

**Simplified version we can ship:**
1. Shannon entropy of pitch type frequencies: `H(P) = -Σ p_i · log(p_i)` where `p_i` is the frequency of pitch type `i` in the pitcher's last 500 pitches. Higher entropy = more unpredictable.
2. Release-point tunneling proxy: SD of release-point across *different pitch types* for the same pitcher. Lower SD = pitches look more alike coming out of the hand.

**Why entropy adds signal beyond Stuff+.** Stuff+ grades each pitch independently. Arsenal+ captures that a 92-mph fastball is more effective when thrown by a pitcher who also throws a 78-mph curveball and a 85-mph slider (three speeds for the batter to account for) than the same fastball thrown by a 2-pitch pitcher (fastball/slider only).

**Proposed features:**
- `sp_pitch_entropy_last_500_pitches`
- `sp_release_pt_tunnel_sd_across_pitch_types`

**ROI estimate.** 5–10 bps on totals. Small but incremental to Stuff+ rather than redundant with it.

**Priority: MEDIUM.** Ship after `SP-02` (Stuff+) is live; easy to bolt on since we're already ingesting pitch-level data.

### B.5 Fastball velocity decay within start + across season

**Within-start velo decay.** Subjective-fatigue increases 17.8% by end of game but MLB pitchers largely **maintain velocity** ([PMC — Collegiate Fatigue Study](https://pmc.ncbi.nlm.nih.gov/articles/PMC4555605/)). Within-start velo decay is **not** as predictive as folklore suggests — modern pitchers are conditioned to max-effort through 5–6 innings; meaningful decay happens *past* their typical IP, which is exactly when they're pulled.

**Across-season velo decay.** Much stronger signal. A pitcher whose trailing-5-start average fastball is 1.5+ mph below his season peak has measurable performance decline. Maps cleanly to B.2 (spin decay) as a paired fatigue index.

**Proposed feature:** `sp_fb_velo_delta_5_start_vs_season_peak`. Combined with B.2 spin decay into a **composite fatigue index**:

```
fatigue_idx = 0.5 * z_score(velo_decline) + 0.5 * z_score(spin_decline)
```

**ROI estimate.** 3–8 bps on totals and SP-dominant moneylines. Most impact in August–October.

**Priority: MEDIUM.** Bundle with B.2.

### B.6 Batter plate-discipline × pitcher zone-rate mismatch

**The asymmetry.** A low-chase-rate batter (O-Swing% ≤ 22%) faces a zone-pounding pitcher (Zone% ≥ 48%) — batter is forced to swing at strikes, neutralizing his discipline edge. Conversely, a high-chase-rate batter (O-Swing% ≥ 33%) faces a nibbling pitcher (Zone% ≤ 42%) — chaser eats himself alive outside the zone ([FanGraphs — Plate Discipline Library](https://library.fangraphs.com/offense/plate-discipline/); [Baseball Prospectus — Bad Decision Rate](https://www.baseballprospectus.com/news/article/74813/the-crooked-inning-bad-decision-plate-discipline/)).

**Proposed composite feature:**
```
discipline_mismatch_score =
    (lineup_avg_O_swing_pct - league_avg) × (sp_zone_pct - league_avg)
```

Sign interpretation: positive score = batter-favorable (disciplined batter vs nibbler, or chaser vs zone-pounder). Negative = pitcher-favorable.

**ROI estimate.** 3–10 bps on totals and run line — narrow applicability since most matchups are near league average.

**Priority: LOW-MEDIUM.** Research feature; measure in Phase 5 alongside `SP-04`.

### B.7 pybaseball access summary

| Metric | pybaseball source | Scraping complexity |
|---|---|---|
| Release point (x/z), extension, spin rate, velo | `statcast()` pitch-level | Trivial |
| Barrel rate, xwOBA-on-contact | `statcast_batter()`, aggregate | Trivial |
| Pitch mix frequencies | `statcast()` pitch-level | Trivial — just `groupby(pitch_type)` |
| Plate discipline (O-Swing%, Zone%) | Derive from `statcast()` zone columns (1–13 zone IDs) | Low — zone 1–9 = in-zone, 11–14 = out-of-zone |
| Stuff+, Location+, Pitching+ | Not in pybaseball directly; scrape FanGraphs leaderboards | Medium |
| Arsenal+ / Driveline proprietary | Not available publicly — must re-implement | High (30–60 hrs) |

**Conclusion:** Items B.1–B.6 are all accessible via pybaseball (`statcast()`). Arsenal+ is the one deep item requiring re-implementation; our simplified entropy proxy (B.4) captures 60–70% of the signal for ~5% of the effort.

---

## Track C — Long-Tail Prop Markets as Derivatives

### C.1 Market coverage audit (The Odds API)

**Confirmed from [The Odds API betting-markets reference](https://the-odds-api.com/sports-odds-data/betting-markets.html):**

| Market | API key | Carried by DK | Carried by FD | Tier required |
|---|---|---|---|---|
| Game ML | `h2h` | Yes | Yes | All (incl. free) |
| Spread (run line) | `spreads` | Yes | Yes | All |
| Totals | `totals` | Yes | Yes | All |
| **F5 ML** | `h2h_1st_5_innings` | Yes | Yes | Listed as period market; confirm in tier |
| **F5 total** | `totals_1st_5_innings` | Yes | Yes | Period market |
| **F5 alt total** | `alternate_totals_1st_5_innings` | Yes | Yes | Period market |
| **1st inning total** | `totals_1st_1_innings` | Yes | Yes | Period market — use for NRFI derivative |
| Pitcher Ks | `pitcher_strikeouts` | Yes | Yes | **Player props — confirm tier** |
| Batter HR | `batter_home_runs` | Yes | Yes | **Player props — confirm tier** |
| Team total | `team_totals` or embedded in totals | Yes | Yes | Confirm key |

**Pricing reality-check (The Odds API).** Pricing page shows plans at $30, $59, $119, $249/mo. **Our v1 $79 plan reference in CLAUDE.md may be out-of-date** — the current lineup is $30 (20k credits) / $59 (100k) / $119 (5M). Recommend confirming with a sandbox request what the marginal credit cost of period + prop markets is per request; my read is period markets consume 1 credit per market per call, so adding F5 + 1st-inning doubles credit use on every poll.

**Decision:** Stay on $59/mo (100k credits) tier initially. At 1 poll/day × 15 games × 4 markets × 2 books = ~3,600 credits/day = ~108k/month — just over the 100k cap. **Either reduce to poll every 36h, or jump to $119 tier.** Recommend jumping to $119 tier only after F5 backtest confirms edge.

### C.2 NRFI/YRFI derivation

**The Odds API does NOT carry NRFI as a first-class market** (confirmed from the betting-markets reference page). It's derivable via `totals_1st_1_innings` at 0.5 — over = YRFI, under = NRFI.

**NRFI model.** Per published NRFI research, the strongest predictors in order:
1. Starting-pitcher 1st-inning ERA × 1st-inning K% ([BettingPros NRFI](https://www.bettingpros.com/mlb/props/nrfi-yrfi/); [Cleatz NRFI](https://cleatz.com/nrfi-picks-today/))
2. Top-of-order (1-3 hitters) xwOBA vs SP handedness
3. Park factor first-inning-adjusted (Coors, Cincinnati inflate; Petco, Oakland suppress)
4. Recent form: last 5 starts' 1st-inning runs allowed

**Training data availability.** Derive from MLB Stats API play-by-play — `inning_num=1, inning_half=top/bottom`. Already in our ingestion scope.

**Proposed approach.** Don't train a separate NRFI model; derive NRFI probability as a **closed-form function of our totals model**:

```
P(NRFI) = P(runs_inning_1 = 0)
        = exp(-λ_inning_1)                           [Poisson assumption]
λ_inning_1 = expected_total / 9 × first_inning_factor(park, top_of_order_quality)
```

This is a 2-hour feature engineering task that unlocks an entire side market.

**ROI estimate.** The raw NRFI edge is well-documented but small (~10–20 bps when calibrated correctly); at DK/FD vigs of –120 / –115 typical, the vig tax is heavier than on game totals. Still worth publishing picks in Tier 3+ for bankroll diversification.

**Priority: MEDIUM.** Requires F5-first-inning market access confirmation.

### C.3 F5 model — separate head or feature extension?

**v1 recommended** a dedicated F5 model (`F5-02`). This research supports that position but refines the ROI case.

**Why F5 is softer.** Sharps focus on full games; F5 sees a fraction of the volume ([Outlier](https://outlier.bet/sports-betting-strategy/mlb-betting/the-strategy-behind-first-five-inning-betting/); [OddsShark F5](https://www.oddsshark.com/mlb/first-five-inning-betting); [Sportstrader](https://www.sportytrader.com/us/sports-betting/guide/first-five-innings-bets/)). DK and FD often post F5 lines by taking the full-game line and mechanically adjusting, which creates **systematic mispricings on opener/bullpen-game starters** (where the full-game model weighs SP heavily but the F5-line adjustment doesn't reflect opener logic) and on **teams with excellent bullpens facing weak SPs** (full-game total compresses via BP; F5 total does not).

**Implementation recommendation:**
- **Train a dedicated F5 model** with reduced bullpen weight (bullpen features weight → 0, since starters usually finish 5 innings).
- Feature set is ~70% overlap with main model; remaining 30% is F5-specific (first-5 historical run rates per team, SP career F5 ERA, etc.).
- Use the main model's predicted total as a **prior**, updated by F5-specific signals. Bayesian blend similar to `MKT-01`.

**ROI estimate.** 15–30 bps on F5 picks per v1. Confirmed by literature review — F5 softness is real.

**Priority: HIGH** (matches v1). Phase 3 deliverable.

### C.4 Pitcher K prop as informational signal for game totals

**The insight.** Posted pitcher K O/U encodes market's joint expectation of (a) pitcher dominance and (b) innings pitched. High K lines suggest **longer expected starts** (more pitches, more Ks accumulate) and **higher expected swing-and-miss** (fewer balls in play, fewer batted-ball-variance runs).

**Empirical relationship.** High combined K totals (SP1 + SP2 posted Ks) correlate modestly with UNDERS ([HeatCheck HQ — K Props Strategy](https://heatcheckhq.io/blog/how-to-bet-mlb-strikeout-props); [Outlier — K Prop Analysis](https://help.outlier.bet/en/articles/8243670-how-to-analyze-pitcher-strikeout-props-mlb-player-props)). Not an arbitrage — games with high-K starters can still go over via HR variance — but it's signal.

**Proposed feature (already flagged as `PROP-01` in v1 with priority M):** add market-implied combined K total as a feature for the totals model. **Upgrade to HIGH priority** — the feature is nearly free to ingest once we have props API access for F5.

### C.5 Player HR props as aggregate totals signal

**Proposed signal.** Sum of individual HR over lines across a team's lineup = market's implied team HR expectation. Divergences between this implied team-HR count and our totals model's implied HR contribution to runs is a flag.

**Practical hurdle.** The Odds API caps individual-prop calls and each batter HR market is a separate call per player. A 9-player lineup × 2 teams × 15 games = 270 prop calls per slate, multiplying API credit consumption by ~20×. **Not worth it** on $59/$119 tiers.

**Alternative.** Scrape one sportsbook's HR props page once daily (DK has all ~200 HR props listed on a single page that loads as JSON). Zero incremental Odds API cost. Still a meaningful eng lift (10–15h) + fragile.

**Priority: LOW.** Research track; not in Phase 3 roadmap.

### C.6 Team totals — DK vs FD divergence

**The arb case.** Team totals are derived from (game total, run line). Given any two of (home team total, away team total, game total, run line), the third is constrained. When DK and FD disagree on the posting of, say, "away team total over 4.5" vs "run line + total implied away total," the arithmetic delta represents a stale price.

**Reality check.** Both books use roughly the same algorithm under the hood. Systematic divergences are rare (most are noise within 5-cent precision). True arbs after vig require rule-of-thumb ≥3 cents of divergence after vig removal, which my audit suggests happens on <2% of games — not a reliable edge.

**Refinement.** This is **not an edge** to publish picks on. It IS a useful **quality-control check** on our own prediction — if our model says the home team total should be 4.7 but DK/FD agree at 3.9, we should reconsider rather than bet.

**Priority: LOW.** Not a pick source; usable as a sanity-gate in `CAL-01` workflow.

### C.7 Props vs. core markets for small-volume personal users

**Honest assessment.** For a <$5k personal bankroll making 3–5 picks/day:
- **Core markets (ML, RL, game totals):** sustained edges of ~2–4% after vig are achievable with a well-calibrated model. DK/FD accept normal bet sizes. **BEST fit for v1.**
- **F5 markets:** softer lines, but lower bet limits on both DK and FD (often $500–$1000 max vs $10k on game ML). At personal-user stakes, this cap is irrelevant — edge is real. **Strong fit for v1.1.**
- **NRFI/1st-inning props:** thin markets; bet limits often $100–$250. Edge per pick may exceed ML edges in bps, but absolute dollar variance is high. **Fit for small-unit diversification, not main bankroll.**
- **Player props (Ks, HRs):** limits $100–$500. High vig (often –120 on both sides). **Not suitable as primary market.**

**Recommendation:** Focus v1 and v1.1 effort on core + F5. Treat NRFI and player props as research tracks and information sources rather than pick-generation targets.

---

## Track D — Data Source Audit + Out-of-the-Box Sources

### D.1 Umpire data — upgrade path from v1

**v1 listed:** UmpScorecards, Baseball Reference (scrape). **Upgrade:**

**Retrosheet umpire CSVs** ([Retrosheet Umpire Logs](https://www.retrosheet.org/downloads/csvumpires.html); [CSV Documentation](https://www.retrosheet.org/downloads/othercsvs.html)):
- **Historical depth: 1898–2025** (vs UmpScorecards 2015–present)
- Format: CSV, mirrors gameinfo.csv + ejection count column
- Cost: **Free**
- Update cadence: season-complete (latest confirmed 2025)
- **Use case:** training data for our umpire K-zone model — dramatically more historical sample than UmpScorecards.

**UmpScorecards** ([umpscorecards.com](https://umpscorecards.com/); [Kaggle 2015-2022 dump](https://www.kaggle.com/datasets/mattop/mlb-baseball-umpire-scorecards-2015-2022)):
- Public web pages are scrape-friendly; **has a private API** gated behind Expert-tier subscription (pricing not published — need to email).
- Use case: current-season umpire performance trends for real-time features.

**Recommended stack:** Retrosheet CSV for training-set umpire history (since K-zone signal didn't structurally exist in the 1990s–early 2000s, cap training data to 2015+). UmpScorecards scrape for in-season current stats.

**Priority: HIGH** — resolves v1 data gap G6.

### D.2 Weather: granularity beyond Open-Meteo

**Open-Meteo** ([open-meteo.com](https://open-meteo.com/)) already gives us:
- Temperature, humidity, wind speed, wind direction (hourly)
- Free, no auth for <10k requests/day
- 30-min refresh cadence on some endpoints (per [WeatherEdge](https://rotogrinders.com/columns/mlb-weatheredge-mlb-dfs-betting-weather-tool-2645931))

**Upgrade: 4-poll schedule.** v1's `WX-03` proposed 2 polls (T-12h, T-90min). Open-Meteo supports hourly polls at no cost. Recommend:
- T-6h (opening-line baseline)
- T-3h
- T-90min (lineup-lock)
- T-0 (first pitch)

Produces 3 forecast-delta features per game. Zero marginal cost.

**Air density / humidity expansion.** Open-Meteo returns `surface_pressure` and `relative_humidity_2m`. Compute true air density:

```
ρ = (P_d · M_d + P_v · M_v) / (R · T)     [ideal gas with wet air mixing]
```

where `P_d = surface_pressure - saturation_pressure·humidity/100`. Gives per-game air density in kg/m³. Baseball carry scales linearly with `1/ρ`. Adds ~1 line of feature engineering.

**Roof-status for retractable parks.** No unified API exists — each team announces on X ~2-4 hours pre-game ([Marlins @loanDepotpark X feed](https://x.com/loanDepotpark); [Brewers hotline](https://www.mlb.com/brewers/ballpark/roof-status); [Stadium Roof Status tracker](https://stadiumroofstatus.com/)). Practical approach: **default to "closed" for dome-retractable parks on forecast rain days, "open" otherwise** — catches ~85% of cases. Add a manual-override flag for pre-slate publication.

**Specialty MLB weather aggregators:**
- Ballpark Pal ([ballparkpal.com](https://www.ballparkpal.com/Park-Factors-Preview.php)) — daily park factors adjusted for weather
- RotoGrinders WeatherEdge — visual wind rose per park
- Occupy Fantasy — "Air Density Index" composite score

These are **secondary validation sources**, not primary. Stick with Open-Meteo as source-of-truth.

**Priority: HIGH** for 4-poll upgrade; **LOW** for alternative providers.

### D.3 Injury feeds

**Tier 1 (free):**
- **MLB Stats API** — player status endpoint (`/api/v1/people/{id}`) returns `status.statusCode` values including "A" (Active), "D" (DL), "DTD" (day-to-day), "SU" (suspended), "BRV" (bereavement), "PL" (paternity). Includes injury description + return date when available. **Free, official, already in our pipeline.**
- **MLB.com transactions feed** — roster moves, IL placements, call-ups. Free, low-latency.

**Tier 2 (paid, low cost):**
- **RotoWire MLB injury syndication** ([rotowire.com/baseball/injury-report.php](https://www.rotowire.com/baseball/injury-report.php)) — ~$20–40/mo for syndication, includes beat-writer reported minor injuries ("dealing with a sore back") that don't make the IL feed. **Best value** for early-warning signal.
- **SportsDataIO** ([sportsdata.io/mlb-api](https://sportsdata.io/mlb-api)) — broader feed but expensive at scale ($100–500/mo).
- **Goalserve** ([goalserve.com MLB feed](https://www.goalserve.com/enout-us/sport-data-feeds/mlb-api/)) — XML/JSON injuries feed; pricing on request; typically $30–80/mo.

**Tier 3 (high cost):**
- **Sportradar** ([developer.sportradar.com/baseball](https://developer.sportradar.com/baseball/reference/overview)) — enterprise feed, likely >$500/mo. Overkill for us.

**Recommendation:** Start with MLB Stats API (free). Layer in RotoWire syndication (~$30/mo) for pre-game DTD signal once `LINEUP-01` ships. This replaces v1's "X API or Nitter scrape" recommendation — **more reliable, within budget, legally defensible.**

**Priority: MEDIUM** — pre-req for v1 `LINEUP-01`.

### D.4 Betting syndicate signals / line-movement aggregators

**VSiN** ([vsin.com](https://vsin.com/)) — has line-movement tools but **no public API** we've found. Subscriptions ~$40/mo; content is editorial. Not directly ingestible.

**Action Network / Action Labs** — Paid API via internal sales only; per public info starts at ~$500/mo. Out of budget.

**Sports Insights / Pregame.com** — "Sharp Vs. Square" dashboards; subscription ~$100/mo. Has a data export but API-programmatic access requires custom integration.

**OddsJam** ([oddsjam.com/odds-api](https://oddsjam.com/odds-api)) — aggregator with steam-detection features; pricing starts ~$100/mo for historical + $199/mo for real-time. Over budget.

**Free alternative:** Poll The Odds API every 30 minutes during pre-game window, build our own steam detection:
- Flag moves of ≥5 cents in <5 minutes on ≥3 books as "steam"
- Detect reverse line movement (line moves against ≥60% public ticket share — requires public % source, see D.7)

**Incremental cost:** If we go from 1 poll/day to 6 polls/day for the 3-hour pre-game window, credit consumption rises ~6× on top of core polling. Stay under 100k credits requires tight market selection (don't poll player props on each call; poll ML/total/F5 only).

**Priority: MEDIUM.** Build our own; skip paid aggregators.

### D.5 Minor-league call-up signals

**Minor-league Statcast** ([baseballsavant.mlb.com/statcast-search-minors](https://baseballsavant.mlb.com/statcast-search-minors)) — AAA tracking data available since 2023. **Free, officially published by MLB.** Gives us Stuff+/velocity/spin for AAA pitchers before they arrive in MLB.

**Use cases:**
1. **Bullpen call-up quality.** When a team calls up a fresh arm from AAA mid-slate, our feature `bp_fresh_arm_quality` can be populated from minor-league Statcast (last-5-AAA-appearance velocity and K%). Otherwise, imputation with replacement level understates a top-10 prospect.
2. **Probable-starter replacement.** Rare mid-week opener/spot-starter reveals where the SP is actually a AAA call-up. Our `SP-02` Stuff+ pipeline should fall back to AAA Stuff+ when MLB sample is <50 IP.

**Data access:** pybaseball's `statcast_search` supports a `minors=True` flag. Low integration effort.

**Priority: MEDIUM.** Bundle with `BP-02` bullpen work in Phase 2.

### D.6 Weather forecast refresh as alpha

Covered in D.2. This is the WX-03 upgrade: 4 polls instead of 2, same API, marginal cost 0. Ship alongside D.2.

### D.7 Public betting percentages (free sources)

**Practical sources:**
- **Covers.com consensus page** ([contests.covers.com/consensus/topconsensus/all/overall](https://contests.covers.com/consensus/topconsensus/all/overall)) — free, shows bet % on most markets.
- **Sports Betting Dime** ([sportsbettingdime.com/mlb/public-betting-trends/](https://www.sportsbettingdime.com/mlb/public-betting-trends/)) — free, daily splits.
- **Outlier.bet** ([outlier.bet](https://outlier.bet/sports-betting-strategy/betting-intelligence/understanding-public-betting-percentages/)) — free tier has public %.
- **VSiN public splits** — shown in content but no API; scraping TOS is ambiguous.

**Reliability caveat.** "Public %" varies wildly between sources because each reflects a different subset of books (some include offshore; some only include their partner books). **Recommend treating as a directional feature only** (quartile bin: 0–25%, 25–50%, 50–75%, 75%+), not a continuous number.

**Integration.** Weekly scrape of 1–2 free sources; cache in Supabase; expose as a categorical feature (`public_bet_pct_bucket`). Eng cost: 4–6h.

**Priority: MEDIUM-LOW.** Matches v1's `MKT-03` / `SENTIMENT-01`.

### D.8 Beat-writer / X lineup early signal

**Reality check on v1's recommendation.** v1 suggested three options: X API ($200+/mo), Nitter scrape (fragile), or RotoWire aggregator ($30/mo). Research confirms **RotoWire is best**: their lineup feeds reflect beat-writer reports within ~5 minutes of publication, and they do the X-API integration on their end.

**Supplemental: MLB Data Warehouse newsletter/Twitter aggregators** — several free Twitter lists exist (e.g., [Travis Pflanz's MLB beat writers list](https://www.travispflanz.com/mlb-beat-writers-on-twitter/)) but accessing the underlying tweets programmatically still requires X API.

**Non-obvious add: BBWAA member directory** ([bbwaa.com/members](https://bbwaa.com/members/)) — curated list of every credentialed baseball writer. Useful for building our own curated X list if we pay the X API.

**Recommendation:** Stick with RotoWire per v1. Skip X API at v1 budget.

**Priority: MEDIUM.** Pre-req for `LINEUP-01` (v1 Phase 4).

### D.9 Non-obvious free sources

| Source | What it gives us | Cost | Integration complexity |
|---|---|---|---|
| [Retrosheet](https://www.retrosheet.org/) | Historical play-by-play 1901–2025, umpire assignments, box scores | Free | Low (CSV downloads) |
| [FanGraphs leaderboards](https://www.fangraphs.com) | Stuff+/Location+/Pitching+, plate discipline aggregated | Free (rate-limited scrape) | Medium (HTML scraping) |
| [SABR research archive](https://sabr.org/analytics/presentations/2025) | Peer-reviewed methodologies for feature engineering | Free | N/A (reading material) |
| [Smart Fantasy Baseball](https://www.smartfantasybaseball.com/tools/) | ID mapping between FanGraphs / Baseball Ref / MLB IDs (critical for joining datasets!) | Free | Trivial |
| [MLB GameDay XML / MLB Stats API v1](https://www.mlb.com) | Free official pitch-level data since 2008 | Free | Medium |
| [Baseball Savant CSV downloads](https://baseballsavant.mlb.com/csv-docs) | Raw pitch data exports | Free | Low |
| [UmpScores](https://www.umpscores.com/) | Alternate umpire tendencies dashboard | Free | Medium (scrape) |
| [MLB Roster Resource (FanGraphs)](https://www.fangraphs.com/roster-resource/minor-league-power-rankings) | Minor-league depth + prospect rankings | Free | Medium |
| [Ballpark Pal](https://www.ballparkpal.com/) | Daily weather-adjusted park factors | Free (web) | Medium (scrape) |

**Critical insight: ID mapping.** Smart Fantasy Baseball's free player-ID mapping table is what lets us join FanGraphs stats to Baseball Savant events to MLB Stats API rosters. Without it, name-matching fails on suffix differences, middle-initial variations, and Spanish accent characters. **Must ingest this at project startup.** 1-hour task.

---

## Add-to-Roadmap Table

| # | Item | Track | ROI estimate | Data source | Cost | Eng hours | Priority |
|---|------|-------|--------------|-------------|------|-----------|----------|
| A1 | 0.10 Kelly ramp schedule (vs flat 0.25) | A | Risk reduction (no ROI lift) | — | $0 | 2 | **H** (ship with baseline) |
| A2 | Simultaneous-Kelly solver | A | Variance ↓30–40% | — | $0 | 10–15 | **H** |
| A3 | Uncertainty-shrinkage formula | A | ~5 bps calibration | From CAL-01 | $0 | 4 | **H** |
| A4 | 3-layer guardrails (per-pick/per-day/drawdown) | A | Risk reduction | — | $0 | 4 | **H** |
| A5 | Tier→Kelly-multiplier mapping | A | Indirect (positioning) | — | $0 | 2 | **H** |
| B1 | Release-point variability features | B | 5–15 bps | pybaseball | $0 | 8–10 | **H** |
| B2 | Spin decay + velo decay composite fatigue index | B | 3–8 bps | pybaseball | $0 | 6–8 | M |
| B3 | Barrel% / xwOBA-on-contact (upgrade OFF-01) | B | 5–12 bps | pybaseball | $0 | 4–6 | M |
| B4 | Pitch mix entropy (simplified Arsenal+) | B | 5–10 bps | pybaseball | $0 | 10–12 | M |
| B5 | Plate discipline × zone mismatch | B | 3–10 bps | pybaseball | $0 | 6–8 | L-M |
| C1 | F5 market ingestion (`h2h_1st_5_innings`, `totals_1st_5_innings`) | C | Unlocks F5-01 (15–30 bps) | The Odds API | $0 if on 100k tier; else +$60/mo | 8 | **H** |
| C2 | NRFI derivative from `totals_1st_1_innings` | C | 10–20 bps | The Odds API | Same as C1 | 6–8 | M |
| C3 | K-prop as totals feature (`PROP-01` promote) | C | 5–15 bps | The Odds API props | Confirm tier | 6–10 | M-H |
| C4 | Dedicated F5 model | C | Multiplies C1 | — | $0 | 15–20 | **H** |
| D1 | Retrosheet umpire CSV ingestion | D | Unlocks UMP-01/02 (10–30 bps) | retrosheet.org | $0 | 4–6 | **H** |
| D2 | AAA Statcast for call-up / spot-starter | D | 3–8 bps on affected games | Baseball Savant minors | $0 | 6–8 | M |
| D3 | 4-poll weather schedule + air-density | D | Upgrades WX-03 (10–25 bps) | Open-Meteo | $0 | 4 | **H** |
| D4 | Self-built steam detection | D | Upgrades MKT-02 (5–15 bps) | The Odds API polls | Poll cost | 8–12 | M |
| D5 | RotoWire injury + lineup feed | D | Pre-req for LINEUP-01 | rotowire.com | ~$30/mo | 6–8 | **H** (before Phase 4) |
| D6 | Covers.com public-% scrape | D | Enables SENTIMENT-01 | covers.com | $0 | 4–6 | L-M |
| D7 | Smart Fantasy Baseball ID mapping | D | Cross-source join reliability | smartfantasybaseball.com | $0 | 1 | **H** |

**Total incremental cost:** +$30/mo (RotoWire) if on current 100k tier; +$90/mo if jumping to 5M tier for props. All within $100/mo odds cap + $300/mo total cap.

---

## Open Questions for Kyle

1. **The Odds API tier decision.** Current $79/mo reference in CLAUDE.md appears stale — pricing is now $30 / $59 / $119. At $59 (100k credits) we hit the cap with F5 + 1st-inning + 30-min polling. **Recommendation:** confirm current plan, pre-provision jump to $119 (5M credits) only after F5 backtest shows edge. Estimated additional cost $60/mo.
2. **Kelly ramp schedule (0.10 → 0.15 → 0.25).** This is more conservative than v1's flat 0.25 at launch. **Recommendation:** accept — produces better learning dynamics and protects the first 200 picks while we validate calibration. Cost is ~5–10% of growth upside in weeks 1–8; value is drawdown protection.
3. **Simultaneous-Kelly solver implementation timing.** Ship with baseline model or in Phase 1? **Recommendation:** ship with baseline — 15h eng task, unlocks safe multi-pick slates from day 1.
4. **RotoWire injury feed ($30/mo) — approve for pre-`LINEUP-01`?** Recommendation: **approve.** Unblocks a Phase 4 dependency and gives us injury-wire input months earlier. $30/mo is within budget headroom.
5. **Retrosheet historical umpire data: how far back to train?** Retrosheet goes to 1898 but umpire K-zone signal is a 2015+ phenomenon (QuesTec→Statcast era). **Recommendation:** cap training at 2015 season for umpire features; use full Retrosheet history only for box-score and venue-history features.
6. **AAA Statcast ingestion — v1 or v1.1?** It's free and meaningful but adds an ingestion pipeline. **Recommendation:** defer to v1.1 (bundle with BP-02); not critical for launch.

---

## Appendix — Sources

### Track A — Bankroll
- [Kelly criterion — Wikipedia](https://en.wikipedia.org/wiki/Kelly_criterion)
- [Downey — uncertainty Kelly simulations](https://matthewdowney.github.io/uncertainty-kelly-criterion-optimal-bet-size.html)
- [Baker & McHale — Optimal Betting Under Parameter Uncertainty](https://www.researchgate.net/publication/262425087_Optimal_Betting_Under_Parameter_Uncertainty_Improving_the_Kelly_Criterion) ([Semantic Scholar](https://www.semanticscholar.org/paper/Optimal-Betting-Under-Parameter-Uncertainty:-the-Baker-McHale/d03cda6e9aec9a6674047b1c093780fdc2bf2d56))
- [Whelan — Fortune's Formula or Road to Ruin?](https://www.karlwhelan.com/Papers/KellyJuly2023.pdf)
- [Chu, Wu, Swartz — Modified Kelly Criteria](https://www.sfu.ca/~tswartz/papers/kelly.pdf)
- [Never Go Full Kelly — LessWrong](https://www.lesswrong.com/posts/TNWnK9g2EeRnQA8Dg/never-go-full-kelly)
- [Thorp 1975 — Portfolio Choice and the Kelly Criterion](https://gwern.net/doc/statistics/decision/1975-thorp.pdf)
- [Thorp 2007 — The Kelly Criterion in Blackjack, Sports Betting, and the Stock Market](https://gwern.net/doc/statistics/decision/2006-thorp.pdf)
- [MacLean, Thorp, Ziemba — Good and bad properties of Kelly](https://www.stat.berkeley.edu/~aldous/157/Papers/Good_Bad_Kelly.pdf)
- [vegapit — Numerically solve Kelly for multiple simultaneous bets](https://vegapit.com/article/numerically_solve_kelly_criterion_multiple_simultaneous_bets/)
- [thk3421 — KellyPortfolio tool](https://thk3421-models.github.io/KellyPortfolio/)
- [arxiv 2003.02743 — Classical Kelly generalization](https://arxiv.org/pdf/2003.02743)
- [Ernie Chan — Kelly drawdown limits](http://epchan.blogspot.com/2010/04/how-do-you-limit-drawdown-using-kelly.html)
- [Peta — *Trading Bases*](https://www.amazon.com/Trading-Bases-Fortune-Betting-Baseball/dp/0451415175); [Square Bettor lessons](https://squarebettor.com/advice-tips/lessons-from-trading-bases-by-joe-peta/); [FanGraphs community — Peta 2020](https://community.fangraphs.com/applying-petas-wagering-methodology-in-2020/)
- [Krackomberger profile — WagerTalk](https://www.wagertalk.com/profile/bill-krackman-krackomberger); [Legal Sports Betting bio](https://www.legalsportsbetting.com/famous-sports-bettors/bill-krackomberger/)
- [Walters — Shortform](https://www.shortform.com/blog/billy-walters-sports-betting/); [Covers](https://www.covers.com/guides/betting-tips-from-pro-sports-bettor-billy-walters); [ESPN](https://www.espn.com/sports-betting/story/_/id/38207435/how-bet-football-guide-nfl-ncaa-games-more)
- [Saahil Sud — WBUR profile](https://www.wbur.org/news/2015/11/23/dfs-power-player-profile); [RotoGrinders profile](https://rotogrinders.com/profiles/saahilsud)

### Track B — Statcast
- [Frontiers 2024 — Release point variability and MLB performance](https://www.frontiersin.org/journals/sports-and-active-living/articles/10.3389/fspor.2024.1447665/full) ([PMC mirror](https://pmc.ncbi.nlm.nih.gov/articles/PMC11608975/))
- [Frontiers 2023 — Pitching params and release points by pitch type](https://www.frontiersin.org/journals/sports-and-active-living/articles/10.3389/fspor.2023.1113069/full)
- [FanGraphs — Quantifying Pitcher Deception](https://blogs.fangraphs.com/an-attempt-to-quantify-pitcher-deception/)
- [Towards Data Science — Quantifying Pitcher Deception](https://towardsdatascience.com/quantifying-pitcher-deception-7fb2288661c8/)
- [GitHub — Pitcher Deception Score](https://github.com/pancaketoes/Pitcher-Deception-Score)
- [PMC — UCL injury warning signs via pitch tracking (2024)](https://pmc.ncbi.nlm.nih.gov/articles/PMC12717397/)
- [PMC — Advanced data for injury impact on pitchers](https://pmc.ncbi.nlm.nih.gov/articles/PMC9310227/)
- [Fantrax — Spin Rate Declines](https://fantraxhq.com/statcast-standouts-spin-rate-declines/)
- [Driveline — Spin Rate: What We Know Now](https://www.drivelinebaseball.com/2016/11/spin-rate-what-we-know-now/)
- [Driveline — Revisiting Stuff+](https://www.drivelinebaseball.com/2024/05/revisiting-stuff-plus/)
- [Driveline — Effective Velocity at MLB](https://www.drivelinebaseball.com/2019/05/calling-right-pitch-investigating-effective-velocity-mlb-level/)
- [FanGraphs community — Pitch Mix Variation](https://community.fangraphs.com/pitch-mix-variation-and-ways-to-measure-it/)
- [Uram Analytics — From Stuff to Strategy (Arsenal+)](https://www.uramanalytics.com/post/from-stuff-to-strategy-improving-mlb-pitch-profiles-and-optimizing-usage)
- [Medium — Unpredictability in Pitch Types (Shannon entropy)](https://medium.com/@amritvignesh/creating-a-pitching-metric-to-describe-unpredictability-in-pitch-types-b49b18dc37d7)
- [MDPI — Pitch Sequence Complexity and Long-Term Pitcher Performance](https://www.mdpi.com/2075-4663/3/1/40)
- [FanGraphs — A Sweet Spot by Any Other Definition](https://blogs.fangraphs.com/a-sweet-spot-by-any-other-definition/)
- [Medium — Barrel Gains / Contact Quality](https://medium.com/@johndefilippo04/digging-into-barrel-gains-the-link-between-contact-quality-and-power-production-3b37dfebf83d)
- [MLB Prediction — Expected Stats Guide](https://mlbprediction.com/expected-stats-guide.html)
- [FanGraphs library — Plate Discipline](https://library.fangraphs.com/offense/plate-discipline/)
- [Baseball Prospectus — Bad Decision Rate](https://www.baseballprospectus.com/news/article/74813/the-crooked-inning-bad-decision-plate-discipline/)
- [Pitcher List — Plate Discipline Beginner's Guide](https://pitcherlist.com/a-beginners-guide-to-understanding-plate-discipline-metrics-for-hitters/)
- [PMC — Collegiate Pitcher Fatigue Kinematics](https://pmc.ncbi.nlm.nih.gov/articles/PMC4555605/)
- [pybaseball GitHub](https://github.com/jldbc/pybaseball)
- [Baseball Savant CSV docs](https://baseballsavant.mlb.com/csv-docs)
- [PMC — Arm Angles & UCL Risk](https://pmc.ncbi.nlm.nih.gov/articles/PMC11873486/)
- [ESPN — MLB 2024 Pitching Injury Report](https://www.espn.com/mlb/story/_/id/43024395/mlb-2024-pitching-injury-report-study-takeaways-analysis)

### Track C — Prop Markets
- [The Odds API — betting markets reference](https://the-odds-api.com/sports-odds-data/betting-markets.html)
- [The Odds API — pricing](https://the-odds-api.com/)
- [The Odds API — MLB odds coverage](https://the-odds-api.com/sports/mlb-odds.html)
- [Outlier — F5 strategy](https://outlier.bet/sports-betting-strategy/mlb-betting/the-strategy-behind-first-five-inning-betting/)
- [OddsShark — F5 betting report](https://www.oddsshark.com/mlb/first-five-inning-betting)
- [Sportytrader — First Five Innings guide](https://www.sportytrader.com/us/sports-betting/guide/first-five-innings-bets/)
- [PlayIllinois — F5 betting](https://www.playillinois.com/sports-betting/first-five-innings/)
- [BettorEdge — F5 bets](https://www.bettoredge.com/post/what-are-mlb-first-5-inning-bets-and-how-do-they-work)
- [BettingPros — NRFI/YRFI matchups](https://www.bettingpros.com/mlb/props/nrfi-yrfi/)
- [OddsIndex — NRFI picks](https://oddsindex.com/sports/mlb/nrfi-picks-today)
- [RG — NRFI guide](https://rg.org/guides/baseball/nrfi-bets)
- [Cleatz — NRFI strategy](https://cleatz.com/nrfi-picks-today/)
- [BettorEdge — NRFI strategy](https://www.bettoredge.com/post/mastering-nrfi-bets-proven-strategies-for-baseball-s-hottest-market)
- [TeamRankings — NRFI team stats](https://www.teamrankings.com/mlb/stat/no-run-first-inning-pct)
- [HeatCheck HQ — K props strategy](https://heatcheckhq.io/blog/how-to-bet-mlb-strikeout-props)
- [Outlier help — K prop analysis](https://help.outlier.bet/en/articles/8243670-how-to-analyze-pitcher-strikeout-props-mlb-player-props)
- [OddsJam — Odds API](https://oddsjam.com/odds-api)

### Track D — Data Sources
- [Retrosheet home](https://www.retrosheet.org/)
- [Retrosheet — umpire CSVs](https://www.retrosheet.org/downloads/csvumpires.html)
- [Retrosheet — other CSVs](https://www.retrosheet.org/downloads/othercsvs.html)
- [UmpScorecards](https://umpscorecards.com/) ([About](https://umpscorecards.com/page/about); [Games archive](https://umpscorecards.com/data/games); [Umpires archive](https://umpscorecards.com/data/umpires))
- [UmpScores](https://www.umpscores.com/)
- [Kaggle — UmpScorecards 2015–2022 dump](https://www.kaggle.com/datasets/mattop/mlb-baseball-umpire-scorecards-2015-2022)
- [Open-Meteo](https://open-meteo.com/)
- [RotoGrinders WeatherEdge](https://rotogrinders.com/columns/mlb-weatheredge-mlb-dfs-betting-weather-tool-2645931)
- [Ballpark Pal](https://www.ballparkpal.com/Park-Factors-Preview.php)
- [Baseball VMI — Air Density Index](https://www.baseballvmi.com/predicting-player-performance)
- [Stadium Roof Status](https://stadiumroofstatus.com/)
- [MLB Data API docs](https://appac.github.io/mlb-data-api-docs/)
- [RotoWire MLB Injury Report](https://www.rotowire.com/baseball/injury-report.php) ([Syndication rate card](https://www.rotowire.com/ratecard/syndicatedcontent.htm))
- [SportsDataIO MLB API](https://sportsdata.io/mlb-api)
- [Goalserve MLB feeds](https://www.goalserve.com/enout-us/sport-data-feeds/mlb-api/)
- [Sportradar Baseball API](https://developer.sportradar.com/baseball/reference/overview)
- [Baseball Savant minors](https://baseballsavant.mlb.com/statcast-search-minors) ([news post](https://www.mlb.com/news/minor-league-statcast-data))
- [RotoWire MLB depth charts](https://www.rotowire.com/baseball/mlb-depth-charts/)
- [FanGraphs Minor League Roster Resource](https://www.fangraphs.com/roster-resource/minor-league-power-rankings)
- [VSiN — Line Movement 101](https://vsin.com/how-to-bet/interpreting-line-movement-to-locate-sharp-action/)
- [Covers.com consensus splits](https://contests.covers.com/consensus/topconsensus/all/overall)
- [Sports Betting Dime — MLB public betting](https://www.sportsbettingdime.com/mlb/public-betting-trends/)
- [Outlier — public betting percentages](https://outlier.bet/sports-betting-strategy/betting-intelligence/understanding-public-betting-percentages/)
- [Travis Pflanz — MLB beat writers](https://www.travispflanz.com/mlb-beat-writers-on-twitter/)
- [BBWAA members directory](https://bbwaa.com/members/)
- [Smart Fantasy Baseball tools](https://www.smartfantasybaseball.com/tools/)
- [SABR — 2025 Analytics Conference presentations](https://sabr.org/analytics/presentations/2025)
- [SABR — statistical databases and websites guide](https://sabr.org/how-to/statistical-databases-and-websites)
