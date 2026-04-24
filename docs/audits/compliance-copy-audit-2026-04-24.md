# Compliance Copy Freshness Audit — 2026-04-24 (Cycle 2, Proposal #9)

**Auditor:** implementer agent (AUDIT-ONLY mode)
**Scope:** 21+ age gate, geo-block, responsible-gambling (RG) disclaimers, ToS, Privacy Policy, marketing copy, email/subscriber comms.
**Method:** read every file under `docs/compliance/**` + every subscriber-facing page/component under `apps/web/app/**` and `apps/web/components/**` that renders a compliance surface; cross-reference against scope-gate annotations and CLAUDE.md brand/stack decisions.
**No code or copy was edited.** Every row below is a recommendation — any fix is a separate proposal.

Severity legend:
- **P0** — subscriber-facing bug that is visible today and breaks a compliance invariant (broken link on a required surface, missing required surface, claim that contradicts product reality in a regulator-attractive way).
- **P1** — inconsistency or stale copy that a regulator or attorney-review pass would flag.
- **P2** — polish / drift / redundancy that should be tightened but is not a blocker.

---

## 1. Per-surface findings

### 1.1  21+ Age Gate — `apps/web/app/age-gate/page.tsx`

| # | Current copy excerpt | Issue | Severity | Recommended rewrite (suggestion, not an edit) |
|---|---|---|---|---|
| AG-1 | `"You must be 21 or older to access this site."` + `<strong>21 or older</strong>` | Matches spec (`age-gate-spec.md`). No issue. | — | — |
| AG-2 | Failure message: `"You must be 21 or older to use Diamond Edge."` | Matches spec; does NOT leak whether DOB was too young vs. malformed (per spec §Failure Behavior). | — | — |
| AG-3 | Failure message: `"If you or someone you know needs support, call 1-800-522-4700 (National Problem Gambling Helpline, 24/7, free)."` | Good — RG hotline injected into failure screen. | — | — |
| AG-4 | Footer link: `"Problem gambling? 1-800-522-4700"` (no state-specific injection) | Age-gate page does not accept a `geoState` prop; spec §State-Specific Hotlines allows national default, so this is acceptable. A user's declared state isn't known until post-signup anyway. | — | — |
| AG-5 | Branding: `<h1>Diamond Edge</h1>` on full-bleed age-gate page. | Uses the "Diamond Edge" trademark prominently before USPTO clearance against "Diamond Edge Technology LLC" is complete. See §3 (Trademark-status audit). | P1 | Keep wordmark (reversal would cascade everywhere). Track under trademark-status workstream, not age-gate copy. |
| AG-6 | No state-selector anywhere on this screen. `age-gate-spec.md` §Placement says the hard DOB gate is step 2 of onboarding. | Matches spec. | — | — |
| AG-7 | Middleware `apps/web/middleware.ts` does NOT route to `/age-gate` for unverified users — only `app/page.tsx` does. Unverified users who navigate directly to `/picks/today` pass the geo middleware and get gated only by `app/page.tsx`'s redirect. | Bypass-by-URL risk. Not a copy issue but an age-gate scope item. Flagged for follow-up (NOT part of this audit's fix recommendations). | P1 (out of scope for this audit) | Raise as a separate proposal (age-gate middleware enforcement). Do not attempt here. |

### 1.2  Geo-block — `apps/web/app/geo-blocked/page.tsx`, `apps/web/middleware.ts`

| # | Current copy excerpt | Issue | Severity | Recommended rewrite |
|---|---|---|---|---|
| GB-1 | Heading: `"Not Available in Your Location"` | Matches `geo-block-spec.md` §Geo-Gate UX. | — | — |
| GB-2 | Body: `"Diamond Edge is currently available only in states where DraftKings and FanDuel are both fully licensed and operational. Your location is not yet supported."` | Matches spec — does not reveal the detected state, does not hint at VPN. | — | — |
| GB-3 | **State list drift — allowed-states count / composition mismatch.** `apps/web/app/geo-blocked/page.tsx` `ALLOW_STATES` array contains **25** entries (AZ, AR, CO, CT, DC, IL, IN, IA, KS, KY, LA, MD, MA, MI, MO, NJ, NY, NC, OH, PA, TN, VT, VA, WV, WY). `apps/web/middleware.ts` `DEFAULT_ALLOW_STATES` contains **24** entries — **missing TN**. `docs/compliance/state-matrix.md` lists 25 ALLOW jurisdictions including TN. | **Hard inconsistency.** Users in TN are told on the geo-block page that TN is a supported state (25 listed), but middleware blocks them. This is visible, testable, and a regulator/attorney red flag (the displayed allow-list is authoritatively the one the subscriber sees; the middleware is the one the subscriber hits). | **P0** | Either (a) add `TN` to `DEFAULT_ALLOW_STATES` in middleware (state-matrix.md is authoritative; it says TN is ALLOW) OR (b) remove TN from the geo-block page list. Per `docs/compliance/state-matrix.md` line 29/81, TN should be ALLOW → fix the middleware, not the copy. Do this as a separate single-file PR. |
| GB-4 | Middleware comment (line 8): `"canonical 25 jurisdictions (24 states + DC)"` | Contradicts the array, which has 24 entries. | P1 | Align comment and array together with the GB-3 fix. |
| GB-5 | `/geo-blocked` page has no link back to support or back to marketing. Spec §Geo-Gate Page Content says: `"Questions? Contact support at [support email]."` | Support-email placeholder was never filled in on this surface. ToS + Privacy use `support@diamond-edge.co`. | P1 | Append `"Questions? Contact support@diamond-edge.co."` (or the canonical support mailbox once verified). |
| GB-6 | No RG page link, no Terms / Privacy link from `/geo-blocked` page. | `GlobalFooter` is rendered on every route (`layout.tsx`), so users DO see those links — but the `/geo-blocked` page bypasses `TopNav` (nav hides on `/geo-blocked` per `top-nav.tsx:81`), which is correct. Footer links still present via layout. OK. | — | — |
| GB-7 | **Allow-states page list is hardcoded.** `geo-block-spec.md` §DB-Driven Block List says v1 can hardcode; v1.1 moves to DB. Still two hardcoded copies (middleware + page) are the underlying cause of GB-3. | Structural risk. Flag for structural follow-up. | P2 | Single source of truth: export the ALLOW list from one module (`apps/web/lib/compliance/allow-states.ts`) and import in both middleware and `/geo-blocked` page. Separate proposal. |

