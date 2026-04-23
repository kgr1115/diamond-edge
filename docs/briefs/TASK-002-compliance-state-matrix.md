# TASK-002 — Compliance: DK + FD Legal-State Intersection Matrix

**Status:** In Progress (spawned 2026-04-22)
**Owner:** mlb-compliance
**Unblocks:** Backend geo-blocking implementation, Frontend geo-block UX, Launch geography decision

---

## Objective

Deliver the authoritative v1 launch-state matrix: every US state classified as ALLOW / BLOCK / GRAY, based on the intersection of states where both DraftKings and FanDuel are currently fully legal and operational for sports betting.

---

## Context

- Diamond Edge is an information/analysis service (picks, stats, rationale) — not a sportsbook. We do not place bets or hold funds. This narrows regulatory exposure significantly, but "tout service" / "handicapper" rules still apply per state and must be checked.
- Sportsbooks covered in v1: DraftKings + FanDuel only. A state must have both operational to be ALLOW.
- Age gate: 21+ everywhere, even if the state's betting age is 18+.
- Responsible gambling copy is a product surface, not a footnote.
- We are US-only for v1. GDPR is not a concern. CCPA/CPRA applies if California users can reach the site — but CA will likely be blocked (verify DK/FD status there).
- Legal posture: when uncertain, block for v1. Reopen post-launch with attorney guidance.
- This output is attorney-review-required before launch. Flag every item that needs legal sign-off.

---

## Inputs

- `CLAUDE.md` — locked decisions
- DraftKings operational state map: https://www.draftkings.com/help/sportsbook (verify current states)
- FanDuel operational state map: https://www.fanduel.com/sportsbook (verify current states)
- State gaming commission statutes or AGA (American Gaming Association) state tracker for tout-service / handicapper rules
- NCPG (National Council on Problem Gambling) responsible gambling resources

---

## Deliverables

### 1. State Matrix (`docs/compliance/state-matrix.md`)

One row per US state + DC (51 entries). Columns:
- State name + abbreviation
- DK operational (yes/no/unknown)
- FD operational (yes/no/unknown)
- v1 verdict: ALLOW / BLOCK / GRAY
- Tout-service / handicapper registration required (yes/no/unknown/attorney-check)
- Source/reference URL for DK status
- Source/reference URL for FD status
- Notes (any edge cases, age requirements, specific restrictions)
- Confidence: HIGH / MEDIUM / LOW

Gray = DK or FD is legal but not both, or legal posture on tout services is ambiguous. Block all GRAY states for v1.

### 2. Engineering Spec for Geo-Blocking (`docs/compliance/geo-block-spec.md`)

Specify how geo-blocking should work technically (frontend + backend implement from this spec):
- How user location is determined (IP geolocation? self-reported state? both?)
- What to show blocked users (landing page copy, cannot-access message)
- Edge cases: VPN detection (required or best-effort?), users traveling, state-line ambiguity
- What data the backend needs to store/check at session time
- Whether blocked users can browse any content or are fully walled
- How ALLOW/BLOCK list is maintained (hardcoded? DB-driven? how updated?)

### 3. Responsible Gambling Copy (`docs/compliance/copy/responsible-gambling.md`)

Draft copy for the following surfaces:
- Picks page header/footer disclaimer (short, ~2-3 sentences)
- Subscription sign-up page disclaimer (medium, should include resources)
- Onboarding flow step (full responsible gambling acknowledgment, required checkbox)
- Site-wide footer (brief, always present)
- Pick detail page sidebar (brief, picks-specific: "Past performance does not guarantee future results" style)

All copy must include:
- National problem gambling hotline: 1-800-522-4700 (NCPG)
- State-specific lines where applicable (note which states have them; frontend can inject dynamically)
- Real help language — not legalese

### 4. Age Gate Spec (`docs/compliance/age-gate-spec.md`)

Specify the 21+ enforcement:
- Where in the user flow the gate appears (pre-auth? post-signup? both?)
- What it asks (DOB entry? checkbox? both?)
- What happens to users who fail (blocked, can they retry?)
- Whether DOB is stored (and in what form — full DOB vs age flag only)
- Attorney-review items specific to age gate

### 5. Pre-Launch Legal Checklist (`docs/compliance/launch-checklist.md`)

Items that must be complete before v1 goes live:
- [ ] USPTO trademark clearance ("Diamond Edge" — flag existing "Diamond Edge Technology LLC" filings)
- [ ] Attorney review of ToS and Privacy Policy
- [ ] Entity formation (LLC recommended — timing: before launch)
- [ ] State-specific tout-service registration requirements (if any ALLOW states require it)
- [ ] Terms of Service published (draft OK, final requires attorney)
- [ ] Privacy Policy published
- [ ] Age gate implemented and tested
- [ ] Geo-blocking live and tested
- [ ] Responsible gambling copy live on all specified surfaces
- [ ] "Not a sportsbook" / "Information only" disclaimer in ToS and on site
- Any additional items you identify

---

## Definition of Done

- [ ] All 51 states classified (ALLOW / BLOCK / GRAY) with source citations
- [ ] Every ALLOW state checked for tout-service / handicapper registration requirement
- [ ] Geo-block spec covers the edge cases listed above
- [ ] Responsible gambling copy drafted for all 5 surfaces
- [ ] Age gate spec covers DOB storage decision and retry behavior
- [ ] Launch checklist is complete and explicit about attorney-review items
- [ ] GRAY states have an explanation of what must change to move them to ALLOW
- [ ] Every state determination cites an authoritative source (not inference)
- [ ] Attorney-review list is consolidated in one place

---

## Dependencies

- No blockers. This task reads public information and CLAUDE.md.
- Output unblocks: Backend engineer (geo-block DB fields), Frontend engineer (geo-block UX, RG copy placement), Legal attorney review (launch checklist).

---

## Notes

- You are not a licensed attorney. Every draft requires attorney sign-off before publishing. Say so explicitly in the deliverables.
- When DK and FD operational maps conflict with state law information, flag the discrepancy — don't resolve it unilaterally.
- Quarterly review cadence for state law changes should appear in the launch checklist.
