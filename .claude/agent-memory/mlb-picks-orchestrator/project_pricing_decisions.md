---
name: Product & Pricing Decisions (User-Confirmed 2026-04-22)
description: Locked product decisions from user Q&A: tier pricing, free-tier behavior, confidence threshold, parlay scope, launch target
type: project
---

Locked as of: 2026-04-22 (user responded "go with the recommendations")

## 1. Free-Tier LLM Behavior: NO LLM Call

Free picks show pick side + confidence tier only. No rationale text, no Haiku call.

**Why:** Cleaner free-vs-pro differentiation. Zero marginal LLM cost for free users. Recommendation accepted by user.

**How to apply:** API route for `/api/picks` must strip `rationale` field entirely when `subscription_tier === 'free'`. AI Reasoning agent generates rationale only for pro/elite. Stripe paywall copy should call out "AI rationale" as a pro feature.

---

## 2. Minimum Confidence Threshold for Publication: Tier 3+ (EV > 4%)

Only picks with expected value above 4% are published. Expected volume: ~3-6 picks per day.

**Why:** Prioritizes signal quality over coverage volume. Aligns with sharp-bettor positioning (not a tout service). Recommendation accepted by user.

**How to apply:** ML model output filter: `if ev_percent < 0.04, do not insert into picks table`. Daily pick volume will be low — UI and marketing copy must frame scarcity as a feature ("high-conviction only"). If volume dips to 0 on a slow day, the app should show a "No qualifying picks today" state gracefully.

---

## 3. Subscription Tiers: Free / Pro $19/mo / Elite $39/mo

Tier names match the schema enum: `free`, `pro`, `elite`.

**Why:** User confirmed these names and prices from the suggested options. Stripe products can now be created using these exact values.

**How to apply:**
- Backend: Stripe product/price objects: Free (no Stripe product needed), Pro ($19/mo recurring), Elite ($39/mo recurring)
- Schema: `subscription_tier` enum already uses `free`, `pro`, `elite` — no migration needed
- Frontend: Pricing page copy uses these exact values
- Future: Any tier change requires both a Stripe product update AND an `ALTER TYPE` on the enum — flag to orchestrator

---

## 4. Parlays: Deferred to v1.1

No parlay leg junction table in v1. The `market_type` enum retains `parlay` as a value for forward compatibility, but no parlay picks will be generated or displayed in v1.

**Why:** Schema complexity not justified for v1 scope. Recommendation accepted by user.

**How to apply:** ML agent scopes to moneyline, run_line, and totals only. `parlay` value in `market_type` enum should not be used in v1 — treat as reserved. No parlay UI in v1 frontend.

---

## 5. Soft Launch Target: UNCONFIRMED (Working Assumption 2026-06-03)

No confirmed date from user. Using 2026-06-03 (~6 weeks from 2026-04-22) as a planning assumption.

**Why:** User did not provide a date. Assumption is needed for sprint planning and critical path pressure.

**How to apply:** Flag as UNCONFIRMED in all planning artifacts. Ask user explicitly in next status report. If confirmed at 6 weeks, Phase 1 must complete by ~2026-05-06 to leave 4 weeks for Phase 2 + QA + attorney review.
