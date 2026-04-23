# Diamond Edge — Age Gate Spec v1

**Status:** Draft — ATTORNEY REVIEW REQUIRED
**Date:** 2026-04-22
**Author:** mlb-compliance
**Implements:** Frontend (age gate UI) + Backend (`/api/auth/age-verify`, `profiles` table, `age_gate_logs` table)

---

## Requirement

All users must confirm they are 21 years of age or older before accessing any pick content or subscription flow. This applies in all ALLOW states, regardless of whether the state's own minimum betting age is 18 or 21. Our standard is 21+, full stop.

---

## Where the Gate Appears

### Placement in user flow:

1. **Pre-subscription gate (unauthenticated):** Users who navigate to the pricing/subscription page see a lightweight 21+ acknowledgment gate before viewing pricing. This is a checkbox confirmation only — no DOB entry at this step. Purpose: Signal the age requirement before any account creation begins.

2. **Post-signup gate (authenticated, onboarding step 2):** Immediately after email verification and before the user can view any picks, they must complete the full DOB-entry age gate. This is the hard gate.

3. **Re-check on session start (soft check):** If `profiles.age_verified = false`, redirect every authenticated user to the age gate step before any protected route serves. This catches accounts that slipped through without completing the gate.

### What is NOT gated:
- Public marketing pages (homepage, about, pricing)
- Aggregated historical performance stats (these are public)
- Account creation itself (email + password — so we can complete age verification as step 2)

---

## Gate Mechanics

### Step 1: Checkbox pre-gate (pre-signup, marketing → subscription flow)
- One checkbox: "I confirm that I am 21 years of age or older."
- One checkbox: "I am located in a state where sports betting is legal."
- No DOB entry at this step.
- Does not write to DB. Session-only signal that unlocks the sign-up form.
- Purpose: Compliance posture signal before account creation. Not the hard gate.

### Step 2: DOB entry gate (post-signup, onboarding)
- Present a date picker or three dropdowns (Month / Day / Year).
- User enters their date of birth.
- Server computes age from DOB at submission time.
- **If age >= 21:** Set `profiles.age_verified = true`, `profiles.age_verified_at = now()`. Store `profiles.date_of_birth` (see storage note below). Write a passing record to `age_gate_logs`. Proceed to next onboarding step.
- **If age < 21:** Do NOT set `age_verified`. Write a failing record to `age_gate_logs`. Show failure message. Lock account from pick content.

---

## DOB Storage Decision

**Decision: Store full date of birth in `profiles.date_of_birth` (type: `date`).**

**Rationale:**
- Full DOB is necessary for audit purposes — if a user later claims they provided a false DOB, we have the record.
- We do not store raw IP addresses — only IP hashes (SHA-256) in `age_gate_logs` for privacy compliance.
- DOB is stored as a date type, not as a string, to prevent format-variant storage.
- DOB is never exposed via any API endpoint.

**Attorney-review item:** Confirm that storing full DOB is preferred over an age-verified boolean only. Some attorneys prefer boolean-only to minimize PII exposure. The tradeoff is audit trail strength. We recommend full DOB for v1; attorney may override.

---

## Failure Behavior

When a user fails the age gate (age < 21):
1. Show the message: "You must be 21 or older to use Diamond Edge." No detail about how close they are (e.g., do not say "You are 20 years old").
2. Do NOT reveal whether the DOB was "too young" vs. "invalid format" — both failures return the same message to prevent reverse-engineering the threshold.
3. Lock the account: `profiles.age_verified = false` remains. The user cannot access picks.
4. **Can the user retry?** No — not on the same account. Once a DOB is submitted and fails, the account is locked. The user must contact support to appeal (attorney may advise on appeal process). This prevents brute-force DOB entry to find a passing date.
5. **Re-attempt via new account:** A user creating a new account with a new email would go through the same gate. We do not fingerprint users across accounts for v1 — this is a known limitation.

---

## Audit Log

Every age gate submission writes a record to `age_gate_logs`:
- `user_id`: the authenticated user's UUID
- `ip_hash`: SHA-256 of the request IP (not raw IP — privacy)
- `passed`: boolean
- `method`: 'dob_entry'
- `created_at`: timestamp

This log is append-only and accessible only to service role (not user-readable via RLS for their own logs in v1 — attorney may advise on CCPA/CPRA right-of-access implications).

---

## Edge Cases

| Scenario | Handling |
|---|---|
| User enters a future DOB | Form validation rejects before submission. "Please enter a valid date of birth." |
| User enters DOB > 120 years ago | Form validation rejects. Reasonable upper bound. |
| User enters DOB exactly on 21st birthday | Server-side: `age = (today - dob).years`. If exactly 21 years today, passes. |
| User changes their declared DOB after passing | `profiles.date_of_birth` is immutable after `age_verified = true`. API rejects update attempts. |
| Age verification succeeds, then user turns out to be underage | Defense in depth: ToS prohibits misrepresentation. Log exists. Attorney handles if it arises. |

---

## Implementation Handoff

**Frontend:**
- Build `AgeGateModal` or `AgeGatePage` component — full-screen, cannot be dismissed without entry.
- DOB entry: three dropdowns (Month / Day / Year) or a single date input — test both for mobile UX.
- Show a friendly failure message with no specifics.
- After passing, immediately progress to next onboarding step without re-showing the gate.

**Backend:**
- `POST /api/auth/age-verify` — accepts `{ date_of_birth: 'YYYY-MM-DD', method: 'dob_entry' }`.
- Computes age server-side (never trust client-computed age).
- On pass: updates `profiles`, writes to `age_gate_logs`, returns `{ verified: true }`.
- On fail: writes to `age_gate_logs`, returns `403 { error: { code: 'AGE_GATE_FAILED', message: 'Age verification failed.' } }`.
- After fail, the `profiles.age_verified` flag remains false; all pick-serving routes check this flag and return 403.

---

## Attorney-Review Items

- [ ] Confirm that DOB-entry (self-attestation) is legally sufficient for age verification in all 25 ALLOW states, or whether any state requires third-party identity verification.
- [ ] Confirm that storing full DOB (vs. age-flag-only) is preferred or required.
- [ ] Confirm the "no retry" policy is appropriate or whether an appeal process must be specified.
- [ ] Review failure message wording to ensure no inadvertent implied obligations.
- [ ] Confirm CCPA/CPRA applicability to DOB storage if any California residents create accounts before the geo-block catches them (e.g., VPN users).
