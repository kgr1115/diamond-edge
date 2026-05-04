# Compliance Determination: TN Ruling + Verified Helpline Numbers

**Date:** 2026-04-26
**Author:** mlb-compliance agent
**Status:** Attorney review required before any changes ship to production.

---

## Section 1: Tennessee (TN) — v1 Inclusion Ruling

### Determination: **TN IN**

### Reasoning

The locked v1 rule requires both DraftKings AND FanDuel to be fully licensed and operationally active for online sports wagering in a state.

**DraftKings Tennessee:**
- Licensed entity: Crown TN Gaming LLC (d/b/a DraftKings)
- License most recently renewed: October 24, 2024
- Status: Active, operational for online/mobile sports wagering
- Source: Tennessee Sports Wagering Council (SWAC) Approved Licensees page — https://www.tn.gov/swac/licensees-registrants.html (fetched 2026-04-26)

**FanDuel Tennessee:**
- Licensed entity: Betfair Interactive US LLC (d/b/a FanDuel Sportsbook)
- License most recently renewed: October 24, 2024
- Status: Active, operational for online/mobile sports wagering
- Source: Same SWAC Approved Licensees page (fetched 2026-04-26)

Tennessee sports wagering is online-only (no retail sportsbooks), fully legal under the Tennessee Sports Gaming Act. The state imposes a 10% hold requirement rather than a tax on gross gaming revenue, but that is a sportsbook obligation with no compliance impact for Diamond Edge as an information-only service. Minimum legal wagering age in TN is 21, consistent with our platform-wide gate.

**Confidence: High.** Both licenses confirmed directly from the state regulator's published licensee list.

### Current Code Conflict

- `middleware.ts` DEFAULT_ALLOW_STATES: TN is **absent**
- `app/geo-blocked/page.tsx` ALLOW_STATES: TN is **present**

This is a bug: TN users get blocked by middleware then see TN listed as supported on the block screen. The middleware is wrong; the geo-blocked page's list is correct (aside from one missing state — see below).

Note: The geo-blocked page also lists TN (25 states including TN) but middleware only has 24. The middleware comment says "24 states + DC" which is the correct count if TN is included — but TN is missing from the array. The discrepancy is a copy-paste omission in middleware.

### Required Implementation Change

Add `'TN'` to `DEFAULT_ALLOW_STATES` in `apps/web/middleware.ts`. No other changes required for TN inclusion.

### Tennessee Responsible Gambling Addendum

TN has a state-specific helpline: **Tennessee REDLINE, 1-800-889-9789** (call or text, 24/7). Source: tn.gov/swac and multiple TN-licensed operator disclosures. This number should be added to the STATE_HELPLINES map in `responsible-gambling-banner.tsx` — see Section 2.

### Canonical PR Sentence

> Compliance ruling 2026-04-26: Tennessee is IN for v1. Both DraftKings (Crown TN Gaming LLC) and FanDuel (Betfair Interactive US LLC) hold active SWAC licenses renewed October 2024 and are fully operational for online sports wagering; add TN to DEFAULT_ALLOW_STATES in middleware.ts.

---

## Section 2: Verified State-Specific Responsible Gambling Helpline Numbers

### Critical Background: National Helpline Landscape Has Changed (January 2026)

Two material changes since the original banner was written:

1. **1-800-GAMBLER is no longer the NCPG national number.** The National Council on Problem Gambling lost legal rights to 1-800-GAMBLER effective September 29, 2025 (court order). The number reverted to its original owner, the Council on Compulsive Gambling of New Jersey (CCGNJ). NCPG launched **1-800-MY-RESET (1-800-697-3738)** as the new national helpline in January 2026. Source: NCPG press release 2026-01-29 — https://www.ncpgambling.org/news/1-800-my-reset-announcement/

2. **1-800-522-4700 remains active.** NCPG confirmed the legacy number stays live with no announced retirement date. Source: https://www.ncpgambling.org/1-800-my-reset-national-problem-gambling-helpline-faq/

