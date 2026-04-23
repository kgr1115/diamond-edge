/**
 * Test DB seed script.
 *
 * Run against a local Supabase instance (`supabase start`) before E2E or integration tests.
 * Usage: npx tsx tests/fixtures/seed.ts
 *
 * What this seeds:
 *   - 3 test users (free / pro / elite) in auth.users + profiles
 *   - 2 sportsbooks (DraftKings, FanDuel)
 *   - 2 MLB teams (NYY home, BOS away)
 *   - 1 test pitcher per team
 *   - 1 scheduled game (today in ET)
 *   - 2 odds snapshots (DK moneyline + total)
 *   - 2 rationale_cache rows (one for pro pick, one for elite pick)
 *   - 2 picks (one pro-tier, one elite-tier) linked to the game + rationale
 *
 * Idempotent: uses upsert / on-conflict-ignore patterns throughout.
 * Does NOT seed production data — connects only to the local test instance.
 *
 * Flake risk: none — deterministic inserts with fixed UUIDs.
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.TEST_SUPABASE_URL ?? 'http://localhost:54321';
const SERVICE_KEY = process.env.TEST_SUPABASE_SERVICE_KEY ?? 'test-service-key';

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

// Fixed UUIDs so tests can reference them predictably
const IDS = {
  sportsbook_dk: 'aaaaaaaa-0001-0001-0001-000000000001',
  sportsbook_fd: 'aaaaaaaa-0001-0001-0001-000000000002',
  team_nyy: 'bbbbbbbb-0001-0001-0001-000000000001',
  team_bos: 'bbbbbbbb-0001-0001-0001-000000000002',
  pitcher_nyy: 'cccccccc-0001-0001-0001-000000000001',
  pitcher_bos: 'cccccccc-0001-0001-0001-000000000002',
  game: 'dddddddd-0001-0001-0001-000000000001',
  rationale_pro: 'eeeeeeee-0001-0001-0001-000000000001',
  rationale_elite: 'eeeeeeee-0001-0001-0001-000000000002',
  pick_pro: 'ffffffff-0001-0001-0001-000000000001',
  pick_elite: 'ffffffff-0001-0001-0001-000000000002',
};

// Today's date in ET (YYYY-MM-DD)
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

async function seedSportsbooks(): Promise<void> {
  const { error } = await supabase.from('sportsbooks').upsert(
    [
      { id: IDS.sportsbook_dk, key: 'draftkings', name: 'DraftKings', active: true },
      { id: IDS.sportsbook_fd, key: 'fanduel', name: 'FanDuel', active: true },
    ],
    { onConflict: 'id' }
  );
  if (error) throw new Error(`sportsbooks seed: ${error.message}`);
  console.log('sportsbooks seeded');
}

async function seedTeams(): Promise<void> {
  const { error } = await supabase.from('teams').upsert(
    [
      {
        id: IDS.team_nyy,
        mlb_team_id: 147,
        name: 'New York Yankees',
        abbreviation: 'NYY',
        city: 'New York',
        division: 'AL East',
        league: 'AL',
        venue_name: 'Yankee Stadium',
        venue_city: 'New York',
        venue_state: 'NY',
      },
      {
        id: IDS.team_bos,
        mlb_team_id: 111,
        name: 'Boston Red Sox',
        abbreviation: 'BOS',
        city: 'Boston',
        division: 'AL East',
        league: 'AL',
        venue_name: 'Fenway Park',
        venue_city: 'Boston',
        venue_state: 'MA',
      },
    ],
    { onConflict: 'id' }
  );
  if (error) throw new Error(`teams seed: ${error.message}`);
  console.log('teams seeded');
}

async function seedPlayers(): Promise<void> {
  const { error } = await supabase.from('players').upsert(
    [
      {
        id: IDS.pitcher_nyy,
        mlb_player_id: 99001,
        full_name: 'Test Pitcher NYY',
        position: 'SP',
        throws: 'R',
        bats: 'R',
        team_id: IDS.team_nyy,
        active: true,
      },
      {
        id: IDS.pitcher_bos,
        mlb_player_id: 99002,
        full_name: 'Test Pitcher BOS',
        position: 'SP',
        throws: 'L',
        bats: 'L',
        team_id: IDS.team_bos,
        active: true,
      },
    ],
    { onConflict: 'id' }
  );
  if (error) throw new Error(`players seed: ${error.message}`);
  console.log('players seeded');
}

async function seedGame(): Promise<void> {
  const gameTimeUtc = new Date();
  gameTimeUtc.setHours(23, 10, 0, 0); // 7:10 PM ET

  const { error } = await supabase.from('games').upsert(
    {
      id: IDS.game,
      mlb_game_id: 999001,
      game_date: today,
      game_time_utc: gameTimeUtc.toISOString(),
      status: 'scheduled',
      home_team_id: IDS.team_nyy,
      away_team_id: IDS.team_bos,
      venue_name: 'Yankee Stadium',
      venue_state: 'NY',
      weather_condition: 'clear',
      weather_temp_f: 72,
      weather_wind_mph: 8,
      weather_wind_dir: 'SW',
      probable_home_pitcher_id: IDS.pitcher_nyy,
      probable_away_pitcher_id: IDS.pitcher_bos,
    },
    { onConflict: 'id' }
  );
  if (error) throw new Error(`game seed: ${error.message}`);
  console.log('game seeded');
}

async function seedOdds(): Promise<void> {
  const { error } = await supabase.from('odds').upsert(
    [
      {
        game_id: IDS.game,
        sportsbook_id: IDS.sportsbook_dk,
        market: 'moneyline',
        home_price: -145,
        away_price: 125,
        snapshotted_at: new Date().toISOString(),
      },
      {
        game_id: IDS.game,
        sportsbook_id: IDS.sportsbook_fd,
        market: 'moneyline',
        home_price: -140,
        away_price: 120,
        snapshotted_at: new Date().toISOString(),
      },
      {
        game_id: IDS.game,
        sportsbook_id: IDS.sportsbook_dk,
        market: 'total',
        total_line: 8.5,
        over_price: -110,
        under_price: -110,
        snapshotted_at: new Date().toISOString(),
      },
    ],
    { onConflict: 'id' }
  );
  if (error) throw new Error(`odds seed: ${error.message}`);
  console.log('odds seeded');
}

async function seedRationaleCache(): Promise<void> {
  const { error } = await supabase.from('rationale_cache').upsert(
    [
      {
        id: IDS.rationale_pro,
        model_used: 'claude-haiku-4-5',
        prompt_hash: 'pro-pick-prompt-hash-test-001',
        rationale_text:
          'The Yankees hold a significant home-field advantage with a strong rotation matchup. ' +
          'Model probability sits at 60.2%, implying +EV at current DK line of -145. ' +
          'Bullpen rest metrics favor NYY entering this series.',
        tokens_used: 280,
        cost_usd: 0.000084,
        generated_at: new Date().toISOString(),
      },
      {
        id: IDS.rationale_elite,
        model_used: 'claude-sonnet-4-6',
        prompt_hash: 'elite-pick-prompt-hash-test-001',
        rationale_text:
          'Elite-tier rationale: Deep statistical analysis indicates a strong edge. ' +
          'wRC+ differential of +22 favors NYY offense vs BOS starter. ' +
          'Park factor adjustment reduces total expectation — under 8.5 carries +6.8% EV.',
        tokens_used: 540,
        cost_usd: 0.00432,
        generated_at: new Date().toISOString(),
      },
    ],
    { onConflict: 'id' }
  );
  if (error) throw new Error(`rationale_cache seed: ${error.message}`);
  console.log('rationale_cache seeded');
}

async function seedPicks(): Promise<void> {
  const { error } = await supabase.from('picks').upsert(
    [
      {
        id: IDS.pick_pro,
        game_id: IDS.game,
        pick_date: today,
        market: 'moneyline',
        pick_side: 'home',
        model_probability: 0.602,
        implied_probability: 0.5918,
        expected_value: 0.0612,
        confidence_tier: 4,
        best_line_price: -140,
        best_line_book_id: IDS.sportsbook_fd,
        rationale_id: IDS.rationale_pro,
        required_tier: 'pro',
        result: 'pending',
        generated_at: new Date().toISOString(),
      },
      {
        id: IDS.pick_elite,
        game_id: IDS.game,
        pick_date: today,
        market: 'total',
        pick_side: 'under',
        model_probability: 0.578,
        implied_probability: 0.5238,
        expected_value: 0.068,
        confidence_tier: 5,
        best_line_price: -110,
        best_line_book_id: IDS.sportsbook_dk,
        rationale_id: IDS.rationale_elite,
        required_tier: 'elite',
        result: 'pending',
        generated_at: new Date().toISOString(),
      },
    ],
    { onConflict: 'id' }
  );
  if (error) throw new Error(`picks seed: ${error.message}`);
  console.log('picks seeded');
}

/**
 * Seed test users into auth.users + profiles via Supabase Admin API.
 * Requires service role key (not anon key).
 */
