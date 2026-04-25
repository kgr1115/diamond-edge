/**
 * Single source of truth for runtime feature flags.
 *
 * `paidTiersEnabled()` controls whether auth, tiered entitlements, billing,
 * Stripe webhooks, age-gate, and geo-block are wired into the live surfaces.
 *
 * When false (default — portfolio mode):
 *   - Auth pages, age-gate, geo-blocked, pricing, bankroll, billing return 404.
 *   - Stripe checkout/portal/webhook routes return 404 (signature-verification
 *     code is preserved verbatim for the day the flag flips back on).
 *   - Middleware skips age-gate + geo-block enforcement.
 *   - Slate loader treats every viewer as Elite-equivalent (no field masking,
 *     no upgrade-CTA paywall on pick cards).
 *   - Top nav hides Sign In / Pricing / Bankroll / CLV.
 *
 * When true: behavior identical to the v0.1-paid-tiers tag (full SaaS).
 *
 * Read via `process.env.NEXT_PUBLIC_PAID_TIERS` so both Server Components and
 * Client Components see the same value at build time. The NEXT_PUBLIC_ prefix
 * is required for the value to be inlined into the client bundle.
 */
export function paidTiersEnabled(): boolean {
  return process.env.NEXT_PUBLIC_PAID_TIERS === 'true';
}
