/**
 * Diamond Edge — Pick Pipeline Edge Function
 *
 * Supabase Edge Function (Deno TypeScript).
 * Triggered by /api/cron/pick-pipeline via supabase.functions.invoke().
 *
 * Pipeline stages (per docs/runbooks/pick-pipeline-failure.md log event names):
 *   1. game_fetch       — Load today's scheduled games
 *   2. odds_fetch       — Load latest odds for each game
 *   3. worker_call      — POST /predict to Fly.io worker
 *   4. ev_filter        — Drop candidates with EV < 4%
 *   5. rationale_call   — Get or generate rationale for Pro/Elite picks
 *   6. db_write         — Batch insert picks to Supabase
 *   7. cache_invalidate — Invalidate Redis picks:today keys
 *
 * Error handling rules (per TASK-010-pre spec):
 *   - Single game /predict failure: log + skip that game, continue
 *   - Rationale failure: log + write pick with rationale_id = null
 *   - DB write failure: log + return 500 (hard failure)
 *   - Redis invalidation failure: log warning, return 200 (stale cache acceptable)
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { buildFeatureVector } from './feature-builder.ts';
import { callPredict } from './worker-client.ts';
import { getOrGenerateRationale } from './rationale.ts';
import { invalidatePicksCache } from './redis.ts';
import type { GameRow, OddsRow, PickCandidate, PreparedPick } from './types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Today's date in Eastern Time (YYYY-MM-DD). */
function todayInET(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/** Structured log line. All stage logs use this format for runbook alignment. */
function log(event: string, payload: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, timestamp: new Date().toISOString(), ...payload }));
}

