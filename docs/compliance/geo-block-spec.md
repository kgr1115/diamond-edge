# Diamond Edge — Geo-Blocking Engineering Spec v1

**Status:** Draft — ATTORNEY REVIEW REQUIRED
**Date:** 2026-04-22
**Author:** mlb-compliance
**Implements:** Frontend (geo-gate UX) + Backend (middleware, DB check)

---

## Objective

Block access to Diamond Edge pick content and subscription flows for users physically located in non-ALLOW states, using a defense-in-depth approach: IP geolocation as the primary signal, user-declared state as a secondary signal, and a soft audit log for compliance purposes.

---

## What Gets Blocked vs. What Stays Public

| Content | ALLOW state users | BLOCK state users |
|---|---|---|
| Marketing homepage, pricing page | Visible | Visible |
| "About" / "How it works" | Visible | Visible |
| Historical pick performance stats (aggregated, no picks) | Visible | Visible |
| Today's picks (any tier) | Full access (per subscription) | Blocked — gate shown |
| Pick detail pages | Full access | Blocked |
| Subscription/checkout flow | Full access | Blocked |
| Bankroll tracker | Full access | Blocked |
| Player/team stats pages | Visible (these are public reference data) | Visible |
| Account creation (email signup) | Allowed | Allowed (can create account; picks blocked after geo-check) |

**Rationale for partial block:** Public marketing content and aggregated historical stats are information products available broadly. The risk surface is the picks and subscription — those are what state law could potentially reach. Blocking only those is defensible and reduces drop-off from curious users who may travel or relocate.

---

## Geolocation Method

### Primary: IP Geolocation

- Use a server-side IP geolocation library at the Vercel Edge Middleware layer (e.g., Vercel's built-in `geo` object from `@vercel/edge`, which provides `request.geo.region` = US state code).
- No third-party geo API needed — Vercel provides this at the Edge for free.
- Applied on every request to protected routes (picks, bankroll, subscription checkout).
- State code extracted as ISO 3166-2 (e.g., `TX`, `CA`).

### Secondary: User-Declared State

- During account creation (step 2 of onboarding, after age gate), user selects their state.
- This is stored as `profiles.geo_state` in Supabase.
- If user-declared state is BLOCK, they cannot access picks regardless of IP geolocation.
- If IP says BLOCK but user declares ALLOW state, **IP wins** — block the user with messaging that explains we use location at access time.

### Conflict Resolution: IP vs. Declared

| IP State | Declared State | Decision | User Sees |
|---|---|---|---|
| ALLOW | ALLOW | Allow | Normal access |
| ALLOW | BLOCK | Allow (IP wins) | Normal access; note that declared state is blocked |
| BLOCK | ALLOW | Block (IP wins) | "Looks like you're accessing from a restricted state" message |
| BLOCK | BLOCK | Block | Geo-gate page |
| Unknown (IP fails) | ALLOW | Allow with audit log | Normal access; logged for compliance |
| Unknown (IP fails) | BLOCK | Block | Geo-gate page |
| Unknown (IP fails) | Unknown | Block | Geo-gate page (conservative default) |

---

## Geo-Gate UX (What Blocked Users See)

### Geo-Gate Page Content

Shown instead of pick content when user is in a BLOCK state:

> **Diamond Edge is not available in your location.**
>
> Sports betting information services like Diamond Edge are only available in states where both DraftKings and FanDuel operate legally. Your current location does not meet these requirements.
>
> If you believe this is an error — for example, you are traveling from an eligible state — please check back when you return home.
>
> Questions? Contact support at [support email].

**Do NOT include:**
- A way to "bypass" the geo-gate
- Specific messaging about which state is detected (do not expose geo data to user)
- Any suggestion that VPN use is a workaround

---

## VPN Handling

- **No active VPN detection required for v1.** Commercial VPN detection (e.g., MaxMind's VPN database) adds cost and complexity without proportionate legal benefit for an information service.
- **Defense posture:** Our Terms of Service prohibit access via VPN or proxy to circumvent geo-restrictions. This transfers liability to the user.
- **Audit log:** Log the IP hash and detected state for every pick access attempt. Anomalous patterns (e.g., high volume of picks from an IP that geolocates to a BLOCK state) can be reviewed post-launch.
- **v1.1 option:** Add MaxMind GeoIP2 + VPN flag if attorney recommends it post-launch. Budget ~$20/month for MaxMind at scale.

---

## State Travel Edge Case

Users physically in an ALLOW state but with a BLOCK-state home address (declared state) get access because IP wins. This is correct behavior — if they are physically present in an ALLOW state, we are not violating that state's laws.

---

## DB-Driven Block List

The `geo_blocked_states` table in Supabase contains the list of blocked state codes. This allows the compliance team to update the list without a code deploy (e.g., a new state becomes ALLOW when a new operator launches).

**Refresh cadence:**
- `geo_blocked_states` is loaded into the Edge Middleware via a cached fetch at startup or on a short TTL (5 minutes).
- This avoids a DB round-trip on every request.
- Alternative: Bake the list into an environment variable and redeploy when it changes. Simpler for v1; use this approach first. Migrate to DB-driven in v1.1.

**v1 recommendation:** Hardcode ALLOW state list as an env variable (`GEO_ALLOW_STATES=AZ,AR,CO,...`). Update requires a Vercel env var change + redeployment (minutes, not a code change). Switch to DB-driven lookup in v1.1 when the list may change more frequently.

---

## Backend Enforcement (Defense in Depth)

Geo-blocking at the Edge is fast but can be bypassed via direct API calls. Backend API routes must also enforce geo-blocking:

1. All pick-serving API routes (`/api/picks/*`) check `profiles.geo_blocked` flag on the authenticated user's profile.
2. `profiles.geo_blocked` is set at account creation and re-evaluated on login based on `profiles.geo_state` vs. the block list.
3. For unauthenticated users, the API routes check the `request.geo.region` from Vercel edge headers.

**Sequence for auth'd request:**
1. Edge Middleware: IP geo check → block or pass.
2. API route: Check `profiles.geo_blocked` from Supabase session claims.
3. If either blocks: 403 with `{ error: { code: 'GEO_RESTRICTED' } }`.

---

## Implementation Handoff to Frontend + Backend

**Frontend tasks:**
- Implement `GeoGate` component — wraps all pick routes, checks `geo_blocked` from user session or Edge header.
- Show geo-gate page (static, no API call) when blocked.
- Add geo-state selector to onboarding step 2 (required field, not free-text — use a dropdown of US states).
- Update the `profiles` record on state selection via `POST /api/auth/update-state`.

**Backend tasks:**
- Add `profiles.geo_blocked` boolean (updated by Supabase trigger when `geo_state` changes).
- Implement Vercel Edge Middleware that reads `request.geo.region`, checks against ALLOW list env var, and sets a response header (`X-Geo-Blocked: true`) for the frontend to consume.
- Seed `geo_blocked_states` table with all non-ALLOW states.
- Enforce geo check in all `/api/picks/*` and `/api/bankroll/*` route handlers.

---

## Attorney-Review Items

- [ ] Confirm that IP-geolocation-based blocking constitutes adequate legal compliance in each ALLOW state.
- [ ] Confirm that our "BLOCK state but traveling" scenario (IP = ALLOW, declared = BLOCK) is legally sound.
- [ ] Review Terms of Service language covering VPN/proxy prohibition.
- [ ] Louisiana specifically: confirm that parish-level variance does not require sub-state blocking.
- [ ] Confirm that blocking access to picks (not blocking account creation) is the correct legal boundary.
