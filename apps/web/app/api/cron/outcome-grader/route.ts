/**
 * Vercel Cron handler: GET /api/cron/outcome-grader
 * Registered in vercel.json at schedule "0 8 * * *" (08:00 UTC / 3 AM ET).
 * Also called from pg_cron job 'outcome-grader' at the same schedule.
 *
 * Grades all pending picks for games that reached status='final' at least
 * 6 hours ago. Handles moneyline, run_line, and total markets. Idempotent:
 * uses upsert on pick_outcomes(pick_id) so retries are safe.
 *
 * Auth: CRON_SECRET Bearer header (same secret as other cron routes).
 * RLS bypass: uses SUPABASE_SERVICE_ROLE_KEY — never exposed to client.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const maxDuration = 60;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PickResult = 'win' | 'loss' | 'push' | 'void';

interface PendingPick {
  id: string;
  game_id: string;
  market: string;
  pick_side: string;
  best_line_price: number | null;
  // Joined from games
  home_score: number | null;
  away_score: number | null;
  home_team_id: string;
  away_team_id: string;
  // Run line / total metadata (stored at pick time)
  run_line_spread: number | null;
  total_line: number | null;
}

interface GradingOutcome {
  pick_id: string;
  game_id: string;
  result: PickResult;
  home_score: number;
  away_score: number;
  pnl_units: number;    // profit/loss in units assuming 1-unit stake
  notes: string | null;
}

export interface OutcomeGraderResult {
  graded: number;
  wins: number;
  losses: number;
  pushes: number;
  voids: number;
  errors: string[];
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Auth guard
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    console.warn(JSON.stringify({
      level: 'warn',
      event: 'cron_unauthorized',
      path: '/api/cron/outcome-grader',
    }));
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Unauthorized.' } },
      { status: 401 }
    );
  }

  return runOutcomeGrader();
}

// ---------------------------------------------------------------------------
// Grader — exported so tests can call it directly
// ---------------------------------------------------------------------------

export async function runOutcomeGrader(): Promise<NextResponse<OutcomeGraderResult>> {
  const startMs = Date.now();

  const supabaseUrl = process.env.SUPABASE_URL!;
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  if (!supabaseUrl || !serviceKey) {
    console.error(JSON.stringify({ level: 'error', event: 'outcome_grader_config_missing' }));
    return NextResponse.json(
      { graded: 0, wins: 0, losses: 0, pushes: 0, voids: 0, errors: ['Supabase env vars missing'], durationMs: 0 },
      { status: 500 }
    );
  }

  // Service role bypasses RLS — required to read shadow picks and write outcomes.
  const supabase = createClient(supabaseUrl, serviceKey);

  console.info(JSON.stringify({ level: 'info', event: 'outcome_grader_start', time: new Date().toISOString() }));

  // ---------------------------------------------------------------------------
  // 1. Fetch pending picks for games that went final at least 6 hours ago.
  //    The 6h buffer ensures box scores are settled (extra innings, protest, etc).
  // ---------------------------------------------------------------------------
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

  const { data: picksData, error: picksError } = await supabase
    .from('picks')
    .select(`
      id,
      game_id,
      market,
      pick_side,
      best_line_price,
      games!inner (
        home_score,
        away_score,
        home_team_id,
        away_team_id,
        status,
        updated_at
      ),
      odds!left (
        run_line_spread,
        total_line,
        market,
        snapshotted_at
      )
    `)
    .eq('result', 'pending')
    .eq('games.status', 'final')
    .lt('games.updated_at', sixHoursAgo);

  if (picksError) {
    console.error(JSON.stringify({
      level: 'error',
      event: 'outcome_grader_fetch_failed',
      error: picksError.message,
    }));
    return NextResponse.json(
      { graded: 0, wins: 0, losses: 0, pushes: 0, voids: 0, errors: [picksError.message], durationMs: Date.now() - startMs },
      { status: 500 }
    );
  }

  const picks = (picksData ?? []) as unknown as Array<{
    id: string;
    game_id: string;
    market: string;
    pick_side: string;
    best_line_price: number | null;
    games: {
      home_score: number | null;
      away_score: number | null;
      home_team_id: string;
      away_team_id: string;
      status: string;
      updated_at: string;
    };
    odds: Array<{
      run_line_spread: number | null;
      total_line: number | null;
      market: string;
      snapshotted_at: string;
    }> | null;
  }>;

  console.info(JSON.stringify({
    level: 'info',
    event: 'outcome_grader_picks_loaded',
    pending_count: picks.length,
  }));

  if (picks.length === 0) {
    const durationMs = Date.now() - startMs;
    console.info(JSON.stringify({ level: 'info', event: 'outcome_grader_complete', graded: 0, durationMs }));
    return NextResponse.json(
      { graded: 0, wins: 0, losses: 0, pushes: 0, voids: 0, errors: [], durationMs },
      { status: 200 }
    );
  }

  // ---------------------------------------------------------------------------
  // 2. Grade each pick
  // ---------------------------------------------------------------------------
  const outcomes: GradingOutcome[] = [];
  const errors: string[] = [];

  for (const row of picks) {
    const { id: pick_id, game_id, market, pick_side, best_line_price } = row;
    const { home_score, away_score, home_team_id, away_team_id } = row.games;

    if (home_score === null || away_score === null) {
      // Game is final but scores are null — data issue; mark void.
      outcomes.push({
        pick_id,
        game_id,
        result: 'void',
        home_score: 0,
        away_score: 0,
        pnl_units: 0,
        notes: 'final status with null scores — data ingestion issue',
      });
      continue;
    }

    // Extract run_line_spread and total_line from the joined odds rows.
    // Take the most-recent snapshot for the relevant market.
    const relevantOdds = (row.odds ?? [])
      .filter((o) => o.market === market)
      .sort((a, b) => (a.snapshotted_at < b.snapshotted_at ? 1 : -1));
    const latestOdds = relevantOdds[0] ?? null;

    let result: PickResult;
    let notes: string | null = null;

    try {
      switch (market) {
        case 'moneyline':
          result = gradeMoneyline(pick_side, home_score, away_score, home_team_id, away_team_id);
          break;
        case 'run_line': {
          const spread = latestOdds?.run_line_spread ?? -1.5;
          result = gradeRunLine(pick_side, home_score, away_score, home_team_id, away_team_id, spread);
          break;
        }
        case 'total': {
          const line = latestOdds?.total_line ?? null;
          if (line === null) {
            result = 'void';
            notes = 'total_line unavailable — grading as void';
          } else {
            result = gradeTotal(pick_side, home_score, away_score, line);
          }
          break;
        }
        default:
          // Prop/parlay: not graded by this job; skip silently.
          continue;
      }
    } catch (err) {
      const msg = `grade error pick=${pick_id}: ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg);
      console.error(JSON.stringify({ level: 'error', event: 'outcome_grader_grade_error', pick_id, error: msg }));
      continue;
    }

    const pnl_units = computePnL(result, best_line_price);

    outcomes.push({ pick_id, game_id, result, home_score, away_score, pnl_units, notes });
  }

  // ---------------------------------------------------------------------------
  // 3. Upsert pick_outcomes and update picks.result in a batch
  // ---------------------------------------------------------------------------
  if (outcomes.length > 0) {
    const outcomeRows = outcomes.map((o) => ({
      pick_id: o.pick_id,
      game_id: o.game_id,
      result: o.result,
      home_score: o.home_score,
      away_score: o.away_score,
      graded_at: new Date().toISOString(),
      notes: o.notes,
    }));

    const { error: upsertError } = await supabase
      .from('pick_outcomes')
      .upsert(outcomeRows, { onConflict: 'pick_id' });

    if (upsertError) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'outcome_grader_upsert_failed',
        error: upsertError.message,
      }));
      errors.push(`pick_outcomes upsert failed: ${upsertError.message}`);
    } else {
      // Update picks.result for each graded pick (batched per result value to minimize round-trips).
      await updatePickResults(supabase, outcomes);
    }
  }

  // ---------------------------------------------------------------------------
  // 4. Invalidate picks cache (history queries are affected by result changes)
  // ---------------------------------------------------------------------------
  if (outcomes.length > 0) {
    await invalidateHistoryCache().catch((err) => {
      console.warn(JSON.stringify({
        level: 'warn',
        event: 'outcome_grader_cache_invalidation_failed',
        error: err instanceof Error ? err.message : String(err),
      }));
    });
  }

  // ---------------------------------------------------------------------------
  // 5. Emit structured result
  // ---------------------------------------------------------------------------
  const wins    = outcomes.filter((o) => o.result === 'win').length;
  const losses  = outcomes.filter((o) => o.result === 'loss').length;
  const pushes  = outcomes.filter((o) => o.result === 'push').length;
  const voids   = outcomes.filter((o) => o.result === 'void').length;
  const durationMs = Date.now() - startMs;

  console.info(JSON.stringify({
    level: 'info',
    event: 'outcome_grader_complete',
    graded: outcomes.length,
    wins,
    losses,
    pushes,
    voids,
    errors: errors.length,
    durationMs,
  }));

  return NextResponse.json(
    { graded: outcomes.length, wins, losses, pushes, voids, errors, durationMs },
    { status: errors.length > 0 ? 207 : 200 }
  );
}

// ---------------------------------------------------------------------------
// Grading logic — pure functions, unit-testable
// ---------------------------------------------------------------------------

/**
 * Grade a moneyline pick.
 * pick_side is 'home' or 'away'. Ties (0-0) after full regulation are void (MLB rules).
 */