### 1.3  Responsible-gambling disclaimer — multiple surfaces

Surface inventory (where the RG disclaimer renders to a subscriber):

| Surface | File | Variant |
|---|---|---|
| Site-wide footer (every page) | `apps/web/components/layout/global-footer.tsx` | "Information service" footer |
| Picks slate header banner | `apps/web/components/picks/responsible-gambling-banner.tsx` (surface=`banner`) | Amber slim banner |
| Picks slate below-slate footer | `apps/web/components/picks/responsible-gambling-banner.tsx` (surface=`footer`) | "Information and analysis service" footer w/ `ncpgambling.org` link |
| Pick detail page sidebar | `apps/web/app/picks/[id]/page.tsx` (inline "A note on risk") | Sidebar "note on risk" |
| Pick detail below-the-fold footer | `apps/web/app/picks/[id]/page.tsx` (renders `ResponsibleGamblingBanner` with surface=`footer`, **no `geoState` prop passed**) | "Information and analysis service" footer |
| Pricing page "Before you subscribe" panel | `apps/web/app/pricing/page.tsx` | Above-CTA RG block |
| Age-gate failure screen | `apps/web/app/age-gate/page.tsx` | Small helpline line |
| Terms page RG blockquote | `apps/web/app/terms/page.tsx` §6 | Inline blockquote |
| Terms page bottom footer | `apps/web/app/terms/page.tsx` | Duplicates GlobalFooter wording |
| Privacy page bottom footer | `apps/web/app/privacy/page.tsx` | Duplicates GlobalFooter wording |

