/**
 * Test user credentials and IDs for each subscription tier.
 *
 * These accounts are seeded into the LOCAL Supabase test instance only.
 * They NEVER exist in prod. Credentials are intentionally weak — test-only.
 *
 * To seed: run `npx tsx tests/fixtures/seed.ts` against a running `supabase start` instance.
 */

export const TEST_USERS = {
  free: {
    email: 'test-free@diamondedge.test',
    password: 'TestPassword123!',
    tier: 'free' as const,
    // UUID is assigned by Supabase at seed time; populated here for API-level tests.
    userId: process.env.TEST_FREE_USER_ID ?? 'free-user-uuid-placeholder',
  },
  pro: {
    email: 'test-pro@diamondedge.test',
    password: 'TestPassword123!',
    tier: 'pro' as const,
    userId: process.env.TEST_PRO_USER_ID ?? 'pro-user-uuid-placeholder',
  },
  elite: {
    email: 'test-elite@diamondedge.test',
    password: 'TestPassword123!',
    tier: 'elite' as const,
    userId: process.env.TEST_ELITE_USER_ID ?? 'elite-user-uuid-placeholder',
  },
} as const;

/** Sportsbook UUIDs seeded in the test DB (match migration seed values). */
export const TEST_SPORTSBOOKS = {
  draftkings: 'sb-draftkings-test-uuid',
  fanduel: 'sb-fanduel-test-uuid',
} as const;

/** A test pick UUID seeded for each required tier. Used by pick-detail E2E tests. */
export const TEST_PICKS = {
  /** A pick with required_tier = 'pro' — free users see upgrade CTA, pro+ see rationale. */
  pro_pick_id: process.env.TEST_PRO_PICK_ID ?? 'pro-pick-uuid-placeholder',
  /** A pick with required_tier = 'elite' — only elite users see SHAP attributions. */
  elite_pick_id: process.env.TEST_ELITE_PICK_ID ?? 'elite-pick-uuid-placeholder',
} as const;