3. **1-800-GAMBLER (1-800-426-2537) is still operational** — now solely run by CCGNJ. States that directed licensees to use 1-800-GAMBLER (IL, PA, MI, CO) are using the CCGNJ-operated line. As of the research date these states' regulators had not issued directives changing this number, so it remains the correct display number for those states.

**Implication for Diamond Edge:** The component currently hard-codes `tel:18005224700` for the `href` on every variant regardless of state. The banner shows state-specific display text but dials the wrong number for state-specific lines. Both bugs must be fixed by the implementer: display text AND tel href must be state-aware.

### Fallback Number Update

The current fallback `1-800-522-4700` → `tel:18005224700` is still active and routes calls. However, NCPG is transitioning awareness to 1-800-MY-RESET. **Recommendation:** update the fallback to the new primary national line:

- **Display:** `1-800-MY-RESET (1-800-697-3738)`
- **tel href:** `tel:18006973738`
- **Source:** https://www.ncpgambling.org/help-treatment/about-the-national-problem-gambling-helpline/ (fetched 2026-04-26)

**Attorney-review item:** Confirm whether any v1 states' gaming regulations mandate specific helpline text verbatim (some states require exact "1-800-GAMBLER" display per operator agreement). If yes, the per-state override table handles it; the national fallback change is safe regardless.

### Verified Helpline Numbers Table

States are all 24 current v1 states + DC + TN (if added per Section 1 ruling above).

