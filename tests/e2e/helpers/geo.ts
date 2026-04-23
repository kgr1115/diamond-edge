/**
 * Geo-spoofing helpers for E2E tests.
 *
 * Vercel Edge Middleware reads the `x-vercel-ip-country-region` header for geo state.
 * In local dev/test, we inject this header via Playwright's extraHTTPHeaders to simulate
 * blocked and allowed geographies without a VPN or real IP routing.
 *
 * Flake risk: none — header injection is deterministic.
 */

import type { BrowserContext, Page } from '@playwright/test';

/** ISO 3166-2 state codes that are in the ALLOW list (both DK + FD licensed). */
export const ALLOW_STATE = 'NY';

/** A state not in the ALLOW list. TX does not have legal sports betting. */
export const BLOCK_STATE = 'TX';

/**
 * Create a new browser context with geo headers set to simulate an ALLOW-state user.
 * Use for tests that need a user who can see picks.
 */
export async function contextForAllowState(
  browser: import('@playwright/test').Browser
): Promise<BrowserContext> {
  return browser.newContext({
    extraHTTPHeaders: {
      'x-vercel-ip-country': 'US',
      'x-vercel-ip-country-region': ALLOW_STATE,
    },
  });
}

/**
 * Create a new browser context with geo headers set to simulate a BLOCK-state user.
 * Use for tests that assert the geo-block screen renders.
 */
export async function contextForBlockState(
  browser: import('@playwright/test').Browser
): Promise<BrowserContext> {
  return browser.newContext({
    extraHTTPHeaders: {
      'x-vercel-ip-country': 'US',
      'x-vercel-ip-country-region': BLOCK_STATE,
    },
  });
}

/**
 * Set geo headers on an existing page for a single navigation.
 * Useful when the context already exists (e.g., authenticated context).
 */
export async function setGeoHeadersOnPage(page: Page, stateCode: string): Promise<void> {
  await page.setExtraHTTPHeaders({
    'x-vercel-ip-country': 'US',
    'x-vercel-ip-country-region': stateCode,
  });
}
