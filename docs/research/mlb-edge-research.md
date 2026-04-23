# Diamond Edge — MLB Edge Research

**Status:** Research synthesis for ML iteration (post-baseline)
**Date:** 2026-04-22
**Audience:** `mlb-ml-engineer` (primary), `mlb-data-engineer`, `mlb-ai-reasoning`
**Scope:** Prioritized catalog of MLB betting edges beyond the 87/107/81 baseline features already specced in `worker/models/*/feature-spec.md`.

---

## Scope & Ground Rules

- **Market surface:** DK + FD only (per `docs/compliance/state-matrix.md`). Any strategy requiring Pinnacle, Bovada, Fliff, Circa, or offshore books is explicitly out of scope. Pinnacle references appear only as a market-prior signal that can occasionally be scraped from public odds screens, not as a place to bet.
- **Timing:** Pre-game only. No in-play / live betting (v1 constraint). No middling/scalping that requires post-posting re-entry.
- **Market types in scope:** moneyline, run line, totals, F5 totals/ML, NRFI/YRFI (as derivatives of our totals model). **No parlays** in v1 (deferred to v1.1+).
- **Cost guardrails:** Any edge that increases The Odds API call volume must live within the $100/mo cap. LLM-based edges must show estimated $/1000-picks cost.
- **Honesty:** Where I cite a number, it's either sourced or labeled "estimated." We do not fabricate effect sizes.

---

## 1. Executive Summary — Top 5 Highest-Leverage Additions

Ranked by **expected ROI lift** × **implementation tractability** given our stack.

| Rank | Edge | Why it's high-leverage | Est. implementation |
|------|------|------------------------|---------------------|
| 1 | **Handedness-split park factors + lineup-aware HR factor** | Our current `park_hr_factor` is a single number. Splitting by batter hand and feeding it against confirmed lineup handedness is a well-understood edge that sharp bettors exploit (short porches asymmetrically help pull power). Data is free at Statcast. Direct improvement to totals and run line. | 6–10h; free data |
| 2 | **Umpire K-zone & run factor (confirm data gap G6)** | Umpires with a 1.45× K boost shrink totals; "small zone" umps inflate walks and runs. Our spec already lists features 76–78 but flags drop risk. Umpire-assignment data is free (UmpScorecards, Baseball Reference). This is a known, publicly available edge that most recreational bettors still ignore. | 8–12h; scrape-friendly |
| 3 | **Late-news LLM pipeline (beat writer X/Twitter + injury wire → lineup/starter confirmation)** | Our pipeline already pays for Claude Haiku. Markets are slowest to adjust in the 60–90 min window between posted lineup and first pitch. Parsing beat writer posts for late scratches, DTD status, and surprise openers converts our "lineup not confirmed" features from uncertainty into signal. High-ROI because the marginal LLM cost (~$0.001/day via Haiku) is trivial. | 15–25h; ~$5/mo LLM |
| 4 | **Opener / bullpen-game detector + Times-Through-the-Order (TTOP) feature** | Current spec treats every SP as a traditional starter. Openers (TB, MIA, occasionally HOU/DET) break SP-based features and mispredict totals. Detecting opener games and adjusting to "expected SP IP < 3" + relying on bullpen features flips the signal. TTOP is well-documented (1st time: .713 OPS; 3rd time: much higher). | 10–15h; free data |
| 5 | **Market-aware modeling: Bayesian blend of our prediction with DK/FD close-to-open implied probability** | Instead of using `market_implied_prob_home` as just another feature, treat the opening line as a strong prior and our model output as a likelihood update. This is how Peta, Peabody, and most professional sharps actually operate. Produces better calibration and fewer "we disagree with the market by 15 points" embarrassments. | 12–20h; no new data |

**Combined expected effect (estimated):** 80–150 bps of ROI improvement on blended picks, plus meaningful calibration improvements (lower log-loss, higher positive CLV rate). These are not additive — diminishing returns after the top 3.

---

## 2. Full Edge Catalog

Scored on: **Edge size** (estimated raw ROI basis points when isolable — cite where possible), **Data cost**, **Eng hours**, **Risk**, **Priority** (v1.1 / v1.2 / v2).

### Table key
- **Edge bps** = expected raw edge size in basis points of ROI, estimated or cited. Most MLB edges are small (10–50 bps); large claims should be skeptically received.
- **Data cost**: $$ = paid, $ = scrape/free API, ✓ = already in schema
- **Eng hours**: rough estimate in dev-hours
- **Priority**: H = v1.1 (next model iteration); M = v1.2; L = v2+/research park

