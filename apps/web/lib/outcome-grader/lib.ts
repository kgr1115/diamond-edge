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

// Shape required for snapshot-pinned line resolution. Both initial-grading
// and regrade flows project picks down to this shape.
type PinnableLineInput = {
  id: string;
  game_id: string;
  market: string;
  best_line_book_id: string | null;
  generated_at: string | null;
};

async function resolvePinnedLines(
  supabase: SupabaseClient,
  candidatePicks: PinnableLineInput[],
  out: Map<string, { run_line_spread: number | null; total_line: number | null }>,
): Promise<void> {
  const rlAndTotals = candidatePicks.filter((p) => p.market === 'run_line' || p.market === 'total');
  if (rlAndTotals.length === 0) return;

  const gameIds = Array.from(new Set(rlAndTotals.map((p) => p.game_id)));
  const markets = Array.from(new Set(rlAndTotals.map((p) => p.market)));

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

  for (const p of rlAndTotals) {
    const candidates = oddsByKey.get(`${p.game_id}::${p.market}`) ?? [];
    if (candidates.length === 0) {
      out.set(p.id, { run_line_spread: null, total_line: null });
      continue;
    }
    const pickTimeMs = p.generated_at ? new Date(p.generated_at).getTime() + 5 * 60 * 1000 : Date.now();

    const sameBookPrePick = candidates
      .filter((o) => o.sportsbook_id === p.best_line_book_id && new Date(o.snapshotted_at).getTime() <= pickTimeMs)
      .sort((a, b) => (a.snapshotted_at < b.snapshotted_at ? 1 : -1));
    const anyBookPrePick = candidates
      .filter((o) => new Date(o.snapshotted_at).getTime() <= pickTimeMs)
      .sort((a, b) => (a.snapshotted_at < b.snapshotted_at ? 1 : -1));
    const anyTime = candidates.sort((a, b) => (a.snapshotted_at < b.snapshotted_at ? 1 : -1));

    const chosen = sameBookPrePick[0] ?? anyBookPrePick[0] ?? anyTime[0];
    out.set(p.id, {
      run_line_spread: chosen.run_line_spread ?? null,
      total_line: chosen.total_line ?? null,
    });
  }
}

