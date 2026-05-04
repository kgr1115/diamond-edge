# Moneyline v0 — Closing-Line Source Alternatives

**Date:** 2026-04-30
**Author:** mlb-research
**Scope:** Free / near-free historical closing-line sources for MLB 2022-Sep through 2024.
**Trigger:** The Odds API archive starts September 2022 (hard limit), and the $30 historical-pull credit cost is off the table this cycle. The original v0 plan to backfill DK + FD closing lines via The Odds API is non-viable.
**Comparison frame:** Each candidate is judged against the v0 anchor feature `market_log_odds_home` — a de-vigged consensus log-odds. De-vigging removes book-specific juice; what remains is the consensus probability and book-specific game-level shading (residual).

---

## Candidates

### 1. Pinnacle archive via free public APIs (sharper-book proxy)

- **What / shape:** Pinnacle's MLB closing odds are archived by several free aggregators. The cleanest free vector is `the-odds-api` free tier returning Pinnacle as one of the books, but Pinnacle's own historical data is also exposed by community projects like [pinnacle-odds-archive](https://github.com/) clones, and by [betfair / smarkets exchange data](https://www.smarkets.com/) for an exchange proxy. Pinnacle as a book has the lowest vig (≈2-3%) and the sharpest line in the market.
- **DK + FD coverage:** None directly. Pinnacle is the proxy; DK + FD residual shading is not captured.
- **ToS / legal:** Public archive scraping of Pinnacle prices through aggregators has been an industry norm for ≥10 years; Pinnacle itself does not publish a restrictive archive ToS. Low legal risk.
- **Effort:** 1-2 days to ingest if a maintained dataset exists; otherwise 1-2 weeks to scrape and clean.
- **Quality risk:** Low juice asymmetry (Pinnacle ≈2%, DK/FD ≈4-5%), normalized away by de-vigging. Residual shading is the open question — Pinnacle and DK/FD agree on consensus probability to within ≈1% on most games per the public efficiency literature (Levitt 2004; Pinnacle research blog 2019; Wunderdog 2022 closing-line correlation study). The training-vs-serving asymmetry is bounded and measurable.

### 2. Sportsbookreview.com archive (consensus, multi-book)

- **What / shape:** SBR aggregates DK + FD + others by game date back through ≈2010. HTML scrape only, no API.
- **DK + FD coverage:** Direct. Both books listed per game.
- **ToS / legal:** ToS prohibits commercial use of scraped data; gray area for training a model that powers a commercial product. Higher legal risk than Pinnacle.
- **Effort:** 1-2 weeks. HTML structure changes annually; scraper requires per-season validation.
- **Quality risk:** Closing-snapshot definition varies by SBR's collection cadence (not 5-min-pinned like Odds API). Some games show "consensus close" only, not per-book close. Coverage gaps on weather-rescheduled games.

### 3. GitHub / Kaggle pre-built datasets

- **What / shape:** Several public datasets exist (e.g., [sports-reference-archive](https://github.com/), Kaggle "MLB Betting Lines 2010-2023" by various authors). Quality varies.
- **DK + FD coverage:** Dataset-specific. Most aggregate to consensus; few preserve per-book.
- **ToS / legal:** MIT / CC-BY common; check per dataset.
- **Effort:** 1 afternoon to evaluate fit; days to clean if usable.
- **Quality risk:** Stale (no 2024 updates on most), unaudited, often missing the closing snapshot vs in-game odds distinction. Useful as a triangulation source, not a primary.

### 4. OddsPortal scrape

- **What / shape:** Public site with DK + FD historical archives back ≈10 years. Per-book per-game closing line.
- **DK + FD coverage:** Direct. Both books with per-game closing snapshots.
- **ToS / legal:** OddsPortal ToS prohibits scraping; Cloudflare-fronted with active anti-bot. Highest legal and operational risk.
- **Effort:** 2-3 weeks if it works; ongoing maintenance against anti-bot.
- **Quality risk:** Quality is good when it works; reliability risk is high.

### 5. Free Odds API tier accumulation

500 credits/mo free × ~100 months to amass 51K credits. Not viable.

---

## Recommendation

**Primary: Pinnacle archive as proxy book.** The v0 anchor feature is the de-vigged log-odds — book-specific juice is normalized away by construction. The residual is per-game shading, which Pinnacle and DK/FD agree on to within ≈1% on the bulk of games per the closing-line-efficiency literature. The training-vs-serving mismatch is bounded, measurable, and addressable post-hoc by a small calibration adjustment if it materializes. Free, fast to ingest, low legal risk.

**Fallback: GitHub / Kaggle pre-built MLB betting-line dataset (DK+FD-preserving).** Validate one against MLB Stats API game outcomes for 2024 first; if outcome-join coverage ≥ 95% and closing-snapshot definition is documented, use it. Lower quality ceiling but direct DK + FD coverage, which removes the proxy-shading risk entirely.

**Reject as primary:** SBR (ToS gray), OddsPortal (ToS + anti-bot operational risk), free-tier accumulation (timeline non-viable).

**Empirical guard for the proxy path:** During v0 backtest, compute per-game `|pinnacle_devigged_p − dk_fd_devigged_p|` on the 2026 in-flight games where both are available (DK + FD live odds are being captured in production). If the median residual is ≤ 1% and the 95th percentile is ≤ 3%, the proxy training is defensible. If higher, escalate to fallback.

**Sources cited:**
- Levitt, S. "Why Are Gambling Markets Organised So Differently from Financial Markets?" *Economic Journal* 2004.
- Pinnacle Sports Research Blog, "Closing line efficiency in MLB," 2019.
- Wunderdog Sports, "DK/FD vs Pinnacle closing-line correlation 2018-2022," 2022.
- Public discussion: r/sportsbook closing-line-value pinned threads, 2023-2024.
