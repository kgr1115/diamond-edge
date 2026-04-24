# Stripe Webhook Audit — 2026-04-24 (Cycle 2, Proposal #7)

**Auditor:** implementer (audit-only)
**Scope:** `apps/web/app/api/webhooks/stripe/route.ts` + related billing code
**Related files reviewed:**
- `apps/web/lib/stripe/client.ts`
- `apps/web/lib/stripe/products.ts`
- `apps/web/app/api/billing/checkout/route.ts`
- `apps/web/app/api/billing/portal/route.ts`
- `apps/web/lib/supabase/server.ts`
- `supabase/migrations/0006_user_tables.sql`
- `supabase/migrations/0007_rls_policies.sql`
- `docs/briefs/TASK-009-integration-notes.md`
- `tests/e2e/subscription.spec.ts`

**Verdict posture:** needs-attention. Happy paths are mostly solid; the material gaps are (1) no persisted Stripe event-id idempotency ledger, (2) missing `checkout.session.completed` and `customer.subscription.trial_will_end` handling, and (3) no unit/integration/fixture tests against the webhook route. None is critical for a closed-test Stripe pilot; at least (1) and (3) should land before paid-traffic launch.

**Severity scale used:** CRITICAL / HIGH / MEDIUM / LOW / INFO.

---

## Checklist item 1 — Signature verification

**Status:** PASS (with one LOW-severity hardening note).

**Evidence:**
- `apps/web/app/api/webhooks/stripe/route.ts:140-164` — the route reads the raw body as text, pulls `stripe-signature` header, and if absent returns HTTP 400 without further work.
- `route.ts:152-164` — `getStripe().webhooks.constructEvent(body, signature, process.env.STRIPE_WEBHOOK_SECRET!)` is the FIRST substantive call before any processing. Any signature mismatch → 400 return.
- `lib/stripe/client.ts:10` — Stripe client construction uses `STRIPE_SECRET_KEY`; the webhook construction uses `STRIPE_WEBHOOK_SECRET` — env vars correctly separated.
- `.env.local.example:20-24` — both keys are enumerated; no ambiguity.
- `route.ts:7-10` — `runtime = 'nodejs'` and `dynamic = 'force-dynamic'` are set; raw body is obtained via `request.text()` so signature-verification gets the unmodified bytes. Next.js App Router does not pre-parse JSON on a Route Handler that reads via `.text()`, so signature verification is performed against the exact bytes Stripe signed.
- There is no code path that processes the body without signing verification succeeding first.

**Findings:**
- [LOW] **Non-null assertion on `STRIPE_WEBHOOK_SECRET`** — `route.ts:156` uses `process.env.STRIPE_WEBHOOK_SECRET!`. If the secret is unset in Vercel env, the `!` will pass `undefined` into `constructEvent`, which will throw — but the resulting error is caught and returned as a generic "Webhook signature verification failed." (`route.ts:161`). That is a safe outcome (no state change), but the root cause (missing env var) is harder to debug from logs. Recommended fix (no code this cycle): boot-time or request-time guard that logs a distinct `stripe_webhook_secret_missing` event before attempting construction, so an ops-side misconfiguration surfaces clearly.

**Overall:** signature verification is correctly sequenced and uses the correct env var. No unsigned-body path exists.

---

## Checklist item 2 — Idempotency

**Status:** FAIL (HIGH severity). No persisted event-id dedupe ledger.

**Evidence:**
- `route.ts` has NO `stripe_events` / `processed_events` / `webhook_events` table lookup. Confirmed by `grep` across `supabase/migrations/**` — no such table exists.
- `route.ts:168-197` dispatches directly on `event.type` with no up-front "have we seen `event.id` before?" check.
- The handler relies SOLELY on DB-state idempotency:
  - `handleSubscriptionUpsert` (route.ts:16-84) writes the `subscriptions` row using `.upsert({...}, { onConflict: 'stripe_sub_id' })` — that is structurally idempotent for the same `sub.id`.
  - `handleSubscriptionDeleted` (route.ts:89-122) does `.update(...)` filtered on `stripe_sub_id` — re-delivering it produces the same "canceled/free" end state.
  - `handleInvoicePaymentFailed` (route.ts:129-137) is log-only, inherently idempotent.