| State | Display Text (recommended) | E.164 tel href | Source URL | Confidence |
|-------|---------------------------|----------------|------------|------------|
| AZ | 1-800-NEXT-STEP (1-800-639-8783) | tel:18006398783 | https://problemgambling.az.gov/ (AZ Dept of Gaming, Division of Problem Gambling) | High |
| AR | 1-800-MY-RESET (1-800-697-3738) | tel:18006973738 | https://www.ncpgambling.org/help-treatment/help-by-state/arkansas/ — no state-dedicated line found | Medium |
| CO | 1-800-GAMBLER (1-800-426-2537) | tel:18004262537 | https://sbg.colorado.gov/problem-gambling-resources — CO Division of Gaming directed continued use of 1-800-GAMBLER per Sept 2025 notice; CCGNJ now operates the line | High |
| CT | 1-800-MY-RESET (1-800-697-3738) | tel:18006973738 | https://www.ncpgambling.org/help-treatment/help-by-state/connecticut/ — no state-dedicated line found | Medium |
| DC | 1-800-MY-RESET (1-800-697-3738) | tel:18006973738 | https://www.ncpgambling.org/help-treatment/help-by-state/district-of-columbia/ — no state-dedicated line found | Medium |
| IL | 1-800-GAMBLER (1-800-426-2537) | tel:18004262537 | https://illinoisproblemgambling.org/ (Illinois Council on Problem Gambling — official state affiliate) | High |
| IN | 1-800-9-WITH-IT (1-800-994-8448) | tel:18009948448 | https://www.in.gov/igc/problemgamblinghelp/problem-gambling-resources/ (Indiana Gaming Commission) | High |
| IA | 1-800-BETS-OFF (1-800-238-7633) | tel:18002387633 | https://hhs.iowa.gov/programs/programs-and-services/office-problem-gambling (Iowa HHS / Your Life Iowa) | High |
| KS | 1-800-MY-RESET (1-800-697-3738) | tel:18006973738 | https://www.ncpgambling.org/help-treatment/help-by-state/kansas/ — no state-dedicated line found | Medium |
| KY | 1-800-MY-RESET (1-800-697-3738) | tel:18006973738 | https://www.ncpgambling.org/help-treatment/help-by-state/kentucky/ — no state-dedicated line found | Medium |
| LA | 1-800-MY-RESET (1-800-697-3738) | tel:18006973738 | https://www.ncpgambling.org/help-treatment/help-by-state/louisiana/ — no state-dedicated line found | Medium |
| MA | 1-800-327-5050 | tel:18003275050 | https://maproblemgamblinghelpline.org/ (MA Dept of Public Health — official Commonwealth helpline) | High |
| MD | 1-800-MY-RESET (1-800-697-3738) | tel:18006973738 | https://www.ncpgambling.org/help-treatment/help-by-state/maryland/ — no state-dedicated line found | Medium |
| MI | 1-800-GAMBLER (1-800-426-2537) | tel:18004262537 | https://www.michigan.gov/mgcb/news/2024/02/08/mi-adopts-1800gambler (MI Gaming Control Board Feb 2024 — primary number; 1-800-270-7117 still routes) | High |
| MO | 1-800-MY-RESET (1-800-697-3738) | tel:18006973738 | https://www.ncpgambling.org/help-treatment/help-by-state/missouri/ — no state-dedicated line found | Medium |
| NC | 1-800-MY-RESET (1-800-697-3738) | tel:18006973738 | https://www.ncpgambling.org/help-treatment/help-by-state/north-carolina/ — no state-dedicated line; NC Council on PG org line (336-681-8516) is not a public crisis line | Medium |
| NJ | 1-800-GAMBLER (1-800-426-2537) | tel:18004262537 | https://800gambler.org/ (Council on Compulsive Gambling of NJ — original owner/operator, confirmed active 2026) | High |
| NY | 1-877-8-HOPENY (1-877-846-7369) | tel:18778467369 | https://oasas.ny.gov/hopeline (NYS Office of Addiction Services and Supports — confirmed active 2026) | High |
| OH | 1-800-589-9966 | tel:18005899966 | https://www.ohiomhas.gov/ via Ohio Casino Control Commission partnership; confirmed by multiple state-licensed operator disclosures 2026 | High |
| PA | 1-800-GAMBLER (1-800-426-2537) | tel:18004262537 | https://pacouncil.com/helpline/ (Council on Compulsive Gambling of PA — confirmed active, 24/7) | High |
| TN | 1-800-889-9789 (TN REDLINE) | tel:18008899789 | Tennessee REDLINE, state-funded and published by SWAC-licensed operators; confirmed via SWAC FAQ and operator disclosures | High |
| VA | 1-800-MY-RESET (1-800-697-3738) | tel:18006973738 | https://www.ncpgambling.org/help-treatment/help-by-state/virginia/ — no state-dedicated line found | Medium |
| VT | 1-800-MY-RESET (1-800-697-3738) | tel:18006973738 | https://www.ncpgambling.org/help-treatment/help-by-state/vermont/ — no state-dedicated line found | Medium |
| WV | 1-800-MY-RESET (1-800-697-3738) | tel:18006973738 | https://www.ncpgambling.org/help-treatment/help-by-state/west-virginia/ — no state-dedicated line found | Medium |
| WY | 1-800-MY-RESET (1-800-697-3738) | tel:18006973738 | https://www.ncpgambling.org/help-treatment/help-by-state/wyoming/ — no state-dedicated line found | Medium |
| **FALLBACK** | 1-800-MY-RESET (1-800-697-3738) | tel:18006973738 | https://www.ncpgambling.org/help-treatment/about-the-national-problem-gambling-helpline/ | High |

### Notes on Specific States

**Iowa:** State uses "1-800-BETS-OFF" as the distinctive Iowa gambling helpline, operated through Iowa HHS / Your Life Iowa (855-581-8111 is the general Your Life Iowa crisis line). The BETS-OFF number is more recognizable and specific to gambling in IA. E.164 for 1-800-238-7633: `tel:18002387633`.

**Indiana:** "1-800-9-WITH-IT" is the Indiana Gaming Commission published helpline. E.164 for 1-800-994-8448: `tel:18009948448`. Note: the NCPG state page now redirects to 1-800-MY-RESET, but the IGC's own page still cites 1-800-9-WITH-IT. Use the IGC number — it is the state regulator's published line.

**Michigan:** 1-800-GAMBLER is the official primary number adopted by Michigan Gaming Control Board February 2024. The legacy 1-800-270-7117 still routes calls from MI to MDHHS; use 1-800-GAMBLER as display/primary. Note: 1-800-GAMBLER is now operated by CCGNJ, not NCPG, but MGCB has not issued a new directive as of research date.

