import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { pickClvFrom } from '@/lib/types/pick-clv';
import { startCronRun, finishCronRun } from '@/lib/ops/cron-run-log';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Vercel Cron handler: GET /api/cron/clv-compute
 * Triggered nightly by pg_cron (registered in migration 0009 by backend Phase 5).
 * Also callable directly with CRON_SECRET for manual backfill.
 *
 * Closing Line Value (CLV) measures whether the market moved toward our pick
 * after pick-generation time. Positive CLV = market later agreed with us = genuine edge signal.
 *
 * Algorithm:
 *   1. Find picks where pick_clv row does NOT exist AND game.status = 'final'.
 *   2. For each pick: find the closing odds snapshot from market_priors
 *      (most recent row for the game's market before game_time_utc).
 *   3. Compute novig closing probability for the pick's side.
 *   4. clv_edge = closing_novig_prob - pick_time_novig_prob
 *      (positive = line moved toward us after pick was generated)
 *   5. Insert pick_clv row.
 *
 * Batch size: 200 picks per run to stay within 60s Vercel limit.
 * Picks without market_novig_prior (pre-B2 picks) are skipped gracefully.
 *
 * Security: CRON_SECRET header required.
 */

interface MarketPriorRow {
  id: string;
  game_id: string;
  market: string;
  snapshot_time: string;
  book: string;
  novig_home_prob: number | null;
  novig_total_over_prob: number | null;
  raw_margin: number;
}

interface PickRow {
  id: string;
  game_id: string;
  market: string;
  pick_side: string;
  market_novig_prior: number | null;
  games: {
    game_time_utc: string;
    status: string;
  } | null;
}

/**
 * Remove vig from American odds pair. Returns novig home probability or null if invalid.
 * Mirrors the Python logic in train_b2_delta.py and load_historical_odds_v2.py exactly.
 */
function removeVig(homePrice: number, awayPrice: number): number | null {
  const rawImplied = (price: number): number => {
    if (price > 0) return 100 / (100 + price);
    return Math.abs(price) / (Math.abs(price) + 100);
  };

  const pRaw = rawImplied(homePrice);
  const oRaw = rawImplied(awayPrice);
  const margin = pRaw + oRaw - 1.0;

  if (margin > 0.15 || margin <= 0.0) return null;
  const m = Math.max(margin, 0.005);
  return pRaw / (1.0 + m);
}

/**
 * Compute novig closing probability for a pick's side from market_priors rows.
 * Returns null if insufficient data.
 */
function computeClosingNovigProb(
  market: string,
  pickSide: string,
  closingPriors: MarketPriorRow[],
): number | null {
  const blendedRow = closingPriors.find((r) => r.book === 'blended');
  if (!blendedRow) return null;

  if (market === 'moneyline' || market === 'run_line') {
    const homeProb = blendedRow.novig_home_prob;
    if (homeProb === null) return null;
    if (pickSide === 'home') return homeProb;
    if (pickSide === 'away') return 1.0 - homeProb;
    return null;
  }

  if (market === 'total' || market === 'totals') {
    const overProb = blendedRow.novig_total_over_prob;
    if (overProb === null) return null;
    if (pickSide === 'over') return overProb;
    if (pickSide === 'under') return 1.0 - overProb;
    return null;
  }

  return null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Unauthorized.' } },
      { status: 401 },
    );
  }

  const runHandle = await startCronRun('clv-compute');
  const startMs = Date.now();
  console.info(JSON.stringify({ level: 'info', event: 'clv_compute_start', time: new Date().toISOString() }));

  const wrap = async <T extends NextResponse>(
    build: () => Promise<T>,
  ): Promise<NextResponse> => {
    try {
      const response = await build();
      await finishCronRun(runHandle, {
        status: response.status >= 200 && response.status < 300 ? 'success' : 'failure',
        errorMsg: response.status >= 300 ? `HTTP ${response.status}` : null,
      });
      return response;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await finishCronRun(runHandle, { status: 'failure', errorMsg: msg });
      throw err;
    }
  };

  return wrap(async () => {
  let supabase;
  try {
    supabase = createServiceRoleClient();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ level: 'error', event: 'clv_compute_client_init_failed', error: msg }));
    return NextResponse.json({ error: { code: 'CONFIG_ERROR', message: msg } }, { status: 500 });
  }

  // Server-side exclusion: fetch all pick_ids already present in pick_clv so the
  // picks query excludes them BEFORE the 200-row limit. Keeps the batch healthy
  // — without this, a backlog of already-computed picks could fill the limit and
  // starve newly-final games.
  const existingFetchStart = Date.now();
  const { data: existingClv, error: existingError } = await pickClvFrom(supabase)
    .select('pick_id');

  if (existingError) {
    console.error(JSON.stringify({ level: 'error', event: 'clv_compute_existing_fetch_error', error: existingError.message, ms: Date.now() - existingFetchStart }));
    return NextResponse.json({ error: { code: 'DB_ERROR', message: existingError.message } }, { status: 500 });
  }
  const existingIds = (existingClv ?? []).map((r: { pick_id: string }) => r.pick_id);
  console.info(JSON.stringify({ level: 'info', event: 'clv_compute_existing_fetch', count: existingIds.length, ms: Date.now() - existingFetchStart }));

  // Find picks missing CLV where game is final
  // Left-join semantics via !inner: picks without pick_clv rows are returned
  const pickFetchStart = Date.now();
  let pickQuery = supabase
    .from('picks')
    .select(
      'id, game_id, market, pick_side, market_novig_prior, ' +
        'games!inner(game_time_utc, status)',
    )
    .eq('games.status', 'final')
    .not('market_novig_prior', 'is', null);

  if (existingIds.length > 0) {
    pickQuery = pickQuery.not('id', 'in', `(${existingIds.join(',')})`);
  }

  const { data: rawPicks, error: pickError } = await pickQuery.limit(200);

  if (pickError) {
    console.error(JSON.stringify({ level: 'error', event: 'clv_compute_pick_fetch_error', error: pickError.message, ms: Date.now() - pickFetchStart }));
    return NextResponse.json({ error: { code: 'DB_ERROR', message: pickError.message } }, { status: 500 });
  }
  console.info(JSON.stringify({ level: 'info', event: 'clv_compute_pick_fetch', count: rawPicks?.length ?? 0, ms: Date.now() - pickFetchStart }));

  if (rawPicks?.length === 200) {
    console.warn(JSON.stringify({
      level: 'warn',
      event: 'clv_compute_batch_saturated',
      count: rawPicks.length,
      note: 'hit 200-row batch ceiling; backlog likely exists',
    }));
  }

  const picks = (rawPicks as unknown as PickRow[]) ?? [];

  if (picks.length === 0) {
    console.info(JSON.stringify({ event: 'clv_compute_no_picks' }));
    return NextResponse.json({ computed: 0, skipped: 0 }, { status: 200 });
  }

  // Defensive assertion: all rows from the picks query should already be missing
  // from pick_clv (server-side .not('id', 'in', ...) above). The client-side set
  // is retained as a belt-and-braces guard against drift between the two reads.
  const existingSet = new Set(existingIds);
  const unprocessedPicks = picks.filter((p) => !existingSet.has(p.id));

  if (unprocessedPicks.length === 0) {
    return NextResponse.json({ computed: 0, skipped: picks.length, note: 'all already computed' }, { status: 200 });
  }

  // Batch-load closing market_priors for all unique game+market combos
  const gameMarketPairs = [
    ...new Map(
      unprocessedPicks.map((p) => [
        `${p.game_id}:${p.market}`,
        { game_id: p.game_id, market: p.market, game_time_utc: p.games?.game_time_utc ?? '' },
      ]),
    ).values(),
  ];

  const priorsFetchStart = Date.now();
  const { data: allPriors, error: priorsError } = await supabase
    .from('market_priors')
    .select('id, game_id, market, snapshot_time, book, novig_home_prob, novig_total_over_prob, raw_margin')
    .in(
      'game_id',
      [...new Set(unprocessedPicks.map((p) => p.game_id))],
    );

  if (priorsError) {
    console.error(JSON.stringify({ level: 'error', event: 'clv_compute_priors_fetch_error', error: priorsError.message, ms: Date.now() - priorsFetchStart }));
    return NextResponse.json({ error: { code: 'DB_ERROR', message: priorsError.message } }, { status: 500 });
  }
  console.info(JSON.stringify({ level: 'info', event: 'clv_compute_priors_fetch', count: allPriors?.length ?? 0, ms: Date.now() - priorsFetchStart }));

  const priorsData = (allPriors ?? []) as MarketPriorRow[];

  // Build lookup: game_id:market → sorted closing priors (before game_time_utc)
  const priorsLookup = new Map<string, MarketPriorRow[]>();
  for (const pair of gameMarketPairs) {
    const key = `${pair.game_id}:${pair.market}`;
    const normalized_market = pair.market === 'total' ? 'totals' : pair.market;
    const matchingPriors = priorsData
      .filter(
        (r) =>
          r.game_id === pair.game_id &&
          (r.market === pair.market || r.market === normalized_market) &&
          r.snapshot_time < pair.game_time_utc,
      )
      .sort((a, b) => b.snapshot_time.localeCompare(a.snapshot_time)); // descending = most recent first
    priorsLookup.set(key, matchingPriors);
  }

  // Compute CLV for each pick
  const inserts: Array<{
    pick_id: string;
    pick_time_novig_prob: number;
    closing_novig_prob: number | null;
    clv_edge: number | null;
  }> = [];

  let skipped = 0;
  const perPickErrors: string[] = [];

  for (const pick of unprocessedPicks) {
    try {
      const pickTimeNovig = pick.market_novig_prior;
      if (pickTimeNovig === null) {
        skipped++;
        continue;
      }

      const lookupKey = `${pick.game_id}:${pick.market}`;
      const closingPriors = priorsLookup.get(lookupKey) ?? [];

      // Guard: if closingPriors is empty (missing odds rows), log explicitly.
      if (closingPriors.length === 0) {
        console.info(JSON.stringify({
          level: 'info',
          event: 'clv_compute_no_closing_priors',
          pick_id: pick.id,
          game_id: pick.game_id,
          market: pick.market,
        }));
      }

      const closingNovig = computeClosingNovigProb(pick.market, pick.pick_side, closingPriors);

      const clvEdge = closingNovig !== null ? closingNovig - pickTimeNovig : null;

      inserts.push({
        pick_id: pick.id,
        pick_time_novig_prob: pickTimeNovig,
        closing_novig_prob: closingNovig,
        clv_edge: clvEdge,
      });
    } catch (err) {
      const msg = `CLV compute error for pick ${pick.id}: ${err instanceof Error ? err.message : String(err)}`;
      perPickErrors.push(msg);
      console.error(JSON.stringify({ level: 'error', event: 'clv_compute_per_pick_error', pick_id: pick.id, error: msg }));
    }
  }

  if (inserts.length === 0) {
    const hadErrors = perPickErrors.length > 0;
    console.info(JSON.stringify({ level: hadErrors ? 'warn' : 'info', event: 'clv_compute_no_inserts', skipped: unprocessedPicks.length, per_pick_errors: perPickErrors.length }));
    return NextResponse.json(
      { computed: 0, skipped: unprocessedPicks.length, errors: perPickErrors, note: 'no closing priors found' },
      { status: hadErrors ? 207 : 200 },
    );
  }

  const insertStart = Date.now();
  const { error: insertError } = await pickClvFrom(supabase).insert(inserts);

  if (insertError) {
    console.error(JSON.stringify({ level: 'error', event: 'clv_compute_insert_error', error: insertError.message, ms: Date.now() - insertStart }));
    return NextResponse.json({ error: { code: 'DB_ERROR', message: insertError.message } }, { status: 500 });
  }
  console.info(JSON.stringify({ level: 'info', event: 'clv_compute_insert', count: inserts.length, ms: Date.now() - insertStart }));

  const clvWithData = inserts.filter((r) => r.clv_edge !== null);
  const meanClv =
    clvWithData.length > 0
      ? clvWithData.reduce((sum, r) => sum + (r.clv_edge ?? 0), 0) / clvWithData.length
      : null;

  const allErrors = perPickErrors;
  console.info(
    JSON.stringify({
      level: allErrors.length > 0 ? 'warn' : 'info',
      event: 'clv_compute_complete',
      computed: inserts.length,
      skipped,
      per_pick_errors: allErrors.length,
      with_closing_prob: clvWithData.length,
      mean_clv_edge: meanClv !== null ? Math.round(meanClv * 10000) / 10000 : null,
      duration_ms: Date.now() - startMs,
    }),
  );

  return NextResponse.json(
    {
      computed: inserts.length,
      skipped,
      with_closing_prob: clvWithData.length,
      mean_clv_edge: meanClv,
      errors: allErrors,
      duration_ms: Date.now() - startMs,
    },
    { status: allErrors.length > 0 ? 207 : 200 },
  );
  });
}
