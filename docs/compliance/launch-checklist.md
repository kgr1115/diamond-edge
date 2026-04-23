# Diamond Edge — Pre-Launch Legal Checklist v1

**Status:** Draft — ATTORNEY REVIEW REQUIRED
**Date:** 2026-04-22
**Author:** mlb-compliance
**Owner:** Kyle Rauch (founder) — responsible for completing each item
**Note:** This checklist is research-based, not legal advice. An attorney must review and add to it before launch.

---

## How to Use This Checklist

Each item has a status indicator:
- [ ] = Not started
- [~] = In progress
- [x] = Complete
- [A] = Requires attorney review or completion

Items marked [A] cannot be self-completed by the founder — they require licensed attorney work.

---

## Category 1: Entity Formation

- [ ] **Form a legal entity (LLC strongly recommended) before launch.**
  - Operating as a sole proprietor exposes personal assets to liability from user disputes or regulatory action.
  - Recommended: Single-member LLC in a favorable state (Delaware or Wyoming for IP-holding; home state for simplicity).
  - This should happen BEFORE any paid subscriptions are collected.
  - Timeline: File → ~2–4 weeks for state processing. Apply for EIN immediately after.

- [ ] **Obtain an EIN (Employer Identification Number) from the IRS.**
  - Required for business banking and Stripe account setup.
  - Free, takes 15 minutes at irs.gov.

- [ ] **Open a dedicated business bank account.**
  - Do not commingle personal and business funds.
  - Required for Stripe payouts and accurate accounting.

- [ ] **Register for state taxes in your home state** (where the LLC is formed or where you work).
  - Consult a CPA. SaaS products may have sales tax obligations in some states.

---

## Category 2: Trademark & Brand

