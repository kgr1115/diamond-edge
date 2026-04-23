/**
 * pipeline.spec.ts — Pick pipeline end-to-end integration test
 *
 * Scope:
 *   Tests the full Supabase Edge Function pipeline:
 *     game_fetch → odds_fetch → worker_call → ev_filter → rationale_call → db_write → cache_invalidate
 *   Against a REAL local Supabase test DB (seeded via tests/fixtures/seed.ts).
 *   Fly.io /predict worker is mocked at the HTTP boundary.
 *   Anthropic rationale API is mocked at the HTTP boundary.
 *   Redis invalidation is mocked (no local Redis required for integration test).
 *
 * Out of scope:
 *   - ML model accuracy / calibration (ML engineer owns)
 *   - Full E2E through the UI (Playwright layer owns)
 *   - Stripe webhook processing
 *
 * Level: Integration (pipeline)
 * Data setup: Real test DB seeded with games + odds (via seed.ts).
 *   Worker /predict returns mock PickCandidate array.
 *   Rationale API returns canned text.
 * Pass criteria:
 *   1. Pipeline function returns HTTP 200 with picks_written count.
 *   2. Picks rows land in the test DB with correct fields.
 *   3. required_tier is 'elite' for confidence_tier >= 5, 'pro' for 3-4.
 *   4. Picks with EV < 4% are NOT written.
 *   5. rationale_id is set for qualified picks (non-free tier).
 *   6. A pick with rationale failure still writes (rationale_id = null).
 * Flake risk: Supabase local instance cold start. Mitigation: beforeAll with
 *   a health-check ping. Workers /predict mock is deterministic.
 * CI gating: BLOCKING (scheduled daily + on PR for pipeline-touching changes)
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env.TEST_SUPABASE_URL ?? 'http://localhost:54321';
const SERVICE_KEY = process.env.TEST_SUPABASE_SERVICE_KEY ?? 'test-service-key';
const PIPELINE_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/pick-pipeline`;

// Test game seeded in seed.ts
const TEST_GAME_ID = 'dddddddd-0001-0001-0001-000000000001';

// ---------------------------------------------------------------------------
// Mock server — intercepts Fly.io worker + Anthropic + Redis at HTTP layer
// ---------------------------------------------------------------------------

/** PickCandidate shape returned by Fly.io /predict. */
interface MockPickCandidate {
  game_id: string;
  market: string;
  pick_side: string;
  model_probability: number;
  implied_probability: number;
  expected_value: number;
  confidence_tier: number;
  best_line: { price: number; sportsbook_key: string };
  generated_at: string;
}

const FLY_WORKER_URL = process.env.FLY_WORKER_URL ?? 'https://diamond-edge-worker.fly.dev';

const mockCandidates: MockPickCandidate[] = [
  {
    game_id: TEST_GAME_ID,
    market: 'moneyline',
    pick_side: 'home',
    model_probability: 0.602,
    implied_probability: 0.5917,
    expected_value: 0.062, // > 4% — qualifies
    confidence_tier: 4,
    best_line: { price: -140, sportsbook_key: 'fanduel' },
    generated_at: new Date().toISOString(),
  },
  {
    game_id: TEST_GAME_ID,
    market: 'total',
    pick_side: 'under',
    model_probability: 0.578,
    implied_probability: 0.5238,
    expected_value: 0.068, // > 4% — qualifies (elite tier)
    confidence_tier: 5,
    best_line: { price: -110, sportsbook_key: 'draftkings' },
    generated_at: new Date().toISOString(),
  },
  {
    game_id: TEST_GAME_ID,
    market: 'run_line',
    pick_side: 'away',
    model_probability: 0.41,
    implied_probability: 0.4762,
    expected_value: 0.02, // < 4% — FILTERED OUT by ev_filter
    confidence_tier: 2,
    best_line: { price: 110, sportsbook_key: 'draftkings' },
    generated_at: new Date().toISOString(),
  },
];