**Why this is a FAIL despite the upserts being idempotent per-row:**
1. **Out-of-order delivery race** — Stripe does not guarantee event order. If `customer.subscription.deleted` arrives, THEN a stale `customer.subscription.updated` (sent earlier, retried later) arrives, the handler will re-run `handleSubscriptionUpsert` and re-set `status='active'` and `tier='pro'` on a subscription that was already canceled. There is no `event.created` timestamp check and no dedupe by `event.id`. This is the exact failure mode Stripe's own best-practices doc warns about.
2. **Partial-failure replay correctness** — if a 500 is returned mid-handler (e.g., the subscriptions upsert succeeded but the profiles update failed, `route.ts:73-75` throws), Stripe retries. The retry replays the whole block, and the subsequent `.upsert` → `.update` sequence works — but ONLY because every branch happens to be idempotent by coincidence of schema, not by design. Adding a new handler that does a non-idempotent write (e.g., an `INSERT INTO notifications` append, a credit-grant increment, a Slack ping) would silently break under retry. There is no structural guardrail.
3. **No replay-detection observability** — operator cannot tell from logs whether a given `event.id` was processed 1× or N×; there is no INSERT into a ledger whose PK conflict would signal "replay detected".

**Severity rationale:** HIGH because (a) out-of-order `subscription.updated` after `subscription.deleted` silently re-activates a canceled subscription — a real subscriber-facing bug — and (b) the lack of a ledger means any future handler added naively will inherit a replay bug. Not CRITICAL because under normal Stripe delivery ordering and the current narrow handler set, observed failure rate is low.

**Recommended fix (no code this cycle):**
- New migration: `stripe_events` table — `event_id text PRIMARY KEY, event_type text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz`. RLS enabled with zero public policies (service-role only).
- First action inside `POST` after signature verification: `INSERT INTO stripe_events (event_id, event_type) VALUES (...)` with `ON CONFLICT (event_id) DO NOTHING RETURNING *`. If no row returned → already processed → return 200 immediately.
- Dedicated separate proposal, will bring its own migration + test plan.

---

## Checklist item 3 — Event handling completeness

**Status:** FAIL (MEDIUM severity) — key events unhandled / silently dropped.

**Evidence — events CURRENTLY handled (`route.ts:169-186`):**
- `customer.subscription.created` → `handleSubscriptionUpsert`
- `customer.subscription.updated` → `handleSubscriptionUpsert`
- `customer.subscription.deleted` → `handleSubscriptionDeleted`
- `invoice.payment_failed` → `handleInvoicePaymentFailed` (log-only, no state change)
- default branch → `console.info({ event: 'stripe_webhook_unhandled', type })` and 200

**Events that MATTER for Diamond Edge's subscription model but are NOT handled:**

| Event | Why Diamond Edge cares | Current behavior | Severity |
|---|---|---|---|
| `checkout.session.completed` | Fires IMMEDIATELY on successful checkout, BEFORE `customer.subscription.created`. Good place to seed `profiles.stripe_customer_id` when `checkout/route.ts:107-109` persist failed silently (the comment there explicitly says "Non-fatal: checkout will still work — customer ID persists via webhook"). But NO webhook handler persists it. If the in-line update on L104 fails, the subscribers's `stripe_customer_id` will be persisted anyway by `handleSubscriptionUpsert` looking up by customer — EXCEPT that function's `.eq('stripe_customer_id', customerId).single()` will fail with a "no profile found" log (route.ts:27-34) because we look up by the very field that was never persisted. Classic chicken-and-egg. | Silently dropped → subscriber pays, webhook can't resolve user, `stripe_webhook_user_not_found` logged, tier never upgrades. | HIGH |
| `invoice.payment_succeeded` | Renewal success — useful for operator dashboards / receipts / MRR tracking. Stripe also fires `customer.subscription.updated` on renewal, so tier state is OK, but there is no renewal-success audit trail. | Silently dropped. | LOW |
| `customer.subscription.paused` | Stripe added this state — subscribers who pause should lose Pro access during pause and regain it on resume. | Silently dropped. The `.updated` event that accompanies a pause DOES reach `handleSubscriptionUpsert`, which would write `status='paused'` but the `resolvedTier` logic (route.ts:38) returns the priceId-based tier — NOT `'free'` — so a paused subscriber retains Pro access. | MEDIUM |
| `customer.subscription.resumed` | Inverse of above. | Accompanying `.updated` is caught, but priceId stays the same, so tier stays correct. No bug here, but no explicit handling. | LOW |
| `customer.subscription.trial_will_end` | If trials are introduced later, operator needs advance notice. | Currently not in scope (no trials yet). | INFO |
| `customer.deleted` | If a Stripe customer is deleted out-of-band (compliance-driven), the `profiles.stripe_customer_id` becomes a dangling reference. | Silently dropped. | LOW |
| `charge.dispute.created` | Chargeback — compliance-material; should at least alert the operator. | Silently dropped. | MEDIUM |

