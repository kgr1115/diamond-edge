import { NextResponse } from 'next/server';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { syncBoxScores } from '@/lib/ingestion/mlb-stats/box-scores';
import { cacheInvalidatePattern, CacheKeys } from '@/lib/redis/cache';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PickResult = 'win' | 'loss' | 'push' | 'void';

export interface GradingOutcome {
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
  if (home_score === away_score) return 'void';
  const homeWon = home_score > away_score;
  if (pick_side === 'home' || pick_side === home_team_id) return homeWon ? 'win' : 'loss';
  if (pick_side === 'away' || pick_side === away_team_id) return homeWon ? 'loss' : 'win';
  return 'void';
}

/**
 * Grade a run-line pick.
 * spread is the home-team spread (negative = home favorite). Push on exact cover.
 */
export function gradeRunLine(
  pick_side: string,
  home_score: number,
  away_score: number,
  home_team_id: string,
  away_team_id: string,
  spread: number,
): PickResult {
  const diff = home_score - away_score;
  const absSpread = Math.abs(spread);

  let homeCovered: boolean;
  let push: boolean;

  if (spread < 0) {
    homeCovered = diff > absSpread;
    push = diff === absSpread;
  } else {
    homeCovered = diff >= -absSpread;
    push = diff === -absSpread;
  }

  if (push) return 'push';
  if (pick_side === 'home' || pick_side === home_team_id) return homeCovered ? 'win' : 'loss';
  if (pick_side === 'away' || pick_side === away_team_id) return homeCovered ? 'loss' : 'win';
  return 'void';
}

/** Grade an over/under pick. pick_side = 'over' | 'under'. Push on exact total. */
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

/** P&L in units given result and American odds. 1-unit stake. */
export function computePnL(result: PickResult, americanOdds: number | null): number {
  if (result === 'push' || result === 'void') return 0;
  if (result === 'loss') return -1;
  if (americanOdds === null) return 0.909; // default -110 payout
  return americanOdds > 0 ? americanOdds / 100 : 100 / Math.abs(americanOdds);
}

// ---------------------------------------------------------------------------
// DB helpers (used internally by runOutcomeGrader)
// ---------------------------------------------------------------------------

async function updatePickResults(
  supabase: SupabaseClient,
  outcomes: GradingOutcome[],
): Promise<void> {
  const resultGroups: Record<PickResult, string[]> = { win: [], loss: [], push: [], void: [] };
  for (const o of outcomes) resultGroups[o.result].push(o.pick_id);

  for (const [result, ids] of Object.entries(resultGroups) as [PickResult, string[]][]) {
    if (ids.length === 0) continue;
    const { error } = await supabase.from('picks').update({ result }).in('id', ids);
    if (error) {
      console.error(JSON.stringify({ level: 'error', event: 'outcome_grader_picks_update_failed', result, count: ids.length, error: error.message }));
    } else {
      console.info(JSON.stringify({ level: 'info', event: 'outcome_grader_picks_updated', result, count: ids.length }));
    }
  }
}

// Derive SCAN globs from CacheKeys builders so the prefix is single-sourced
// (the original bug was a typo'd literal). For builders with numeric segments,
// trim down to the prefix and append a single '*' — SCAN matches '*' greedily
// across ':' boundaries, covering every concrete key the builder can produce.
function patternFor(key: string, keepSegments: number): string {
  return `${key.split(':').slice(0, keepSegments).join(':')}:*`;
}

async function invalidateGradedCaches(): Promise<void> {
  const patterns = [
    patternFor(CacheKeys.historyAgg('x', 'x', 'x'), 3),   // de:history:agg:*
    patternFor(CacheKeys.historyList('x', 'x', 'x', 0, 0), 3), // de:history:list:*
    patternFor(CacheKeys.picksToday('x', 'x'), 3),        // de:picks:today:*
  ];
  await Promise.all(patterns.map((p) => cacheInvalidatePattern(p)));
}

// ---------------------------------------------------------------------------
// Main: runOutcomeGrader
// ---------------------------------------------------------------------------

