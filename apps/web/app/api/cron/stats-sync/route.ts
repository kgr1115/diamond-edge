/**
 * Stats-sync cron handler — wires the five new stats tables.
 *
 * NOT a Vercel Cron route (Vercel Hobby is at its 2-cron limit).
 * Scheduled via pg_cron: see migration 0012 addendum comment below.
 *
 * Exposed as a GET endpoint callable via pg_cron → net.http_post().
 * Run order for one calendar day:
 *   14:00 UTC — schedule-sync runs (games, odds, news)
 *   14:30 UTC — stats-sync runs (pitcher, bullpen, batting, umpire, lineup)
 *   15:30 UTC — lineup-sync tight loop begins (every 15min, pg_cron, see below)
 *   16:00 UTC — pick-pipeline runs
 *
 * Stages in this handler:
 *   1. Pitcher season stats  — for all probable starters in today's slate.
 *   2. Team batting stats    — for all teams playing today.
 *   3. Bullpen team stats    — for all teams playing today.
 *   4. Umpire assignments    — for all today's games (T-2h window; may be empty).
 *   5. Lineup entries        — initial pass; 15-min tight loop handled separately.
 *
 * Duration budget: < 55s on Vercel (60s maxDuration). If the full 30-team
 * season refresh is needed (first run of the season), call via Supabase Edge
 * Function instead, which has no timeout cap.
 *
 * pg_cron registration (add to 0009_pg_cron_schedules.sql or run manually):
 *
 *   SELECT cron.schedule(
 *     'stats-sync-daily',
 *     '30 14 * * *',
 *     $$ SELECT net.http_post(
 *       url     := current_setting('app.vercel_url') || '/api/cron/stats-sync',
 *       headers := jsonb_build_object(
 *         'Content-Type',  'application/json',
 *         'Authorization', 'Bearer ' || current_setting('app.cron_secret')
 *       ),
 *       body := '{}'::jsonb
 *     ) $$
 *   );
 *
 *   SELECT cron.schedule(
 *     'lineup-sync-15min',
 *     '* /15 15-23 * * *',
 *     $$ SELECT net.http_post(
 *       url     := current_setting('app.vercel_url') || '/api/cron/stats-sync?stage=lineup',
 *       headers := jsonb_build_object(
 *         'Content-Type',  'application/json',
 *         'Authorization', 'Bearer ' || current_setting('app.cron_secret')
 *       ),
 *       body := '{}'::jsonb
 *     ) $$
 *   );
 */

