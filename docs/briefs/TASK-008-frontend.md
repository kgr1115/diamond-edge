# TASK-008 — Frontend: Slate View, Pick Detail, Bankroll Dashboard, Subscription Paywall

**Agent:** mlb-frontend
**Phase:** 2
**Date issued:** 2026-04-22
**Status:** Ready to start

---

## Objective

Build the complete v1 frontend: daily picks slate, pick detail page, bankroll dashboard with bet logging, subscription paywall/upsell UI, age gate screen, geo-block screen, and responsible gambling copy — all in Next.js 15 App Router with Tailwind + shadcn/ui, dark mode from day one, Server Components by default.

---

## Context

- **Stack (locked):** Next.js 15 App Router, TypeScript, Tailwind CSS, shadcn/ui. No other component libraries. Dark mode from day one (Tailwind `dark:` classes, not system-only — provide a toggle).
- **Server Components by default.** Use Client Components (`'use client'`) only where interactivity is required (forms, modals, toggled state). Data fetching in Server Components via the API routes.
- **API routes are the backend interface.** Do not call Supabase directly from the frontend — go through `/api/*` routes defined in `docs/api/api-contracts-v1.md`. The Supabase client in `apps/web/lib/supabase/client.ts` is for auth session management only.
- **Tier gating is enforced at the API layer.** The frontend receives only what the user is entitled to. If `rationale_preview` is absent from the pick response, the user is on Free tier — show the paywall upsell in that slot. Do not implement tier logic in the frontend beyond UI branching on response field presence.
- **Responsible gambling copy:** Every pick surface must render the appropriate copy from `docs/compliance/copy/responsible-gambling.md`. This is a hard compliance requirement — do not omit it. Use the correct surface variant:
  - Picks slate page: Surface 1 (slim banner + footer version)
  - Pick detail page: Surface 5 (sidebar "A note on risk" block)
  - Subscription page: Surface 2 (above payment form)
  - Onboarding flow: Surface 3 (acknowledgment checkboxes)
  - All pages: Surface 4 (global footer)
- **Age gate and geo-block:** Middleware in `apps/web/lib/supabase/middleware.ts` already enforces these. Your job is to render the screens when middleware redirects hit `/age-gate` and `/geo-blocked` routes. The screens must be dead-simple, compliant, and unforgeable.
- **Pricing:** Free (no card), Pro $19/mo, Elite $39/mo. These are locked — do not change them in UI copy.
- **Stripe checkout:** TASK-009 delivers `POST /api/billing/checkout` and `POST /api/billing/portal`. Wire the "Upgrade" button to call `/api/billing/checkout` and redirect to the Stripe-hosted checkout URL returned. Do not build a custom payment form.
- **Zero state:** EV > 4% filter means some days produce 0 picks. The slate page must handle this gracefully with a "No qualifying picks today" state — not a broken empty page.
- **No parlay UI in v1.** The `parlay` market type exists in the schema but is reserved. Do not render parlay picks or parlay-related UI.

---

## Inputs

- `docs/api/api-contracts-v1.md` — all API routes, response shapes, tier gating table
- `docs/compliance/copy/responsible-gambling.md` — exact copy for each surface
- `docs/compliance/age-gate-spec.md` — age gate flow and failure behavior
- `docs/compliance/geo-block-spec.md` — geo-block screen spec
- `apps/web/lib/types/database.ts` — TypeScript types (SubscriptionTier, MarketType, etc.)
- `apps/web/lib/supabase/client.ts` — browser Supabase client (for auth session)
- `apps/web/lib/supabase/middleware.ts` — understand what middleware sets (x-geo-state, x-geo-blocked headers)
- `CLAUDE.md` — locked constraints (brand name "Diamond Edge", stack, budget)

---

## Deliverable Format

All page and component files under `apps/web/app/` and `apps/web/components/`. Commit when complete.

### Pages

**1. `/picks/today` — Daily Picks Slate** (`apps/web/app/picks/today/page.tsx`)
- Server Component. Fetches `/api/picks/today` server-side.
- Layout: slate header (date, pick count, user tier badge), pick card grid.
- Pick card shows: matchup (teams + game time), market, pick side, confidence tier (1–5 stars or dots), result badge (pending/win/loss).
- Pro+ cards additionally show: best line price + book, model probability.
- Free-tier cards: pick side + confidence tier only. A "Unlock full analysis" upsell CTA in the slot where rationale would appear.
- Zero state: "No qualifying picks today. Our model requires EV > 4% — on lighter slates, no picks qualify. Check back tomorrow." with a link to `/history`.
- Loading state: skeleton cards (use shadcn/ui Skeleton).
- Error state: "Unable to load picks. Please refresh." — do not expose error detail to users.
- Slim responsible-gambling banner at top (Surface 1 short version from compliance doc).
- Sticky footer disclaimer (Surface 1 footer version).
- Freshness badge in the header row ("Odds updated Xm ago") driven by `PicksMeta.last_odds_snapshot_at`; color thresholds live in `lib/picks/load-slate.ts` (`ODDS_AMBER_MIN`, `ODDS_RED_MIN`, `ODDS_STALE_MIN`). When `meta.odds_stale` is true, pick cards also surface a "Line may be stale" label under the price.

