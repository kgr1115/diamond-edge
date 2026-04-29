/**
 * Diamond Edge — Pick Pipeline Edge Function
 *
 * Supabase Edge Function (Deno TypeScript).
 * Triggered by /api/cron/pick-pipeline via supabase.functions.invoke().
 *
 * Pipeline stages (per docs/runbooks/pick-pipeline-failure.md log event names):
 *   1. game_fetch       — Load scheduled games for a date
 *   2. odds_fetch       — Load latest odds for each game
 *   3. news_fetch       — Load recent news_signals per game (T-6h window)
 *   4. worker_call      — POST /predict to Fly.io worker
 *   5. ev_filter        — Two-gate shadow/live visibility assignment
 *   6. rationale_call   — Get or generate rationale for Pro/Elite picks
 *   7. db_write         — Batch insert picks to Supabase
 *   8. cache_invalidate — Invalidate Redis picks:today keys
 *
 * Multi-date lookahead (added 2026-04-28):
 *   The pipeline runs for today + LOOKAHEAD_DAYS forward dates. Each date is
 *   processed independently — a failure on one date does not abort the others.
 *   Dates with zero scheduled games are skipped without LLM/worker spend.
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
 *   - DB write failure: log + record per-date error, continue with next date
 *   - Redis invalidation failure: log warning, continue
 */

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { callPredict } from './worker-client.ts';
import { getOrGenerateRationale } from './rationale.ts';
import { invalidatePicksCache } from './redis.ts';
import type { GameRow, OddsRow, PickCandidate, PreparedPick } from './types.ts';

// ---------------------------------------------------------------------------
// Thresholds (ADR-002 Phase 5)
// ---------------------------------------------------------------------------

const SHADOW_EV_MIN = 0.04;
const SHADOW_TIER_MIN = 3;
const LIVE_EV_MIN = 0.08;
const LIVE_TIER_MIN = 5;

/**
 * Per-market visibility blocklist — picks in these markets are gated to
 * `visibility = 'shadow'` regardless of EV/tier. See
 * docs/ml/tier-calibration.md (Layer 2) and
 * docs/improvement-pipeline/pick-scope-gate-2026-04-28.md Proposal 3.
 *
 * AUTO-REVERT TRIGGER: remove a market from this set when the next monthly
 * retrain produces a candidate where the market's 60-day backtest log-loss
 * improves by ≥10% AND the market's shadow-run win rate hits 50% on N≥30.
 *
 * 2026-04-28: moneyline added — predicted 50–55% prob band actuals 16.7%
 * on N=12 (33pp gap, far outside variance bounds; the model is broken on ML).
 */
const LIVE_MARKET_BLOCKLIST: ReadonlySet<string> = new Set(['moneyline']);

/** Number of days past today to also pipeline. 0 = today only, 7 = today+7. */
const LOOKAHEAD_DAYS = 7;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayInET(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/**
 * Returns [today, today+1, …, today+LOOKAHEAD_DAYS] as YYYY-MM-DD strings in ET.
 * Computed via UTC arithmetic + Intl formatting to dodge DST edge cases.
 */
function dateRangeFromToday(lookahead: number): string[] {
  const out: string[] = [];
  const base = new Date();
  for (let i = 0; i <= lookahead; i++) {
    const d = new Date(base.getTime() + i * 86_400_000);
    out.push(d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }));
  }
  return out;
}

function log(event: string, payload: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, timestamp: new Date().toISOString(), ...payload }));
}

function requiredTierFor(confidenceTier: number): 'pro' | 'elite' {
  return confidenceTier >= 5 ? 'elite' : 'pro';
}

interface NewsSignalRow {
  signal_type: string;
  confidence: number;
  payload: {
    war_proxy?: number | null;
    severity?: string | null;
    [key: string]: unknown;
  } | null;
}

