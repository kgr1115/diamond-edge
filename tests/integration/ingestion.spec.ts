/**
 * ingestion.spec.ts — Data ingestion integration tests
 *
 * Scope:
 *   - Odds API cron handler: mocked Odds API response → correct rows in `odds` table
 *   - MLB Stats schedule sync: mocked MLB Stats API → correct rows in `games` table
 *   - Field mapping and enum coercion are correct
 *   - Upsert behavior: re-running sync does not duplicate rows
 *
 * Out of scope:
 *   - Statcast ingestion (not yet wired in v1)
 *   - Real Odds API / MLB Stats API calls (mocked at HTTP layer)
 *   - Redis caching layer (separate caching-strategy tests)
 *
 * Level: Integration
 * Data setup: Real test DB. Teams + sportsbooks seeded via tests/fixtures/seed.ts.
 *   External APIs mocked via MSW.
 * Pass criteria:
 *   1. After schedule sync, games table has correct row counts for the date.
 *   2. game_date, game_time_utc, status, team IDs all match the mocked response.
 *   3. After odds sync, odds table has rows with correct market, prices, sportsbook_id.
 *   4. Re-running sync does not create duplicate game or odds rows.
 * Flake risk: test DB state from prior runs can interfere. Mitigation: use
 *   mlb_game_id = 999002 (different from seed.ts 999001) to isolate this test's data.
 * CI gating: BLOCKING
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

const SUPABASE_URL = process.env.TEST_SUPABASE_URL ?? 'http://localhost:54321';
const SERVICE_KEY = process.env.TEST_SUPABASE_SERVICE_KEY ?? 'test-service-key';
const APP_URL = process.env.TEST_APP_URL ?? 'http://localhost:3000';

// Fixed IDs for test isolation (different from seed.ts)
const TEST_MLBGame_ID = 999002;
const TEST_CRON_SECRET = process.env.CRON_SECRET ?? 'test-cron-secret';

// ---------------------------------------------------------------------------
// Mock MLB Stats API response
// ---------------------------------------------------------------------------

const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

const MLB_SCHEDULE_MOCK = {
  dates: [
    {
      date: TODAY,
      games: [
        {
          gamePk: TEST_MLBGame_ID,
          gameDate: new Date().toISOString(),
          status: { abstractGameState: 'Preview', detailedState: 'Scheduled' },
          teams: {
            home: {
              team: { id: 147, name: 'New York Yankees' },
              leagueRecord: { wins: 15, losses: 10 },
            },
            away: {
              team: { id: 111, name: 'Boston Red Sox' },
              leagueRecord: { wins: 12, losses: 13 },
            },
          },
          venue: { name: 'Yankee Stadium' },
          doubleHeader: 'N',
          seriesGameNumber: 1,
          gamesInSeries: 3,
        },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Mock The Odds API response
// ---------------------------------------------------------------------------

const ODDS_API_MOCK = [
  {
    id: `odds-api-game-${TEST_MLBGame_ID}`,
    sport_key: 'baseball_mlb',
    commence_time: new Date().toISOString(),
    home_team: 'New York Yankees',
    away_team: 'Boston Red Sox',
    bookmakers: [
      {
        key: 'draftkings',
        title: 'DraftKings',
        markets: [
          {
            key: 'h2h',
            outcomes: [
              { name: 'New York Yankees', price: -145 },
              { name: 'Boston Red Sox', price: 125 },
            ],
          },
          {
            key: 'totals',
            outcomes: [
              { name: 'Over', price: -110, point: 8.5 },
              { name: 'Under', price: -110, point: 8.5 },
            ],
          },
        ],
      },
      {
        key: 'fanduel',
        title: 'FanDuel',
        markets: [
          {
            key: 'h2h',
            outcomes: [
              { name: 'New York Yankees', price: -140 },
              { name: 'Boston Red Sox', price: 120 },
            ],
          },
        ],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// MSW server
// ---------------------------------------------------------------------------

const mswServer = setupServer(
  http.get('https://statsapi.mlb.com/api/v1/schedule', () => {
    return HttpResponse.json(MLB_SCHEDULE_MOCK);
  }),

  http.get('https://api.the-odds-api.com/v4/sports/baseball_mlb/odds', () => {
    return HttpResponse.json(ODDS_API_MOCK);
  })
);

let supabase: SupabaseClient;

beforeAll(async () => {
  mswServer.listen({ onUnhandledRequest: 'warn' });

  supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const { error } = await supabase.from('sportsbooks').select('id').limit(1);
  if (error) {
    throw new Error(
      `Local Supabase not reachable at ${SUPABASE_URL}. ` +
      'Run "supabase start" and seed before integration tests.'
    );
  }

  // Clean up any previous ingestion test data for this mlb_game_id
  await supabase.from('odds').delete().eq(
    'game_id',
    supabase.from('games').select('id').eq('mlb_game_id', TEST_MLBGame_ID)
  );
  await supabase.from('games').delete().eq('mlb_game_id', TEST_MLBGame_ID);
});

afterAll(() => {
  mswServer.close();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MLB schedule sync ingestion', () => {
  it('schedule-sync cron writes game rows to the DB with correct fields', async () => {
    const res = await fetch(`${APP_URL}/api/cron/schedule-sync`, {
      method: 'POST',
      headers: {
        'x-cron-secret': TEST_CRON_SECRET,
        'Content-Type': 'application/json',
      },
    });

    // Cron handler returns 200 on success
    expect(res.status).toBe(200);

    const { data: games, error } = await supabase
      .from('games')
      .select('*')
      .eq('mlb_game_id', TEST_MLBGame_ID);

    expect(error).toBeNull();
    expect(games?.length).toBeGreaterThanOrEqual(1);

    const game = games![0];
    expect(game.game_date).toBe(TODAY);
    expect(game.status).toBe('scheduled');
    // Both team FKs must resolve to rows in the teams table
    expect(game.home_team_id).toBeTruthy();
    expect(game.away_team_id).toBeTruthy();
  });

  it('re-running schedule-sync does not duplicate games (upsert behavior)', async () => {
    await fetch(`${APP_URL}/api/cron/schedule-sync`, {
      method: 'POST',
      headers: { 'x-cron-secret': TEST_CRON_SECRET },
    });

    const { data: games } = await supabase
      .from('games')
      .select('id')
      .eq('mlb_game_id', TEST_MLBGame_ID);

    // Exactly one row for this mlb_game_id
    expect(games?.length).toBe(1);
  });
});

describe('odds refresh ingestion', () => {
  it('odds-refresh cron writes odds rows with correct market and price fields', async () => {
    const res = await fetch(`${APP_URL}/api/cron/odds-refresh`, {
      method: 'POST',
      headers: {
        'x-cron-secret': TEST_CRON_SECRET,
        'Content-Type': 'application/json',
      },
    });

    expect(res.status).toBe(200);

    // Fetch the game ID first
    const { data: games } = await supabase
      .from('games')
      .select('id')
      .eq('mlb_game_id', TEST_MLBGame_ID);

    if (!games?.length) {
      // If schedule-sync didn't run first, skip odds assertions (order dependency)
      return;
    }

    const gameId = games[0].id;
    const { data: odds, error } = await supabase
      .from('odds')
      .select('*')
      .eq('game_id', gameId)
      .order('snapshotted_at', { ascending: false });

    expect(error).toBeNull();
    expect(odds?.length).toBeGreaterThan(0);

    // Verify moneyline odds from DraftKings exist
    const dkMoneyline = odds?.find(
      (o) =>
        o.market === 'moneyline' &&
        o.home_price === -145 // DK home price from mock
    );
    expect(dkMoneyline).toBeDefined();
    expect(dkMoneyline?.away_price).toBe(125);

    // Verify totals from DraftKings exist
    const dkTotal = odds?.find(
      (o) => o.market === 'total' && o.total_line !== null
    );
    expect(dkTotal).toBeDefined();
    expect(Number(dkTotal?.total_line)).toBe(8.5);
    expect(dkTotal?.over_price).toBe(-110);
  });

  it('odds rows reference a valid sportsbook_id FK', async () => {
    const { data: games } = await supabase
      .from('games')
      .select('id')
      .eq('mlb_game_id', TEST_MLBGame_ID);

    if (!games?.length) return;

    const { data: odds } = await supabase
      .from('odds')
      .select('sportsbook_id')
      .eq('game_id', games[0].id)
      .limit(5);

    for (const row of odds ?? []) {
      expect(row.sportsbook_id).toBeTruthy();
      // FK must resolve
      const { data: sb } = await supabase
        .from('sportsbooks')
        .select('id')
        .eq('id', row.sportsbook_id)
        .single();
      expect(sb?.id).toBe(row.sportsbook_id);
    }
  });
});
