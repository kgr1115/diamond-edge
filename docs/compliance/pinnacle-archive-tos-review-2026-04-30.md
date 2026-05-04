# Pinnacle Archive Odds — ToS Review
**Date:** 2026-04-30
**Scope:** Internal model training only (moneyline v0 closing-line anchor feature). No redistribution, no public display of Pinnacle lines, no production-cadence scraping.
**Not legal advice.** Attorney review required before committing to any path.

---

## Ratings

### Option 1 — Pinnacle's own historical odds API
**RED**

Pinnacle closed public API access on 2026-07-23 (confirmed via GitHub pinnacleapi/pinnacleapi-documentation). Access now requires a funded Pinnacle account or a bespoke commercial partnership approved by Pinnacle (api@pinnacle.com). Diamond Edge cannot open a funded Pinnacle account (Pinnacle is not available to US residents in most states). No public free tier exists. Using the API without authorization is not available as a path. Even if access were granted, Pinnacle's API documentation contains no explicit data-storage or redistribution terms, which creates ambiguity that requires attorney review before any commercial derivative work.

**Do not use.**

### Option 2 — Scrape an archive site (OddsPortal or Sportsbookreview.com)
**RED**

Both sites contain explicit anti-scraping language with no commercial-use carve-out:

- **OddsPortal** (terms fetched directly): "You must not burden our server…with automated requests." "You are not permitted to use our content…by embedding, aggregating, scraping or recreating it without our express consent." "No extraction (copying)…of the Database Content…is permitted without our express consent." Commercial use is prohibited outright.
- **Sportsbookreview.com** (terms fetched directly): Prohibits "any automatic device or manual process to monitor or reproduce the Site or Materials." Liquidated damages clause: $5,000 per violation plus attorney fees. Explicit statement that scraping is not fair use.

The fact that open-source scrapers exist for both sites does not create legal cover — it reflects enforcement inconsistency, not permission. For a paid commercial SaaS, the risk profile is materially higher than a one-off research script.

**Do not use.**

### Option 3 — Pre-built Kaggle / GitHub dataset (e.g., marcoblume/pinnacle.data)
**YELLOW**

The most defensible path, with caveats:

**What exists:** `marcoblume/pinnacle.data` (also mirrored to CRAN) is an R package containing Pinnacle MLB and other market odds. License is GPL-3. GPL-3 permits commercial use. However, the dataset covers **2016 only** — it does not reach 2022–2024, the target backfill window.

**The core problem:** No confirmed Kaggle or GitHub dataset with a clean open license (CC0, MIT, or GPL) covering Pinnacle MLB closing lines for 2022–2024 was found in this review. The search returned no MLB-specific Pinnacle dataset at that vintage with documented provenance. Any dataset found on Kaggle must be individually checked for: (a) explicit license, (b) stated source of the underlying odds data, (c) whether the uploader had authorization to republish Pinnacle's data.

**The GPL-3 derivative-work constraint:** GPL-3 requires that derivative works also be released under GPL-3. If a trained model artifact is considered a derivative work of the training data (contested legal theory, unresolved by US courts), that could require open-sourcing the model. This is a genuine attorney-review item — the majority practitioner view is that model weights are not a GPL-3 derivative of training data, but there is no settled precedent.

**Use with conditions (see below).**

---

## Recommendation

**Primary:** Option 3 (pre-built dataset), **but only after** vetting a specific dataset for all three criteria: explicit open license, stated data provenance, and temporal coverage of 2022–2024. If no such dataset exists with clean provenance, escalate to user before proceeding.

**Fallback:** Contact Pinnacle directly (api@pinnacle.com) to describe the use case — "academic/research-grade historical MLB closing lines for internal ML training; no redistribution; paid SaaS." Pinnacle explicitly lists "academics and pregame handicapping projects" as a support category. A written permission email is worth more than any license parsing.

**Do not use Options 1 or 2 as described.**

---

## Attorney-Review Items

1. Whether GPL-3 trained-on data propagates to model weights — practitioner consensus says no, but no settled US precedent.
2. If Pinnacle email permission is obtained, whether a written email constitutes sufficient authorization for internal commercial training use, or whether a formal data licensing agreement is needed.
3. Whether any Kaggle dataset republishing Pinnacle odds without Pinnacle's explicit authorization creates downstream liability for Diamond Edge as a commercial user of that dataset.

---

## Engineering Handoff

None — this review does not approve any fetch path. mlb-data-engineer should hold on backfill implementation until a specific dataset is identified and cleared per Option 3 conditions above, or Pinnacle email authorization is obtained.

---

## Sources Consulted

- Pinnacle API closure: https://github.com/pinnacleapi/pinnacleapi-documentation
- OddsPortal terms: https://www.oddsportal.com/terms/ (fetched directly)
- Sportsbookreview.com terms: https://www.sportsbookreview.com/terms-of-use/ (fetched directly; liquidated damages clause confirmed)
- marcoblume/pinnacle.data license: https://github.com/marcoblume/pinnacle.data/blob/master/DESCRIPTION (GPL-3, 2016 data only)
- Pinnacle Kaggle/GitHub search: no 2022–2024 MLB dataset with clean provenance found
- Pinnacle support categories: https://github.com/pinnacleapi/pinnacleapi-documentation README

**Confidence:** High on Options 1 and 2 (explicit ToS language confirmed). Medium on Option 3 (no specific 2022–2024 dataset confirmed; license analysis contingent on what dataset is actually selected).