**2. `/picks/[id]` — Pick Detail** (`apps/web/app/picks/[id]/page.tsx`)
- Server Component. Fetches `/api/picks/[id]` server-side.
- Sections:
  - Header: matchup, game time, venue, weather (if available), probable pitchers
  - Pick summary: market, pick side, confidence tier, result, generated_at
  - Line comparison: DK vs. FD odds table side-by-side (from `best_line_price` + `best_line_book`; full line shopping from `/api/odds/[game_id]` for Pro+)
  - Model analysis section (Pro+): model probability, rationale_preview or full rationale
  - Elite-only: SHAP attributions rendered as a bar chart or ranked list
  - Paywall upsell (Free users): "Upgrade to Pro to see the full statistical analysis"
  - Responsible gambling sidebar (Surface 5 — "A note on risk")
- 404 page if pick not found.

**3. `/bankroll` — Bankroll Dashboard** (`apps/web/app/bankroll/page.tsx`)
- Auth-required. Redirect to `/login` if unauthenticated.
- Fetches `/api/bankroll` (30-day default).
- Summary row: total wagered, P&L, ROI %, win/loss/push counts, win rate.
- Bet log table: sortable by date, market, sportsbook, amount, outcome.
- "Log a Bet" button → opens a modal/drawer (Client Component) with the bet logging form.
- Bet log form: date, description (optional), market (optional), sportsbook (DK/FD), amount ($), odds (American), pick link (optional), notes (optional). Submit → `POST /api/bankroll/entry`.
- Settle bet: click a pending bet row → inline settle form → `PUT /api/bankroll/entry/[id]`.
- Delete bet: soft delete via `DELETE /api/bankroll/entry/[id]` with confirmation.
- Empty state: "No bets logged yet. Start tracking your bets to see your ROI."
- Auth-guard: if user is Free tier, show the bankroll dashboard but with an upsell nudge ("Track unlimited bets with Pro").

**4. `/history` — Public Pick Performance** (`apps/web/app/history/page.tsx`)
- Server Component. Fetches `/api/history`.
- Summary stats: total picks, win rate, ROI% (flat $100 bets), by-market breakdown, by-confidence breakdown.
- Pick history table with pagination (50/page).
- Filter controls: market, date range.
- No auth required — this is public social proof.

**5. `/pricing` — Subscription Pricing Page** (`apps/web/app/pricing/page.tsx`)
- Three-column pricing table: Free / Pro $19/mo / Elite $39/mo.
- Feature comparison matrix (derive from tier gating table in `docs/api/api-contracts-v1.md`).
- "Get Started Free" (no card) / "Upgrade to Pro" (→ Stripe checkout) / "Go Elite" (→ Stripe checkout).
- Responsible gambling copy Surface 2 above the Pro/Elite CTAs.
- Authenticated users: "Current plan" badge on their active tier. Upgrade/downgrade CTAs as appropriate.
- Link to customer portal for existing subscribers ("Manage subscription" → `POST /api/billing/portal`).

**6. `/age-gate` — Age Verification Screen** (`apps/web/app/age-gate/page.tsx`)
- Client Component (requires user interaction).
- DOB input (month/day/year selects or a single date input).
- Submit → `POST /api/auth/age-verify`. On success: redirect to intended destination. On failure (403): show "You must be 21 or older to use Diamond Edge." — no retry, no further instructions (per age-gate-spec.md).
- 21+ required statement prominent. National helpline in footer.

**7. `/geo-blocked` — Geo-Block Screen** (`apps/web/app/geo-blocked/page.tsx`)
- Static Server Component. No interactivity needed.
- Message: "Diamond Edge is currently available only in states where DraftKings and FanDuel are both fully licensed and operational. Your location is not yet supported."
- List the 25 ALLOW states (from `docs/compliance/state-matrix.md`) so blocked users understand where service is available.
- National helpline in footer (always present on all pages).

**8. `/login` and `/signup`** (`apps/web/app/login/page.tsx`, `apps/web/app/signup/page.tsx`)
- Use Supabase Auth UI or custom forms — your choice, but must be clean and on-brand.
- Login: email + password. "Forgot password?" link.
- Signup: email + password. After signup: route through age gate, then onboarding responsible gambling acknowledgment (Surface 3).
- OAuth: "Continue with Google" button (Supabase OAuth). Optional for v1 — include if low-effort, skip if it adds significant scope.

### Components