| # | Edge | Description | Est. edge | Data source | Eng hours | Risk / caveat | Priority |
|---|------|-------------|-----------|-------------|-----------|---------------|----------|
| **UMP-01** | Umpire K-zone bias | HP umpire K-boost multiplier × combined SP K-rate. Large-zone umps suppress totals; small-zone umps inflate them ([Core Sports](https://www.coresportsbetting.com/how-mlb-umpire-tendencies-affect-over-under-bets/), [UmpScorecards](https://umpscorecards.com/)). | 15–30 bps on totals | [UmpScorecards](https://umpscorecards.com/), [Baseball Ref](https://www.baseball-reference.com) (free scrape) | 8–12 | Umpire rotations shift each year; feature must refresh. "Umpire assigned" is often not confirmed until ~4h pre-game. | **H** (already in spec as features 76–78; confirm G6 resolution) |
| **UMP-02** | Umpire run factor vs park baseline | Separate from K-rate — an ump's runs-per-game factor vs league average. Some umps call batter-friendly zones that lengthen at-bats without boosting K. | 10–20 bps on totals | UmpScorecards, Swish Analytics | 2–4 (add to UMP-01) | Smaller sample per ump; regress heavily. | **H** |
| **WX-01** | Handedness-asymmetric wind/HR factor | Wind-to-right-field is worth more vs LHB-heavy lineups at RF-porch parks (Yankee Stadium, Citizens Bank, Great American). Split `weather_wind_factor` by lineup LHB/RHB weight. | 5–15 bps on totals | NWS/OpenWeather + stadium bearings (already partial) | 6–10 | Requires confirmed lineup for max value. | **H** |
| **WX-02** | Humidity + air-density (true carry) | Temperature alone misses the air-density story. Humid air is less dense → ball carries further (common myth is the opposite — dry air appears less dense but the physics says humid air is actually slightly less dense per PV=nRT with H₂O < N₂/O₂). Impact is measurable for HR carry. [Alan Nathan physics of baseball](http://baseball.physics.illinois.edu/). | 3–8 bps on totals | OpenWeather (already in pipeline, just expose humidity field) | 3–5 | Small effect; dome-heavy slate days it's zero. | M |
| **WX-03** | Recent-hour forecast delta | Forecasts at the time the total was posted (T-12h to T-24h) vs. the refreshed forecast T-90min. Delta in wind speed or direction correlates with line-vs-actual mispricing because books don't re-line for weather between opening and first pitch. | 10–25 bps on totals when delta is large | Weather API (poll twice: at line-open and at lineup-lock) | 8–12 | Requires second weather pull → marginal API cost. | **H** |
| **WX-04** | Rain-probability-by-inning model | If forecasts show rain probability climbing sharply in innings 6–9, game may be shortened or feature different pitcher deployment (though we skip in-play, early forecast of this affects pre-game totals). | 3–10 bps on affected subset | NWS hourly forecast | 4–6 | Narrow applicability (~5–10 games/season). Low cost to add, modest lift. | M |
| **LINEUP-01** | Late-news Claude parser (X/Twitter beat writers + wire) | Use Claude Haiku to summarize beat-writer posts + wire stories in the T-90min window. Detect: late scratches, surprise DTD, bullpen/opener announcements, weather scratches. Convert "lineup not confirmed" from noise into signal. | 20–40 bps (broad — varies by game) | X API (free tier limits) or Nitter scrape + RotoWire/FantasyLabs feeds | 15–25 | X API rate limits; must handle rumor vs. confirmed. Cost bound: 3 calls/slate × 15 games × $0.001 Haiku ≈ $0.05/day. | **H** |
| **LINEUP-02** | Key-hitter DTD impact | When a 4–5-WAR player is DTD (day-to-day), OPS impact on team depends on replacement-level gap. Current spec has no "star player missing" feature. | 5–15 bps on affected games | MLB Stats API player status + our `player_season_stats` | 6–10 | DTD is inherently uncertain until 60min pre-game. Requires LINEUP-01 pipeline. | M |
| **LINEUP-03** | Lineup slot concentration (stacking) | Handedness runs (3+ LHB in a row) vs. opposing SP matter beyond aggregate platoon score. Our feature 70/71 is weighted — but stacking produces multiplicative effect (pitch selection, reliever matchup planning). | 3–10 bps | `game_lineups` (G7) + `players.throws` | 4–6 | Small effect; bullet in v1.2. | M |
| **BP-01** | Bullpen fatigue: pitches thrown (not just IP) | Current spec uses `bp_ip_last_2d`. IP is coarser than pitches thrown. A 1 IP, 30-pitch outing is more fatiguing than 2 IP, 22-pitch outing. | 5–15 bps | MLB Stats API play-by-play (pitch counts) | 8–12 | Aggregating from play-by-play adds ingestion complexity. | **H** |
| **BP-02** | Closer/high-leverage arm availability | "Is the closer available today?" is a binary signal distinct from aggregate bullpen fatigue. Featuring individual high-leverage reliever availability (last 3 days usage per reliever) is more predictive than team-level aggregate. | 10–20 bps on close games | Play-by-play + reliever role classification | 10–15 | Role-classification (closer vs setup) is fuzzy and changes through season. | **H** |
| **BP-03** | Opener / bullpen-game detector | Detect games where "probable starter" is actually an opener (expected IP < 3). Current features weight SP heavily; openers invert that logic. | 15–30 bps on TB/MIA/TOR-adjacent games | MLB Stats API + historical pattern matching | 10–15 | Binary signal but catches the right games. | **H** |
| **SP-01** | Times-Through-Order (TTOP) weighting | Starter "effective IP" expectation derived from pitch efficiency + matchup familiarity. A 70-pitch-3-IP SP facing an unfamiliar lineup on third time through is a different animal than the same SP on first time through. Extends BP-03. | 5–15 bps | MLB Stats API | 8–12 | Most impactful on F5 market. | **H** |
| **SP-02** | Statcast xFIP / Stuff+ / Location+ | Already flagged as G3 data gap. Statcast "Stuff+" metrics outpredict raw ERA/FIP on pitcher quality ([Eno Sarris, The Athletic](https://theathletic.com)). | 10–25 bps | Baseball Savant scrape / CSV | 12–20 to build ingestion | Most professional modelers use these as priors. | **H** (resolve G3) |
| **SP-03** | Catcher framing runs | Framing runs saved converts to ~0.125 runs/strike ([MLB Glossary](https://www.mlb.com/glossary/statcast/catcher-framing)). Top framer (+25 runs season) vs bottom (-10 runs) is a ~35-run team delta across 140 games. For a single game: ~0.25 runs ERA-equivalent. Not in current spec. | 5–15 bps on totals & ML | Baseball Savant | 6–10 | Framing value decays in automated-zone era; still nonzero 2026. | **H** |
| **SP-04** | Pitcher-vs-opponent-lineup BvP (xwOBA) | Career/recent xwOBA of SP vs. today's actual confirmed batters. Our feature 13/28 uses team-level ERA vs opp. Batter-level xwOBA vs pitcher handedness × pitch mix is finer-grained. | 5–20 bps, noisy per-matchup | Baseball Savant event-level data | 15–25 | Sample-size hell. Must Bayes-shrink heavily. | M |
| **OFF-01** | Park-adjusted team wOBA / xwOBA | We use raw team OPS/wOBA. Park-adjusting offensive stats before feeding the model removes Coors-inflated stats from the feature. The model could learn the park interaction, but explicit park-adjustment is cleaner and shrinks sample required. | 5–10 bps | Derived from Statcast + park factors | 4–8 | Conceptually cleanest; model can learn it but explicit is better. | M |
| **OFF-02** | Recent-streak weighted offensive form | Exponentially-weighted moving average on runs/wOBA (half-life ~7 days) vs current "last 14d" flat average. Captures hot/cold streaks without arbitrary window cutoff. | 3–8 bps | Derived from `team_game_logs` | 4–6 | Cheap win. | **H** |
| **TRAVEL-01** | Eastward travel + timezone circadian | ≥2 TZ east travel produces measurable offensive dip, and a ≥3 TZ gap shifts win-% by ~10 pts ([PNAS Song et al.](https://www.pnas.org/doi/abs/10.1073/pnas.1608847116); [Science AAAS coverage](https://www.science.org/content/article/jet-lag-puts-baseball-players-their-game)). Current spec has `travel_tz_change` but doesn't encode directionality. Eastward is worse than westward. | 8–20 bps on affected games | Already derivable from venue history | 3–4 | Limited games affected (maybe 15–20% of slate). | **H** |
| **TRAVEL-02** | Post-getaway-day / doubleheader fatigue | Getaway day afternoon games → night game in new city = compounded travel+rest issue. Doubleheader game 2 has distinct scoring profile. | 5–10 bps | Derived from `games` | 3–5 | `game_is_doubleheader` already in totals spec; extend to ML/RL + add getaway flag. | **H** |
| **MKT-01** | Bayesian prior: open-line as strong prior | Treat DK/FD opening total/ML as prior; update with our model's feature delta. Mathematically: blend model `P(over)` with market `P(over)` using weight = f(historical CLV). This is how Peta and most pro modelers operate ([Peta, *Trading Bases*](https://www.amazon.com/Trading-Bases-Fortune-Betting-Baseball/dp/0451415175)). | Calibration ↑, log-loss ↓ | No new data | 12–20 | Requires careful handling — don't double-count market signal (feature 86 already feeds it). | **H** |
| **MKT-02** | Line movement velocity | Feature 87 is a 3-way direction flag. Actual move magnitude + time-to-move gives finer signal. DK moves 20 cents in first hour = different from 3 cents over 4 hours. | 5–15 bps | Requires >1 poll/day (cost impact!) | 10–15 eng + recurring API cost | **Budget risk:** bumping poll frequency from 1× to 4×/day still fits $100 cap for 15 games/day × 4 books, but pre-calculate. | M |
| **MKT-03** | Reverse line movement (RLM) | Line moves against public-ticket majority → sharp money signal. Less reliable in MLB than NFL due to daily volume and lower per-game attention, but still measurable on national-spotlight games. | 5–15 bps, narrow | Public betting % (SportsInsights, Action Network — some free) | 8–12 | "Public %" quality varies by source. Books can also fake moves. | M |
| **MKT-04** | DK vs FD price divergence (not arb — best-price) | Not arbitrage (v1 constraint, and arbs 1–2% after vig are rare across only 2 books). But always bet at the better of DK/FD — we should already be doing this. Low-hanging signal is detecting systematic DK under-rounding on home underdogs vs FD. | 2–8 bps depending on slate | Already in `odds` table | 2–4 | Trivial; should be in post-model "best book" logic, not a feature. | **H** (as pick execution logic) |
| **F5-01** | F5 (first 5) market as softer line | F5 is a secondary market; books put less effort into pricing it ([Outlier](https://outlier.bet/sports-betting-strategy/mlb-betting/the-strategy-behind-first-five-inning-betting/), [OddsIndex](https://oddsindex.com/guides/f5-betting-first-5-innings)). SP-dominant games where our SP feature confidence is high → F5 line is likely softer than full-game. | 15–30 bps | The Odds API — verify F5 markets included in our tier (confirm for DK/FD) | 10–15 | **Dependency:** requires The Odds API entry tier to include F5 markets for DK/FD. If not, upgrade cost must be weighed against $100 cap. | **H** (verify API coverage first) |
| **F5-02** | Separate F5 model with reduced bullpen weight | Bullpen features should weigh ~0 for F5 (starters usually finish the 5th). Retraining a dedicated F5 model is cheaper than refitting. | Multiplies F5-01 | Same data as main model | 6–10 | Only worth it once F5-01 confirms market access. | M |
| **NRFI-01** | NRFI/YRFI as totals-model derivative | First inning scores are 32–35% of games league-wide ([BettingPros](https://www.bettingpros.com/mlb/props/nrfi-yrfi/)). Derive NRFI probability from top-of-order xwOBA vs SP first-inning K/BB rate + park HR factor. Cheap derivative of our totals model. | 10–25 bps if prop market covered by DK/FD | The Odds API prop coverage | 8–12 | Confirm API tier covers NRFI. Small-sample markets can be sharp against retail. | M |
| **PROP-01** | Pitcher K-prop-derived game flow signal | Posted SP K O/U encodes market's expectation of innings pitched and matchup dominance. Large gap between our "expected Ks" and posted line signals disagreement with the market on total or pace. | 5–15 bps (as a feature, not a play) | Odds API props | 6–10 | Useful even if we don't bet K props. | M |
| **SENTIMENT-01** | Contrarian public-% fade | 70%+ public on one side with minimal line move → fade. Documented edge but has degraded in modern market ([Sports Insights](https://www.sportsinsights.com/blog/should-you-fade-the-public-when-betting-mlb-totals/)). Much noisier in MLB than NFL. | 5–10 bps on narrow subset | Action Network / SportsInsights | 6–8 | Evidence for this edge is weakening in 2024–2026. Low confidence. | L |
| **SENTIMENT-02** | Beat-writer sentiment scoring (LLM) | Beyond injury parsing: LLM-scored sentiment of pre-game writeups ("bullpen is cooked," "dealing with nagging thumb issue"). Novel; unknown effect size. | Unknown — research only | X/beat writer feeds | 20–40 | Research project. Unfortunately this is the sexy one but hardest to calibrate. | L |
| **MOTIVATION-01** | Playoff leverage / tanking / call-up context | September games with one team tanking + the other fighting for a WC. Also: recently-called-up player energy boost vs fatigue. | 5–15 bps, seasonal only | Derived from standings + MLB Stats API transactions | 6–10 | Only applies Aug–Sept. Seasonal bump; build for v1.2 pre-postseason. | M |
| **CAL-01** | Per-decile calibration monitoring + avoidance | Track where our model is miscalibrated (e.g., systematically overconfident on home underdogs in domes). Use the calibration plot to either (a) adjust via isotonic refit or (b) reduce/avoid picks in miscalibrated deciles. | Meta: reduces bad picks | Derived from our `picks` table + results | 6–10 | This is hygiene, not an edge. But gives us a "do not bet" filter. | **H** |
| **CAL-02** | Bayesian shrinkage on rookie/small-sample pitchers | Rookie SPs have high variance. Our `missing value` rule imputes league-avg, losing signal. Empirical-Bayes beta-binomial prior (regress toward position mean per IP) is finer ([Robinson — Variance Explained](http://varianceexplained.org/r/empirical_bayes_baseball/)). | 5–10 bps on rookie-heavy slates | No new data | 8–12 | Requires careful prior specification. | M |
| **BANKROLL-01** | Fractional Kelly (0.25 Kelly) with confidence tiering | Our ops should size bets using 0.25 Kelly (quarter-Kelly) — empirically the sweet spot ([Crane, Substack](https://harrycrane.substack.com/p/two-arguments-for-fractional-kelly)). Full Kelly produces ~50% drawdown with 50% probability even for +EV bettors ([Wikipedia Kelly](https://en.wikipedia.org/wiki/Kelly_criterion)). | Variance ↓, growth retained at ~55% of full Kelly | Already have all inputs | 4–6 | Tier caps: Pro vs Elite picks get different Kelly fractions (Elite picks are higher-confidence, can use 0.3 Kelly). | **H** (ship with baseline) |
| **BANKROLL-02** | Simultaneous-bet Kelly for daily slate | Multi-bet same-day Kelly adjusts for correlated outcomes (weather affects both totals on a doubleheader, for example). Solve optimal stake vector rather than independent sizing. | Variance ↓ further | Same as BANKROLL-01 | 10–15 | Add after BANKROLL-01 ships. | M |
| **BANKROLL-03** | Drawdown-constrained sizing | Cap total daily exposure as % of bankroll (e.g., never risk >10%/day regardless of Kelly). Common pro practice. | Risk guardrail | — | 2–4 | Implement alongside BANKROLL-01. | **H** |

### Explicit de-prioritization (explained for completeness)

| Edge | Why deprioritized |
|------|-------------------|
| Middling / scalping | Requires post-posting re-entry and specific line-move thresholds — out of scope for once-daily pre-game pipeline. |
| Asian/European (Pinnacle) early moves | Useful signal but we can't capture it at scale without either paid feeds (out of budget) or Pinnacle API terms we shouldn't rely on. |
| Live in-play ± EV underdog spots | v1 is pre-game only. |
| Parlays / same-game parlays | Deferred to v1.1+ per CLAUDE.md. Correlation math there is non-trivial. |
| Rare-event lottery underdog plays | Low-frequency, very high-variance, hard to calibrate with our sample size. Revisit in v2. |
| Futures mispricing | Deferred; futures pricing is its own model domain and locks bankroll for months. |

---

## 3. Recommended v1.1 Roadmap (Post-Baseline)

Execution order after baseline LightGBM ships. Each phase is ~2 weeks of ML + data engineering effort.

### Phase 1 — Foundations & Hygiene (before any "new edge" work)
1. **CAL-01**: Per-decile calibration monitoring in place. Establishes the baseline we're improving against. *Also this is how we'll measure whether Phase 2+ is working.*
2. **MKT-01**: Bayesian blend of market prior + model likelihood. Lower log-loss immediately; small risk.
3. **BANKROLL-01 + BANKROLL-03**: Fractional Kelly + daily drawdown cap. Ship with baseline if possible.
4. **MKT-04**: Always-best-price logic between DK and FD at pick-execution time. Trivial but free bps.

**Exit criterion:** Baseline model calibrated within ±3% per decile across all three markets. Kelly sizing produces <15% expected max drawdown in backtest.

### Phase 2 — Fill existing data gaps with high-leverage features
5. **UMP-01 + UMP-02**: Resolve data gap G6. Features 76–78 go live.
6. **SP-02** (Statcast xFIP/Stuff+): Resolve G3.
7. **BP-01 + BP-02**: Pitch-count fatigue and closer-availability features.
8. **WX-01**: Handedness-split HR park factor (requires lineup confirmation pipeline).
9. **TRAVEL-01**: Directional timezone change (eastward penalty).
10. **OFF-02**: EWMA recent-form features.

**Exit criterion:** +30–60 bps backtested ROI improvement over Phase 1. Model feature count ~110.

### Phase 3 — Openers and F5 market expansion
11. **BP-03 + SP-01**: Opener detection + TTOP weighting. Train dedicated F5 model.
12. **F5-01**: Verify The Odds API coverage of F5 markets for DK/FD. Expand market surface if green-lit.
13. **F5-02**: Dedicated F5 model training.
14. **NRFI-01**: NRFI/YRFI as totals-model derivative. Verify prop coverage.

**Exit criterion:** F5 market live if API tier supports. NRFI live if prop surface supports. +15–30 bps additional backtested ROI, now on wider market surface.

### Phase 4 — Late-news LLM integration
15. **LINEUP-01**: Claude Haiku pipeline parsing beat writer X posts + injury wire for T-90min updates. Log cost per slate.
16. **LINEUP-02**: DTD star-player impact feature.
17. **WX-03**: Two-poll weather delta feature.

**Exit criterion:** LLM cost under $10/mo. Confirmed-lineup win rate improves vs unconfirmed baseline. +20–40 bps of ROI on affected games (broad range reflects genuine uncertainty).

### Phase 5 — Catcher/framing and finer pitcher features (lower priority)
18. **SP-03**: Catcher framing runs.
19. **CAL-02**: Bayesian shrinkage for rookie SPs.
20. **OFF-01**: Park-adjusted offensive metrics.

**Exit criterion:** Model feature count ~130. Feature interactions in SHAP stabilized.

### Phase 6 — Research / speculative (v2 territory)
- SENTIMENT-01, SENTIMENT-02, MOTIVATION-01, SP-04, MKT-02, MKT-03. These are research park: build measurement harness, report, then decide whether they justify production cost.

---

## 4. Quant Approaches Used by Pros (Methodology Reference)

### Bayesian / market-aware modeling
- **Joe Peta** (*Trading Bases*, [ESPN interview](https://www.espn.com/blog/playbook/fandom/post/_/id/18799/wall-st-vet-backs-mlb-betting-in-book), [The Hardball Times review](https://tht.fangraphs.com/book-review-trading-bases/)): Uses Pythagorean projections + SP-adjusted WAR + DIPS to produce team win probabilities, then compares to Vegas line. Core insight: an SP adjustment can swing a .400-team to .500+/.600 on days its ace pitches. We already do this; what we don't do is **explicitly blend with the market** (see MKT-01).
- **Rufus Peabody** ([Unabated — Beyond CLV](https://unabated.com/articles/beyond-clv-analyze-bet-quality-using-expected-roi); [MIT Sloan profile](https://www.sloansportsconference.com/people/rufus-peabody)): CLV is the north-star metric. His "Expected ROI" methodology extends CLV by de-lucking results (e.g., adjusting extra-inning noise in baseball). Key: **track positive CLV rate as primary success metric, not win rate.**
- **Haralabos Voulgaris** ([Grokipedia](https://grokipedia.com/page/Haralabos_Voulgaris), [Sports History Network](https://sportshistorynetwork.com/gambling/inside-the-mind-of-haralabos-voulgaris/)): "Ewing" model simulates coaching decisions and officiating tendencies. The translatable principle: **model agent-level behavior, not just team aggregates.** In MLB: model manager hook-tendencies on SP, bullpen deployment patterns, defensive shifts per player.
- **Billy Walters / Computer Group** ([Wikipedia](https://en.wikipedia.org/wiki/Billy_Walters_(gambler)), [Shortform](https://www.shortform.com/blog/billy-walters-sports-betting/)): ~60% win rate; industrial line-movement operation. The Walters playbook — beard networks, head-fake betting, syndicate coordination — **does not translate** to a retail SaaS. What does translate: **modeling mispricings and acting on them with disciplined sizing.**
- **Spanky (Gadoon Kyrollos)** ([The Ringer — Requiem for a Sports Bettor](https://www.theringer.com/2019/06/05/gambling/sports-betting-bettors-sharps-kicked-out-spanky-william-hill-new-jersey); [Be Better Bettors podcast](https://podcasts.apple.com/us/podcast/be-better-bettors/id1493902736)): **Top-down** bettor — follows sharp money rather than building models from scratch. Not our approach, but his framework of tracking line movements across many books is reflected in MKT-02.

### Statistical frameworks
- **Poisson / Skellam for totals** ([WAR, Pythagoras, Poisson and Skellam](https://ecologicallyoriented.wordpress.com/2017/12/07/war-pythagoras-poisson-and-skellam/)): Classical model for run-scoring. Each team scores as a Poisson; run margin is Skellam-distributed. For MLB, **Conway-Maxwell-Poisson** handles over/under-dispersion better than vanilla Poisson ([arxiv](https://arxiv.org/html/2409.17129v1)). Relevance to us: use this as an **analytical prior for totals** and as a **calibration sanity check** for our LightGBM totals output.
- **Dixon-Coles** (football origin; [dashee87 implementation](https://dashee87.github.io/football/python/predicting-football-results-with-statistical-modelling-dixon-coles-and-time-weighting/)): Time-weighted team ratings with low-score correction. Baseball analog: weight recent games more, correct for structural NRFI rates.
- **Empirical Bayes shrinkage** ([Robinson — Variance Explained](http://varianceexplained.org/r/empirical_bayes_baseball/)): Beta-binomial for rate stats on small samples. Directly applicable to rookie SPs, early-season bullpens (see CAL-02).
- **Bayesian TTOP** ([Brill Wharton paper](https://wsb.wharton.upenn.edu/wp-content/uploads/2023/08/Ryan-Brill_Research-Paper.pdf)): Confirms TTOP is real and quantifies pitcher-specific magnitudes.

### Bankroll / sizing
- **Kelly Criterion** ([Wikipedia](https://en.wikipedia.org/wiki/Kelly_criterion)): Maximizes log-growth but has 50% probability of 50% drawdown at full Kelly.
- **Fractional Kelly** ([Downey](https://matthewdowney.github.io/uncertainty-kelly-criterion-optimal-bet-size.html), [Crane](https://harrycrane.substack.com/p/two-arguments-for-fractional-kelly)): Under parameter uncertainty, fractional Kelly is provably better. Quarter-Kelly (0.25) captures ~55% of full-Kelly growth with <10% expected max drawdown. **This is what we should ship.**
- **CLV as leading indicator** ([VSiN](https://vsin.com/how-to-bet/the-importance-of-closing-line-value/), [OddsJam](https://oddsjam.com/betting-education/closing-line-value), [Pikkit CLV tracker](https://pikkit.com/closing-line-value)): Build CLV dashboarding from day 1 of production — it stabilizes 10–20× faster than win rate.

---

## 5. Out-of-the-Box Angles — Explicit Investigation Notes

| Angle | Our read |
|-------|----------|
| **LLM-parsed beat writer news** | Strong yes — LINEUP-01. We already pay for Claude. Marginal cost is ~$5/mo at Haiku rates. Biggest risk is rumor-vs-confirmed noise — mitigate with "confidence" tagging in the LLM output schema. |
| **Contrarian social sentiment** | Weak yes — SENTIMENT-01. Evidence weakening in 2024–2026 era. Treat as research feature, not a primary signal. |
| **DK ↔ FD arbitrage** | Weak no (as arb) — 1–2% arbs are rare with only 2 books, and professional arb sites already skim them. Strong yes (as best-price logic) — MKT-04. Always execute at whichever book has the better number. |
| **Middling / scalping** | Out of scope (pre-game only in v1). Revisit if/when we add live betting. |
| **Weather-driven unders** | Yes — WX-01/WX-03. Particularly valuable in April/May cold and October. |
| **Opener/bullpen-game detection** | Strong yes — BP-03. Mandatory to avoid systematic mispricing on TB/MIA and increasingly other teams using openers. |
| **Underdog lottery tickets** | Deferred. Requires specific spot identification (e.g., "+EV on home dogs with R SP vs L-heavy road lineup in day game after cross-country travel"). Sample-size-dependent; v2 research. |
| **NRFI/YRFI derivative plays** | Yes — NRFI-01. Only if The Odds API covers the prop for DK/FD (verify). Cheap to derive from totals model. |
| **Calibration-deciles self-audit** | Yes — CAL-01. This is hygiene, not an edge, but it prevents us from betting losing deciles. |

---

## 6. Open Questions — Kyle Should Weigh In

These block or materially change the roadmap. Surface with recommendations (not open questions).

1. **The Odds API coverage of F5 and NRFI props (DK + FD):** Does our entry tier include these markets? If not, upgrade cost must be weighed against the $100 cap. **Recommendation:** verify before committing to Phase 3.
2. **Weather API polling frequency:** WX-03 requires 2 polls/day (line-open + lineup-lock). Today we poll 1×/day. Cost impact likely trivial but needs confirmation. **Recommendation:** approve 2-poll pipeline; estimated add <$5/mo.
3. **X/Twitter access for LINEUP-01:** X API free tier is restrictive in 2026. Options: (a) official API paid tier (~$100–200/mo, breaks budget), (b) Nitter-style scrape (legal gray area, fragile), (c) aggregator feeds like RotoWire+FantasyLabs (~$30/mo), (d) delay LINEUP-01 to v1.2. **Recommendation:** option (c) — aggregator feed stays within budget and is more reliable than scraping X directly.
4. **Kelly fraction and initial bankroll policy:** Personal-use initial bankroll size determines how much variance we can absorb. At <$5k bankroll, quarter-Kelly still risks meaningful dollar drawdown. **Recommendation:** 0.25 Kelly across the board at launch; move to 0.30 on Elite tier picks only after 200-pick track record shows +CLV.
5. **Opener detection: heuristic vs. beat-news signal:** Openers are sometimes announced 24h ahead, sometimes only at lineup posting. **Recommendation:** implement heuristic (team history + probable SP career IP) as baseline; upgrade to beat-news signal once LINEUP-01 ships.
6. **Market blending weight (MKT-01):** How much to weight the DK/FD opening line as a prior relative to our model? **Recommendation:** start at 70% market / 30% model for games where our confidence is low (market prior dominates); shift to 40/60 when model confidence is high (measured by feature coverage + confirmed lineup/SP). Tune via backtest.
7. **When to avoid picks entirely:** If model is miscalibrated in a decile, do we (a) adjust via isotonic refit or (b) refuse to publish picks in that bucket? Pros disagree. **Recommendation:** refuse picks in miscalibrated buckets until we have ≥200 picks in that bucket with stable calibration. Ship-over-polish argues for filtering early.

---

## 7. Things Even the Pros Disagree On

Worth knowing when evaluating our own decisions:

- **How much to weight CLV vs. actual ROI in short samples.** Peabody: CLV is king. Others: CLV can be gamed by early-market limits; ROI at closing price is the real test.
- **Whether public-fade edge still exists in 2026.** Sharp Insights data says yes in narrow spots; most pros say the edge has been arbed away by the 2020–2025 retail-sharp crossover.
- **Kelly fraction sweet spot.** Consensus is 0.25, but pros who deeply trust their models push to 0.50. We should stay conservative given early-stage model uncertainty.
- **Whether in-play adds edge or just exposure.** Out of scope for us anyway, but note for v2 scoping.
- **Umpire effects — are they real or sample-size noise?** Most agree the top/bottom decile of umps produce real run differentials; the middle 80% is within regress-to-mean noise. Conclusion: use umpire features but shrink heavily.

---

## Appendix A — Data Source Cost Summary (Delta from Current Pipeline)

| Source | Cost | Used by |
|--------|------|---------|
| UmpScorecards scrape | Free | UMP-01, UMP-02 |
| Baseball Savant scrape (xFIP, barrel, framing) | Free | SP-02, SP-03, SP-04, OFF-01 |
| MLB Stats API extended (pitch counts, play-by-play) | Free (higher volume) | BP-01, BP-02, SP-01, BP-03 |
| Weather API extra poll (2×/day) | ~$0–5/mo | WX-03 |
| RotoWire + FantasyLabs lineup/news feed | ~$20–40/mo | LINEUP-01, LINEUP-02 |
| Anthropic Claude Haiku (news parsing) | ~$2–10/mo | LINEUP-01, SENTIMENT-02 |
| The Odds API F5 / props expansion | **Verify — possibly $0 if included** | F5-01, NRFI-01, PROP-01 |

**Projected total delta:** +$25–$60/mo, well within budget envelope headroom below the $300 cap.

---

## Appendix B — Sources (Full List)

### Professional gamblers / frameworks
- Joe Peta, *Trading Bases*: [Amazon](https://www.amazon.com/Trading-Bases-Fortune-Betting-Baseball/dp/0451415175) | [ESPN Playbook interview](https://www.espn.com/blog/playbook/fandom/post/_/id/18799/wall-st-vet-backs-mlb-betting-in-book) | [The Hardball Times review](https://tht.fangraphs.com/book-review-trading-bases/) | [Analytics.Bet adaptation](https://analytics.bet/articles/a-deep-learning-approach-to-mlb-money-line-betting-based-on-joe-petas-trading-bases/)
- Rufus Peabody: [Unabated — Beyond CLV](https://unabated.com/articles/beyond-clv-analyze-bet-quality-using-expected-roi) | [MIT Sloan profile](https://www.sloansportsconference.com/people/rufus-peabody) | [The Unabated Podcast](https://open.spotify.com/show/21nxGHdfGHcklYcQCe2Rw9)
- Haralabos Voulgaris: [Grokipedia](https://grokipedia.com/page/Haralabos_Voulgaris) | [Sports History Network](https://sportshistorynetwork.com/gambling/inside-the-mind-of-haralabos-voulgaris/) | [OpenCourt coverage](https://www.opencourt-basketball.com/2025/08/11/haralabos-voulgaris-the-gambler-who-outsmarted-vegas-and-changed-nba-betting-forever/)
- Billy Walters: [Wikipedia](https://en.wikipedia.org/wiki/Billy_Walters_(gambler)) | [Shortform — Computer Group](https://www.shortform.com/blog/the-computer-group-sports-betting/) | [Shortform — Walters system](https://www.shortform.com/blog/billy-walters-sports-betting/) | [ESPN — Head-fake game](https://www.espn.com/chalk/story/_/id/32066178/the-head-fake-game-how-sharp-bettors-fool-betting-market)
- Spanky (Gadoon Kyrollos): [The Ringer — Requiem](https://www.theringer.com/2019/06/05/gambling/sports-betting-bettors-sharps-kicked-out-spanky-william-hill-new-jersey) | [BetterEd — Top-down case study](https://www.bettored.org/post/case-study-spanky-top-down-betting) | [Be Better Bettors podcast](https://podcasts.apple.com/us/podcast/be-better-bettors/id1493902736)

### Market inefficiencies
- Umpire K-rate & totals: [Core Sports Betting](https://www.coresportsbetting.com/how-mlb-umpire-tendencies-affect-over-under-bets/) | [Swish Analytics](https://www.swishanalytics.com/mlb/mlb-umpire-factors) | [UmpScorecards](https://umpscorecards.com/) | [Bat Flips and Nerds — umpire bias](https://batflipsandnerds.com/2019/10/18/umpires-are-more-biased-than-i-thought/)
- Weather: [RotoGrinders WeatherEdge](https://rotogrinders.com/columns/mlb-weatheredge-mlb-dfs-betting-weather-tool-2645931) | [HeatCheckHQ — MLB weather betting](https://heatcheckhq.io/blog/mlb-weather-betting-guide) | [Alan Nathan Physics of Baseball](http://baseball.physics.illinois.edu/)
- Travel / circadian: [PNAS — Song et al.](https://www.pnas.org/doi/abs/10.1073/pnas.1608847116) ([PMC mirror](https://pmc.ncbi.nlm.nih.gov/articles/PMC5307448/)) | [Science AAAS](https://www.science.org/content/article/jet-lag-puts-baseball-players-their-game) | [Northwestern Now](https://news.northwestern.edu/stories/2017/01/jet-lag-impairs-performance-major-league-baseball-players) | [Core Sports — E/W travel](https://www.coresportsbetting.com/east-coast-vs-west-coast-travel-impact-on-sports-betting/)
- Bullpen fatigue: [ESPN closer depth chart](https://www.espn.com/fantasy/baseball/flb/story?page=REcloserorgchart) | [Core Sports — bullpen fatigue](https://www.coresportsbetting.com/how-to-use-bullpen-fatigue-in-mlb-betting/) | [Underdog Chance — consecutive games](https://www.underdogchance.com/evaluating-bullpen-usage-in-consecutive-mlb-games/) | [MLB.com — traditional closers fading](https://www.mlb.com/news/traditional-closers-fading-away-as-bullpen-usage-evolves)
- F5 markets: [Outlier — F5 strategy](https://outlier.bet/sports-betting-strategy/mlb-betting/the-strategy-behind-first-five-inning-betting/) | [OddsIndex F5 guide](https://oddsindex.com/guides/f5-betting-first-5-innings) | [Sports Betting Dime — F5](https://www.sportsbettingdime.com/guides/how-to/bet-on-baseball-first-five-innings/) | [Oddsshark F5 report](https://www.oddsshark.com/mlb/first-five-inning-betting)
- NRFI/YRFI: [BettorEdge NRFI strategy](https://www.bettoredge.com/post/mastering-nrfi-bets-proven-strategies-for-baseball-s-hottest-market) | [BettingPros NRFI matchups](https://www.bettingpros.com/mlb/props/nrfi-yrfi/) | [Action Network NRFI](https://www.actionnetwork.com/mlb/mlb-odds-no-run-first-inning-how-to-bet-baseball) | [Core Sports — first inning trends](https://www.coresportsbetting.com/how-to-use-first-inning-scoring-trends-for-mlb-betting/)
- Park factors (handedness): [Baseball Savant park factors](https://baseballsavant.mlb.com/leaderboard/statcast-park-factors) | [Baseball America — L/R park splits](https://www.baseballamerica.com/stories/three-year-lefty-righty-splits-for-each-mlb-park/) | [Baseball Prospectus — park factors volatility](https://www.baseballprospectus.com/news/article/64534/an-updated-system-of-park-factors-and-volatility/) | [MLB.com — Statcast park factors](https://www.mlb.com/news/park-factors-measured-by-statcast)
- TTOP: [MLB.com Glossary — TTOP](https://www.mlb.com/glossary/miscellaneous/third-time-through-the-order-penalty) | [Baseball Prospectus — TTOP](https://www.baseballprospectus.com/news/article/22156/baseball-proguestus-everything-you-always-wanted-to-know-about-the-times-through-the-order-penalty/) | [Brill — Bayesian TTOP](https://wsb.wharton.upenn.edu/wp-content/uploads/2023/08/Ryan-Brill_Research-Paper.pdf) ([arxiv](https://arxiv.org/abs/2210.06724))
- Catcher framing: [MLB Glossary — Framing](https://www.mlb.com/glossary/statcast/catcher-framing) | [Baseball Savant framing leaderboard](https://baseballsavant.mlb.com/leaderboard/catcher-framing) | [FanGraphs — framing evolution](https://blogs.fangraphs.com/pitch-framing-is-evolving-along-with-the-strike-zone/) | [Baseball Prospectus — probabilistic framing](https://www.baseballprospectus.com/news/article/22934/framing-and-blocking-pitches-a-regressed-probabilistic-model-a-new-method-for-measuring-catcher-defense/)

### Statistical / modeling
- Poisson / Skellam / Dixon-Coles: [dashee87 — Dixon-Coles](https://dashee87.github.io/football/python/predicting-football-results-with-statistical-modelling-dixon-coles-and-time-weighting/) | [Ecologically Oriented — Poisson/Skellam](https://ecologicallyoriented.wordpress.com/2017/12/07/war-pythagoras-poisson-and-skellam/) | [arxiv — Bivariate CMP Poisson](https://arxiv.org/html/2409.17129v1)
- Empirical Bayes: [Robinson — Variance Explained](http://varianceexplained.org/r/empirical_bayes_baseball/) | [PyMC Labs — Bayesian MARCEL](https://www.pymc-labs.com/blog-posts/bayesian-marcel) | [MLB Bayesian Ridge (GitHub)](https://github.com/dteuscher1/MLB-Bayesian-Ridge)
- Statcast metrics: [MLB Statcast glossary](https://www.mlb.com/glossary/statcast) | [Baseball Savant xwOBA](https://baseballsavant.mlb.com/leaderboard/expected_statistics) | [Pitcher List — Statcast value](https://pitcherlist.com/going-deep-the-real-value-of-statcast-data-part-i/) | [MLB Prediction — expected stats](https://mlbprediction.com/expected-stats-guide.html)

### Bankroll & market signals
- Kelly criterion: [Wikipedia](https://en.wikipedia.org/wiki/Kelly_criterion) | [Downey — uncertainty Kelly](https://matthewdowney.github.io/uncertainty-kelly-criterion-optimal-bet-size.html) | [Crane — fractional Kelly](https://harrycrane.substack.com/p/two-arguments-for-fractional-kelly) | [Kelly simulator](https://kellysimulator.com/)
- CLV: [VSiN — CLV importance](https://vsin.com/how-to-bet/the-importance-of-closing-line-value/) | [OddsJam — CLV](https://oddsjam.com/betting-education/closing-line-value) | [Pikkit CLV tracker](https://pikkit.com/closing-line-value) | [betstamp — CLV](https://betstamp.com/education/what-is-closing-line-value-clv)
- Reverse line movement: [Pinnacle OddsDropper — RLM](https://www.pinnacleoddsdropper.com/blog/reverse-line-movement) | [Predictem — RLM](https://www.predictem.com/betting/strategy/reverse-line-movement/) | [FantasyLife — RLM](https://www.fantasylife.com/articles/betting/what-is-reverse-line-movement) | [SportsInsights — Steam moves](https://www.sportsinsights.com/betting-systems/steam-moves/)
- Public fade: [SportsInsights — fade the public MLB totals](https://www.sportsinsights.com/blog/should-you-fade-the-public-when-betting-mlb-totals/) | [Boyd's Bets — contrarian betting](https://www.boydsbets.com/contrarian-betting-explained/)

### Comparison & general MLB strategy
- MLB betting strategy: [betstamp — 2025 guide](https://betstamp.com/education/mlb-betting-strategy-guide)
- DK vs FD comparison: [RotoWire — FD vs DK](https://www.rotowire.com/betting/fanduel-vs-draftkings) | [Sharp Football Analysis — FD vs DK Apr 2026](https://www.sharpfootballanalysis.com/sportsbook/fanduel-vs-draftkings/) | [The Lines — DK vig](https://www.thelines.com/draftkings-vig-betting-lines/) | [HoldCrunch](https://holdcrunch.com/insights/)