| # | Current copy excerpt | Issue | Severity | Recommended rewrite |
|---|---|---|---|---|
| RG-1 | **No dedicated `/responsible-gambling` page exists.** `apps/web/app/responsible-gambling/**` returns empty glob; `docs/compliance/launch-checklist.md` Category 5 line 118 requires it. Both `GlobalFooter` AND `terms/page.tsx` AND `privacy/page.tsx` link to `/responsible-gambling` (3 occurrences). | **404 on 3 compliance-surface links.** Broken link on every page of the site. Regulator/attorney review would catch this immediately. | **P0** | Create `apps/web/app/responsible-gambling/page.tsx` consolidating the material from `docs/compliance/copy/responsible-gambling.md` (national + state hotlines, NCPG chat, self-exclusion callout). Separate proposal. |
| RG-2 | Canonical footer wording (GlobalFooter, Terms bottom, Privacy bottom): `"Diamond Edge is an information service. We do not place bets or hold funds on your behalf. 21+ only. Available only where DraftKings and FanDuel legally operate. Problem gambling? Call 1-800-522-4700 (24/7, free, confidential)."` | Duplicated verbatim in 3 places. Consistent today — fragile to drift tomorrow. `GlobalFooter` already renders on Terms and Privacy pages via `layout.tsx`, so the inner "RG footer" blocks on those two pages are structurally redundant. | P1 | De-duplicate: remove the bespoke footer blocks from `terms/page.tsx` and `privacy/page.tsx` (the layout-level `GlobalFooter` already covers them). Single source of truth = `GlobalFooter`. Separate proposal. |
| RG-3 | `responsible-gambling-banner.tsx` surface=`banner`: `"Diamond Edge provides information only — not financial advice. If gambling affects your life, call {helpline}."` | Matches `docs/compliance/copy/responsible-gambling.md` Surface 1 short version. Good. State helpline injection works (`STATE_HELPLINES` map). | — | — |
| RG-4 | `responsible-gambling-banner.tsx` surface=`footer`: `"Diamond Edge is an information and analysis service. We do not place bets or hold funds. Sports betting involves real financial risk. Past pick performance does not guarantee future results. If you or someone you know is struggling with problem gambling, free, confidential help is available 24/7 at {helpline} or ncpgambling.org."` | Matches `responsible-gambling.md` Surface 1 footer version verbatim. Good. | — | — |
| RG-5 | **Hardcoded `tel:18005224700` anchor even when `{helpline}` text is a state-specific line.** `responsible-gambling-banner.tsx` lines 41, 56: the `<a href>` is always `tel:18005224700` while the displayed text is the state-specific line (e.g., "1-877-8-HOPENY" for NY). Tapping the NY line on mobile dials the national number. | User-experience bug with RG implications: an NY user who sees "HOPENY" and taps it is routed to the national line instead of the NY line they were visually promised. Not a copy issue per se — the copy is correct — but a functional compliance drift. | P1 | Parameterize the `tel:` anchor per state (format `STATE_HELPLINES` as `{ display, tel }` pairs). Separate proposal. |
| RG-6 | Pick-detail page renders `<ResponsibleGamblingBanner surface="footer" />` WITHOUT passing `geoState` (line 302 of `picks/[id]/page.tsx`). | Single known surface where state-specific helpline injection does NOT happen. Every other slate / footer respects `geoState`. Drift. | P1 | Thread `geoState` through pick-detail page like `picks/today/page.tsx` does. Single-line change. Separate proposal. |
| RG-7 | `docs/compliance/copy/responsible-gambling.md` Surface 3 (onboarding acknowledgment checkbox) — **not implemented**. No code path renders the 4-checkbox RG commitment step. | Gap vs. spec + vs. `launch-checklist.md` Category 5 (`"Onboarding responsible gambling acknowledgment (with checkboxes) — live"` currently unchecked). | P1 | Raise as separate proposal (new onboarding step component). Coordinate with the "age-gate middleware enforcement" P1 from AG-7 since both touch onboarding flow. |
| RG-8 | `docs/compliance/copy/responsible-gambling.md` Surface 3 (onboarding copy) mentions `"Text HELP to 233459"`. All other surfaces (banner, GlobalFooter, age-gate) use `"Text HOME to 741741"` (Crisis Text Line per §National Resources). | Spec-internal inconsistency. The onboarding copy references "233459" which is the NCPG ncpgambling.org text line ("TEXT HOME to 741741" is the crisis text line — different). `docs/compliance/copy/responsible-gambling.md` line 10 says `"Crisis Text Line: Text HOME to 741741"`; line 73 says `"Text HELP to 233459"` — the NCPG chat/text line. Both are real numbers but the callout could confuse a user who sees two different text instructions. | P2 | Pick one per surface. For onboarding: keep NCPG `Text HELP to 233459` (since it's the problem-gambling-specific line). Do NOT mix both in one block. Raise with mlb-compliance. |
| RG-9 | **State-helpline drift — TN present in allow-list but NOT in `STATE_HELPLINES` map** of `responsible-gambling-banner.tsx`. So TN users (pending fix from GB-3) would see the national number — acceptable per spec (default = national), just flagging for completeness. | Same applies to AZ, CT, IA, IN, KS, KY, LA, MD, MO, NC, VA, VT, WV, WY — 14 allow states fall back to national. | P2 | Extend `STATE_HELPLINES` map. Low urgency — national line is legal default per spec §State-Specific Hotlines line 120. |
| RG-10 | **"21+ only" string appears in:** `GlobalFooter`, Terms bottom footer, Privacy bottom footer, signup page subhead ("21+ only. Free to start."), age-gate headline — **but NOT on** the pricing page's "Before you subscribe" block, which is the highest-intent conversion surface. | Missing the "21+" callout specifically on the pre-payment disclosure. Footer covers it globally, but spec §Surface 2 (pricing disclaimer) says "21+" + "only where DK/FD legal" should be in the pre-payment block itself. | P2 | Add "21+ only. Available only where DraftKings and FanDuel legally operate." to the pricing page's pre-CTA RG block (already contains the rest of the surface-2 copy). Single-line change. |

### 1.4  Terms of Service — `apps/web/app/terms/page.tsx`

| # | Current copy excerpt | Issue | Severity | Recommended rewrite |
|---|---|---|---|---|
| TOS-1 | `EFFECTIVE_DATE = 'April 22, 2026'` (header), `Last updated: 2026-04-22` in source comment. | Today is 2026-04-24. Domain migrated 2026-04-23 (diamond-edge.co replaces diamondedge.ai). Effective date does NOT need to change for domain swap since the ToS doesn't reference the old domain. However, attorney-review reminder and "Draft — Attorney Review Required" banner remain accurate. | P2 | Keep as-is unless the next substantive edit bumps the date. The placeholder style is correct ("Effective date: April 22, 2026" + attorney-draft banner). |
| TOS-2 | `§3 "Information Only"`: `"[We do not] Act as a sportsbook, bookmaker, or licensed handicapper."` | Matches §1 of `responsible-gambling.md` structure. Good defensive phrasing. | — | — |
| TOS-3 | `§3`: `"All picks, probabilities, and expected-value figures are outputs of statistical models and are provided for informational purposes only."` | **Marketing-vs-reality gap.** Claim "outputs of statistical models" is currently not accurate for moneyline — per `docs/improvement-pipeline/pick-scope-gate-2026-04-24.md` §Claim 1 CONFIRMED, the moneyline B2 model is a market passthrough (lgbm_best_iteration=1, nonzero_delta_rate=0.0, mean_clv_pct=-1.045%). A regulator reading this alongside the actual pick output would find "statistical model" technically defensible (B2 is a LightGBM regressor even if it outputs ≈ market) but fragile. | P1 | Copy is acceptable for now; the REAL fix is Pick-Pipeline Proposal #1 (rebuild B2). Do NOT soften the ToS claim — that would create more liability, not less. Flag: if the B2 fix ships, this sentence becomes fully accurate. |
| TOS-4 | `§6` RG blockquote: duplicates the Surface-1-footer wording verbatim. Links `ncpgambling.org`. | Consistent with GlobalFooter + slate footer. Good. | — | — |
| TOS-5 | `§11 Governing Law`: `"[Attorney review required: confirm governing law, jurisdiction, and arbitration clause for all active states in the ALLOW list.]"` | Attorney-placeholder remains, as expected for draft. Does not drift from reality. | — | — |
| TOS-6 | `§12 Contact`: `support@diamond-edge.co`. | Uses the NEW domain (post-migration). Good — NO `diamondedge.ai` references in subscriber ToS. | — | — |
| TOS-7 | `§5 Subscription and Billing`: `"No refunds are issued for partial periods."` | Tighter than `responsible-gambling.md` silence on refunds. `launch-checklist.md` line 134 says "Recommend: no refunds on used subscription periods; prorated or full refund on cancellation within first 7 days. Attorney to advise." ToS is stricter than the recommendation. | P2 | Either align ToS to the 7-day-refund recommendation OR mark the launch-checklist recommendation as superseded by ToS. Raise with mlb-compliance. |
| TOS-8 | No USPTO status referenced. `CLAUDE.md` line 33 says USPTO clearance against "Diamond Edge Technology LLC" is a pre-launch blocker. | ToS does not claim trademark ownership; `§8 Intellectual Property`: `"UI design, and branding, is the property of Diamond Edge and its operators."` — "Diamond Edge and its operators" is vague-enough to be non-problematic pre-clearance. | — | — |
| TOS-9 | Bottom-of-page duplicate RG footer (lines 187–196) duplicates `GlobalFooter`. | Structural redundancy (see RG-2). | P1 | Remove — `GlobalFooter` from `layout.tsx` already renders. |

### 1.5  Privacy Policy — `apps/web/app/privacy/page.tsx`

| # | Current copy excerpt | Issue | Severity | Recommended rewrite |
|---|---|---|---|---|
| PP-1 | `EFFECTIVE_DATE = 'April 22, 2026'` | Same as TOS-1. Unchanged domain references post-migration. | — | — |
| PP-2 | `§1 Who We Are`: links `https://diamond-edge.co` (new domain). | Correctly uses post-migration domain. No `diamondedge.ai` leak. | — | — |
| PP-3 | `§2 Information We Collect — Age verification`: `"We store the date you verified, not your raw DOB, after verification is complete."` | **CONTRADICTS `age-gate-spec.md` §DOB Storage Decision lines 53–62**, which says: `"Decision: Store full date of birth in profiles.date_of_birth (type: date)."` The Privacy Policy promises one thing; the spec says another. The spec is authoritative for engineering (attorney may override); Privacy Policy is authoritative for the subscriber. | **P0** (user-disclosure conflict) | Reconcile. Two paths: (a) if spec wins, rewrite PP-3 to `"We store your date of birth, encrypted at rest, for audit purposes. It is never exposed via any API."` OR (b) if Privacy Policy wins, change the spec and the implementation to store only the verified-at timestamp. This is an attorney-review item flagged in `age-gate-spec.md:61` — escalate to compliance agent. **This is the most concerning finding in the audit.** |
| PP-4 | `§4 Data Sharing`: lists Supabase, Stripe, Vercel. Omits **Anthropic** (Claude API for rationale generation). | Data-sharing disclosure gap. Pick rationale prompts include `game_context` fields (team names, pitcher names — arguably not user PII, but the call is still a sub-processor relationship). `privacy-policy.md` should list Anthropic as a sub-processor for transparency. | P1 | Add: `"Anthropic: Claude API for AI-generated pick rationale. Requests contain pick context (teams, pitchers, statistics) — not user PII. [https://www.anthropic.com/privacy]"`. Separate proposal. |
| PP-5 | `§4`: `[Attorney review required: confirm adequate data processing agreements with all sub-processors for applicable state privacy laws.]` | Placeholder remains, as expected. | — | — |
| PP-6 | `§7 Cookies and Tracking`: `"No analytics platform with user-level tracking is active in v1."` | Confirmed — grep for `gtag`, `segment`, `mixpanel`, `posthog`, `plausible`, `fathom` in `apps/web/**` returns no matches. Claim is true as of this audit. | — | — |
| PP-7 | `§6 Your Rights`: CCPA/VCDPA/CPA placeholder `[Attorney review required...]`. | Expected. | — | — |
| PP-8 | Bottom-of-page duplicate RG footer (lines 225–234). | Same as TOS-9. | P1 | Remove. |
| PP-9 | No mention of `age_gate_logs` or `profiles.ip_hash` retention policy, despite `age-gate-spec.md:83-85` enumerating both. | Disclosure gap — an attorney reviewing CCPA would flag this. | P2 | Add a row to §2 Information We Collect: `"Age-verification audit log: a hashed IP address (SHA-256) and a pass/fail flag, retained 5 years per launch-checklist.md §8."` |

### 1.6  Marketing copy — `apps/web/app/layout.tsx`, `apps/web/app/pricing/page.tsx`

| # | Current copy excerpt | Issue | Severity | Recommended rewrite |
|---|---|---|---|---|
| MK-1 | `layout.tsx` metadata: `description: "Statistically-grounded, AI-explained MLB betting picks. Moneyline, run line, totals, and props."` | **Marketing-vs-reality gap.** "AI-explained" is currently partially false because `/rationale` endpoint is a hardcoded stub per `pick-scope-gate-2026-04-24.md` §Claim 2 CONFIRMED — `worker/app/main.py:692-742` returns a deterministic template, not a Claude call. Rationale is produced by `apps/web/lib/ai/generate-rationale.ts` (real Claude call) from the Edge Function path, so the claim is accurate for **Pro/Elite picks routed via the Next.js Edge Function** — BUT if any code path still hits the worker's `/rationale` stub (pending cycle-2 fix), the description is subtly wrong for that subset. | P1 | Copy is defensible given the Edge-Function rationale path IS real Claude. No rewrite required today — but if the pick-pipeline refactor routes any rationale through the worker stub, the ToS + marketing claim becomes misleading. Flag this as dependent on pick-pipeline Proposal #2 state. |
| MK-2 | Same metadata: `"Moneyline, run line, totals, and props."` | **Marketing-vs-reality gap.** v1 does NOT publish props. `CLAUDE.md` line 14 confirms v1 scope is "moneyline, run line, totals, props, parlays, and futures" as the *aspirational* v1 scope, but `project_state.md` line 78 says totals have calibration FAIL and are ML-engineer-recommended to be gated to Tier 4+ or deferred; parlays are deferred to v1.1 per line 58/156; no props pipeline exists in code. | P1 | Drop "and props" from the marketing description until the props pipeline exists. New suggested copy: `"Statistically-grounded, AI-explained MLB betting picks. Moneyline, run line, and totals."` |
| MK-3 | Pricing page subhead: `"Statistically-grounded, AI-explained MLB picks. Cancel anytime."` | Same caveat as MK-1 re: moneyline B2 passthrough. Plus "Cancel anytime" is accurate per ToS §5 ("You may cancel at any time; access continues until the end of the current billing period."). | P2 | Keep. Same dependency as MK-1. |
| MK-4 | Pricing page TIERS copy — Free: `"Get a feel for Diamond Edge with limited daily picks."`; Pro: `"Full access to picks with line shopping and AI analysis."`; Elite: `"Everything in Pro plus deep model transparency."` | "AI analysis" (Pro) — same caveat as MK-1. "Deep model transparency" (Elite) — supported by SHAP attributions being in the feature list. No "guaranteed", "beat the books", or "expert handicapper" language anywhere. Good. | P2 | Keep. Revisit after B2 fix ships. |
| MK-5 | Pro feature list: `"AI rationale (Haiku)"`. Elite: `"AI rationale (Sonnet)"`. | Exposes vendor-model names to subscribers. Not a compliance issue but a brand-sophistication drift — most SaaS products don't expose model names. Also, `generate-rationale.ts` lines 23–26 pin to `claude-haiku-4-5` / `claude-sonnet-4-6`; if Anthropic ships 4.7 and the strings change, marketing copy lags. | P2 | Change to generic: `"AI rationale (fast)"` / `"AI rationale (deep)"` or `"AI rationale"` / `"Deep AI rationale"`. Separate proposal. |
| MK-6 | No homepage (`/`). `app/page.tsx` is a server redirect — unauthenticated → `/signup`, age-unverified → `/age-gate`, else → `/picks/today`. | No public marketing landing page exists. `geo-block-spec.md` §What Gets Blocked vs. What Stays Public line 20 says marketing homepage is expected to exist and stay public. | P1 | Build a real `/` public landing page (or a distinct `/home`) with accurate claims. Separate proposal — outside this audit's fix scope. |
| MK-7 | No "expert handicapper", "beat the books", "guaranteed wins", "insider picks", or similar regulator-bait phrasing found anywhere in `apps/web/**/*.tsx` (case-insensitive grep). | Good — the marketing tone is intentionally conservative ("information service", "statistical analysis", "not a guarantee"). | — | — |
| MK-8 | Stripe product seeding — `apps/web/lib/stripe/products.ts`: `"Full pick analysis, line shopping, and AI rationale for every pick."` and `"Everything in Pro plus SHAP attribution, Sonnet-powered rationale, and unlimited bankroll tracking."` | These show up on Stripe-hosted checkout and the Customer Portal. "Sonnet-powered rationale" exposes vendor-model detail (same as MK-5). "Unlimited bankroll tracking" is a small promise — verify there's no quota on bankroll entries per user (spot-check via `bankroll` routes). | P2 | Align with MK-5. "Unlimited bankroll tracking" can stay (there's no per-user quota currently). |

