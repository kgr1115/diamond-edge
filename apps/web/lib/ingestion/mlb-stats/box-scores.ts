/**
 * Box score sync — updates completed games with final scores and status.
 *
 * Flow:
 * 1. Query games table for games in 'live' or 'scheduled' status from yesterday and today.
 * 2. Fetch linescore from MLB Stats API for each game not yet 'final'.
 * 3. Update games table with current score, inning, and status.
 *
 * Called from: the outcome-grader cron job after 4am ET (allows overnight games to complete).
 *
 * Freshness SLA: runs 1x/day at 4am ET. Games finalized overnight are captured within ~4h.
 * Live games during the day are updated by the schedule-sync run which includes linescore
 * hydration for all scheduled games.
 */

import { createServiceRoleClient } from '@/lib/supabase/server';
import { fetchLinescore, fetchSchedule } from './client';
import type { GameStatus } from '@/lib/types/database';

export interface BoxScoreSyncResult {
  gamesChecked: number;
  gamesUpdated: number;
  errors: string[];
}

/**
 * Update box scores for games that may have completed.
 * Looks at games from the past 2 days with non-final status.
 */
export async function syncBoxScores(): Promise<BoxScoreSyncResult> {
  const errors: string[] = [];
  const supabase = createServiceRoleClient();

  // Look at yesterday and today for incomplete games
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(now);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);

  const { data: games, error: gamesError } = await supabase
    .from('games')
    .select('id, mlb_game_id, game_date, status')
    .in('game_date', [yesterdayStr, today])
    .in('status', ['scheduled', 'live']);

  if (gamesError) {
    errors.push(`Failed to load games: ${gamesError.message}`);
    return { gamesChecked: 0, gamesUpdated: 0, errors };
  }

  if (!games?.length) {
    console.info(JSON.stringify({ level: 'info', event: 'box_score_sync_no_pending_games' }));
    return { gamesChecked: 0, gamesUpdated: 0, errors };
  }

  // Use the schedule endpoint with linescore hydration to batch-fetch all games
  const dates = [...new Set(games.map(g => g.game_date))];
  let scheduleResponse;
  try {
    scheduleResponse = await fetchSchedule(dates, {
      hydrate: 'linescore,decisions',
    });
  } catch (err) {
    errors.push(`Schedule fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    return { gamesChecked: games.length, gamesUpdated: 0, errors };
  }

  // Build a lookup: mlb_game_id → schedule entry
  const scheduleByPk = new Map(
    scheduleResponse.dates.flatMap(d => d.games).map(g => [g.gamePk, g])
  );

  let gamesUpdated = 0;

  for (const game of games) {
    const schedGame = scheduleByPk.get(game.mlb_game_id);
    if (!schedGame) continue;

    const { abstractGameState, detailedState } = schedGame.status;
    let newStatus: GameStatus = game.status as GameStatus;

    if (detailedState === 'Postponed') newStatus = 'postponed';
    else if (detailedState === 'Cancelled' || detailedState === 'Canceled') newStatus = 'cancelled';
    else if (abstractGameState === 'Final') newStatus = 'final';
    else if (abstractGameState === 'Live') newStatus = 'live';

    const homeScore = schedGame.linescore?.teams?.home?.runs ?? schedGame.teams.home.score ?? null;
    const awayScore = schedGame.linescore?.teams?.away?.runs ?? schedGame.teams.away.score ?? null;
    const inning = schedGame.linescore?.currentInning ?? null;

    const { error: updateError } = await supabase
      .from('games')
      .update({
        status: newStatus,
        home_score: homeScore,
        away_score: awayScore,
        inning,
        updated_at: new Date().toISOString(),
      })
      .eq('id', game.id);

    if (updateError) {
      errors.push(`Failed to update game ${game.mlb_game_id}: ${updateError.message}`);
    } else {
      gamesUpdated++;
      if (newStatus !== game.status) {
        console.info(
          JSON.stringify({
            level: 'info',
            event: 'game_status_updated',
            mlb_game_id: game.mlb_game_id,
            from: game.status,
            to: newStatus,
            home_score: homeScore,
            away_score: awayScore,
          })
        );
      }
    }
  }

  return { gamesChecked: games.length, gamesUpdated, errors };
}