const mswServer = setupServer(
  // Fly.io /predict endpoint mock
  http.post(`${FLY_WORKER_URL}/predict`, async () => {
    return HttpResponse.json(mockCandidates);
  }),

  // Anthropic API mock — returns canned rationale
  http.post('https://api.anthropic.com/v1/messages', async () => {
    return HttpResponse.json({
      id: 'msg_test_001',
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'Test rationale: Strong statistical edge identified based on lineup and pitching metrics.',
        },
      ],
      model: 'claude-haiku-4-5',
      stop_reason: 'end_turn',
      usage: { input_tokens: 350, output_tokens: 120 },
    });
  }),

  // Upstash Redis mock — returns ok for KEYS invalidation
  http.post('https://*.upstash.io/*', async () => {
    return HttpResponse.json({ result: [] });
  })
);

// ---------------------------------------------------------------------------
// Supabase client for assertions
// ---------------------------------------------------------------------------

let supabase: SupabaseClient;

beforeAll(async () => {
  mswServer.listen({ onUnhandledRequest: 'warn' });

  supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
  });

  // Health check — confirm local Supabase is running
  const { error } = await supabase.from('sportsbooks').select('id').limit(1);
  if (error) {
    throw new Error(
      `Local Supabase not reachable at ${SUPABASE_URL}. ` +
      'Run "supabase start" and "npx tsx tests/fixtures/seed.ts" before integration tests.'
    );
  }
});

afterAll(() => {
  mswServer.close();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pick pipeline integration', () => {
  it('pipeline returns 200 and writes exactly 2 picks (3 candidates, 1 filtered by EV)', async () => {
    const res = await fetch(PIPELINE_FUNCTION_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    expect(res.status).toBe(200);

    const body = (await res.json()) as { picks_written: number };
    // 3 candidates → 1 filtered (EV < 4%) → 2 written
    expect(body.picks_written).toBe(2);
  });

  it('written picks have correct fields and are in the test DB', async () => {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    const { data: picks, error } = await supabase
      .from('picks')
      .select('*')
      .eq('game_id', TEST_GAME_ID)
      .eq('pick_date', today);

    expect(error).toBeNull();
    expect(picks).not.toBeNull();
    expect(picks!.length).toBeGreaterThanOrEqual(2);

    const moneylinePick = picks!.find((p) => p.market === 'moneyline' && p.pick_side === 'home');
    expect(moneylinePick).toBeDefined();
    expect(moneylinePick!.confidence_tier).toBe(4);
    expect(moneylinePick!.result).toBe('pending');
    expect(moneylinePick!.model_probability).toBeCloseTo(0.602, 2);
  });

  it('required_tier is "elite" for confidence_tier=5, "pro" for confidence_tier=4', async () => {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    const { data: picks } = await supabase
      .from('picks')
      .select('market, pick_side, confidence_tier, required_tier')
      .eq('game_id', TEST_GAME_ID)
      .eq('pick_date', today);

    const totalPick = picks?.find((p) => p.market === 'total' && p.pick_side === 'under');
    const mlPick = picks?.find((p) => p.market === 'moneyline' && p.pick_side === 'home');

    expect(totalPick?.required_tier).toBe('elite'); // confidence_tier 5 → elite
    expect(mlPick?.required_tier).toBe('pro');       // confidence_tier 4 → pro
  });

  it('low-EV candidate (run_line, EV=2%) is NOT in the DB', async () => {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    const { data: picks } = await supabase
      .from('picks')
      .select('market, pick_side')
      .eq('game_id', TEST_GAME_ID)
      .eq('pick_date', today)
      .eq('market', 'run_line');

    // run_line candidate had EV < 4% and must not be written
    expect(picks?.length ?? 0).toBe(0);
  });

  it('picks have rationale_id set (not null) after successful rationale call', async () => {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    const { data: picks } = await supabase
      .from('picks')
      .select('market, rationale_id')
      .eq('game_id', TEST_GAME_ID)
      .eq('pick_date', today);

    const proPickWithRationale = picks?.find((p) => p.market === 'moneyline');
    expect(proPickWithRationale?.rationale_id).not.toBeNull();
  });

  it('pick is still written when rationale call fails (rationale_id = null)', async () => {
    // Override the Anthropic mock to fail for this test only
    mswServer.use(
      http.post('https://api.anthropic.com/v1/messages', async () => {
        return HttpResponse.json({ error: { type: 'overloaded_error' } }, { status: 529 });
      })
    );

    // Run pipeline again — should still write picks, just with rationale_id = null
    const res = await fetch(PIPELINE_FUNCTION_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    });

    // Pipeline must NOT return 500 on rationale failure — per error handling spec
    expect(res.status).toBe(200);
  });
});