### 1.7  Email templates / subscriber comms

| # | Finding | Severity | Recommendation |
|---|---|---|---|
| EM-1 | **No custom email templates exist in the repo.** No `apps/web/**/emails`, no `react-email`, no `resend` usage. Supabase Auth default emails are used (`emailRedirectTo: ${window.location.origin}/age-gate` per `signup/page.tsx:31`). | P1 | Supabase default emails carry Supabase branding/domain by default — not on-brand. Launch-checklist does not currently enumerate email-template customization. Raise as a separate "configure Supabase Auth custom email templates on diamond-edge.co" proposal. Until then, subscribers get confirmation/password-reset emails with Supabase-branded templates. |
| EM-2 | `privacy/page.tsx:85`: `"Send transactional emails (account confirmation, billing receipts). We do not send marketing email without explicit opt-in."` | The claim is technically accurate IF Supabase defaults are the only email path. No Stripe receipt customization exists — Stripe sends default receipts using the email on file. Both are fine from a CCPA standpoint. | — | Keep. |

---

## 2. Cross-file consistency — RG disclaimer variants

Below is the inventory of distinct RG disclaimer strings across subscriber-facing surfaces. "Canonical" column identifies which variant should be the reference.

| Variant | Where | Text |
|---|---|---|
| **V1 — Short banner (canonical per `responsible-gambling.md` Surface 1 short)** | `components/picks/responsible-gambling-banner.tsx` (surface=`banner`) | "Diamond Edge provides information only — not financial advice. If gambling affects your life, call {helpline}." |
| **V2 — Long footer (canonical per `responsible-gambling.md` Surface 1 footer)** | `components/picks/responsible-gambling-banner.tsx` (surface=`footer`); Terms §6 blockquote | "Diamond Edge is an information and analysis service. We do not place bets or hold funds. Sports betting involves real financial risk. Past pick performance does not guarantee future results. If you or someone you know is struggling with problem gambling, free, confidential help is available 24/7 at 1-800-522-4700 or ncpgambling.org." |
| **V3 — Global footer (canonical per `responsible-gambling.md` Surface 4)** | `components/layout/global-footer.tsx`; also duplicated in `terms/page.tsx` bottom; also duplicated in `privacy/page.tsx` bottom | "Diamond Edge is an information service. We do not place bets or hold funds on your behalf. **21+ only.** Available only where DraftKings and FanDuel legally operate. Problem gambling? Call 1-800-522-4700 (24/7, free, confidential)." |
| **V4 — Pre-subscription disclosure (canonical per `responsible-gambling.md` Surface 2)** | `pricing/page.tsx` | "Diamond Edge provides statistical analysis and AI-generated rationale. We do not guarantee wins, profits, or any specific outcome. Sports betting is inherently uncertain — even high-confidence picks lose. A subscription is an investment in information, not in returns. Never bet more than you can afford to lose. Problem gambling? 1-800-522-4700 (24/7, free)." |
| **V5 — Pick-detail "note on risk" (canonical per `responsible-gambling.md` Surface 5)** | `picks/[id]/page.tsx` sidebar | "This pick is based on a statistical model and AI analysis. The model identified an edge at the time of generation. Edges erode, lines move, and results vary. Past performance does not predict future results. This is analysis, not a guarantee. Never bet more than your stated bankroll limit. Struggling? 1-800-522-4700" |
| **V6 — Age-gate failure (no canonical — acceptable variant)** | `age-gate/page.tsx` | "If you or someone you know needs support, call 1-800-522-4700 (National Problem Gambling Helpline, 24/7, free)." |
| **V7 — Geo-block footer (no canonical — acceptable variant)** | `geo-blocked/page.tsx` | "Problem gambling? Call 1-800-522-4700 (24/7, free)." |