import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { syncPitcherStats } from '@/lib/ingestion/stats/pitcher-stats';
import { syncBullpenStats } from '@/lib/ingestion/stats/bullpen-stats';
import { syncTeamBattingStats } from '@/lib/ingestion/stats/team-batting';
import { syncUmpireAssignments } from '@/lib/ingestion/stats/umpire-assignments';
import { syncLineupEntries } from '@/lib/ingestion/stats/lineup-entries';
import { startCronRun, finishCronRun } from '@/lib/ops/cron-run-log';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    console.warn(JSON.stringify({ level: 'warn', event: 'cron_unauthorized', path: '/api/cron/stats-sync' }));
    return NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 });
  }

  const startMs = Date.now();
  const now = new Date();
  const todayUTC = now.toISOString().slice(0, 10);
  const season = now.getUTCMonth() >= 9 ? now.getUTCFullYear() : now.getUTCFullYear();

  // ?stage=lineup triggers only the lineup-sync (15-min tight loop)
  const stage = request.nextUrl.searchParams.get('stage');
  if (stage === 'lineup') {
    const lineupHandle = await startCronRun('stats-sync-lineup');
    const response = await handleLineupOnly(todayUTC, startMs);
    await finishCronRun(lineupHandle, {
      status: response.status >= 200 && response.status < 300 ? 'success' : 'failure',
      errorMsg: response.status >= 300 ? `HTTP ${response.status}` : null,
    });
    return response;
  }

  const runHandle = await startCronRun('stats-sync');

  console.info(JSON.stringify({ level: 'info', event: 'stats_sync_start', todayUTC, season }));

  const supabase = createServiceRoleClient();

  // -------------------------------------------------------------------------
  // Stage 1: Resolve today's probable starters
  // -------------------------------------------------------------------------
  // Cast result to a concrete type that includes the joined pitcher objects.
  // Supabase's generated types don't narrow foreign-key joins to named aliases.
  type TodayGameRow = {
    home_team_id: string;
    away_team_id: string;
    home_sp: { id: string; mlb_player_id: number } | null;
    away_sp: { id: string; mlb_player_id: number } | null;
  };

  const { data: todayGamesRaw } = await supabase
    .from('games')
    .select(`
      home_team_id, away_team_id,
      home_sp:probable_home_pitcher_id(id, mlb_player_id),
      away_sp:probable_away_pitcher_id(id, mlb_player_id)
    `)
    .eq('game_date', todayUTC)
    .in('status', ['scheduled', 'live']);

  const todayGames = (todayGamesRaw ?? []) as unknown as TodayGameRow[];

  // Collect unique (player_uuid, mlb_player_id) pairs for pitchers
  const pitcherSet = new Map<string, { id: string; mlb_player_id: number }>();
  for (const game of todayGames) {
    for (const sp of [game.home_sp, game.away_sp]) {
      if (sp && sp.id && sp.mlb_player_id) {
        pitcherSet.set(sp.id, sp);
      }
    }
  }

  const pitcherList = Array.from(pitcherSet.values());

  // -------------------------------------------------------------------------
  // Stage 2: Pitcher season stats
  // -------------------------------------------------------------------------
  let pitcherResult = { pitchersUpserted: 0, savantRowsMatched: 0, errors: [] as string[] };
  if (pitcherList.length > 0) {
    const stageStart = Date.now();
    try {
      pitcherResult = await syncPitcherStats(pitcherList, season);
      console.info(JSON.stringify({
        level: 'info', event: 'stats_sync_pitcher_done',
        ...pitcherResult, ms: Date.now() - stageStart,
      }));
    } catch (err) {
      const msg = `Pitcher stats sync failed: ${err instanceof Error ? err.message : String(err)}`;
      pitcherResult.errors.push(msg);
      console.error(JSON.stringify({ level: 'error', event: 'stats_sync_pitcher_error', msg }));
    }
  }

  // -------------------------------------------------------------------------
  // Stage 3: Team batting stats
  // -------------------------------------------------------------------------
  const battingStageStart = Date.now();
  const battingResult = await syncTeamBattingStats(season, todayUTC).catch(err => ({
    teamsUpserted: 0, savantRowsMatched: 0,
    errors: [`Team batting sync failed: ${err instanceof Error ? err.message : String(err)}`],
  }));
  console.info(JSON.stringify({
    level: battingResult.errors.length ? 'warn' : 'info',
    event: 'stats_sync_batting_done',
    ...battingResult, ms: Date.now() - battingStageStart,
  }));

  // -------------------------------------------------------------------------
  // Stage 4: Bullpen team stats
  // -------------------------------------------------------------------------
  const bullpenStageStart = Date.now();
  const bullpenResult = await syncBullpenStats(season, todayUTC).catch(err => ({
    teamsUpserted: 0,
    errors: [`Bullpen sync failed: ${err instanceof Error ? err.message : String(err)}`],
  }));
  console.info(JSON.stringify({
    level: bullpenResult.errors.length ? 'warn' : 'info',
    event: 'stats_sync_bullpen_done',
    ...bullpenResult, ms: Date.now() - bullpenStageStart,
  }));

  // -------------------------------------------------------------------------
  // Stage 5: Umpire assignments
  // -------------------------------------------------------------------------
  const umpireStageStart = Date.now();
  const umpireResult = await syncUmpireAssignments(todayUTC).catch(err => ({
    gamesUpdated: 0, umpireStatsResolved: 0,
    errors: [`Umpire sync failed: ${err instanceof Error ? err.message : String(err)}`],
  }));
  console.info(JSON.stringify({
    level: umpireResult.errors.length ? 'warn' : 'info',
    event: 'stats_sync_umpire_done',
    ...umpireResult, ms: Date.now() - umpireStageStart,
  }));

  // -------------------------------------------------------------------------
  // Stage 6: Lineup entries (initial pass — tight loop via separate cron)
  // -------------------------------------------------------------------------
  const lineupStageStart = Date.now();
  const lineupResult = await syncLineupEntries(todayUTC).catch(err => ({
    gamesProcessed: 0, confirmedLineups: 0, placeholderLineups: 0,
    errors: [`Lineup sync failed: ${err instanceof Error ? err.message : String(err)}`],
  }));
  console.info(JSON.stringify({
    level: lineupResult.errors.length ? 'warn' : 'info',
    event: 'stats_sync_lineup_done',
    ...lineupResult, ms: Date.now() - lineupStageStart,
  }));

  const durationMs = Date.now() - startMs;
  const allErrors = [
    ...pitcherResult.errors,
    ...battingResult.errors,
    ...bullpenResult.errors,
    ...umpireResult.errors,
    ...lineupResult.errors,
  ];

  console.info(JSON.stringify({
    level: allErrors.length ? 'warn' : 'info',
    event: 'stats_sync_complete',
    durationMs,
    errorCount: allErrors.length,
  }));

  await finishCronRun(runHandle, {
    status: allErrors.length ? 'failure' : 'success',
    errorMsg: allErrors.length ? allErrors.join(' | ') : null,
  });

  return NextResponse.json({
    pitcher:  { ok: pitcherResult.errors.length === 0, ...pitcherResult },
    batting:  { ok: battingResult.errors.length === 0, ...battingResult },
    bullpen:  { ok: bullpenResult.errors.length === 0, ...bullpenResult },
    umpire:   { ok: umpireResult.errors.length === 0, ...umpireResult },
    lineup:   { ok: lineupResult.errors.length === 0, ...lineupResult },
    durationMs,
  }, { status: allErrors.length ? 207 : 200 });
}

// ---------------------------------------------------------------------------
// Lineup-only fast path for 15-min tight loop
// ---------------------------------------------------------------------------

async function handleLineupOnly(
  todayUTC: string,
  startMs: number,
): Promise<NextResponse> {
  const result = await syncLineupEntries(todayUTC).catch(err => ({
    gamesProcessed: 0, confirmedLineups: 0, placeholderLineups: 0,
    errors: [`Lineup sync failed: ${err instanceof Error ? err.message : String(err)}`],
  }));

  console.info(JSON.stringify({
    level: result.errors.length ? 'warn' : 'info',
    event: 'stats_sync_lineup_tick',
    ...result, durationMs: Date.now() - startMs,
  }));

  return NextResponse.json({
    lineup: { ok: result.errors.length === 0, ...result },
    durationMs: Date.now() - startMs,
  }, { status: result.errors.length ? 207 : 200 });
}