**Colorado:** CO Division of Gaming issued a Sept 25, 2025 directive to continue using 1-800-GAMBLER. The CCGNJ-operated line is the correct number. This remains the officially directed CO number.

**Illinois:** Illinois Council on Problem Gambling (NCPG state affiliate) continues to publish 1-800-GAMBLER as the primary helpline as of research date.

**Medium-confidence states:** AR, CT, DC, KS, KY, LA, MD, MO, NC, VA, VT, WV, WY have no state-dedicated gambling helplines. The national line (now 1-800-MY-RESET) is the correct resource. This is a lower confidence rating not because the number is wrong, but because we have not verified directly from each state gaming regulator's website (many returned 403 errors or don't publish a gambling-specific page).

### Component Implementation Spec for Implementer

Replace the static `STATE_HELPLINES` map and the hard-coded `tel:18005224700` href in `responsible-gambling-banner.tsx` with the following:

```typescript
const STATE_HELPLINES: Record<string, { display: string; tel: string }> = {
  AZ: { display: '1-800-NEXT-STEP (1-800-639-8783)', tel: 'tel:18006398783' },
  CO: { display: '1-800-GAMBLER (1-800-426-2537)',   tel: 'tel:18004262537' },
  IL: { display: '1-800-GAMBLER (1-800-426-2537)',   tel: 'tel:18004262537' },
  IN: { display: '1-800-9-WITH-IT (1-800-994-8448)', tel: 'tel:18009948448' },
  IA: { display: '1-800-BETS-OFF (1-800-238-7633)',  tel: 'tel:18002387633' },
  MA: { display: '1-800-327-5050',                    tel: 'tel:18003275050' },
  MI: { display: '1-800-GAMBLER (1-800-426-2537)',   tel: 'tel:18004262537' },
  NJ: { display: '1-800-GAMBLER (1-800-426-2537)',   tel: 'tel:18004262537' },
  NY: { display: '1-877-8-HOPENY (1-877-846-7369)',  tel: 'tel:18778467369' },
  OH: { display: '1-800-589-9966',                    tel: 'tel:18005899966' },
  PA: { display: '1-800-GAMBLER (1-800-426-2537)',   tel: 'tel:18004262537' },
  TN: { display: '1-800-889-9789 (TN REDLINE)',      tel: 'tel:18008899789' },
};

const FALLBACK_HELPLINE = {
  display: '1-800-MY-RESET (1-800-697-3738)',
  tel: 'tel:18006973738',
};
```

All remaining v1 states (AR, CT, DC, KS, KY, LA, MD, MO, NC, VA, VT, WV, WY) fall through to FALLBACK_HELPLINE. The `tel` href on both `banner` and `footer` variants must use the state-resolved `tel` value, not the hard-coded `tel:18005224700`.

---

## Attorney-Review Items

1. **TN inclusion:** Confirm no additional registration, filing, or disclosure requirement applies to Diamond Edge as a tout/handicapper service under Tennessee law before TN users are unblocked.

2. **1-800-GAMBLER post-CCGNJ transition:** For states that mandate "1-800-GAMBLER" verbatim in licensed-operator disclosures (IL, MI, CO, PA) — confirm whether that obligation extends to unlicensed information services like Diamond Edge, or whether it is a sportsbook-specific requirement. If it does extend to us, the CCGNJ-operated number is still correct.

3. **National fallback number change:** Confirm whether any v1 state's gaming regulations or operator agreements specify "1-800-522-4700" by E.164 digits (not just the vanity number). If so, retain 18005224700 as an additional displayed option.

4. **Medium-confidence states:** AR, CT, DC, KS, KY, LA, MD, MO, NC, VA, VT, WV, WY — review whether any of these states have adopted specific problem gambling helpline display requirements for online services since 2025.

5. **Iowa BETS-OFF number:** Confirm 1-800-BETS-OFF (1-800-238-7633) is still the Iowa HHS/IRGC-directed number and has not been replaced by 1-800-MY-RESET post the national line transition.

---

*This document is research and draft copy only. It does not constitute legal advice. A licensed attorney must review all compliance determinations before production deployment.*