export function gradeMoneyline(
  pick_side: string,
  home_score: number,
  away_score: number,
  home_team_id: string,
  away_team_id: string,
): PickResult {
  // MLB games can't actually tie in regulation (extra innings), but guard anyway.
  if (home_score === away_score) return 'void';

  const homeWon = home_score > away_score;

  if (pick_side === 'home' || pick_side === home_team_id) {
    return homeWon ? 'win' : 'loss';
  }
  if (pick_side === 'away' || pick_side === away_team_id) {
    return homeWon ? 'loss' : 'win';
  }

  // pick_side didn't match home/away ids or canonical names — data gap
  return 'void';
}

/**
 * Grade a run-line pick.
 * Standard spread is -1.5 (home) or +1.5 (away). Push occurs on exact cover.
 */
export function gradeRunLine(
  pick_side: string,
  home_score: number,
  away_score: number,
  home_team_id: string,
  away_team_id: string,
  spread: number,
): PickResult {
  // spread is stored as the home-team spread (e.g. -1.5 means home gives 1.5 runs).
  // home cover: home_score - away_score >= abs(spread)  (when spread negative, home is fav)
  // away cover: away_score - home_score >= abs(spread)  (when spread positive, away is fav)
  const diff = home_score - away_score;
  const absSpread = Math.abs(spread);

  let homeCovered: boolean;
  let push: boolean;

  if (spread < 0) {
    // Home is favorite (spread = -1.5): home must win by more than absSpread
    homeCovered = diff > absSpread;
    push = diff === absSpread;
  } else {
    // Away is favorite (spread = +1.5): away must cover
    homeCovered = diff >= -absSpread;
    push = diff === -absSpread;
  }

  if (push) return 'push';

  if (pick_side === 'home' || pick_side === home_team_id) {
    return homeCovered ? 'win' : 'loss';
  }
  if (pick_side === 'away' || pick_side === away_team_id) {
    return homeCovered ? 'loss' : 'win';
  }

  return 'void';
}