interface DateResult {
  date: string;
  games_analyzed: number;
  picks_written: number;
  live: number;
  shadow: number;
  skipped?: boolean;
  reason?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Top-level handler
// ---------------------------------------------------------------------------

Deno.serve(async (_req: Request): Promise<Response> => {
  try {
    return await runPipeline();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ event: 'pipeline_unhandled_error', error: msg }));
    return new Response(JSON.stringify({ error: 'pipeline_unhandled_error', message: msg }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});

async function runPipeline(): Promise<Response> {
  const dates = dateRangeFromToday(LOOKAHEAD_DAYS);
  log('pipeline_start_multi', { dates, lookahead_days: LOOKAHEAD_DAYS });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  const byDate: DateResult[] = [];
  let totalWritten = 0;
  let totalLive = 0;
  let totalShadow = 0;

  for (const date of dates) {
    try {
      const r = await runPipelineForDate(date, supabase);
      byDate.push(r);
      totalWritten += r.picks_written;
      totalLive += r.live;
      totalShadow += r.shadow;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('pipeline_date_error', { date, error: msg });
      byDate.push({ date, games_analyzed: 0, picks_written: 0, live: 0, shadow: 0, error: msg });
    }
  }

  log('pipeline_complete_multi', {
    dates_processed: byDate.length,
    total_picks_written: totalWritten,
    total_live: totalLive,
    total_shadow: totalShadow,
  });

  return new Response(
    JSON.stringify({
      picks_written: totalWritten,
      live: totalLive,
      shadow: totalShadow,
      by_date: byDate,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

// ---------------------------------------------------------------------------
// Single-date pipeline (the original logic, parameterized by `date`)
// ---------------------------------------------------------------------------

async function runPipelineForDate(date: string, supabase: SupabaseClient): Promise<DateResult> {
  log('pipeline_start', { date });

  // Retry guard: if any pick was inserted for this pick_date within the last
  // RETRY_GUARD_MIN minutes, treat this as a duplicate cron / manual trigger
  // and skip. Preserves DIFFERENT-day lead-time observations (which are the
  // signal we want for /history lead-time grading) while killing same-run
  // retries (which are pure noise).
  const RETRY_GUARD_MIN = 10;
  const cutoffISO = new Date(Date.now() - RETRY_GUARD_MIN * 60_000).toISOString();
  const { count: recentCount, error: recentErr } = await supabase
    .from('picks')
    .select('id', { count: 'exact', head: true })
    .eq('pick_date', date)
    .gte('generated_at', cutoffISO);

  if (recentErr) {
    log('retry_guard_query_failed', { date, error: recentErr.message });
  } else if ((recentCount ?? 0) > 0) {
    log('pipeline_skip', {
      date,
      reason: 'retry_guard',
      recent_count: recentCount,
      window_min: RETRY_GUARD_MIN,
    });
    return {
      date,
      games_analyzed: 0,
      picks_written: 0,
      live: 0,
      shadow: 0,
      skipped: true,
      reason: `retry_guard:${recentCount}_picks_in_last_${RETRY_GUARD_MIN}min`,
    };
  }

  // Stage 1
  const gameFetchStart = Date.now();
  const { data: gamesData, error: gamesError } = await supabase
    .from('games')
    .select(`
      id, mlb_game_id, game_date, game_time_utc, status,
      home_team_id, away_team_id,
      venue_name, venue_state,
      weather_condition, weather_temp_f, weather_wind_mph, weather_wind_dir,
      probable_home_pitcher_id, probable_away_pitcher_id,
      home_team:home_team_id ( id, name, abbreviation ),
      away_team:away_team_id ( id, name, abbreviation )
    `)
    .eq('game_date', date)
    .in('status', ['scheduled', 'live']);

  if (gamesError) {
    log('game_fetch', { ok: false, date, error: gamesError.message, ms: Date.now() - gameFetchStart });
    return { date, games_analyzed: 0, picks_written: 0, live: 0, shadow: 0, error: gamesError.message };
  }

  const games = (gamesData ?? []) as GameRow[];
  log('game_fetch', { ok: true, date, count: games.length, ms: Date.now() - gameFetchStart });

  if (games.length === 0) {
    log('pipeline_skip', { date, reason: 'no_games' });
    return { date, games_analyzed: 0, picks_written: 0, live: 0, shadow: 0, skipped: true, reason: 'no_games' };
  }

  // Stage 2
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
    log('odds_fetch', { ok: false, date, error: oddsError.message, ms: Date.now() - oddsFetchStart });
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
      date,
      games_without_odds: gamesWithoutOdds.length,
      game_ids: gamesWithoutOdds,
    });
  }

  log('odds_fetch', { ok: !oddsError, date, game_count: gamesWithOdds, games_without_odds: gamesWithoutOdds.length, ms: Date.now() - oddsFetchStart });

  // If no game has any odds, skip — worker would return zero candidates anyway
  if (gamesWithOdds === 0) {
    log('pipeline_skip', { date, reason: 'no_odds_for_any_game' });
    return { date, games_analyzed: games.length, picks_written: 0, live: 0, shadow: 0, skipped: true, reason: 'no_odds' };
  }

  // Stage 3
  const newsFetchStart = Date.now();
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const { data: signalsData, error: signalsError } = await supabase
    .from('news_signals')
    .select('game_id, signal_type, confidence, payload')
    .in('game_id', gameIds)
    .gte('created_at', sixHoursAgo);

  if (signalsError) {
    log('news_fetch', { ok: false, date, error: signalsError.message, ms: Date.now() - newsFetchStart });
  }

  const signalsByGame: Record<string, NewsSignalRow[]> = {};
  for (const row of (signalsData ?? []) as (NewsSignalRow & { game_id: string })[]) {
    if (!signalsByGame[row.game_id]) signalsByGame[row.game_id] = [];
    signalsByGame[row.game_id].push(row);
  }

  log('news_fetch', {
    ok: !signalsError,
    date,
    games_with_signals: Object.keys(signalsByGame).length,
    total_signals: (signalsData ?? []).length,
    ms: Date.now() - newsFetchStart,
  });

  // Stage 4
  const allCandidates: PickCandidate[] = [];
  for (const game of games) {
    const gameOdds = oddsByGame[game.id] ?? [];
    const gameSignals = signalsByGame[game.id] ?? [];
    const workerCallStart = Date.now();

    if (gameOdds.length === 0) {
      log('worker_call_no_odds_in_edge', { ok: true, date, game_id: game.id });
    }

    try {
      const candidates = await callPredict({
        game_id: game.id,
        markets: ['moneyline', 'run_line', 'total'],
      });
      allCandidates.push(...candidates);
      log('worker_call', {
        ok: true,
        date,
        game_id: game.id,
        candidates: candidates.length,
        news_signal_count: gameSignals.length,
        ms: Date.now() - workerCallStart,
      });
    } catch (err) {
      log('worker_call', {
        ok: false,
        date,
        game_id: game.id,
        error: err instanceof Error ? err.message : String(err),
        stage: 'predict',
        ms: Date.now() - workerCallStart,
      });
    }
  }

  // Stage 5
  const malformedCandidates = allCandidates.filter(
    (c) => typeof c.expected_value !== 'number' || typeof c.confidence_tier !== 'number'
  );
  if (malformedCandidates.length > 0) {
    log('ev_filter_malformed', {
      ok: false,
      date,
      count: malformedCandidates.length,
      game_ids: malformedCandidates.map((c) => c.game_id),
    });
  }

  const validCandidates = allCandidates.filter(
    (c) => typeof c.expected_value === 'number' && typeof c.confidence_tier === 'number'
  );

  const shadowCandidates = validCandidates.filter(
    (c) => c.expected_value >= SHADOW_EV_MIN && c.confidence_tier >= SHADOW_TIER_MIN
  );

  // LIVE eligibility = EV + tier gate AND market not in blocklist.
  // Blocked markets land as shadow regardless of EV/tier — see
  // LIVE_MARKET_BLOCKLIST docstring above.
  const liveCandidates = new Set(
    shadowCandidates
      .filter((c) =>
        c.expected_value >= LIVE_EV_MIN &&
        c.confidence_tier >= LIVE_TIER_MIN &&
        !LIVE_MARKET_BLOCKLIST.has(c.market)
      )
      .map((c) => `${c.game_id}:${c.market}:${c.pick_side}`)
  );

  const blockedFromLive = shadowCandidates.filter((c) =>
    c.expected_value >= LIVE_EV_MIN &&
    c.confidence_tier >= LIVE_TIER_MIN &&
    LIVE_MARKET_BLOCKLIST.has(c.market)
  ).length;

  log('ev_filter', {
    ok: true,
    date,
    total: allCandidates.length,
    valid: validCandidates.length,
    malformed: malformedCandidates.length,
    shadow: shadowCandidates.length,
    live: liveCandidates.size,
    live_blocked_by_market: blockedFromLive,
    market_blocklist: Array.from(LIVE_MARKET_BLOCKLIST),
  });

  if (shadowCandidates.length === 0) {
    log('pipeline_complete', { date, picks_written: 0, reason: 'no_qualified_picks' });
    return { date, games_analyzed: games.length, picks_written: 0, live: 0, shadow: 0 };
  }

  // Dedup
  const deduped = new Map<string, PickCandidate>();
  for (const candidate of shadowCandidates) {
    const key = `${candidate.game_id}:${candidate.market}`;
    const existing = deduped.get(key);
    if (!existing) { deduped.set(key, candidate); continue; }

    const existingIsLive = liveCandidates.has(`${existing.game_id}:${existing.market}:${existing.pick_side}`);
    const incomingIsLive = liveCandidates.has(`${candidate.game_id}:${candidate.market}:${candidate.pick_side}`);

    let prefer = false;
    if (candidate.expected_value > existing.expected_value) {
      prefer = true;
    } else if (candidate.expected_value === existing.expected_value) {
      if (incomingIsLive && !existingIsLive) {
        prefer = true;
      } else if (incomingIsLive === existingIsLive) {
        prefer = candidate.best_line.sportsbook_key === 'draftkings' &&
                 existing.best_line.sportsbook_key !== 'draftkings';
      }
    }
    if (prefer) deduped.set(key, candidate);
  }
  const dedupedCandidates = Array.from(deduped.values());
  log('ev_filter_deduped', { date, input_count: shadowCandidates.length, output_count: dedupedCandidates.length });

  // Stage 6 — game_context for rationale
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
      home_team: { name: g.home_team?.name ?? 'Home', abbreviation: g.home_team?.abbreviation ?? 'HM', record: '0-0' },
      away_team: { name: g.away_team?.name ?? 'Away', abbreviation: g.away_team?.abbreviation ?? 'AW', record: '0-0' },
      game_time_local: g.game_time_utc
        ? new Date(g.game_time_utc).toLocaleString('en-US', {
            hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short',
          })
        : 'TBD',
      venue: g.venue_name ?? 'Unknown Venue',
      probable_home_pitcher: null,
      probable_away_pitcher: null,
      weather: g.weather_condition
        ? { condition: g.weather_condition, temp_f: g.weather_temp_f ?? 72, wind_mph: g.weather_wind_mph ?? 0, wind_dir: g.weather_wind_dir ?? 'N' }
        : null,
    };
  }

