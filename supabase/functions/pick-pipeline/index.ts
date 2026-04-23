/**
 * Diamond Edge — Pick Pipeline Edge Function
 *
 * Supabase Edge Function (Deno TypeScript).
 * Triggered by /api/cron/pick-pipeline via supabase.functions.invoke().
 *
 * Pipeline stages (per docs/runbooks/pick-pipeline-failure.md log event names):
 *   1. game_fetch       — Load today's scheduled games
 *   2. odds_fetch       — Load latest odds for each game
 *   3. news_fetch       — Load recent news_signals per game (T-6h window)
 *   4. worker_call      — POST /predict to Fly.io worker
 *   5. ev_filter        — Two-gate shadow/live visibility assignment
 *   6. rationale_call   — Get or generate rationale for Pro/Elite picks
 *   7. db_write         — Batch insert picks to Supabase
 *   8. cache_invalidate — Invalidate Redis picks:today keys
 *
 * Two-gate visibility (ADR-002 Phase 5):
 *   SHADOW: EV >= 0.04 AND confidence_tier >= 3
 *     → stored to DB for CLV/feedback-loop accumulation, NOT user-visible
 *   LIVE:   EV >= 0.08 AND confidence_tier >= 5
 *     → user-visible; RLS policy picks_select_live_* enforces this
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
// Thresholds (ADR-002 Phase 5)
// ---------------------------------------------------------------------------

/** Minimum to store at all — shadow picks for CLV data accumulation. */
const SHADOW_EV_MIN = 0.04;
const SHADOW_TIER_MIN = 3;

/** Minimum for user-visible live picks. */
const LIVE_EV_MIN = 0.08;
const LIVE_TIER_MIN = 5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayInET(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function log(event: string, payload: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, timestamp: new Date().toISOString(), ...payload }));
}

function requiredTierFor(confidenceTier: number): 'pro' | 'elite' {
  return confidenceTier >= 5 ? 'elite' : 'pro';
}

function assignVisibility(ev: number, tier: number): 'shadow' | 'live' {
  if (ev >= LIVE_EV_MIN && tier >= LIVE_TIER_MIN) return 'live';
  return 'shadow';
}

// ---------------------------------------------------------------------------
// news_signals row (minimal shape needed for feature aggregation)
// ---------------------------------------------------------------------------

