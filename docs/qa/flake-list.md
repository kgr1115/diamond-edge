# Diamond Edge — Flaky Test Registry

**Owner:** mlb-qa
**Policy:** Flaky tests are bugs. A flaky test is never silently retried and accepted.
  When a test is identified as flaky, it is quarantined (skipped with a `test.skip`)
  immediately and a fix is tracked in this file. Quarantined tests do not count as
  passing for staging gate purposes.

**How to report a flake:**
  1. Reproduce the flake (run the test 5 times; fail > 0 but < 5 times = flaky).
  2. Add an entry to this file.
  3. Add `test.skip('FLAKE-NNN: reason', ...)` to the test.
  4. File the entry below and notify the owning agent.

---

## Active Flakes

_No flakes recorded yet. This file is initialized at TASK-011 scaffold time (2026-04-22)._

---

## Resolved Flakes

_Empty — maintained as issues are found and fixed._

---

## Flake Entry Template

```
### FLAKE-NNN: [short description]
- **Test file:** tests/e2e/foo.spec.ts or tests/integration/bar.spec.ts
- **Test name:** exact test() / it() name string
- **First seen:** YYYY-MM-DD
- **Repro rate:** X/10 runs
- **Root cause:** [hypothesis or confirmed cause]
- **Mitigation applied:** [e.g., increased timeout, added waitFor, removed time-sensitive assertion]
- **Fix owner:** [agent name or team member]
- **Status:** quarantined | in-fix | resolved
- **Resolved:** YYYY-MM-DD (if resolved)
```

---

## Known Non-Determinism Sources (documented proactively)

These are not current flakes but are documented as future flake risks:

| Source | Affected tests | Mitigation in place |
|--------|---------------|---------------------|
| Supabase local cold start latency | All integration tests | beforeAll health-check ping with error message directing user to `supabase start` |
| Geo header injection (Playwright) | `slate.spec.ts` — geo-block assertions | `setExtraHTTPHeaders` before navigation; middleware must run in dev mode |
| Time-based DOB calculation (age gate) | `auth.spec.ts` — age gate fail test | Uses `currentYear - 20` for DOB year, always < 21 |
| Stripe checkout redirect | `subscription.spec.ts` | Checkout route is mocked; no live Stripe dependency |
| Redis invalidation timing | `pipeline.spec.ts` — cache assertions | Redis calls are mocked via MSW; no real Redis in CI |
| pick_date in ET vs UTC | `pipeline.spec.ts` — picks_written count | `todayInET()` helper matches the pipeline's own logic; verified in seed |
| Duplicate rationale_cache inserts across pipeline runs | `pipeline.spec.ts` | Each run generates new picks; rationale dedup via prompt_hash prevents double-billing but may return cached row |