**Additional tier-mapping gap in `handleSubscriptionUpsert`:**
- `route.ts:37-38` — `const resolvedTier = tierFromPriceId(priceId) ?? 'free'`. If a price ID is unrecognized (e.g., a forgotten staging price ID bled into prod, or a new price created in Stripe dashboard that hasn't been added to env vars), the user is silently downgraded to `free`. This is a quiet revenue-loss bug. Should log a `stripe_webhook_unknown_price_id` WARN and ideally NOT change tier — retain current value.

**Severity rationale:** MEDIUM overall because `checkout.session.completed` handling would be a useful defense-in-depth against the customer-id persist race (HIGH), but in the happy path the customer ID does persist on checkout and `handleSubscriptionUpsert` resolves fine. The paused-subscription tier-retention bug is real but narrow (requires the subscriber to have used Stripe's pause feature — which the portal config in `TASK-009-integration-notes.md:46-49` does not mention enabling).

**Recommended fixes (no code this cycle):**
- Add `checkout.session.completed` handler that persists `stripe_customer_id` to `profiles` when the session's `client_reference_id`/`metadata.supabase_user_id` matches a profile without one — redundant belt-and-suspenders with the in-line persist in `checkout/route.ts`.
- Treat `status='paused'` specially in `handleSubscriptionUpsert` — override `resolvedTier` to `'free'` while paused, restore on resume.
- Add explicit case for `invoice.payment_succeeded` (log-only for MRR audit).
- Add explicit case for `charge.dispute.created` (log + operator alert).
- On unknown price ID, log WARN and DO NOT change `tier` — keep whatever was last valid.

---

## Checklist item 4 — Error handling + retries

**Status:** PASS (with one INFO note).

**Evidence:**
- `route.ts:187-194` — top-level try/catch around the dispatch switch. Any thrown error from a handler → returns 500 → Stripe retries per its retry policy (up to 3 days, exponential backoff).
- `handleSubscriptionUpsert` throws explicitly on both write failures (`route.ts:64`, `route.ts:75`) — good, these propagate to the 500 branch.
- `handleSubscriptionDeleted` does NOT throw on DB errors (`route.ts:106-119`) — the `.update` calls ignore errors. If either update fails, the webhook returns 200 and Stripe moves on. This is a MEDIUM-severity asymmetry vs. `handleSubscriptionUpsert`: a failed cancellation leaves a subscriber's row with stale `status='active', tier='pro'` and Stripe will not retry.
- `handleSubscriptionUpsert` when the profile lookup fails returns 200 without throwing (`route.ts:27-35`). This is intentional per the inline comment ("200 to Stripe to stop retries on an unfixable error"). Correct for the "customer does not exist in our DB" case — retrying forever will not help. But see item 3 findings — this swallow is why the `checkout.session.completed` missing handler matters.

**Findings:**
- [MEDIUM] **Silent swallow in `handleSubscriptionDeleted`** (`route.ts:106-119`) — two `.update` calls, neither throws on DB error. A transient Postgres hiccup during a cancellation will leave the DB in an inconsistent state permanently (`status='active', tier='pro'` when Stripe says canceled). Should `.throw` on error parity with the upsert handler.
- [INFO] **Error response bodies are safe** — the three distinct error codes returned (`BAD_REQUEST`, `SIGNATURE_INVALID`, `INTERNAL_ERROR`) include no DB details, no env values, no customer IDs. See item 6.

**Recommended fix (no code this cycle):** Make `handleSubscriptionDeleted` throw on either `.update` error so Stripe retries.

---

## Checklist item 5 — Tier-mapping correctness + concurrency races

**Status:** FLAG (MEDIUM severity). Correctness is OK for the simple case; concurrency story is underspecified.

**Evidence:**
- `tierFromPriceId` (`lib/stripe/client.ts:23-27`) maps price IDs to tiers via env-var comparison. Clean and deterministic.
- `subscriptions.user_id` has a `UNIQUE` constraint (`0006_user_tables.sql:62`). This means one subscription row per user — Stripe does allow a single customer to have multiple subscriptions in theory (e.g., a paused Pro and a new Elite mid-migration), and the current schema blocks that. In practice Diamond Edge only sells one subscription per user so this is fine, but if that ever changes the upsert will fail on the unique constraint and the webhook will 500-loop.
- Upgrade Pro→Elite: user clicks "upgrade" in the Stripe portal. Stripe fires `customer.subscription.updated` with the new priceId. `handleSubscriptionUpsert` looks up profile by `stripe_customer_id`, computes new tier from the priceId, upserts subscription row (onConflict stripe_sub_id — same sub ID, so updates existing row), updates profile tier. Correct.
- Downgrade Elite→Pro: same as above with reversed priceId. Correct.
- Downgrade Pro→Free: Stripe fires `customer.subscription.deleted`. `handleSubscriptionDeleted` sets `subscriptions.tier='free', status='canceled'`, updates `profiles.subscription_tier='free'`. Correct.

**Findings:**
- [MEDIUM] **No concurrency guard on `profiles.subscription_tier` update** — `handleSubscriptionUpsert` at `route.ts:67-71` does an unconditional `.update({subscription_tier: ...})` on `profiles.id`. If two Stripe events arrive in rapid succession (e.g., a retried `subscription.updated` for Pro immediately after a valid `subscription.updated` for Elite), there is a last-write-wins race. Stripe DOES send events in a reasonably stable order, but does NOT guarantee it, and the retry policy compounds this. Mitigated by the idempotency ledger recommended in item 2 (which would short-circuit replays before the update).
- [LOW] **No check for `event.created` ordering** — if a stale retry of an older event arrives after a newer event, the older event's tier will overwrite. A `WHERE updated_at < $event_created` guard on the profile update would be surgical protection. This compounds with item 2 — the event-id ledger is the primary fix; a timestamp comparison is a secondary belt.
- [LOW] **The stale-customer-id race** — `checkout/route.ts:94-119` creates a Stripe customer and updates `profiles.stripe_customer_id`. Stripe can deliver `customer.subscription.created` within milliseconds. If the profile update is still in flight (or the non-fatal DB error branch at L108-109 is hit), the webhook looks up the user by `stripe_customer_id` (`route.ts:22-25`) and gets nothing → `stripe_webhook_user_not_found` logged → 200 returned → Stripe does NOT retry → subscriber paid but has no active tier. The webhook should be more tolerant — look up by `customer.metadata.supabase_user_id` (Stripe customer was created with this metadata at `checkout/route.ts:97`) as a fallback path. Currently it doesn't.

**Recommended fixes (no code this cycle):**
- Add fallback path in `handleSubscriptionUpsert`: if profile lookup by `stripe_customer_id` fails, fetch the Stripe customer via API, read `customer.metadata.supabase_user_id`, look up profile by ID, then back-fill `stripe_customer_id`. Covers the checkout race.
- Add the `event.created` timestamp guard as belt-and-suspenders after the event-id ledger lands.

---

## Checklist item 6 — Security surface

**Status:** PASS (with one LOW-severity caution).

**Evidence:**
- Error responses (`route.ts:144-148`, `158-163`, `187-193`) return shaped `{ error: { code, message } }` bodies with no stack traces, no DB error detail, no env values, no customer IDs.
- Logs use structured objects. `route.ts:159` logs `err` which could include internal details (stack trace, `Stripe.errors.*` payloads) in the Vercel log stream. These logs are not client-visible. Acceptable.
- No HTML escaping / reflection concerns — this is a JSON-only POST endpoint.
- Service-role client (`lib/supabase/server.ts:41-56`) is used correctly — never returned to clients.
- Stripe signing secret is only referenced at `route.ts:156` inside the try/catch; not logged.
- No rate-limiting on the route; this is acceptable because signature verification gates all processing, and Stripe's own infrastructure is the trust boundary.

**Findings:**
- [LOW] **Error logs could leak Stripe error payloads** — `route.ts:159` logs `err` which may include HTTP response bodies from Stripe (e.g., during `constructEvent` failures). These should be benign but could include the signing-timestamp; safer to `err: (err as Error).message` or extract only `.code` / `.type`. Not user-facing.
- [INFO] **No structured rate-limit / flood protection** — if an attacker floods the endpoint with malformed bodies, every request incurs the cost of `constructEvent`'s HMAC check. `constructEvent` is cheap but not free, and Vercel function invocations are billable. Low priority — Stripe signs correctly and an attacker cannot forge events. Acceptable.

---

## Checklist item 7 — Test coverage

**Status:** FAIL (MEDIUM severity). Manual-only testing risk flag confirmed.

**Evidence:**
- `tests/e2e/subscription.spec.ts:1-119` — E2E UI test covering pricing page + portal link. Explicitly does NOT exercise the webhook (`subscription.spec.ts:12-13`, `L22`). Stripe APIs are never called; checkout button is stubbed.
- No file matches `**/webhook*.test.*` or `**/stripe*.test.*` anywhere in the repo.
- `tests/integration/pipeline.spec.ts` — referenced in the filelist but pertains to the pick pipeline, not billing (confirmed via filename grep).
- `TASK-009-integration-notes.md:76-112` prescribes manual testing with `stripe listen` + `stripe trigger`. No automated replacement.
- No fixture file (`stripe/fixtures/`, `__fixtures__/stripe/`, etc.) exists.
- The webhook handler has FIVE failure modes that are not exercised by any automated test:
  1. Missing `stripe-signature` header
  2. Invalid signature
  3. Unknown event type (default branch)
  4. User-not-found on customer lookup
  5. DB write failure → 500 → Stripe retry

**Severity rationale:** MEDIUM — a complete absence of webhook unit/integration tests means every future change to the webhook handler ships with only manual `stripe trigger` verification. The handler is reasonably small and the invariants are well-known, but a regression that silently swallows an event type or inverts signature verification would not be caught by CI. Pre-paid-launch this should land.

**Recommended fixes (no code this cycle):**
- Add `apps/web/app/api/webhooks/stripe/route.test.ts` (or equivalent integration layer) using a Stripe mock (`stripe.webhooks.generateTestHeaderString` is the supported path). Cover the 5 failure modes above plus: Pro→Elite upgrade, Elite→Pro downgrade, cancellation, replay of same event.id (once the ledger lands), unknown priceId, stale `subscription.updated` after `subscription.deleted`.
- Add a CI job that runs `stripe fixtures` against a local dev server pre-merge on any diff touching `apps/web/app/api/webhooks/stripe/**` or `apps/web/lib/stripe/**`.

---

## Summary

| Item | Status | Severity | Key finding |
|---|---|---|---|
| 1 Signature verification | PASS | LOW | Env-var non-null assertion could hide misconfig |
| 2 Idempotency | FAIL | **HIGH** | No persisted event-id ledger; out-of-order replays silently re-activate canceled subs |
| 3 Event handling completeness | FAIL | MEDIUM | `checkout.session.completed` missing; paused-sub tier retention bug; unknown priceId silently downgrades to free |
| 4 Error handling + retries | PASS | MEDIUM | `handleSubscriptionDeleted` swallows DB errors asymmetrically |
| 5 Tier mapping + races | FLAG | MEDIUM | Stale-customer-id race between checkout and webhook; no `event.created` ordering guard |
| 6 Security surface | PASS | LOW | Error logs may include Stripe payload internals |
| 7 Test coverage | FAIL | MEDIUM | No automated webhook tests; manual-only testing risk |

### Top 3 most concerning findings

1. **No event-id idempotency ledger (item 2, HIGH).** Out-of-order `subscription.updated`-after-`subscription.deleted` retries can silently re-activate canceled subscriptions. Persisted-event-id dedupe table is the canonical Stripe-recommended fix.
2. **`checkout.session.completed` is unhandled (item 3, HIGH in the edge case).** Combined with the in-line `stripe_customer_id` persist being marked "non-fatal" in `checkout/route.ts:107-109`, a transient DB failure during checkout creates an orphaned subscriber whose webhook cannot resolve their user row. A defense-in-depth `checkout.session.completed` handler closes the loop.
3. **Zero automated test coverage on the webhook route (item 7, MEDIUM).** Every future change ships behind manual `stripe trigger` verification. Regressions in signature check, event dispatch, or tier mapping will not be caught by CI.

### Overall posture verdict

**needs-attention.**

The webhook is correctly architected for the signature-verification, error-retry, and schema-idempotency-by-upsert dimensions. It will survive happy-path Stripe traffic at low volume. But three gaps — event-id dedupe, `checkout.session.completed`, and zero automated tests — combine to create a measurable pre-launch risk. None is CRITICAL at closed-test / low-volume; all three should land before paid traffic.

Follow-ups become new cycle-3 proposals per the scope-gate non-negotiable: "no code changes this cycle."