async function seedTestUsers(): Promise<void> {
  const users = [
    { email: 'test-free@diamondedge.test', tier: 'free' },
    { email: 'test-pro@diamondedge.test', tier: 'pro' },
    { email: 'test-elite@diamondedge.test', tier: 'elite' },
  ] as const;

  for (const u of users) {
    // createUser via Admin API — idempotent via email check
    const { data, error } = await supabase.auth.admin.createUser({
      email: u.email,
      password: 'TestPassword123!',
      email_confirm: true,
    });

    if (error && !error.message.includes('already registered')) {
      throw new Error(`auth user seed (${u.email}): ${error.message}`);
    }

    if (data?.user) {
      // Upsert profile with correct tier + age_verified = true to bypass age gate in tests
      const { error: profileError } = await supabase.from('profiles').upsert(
        {
          id: data.user.id,
          email: u.email,
          subscription_tier: u.tier,
          age_verified: true,
          age_verified_at: new Date().toISOString(),
          date_of_birth: '1990-01-01',
          geo_state: 'NY',
          geo_blocked: false,
        },
        { onConflict: 'id' }
      );
      if (profileError) throw new Error(`profile seed (${u.email}): ${profileError.message}`);
    }
  }
  console.log('test users seeded');
}

async function main(): Promise<void> {
  console.log(`Seeding test DB at ${SUPABASE_URL} ...`);
  await seedSportsbooks();
  await seedTeams();
  await seedPlayers();
  await seedGame();
  await seedOdds();
  await seedRationaleCache();
  await seedPicks();
  await seedTestUsers();
  console.log('Seed complete.');
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