/** Map confidence tier to required subscription tier. */
function requiredTierFor(confidenceTier: number): 'pro' | 'elite' {
  return confidenceTier >= 5 ? 'elite' : 'pro';
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (_req: Request): Promise<Response> => {
  const today = todayInET();
  log('pipeline_start', { date: today });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  // ---------------------------------------------------------------------------
  // Stage 1: Fetch today's scheduled games
  // ---------------------------------------------------------------------------
  const { data: gamesData, error: gamesError } = await supabase
    .from('games')
    .select(`
      id, mlb_game_id, game_date, game_time_utc, status,
      home_team_id, away_team_id,
      venue_name, venue_state,
      weather_condition, weather_temp_f, weather_wind_mph, weather_wind_dir,
      probable_home_pitcher_id, probable_away_pitcher_id,
      home_team:home_team_id ( id, name, abbreviation, wins:0, losses:0 ),
      away_team:away_team_id ( id, name, abbreviation, wins:0, losses:0 )
    `)
    .eq('game_date', today)
    .in('status', ['scheduled', 'live']);

  if (gamesError) {
    log('game_fetch', { ok: false, error: gamesError.message });
    return new Response(JSON.stringify({ error: 'game_fetch_failed' }), { status: 500 });
  }

  const games = (gamesData ?? []) as GameRow[];
  log('game_fetch', { ok: true, count: games.length, date: today });

  if (games.length === 0) {
    log('pipeline_complete', { picks_written: 0, reason: 'no_games_today' });
    return new Response(JSON.stringify({ picks_written: 0 }), { status: 200 });
  }

  // ---------------------------------------------------------------------------
  // Stage 2: Fetch latest odds for each game
  // ---------------------------------------------------------------------------
  const gameIds = games.map((g) => g.id);
  const { data: oddsData, error: oddsError } = await supabase
    .from('odds')
    .select(`
      game_id, market, home_price, away_price,
      total_line, over_price, under_price, run_line_spread,
      snapshotted_at,
      sportsbooks ( key )
    `)
    .in('game_id', gameIds)
    .order('snapshotted_at', { ascending: false });

  if (oddsError) {
    log('odds_fetch', { ok: false, error: oddsError.message });
    // Non-fatal: proceed with empty odds (worker will return no candidates)
  }

  const allOdds = (oddsData ?? []) as (OddsRow & { game_id: string })[];
  const oddsByGame: Record<string, OddsRow[]> = {};
  for (const row of allOdds) {
    if (!oddsByGame[row.game_id]) oddsByGame[row.game_id] = [];
    oddsByGame[row.game_id].push(row);
  }

  log('odds_fetch', { ok: !oddsError, game_count: Object.keys(oddsByGame).length });

  // ---------------------------------------------------------------------------
  // Stage 3: Assemble feature vectors + call /predict for each game
  // ---------------------------------------------------------------------------
  const allCandidates: PickCandidate[] = [];

  for (const game of games) {
    const gameOdds = oddsByGame[game.id] ?? [];
    const features = buildFeatureVector(game, gameOdds);

    try {
      const candidates = await callPredict({
        game_id: game.id,
        markets: ['moneyline', 'run_line', 'total'],
        features: features as Record<string, number | string | null>,
      });

      allCandidates.push(...candidates);
      log('worker_call', { ok: true, game_id: game.id, candidates: candidates.length });
    } catch (err) {
      // Single game failure: log and skip — do not abort entire pipeline
      log('worker_call', {
        ok: false,
        game_id: game.id,
        error: err instanceof Error ? err.message : String(err),
        stage: 'predict',
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Stage 4: EV filter
  //
  // TEMP (v3 gate): 8% EV minimum + Tier 5 confidence until vig-removed
  // backtest (run_backtest_v3.py) validates honest ROI and we confirm real
  // alpha. Previous 4% threshold was set before vig removal was applied to
  // the simulator — the v2 ROI numbers (40%+) included phantom edge from
  // book overround. Revert to 4% once v3 report shows ROI 2-5% at 4% EV.
  // ---------------------------------------------------------------------------
  const EV_MIN = 0.08;   // temp: was 0.04
  const TIER_MIN = 5;     // temp: was 3

  const qualified = allCandidates.filter(
    (c) => c.expected_value >= EV_MIN && c.confidence_tier >= TIER_MIN
  );
  log('ev_filter', {
    ok: true,
    total: allCandidates.length,
    qualified: qualified.length,
    dropped: allCandidates.length - qualified.length,
    ev_min: EV_MIN,
    tier_min: TIER_MIN,
  });

  if (qualified.length === 0) {
    log('pipeline_complete', { picks_written: 0, reason: 'no_qualified_picks' });
    return new Response(JSON.stringify({ picks_written: 0 }), { status: 200 });
  }

  // ---------------------------------------------------------------------------
  // Stage 5: Rationale generation for each qualified pick
  // ---------------------------------------------------------------------------

  // Build a game_context lookup (we need team names for the rationale prompt)
  // deno-lint-ignore no-explicit-any
  const gameContextByGameId: Record<string, any> = {};
  for (const game of gamesData ?? []) {
    const g = game as GameRow & {
      // deno-lint-ignore no-explicit-any
      home_team: any;
      // deno-lint-ignore no-explicit-any
      away_team: any;
    };
    gameContextByGameId[g.id] = {
      home_team: {
        name: g.home_team?.name ?? 'Home',
        abbreviation: g.home_team?.abbreviation ?? 'HM',
        record: '0-0',
      },
      away_team: {
        name: g.away_team?.name ?? 'Away',
        abbreviation: g.away_team?.abbreviation ?? 'AW',
        record: '0-0',
      },
      game_time_local: g.game_time_utc
        ? new Date(g.game_time_utc).toLocaleString('en-US', {
            hour: 'numeric',
            minute: '2-digit',
            timeZone: 'America/New_York',
            timeZoneName: 'short',
          })
        : 'TBD',
      venue: g.venue_name ?? 'Unknown Venue',
      probable_home_pitcher: null,
      probable_away_pitcher: null,
      weather: g.weather_condition
        ? {
            condition: g.weather_condition,
            temp_f: g.weather_temp_f ?? 72,
            wind_mph: g.weather_wind_mph ?? 0,
            wind_dir: g.weather_wind_dir ?? 'N',
          }
        : null,
    };
  }

  const preparedPicks: PreparedPick[] = [];

  for (const candidate of qualified) {
    const requiredTier = requiredTierFor(candidate.confidence_tier);
    let rationaleResult = { rationale_cache_id: null as string | null, cache_hit: false };

    try {
      const gameContext = gameContextByGameId[candidate.game_id];
      if (gameContext) {
        rationaleResult = await getOrGenerateRationale(
          candidate,
          gameContext,
          requiredTier,
          supabase
        );
      }
      log('rationale_call', {
        ok: true,
        game_id: candidate.game_id,
        tier: requiredTier,
        cache_hit: rationaleResult.cache_hit,
      });
    } catch (err) {
      // Rationale failure: write pick with rationale_id = null, do not drop the pick
      log('rationale_call', {
        ok: false,
        game_id: candidate.game_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    preparedPicks.push({
      candidate,
      required_tier: requiredTier,
      rationale_cache_id: rationaleResult.rationale_cache_id,
    });
  }

  // ---------------------------------------------------------------------------
  // Stage 6: Batch insert picks to DB
  // ---------------------------------------------------------------------------

  // Resolve sportsbook ID from key (needed for best_line_book_id FK)
  const { data: sbData } = await supabase.from('sportsbooks').select('id, key');
  const sbByKey: Record<string, string> = {};
  for (const sb of sbData ?? []) {
    sbByKey[sb.key] = sb.id;
  }

  const insertRows = preparedPicks.map(({ candidate, required_tier, rationale_cache_id }) => ({
    game_id: candidate.game_id,
    pick_date: today,
    market: candidate.market,
    pick_side: candidate.pick_side,
    model_probability: candidate.model_probability,
    implied_probability: candidate.implied_probability,
    expected_value: candidate.expected_value,
    confidence_tier: candidate.confidence_tier,
    best_line_price: candidate.best_line.price,
    best_line_book_id: sbByKey[candidate.best_line.sportsbook_key] ?? null,
    rationale_id: rationale_cache_id,
    required_tier,
    result: 'pending',
    generated_at: candidate.generated_at,
  }));

  const { error: insertError } = await supabase.from('picks').insert(insertRows);

  if (insertError) {
    log('db_write', { ok: false, error: insertError.message, count: insertRows.length });
    return new Response(JSON.stringify({ error: 'db_write_failed' }), { status: 500 });
  }

  log('db_write', { ok: true, count: insertRows.length, date: today });

  // ---------------------------------------------------------------------------
  // Stage 7: Invalidate Redis cache
  // ---------------------------------------------------------------------------
  try {
    await invalidatePicksCache(today);
    log('cache_invalidate', { ok: true, date: today });
  } catch (err) {
    // Non-fatal: stale cache is acceptable for up to the TTL
    log('cache_invalidate', {
      ok: false,
      date: today,
      error: err instanceof Error ? err.message : String(err),
      warning: 'picks cache may be stale until TTL expires',
    });
  }

  log('pipeline_complete', { picks_written: preparedPicks.length, date: today });
  return new Response(
    JSON.stringify({ picks_written: preparedPicks.length }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
});
