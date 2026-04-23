/**
 * Vitest configuration for Diamond Edge integration tests.
 *
 * Scope: integration tests under tests/integration/ (pipeline, ingestion, rationale).
 * NOT for E2E tests — those use Playwright.
 *
 * Test environment: node (no browser globals needed for integration tests).
 * External APIs: mocked via MSW (msw/node). Supabase DB: real local test instance.
 *
 * Run: npx vitest run --config tests/vitest.config.ts
 */

import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.spec.ts'],
    exclude: ['tests/e2e/**'],

    // Global timeout — integration tests hit real DB so allow more time
    testTimeout: 30_000,

    // Run serially to avoid DB state conflicts between test files
    sequence: { concurrent: false },

    // Environment variables for the test run
    env: {
      TEST_SUPABASE_URL: process.env.TEST_SUPABASE_URL ?? 'http://localhost:54321',
      TEST_SUPABASE_SERVICE_KEY:
        process.env.TEST_SUPABASE_SERVICE_KEY ?? 'test-service-key',
      TEST_APP_URL: process.env.TEST_APP_URL ?? 'http://localhost:3000',
      CRON_SECRET: process.env.CRON_SECRET ?? 'test-cron-secret',
      FLY_WORKER_URL:
        process.env.FLY_WORKER_URL ?? 'https://diamond-edge-worker.fly.dev',
    },

    // Reporters
    reporters: process.env.CI ? ['verbose', 'github-actions'] : ['verbose'],

    // Coverage — informational only for integration tests
    coverage: {
      enabled: false, // Coverage runs separately via unit test runner
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '../apps/web'),
    },
  },
});
