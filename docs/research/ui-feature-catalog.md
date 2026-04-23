# Diamond Edge — UI Feature Catalog (v2 UX Expansion)

**Status:** Research deliverable — prioritized feature backlog for frontend expansion
**Date:** 2026-04-22
**Audience:** `mlb-frontend` (primary), `mlb-backend`, Kyle (personal user)
**Mode:** Personal-use (SaaS scaffolding preserved). Kyle is a serious bettor who wants tools to make money, track edge, and self-regulate.

---

## 0. Executive Summary

Diamond Edge's current UI covers the table-stakes surfaces: today's slate (`/picks/today`), pick detail (`/picks/[id]`), history (`/history`), a starter bankroll tracker (`/bankroll`), plus the dormant SaaS scaffolding (pricing, billing, age-gate, login, signup). That's the pick-consumption layer. It is missing the **decision-support, edge-measurement, and self-regulation layers** that separate a good pro bettor from a tilting one.

**The thesis of this catalog:** Kyle already has the model. What he does not yet have is the **operating cockpit** around the model — sizing, exposure tracking, CLV feedback, research notes, and guardrails. All of those are UI, and almost all of them require data we already track.

### Top 10 features (prioritized)

| # | Feature | Cat. | Complexity | Why it wins |
|---|---------|------|------------|-------------|
| 1 | Kelly Stake Calculator (per-pick) | Bankroll | **S** | Turns model EV into a bet size in one line of math. Uses data we already write. Direct $ impact. |
| 2 | Unit-Based Bankroll Dashboard (drawdown + daily exposure) | Bankroll | **M** | Current `/bankroll` is flat-dollar. Units + drawdown + daily cap is how pros actually track. |
| 3 | CLV Dashboard (aggregate + per-pick) | Edge | **M** | `pick_clv` table is populated but unread. CLV is Peabody's north-star metric — zero UI today. |
| 4 | Per-Market ROI + Calibration Breakdown | Edge | **S** | History page already aggregates by market. Add calibration curve + confidence bucket ROI. |
| 5 | Line Movement Sparkline on Pick Card | Slate | **M** | Every pick card becomes self-justifying: show open → current → (closing) on one mini-chart. |
| 6 | Pick Journal (notes + tags per pick) | Research | **S** | Free-text `notes` already on `bankroll_entries`. Add tag taxonomy + per-pick `/picks/[id]#journal`. |
| 7 | Daily Exposure Guardrail (10%/day cap with live meter) | Regulation | **S** | Thorp/Walters convention. Blocks Kyle from tilting the bankroll in one night. Pure frontend math. |
| 8 | Pitcher Matchup Mini-Card (handedness, last-5 xFIP, spin trend) | Slate | **M** | Pick detail has a one-line "Home SP: X" today. Expand to the SP deep-dive pros screenshot. |
| 9 | Custom EV Threshold + Confidence Tier Filter on Slate | Advanced | **S** | Slider on `/picks/today`: "show me only 6%+ EV, tier 5+." Frontend-only. |
| 10 | Simultaneous Kelly Slate Solver ("size my whole slate") | Bankroll | **L** | Research v2 Track A's headline recommendation. Replaces independent Kelly with portfolio solve. |

### Recommended first wave (4–6 items the frontend agent can build in parallel, no further research needed)

All of these are **S or small-M complexity, obvious user value, and use data already in the schema or trivially derivable**:

1. **Kelly Stake Calculator** (#1 — feature 1.1) — widget on pick detail, 50 lines.
2. **Pick Journal — notes + tags** (#6 — feature 4.1, 4.3) — `bankroll_entries.notes` + new `pick_tags` tag string/array column.
3. **CLV Aggregate Dashboard page** (#3 — feature 2.1) — new `/edge` route; reads `pick_clv`, renders hit-rate + rolling CLV chart.
4. **Custom EV / Tier filter on slate** (#9 — feature 7.1) — URL-param filter on `/picks/today`, zero backend change.
5. **Daily Exposure Meter** (#7 — feature 6.2) — client-side sum of today's `bankroll_entries.bet_amount_cents` / bankroll. Hook into pick-detail stake field.
6. **Unit setter in bankroll settings** (feeds #2) — new `profiles.bankroll_unit_pct` column; every bankroll $ display offers a "in units" toggle.

These six can ship in ~1–2 weeks of parallel frontend work with no upstream blockers. Everything below requires one or more of: a new data source, a new ingestion pipeline, a new backend route, or a UX research pass.

---

## 1. Catalog — by category

Each feature is scored on:
- **Complexity:** **S** ≈ ≤8h of frontend work; **M** ≈ 1–3 days; **L** ≈ >3 days or cross-team
- **Priority:** **P0** must-have (ship first wave), **P1** high-value (next wave), **P2** nice-to-have, **P3** speculative/research

---

### Category 1 — Bankroll Management

#### 1.1 Kelly Stake Calculator (per-pick)
- **Category:** Bankroll
- **Description:** Widget on pick detail that computes the fractional-Kelly stake given the pick's `model_probability`, `best_line_price`, and Kyle's configured bankroll + Kelly fraction. Shows raw Kelly, fractional Kelly (0.15/0.20/0.25 by tier per Research v2 A.5), and the 3% per-pick cap clip.
- **Value for Kyle:** One-click sizing. Removes the "what do I bet on this?" emotional overhead. Anchors all bets to math instead of gut.
- **Complexity:** S
- **Dependencies:** `profiles.bankroll_cents`, `profiles.kelly_fraction` (new column), existing pick row.
- **Priority:** **P0**

#### 1.2 Unit-Based Bankroll Dashboard
- **Category:** Bankroll
- **Description:** Upgrade `/bankroll` from dollar-only to units. Unit = user-configurable 1–3% of bankroll. All bet history renders in both $ and units. Compound growth chart (bankroll over time, annotated with starting bankroll + deposits).
- **Value for Kyle:** Professional bettor convention. Lets him compare his performance to track records posted by pros (who all publish in units).
- **Complexity:** M
- **Dependencies:** `bankroll_entries` (exists), `profiles.bankroll_unit_pct` (new), `profiles.starting_bankroll_cents` (new).
- **Priority:** **P0**

#### 1.3 Simultaneous-Kelly Slate Solver
- **Category:** Bankroll
- **Description:** "Size my whole slate" button. Runs Research v2 Track A.2 portfolio optimization: takes all Tier 4+ picks for today, solves joint log-wealth Kelly with a 10%-of-bankroll budget constraint, returns a stake vector. Renders as a table with per-pick stake in $ and units.
- **Value for Kyle:** Replaces N independent Kelly calculations (which over-stake on correlated slates) with the pro-grade joint solve from Thorp.
- **Complexity:** L (needs a small Python or TS solver; optimization logic + UI)
- **Dependencies:** Today's picks with EV + odds; bankroll config; correlation matrix (can hardcode weather/doubleheader correlations v1).
- **Priority:** **P1**

#### 1.4 Drawdown Dashboard
- **Category:** Bankroll
- **Description:** Rolling 30-day P&L chart with a drawdown envelope. Flags when rolling drawdown passes -10% (yellow) or -15% (red → triggers half-Kelly brake per Research v2 A.3). Max drawdown number prominent.
- **Value for Kyle:** Self-regulation signal. Pros watch drawdown more obsessively than they watch hit rate.
- **Complexity:** M
- **Dependencies:** `bankroll_entries` with settled outcomes; charting lib.
- **Priority:** **P1**

#### 1.5 Weekly Bankroll Rebalance Reminder
- **Category:** Bankroll
- **Description:** Monday-morning banner: "Rebalance your bankroll. Current: $X. Used for this week's sizing." Krackomberger's discipline — stakes sized off Monday's number, no intra-week adjustment.
- **Value for Kyle:** Blocks path-dependent emotional sizing (chasing losses or pressing wins mid-week).
- **Complexity:** S
- **Dependencies:** `profiles.bankroll_snapshot_weekly` (new table or column with week-of-year key).
- **Priority:** **P2**

#### 1.6 Bankroll History & Compound Growth Chart
- **Category:** Bankroll
- **Description:** Full history of bankroll balance over time — deposits, withdrawals, weekly snapshots, graphed with log-scale toggle. Shows theoretical Kelly-optimal growth alongside actual.
- **Value for Kyle:** Visual proof the strategy is working (or not). Key psychological anchor during drawdowns.
- **Complexity:** M
- **Dependencies:** `bankroll_snapshots` table (new, ~4 cols), charting lib.
- **Priority:** **P2**

---

### Category 2 — Edge Measurement & Transparency

#### 2.1 CLV Dashboard (aggregate + per-pick)
- **Category:** Edge
- **Description:** New `/edge` route. Top: aggregate CLV stats — positive CLV rate, average CLV in cents, rolling 30-pick CLV trendline. Middle: per-market CLV breakdown (ML vs RL vs Totals). Bottom: per-pick table sortable by CLV. Pick detail adds a "CLV: +12 cents" badge once graded.
- **Value for Kyle:** CLV stabilizes 10–20× faster than win rate (Peabody). This is the only early-days signal that the model is actually sharp vs. just lucky.
- **Complexity:** M
- **Dependencies:** `pick_clv` table (exists, unused in UI).
- **Priority:** **P0**

#### 2.2 Per-Market ROI Breakdown
- **Category:** Edge
- **Description:** Extend `/history` "by market" grid into a proper dashboard: moneyline / run line / totals / F5 (when live) — each with W-L, ROI, avg edge, CLV, pick count, and a rolling ROI sparkline.
- **Value for Kyle:** Tells him which markets his model is actually winning vs. leaking. Pro bettors cut markets they can't beat.
- **Complexity:** S (extends existing history page)
- **Dependencies:** `picks`, `pick_outcomes`, `pick_clv`.
- **Priority:** **P0**

#### 2.3 Calibration Curve Viewer
- **Category:** Edge
- **Description:** Reliability diagram: predicted probability bucket (0.5, 0.55, 0.6, …) vs. realized win rate. Overlaid 45° line. Highlights deciles where the model is miscalibrated (Research v1 CAL-01). Also renders a Brier score and log-loss summary.
- **Value for Kyle:** Directly answers "is my model miscalibrated?" Pairs with a filter: "hide picks from miscalibrated buckets."
- **Complexity:** M
- **Dependencies:** `picks.model_probability`, `pick_outcomes`, charting lib.
- **Priority:** **P1**

#### 2.4 Confidence Tier vs. Realized Outcome Distribution
- **Category:** Edge
- **Description:** Grouped bar chart: for each confidence tier (1–5), show actual win rate, expected win rate, and sample size. Catches "Tier 5 is supposed to be 58%+ but I'm at 52%" drift.
- **Value for Kyle:** Validates the tier system. Surfaces whether Elite picks are actually elite.
- **Complexity:** S
- **Dependencies:** Same as 2.3.
- **Priority:** **P1**

#### 2.5 Historical Backtest Viewer
- **Category:** Edge
- **Description:** Renders output of the ML backtest runs: P&L curve with 95% confidence band from bootstrap, max drawdown, Sharpe, per-market breakdown. One page per model artifact.
- **Value for Kyle:** Before Kyle promotes a new model to production, this is the go/no-go surface.
- **Complexity:** L (depends on ML engineer producing backtest JSON)
- **Dependencies:** `model_artifacts` table + backtest artifacts (not yet populated).
- **Priority:** **P2**

#### 2.6 Edge Decay / Line Erosion Report
- **Category:** Edge
- **Description:** For each pick: edge at generation vs. edge at first-pitch (using closing odds). How much of the edge was eaten by line movement before you could place the bet? Flags picks where we habitually arrive too late.
- **Value for Kyle:** Informs optimal posting cadence — should picks drop at 10am or noon? Data-driven answer.
- **Complexity:** M
- **Dependencies:** `picks` + closing odds snapshot (exists in `market_priors`).
- **Priority:** **P2**

---

### Category 3 — Slate Intelligence

#### 3.1 Line Movement Sparkline (pick card + detail)
- **Category:** Slate
- **Description:** On every pick card and detail page, render a tiny sparkline of odds movement from open → current. On pick detail, expand to a full chart with the book names overlaid (DK/FD). Flags "RLM" if line moved against public %.
- **Value for Kyle:** Lets Kyle see at a glance whether the market is confirming our pick or fading it. Replaces "gut feel about line movement" with data.
- **Complexity:** M
- **Dependencies:** Need to store historical odds snapshots (`market_priors` has snapshot_time; needs periodic writes or dedicated `odds_snapshots` table).
- **Priority:** **P0**

#### 3.2 Pitcher Matchup Mini-Card
- **Category:** Slate
- **Description:** On pick detail, replace the single-line "Home SP: X" with a matchup module: both SPs with L5-start xFIP, K%, BB%, Stuff+ (when Research v1 SP-02 ships), handedness, TTOP risk flag. Mini headshots if free.
- **Value for Kyle:** The single most-consulted slate surface after odds. Sharps spend 80% of research time on SP matchups.
- **Complexity:** M
- **Dependencies:** Pitcher stats API/table (partial — expand as Phase 2 features ship).
- **Priority:** **P0**

#### 3.3 Park-Factor + Weather Overlay
- **Category:** Slate
- **Description:** On totals picks, show a "Environment" panel: park HR factor (handedness-adjusted per Research v1 WX-01), wind direction relative to stadium bearing, temp, humidity, roof status. Visual: ball-flight arrow + color-coded O/U lean.
- **Value for Kyle:** Makes the environmental edge visible. Also forces a "does this pick make sense given conditions?" sanity check.
- **Complexity:** M
- **Dependencies:** `stadiums.bearing_deg`, `games.weather_*`, park factor lookup.
- **Priority:** **P1**

#### 3.4 Opener Detection Flag
- **Category:** Slate
- **Description:** Pick card badge: "Opener" / "Bullpen game" when Research v1 BP-03 heuristic triggers. On pick detail: reasoning ("TB used opener in 23 of last 30 games"). Affects how TTOP/SP features should be interpreted by the reader.
- **Value for Kyle:** Prevents mental shortcuts like "Oh it's Snell vs McClanahan" when one of them is actually an opener going 2 IP.
- **Complexity:** S (once BP-03 feature is in pick metadata)
- **Dependencies:** `picks.pick_metadata.is_opener_game` (new).
- **Priority:** **P1**

#### 3.5 Sharp vs. Public Sentiment Card
- **Category:** Slate
- **Description:** On pick detail: public betting % from aggregator vs. line movement direction. If 75% public on one side with line moving the other way → RLM badge. Annotate with news-signals context (late scratches, beat-writer sentiment) pulled from `news_signals`.
- **Value for Kyle:** Combines the two inputs pros triangulate — public money + sharp money. Gives an independent confirmation or contrarian warning on each pick.
- **Complexity:** L (requires public % data source — not yet in pipeline; `news_signals` exists but sentiment scoring does not)
- **Dependencies:** Public % feed (~$30/mo RotoWire?), `news_signals`.
- **Priority:** **P2**

#### 3.6 Travel / Rest Badge
- **Category:** Slate
- **Description:** Flag on pick card: "3 TZ eastward travel" / "Getaway day" / "Doubleheader G2" per Research v1 TRAVEL-01/02. Badge opens a tooltip explaining the ~8–20 bps edge.
- **Value for Kyle:** Zero-effort awareness of the travel-related edges already in the model.
- **Complexity:** S
- **Dependencies:** Derived fields already feasible from `games` schedule.
- **Priority:** **P1**

#### 3.7 Umpire Card (totals picks)
- **Category:** Slate
- **Description:** For totals picks: assigned HP umpire with season K-boost % and runs-per-game vs. league average. "Large zone — suppresses totals" tag.
- **Value for Kyle:** Umpire is one of the few free, publicly-ignored edges on totals. Showing it on the pick makes Kyle feel confident in the pick's reasoning.
- **Complexity:** S (once UMP-01 feature lands in `games.ump_stats`)
- **Dependencies:** Research v1 UMP-01 ingestion.
- **Priority:** **P1**

---

### Category 4 — Research & Notes

#### 4.1 Pick Journal (notes per pick)
- **Category:** Research
- **Description:** On pick detail: expandable "My notes" section, free-text, persists to `bankroll_entries.notes` or a new `pick_notes` table keyed by `(user_id, pick_id)`. Renders prior notes for the same game / opponent / pitcher when relevant.
- **Value for Kyle:** Builds a personal playbook over the season. "What did I think about Cole on short rest last time?" becomes answerable.
- **Complexity:** S
- **Dependencies:** New `pick_notes` table (minimal) OR reuse `bankroll_entries.notes`.
- **Priority:** **P0**

#### 4.2 Game-Level Notes (not pick-bound)
- **Category:** Research
- **Description:** Notes attached to a `games` row, independent of whether a pick was generated. Lets Kyle leave "watch this team's bullpen" observations that surface whenever that team appears on a future slate.
- **Value for Kyle:** Captures the research bettor instinct that doesn't always translate to a current-day pick.
- **Complexity:** S
- **Dependencies:** New `game_notes` table.
- **Priority:** **P2**

#### 4.3 Pick Tagging System
- **Category:** Research
- **Description:** Tag picks with user-defined labels: "fade public", "weather play", "revenge spot", "bullpen fatigue", "my model disagrees w/ me". Filter `/history` by tag. Roll up performance by tag.
- **Value for Kyle:** Discovers which of Kyle's own pattern-biases actually make money. "Fade public" picks might be -EV even if gut says yes.
- **Complexity:** S
- **Dependencies:** `pick_tags` text[] column on `bankroll_entries` or new join table.
- **Priority:** **P0**

#### 4.4 CSV Export (tax + record-keeping)
- **Category:** Research
- **Description:** Export `/history` or `/bankroll` to CSV: date, game, market, side, odds, stake, outcome, P&L, CLV, book. Date range selector.
- **Value for Kyle:** Tax prep. Also enables Kyle to run his own analysis in a spreadsheet for anything the UI doesn't surface.
- **Complexity:** S
- **Dependencies:** None — pure frontend serialization.
- **Priority:** **P1**

#### 4.5 Search across notes / tags / games
- **Category:** Research
- **Description:** Global search bar: "show me all picks tagged 'weather play' against NYY with +CLV." Full-text on notes.
- **Value for Kyle:** Compounding value as journal fills up.
- **Complexity:** M
- **Dependencies:** pg_trgm index on notes; structured filters on tags.
- **Priority:** **P2**

---

### Category 5 — Live Monitoring

#### 5.1 Scoreboard with Pick Status
- **Category:** Live
- **Description:** `/live` page: for each pick on today's slate, show live score, inning, and pick status (winning / losing / pushed). Polls MLB Stats API every 60s.
- **Value for Kyle:** One-glance "how am I doing tonight?" screen. Replaces flipping between MLB app and our site.
- **Complexity:** M
- **Dependencies:** Live game-state API poll route.
- **Priority:** **P1**

#### 5.2 Push / Email Notifications
- **Category:** Live
- **Description:** Opt-in notifications: lineup posted, late scratch of a pick's key player, weather delay, pick graded. Uses `news_signals` for real-time triggers.
- **Value for Kyle:** Catches the late-news LLM pipeline's value even when Kyle isn't watching the app.
- **Complexity:** L (browser push + service worker + email transport; requires user-pref tables)
- **Dependencies:** `news_signals`, a notification queue, push/email provider (Resend free tier).
- **Priority:** **P2**

#### 5.3 "Why was this pick made" expanded rationale
- **Category:** Live
- **Description:** Pick detail already shows rationale + SHAP. Extend: when rationale is a generic stub, surface the full SHAP attribution waterfall chart with feature descriptions. For each top-3 driver, a tooltip explaining what the feature means and why it moved probability.
- **Value for Kyle:** Turns opaque SHAP into a teaching moment. Also serves as a sanity check that the model's reasoning isn't laughable.
- **Complexity:** M
- **Dependencies:** `picks.shap_attributions` (already in pick payload), feature glossary table/JSON.
- **Priority:** **P1**

#### 5.4 Lineup Confirmation Badge
- **Category:** Live
- **Description:** Pick card badge flips from "Lineup unconfirmed" (gray) to "Lineup confirmed" (green) at ~T-60min. If a key player is scratched, badge turns red + links to the news_signal.
- **Value for Kyle:** Signal-to-noise: a confirmed-lineup pick is meaningfully higher-confidence than an unconfirmed one.
- **Complexity:** S
- **Dependencies:** `news_signals.signal_type='lineup_change'`.
- **Priority:** **P1**

---

### Category 6 — Responsible Gambling / Self-Regulation

#### 6.1 Session Time Tracker
- **Category:** Regulation
- **Description:** Small chip in nav: "In-app 23 min today." At 90min, gentle nudge: "Consider a break." At 180min, modal with a cool-off timer option.
- **Value for Kyle:** Even serious bettors tilt. Awareness is the primary mitigation.
- **Complexity:** S
- **Dependencies:** Client-side localStorage timer + `user_session_logs` table (optional).
- **Priority:** **P1**

#### 6.2 Daily Exposure Cap Meter
- **Category:** Regulation
- **Description:** Live meter on `/picks/today` and pick detail: "7.3% of bankroll staked today / 10% cap." Once cap hit, stake field on pick detail disables with an explanation.
- **Value for Kyle:** Enforces the Research v2 A.3 daily-cap guardrail at the UI layer. Prevents the one-bad-night blow-up.
- **Complexity:** S
- **Dependencies:** `bankroll_entries` (today-filter) + bankroll config.
- **Priority:** **P0**

#### 6.3 Monthly Spend Cap (soft)
- **Category:** Regulation
- **Description:** User-set monthly $ budget. Warning at 80% of cap; hard-disable new stakes at 100% until rollover or manual override (with 24h cooldown).
- **Value for Kyle:** A self-imposed ceiling that survives emotional weeks.
- **Complexity:** S
- **Dependencies:** `profiles.monthly_cap_cents`, `bankroll_entries` month aggregation.
- **Priority:** **P2**

#### 6.4 Cool-Off Timer
- **Category:** Regulation
- **Description:** "Take a 24/48/72h break." Blocks pick viewing during the window; shows only `/history` and a wellness resource list.
- **Value for Kyle:** Panic-button for tilt days. Also useful post-loss to force a reset.
- **Complexity:** S
- **Dependencies:** `profiles.cool_off_until` timestamp, middleware gate.
- **Priority:** **P2**

#### 6.5 Productivity Gate ("Hide picks until 11 AM")
- **Category:** Regulation
- **Description:** User setting: don't surface today's picks before a configurable time. Blocks the impulse to check at 7am and obsess for 4 hours.
- **Value for Kyle:** Preserves cognitive space. Small feature, real quality-of-life lift.
- **Complexity:** S
- **Dependencies:** `profiles.picks_visible_after_hour` (new).
- **Priority:** **P2**

#### 6.6 Loss Chasing Detector
- **Category:** Regulation
- **Description:** Heuristic: if Kyle has placed >3 bets above his normal unit size after a losing day, banner: "You're betting larger than usual after a loss. Consider taking a break."
- **Value for Kyle:** Catches the specific tilt pattern that kills bankrolls. Subtle but powerful.
- **Complexity:** M
- **Dependencies:** Stake-size statistical baseline per user; `bankroll_entries` aggregation.
- **Priority:** **P3**

---

### Category 7 — Advanced / Pro Tools

#### 7.1 Custom EV Threshold + Tier Filter
- **Category:** Advanced
- **Description:** URL-param filter on `/picks/today`: `?min_ev=6&min_tier=4`. Slider UI so Kyle can say "only show me Tier 5 picks with ≥8% EV today" and preview the resulting slate.
- **Value for Kyle:** Kyle has a sharper personal threshold than the live-gate's 8% EV / Tier 5. Lets him research a narrower cut without asking the backend.
- **Complexity:** S
- **Dependencies:** None — frontend filter on data already sent.
- **Priority:** **P0**

#### 7.2 Shadow-Pick Inspector
- **Category:** Advanced
- **Description:** New `/shadow` page (service-role or Elite-gated): browse shadow picks (EV 4–8% / Tier 3–4) that didn't qualify for live. For each: why it was shadow, its CLV, its eventual outcome.
- **Value for Kyle:** Answers "what am I missing?" and validates the live-gate threshold isn't too tight.
- **Complexity:** M
- **Dependencies:** RLS override or service-role route; already have `picks.visibility='shadow'`.
- **Priority:** **P1**

#### 7.3 Model Feature Walkthrough (educational)
- **Category:** Advanced
- **Description:** From pick detail SHAP waterfall, click any feature → slide-over panel explaining what it is, how it's computed, league distribution, where today's pick sits on that distribution.
- **Value for Kyle:** Deepens his own model understanding. Useful during drawdowns to distinguish "model is wrong" from "variance."
- **Complexity:** L (content-heavy; glossary for ~100 features)
- **Dependencies:** Feature glossary JSON/table (new).
- **Priority:** **P2**

#### 7.4 A/B Model Comparison
- **Category:** Advanced
- **Description:** For any slate or history window, render picks from Model v1 alongside Model v2 (shadow-candidate). Stake-neutral P&L comparison, CLV comparison, tier-overlap table.
- **Value for Kyle:** The go/no-go tool before promoting a new model. Pairs with 2.5 backtest viewer.
- **Complexity:** L
- **Dependencies:** Multi-model pick storage (`picks.model_version` column — exists? needs confirmation).
- **Priority:** **P2**

#### 7.5 "What-If" Stake Sizer
- **Category:** Advanced
- **Description:** On pick detail: slider lets Kyle preview P&L outcomes at custom stake sizes. "If I'd put $500 on this instead of my Kelly-sized $120, here's the expected distribution."
- **Value for Kyle:** Educational. Shows the variance cost of overbetting without having to actually overbet.
- **Complexity:** S
- **Dependencies:** Per-pick model probability + odds.
- **Priority:** **P3**

#### 7.6 Parlay Builder (deferred to v1.1+ per CLAUDE.md)
- **Category:** Advanced
- **Description:** Intentionally out of scope for v1. Listed here for completeness; re-evaluate post v1.
- **Priority:** **P3**

---

## 2. Priority Matrix (summary)

| Priority | Count | Categories |
|----------|-------|------------|
| **P0 (first wave)** | 9 | 1.1 Kelly calc · 1.2 Unit dashboard · 2.1 CLV dashboard · 2.2 Per-market ROI · 3.1 Line movement · 3.2 SP matchup · 4.1 Journal · 4.3 Tags · 6.2 Daily cap meter · 7.1 EV filter |
| **P1 (next wave)** | 13 | 1.3 Simultaneous Kelly · 1.4 Drawdown · 2.3 Calibration · 2.4 Tier calibration · 3.3 Park/weather · 3.4 Opener flag · 3.6 Travel badge · 3.7 Umpire card · 4.4 CSV export · 5.1 Scoreboard · 5.3 SHAP explainer · 5.4 Lineup badge · 6.1 Session tracker · 7.2 Shadow inspector |
| **P2 (nice-to-have)** | 11 | 1.5 Rebalance reminder · 1.6 Compound chart · 2.5 Backtest viewer · 2.6 Edge decay · 3.5 Sharp/public · 4.2 Game notes · 4.5 Search · 5.2 Notifications · 6.3 Monthly cap · 6.4 Cool-off · 6.5 Productivity gate · 7.3 Feature walkthrough · 7.4 A/B models |
| **P3 (speculative)** | 3 | 6.6 Loss-chasing detector · 7.5 What-if sizer · 7.6 Parlays |

---

## 3. Dependencies by Schema Change

To help the backend agent prioritize:

| Schema change | Features unlocked |
|---|---|
| `profiles.bankroll_cents`, `profiles.starting_bankroll_cents`, `profiles.kelly_fraction`, `profiles.bankroll_unit_pct` | 1.1, 1.2, 1.6, 6.2, many more |
| New `pick_notes` (user_id, pick_id, body, created_at) | 4.1 |
| New `pick_tags` column on `bankroll_entries` or join table | 4.3, 4.5 |
| New `bankroll_snapshots` (user_id, week_start, balance_cents) | 1.5, 1.6 |
| `profiles.monthly_cap_cents`, `profiles.cool_off_until`, `profiles.picks_visible_after_hour` | 6.3, 6.4, 6.5 |
| Odds snapshot history (either extend `market_priors` write cadence or new `odds_snapshots`) | 3.1, 2.6 |
| `picks.pick_metadata.is_opener_game` and travel fields | 3.4, 3.6 |
| Feature glossary | 7.3 |

---

## 4. Recommended Implementation Order

**Wave 1 (week 1–2): ship 6 features in parallel — zero upstream blockers.**
- 1.1 Kelly calc · 4.1 Journal · 4.3 Tags · 2.1 CLV dashboard (reads existing `pick_clv`) · 7.1 EV filter · 6.2 Daily exposure meter
- Backend work: add 4 `profiles` columns + `pick_notes` table + `pick_tags` column. <1 day of DB work.

**Wave 2 (week 3–4): edge + slate depth.**
- 1.2 Unit dashboard · 2.2 Per-market ROI · 3.1 Line movement · 3.2 SP matchup card
- Backend: odds snapshot cadence decision + SP stats surface.

**Wave 3 (week 5–6): regulation + monitoring.**
- 1.4 Drawdown · 5.1 Scoreboard · 5.4 Lineup badge · 6.1 Session tracker · 3.6 Travel badge · 3.4 Opener flag (as features land)

**Wave 4 (month 2+): advanced.**
- 1.3 Simultaneous Kelly solver · 2.3 Calibration curve · 7.2 Shadow inspector · 4.4 CSV export · 5.3 SHAP walkthrough

**Deferred until model/data matures:**
- 2.5 Backtest viewer (needs ML artifacts) · 3.5 Sharp/public (needs public% feed) · 7.3 Feature walkthrough (needs glossary) · 7.4 A/B models (needs second model artifact).

---

## 5. Out-of-Scope / Explicit Non-Features

- **Native mobile app.** v1 constraint per CLAUDE.md. Mobile web must be good.
- **Bet placement / deep-linking to book slips.** Compliance ambiguity; also DK/FD URL schemes change. Revisit v1.1.
- **Fund custody of any kind.** Hard no.
- **Non-MLB sports UI.** v1 scope.
- **Social features (leaderboards, comments, shared picks).** Personal-use mode — no other users.
- **Parlay builder.** Deferred to v1.1+.
- **In-play / live betting UI.** Deferred; v1 is pre-game only.

---

## 6. Research Sources Consulted

Catalog design was grounded primarily in two internal research documents which themselves synthesize the public literature:

- `docs/research/mlb-edge-research.md` — v1 edge catalog, Kelly/CLV discussion (Peta, Peabody, Walters, Thorp, Krackomberger references).
- `docs/research/mlb-edge-research-v2.md` — Track A bankroll deep-dive (Thorp simultaneous Kelly, Baker-McHale uncertainty shrinkage, per-pick/per-day/drawdown guardrails).

Pro-bettor UX influence (indirect, via internal research docs):
- Action Network, VSiN app review patterns → `/edge` CLV dashboard and per-market ROI
- Pikkit, BetTracker, Bet Bud → units over dollars, session tracker, tag taxonomy
- Joe Peta's *Trading Bases* → predetermined bet sizes, tier-based Kelly multipliers
- Pinnacle OddsDropper, Unabated → CLV as primary metric, line movement visualization
- Rufus Peabody (Unabated) → CLV north-star framing
- DFS UX (PrizePicks, Underdog) → mobile-first, one-glance slate cards

For v2 of this catalog, Kyle should consider a proper external pass with WebSearch to pull:
- Action Network sharpshooter screenshots
- Pikkit's unit tracker UI
- VSiN CLV widgets
- Responsible gambling UX patterns (BetMGM, DraftKings self-exclusion flows)
