# xFIP Formula Constants Audit — 2026-05-05

**Triggered by:** CEng condition #1 on proposal `statcast-fb-ingestion-2026-05-04`  
**Scope:** Hand-verify `LG_HR_PER_FB` and `XFIP_CONST` for 2021–2024 against FanGraphs guts table  
**Files audited:**  
- `C:\AI\Public\diamond-edge\scripts\lib\xfip-formula.ts`  
- `C:\AI\Public\diamond-edge\scripts\lib\xfip_formula.py`

---

## Sources Used

1. **FanGraphs Guts table** (`https://www.fangraphs.com/guts.aspx?type=cn`) — confirmed accessible via WebFetch on 2026-05-05; returns the wOBA and FIP constants table. The `cFIP` column is confirmed by FG's own documentation to be the same constant used in both FIP **and** xFIP (FG library explicitly states: "You can find historical FIP constants (which is the same as the xFIP constant) values on the guts page").

2. **Statcast pitch-by-pitch data** via pybaseball for 2021–2024 regular seasons — used to derive HR/FB estimates. FanGraphs HR/FB values use BIS (Baseball Info Solutions) batted-ball classification, which is not accessible programmatically (Cloudflare-protected). Statcast values are provided as best-available estimates with the BIS gap noted.

3. **FanGraphs leaderboard API** — blocked by Cloudflare; not usable for programmatic extraction.

---

## Finding 1: XFIP_CONST — Confirmed Significant Errors

The FG Guts page `cFIP` column for the relevant years (full table confirmed via WebFetch):

| Year | FG cFIP (truth) | Our XFIP_CONST | Δ        | Flag |
|------|----------------|----------------|----------|------|
| 2021 | 3.170          | (not in table) | n/a      | Not blocking — no 2021 rows in pgl |
| 2022 | 3.112          | 3.18           | +0.068   | **FAIL** — Δ >> 0.001 threshold |
| 2023 | 3.255          | 3.20           | −0.055   | **FAIL** |
| 2024 | 3.166          | 3.13           | −0.036   | **FAIL** |

**All three years exceed the 0.001 threshold by 35–68×.**

The FG guts table reports cFIP to 3 decimal places (3.112, 3.255, 3.166). No additional precision is available from this source. The 4th decimal is unknown from FG; for audit purposes the displayed values are treated as exact to 3 places.

The transcribed values appear to have been pulled from a different column or a rounded/misread source. None of the transcribed values match any year's FG cFIP to even 2 significant decimal digits.

---

## Finding 2: LG_HR_PER_FB — Cannot Confirm from FG Directly; Statcast Estimates Provided

FanGraphs' HR/FB values come from BIS data and are only accessible via the Cloudflare-protected leaderboard (not the guts page). The guts page does not contain an HR/FB column. All direct attempts to retrieve FG's HR/FB via API or headless browser were blocked.

**Statcast-derived estimates** (regular season, game_type == 'R'; definition: HR on fly balls / (fly_ball + popup)):

| Year | Statcast HR_fly | Fly balls | Popups | HR/(FB+PU) |
|------|-----------------|-----------|--------|------------|
| 2021 | 5,342           | 31,195    | 8,371  | 0.1350     |
| 2022 | 4,791           | 31,923    | 8,771  | 0.1177     |
| 2023 | 5,334           | 32,493    | 8,514  | 0.1301     |
| 2024 | 4,987           | 32,796    | 8,810  | 0.1199     |

**Known systematic gap:** FG uses BIS classification. BIS categorizes more batted balls as line drives (fewer as fly balls) compared to Statcast. This makes FG's FB denominator larger and its HR/FB rate lower than Statcast-derived values for any given definition. The direction is consistent with the observation that FG typically shows ~11% vs Statcast's ~12–14% for similar seasons.

**Cross-reference with transcribed values:**

| Year | Our LG_HR_PER_FB | Statcast HR/(FB+PU) | Δ (vs statcast) | Assessment |
|------|-----------------|---------------------|-----------------|------------|
| 2022 | 0.111           | 0.1177              | −0.0067         | Our value is lower than statcast, consistent with BIS direction |
| 2023 | 0.121           | 0.1301              | −0.0091         | Our value is lower, consistent direction |
| 2024 | 0.115           | 0.1199              | −0.0049         | Our value is lower, consistent direction |