**Findings:**
- **V1–V5 all match their corresponding spec surface in `docs/compliance/copy/responsible-gambling.md` verbatim.** That is the best outcome; drift is low today.
- **V3 is duplicated in 3 files** (`global-footer.tsx`, `terms/page.tsx` bottom, `privacy/page.tsx` bottom). Since `GlobalFooter` already renders on every route via `layout.tsx`, the two inline duplicates are dead code that invites future drift. See RG-2.
- Surfaces 3 of `responsible-gambling.md` (onboarding 4-checkbox acknowledgment) and a dedicated `/responsible-gambling` full-resources page (`launch-checklist.md` Category 5 line 118) are **MISSING** — no code implements them today. See RG-1, RG-7.

**Canonical source of truth:** `docs/compliance/copy/responsible-gambling.md`. All five surface strings in the codebase today match the spec; the gaps are missing surfaces, not drifted copy.

---

## 3. Trademark-status audit — "Diamond Edge" branding pre-USPTO clearance

Per `CLAUDE.md` line 33: `"Pre-launch blocker: USPTO clearance check at tmsearch.uspto.gov against 'Diamond Edge Technology LLC'"`. Per `docs/compliance/launch-checklist.md` §Category 2 line 46-50: `"[A] USPTO trademark clearance: 'Diamond Edge' — Do not launch with the Diamond Edge brand until an attorney clears trademark risk."`