  interface PreparedPickWithVisibility extends PreparedPick {
    visibility: 'shadow' | 'live';
  }

  const preparedPicks: PreparedPickWithVisibility[] = [];
  for (const candidate of dedupedCandidates) {
    const candidateKey = `${candidate.game_id}:${candidate.market}:${candidate.pick_side}`;
    const visibility = liveCandidates.has(candidateKey) ? 'live' : 'shadow';
    const requiredTier = requiredTierFor(candidate.confidence_tier);
    let rationaleResult = { rationale_cache_id: null as string | null, cache_hit: false };

    if (visibility === 'live') {
      try {
        const gameContext = gameContextByGameId[candidate.game_id];
        if (gameContext) {
          rationaleResult = await getOrGenerateRationale(candidate, gameContext, requiredTier, supabase);
        }
        log('rationale_call', { ok: true, date, game_id: candidate.game_id, tier: requiredTier, cache_hit: rationaleResult.cache_hit });
      } catch (err) {
        log('rationale_call', { ok: false, date, game_id: candidate.game_id, error: err instanceof Error ? err.message : String(err) });
      }
    }

    preparedPicks.push({ candidate, required_tier: requiredTier, rationale_cache_id: rationaleResult.rationale_cache_id, visibility });
  }

  // Stage 7 — DB write
  const sbFetchStart = Date.now();
  const { data: sbData, error: sbError } = await supabase.from('sportsbooks').select('id, key');
  if (sbError) {
    log('db_write_sportsbooks_fetch', { ok: false, date, error: sbError.message, ms: Date.now() - sbFetchStart });
  } else {
    log('db_write_sportsbooks_fetch', { ok: true, date, count: sbData?.length ?? 0, ms: Date.now() - sbFetchStart });
  }
  const sbByKey: Record<string, string> = {};
  for (const sb of sbData ?? []) sbByKey[sb.key] = sb.id;

