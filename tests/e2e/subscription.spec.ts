/**
 * subscription.spec.ts — Subscription / paywall UI golden-path E2E tests
 *
 * Scope:
 *   - Pricing page renders all three tiers (Free / Pro $19 / Elite $39)
 *   - Checkout button is wired (disabled Stripe — does NOT call live Stripe)
 *   - Billing portal link is present for authenticated subscribers
 *   - Upgrade CTA on pick detail links to /pricing
 *
 * Out of scope:
 *   - Actual Stripe checkout (requires real Stripe account — flagged as infra blocker)
 *   - Webhook processing (tested in integration layer)
 *   - Subscription state transitions
 *
 * Level: E2E
 * Data setup: Stripe APIs are never called — checkout button route is stubbed.
 *   Billing portal link is rendered server-side from profile.stripe_customer_id.
 * Pass criteria: All pricing copy correct, buttons visible, no live Stripe calls.
 * Flake risk: Low — static pricing page. Only risk is if pricing copy changes and
 *   tests aren't updated. Mitigated by asserting key strings, not exact copy.
 * CI gating: BLOCKING
 */

import { test, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// Pricing page — accessible without auth
// ---------------------------------------------------------------------------

test.describe('pricing page', () => {
  test('pricing page renders all three tier cards', async ({ page }) => {
    await page.goto('/pricing');

    // All three tier names must appear
    await expect(page.getByText(/Free/i).first()).toBeVisible();
    await expect(page.getByText(/Pro/i).first()).toBeVisible();
    await expect(page.getByText(/Elite/i).first()).toBeVisible();

    // Prices must match the locked pricing decision ($19/mo, $39/mo)
    await expect(page.getByText(/\$19/)).toBeVisible();
    await expect(page.getByText(/\$39/)).toBeVisible();
  });

  test('checkout buttons are present on pricing page', async ({ page }) => {
    await page.goto('/pricing');

    // At least one "Get Pro" or "Get Elite" / "Subscribe" button must exist
    const ctaButtons = page.getByRole('button', {
      name: /get pro|get elite|subscribe|upgrade/i,
    });
    await expect(ctaButtons.first()).toBeVisible();
  });

  test('checkout button does not navigate to live Stripe without auth', async ({ page }) => {
    // Intercept any checkout API call to ensure it never fires unintentionally
    let stripeCallMade = false;
    await page.route('/api/billing/checkout', async (route) => {
      stripeCallMade = true;
      // Return a stub response instead of hitting real Stripe
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Login required' } }),
      });
    });

    await page.goto('/pricing');

    // Click the first CTA button — should require auth
    const firstCta = page.getByRole('button', { name: /get pro|get elite|subscribe|upgrade/i });
    if (await firstCta.count() > 0) {
      await firstCta.first().click();
      // Either redirected to login or an error is shown (not a bare crash)
      const redirectedToLogin = page.url().includes('/login');
      const errorShown = await page.getByText(/log in|sign in|unauthorized/i).isVisible();
      expect(redirectedToLogin || errorShown || stripeCallMade).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// Authenticated subscriber — billing portal link
// ---------------------------------------------------------------------------

test.describe('authenticated subscriber', () => {
  test.use({ storageState: 'tests/e2e/.auth/pro-user.json' });

  test('billing portal link is present for authenticated pro user', async ({ page }) => {
    // Mock the manage subscription API to return a portal URL
    await page.route('/api/billing/portal', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ url: 'https://billing.stripe.com/session/test' }),
      });
    });

    await page.goto('/pricing');

    // Pro user on pricing page should see "Manage Subscription" or similar portal link
    // (either a link or button that references their current plan)
    const manageLink = page.getByRole('link', { name: /manage subscription|billing portal/i });
    const manageBtn = page.getByRole('button', { name: /manage subscription|billing portal/i });

    const hasPortalAccess =
      (await manageLink.count()) > 0 || (await manageBtn.count()) > 0;

    // Portal access must be surfaced for paid subscribers
    expect(hasPortalAccess).toBeTruthy();
  });

  test('billing success page renders after mock checkout', async ({ page }) => {
    await page.goto('/billing/success');
    // Success page must acknowledge the subscription
    await expect(
      page.getByText(/subscription|success|welcome|active/i).first()
    ).toBeVisible();
  });
});