| # | Surface | "Diamond Edge" usage | Issue | Severity |
|---|---|---|---|---|
| TM-1 | `app/layout.tsx` title/description, `app/age-gate/page.tsx` H1, `app/pricing/page.tsx`, `app/terms/page.tsx` title + body, `app/privacy/page.tsx` title + body, `app/geo-blocked/page.tsx` body, `app/picks/today/page.tsx` (via TopNav), `components/layout/top-nav.tsx` brand, `components/layout/global-footer.tsx` copyright + body, `components/picks/responsible-gambling-banner.tsx` both variants, `app/billing/success/page.tsx`, `app/login/page.tsx`, `components/picks/responsible-gambling-banner.tsx`. | ~30 distinct uses of "Diamond Edge" as a wordmark in subscriber-facing code. | The brand is already pervasively used pre-USPTO clearance. The trademark risk is real (conflict with "Diamond Edge Technology LLC" per CLAUDE.md + launch-checklist), but this audit's scope is *not* to recommend removing the brand — that would be a product-level decision. The risk is a **known pre-launch blocker**, not a surprise. | P1 (informational) |
| TM-2 | `lib/stripe/products.ts`: product names `"Diamond Edge Pro"` and `"Diamond Edge Elite"`, metadata key `diamond_edge_tier`. | Once these products are created in Stripe live mode, renaming them requires careful Stripe-product-migration (product IDs are durable; price IDs can be superseded). If USPTO clearance forces a rebrand, Stripe is the stickiest surface. | P2 (informational) | Note for rebrand-risk planning: if USPTO clearance fails, plan for Stripe product-rename as a first-class migration task. |
| TM-3 | `app/layout.tsx` `<title>Diamond Edge — MLB Betting Picks</title>`, social-preview metadata. | Search engines will index "Diamond Edge" SEO presence before trademark clearance. | P2 | Known risk — acknowledged in `launch-checklist.md`. |
| TM-4 | **No `®` or `™` symbol is used anywhere** for "Diamond Edge". | Correct — we have not filed and have not used-in-commerce-as-trademark, so symbol use would be improper. | — | Good. |

