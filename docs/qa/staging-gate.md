# Diamond Edge — Staging Gate Criteria

**Owner:** mlb-qa
**Enforced by:** mlb-devops (blocks the staging deploy step in CI/CD)
**Last updated:** 2026-04-22

A deploy to staging is only permitted when ALL items below are checked. DevOps runs the
deploy only after QA confirms this checklist is green in the most recent CI run on main.

---

## Pre-Deploy Checklist

### 1. CI Green on main

- [ ] `lint` job passes (ESLint — zero errors)
- [ ] `type-check` job passes (TypeScript — zero errors)
- [ ] `integration` job passes — all three test files:
  - [ ] `tests/integration/pipeline.spec.ts` — all assertions pass
  - [ ] `tests/integration/ingestion.spec.ts` — all assertions pass
  - [ ] `tests/integration/rationale.spec.ts` — all assertions pass

### 2. E2E Golden Path — All Suites Green

All five Playwright suites must have zero failures in the most recent run:

- [ ] `auth.spec.ts` — signup, age gate passes (1990 DOB), age gate fails (< 21), login, logout
- [ ] `slate.spec.ts` — ALLOW-state user sees slate, BLOCK-state user sees geo-block screen
- [ ] `pick-detail.spec.ts` — free / pro / elite tier-gating assertions
- [ ] `subscription.spec.ts` — pricing page, checkout button present, billing portal link
- [ ] `bankroll.spec.ts` — log bet, appears in history, ROI updates

### 3. Compliance Gates — MUST PASS explicitly (not just exist)

These are not skippable under any release timeline pressure.

- [ ] **Age gate: 21+ passes** — `auth.spec.ts` assertion `user born in 1990 passes age gate`
- [ ] **Age gate: < 21 fails with NO info leakage** — `auth.spec.ts` assertion `user born 5 years ago fails — no info leakage`
  - Specific check: the test asserts that "20 years old", "invalid date", and "too young" strings are NOT visible
- [ ] **Age gate failure shows RG helpline** — 1-800-522-4700 appears on the failure screen
- [ ] **Geo-block screen renders for BLOCK-state** — `slate.spec.ts` TX-context assertion passes
  - Specific check: "Not Available in Your Location" and "DraftKings and FanDuel" text visible
  - Specific check: detected state code (TX) is NOT visible on the geo-block page
- [ ] **Geo-block page shows RG helpline** — 1-800-522-4700 appears on `/geo-blocked`
- [ ] **Pick detail shows RG copy ("A note on risk")** — `pick-detail.spec.ts` sidebar assertion passes
- [ ] **RG banner visible on slate** — `slate.spec.ts` helpline assertion passes

### 4. Pick Pipeline Validation

- [ ] Most recent daily pipeline-validation run passed (or integration test on this commit passed)
- [ ] EV filter correctly drops picks with EV < 4% (pipeline.spec.ts assertion)
- [ ] required_tier mapping is correct (confidence_tier 5 → elite, 3-4 → pro)
- [ ] Picks write to DB with non-null rationale_id (rationale service is reachable)

### 5. Error Monitoring

- [ ] Sentry (or equivalent) shows zero unhandled errors on the staging environment in the last 24h
  - Note: During initial staging provisioning, baseline 24h window starts after first deploy.
    First deploy is gated by items 1-4 above; Sentry check applies to all subsequent deploys.

### 6. Build

- [ ] `build` CI job passed — Next.js production build completes without error

---

## Escalation

If any item fails:

1. Do NOT deploy to staging.
2. File a bug against the owning agent (see CLAUDE.md Agent Roster).
3. If the failure is in a compliance gate (age gate or geo-block), treat as P0 — no exceptions.
4. If a flaky test is suspected, check `docs/qa/flake-list.md` before bypassing.

---

## Notes

- Stripe checkout E2E is NOT in this checklist because it requires a real Stripe account
  (infra blocker tracked separately). The checkout button's presence and wiring is tested;
  the actual Stripe redirect is not.
- ML model accuracy is NOT in this checklist. The pipeline gate confirms the pipeline
  runs and writes picks — model accuracy is a business concern, not a deployment blocker.
- The staging gate does not include `history` page E2E because the seeded test data is
  minimal. History page smoke test is included as a v1.1 backlog item.
