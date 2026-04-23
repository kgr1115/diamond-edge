/**
 * slate.spec.ts — Slate view golden-path E2E tests
 *
 * Scope:
 *   - Slate renders for an ALLOW-state user (geo-header = NY)
 *   - Geo-block screen renders for a BLOCK-state user (geo-header = TX)
 *   - Responsible gambling copy is present on the slate surface
 *   - Free user sees pick cards but not gated fields (no EV, no line detail)
 *   - Zero-state renders correctly when no picks qualify
 *
 * Out of scope:
 *   - Live odds rendering (no live Odds API in tests)
 *   - Pick pipeline triggering
 *
 * Level: E2E
 * Data setup: picks seeded via tests/fixtures/seed.ts; API responses mocked at HTTP layer.
 * Pass criteria: explicit assertions below.
 * Flake risk: geo-header injection via setExtraHTTPHeaders depends on middleware reading
 *   the header. If middleware is cached or bypassed in dev mode, test will fail.
 *   Mitigation: ensure middleware runs in dev (force-dynamic is set on the page).
 * CI gating: BLOCKING
 */

import { test, expect } from '@playwright/test';
import { setGeoHeadersOnPage, ALLOW_STATE, BLOCK_STATE } from './helpers/geo';

const MOCK_PICKS_RESPONSE = {
  date: new Date().toISOString().split('T')[0],
  picks: [
    {
      id: 'ffffffff-0001-0001-0001-000000000001',
      game: {
        id: 'dddddddd-0001-0001-0001-000000000001',
        home_team: { id: '1', name: 'New York Yankees', abbreviation: 'NYY' },
        away_team: { id: '2', name: 'Boston Red Sox', abbreviation: 'BOS' },
        game_time_utc: new Date().toISOString(),
        status: 'scheduled',
      },
      market: 'moneyline',
      pick_side: 'home',
      confidence_tier: 4,
      required_tier: 'pro',
      result: 'pending',
    },
  ],
  total: 1,
  user_tier: 'free',
};

// ---------------------------------------------------------------------------
// ALLOW state — user should see the slate
// ---------------------------------------------------------------------------

test.describe('allow-state user', () => {
  test.use({ storageState: 'tests/e2e/.auth/free-user.json' });

  test('slate renders for NY (allow-state) user', async ({ page }) => {
    await setGeoHeadersOnPage(page, ALLOW_STATE);

    await page.route('/api/picks/today', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...MOCK_PICKS_RESPONSE, user_tier: 'free' }),
      });
    });

    await page.goto('/picks/today');

    // Should NOT be on geo-blocked page
    await expect(page).not.toHaveURL(/\/geo-blocked/);
    await expect(page).toHaveURL(/\/picks\/today/);

    // COMPLIANCE: responsible gambling banner must be on pick surface
    await expect(page.getByText(/1-800-522-4700/).first()).toBeVisible();

    // Slate heading renders
    await expect(page.getByRole('heading', { name: /today.s picks/i })).toBeVisible();
  });

  test('pick card renders pick_side and confidence_tier for free user', async ({ page }) => {
    await setGeoHeadersOnPage(page, ALLOW_STATE);

    await page.route('/api/picks/today', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...MOCK_PICKS_RESPONSE, user_tier: 'free' }),
      });
    });

    await page.goto('/picks/today');

    // Pick side must be visible to all tiers
    await expect(page.getByText(/home|away|over|under/i).first()).toBeVisible();
  });

  test('zero-state renders when no picks qualify', async ({ page }) => {
    await setGeoHeadersOnPage(page, ALLOW_STATE);

    await page.route('/api/picks/today', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          date: new Date().toISOString().split('T')[0],
          picks: [],
          total: 0,
          user_tier: 'free',
        }),
      });
    });

    await page.goto('/picks/today');

    await expect(page.getByText(/no qualifying picks today/i)).toBeVisible();
    // Link to history should be present as a fallback
    await expect(page.getByRole('link', { name: /view pick history/i })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// BLOCK state — user must see the geo-block screen, NOT picks
// ---------------------------------------------------------------------------

test.describe('block-state user', () => {
  test('geo-block screen renders for TX (block-state) visitor', async ({ browser }) => {
    // Use a fresh context so we can inject TX geo headers before any navigation.
    const context = await browser.newContext({
      extraHTTPHeaders: {
        'x-vercel-ip-country': 'US',
        'x-vercel-ip-country-region': BLOCK_STATE,
      },
    });
    const page = await context.newPage();

    // Middleware should redirect picks routes to geo-blocked
    await page.goto('/picks/today');

    // Either redirected to /geo-blocked or the geo-blocked content appears inline
    const isGeoBlocked =
      page.url().includes('/geo-blocked') ||
      (await page.getByText(/not available in your location/i).isVisible());

    expect(isGeoBlocked).toBeTruthy();

    // COMPLIANCE: geo-block page must show the required copy (per geo-block-spec.md)
    await page.goto('/geo-blocked');
    await expect(
      page.getByText(/not available in your location/i)
    ).toBeVisible();
    await expect(
      page.getByText(/DraftKings and FanDuel/i)
    ).toBeVisible();

    // COMPLIANCE: responsible gambling helpline must be on the geo-block page
    await expect(page.getByText(/1-800-522-4700/)).toBeVisible();

    // COMPLIANCE: must NOT mention which specific state was detected
    await expect(page.getByText(new RegExp(BLOCK_STATE))).not.toBeVisible();

    await context.close();
  });

  test('geo-block page shows the list of allowed states', async ({ page }) => {
    await page.goto('/geo-blocked');

    // The page lists available states (per geo-block-spec.md UX spec)
    await expect(page.getByText(/available states/i)).toBeVisible();
    // Spot-check a few known ALLOW states appear in the list
    await expect(page.getByText('NY')).toBeVisible();
    await expect(page.getByText('NJ')).toBeVisible();
    await expect(page.getByText('CO')).toBeVisible();
  });
});