  const dbWriteStart = Date.now();

  const belowGate = preparedPicks.filter((p) => p.candidate.confidence_tier < SHADOW_TIER_MIN);
  if (belowGate.length > 0) {
    log('ev_filter_invariant_violation', {
      ok: false,
      date,
      count: belowGate.length,
      game_ids: belowGate.map((p) => p.candidate.game_id),
      tiers: belowGate.map((p) => p.candidate.confidence_tier),
    });
  }

  const insertRows = preparedPicks.map(({ candidate, required_tier, rationale_cache_id, visibility }) => ({
    game_id: candidate.game_id,
    pick_date: date,
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
    market_novig_prior: null,
    model_delta: null,
    news_signals_applied: false,
  }));

  const { data: upsertResult, error: insertError } = await supabase
    .from('picks')
    .upsert(insertRows, { onConflict: 'game_id,market,pick_side,pick_date', ignoreDuplicates: false })
    .select();

  if (insertError) {
    log('db_write', { ok: false, date, error: insertError.message, count: insertRows.length, ms: Date.now() - dbWriteStart });
    return { date, games_analyzed: games.length, picks_written: 0, live: 0, shadow: 0, error: insertError.message };
  }

  const liveCount = preparedPicks.filter((p) => p.visibility === 'live').length;
  const shadowCount = preparedPicks.filter((p) => p.visibility === 'shadow').length;
  // affected_rows = inserts + updates after upsert; per-row insert-vs-update breakdown not exposed by PostgREST
  log('db_write', { ok: true, date, count: insertRows.length, affected_rows: upsertResult?.length ?? 0, live: liveCount, shadow: shadowCount, ms: Date.now() - dbWriteStart });

  // Stage 8 — invalidate cache
  if (liveCount > 0) {
    try {
      await invalidatePicksCache(date);
      log('cache_invalidate', { ok: true, date });
    } catch (err) {
      log('cache_invalidate', {
        ok: false,
        date,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    log('cache_invalidate', { ok: true, date, skipped: true, reason: 'no live picks written' });
  }

  log('pipeline_complete', { date, picks_written: preparedPicks.length, live: liveCount, shadow: shadowCount });

  return { date, games_analyzed: games.length, picks_written: preparedPicks.length, live: liveCount, shadow: shadowCount };
}

// Re-export for any external imports (e.g. tests)
export { todayInET };