export async function runOutcomeGrader(): Promise<NextResponse<OutcomeGraderResult>> {
  const startMs = Date.now();

  const supabaseUrl = process.env.SUPABASE_URL!;
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  if (!supabaseUrl || !serviceKey) {
    console.error(JSON.stringify({ level: 'error', event: 'outcome_grader_config_missing' }));
    return NextResponse.json(
      { graded: 0, wins: 0, losses: 0, pushes: 0, voids: 0, errors: ['Supabase env vars missing'], durationMs: 0 },
      { status: 500 },
    );
  }

  const supabase = createClient(supabaseUrl, serviceKey);
  console.info(JSON.stringify({ level: 'info', event: 'outcome_grader_start', time: new Date().toISOString() }));

  try {
    const sync = await syncBoxScores();
    console.info(JSON.stringify({
      level: 'info',
      event: 'outcome_grader_box_scores_synced',
      games_checked: sync.gamesChecked,
      games_updated: sync.gamesUpdated,
      errors: sync.errors.length,
    }));
    for (const msg of sync.errors) {
      console.warn(JSON.stringify({ level: 'warn', event: 'outcome_grader_box_scores_error', error: msg }));
    }
  } catch (err) {
    console.warn(JSON.stringify({
      level: 'warn',
      event: 'outcome_grader_box_scores_failed',
      error: err instanceof Error ? err.message : String(err),
    }));
  }

  // Eligibility: result='pending' AND game has both home + away scores
  // populated under the 'final' status. The previous gate
  // (games.updated_at < 6h ago) was meant to wait out score-stabilization
  // races, but it broke manual backfills where syncBoxScores had just
  // touched every flipped game (updated_at = NOW). Filtering on
  // home_score IS NOT NULL AND away_score IS NOT NULL is race-safe AND
  // backfill-friendly: scores are written in the same syncBoxScores
  // update that flips status, so once both columns are populated the
  // data is consistent.
  //
  // No FK exists from picks → odds (the join is composite via game_id +
  // market + sportsbook_id), so we can't use PostgREST embedded selection
  // here. Two-query pattern: fetch picks first, then look up the snapshot-
  // pinned odds row per pick. Mirrors the snapshot-pinning fix in
  // apps/web/lib/picks/load-slate.ts (commit f38ae7c).
  const { data: picksData, error: picksError } = await supabase
    .from('picks')
    .select(`
      id, game_id, market, pick_side, best_line_price, best_line_book_id, generated_at,
      games!inner ( home_score, away_score, home_team_id, away_team_id, status, updated_at )
    `)
    .eq('result', 'pending')
    .eq('games.status', 'final')
    .not('games.home_score', 'is', null)
    .not('games.away_score', 'is', null);

  if (picksError) {
    console.error(JSON.stringify({ level: 'error', event: 'outcome_grader_fetch_failed', error: picksError.message }));
    return NextResponse.json(
      { graded: 0, wins: 0, losses: 0, pushes: 0, voids: 0, errors: [picksError.message], durationMs: Date.now() - startMs },
      { status: 500 },
    );
  }

  const picks = (picksData ?? []) as unknown as Array<{
    id: string; game_id: string; market: string; pick_side: string; best_line_price: number | null;
    best_line_book_id: string | null; generated_at: string | null;
    games: { home_score: number | null; away_score: number | null; home_team_id: string; away_team_id: string; status: string; updated_at: string };
  }>;

  // Build a per-pick lookup for run_line_spread / total_line using snapshot
  // pinning: prefer the odds row from the same book at-or-before pick time;
  // fall back to any book at-or-before pick time, then to most-recent.
  const lineByPickId = new Map<string, { run_line_spread: number | null; total_line: number | null }>();
  const rlAndTotalsPicks = picks.filter((p) => p.market === 'run_line' || p.market === 'total');

  if (rlAndTotalsPicks.length > 0) {
    const gameIds = Array.from(new Set(rlAndTotalsPicks.map((p) => p.game_id)));
    const markets = Array.from(new Set(rlAndTotalsPicks.map((p) => p.market)));

    const { data: oddsRows } = await supabase
      .from('odds')
      .select('game_id, market, sportsbook_id, run_line_spread, total_line, snapshotted_at')
      .in('game_id', gameIds)
      .in('market', markets);

    const oddsByKey = new Map<string, Array<{ sportsbook_id: string | null; run_line_spread: number | null; total_line: number | null; snapshotted_at: string }>>();
    for (const o of (oddsRows ?? [])) {
      const key = `${o.game_id}::${o.market}`;
      if (!oddsByKey.has(key)) oddsByKey.set(key, []);
      oddsByKey.get(key)!.push(o);
    }

    for (const p of rlAndTotalsPicks) {
      const candidates = oddsByKey.get(`${p.game_id}::${p.market}`) ?? [];
      if (candidates.length === 0) {
        lineByPickId.set(p.id, { run_line_spread: null, total_line: null });
        continue;
      }
      const pickTimeMs = p.generated_at ? new Date(p.generated_at).getTime() + 5 * 60 * 1000 : Date.now();

      // Tier 1: same book at-or-before pick time, newest first
      const sameBookPrePick = candidates
        .filter((o) => o.sportsbook_id === p.best_line_book_id && new Date(o.snapshotted_at).getTime() <= pickTimeMs)
        .sort((a, b) => (a.snapshotted_at < b.snapshotted_at ? 1 : -1));
      // Tier 2: any book at-or-before pick time
      const anyBookPrePick = candidates
        .filter((o) => new Date(o.snapshotted_at).getTime() <= pickTimeMs)
        .sort((a, b) => (a.snapshotted_at < b.snapshotted_at ? 1 : -1));
      // Tier 3: any time
      const anyTime = candidates.sort((a, b) => (a.snapshotted_at < b.snapshotted_at ? 1 : -1));

      const chosen = sameBookPrePick[0] ?? anyBookPrePick[0] ?? anyTime[0];
      lineByPickId.set(p.id, {
        run_line_spread: chosen.run_line_spread ?? null,
        total_line: chosen.total_line ?? null,
      });
    }
  }

  console.info(JSON.stringify({ level: 'info', event: 'outcome_grader_picks_loaded', pending_count: picks.length }));

  if (picks.length === 0) {
    const durationMs = Date.now() - startMs;
    console.info(JSON.stringify({ level: 'info', event: 'outcome_grader_complete', graded: 0, durationMs }));
    return NextResponse.json({ graded: 0, wins: 0, losses: 0, pushes: 0, voids: 0, errors: [], durationMs }, { status: 200 });
  }

  const outcomes: GradingOutcome[] = [];
  const errors: string[] = [];

  for (const row of picks) {
    const { id: pick_id, game_id, market, pick_side, best_line_price } = row;
    const { home_score, away_score, home_team_id, away_team_id } = row.games;

    if (home_score === null || away_score === null) {
      outcomes.push({ pick_id, game_id, result: 'void', home_score: 0, away_score: 0, pnl_units: 0, notes: 'final status with null scores — data ingestion issue' });
      continue;
    }

    const pinnedLine = lineByPickId.get(pick_id) ?? null;

    let result: PickResult;
    let notes: string | null = null;

    try {
      switch (market) {
        case 'moneyline':
          result = gradeMoneyline(pick_side, home_score, away_score, home_team_id, away_team_id);
          break;
        case 'run_line': {
          const spread = pinnedLine?.run_line_spread ?? -1.5;
          result = gradeRunLine(pick_side, home_score, away_score, home_team_id, away_team_id, spread);
          break;
        }
        case 'total': {
          const line = pinnedLine?.total_line ?? null;
          if (line === null) { result = 'void'; notes = 'total_line unavailable — grading as void'; }
          else result = gradeTotal(pick_side, home_score, away_score, line);
          break;
        }
        default: continue;
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

  if (outcomes.length > 0) {
    const outcomeRows = outcomes.map((o) => ({
      pick_id: o.pick_id, game_id: o.game_id, result: o.result,
      home_score: o.home_score, away_score: o.away_score,
      graded_at: new Date().toISOString(), notes: o.notes,
    }));

    const { error: upsertError } = await supabase.from('pick_outcomes').upsert(outcomeRows, { onConflict: 'pick_id' });

    if (upsertError) {
      console.error(JSON.stringify({ level: 'error', event: 'outcome_grader_upsert_failed', error: upsertError.message }));
      errors.push(`pick_outcomes upsert failed: ${upsertError.message}`);
    } else {
      await updatePickResults(supabase, outcomes);
    }

    await invalidateGradedCaches().catch((err) => {
      console.warn(JSON.stringify({ level: 'warn', event: 'outcome_grader_cache_invalidation_failed', error: err instanceof Error ? err.message : String(err) }));
    });
  }

  const wins    = outcomes.filter((o) => o.result === 'win').length;
  const losses  = outcomes.filter((o) => o.result === 'loss').length;
  const pushes  = outcomes.filter((o) => o.result === 'push').length;
  const voids   = outcomes.filter((o) => o.result === 'void').length;
  const durationMs = Date.now() - startMs;

  console.info(JSON.stringify({ level: 'info', event: 'outcome_grader_complete', graded: outcomes.length, wins, losses, pushes, voids, errors: errors.length, durationMs }));

  return NextResponse.json(
    { graded: outcomes.length, wins, losses, pushes, voids, errors, durationMs },
    { status: errors.length > 0 ? 207 : 200 },
  );
}