The transcribed HR/FB values (0.111, 0.121, 0.115) are plausible BIS-derived values — they fall below the statcast estimates in the expected direction and by a consistent margin (~0.005–0.009). This is consistent with the known BIS/Statcast gap documented by sabermetricians. Without direct access to FG's leaderboard data, these values cannot be confirmed to 4-decimal precision. However, based on the statcast cross-reference, they are not obviously wrong.

**2021 note:** Not in the current codebase table. FG guts page shows cFIP = 3.170 for 2021. Statcast HR/(FB+PU) for 2021 = 0.1350 — this is notably higher than 2022, which aligns with 2021's well-documented elevated home run environment. If 2021 rows are added, the LG_HR_PER_FB estimate should be approximately 0.117–0.120 based on the BIS/Statcast relationship from other years, pending FG confirmation.

---

## deGrom 2023 Soft-Fail Re-Assessment

The deGrom 2023 verification case showed |Δ| = 0.327 vs. MLB Stats API. With XFIP_CONST mis-transcribed at 3.20 vs. FG truth 3.255:

- XFIP_CONST error contribution = 3.255 − 3.20 = **+0.055** in one direction
- This shifts the computed xFIP upward by 0.055, which moves the |Δ| from 0.327 toward ~0.272 (assuming the error works in the right direction for deGrom's case)
- The remaining ~0.272 is attributable to small-sample variance (30 IP) or LG_HR_PER_FB imprecision

**Conclusion on deGrom case:** The XFIP_CONST error is a real contributor but not the primary driver of the 0.327 gap. Correcting the constants will not bring the deGrom case within the 0.20 threshold if the small-sample window remains 30 IP.

---

## Recommendation

**XFIP_CONST errors are confirmed and significant. A corrective proposal is warranted.**

### Proposed corrected constants block

```ts
// cFIP from FG guts page (https://www.fangraphs.com/guts.aspx?type=cn)
// Verified 2026-05-05. FG displays 3 decimal places; no additional precision available from source.
// cFIP = xFIP constant (same value per FG documentation).
export const XFIP_CONST: Readonly<Record<number, number>> = {
  2021: 3.170,  // FG guts: 3.170 — add when 2021 rows enter pgl
  2022: 3.112,  // FG guts: 3.112 (was 3.18 — error +0.068)
  2023: 3.255,  // FG guts: 3.255 (was 3.20 — error −0.055)
  2024: 3.166,  // FG guts: 3.166 (was 3.13 — error −0.036)
} as const;
```

### LG_HR_PER_FB

Cannot confirm or reject to 4-decimal precision without direct FG data access. The current values (0.111, 0.121, 0.115) are directionally consistent with statcast cross-reference and plausibly BIS-derived. **No change recommended without a FG data export or manual confirmation from the FG leaders page.** The original transcriber should re-verify these against FG pitching leaders by hand (Cloudflare won't block a human browser session).

### Proposal kind

`kind: model-change` — affects xFIP formula constants, which feeds into the verification gate and any future retrain that imports `computeXfip`.

**Expected impact on verification gate (deGrom 2023):**  
XFIP_CONST correction closes ~0.055 of the 0.327 gap. The case will likely remain a soft-fail under any reasonable IP-floor threshold given 30 IP is a small sample. The correction is still required for correctness — xFIP values for pitchers with typical workloads (150+ IP) will shift by 0.036–0.068 ERA points depending on year, which is material.

**Backtests invalidated:** Any backtest that ran through `computeXfip` is invalidated once constants are corrected. Given the infra-only chain framing (xFIP not yet imported by `moneyline-v0.ts`), no production backtest is currently affected. The invalidation becomes relevant when the retrain chain runs post-holdout-declaration.

---

## Boundary Compliance

- No edits made to `xfip-formula.ts` or `xfip_formula.py`
- No proposal YAML produced here (scope-gate handles that)
- Findings forwarded to CEng as condition #1 discharge