**Verdict:** Brand usage is pervasive but no copy claims trademark status. This matches the "draft/pre-launch" posture of the ToS/Privacy banners. The blocker remains USPTO clearance; no copy changes are warranted in this audit.

---

## 4. Marketing-vs-reality gap list (given B2-passthrough + /rationale-stub state)

From `docs/improvement-pipeline/pick-scope-gate-2026-04-24.md`:
- Claim 1 CONFIRMED: Moneyline B2 model is a market passthrough (lgbm_best_iteration=1, nonzero_delta_rate=0.0, mean_clv_pct=-1.045% on 2024 holdout).
- Claim 2 CONFIRMED: Worker's `/rationale` endpoint is a hardcoded string template, not a Claude call. (Edge-Function rationale path via `apps/web/lib/ai/generate-rationale.ts` IS a real Claude call — so the gap applies only to picks that route through the worker stub.)

| # | Subscriber-facing claim | Reality | Gap | Severity | Recommendation |
|---|---|---|---|---|---|
| GAP-1 | `layout.tsx` metadata: `"Statistically-grounded, AI-explained MLB betting picks."` | Moneyline is ≈ market passthrough (B2 adds near-zero deviation). Run-line and totals: researcher's 2024 backtest showed 18% ROI for run-line and calibration FAIL for totals (project_state.md §ML Backtest Results). "Statistically-grounded" is technically accurate (LightGBM is a statistical model, even one that early-stops at iteration 1) but fragile. "AI-explained" is accurate for Pro/Elite picks via the Edge-Function rationale path; stub for worker path. | The claim is defensible but a regulator or consumer-protection complainant could argue "AI-explained" is marketing-weighted given the `/rationale` stub. | P1 | **Do not soften the marketing claim.** The REAL fix is shipping Pick Pipeline Proposal #1 (rebuild B2) + Proposal #2 (remove the worker `/rationale` stub or route around it). Then the claim becomes fully accurate. |
| GAP-2 | `pricing/page.tsx` pre-subscribe: `"Diamond Edge provides statistical analysis and AI-generated rationale."` | Same caveat as GAP-1. `"AI-generated rationale"` is true via Next.js Edge Function → Claude; worker stub is a dark-edge case. | Same as GAP-1. | P1 | Same — fix the underlying pipeline, not the copy. |
| GAP-3 | Pro tier feature list: `"AI rationale (Haiku)"`. Elite: `"AI rationale (Sonnet)"`. | True per `generate-rationale.ts` lines 23-26 (Haiku 4.5 routes Pro; Sonnet 4.6 routes Elite). | No gap currently. | — | — |
| GAP-4 | Pick-detail sidebar (Surface 5): `"This pick is based on a statistical model and AI analysis. The model identified an edge at the time of generation."` | For MONEYLINE picks, "the model identified an edge" is empirically NOT TRUE right now — the moneyline model is a market passthrough producing near-zero delta from the market prior. The "edge" shown to the subscriber is effectively the market prior; B2 adds no signal. For RUN-LINE picks, the 18% backtest ROI suggests there IS a real edge. For TOTALS, calibration FAILs — the "edge" claim is weakest here. | **This is the single most concerning marketing-vs-reality sentence in the codebase.** A subscriber reading "the model identified an edge" for a moneyline pick is being told something the scope-gate evidence says is false for moneyline specifically. | **P1 (escalate to P0 if moneyline is publishing to Pro/Elite subscribers today)** | Two options: (a) add a market-aware conditional rendering — skip the "identified an edge" line for moneyline picks until Pick Proposal #1 ships; (b) soften the copy to `"This pick is based on a statistical model that compared market consensus to our internal signals."` which is true regardless of whether B2 adds edge. Option (b) is simpler and is what I recommend. Raise as separate proposal. |
| GAP-5 | Terms §3: `"All picks, probabilities, and expected-value figures are outputs of statistical models and are provided for informational purposes only."` | Literally true (LightGBM IS a statistical model). The legal framing is correct; the marketing framing in GAP-4 is the weak point. | — | Keep. |
| GAP-6 | No subscriber-facing claim currently promises "CLV positive" or "ROI X%" or "N-win streak" — i.e. no specific-performance claims that would require evidentiary backing. | Good. Conservative marketing posture is intact. | — | — |
| GAP-7 | `privacy/page.tsx` §2: `"We store the date you verified, not your raw DOB, after verification is complete."` | Contradicts `age-gate-spec.md` §DOB Storage Decision. See PP-3. | **Primary disclosure conflict — #1 most concerning finding in this audit.** | **P0** | Reconcile Privacy Policy with spec + implementation. Separate proposal. |
| GAP-8 | `layout.tsx` metadata: `"Moneyline, run line, totals, and props."` | No props pipeline exists in v1 code. See MK-2. | Marketing overpromise. | P1 | Drop "and props". |