/**
 * Grade an over/under pick.
 * pick_side = 'over' | 'under'. Push on exact total.
 */
export function gradeTotal(
  pick_side: string,
  home_score: number,
  away_score: number,
  total_line: number,
): PickResult {
  const combined = home_score + away_score;

  if (combined === total_line) return 'push';

  const wentOver = combined > total_line;

  if (pick_side === 'over') return wentOver ? 'win' : 'loss';
  if (pick_side === 'under') return wentOver ? 'loss' : 'win';

  return 'void';
}

/**
 * Compute P&L in units given result and American odds.
 * Assumes 1-unit stake. Returns profit (positive) or loss (negative).
 */
export function computePnL(result: PickResult, americanOdds: number | null): number {
  if (result === 'push' || result === 'void') return 0;
  if (result === 'loss') return -1;

  // Win: compute profit from American odds
  if (americanOdds === null) return 0.909; // default -110 payout

  if (americanOdds > 0) {
    return americanOdds / 100;
  } else {
    return 100 / Math.abs(americanOdds);
  }
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function updatePickResults(
  supabase: SupabaseClient,
  outcomes: GradingOutcome[],
): Promise<void> {
  const resultGroups: Record<PickResult, string[]> = {
    win: [], loss: [], push: [], void: [],
  };

  for (const o of outcomes) {
    resultGroups[o.result].push(o.pick_id);
  }

  for (const [result, ids] of Object.entries(resultGroups) as [PickResult, string[]][]) {
    if (ids.length === 0) continue;

    const { error } = await supabase
      .from('picks')
      .update({ result })
      .in('id', ids);

    if (error) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'outcome_grader_picks_update_failed',
        result,
        count: ids.length,
        error: error.message,
      }));
    } else {
      console.info(JSON.stringify({
        level: 'info',
        event: 'outcome_grader_picks_updated',
        result,
        count: ids.length,
      }));
    }
  }
}

/**
 * Invalidate the Upstash Redis history cache keys.
 * History keys: de:picks:history:* — pattern delete via SCAN + DEL.
 * Falls back to a targeted DEL for the most common key pattern.
 */
async function invalidateHistoryCache(): Promise<void> {
  const redisUrl   = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!redisUrl || !redisToken) return; // Redis not configured; skip silently.

  const url = redisUrl.replace(/\/$/, '');

  // SCAN for history keys and DEL them.
  // Using KEYS in prod is acceptable on our key volume (<1000 keys total).
  const keysRes = await fetch(`${url}/keys/de:picks:history:*`, {
    headers: { Authorization: `Bearer ${redisToken}` },
  });

  if (!keysRes.ok) return;

  const { result: keys } = await keysRes.json() as { result: string[] };
  if (!keys || keys.length === 0) return;

  // Batch DEL
  await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${redisToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(keys.map((k) => ['DEL', k])),
  });

  console.info(JSON.stringify({
    level: 'info',
    event: 'outcome_grader_cache_invalidated',
    keys_deleted: keys.length,
  }));
}