// Pure dispatch over the three grading functions. Returns the result and an
// optional notes string. Throws if the grader itself throws (caller catches).
function gradePick(
  market: string,
  pick_side: string,
  home_score: number,
  away_score: number,
  home_team_id: string,
  away_team_id: string,
  pinnedLine: { run_line_spread: number | null; total_line: number | null } | null,
): { result: PickResult; notes: string | null } | null {
  switch (market) {
    case 'moneyline':
      return { result: gradeMoneyline(pick_side, home_score, away_score, home_team_id, away_team_id), notes: null };
    case 'run_line': {
      const spread = pinnedLine?.run_line_spread ?? -1.5;
      return { result: gradeRunLine(pick_side, home_score, away_score, home_team_id, away_team_id, spread), notes: null };
    }
    case 'total': {
      const line = pinnedLine?.total_line ?? null;
      if (line === null) return { result: 'void', notes: 'total_line unavailable — grading as void' };
      return { result: gradeTotal(pick_side, home_score, away_score, line), notes: null };
    }
    default:
      return null;
  }
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

  console.info(JSON.stringify({ level: 'info', event: 'outcome_grader_picks_loaded', pending_count: picks.length }));

  // Second query path: pending picks attached to games that will never reach
  // 'final' status (postponed / cancelled / suspended). MLB rules void wagers
  // on these games. Without this path, picks would sit pending forever.
  // The pending filter is mandatory for idempotency — re-runs must not flip
  // already-voided picks back through the pipeline.
  const VOID_STATUSES = ['postponed', 'cancelled', 'suspended'] as const;
  const { data: voidPicksData, error: voidPicksError } = await supabase
    .from('picks')
    .select(`
      id, game_id,
      games!inner ( status )
    `)
    .eq('result', 'pending')
    .in('games.status', VOID_STATUSES as unknown as string[]);

  if (voidPicksError) {
    console.error(JSON.stringify({ level: 'error', event: 'outcome_grader_void_fetch_failed', error: voidPicksError.message }));
    return NextResponse.json(
      { graded: 0, wins: 0, losses: 0, pushes: 0, voids: 0, errors: [voidPicksError.message], durationMs: Date.now() - startMs },
      { status: 500 },
    );
  }

  const voidPicks = (voidPicksData ?? []) as unknown as Array<{
    id: string; game_id: string;
    games: { status: string };
  }>;

  console.info(JSON.stringify({ level: 'info', event: 'outcome_grader_void_picks_loaded', void_pending_count: voidPicks.length }));

  // Third query path: re-grade already-graded final picks whose underlying
  // game has been touched after grading (e.g., score correction posted by
  // MLB hours after first-final). Detection: games.status='final' AND
  // games.updated_at > pick_outcomes.graded_at. Postponed/cancelled games
  // are not eligible — those flow through the void path above. The pure
  // grading functions are reused; we only WRITE when the result actually
  // changes, to avoid cache churn on idempotent re-runs.
  const { data: regradeOutcomeRows, error: regradeError } = await supabase
    .from('pick_outcomes')
    .select(`
      pick_id, result, graded_at,
      picks!inner (
        id, game_id, market, pick_side, best_line_price, best_line_book_id, generated_at,
        games!inner ( home_score, away_score, home_team_id, away_team_id, status, updated_at )
      )
    `)
    .eq('picks.games.status', 'final');

  if (regradeError) {
    console.error(JSON.stringify({ level: 'error', event: 'outcome_grader_regrade_fetch_failed', error: regradeError.message }));
    return NextResponse.json(
      { graded: 0, wins: 0, losses: 0, pushes: 0, voids: 0, errors: [regradeError.message], durationMs: Date.now() - startMs },
      { status: 500 },
    );
  }

  type RegradeRow = {
    pick_id: string;
    result: PickResult;
    graded_at: string;
    picks: {
      id: string; game_id: string; market: string; pick_side: string; best_line_price: number | null;
      best_line_book_id: string | null; generated_at: string | null;
      games: { home_score: number | null; away_score: number | null; home_team_id: string; away_team_id: string; status: string; updated_at: string };
    };
  };
  // PostgREST cannot express "games.updated_at > pick_outcomes.graded_at"
  // (cross-table column comparison). Filter client-side; the candidate set
  // is bounded by 'final' status which already trims dramatically.
  const regradeCandidates = ((regradeOutcomeRows ?? []) as unknown as RegradeRow[]).filter(
    (r) => new Date(r.picks.games.updated_at).getTime() > new Date(r.graded_at).getTime(),
  );

  console.info(JSON.stringify({ level: 'info', event: 'outcome_grader_regrade_candidates_loaded', regrade_candidate_count: regradeCandidates.length }));

  if (picks.length === 0 && voidPicks.length === 0 && regradeCandidates.length === 0) {
    const durationMs = Date.now() - startMs;
    console.info(JSON.stringify({ level: 'info', event: 'outcome_grader_complete', graded: 0, durationMs }));
    return NextResponse.json({ graded: 0, wins: 0, losses: 0, pushes: 0, voids: 0, errors: [], durationMs }, { status: 200 });
  }

  // Resolve snapshot-pinned lines for both pending picks AND regrade
  // candidates in a single odds-table read. Both flows need the same
  // pinning rules; running once over the union keeps query count flat.
  const lineByPickId = new Map<string, { run_line_spread: number | null; total_line: number | null }>();
  await resolvePinnedLines(
    supabase,
    [
      ...picks.map((p) => ({
        id: p.id, game_id: p.game_id, market: p.market,
        best_line_book_id: p.best_line_book_id, generated_at: p.generated_at,
      })),
      ...regradeCandidates.map((r) => ({
        id: r.picks.id, game_id: r.picks.game_id, market: r.picks.market,
        best_line_book_id: r.picks.best_line_book_id, generated_at: r.picks.generated_at,
      })),
    ],
    lineByPickId,
  );

  const outcomes: GradingOutcome[] = [];
  const errors: string[] = [];

  for (const v of voidPicks) {
    outcomes.push({
      pick_id: v.id,
      game_id: v.game_id,
      result: 'void',
      home_score: 0,
      away_score: 0,
      pnl_units: 0,
      notes: `game ${v.games.status}`,
    });
  }

  for (const row of picks) {
    const { id: pick_id, game_id, market, pick_side, best_line_price } = row;
    const { home_score, away_score, home_team_id, away_team_id } = row.games;

    if (home_score === null || away_score === null) {
      outcomes.push({ pick_id, game_id, result: 'void', home_score: 0, away_score: 0, pnl_units: 0, notes: 'final status with null scores — data ingestion issue' });
      continue;
    }

    const pinnedLine = lineByPickId.get(pick_id) ?? null;

    let graded: { result: PickResult; notes: string | null } | null;
    try {
      graded = gradePick(market, pick_side, home_score, away_score, home_team_id, away_team_id, pinnedLine);
    } catch (err) {
      const msg = `grade error pick=${pick_id}: ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg);
      console.error(JSON.stringify({ level: 'error', event: 'outcome_grader_grade_error', pick_id, error: msg }));
      continue;
    }
    if (graded === null) continue; // unknown market

    const pnl_units = computePnL(graded.result, best_line_price);
    outcomes.push({ pick_id, game_id, result: graded.result, home_score, away_score, pnl_units, notes: graded.notes });
  }

  // Regrade pass: re-run grading for each candidate; ONLY emit an outcome
  // when the result actually changed. Unchanged results are skipped to
  // avoid an upsert that would bump graded_at without surfacing real
  // information AND to avoid cache invalidation churn on idempotent runs.
  // The advancing graded_at on changed rows is what closes the detection
  // window — the upsert below sets graded_at = now() via the existing
  // outcomeRows mapping.
  let regradeChangedCount = 0;
  for (const r of regradeCandidates) {
    const pick = r.picks;
    const game = pick.games;
    const { home_score, away_score, home_team_id, away_team_id } = game;

    if (home_score === null || away_score === null) {
      // A game flipped back to having null scores would be a data anomaly.
      // Don't attempt to regrade — the original outcome stands.
      continue;
    }

    const pinnedLine = lineByPickId.get(pick.id) ?? null;

    let graded: { result: PickResult; notes: string | null } | null;
    try {
      graded = gradePick(pick.market, pick.pick_side, home_score, away_score, home_team_id, away_team_id, pinnedLine);
    } catch (err) {
      const msg = `regrade error pick=${pick.id}: ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg);
      console.error(JSON.stringify({ level: 'error', event: 'outcome_grader_regrade_error', pick_id: pick.id, error: msg }));
      continue;
    }
    if (graded === null) continue;
    if (graded.result === r.result) continue; // no change — skip write

    console.info(JSON.stringify({
      level: 'info',
      event: 'outcome_grader_regrade',
      pick_id: pick.id,
      old_result: r.result,
      new_result: graded.result,
    }));

    const pnl_units = computePnL(graded.result, pick.best_line_price);
    outcomes.push({
      pick_id: pick.id,
      game_id: pick.game_id,
      result: graded.result,
      home_score,
      away_score,
      pnl_units,
      notes: graded.notes ?? `regrade: ${r.result} -> ${graded.result}`,
    });
    regradeChangedCount += 1;
  }

  console.info(JSON.stringify({ level: 'info', event: 'outcome_grader_regrade_summary', regrade_changed_count: regradeChangedCount, regrade_skipped_count: regradeCandidates.length - regradeChangedCount }));

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