interface NewsSignalRow {
  signal_type: string;
  confidence: number;
  payload: {
    war_proxy?: number | null;
    severity?: string | null;
    [key: string]: unknown;
  } | null;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (_req: Request): Promise<Response> => {
  try {
    return await runPipeline();
  } catch (err) {
    // Top-level catch: should never fire (all stages have inner guards), but
    // ensures Deno.serve always returns a structured response instead of crashing.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ event: 'pipeline_unhandled_error', error: msg }));
    return new Response(JSON.stringify({ error: 'pipeline_unhandled_error', message: msg }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});

async function runPipeline(): Promise<Response> {
  const today = todayInET();
  log('pipeline_start', { date: today });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  // ---------------------------------------------------------------------------
  // Stage 1: Fetch today's scheduled games
  // ---------------------------------------------------------------------------
  const gameFetchStart = Date.now();
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
    log('game_fetch', { ok: false, error: gamesError.message, ms: Date.now() - gameFetchStart });
    return new Response(JSON.stringify({ error: 'game_fetch_failed' }), { status: 500 });
  }

  const games = (gamesData ?? []) as GameRow[];
  log('game_fetch', { ok: true, count: games.length, date: today, ms: Date.now() - gameFetchStart });

  if (games.length === 0) {
    log('pipeline_complete', { picks_written: 0, reason: 'no_games_today' });
    return new Response(JSON.stringify({ picks_written: 0 }), { status: 200 });
  }

  // ---------------------------------------------------------------------------
  // Stage 2: Fetch latest odds for each game
  // ---------------------------------------------------------------------------
  const gameIds = games.map((g) => g.id);
  const oddsFetchStart = Date.now();
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
    log('odds_fetch', { ok: false, error: oddsError.message, ms: Date.now() - oddsFetchStart });
    // Non-fatal: proceed with empty odds (worker will return no candidates)
  }

  const allOdds = (oddsData ?? []) as (OddsRow & { game_id: string })[];
  const oddsByGame: Record<string, OddsRow[]> = {};
  for (const row of allOdds) {
    if (!oddsByGame[row.game_id]) oddsByGame[row.game_id] = [];
    oddsByGame[row.game_id].push(row);
  }

  const gamesWithOdds = Object.keys(oddsByGame).length;
  const gamesWithoutOdds = games.filter((g) => !oddsByGame[g.id]?.length).map((g) => g.id);
  if (gamesWithoutOdds.length > 0) {
    log('odds_fetch_missing', {
      ok: true,
      games_without_odds: gamesWithoutOdds.length,
      game_ids: gamesWithoutOdds,
      note: 'odds-refresh cron may not have run yet for these games; EV computation will fail at ev_filter',
    });
  }

  log('odds_fetch', { ok: !oddsError, game_count: gamesWithOdds, games_without_odds: gamesWithoutOdds.length, ms: Date.now() - oddsFetchStart });

  // ---------------------------------------------------------------------------
  // Stage 3: Fetch recent news_signals per game (T-6h window)
  // Non-fatal — if news pipeline hasn't run, features default to 0.
  // ---------------------------------------------------------------------------
  const newsFetchStart = Date.now();
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const { data: signalsData, error: signalsError } = await supabase
    .from('news_signals')
    .select('game_id, signal_type, confidence, payload')
    .in('game_id', gameIds)
    .gte('created_at', sixHoursAgo);

  if (signalsError) {
    log('news_fetch', { ok: false, error: signalsError.message, note: 'news features will default to 0', ms: Date.now() - newsFetchStart });
  }

  const signalsByGame: Record<string, NewsSignalRow[]> = {};
  for (const row of (signalsData ?? []) as (NewsSignalRow & { game_id: string })[]) {
    if (!signalsByGame[row.game_id]) signalsByGame[row.game_id] = [];
    signalsByGame[row.game_id].push(row);
  }

  const signalGameCount = Object.keys(signalsByGame).length;
  log('news_fetch', {
    ok: !signalsError,
    games_with_signals: signalGameCount,
    total_signals: (signalsData ?? []).length,
    ms: Date.now() - newsFetchStart,
  });

  // ---------------------------------------------------------------------------
  // Stage 4: Assemble feature vectors + call /predict for each game
  // ---------------------------------------------------------------------------
  const allCandidates: PickCandidate[] = [];

  for (const game of games) {
    const gameOdds = oddsByGame[game.id] ?? [];
    const gameSignals = signalsByGame[game.id] ?? [];
    const features = buildFeatureVector(game, gameOdds, gameSignals);
    const workerCallStart = Date.now();

    // Log when a game has no odds — this is a diagnostic signal for why
    // the worker returns 0 candidates (it can't compute EV without prices).
    if (gameOdds.length === 0) {
      log('worker_call_no_odds', {
        ok: false,
        game_id: game.id,
        note: 'skipping /predict — no odds rows for this game; ev_filter will see 0 candidates',
      });
      continue;
    }

    try {
      const candidates = await callPredict({
        game_id: game.id,
        markets: ['moneyline', 'run_line', 'total'],
        features: features as Record<string, number | string | null>,
      });

      allCandidates.push(...candidates);
      log('worker_call', {
        ok: true,
        game_id: game.id,
        candidates: candidates.length,
        news_signal_count: gameSignals.length,
        ms: Date.now() - workerCallStart,
      });
    } catch (err) {
      log('worker_call', {
        ok: false,
        game_id: game.id,
        error: err instanceof Error ? err.message : String(err),
        stage: 'predict',
        ms: Date.now() - workerCallStart,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Stage 5: Two-gate EV/tier filter → shadow or live visibility
  //
  // SHADOW: EV >= 4% AND tier >= 3 → stored for CLV accumulation, not shown to users
  // LIVE:   EV >= 8% AND tier >= 5 → user-visible; meets the previously temp gate
  //
  // The TEMP comment from the prior implementation is now formalized:
  // 8%/tier-5 is the live gate; 4%/tier-3 is the shadow gate.
  // Shadow picks are model feedback data — they cost nothing extra to store.
  //
  // Guard: candidates with missing/non-numeric expected_value or confidence_tier
  // (e.g., from malformed worker response when odds rows were absent) are logged
  // explicitly rather than silently dropped by the numeric comparison.
  // ---------------------------------------------------------------------------
  const malformedCandidates = allCandidates.filter(
    (c) => typeof c.expected_value !== 'number' || typeof c.confidence_tier !== 'number'
  );
  if (malformedCandidates.length > 0) {
    log('ev_filter_malformed', {
      ok: false,
      count: malformedCandidates.length,
      game_ids: malformedCandidates.map((c) => c.game_id),
      note: 'candidates missing expected_value or confidence_tier — likely missing odds rows for these games',
    });
  }

  const validCandidates = allCandidates.filter(
    (c) => typeof c.expected_value === 'number' && typeof c.confidence_tier === 'number'
  );

  const shadowCandidates = validCandidates.filter(
    (c) => c.expected_value >= SHADOW_EV_MIN && c.confidence_tier >= SHADOW_TIER_MIN
  );

  const liveCandidates = new Set(
    shadowCandidates
      .filter((c) => c.expected_value >= LIVE_EV_MIN && c.confidence_tier >= LIVE_TIER_MIN)
      .map((c) => `${c.game_id}:${c.market}:${c.pick_side}`)
  );

  log('ev_filter', {
    ok: true,
    total: allCandidates.length,
    valid: validCandidates.length,
    malformed: malformedCandidates.length,
    shadow: shadowCandidates.length,
    live: liveCandidates.size,
    dropped_below_shadow_gate: validCandidates.length - shadowCandidates.length,
    shadow_ev_min: SHADOW_EV_MIN,
    shadow_tier_min: SHADOW_TIER_MIN,
    live_ev_min: LIVE_EV_MIN,
    live_tier_min: LIVE_TIER_MIN,
  });

  if (shadowCandidates.length === 0) {
    log('pipeline_complete', { picks_written: 0, reason: 'no_qualified_picks' });
    return new Response(JSON.stringify({ picks_written: 0 }), { status: 200 });
  }

  // ---------------------------------------------------------------------------
  // Stage 6: Rationale generation for LIVE picks only
  // Shadow picks skip rationale to save LLM cost.
  // ---------------------------------------------------------------------------

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

  interface PreparedPickWithVisibility extends PreparedPick {
    visibility: 'shadow' | 'live';
  }

  const preparedPicks: PreparedPickWithVisibility[] = [];

  for (const candidate of shadowCandidates) {
    const candidateKey = `${candidate.game_id}:${candidate.market}:${candidate.pick_side}`;
    const visibility = liveCandidates.has(candidateKey) ? 'live' : 'shadow';
    const requiredTier = requiredTierFor(candidate.confidence_tier);
    let rationaleResult = { rationale_cache_id: null as string | null, cache_hit: false };

    // Only call LLM for live picks — shadow picks accumulate for free.
    if (visibility === 'live') {
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
        log('rationale_call', {
          ok: false,
          game_id: candidate.game_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    preparedPicks.push({
      candidate,
      required_tier: requiredTier,
      rationale_cache_id: rationaleResult.rationale_cache_id,
      visibility,
    });
  }

  // ---------------------------------------------------------------------------
  // Stage 7: Batch insert picks to DB
  // ---------------------------------------------------------------------------
  const sbFetchStart = Date.now();
  const { data: sbData, error: sbError } = await supabase.from('sportsbooks').select('id, key');
  if (sbError) {
    log('db_write_sportsbooks_fetch', { ok: false, error: sbError.message, ms: Date.now() - sbFetchStart });
    // Non-fatal: best_line_book_id will be null for all picks — acceptable degradation.
  } else {
    log('db_write_sportsbooks_fetch', { ok: true, count: sbData?.length ?? 0, ms: Date.now() - sbFetchStart });
  }
  const sbByKey: Record<string, string> = {};
  for (const sb of sbData ?? []) {
    sbByKey[sb.key] = sb.id;
  }

  const dbWriteStart = Date.now();
  const insertRows = preparedPicks.map(({ candidate, required_tier, rationale_cache_id, visibility }) => ({
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
    visibility,
    // ADR-002 columns — null until v5 delta model is live (v2 artifacts don't produce these)
    market_novig_prior: null,
    model_delta: null,
    news_signals_applied: false,
  }));

  const { error: insertError } = await supabase.from('picks').insert(insertRows);

  if (insertError) {
    log('db_write', { ok: false, error: insertError.message, count: insertRows.length, ms: Date.now() - dbWriteStart });
    return new Response(JSON.stringify({ error: 'db_write_failed' }), { status: 500 });
  }

  const liveCount = preparedPicks.filter((p) => p.visibility === 'live').length;
  const shadowCount = preparedPicks.filter((p) => p.visibility === 'shadow').length;
  log('db_write', { ok: true, count: insertRows.length, live: liveCount, shadow: shadowCount, date: today, ms: Date.now() - dbWriteStart });

  // ---------------------------------------------------------------------------
  // Stage 8: Invalidate Redis cache (only needed when live picks were written)
  // ---------------------------------------------------------------------------
  if (liveCount > 0) {
    try {
      await invalidatePicksCache(today);
      log('cache_invalidate', { ok: true, date: today });
    } catch (err) {
      log('cache_invalidate', {
        ok: false,
        date: today,
        error: err instanceof Error ? err.message : String(err),
        warning: 'picks cache may be stale until TTL expires',
      });
    }
  } else {
    log('cache_invalidate', { ok: true, skipped: true, reason: 'no live picks written' });
  }

  log('pipeline_complete', {
    picks_written: preparedPicks.length,
    live: liveCount,
    shadow: shadowCount,
    date: today,
  });

  return new Response(
    JSON.stringify({ picks_written: preparedPicks.length, live: liveCount, shadow: shadowCount }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}
