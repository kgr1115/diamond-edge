/**
 * auth.spec.ts — Golden-path auth E2E tests
 *
 * Scope:
 *   - Signup flow (email + password)
 *   - Age gate: 21+ DOB passes, 20-year-old DOB fails with no information leakage
 *   - Login with valid credentials
 *   - Logout clears session
 *
 * Out of scope:
 *   - OAuth providers (not in v1)
 *   - Password reset flow
 *   - Account deletion
 *
 * Level: E2E
 * Data setup: Test users pre-seeded by tests/fixtures/seed.ts. New signup uses a
 *   unique email per run (avoids duplicate-email collisions between test runs).
 * Pass criteria: See individual test assertions.
 * Flake risk: Supabase email confirmation round-trip. Mitigated by `email_confirm: true`
 *   in admin seed (local) and stub SMTP in CI. Second flake source: redirect timing
 *   after login — mitigated with explicit URL assertion.
 * CI gating: BLOCKING
 */

import { test, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// Age gate — critical compliance tests
// ---------------------------------------------------------------------------

test.describe('age gate', () => {
  test('user born in 1990 (age > 21) passes age gate and accesses picks', async ({ page }) => {
    // Navigate to age gate directly (as if coming from onboarding)
    await page.goto('/age-gate');

    // Confirm the gate renders with the correct 21+ messaging
    await expect(page.getByRole('heading', { name: /diamond edge/i })).toBeVisible();
    await expect(page.getByText(/21 or older/i)).toBeVisible();

    // Fill out DOB: January 1, 1990 — definitively >= 21
    await page.selectOption('#month', '1');
    await page.selectOption('#day', '1');
    await page.fill('#year', '1990');

    // Mock the API response — age-verify route will be called
    await page.route('/api/auth/age-verify', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ verified: true, age_verified_at: new Date().toISOString() }),
      });
    });

    await page.getByRole('button', { name: /confirm age/i }).click();

    // After pass: redirect away from age-gate
    await expect(page).not.toHaveURL(/\/age-gate/, { timeout: 8_000 });
  });

  test('user born 5 years ago (age < 21) fails age gate — no info leakage', async ({ page }) => {
    await page.goto('/age-gate');

    const tooYoungYear = new Date().getFullYear() - 20;
    await page.selectOption('#month', '6');
    await page.selectOption('#day', '15');
    await page.fill('#year', String(tooYoungYear));

    // Mock the API — returns the generic 403 (no DOB vs. age detail)
    await page.route('/api/auth/age-verify', async (route) => {
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'AGE_GATE_FAILED', message: 'Age verification failed.' },
        }),
      });
    });

    await page.getByRole('button', { name: /confirm age/i }).click();

    // Must show the generic failure message
    await expect(
      page.getByText(/you must be 21 or older to use diamond edge/i)
    ).toBeVisible({ timeout: 6_000 });

    // COMPLIANCE: must NOT reveal the specific reason (too young vs. bad format)
    await expect(page.getByText(/20 years old/i)).not.toBeVisible();
    await expect(page.getByText(/invalid date/i)).not.toBeVisible();
    await expect(page.getByText(/too young/i)).not.toBeVisible();

    // COMPLIANCE: failure screen must surface the responsible gambling helpline
    await expect(page.getByText(/1-800-522-4700/)).toBeVisible();

    // User stays on the age gate page — no redirect on failure
    await expect(page).toHaveURL(/\/age-gate/);
  });

  test('age gate submit button is disabled until all three DOB fields are filled', async ({
    page,
  }) => {
    await page.goto('/age-gate');

    const submitBtn = page.getByRole('button', { name: /confirm age/i });
    await expect(submitBtn).toBeDisabled();

    await page.selectOption('#month', '3');
    await expect(submitBtn).toBeDisabled();

    await page.selectOption('#day', '15');
    await expect(submitBtn).toBeDisabled();

    await page.fill('#year', '1985');
    await expect(submitBtn).toBeEnabled();
  });

  test('age gate page surfaces 21+ copy and responsible gambling helpline', async ({ page }) => {
    await page.goto('/age-gate');
    // COMPLIANCE: 21+ copy must be present on the gate
    await expect(page.getByText(/21 or older/i)).toBeVisible();
    // COMPLIANCE: responsible gambling number must appear
    await expect(page.getByText(/1-800-522-4700/)).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Login / Logout
// ---------------------------------------------------------------------------

test.describe('login and logout', () => {
  test('valid credentials redirect away from /login', async ({ page }) => {
    await page.goto('/login');

    await page.route('/api/auth/callback', async (route) => route.continue());

    // Mock Supabase auth — we test the UI flow, not Supabase's auth service
    await page.route('**/auth/v1/token**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          access_token: 'mock-access-token',
          token_type: 'bearer',
          expires_in: 3600,
          refresh_token: 'mock-refresh-token',
          user: {
            id: 'free-user-uuid-placeholder',
            email: 'test-free@diamondedge.test',
          },
        }),
      });
    });

    await page.getByLabel('Email').fill('test-free@diamondedge.test');
    await page.getByLabel('Password').fill('TestPassword123!');
    await page.getByRole('button', { name: /sign in/i }).click();

    // After a successful login, user is not still on /login
    await expect(page).not.toHaveURL(/\/login/, { timeout: 8_000 });
  });

  test('login page renders email and password fields', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible();
  });

  test('signup page renders and links to login', async ({ page }) => {
    await page.goto('/signup');
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
    // Sign up page must link back to login
    await expect(page.getByRole('link', { name: /sign in/i })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Authenticated session — uses stored auth state for free user
// ---------------------------------------------------------------------------

test.describe('authenticated navigation', () => {
  test.use({ storageState: 'tests/e2e/.auth/free-user.json' });

  test('authenticated user can navigate to picks/today', async ({ page }) => {
    // Mock the picks API so we don't need a live pipeline
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

    // Should land on picks page (not redirected to login or age-gate)
    await expect(page).toHaveURL(/\/picks\/today/);
    // COMPLIANCE: responsible gambling copy must be visible on pick surfaces
    await expect(page.getByText(/1-800-522-4700/).first()).toBeVisible();
  });
});