**9. `apps/web/components/picks/pick-card.tsx`**
- Reusable card for slate and detail views. Accepts a pick object (shaped per API response) and tier. Applies field-presence gating (not tier logic — just renders what's in the response).
- Urgency badge next to game time: countdown pill ("in 2h 14m") for scheduled games (neutral > 2h, amber < 2h, red < 30m) and state pill ("Live" / "Final" / "PPD" / "Cancelled") for non-scheduled games. Non-scheduled cards render at `opacity-60` to signal the market is no longer bettable. Pure logic lives in `lib/picks/urgency.ts` (`resolveUrgency`) — single source of truth, unit-tested in `lib/picks/__tests__/urgency.test.ts`. The badge is informational only; no CTA copy anywhere on the card.

**10. `apps/web/components/picks/confidence-badge.tsx`**
- Renders confidence_tier (1–5) as a visual indicator (stars, diamonds, colored dots — your design call, but consistent with dark-mode-first theme).

**11. `apps/web/components/picks/responsible-gambling-banner.tsx`**
- Reusable component for the slim banner (Surface 1 short) and footer disclaimer (Surface 1 footer). Accepts a `surface: 'banner' | 'footer'` prop.
- State-specific helpline injection: reads `profiles.geo_state` (passed as prop) to append state-specific number per `docs/compliance/copy/responsible-gambling.md`.

**12. `apps/web/components/layout/global-footer.tsx`**
- Site-wide footer with Surface 4 responsible gambling copy, links: Terms of Service, Privacy Policy, Responsible Gambling, 21+ badge.
- Included in the root layout.

**13. `apps/web/components/billing/upgrade-cta.tsx`**
- Reusable "Upgrade to Pro / Elite" CTA button. Calls `POST /api/billing/checkout` and redirects to returned URL. Handles loading state.

**14. `apps/web/components/bankroll/bet-log-form.tsx`** (Client Component)
- The bet logging modal/drawer form. Validates client-side (amount > 0, valid American odds format). Submits to `/api/bankroll/entry`.

### Routing Notes
- All authenticated-required pages redirect to `/login?redirect=<intended-url>` when unauthenticated.
- After login, redirect to the original intended URL.
- Middleware already handles geo-block and age-gate redirects. The page components just render the appropriate screens.

---

## Definition of Done

- [ ] `/picks/today` renders pick cards with correct tier-gating (Free sees side + confidence only; Pro+ sees line + probability + rationale preview).
- [ ] Zero-state renders when picks array is empty (not a blank page or error).
- [ ] Loading state: skeleton cards during SSR/suspense.
- [ ] `/picks/[id]` renders all tier-appropriate sections including SHAP attributions for Elite.
- [ ] `/bankroll` is auth-gated; bet logging form submits to API and updates the list without full page reload.
- [ ] `/pricing` shows correct prices ($19/$39), feature matrix, and working upgrade CTAs.
- [ ] `/age-gate` submits DOB to API, handles success and failure correctly per spec.
- [ ] `/geo-blocked` renders the 25 ALLOW states list.
- [ ] Responsible gambling copy appears on every pick surface (all 5 surfaces per compliance doc) — verified by inspection.
- [ ] Dark mode works on all pages from day one (light mode optional but not broken).
- [ ] No inline Supabase DB calls in page components — all data through API routes.
- [ ] No TypeScript errors (`tsc --noEmit`).
- [ ] No `console.error` calls in production paths (use structured logging or silent fail with UI error state).
- [ ] All pages are mobile-responsive (min 375px viewport) — this is a web app, not a native app, but must not break on phones.
- [ ] Parlay market type is never rendered in any UI surface.

---

## Dependencies

**Requires:**
- `docs/api/api-contracts-v1.md` — DONE (TASK-001)
- `apps/web/lib/types/database.ts` — DONE (TASK-003)
- `apps/web/lib/supabase/client.ts` and `server.ts` — DONE (TASK-003)
- `apps/web/app/api/picks/today/route.ts` — DONE (TASK-003): confirms API shape
- `docs/compliance/copy/responsible-gambling.md` — DONE (TASK-002)
- `docs/compliance/age-gate-spec.md` — DONE (TASK-002)
- `docs/compliance/geo-block-spec.md` — DONE (TASK-002)

**Does NOT require:**
- TASK-007 (AI Reasoning) — frontend consumes rationale_text from DB via API, not from the AI function directly
- TASK-009 (Stripe billing) — frontend calls `/api/billing/checkout` and `/api/billing/portal`; wire up with placeholder routes if TASK-009 isn't done; the real routes drop in without frontend changes

**This task does NOT block:**
- TASK-009 (Stripe billing) can develop in parallel
- TASK-010-pre (pick pipeline) can develop in parallel

**Coordination with TASK-009:**
- TASK-009 will deliver `POST /api/billing/checkout` returning `{ url: string }` and `POST /api/billing/portal` returning `{ url: string }`. Wire the upgrade CTA to call checkout and redirect. If TASK-009 is not done when you reach this component, stub it with a `TODO` comment and a disabled button — do not block the rest of the frontend on billing.