---

## 5. Summary — issue counts by severity

| Severity | Count | Items |
|---|---|---|
| **P0 (subscriber-visible, invariant-breaking)** | **3** | GB-3 (TN missing from middleware while listed on geo-block page), RG-1 (`/responsible-gambling` 404 on 3 required-surface links), PP-3 / GAP-7 (Privacy Policy contradicts DOB-storage spec/impl) |
| **P1 (consistency/freshness)** | **14** | AG-5, AG-7, GB-4, GB-5, RG-2, RG-5, RG-6, RG-7, TOS-3, TOS-9, PP-4, PP-8, MK-1, MK-2, MK-6, EM-1, GAP-4, GAP-8, TM-1 (informational) |
| **P2 (polish)** | **12** | GB-7, RG-8, RG-9, RG-10, TOS-1, TOS-7, PP-1, PP-9, MK-3, MK-4, MK-5, MK-8, TM-2, TM-3 |

(Some items appear in both the per-surface table AND the marketing-vs-reality list — they are counted once above.)

---

## 6. Top-3 most concerning findings

1. **PP-3 / GAP-7 — Privacy Policy contradicts the age-gate DOB-storage decision.** The Privacy Policy tells users we discard raw DOB after verification; the spec + (presumably) the implementation store it. This is a direct user-disclosure conflict and the single biggest attorney/regulator-review red flag in the entire compliance surface. **Fix requires reconciling the Privacy Policy, the spec, or the implementation — and flagging to mlb-compliance.**

2. **GB-3 — TN allowed-states mismatch between middleware and the geo-block page.** The list the user SEES on the `/geo-blocked` page contains TN; the list the middleware actually ENFORCES does not. A TN user is told "your state is supported" while being blocked. Trivial to fix (add `'TN'` to `DEFAULT_ALLOW_STATES` — state-matrix.md line 81 says TN is ALLOW), but visible and embarrassing.

3. **RG-1 — `/responsible-gambling` page does not exist, yet 3 surfaces link to it.** GlobalFooter, Terms footer, and Privacy footer all `<Link href="/responsible-gambling">` — all 3 currently 404. This is the most high-volume broken link in the app (GlobalFooter is on every page) and it's a compliance surface specifically called out in the launch checklist. Trivial to unblock by creating the page.

---

## 7. Overall posture verdict

**Compliance copy posture: GOOD with isolated drift.**

- The five RG surfaces defined in `responsible-gambling.md` are implemented verbatim. The spec is authoritative and is followed. No silent drift in canonical RG wording.
- The age-gate and geo-block UX match their respective specs. The single inconsistency (GB-3 TN) is clearly a code bug, not a copy decision.
- Post-domain-migration (`diamondedge.ai` → `diamond-edge.co`): **clean.** No `diamondedge.ai` references in subscriber-facing code or copy. All `support@diamond-edge.co` mailto links are on the new domain.
- No "guaranteed wins" / "beat the books" / "expert handicapper" language anywhere — conservative marketing posture is intact.
- Terms and Privacy retain explicit "Draft — Attorney Review Required" banners. Honest draft posture.
- Missing surfaces (RG-1, RG-7, MK-6) are known gaps from `launch-checklist.md`, not drift.
- **Single biggest concern is PP-3/GAP-7** — one sentence in the Privacy Policy that contradicts the spec. Low-effort to fix once the compliance agent picks a side.
- **Marketing-vs-reality gap is narrow** as of today: GAP-4 (pick-detail sidebar "identified an edge") is the most exposed sentence given the confirmed B2 passthrough finding. Once Pick Pipeline Proposal #1 ships and the moneyline model produces non-zero delta, the gap closes without any copy edit.

**Recommendation for next cycle:** the 3 P0s are all single-file fixes; each becomes its own minimal remediation proposal (do NOT bundle). The 14 P1s should be triaged by mlb-compliance — several (RG-2, RG-5, RG-6, TOS-9, PP-8, EM-1) are pure technical-debt cleanups that don't need legal review. The 12 P2s can be deferred to post-launch polish.

**This is an audit. No code was changed. No compliance copy was modified.** Every recommendation above is a suggestion for a follow-up single-file proposal.
