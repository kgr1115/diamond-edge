/**
 * Odds polling orchestration.
 *
 * Responsibilities:
 * 1. Load active sportsbooks and today's games from DB.
 * 2. Call The Odds API with the active bookmaker keys.
 * 3. Transform and insert odds rows.
 * 4. Return structured metrics (games updated, rows inserted, budget usage).
 *
 * Sportsbook keys come from the DB — adding a new book is a DB INSERT, not a code change.
 */

import { createServiceRoleClient } from '@/lib/supabase/server';
import { fetchMlbOdds } from './client';
import { transformOddsToRows } from './transform';
import type { GameRecord, SportsbookRecord } from './transform';
import { ODDS_API_MARKETS } from '@/lib/ingestion/config';

export interface OddsPollResult {
  gamesProcessed: number;
  rowsInserted: number;
  unmatchedGames: number;
  requestsUsed: number;
  requestsRemaining: number;
  snapshotTime: string;
  errors: string[];
}

/**
 * Run a full odds poll cycle.
 * Called from the `/api/cron/odds-refresh` Vercel Cron handler.
 *
 * Returns a structured result so the cron handler can log and return a detailed response.
 * Never throws — errors are collected and returned in the `errors` array so the cron
 * handler can return 200 with error context rather than triggering a Vercel retry storm.
 */
export async function runOddsPoll(): Promise<OddsPollResult> {
  const errors: string[] = [];
  const supabase = createServiceRoleClient();

  // ------------------------------------------------------------------
  // 1. Load active sportsbooks — data-driven, no hardcoded book list
  // ------------------------------------------------------------------
  const { data: sportsbooks, error: sbError } = await supabase
    .from('sportsbooks')
    .select('id, key')
    .eq('active', true);

  if (sbError || !sportsbooks?.length) {
    errors.push(`Failed to load sportsbooks: ${sbError?.message ?? 'empty result'}`);
    return zeroResult(errors);
  }

  const sportsbookRecords: SportsbookRecord[] = sportsbooks;
  const bookmakerKeys = sportsbookRecords.map(sb => sb.key);

  // ------------------------------------------------------------------
  // 2. Load today's games with team names (needed for game matching)
  // ------------------------------------------------------------------
  const today = todayUtcDate();
  const { data: gamesData, error: gamesError } = await supabase
    .from('games')
    .select(`
      id,
      game_date,
      game_time_utc,
      home_team:home_team_id ( name ),
      away_team:away_team_id ( name )
    `)
    .eq('game_date', today)
    .in('status', ['scheduled', 'live']);

  if (gamesError) {
    errors.push(`Failed to load today's games: ${gamesError.message}`);
    return zeroResult(errors);
  }

  // Supabase returns joined rows as objects; flatten for the transform layer
  const games: GameRecord[] = (gamesData ?? []).map(row => ({
    id: row.id,
    game_date: row.game_date,
    game_time_utc: row.game_time_utc,
    home_team_name: (row.home_team as unknown as { name: string } | null)?.name ?? '',
    away_team_name: (row.away_team as unknown as { name: string } | null)?.name ?? '',
  }));

  if (games.length === 0) {
    // No games today — nothing to poll. Return cleanly.
    console.info(
      JSON.stringify({ level: 'info', event: 'odds_poll_no_games', date: today })
    );
    return { ...zeroResult([]), requestsUsed: 0, requestsRemaining: -1 };
  }

  // ------------------------------------------------------------------
  // 3. Fetch odds from The Odds API
  // ------------------------------------------------------------------
  let oddsResult;
  try {
    oddsResult = await fetchMlbOdds({
      bookmakerKeys,
      markets: ODDS_API_MARKETS,
    });
  } catch (err) {
    errors.push(`Odds API fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    return zeroResult(errors);
  }

  const { games: apiGames, requestsRemaining, requestsUsed } = oddsResult;

  // Log budget usage after every call — catch runaway consumption early.
  console.info(
    JSON.stringify({
      level: 'info',
      event: 'odds_api_call_complete',
      requestsUsed,
      requestsRemaining,
      apiGamesReturned: apiGames.length,
      date: today,
    })
  );

  // Warn when nearing budget limits
  if (requestsRemaining !== -1 && requestsRemaining < 50) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'odds_api_budget_low',
        requestsRemaining,
        requestsUsed,
      })
    );
  }

  // ------------------------------------------------------------------
  // 4. Transform to DB rows
  // ------------------------------------------------------------------
  const { rows, unmatchedGames, snapshotTime } = transformOddsToRows(
    apiGames,
    games,
    sportsbookRecords
  );

  if (unmatchedGames.length > 0) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'odds_games_unmatched',
        count: unmatchedGames.length,
        oddsApiGameIds: unmatchedGames,
        hint: 'Schedule sync may not have run yet for these games',
      })
    );
  }

  if (rows.length === 0) {
    return {
      gamesProcessed: apiGames.length,
      rowsInserted: 0,
      unmatchedGames: unmatchedGames.length,
      requestsUsed,
      requestsRemaining,
      snapshotTime,
      errors,
    };
  }

  // ------------------------------------------------------------------
  // 5. Bulk insert into odds table (append-only — no upsert)
  // ------------------------------------------------------------------
  // Insert in batches of 200 to stay within Supabase request size limits
  const BATCH_SIZE = 200;
  let totalInserted = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error: insertError, count } = await supabase
      .from('odds')
      .insert(batch)
      .select('id'); // count trick — returns inserted rows

    if (insertError) {
      errors.push(`Odds insert batch ${Math.floor(i / BATCH_SIZE)} failed: ${insertError.message}`);
    } else {
      totalInserted += batch.length;
    }
  }

  return {
    gamesProcessed: apiGames.length,
    rowsInserted: totalInserted,
    unmatchedGames: unmatchedGames.length,
    requestsUsed,
    requestsRemaining,
    snapshotTime,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

function zeroResult(errors: string[]): OddsPollResult {
  return {
    gamesProcessed: 0,
    rowsInserted: 0,
    unmatchedGames: 0,
    requestsUsed: 0,
    requestsRemaining: -1,
    snapshotTime: new Date().toISOString(),
    errors,
  };
}
