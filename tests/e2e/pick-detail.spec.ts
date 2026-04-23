/**
 * pick-detail.spec.ts — Pick detail page golden-path E2E tests
 *
 * Scope:
 *   - Free user: sees pick_side + confidence_tier only; no line, no EV, no rationale
 *   - Pro user: sees line, model_probability, full rationale text; no EV, no SHAP
 *   - Elite user: sees all fields including EV and SHAP attributions
 *   - Upgrade CTA is visible to free users when rationale is locked
 *   - Responsible gambling "A note on risk" sidebar is always rendered
 *
 * Out of scope:
 *   - Pick result grading UI
 *   - Historical pick performance charts
 *
 * Level: E2E
 * Data setup: Pick detail API mocked at HTTP layer (three variants: free/pro/elite response).
 * Pass criteria: Tier-gated fields appear/absent per API contract in docs/api/api-contracts-v1.md.
 * Flake risk: Low — purely UI assertions against mocked API.
 * CI gating: BLOCKING
 */

import { test, expect } from '@playwright/test';

const TEST_PICK_ID = 'ffffffff-0001-0001-0001-000000000001';

/** Base pick object — always visible to all tiers. */
const BASE_PICK = {
  id: TEST_PICK_ID,
  game: {
    id: 'dddddddd-0001-0001-0001-000000000001',
    home_team: { id: '1', name: 'New York Yankees', abbreviation: 'NYY' },
    away_team: { id: '2', name: 'Boston Red Sox', abbreviation: 'BOS' },
    game_time_utc: new Date(Date.now() + 4 * 3600 * 1000).toISOString(),
    status: 'scheduled',
    probable_home_pitcher: { id: 'p1', full_name: 'Test Pitcher NYY' },
    probable_away_pitcher: { id: 'p2', full_name: 'Test Pitcher BOS' },
    weather: { condition: 'clear', temp_f: 72, wind_mph: 8, wind_dir: 'SW' },
  },
  market: 'moneyline',
  pick_side: 'home',
  confidence_tier: 4,
  required_tier: 'pro',
  result: 'pending',
  generated_at: new Date().toISOString(),
};

function mockPickApi(page: import('@playwright/test').Page, pickBody: object): void {
  page.route(`/api/picks/${TEST_PICK_ID}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ pick: pickBody }),
    });
  });
}

// ---------------------------------------------------------------------------
// Free user: pick side + confidence only
// ---------------------------------------------------------------------------

test.describe('free user pick detail', () => {
  test.use({ storageState: 'tests/e2e/.auth/free-user.json' });

  test('free user sees pick side and confidence, not rationale or line', async ({ page }) => {
    mockPickApi(page, {
      ...BASE_PICK,
      // No best_line_price, no model_probability, no expected_value, no rationale
    });

    await page.goto(`/picks/${TEST_PICK_ID}`);

    // Always visible: game matchup
    await expect(page.getByText(/Boston Red Sox @ New York Yankees/i)).toBeVisible();

    // Always visible: pick side
    await expect(page.getByText(/home/i)).toBeVisible();

    // Gated fields must NOT appear for free user (API returns them absent)
    await expect(page.getByText(/Model:/i)).not.toBeVisible();
    await expect(page.getByText(/EV:/i)).not.toBeVisible();
    await expect(page.getByText(/Model Feature Drivers/i)).not.toBeVisible();

    // Upgrade CTA must be visible when rationale is locked
    await expect(
      page.getByText(/upgrade to pro to see the full statistical analysis/i)
    ).toBeVisible();
  });

  test('responsible gambling sidebar is visible for free user', async ({ page }) => {
    mockPickApi(page, { ...BASE_PICK });
    await page.goto(`/picks/${TEST_PICK_ID}`);

    // "A note on risk" sidebar — Surface 5 per responsible-gambling spec
    await expect(page.getByText(/a note on risk/i)).toBeVisible();
    await expect(page.getByText(/1-800-522-4700/)).toBeVisible();
    await expect(page.getByText(/past performance does not predict future results/i)).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Pro user: line + model probability + rationale, but no EV or SHAP
// ---------------------------------------------------------------------------

test.describe('pro user pick detail', () => {
  test.use({ storageState: 'tests/e2e/.auth/pro-user.json' });

  test('pro user sees line, model probability, and rationale', async ({ page }) => {
    mockPickApi(page, {
      ...BASE_PICK,
      best_line_price: -140,
      best_line_book: 'FanDuel',
      model_probability: 0.602,
      rationale:
        'The Yankees hold a significant home-field advantage with a strong rotation matchup. ' +
        'Model probability sits at 60.2%, implying +EV at current DK line of -145.',
      // No expected_value, no shap_attributions
    });

    await page.goto(`/picks/${TEST_PICK_ID}`);

    // Pro fields visible
    await expect(page.getByText(/-140/)).toBeVisible();
    await expect(page.getByText(/FanDuel/i)).toBeVisible();
    await expect(page.getByText(/Model:.*60\.2%/i)).toBeVisible();

    // Rationale must render for pro user
    await expect(
      page.getByText(/significant home-field advantage/i)
    ).toBeVisible();

    // EV and SHAP must NOT appear (elite only)
    await expect(page.getByText(/EV:/i)).not.toBeVisible();
    await expect(page.getByText(/Model Feature Drivers/i)).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Elite user: all fields including EV and SHAP
// ---------------------------------------------------------------------------

test.describe('elite user pick detail', () => {
  test.use({ storageState: 'tests/e2e/.auth/elite-user.json' });

  test('elite user sees all fields including EV and SHAP attributions', async ({ page }) => {
    mockPickApi(page, {
      ...BASE_PICK,
      best_line_price: -140,
      best_line_book: 'FanDuel',
      model_probability: 0.602,
      expected_value: 0.061,
      rationale:
        'Elite-tier analysis: wRC+ differential of +22 favors NYY offense. ' +
        'Bullpen metrics and park factor confirm edge.',
      shap_attributions: [
        { feature: 'home_team_era_last_7d', value: 0.038, direction: 'positive' },
        { feature: 'away_starter_whip', value: 0.025, direction: 'positive' },
        { feature: 'weather_wind_mph', value: -0.012, direction: 'negative' },
      ],
    });

    await page.goto(`/picks/${TEST_PICK_ID}`);

    // EV visible to elite
    await expect(page.getByText(/EV:.*\+6\.1%/i)).toBeVisible();

    // SHAP attributions section
    await expect(page.getByText(/Model Feature Drivers/i)).toBeVisible();
    await expect(page.getByText(/home_team_era_last_7d/i)).toBeVisible();

    // Full rationale
    await expect(page.getByText(/wRC\+ differential/i)).toBeVisible();
  });
});