- [A] **USPTO trademark clearance: "Diamond Edge"**
  - Search at [tmsearch.uspto.gov](https://tmsearch.uspto.gov) for "Diamond Edge."
  - Known filing: "Diamond Edge Technology LLC" has 3 filings. An attorney must determine whether these filings conflict with use in the sports information / SaaS category.
  - Yellow flag: `diamondedge.io` was registered 2026-02-08 (privacy-protected owner). Monitor for brand squatting.
  - **Do not launch with the Diamond Edge brand until an attorney clears trademark risk.**
  - Option: File a use-based trademark application in Class 41 (entertainment / sports information services) after attorney clearance.

- [x] **Secure the primary domain: diamond-edge.co** (purchased 2026-04-23 via Cloudflare).
  - DNS + Vercel + Supabase + Stripe wiring pending — see `docs/runbooks/domain-migration-diamond-edge-co.md`.

- [ ] **Purchase `diamondedge.io` defensively if budget allows.**
  - Currently registered (privacy-protected). Monitor WHOIS. If it becomes available, consider acquiring to prevent brand confusion.

---

## Category 3: Legal Documents

- [A] **Terms of Service (ToS) — attorney drafts final version**
  - Draft by compliance agent (in progress). Attorney must finalize before publishing.
  - Must include:
    - "Information only" / "not a sportsbook" language
    - No guarantee of outcomes
    - 21+ age requirement
    - Geographic restriction acknowledgment
    - VPN/proxy prohibition (for geo-bypass prevention)
    - Arbitration clause (strongly recommended)
    - Class action waiver (strongly recommended)
    - Limitation of liability clause
    - DMCA policy
    - Governing law / jurisdiction clause
  - Must be live on the site before first paid subscription.

- [A] **Privacy Policy — attorney reviews draft**
  - Diamond Edge is US-only; GDPR is not required.
  - CCPA/CPRA: Applies if any California resident data is processed. Even with geo-blocking, California users may reach the site (e.g., through VPN or during the brief window before geo-block activates). The privacy policy should include CCPA-compliant disclosures.
  - Must include: data collected, purpose, third-party sharing (Stripe, Supabase, Anthropic API), retention, user rights.
  - Must be live before first paid subscription.

- [A] **Responsible Gambling Policy page**
  - Link from footer. References NCPG resources, state hotlines, self-exclusion options.
  - Draft content: see `docs/compliance/copy/responsible-gambling.md`.
  - Attorney review for completeness.

---

## Category 4: Age Verification & Geo-Blocking (Technical — must be live and tested)

- [ ] **Age gate implemented and QA-tested**
  - Server-side DOB verification (age >= 21).
  - Failure locks account from pick content.
  - Audit log writes on every attempt.
  - QA test: verify that a 20-year-old DOB fails, a 21-year-old DOB passes.

- [ ] **Geo-blocking implemented and QA-tested**
  - Edge Middleware checks IP geolocation.
  - Blocked state users see geo-gate page (not picks).
  - Backend API routes enforce geo-block as defense in depth.
  - QA test: verify using a VPN set to a BLOCK state that picks are inaccessible.

- [ ] **21+ notice visible on every pick surface (not just at signup)**
  - Footer carries "21+" text.
  - Subscription page carries 21+ disclosure.

---

## Category 5: Responsible Gambling Copy (must be live on all surfaces)

- [ ] Picks page header/footer disclaimer — live
- [ ] Subscription sign-up page disclaimer — live
- [ ] Onboarding responsible gambling acknowledgment (with checkboxes) — live
- [ ] Site-wide footer — live
- [ ] Pick detail page sidebar — live
- [ ] Dedicated `/responsible-gambling` page with full NCPG resources — live

---

## Category 6: Financial / Payment Compliance

- [ ] **Stripe account created under the LLC entity, not personal.**
  - Set up Stripe in live mode (not test mode) before accepting real subscriptions.
  - Configure webhook endpoint and validate Stripe signature in code.

- [ ] **Stripe restricted key in production** (webhook secret, no full API key exposure).

- [ ] **Subscription cancellation flow implemented.**
  - Users can cancel anytime from account settings (required by most states' consumer protection laws and by Stripe's terms).

- [ ] **Refund policy documented in ToS.**
  - Recommend: no refunds on used subscription periods; prorated or full refund on cancellation within first 7 days. Attorney to advise.

- [ ] **Do not store credit card numbers.** (Stripe tokenization handles this — confirm no PAN logging in server logs.)

---

## Category 7: State-Specific Tout Service Review

- [A] **Attorney review: Is Diamond Edge required to register as a "handicapper" or "tout service" in any ALLOW state?**
  - No such requirement was identified in research, but attorney must positively confirm for each ALLOW state before launch.
  - States warranting extra scrutiny: New York, Louisiana, Pennsylvania (historically active gaming regulators).
  - If any state requires registration, that state must be blocked until registration is complete.

---

## Category 8: Operational Readiness

- [ ] **Quarterly compliance review scheduled.**
  - State sports betting laws change fast. Schedule a calendar reminder every 90 days to check:
    - New states where both DK + FD have become operational (new ALLOW candidates).
    - Any ALLOW state that has changed its laws or regulatory posture.
    - Any new tout-service registration requirement enacted.
  - Update `docs/compliance/state-matrix.md` and `geo_blocked_states` table accordingly.

- [ ] **Support email and contact page live before launch.**
  - Required for user inquiries, geo-gate appeals, and responsible gambling contact.

- [ ] **Data retention policy defined.**
  - How long do we keep `age_gate_logs`? Recommend 5 years (consistent with financial record-keeping norms).
  - How long do we keep `bankroll_entries` after account deletion? Recommend 3 years, then purge.

---

## Attorney-Review Consolidated List

Items requiring attorney work before launch:

1. Trademark clearance: "Diamond Edge" — conflict check against "Diamond Edge Technology LLC" filings.
2. ToS final draft and review.
3. Privacy Policy review (CCPA/CPRA exposure with geo-blocking in place).
4. Confirm DOB self-attestation is legally sufficient age verification in all 25 ALLOW states.
5. Confirm no tout-service / handicapper registration requirement in any ALLOW state.
6. Review geo-blocking spec for legal adequacy in all ALLOW states.
7. Review responsible gambling copy for any required additions or modifications.
8. Advise on refund policy language.
9. Confirm Louisiana parish-level compliance is handled by IP geo at the state level.

---

## Pre-Launch Gate

The following items are HARD BLOCKERS — do not collect a single dollar of subscription revenue until all are complete:

- [ ] LLC formed
- [ ] Trademark cleared (attorney)
- [ ] ToS and Privacy Policy live (attorney-reviewed)
- [ ] Age gate live and tested
- [ ] Geo-blocking live and tested
- [ ] Responsible gambling copy on all surfaces
- [ ] Stripe in live mode under LLC
- [ ] Tout-service review complete (attorney)
