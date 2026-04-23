/**
 * Auth setup — generates stored browser auth state for each subscription tier.
 *
 * Runs once before all golden-path test projects (via playwright.config.ts dependencies).
 * Stored state files are reused across all tests in the session — no repeat logins.
 *
 * Flake risk: Supabase local auth is fast but occasionally slow on cold start.
 * Mitigation: retry once (see playwright.config.ts retries).
 */

import { test as setup, expect } from '@playwright/test';
import { AUTH_STATE } from '../playwright.config';
import { TEST_USERS } from '../../fixtures/test-users';

/**
 * Logs in as the given user via the sign-in page and saves the browser storage state.
 * Using UI login (not API shortcut) to exercise the real auth flow.
 */
async function loginAs(
  page: import('@playwright/test').Page,
  email: string,
  password: string,
  storageFile: string
): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();

  // Wait for redirect away from /login — indicates successful auth.
  await expect(page).not.toHaveURL(/\/login/, { timeout: 10_000 });

  // If age gate is hit (first-time flow), complete it with a passing DOB.
  if (page.url().includes('/age-gate')) {
    await page.selectOption('#month', '1');
    await page.selectOption('#day', '1');
    await page.fill('#year', '1990');
    await page.getByRole('button', { name: /confirm age/i }).click();
    await expect(page).not.toHaveURL(/\/age-gate/, { timeout: 8_000 });
  }

  await page.context().storageState({ path: storageFile });
}

setup('authenticate free user', async ({ page }) => {
  await loginAs(page, TEST_USERS.free.email, TEST_USERS.free.password, AUTH_STATE.free);
});

setup('authenticate pro user', async ({ page }) => {
  await loginAs(page, TEST_USERS.pro.email, TEST_USERS.pro.password, AUTH_STATE.pro);
});

setup('authenticate elite user', async ({ page }) => {
  await loginAs(page, TEST_USERS.elite.email, TEST_USERS.elite.password, AUTH_STATE.elite);
});
