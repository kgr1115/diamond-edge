import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';

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
 *      (most recent row for the game's market before commence_time).
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
    commence_time: string;
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

  const startMs = Date.now();
  const supabase = createServiceRoleClient();

  // Find picks missing CLV where game is final
  // Left-join semantics via !inner: picks without pick_clv rows are returned
  const { data: rawPicks, error: pickError } = await supabase
    .from('picks')
    .select(
      'id, game_id, market, pick_side, market_novig_prior, ' +
        'games!inner(commence_time, status)',
    )
    .eq('games.status', 'final')
    .not('market_novig_prior', 'is', null)
    .limit(200);

  if (pickError) {
    console.error(JSON.stringify({ event: 'clv_compute_pick_fetch_error', error: pickError.message }));
    return NextResponse.json({ error: { code: 'DB_ERROR', message: pickError.message } }, { status: 500 });
  }

  const picks = (rawPicks as unknown as PickRow[]) ?? [];

  if (picks.length === 0) {
    console.info(JSON.stringify({ event: 'clv_compute_no_picks' }));
    return NextResponse.json({ computed: 0, skipped: 0 }, { status: 200 });
  }

  // Filter out picks already in pick_clv
  const pickIds = picks.map((p) => p.id);
  const { data: existingClv } = await supabase
    .from('pick_clv')
    .select('pick_id')
    .in('pick_id', pickIds);

  const existingSet = new Set((existingClv ?? []).map((r: { pick_id: string }) => r.pick_id));
  const unprocessedPicks = picks.filter((p) => !existingSet.has(p.id));

  if (unprocessedPicks.length === 0) {
    return NextResponse.json({ computed: 0, skipped: picks.length, note: 'all already computed' }, { status: 200 });
  }

  // Batch-load closing market_priors for all unique game+market combos
  const gameMarketPairs = [
    ...new Map(
      unprocessedPicks.map((p) => [
        `${p.game_id}:${p.market}`,
        { game_id: p.game_id, market: p.market, commence_time: p.games?.commence_time ?? '' },
      ]),
    ).values(),
  ];

  const { data: allPriors, error: priorsError } = await supabase
    .from('market_priors')
    .select('id, game_id, market, snapshot_time, book, novig_home_prob, novig_total_over_prob, raw_margin')
    .in(
      'game_id',
      [...new Set(unprocessedPicks.map((p) => p.game_id))],
    );

  if (priorsError) {
    console.error(JSON.stringify({ event: 'clv_compute_priors_fetch_error', error: priorsError.message }));
    return NextResponse.json({ error: { code: 'DB_ERROR', message: priorsError.message } }, { status: 500 });
  }

  const priorsData = (allPriors ?? []) as MarketPriorRow[];

  // Build lookup: game_id:market → sorted closing priors (before commence_time)
  const priorsLookup = new Map<string, MarketPriorRow[]>();
  for (const pair of gameMarketPairs) {
    const key = `${pair.game_id}:${pair.market}`;
    const normalized_market = pair.market === 'total' ? 'totals' : pair.market;
    const matchingPriors = priorsData
      .filter(
        (r) =>
          r.game_id === pair.game_id &&
          (r.market === pair.market || r.market === normalized_market) &&
          r.snapshot_time < pair.commence_time,
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

  for (const pick of unprocessedPicks) {
    const pickTimeNovig = pick.market_novig_prior;
    if (pickTimeNovig === null) {
      skipped++;
      continue;
    }

    const lookupKey = `${pick.game_id}:${pick.market}`;
    const closingPriors = priorsLookup.get(lookupKey) ?? [];

    const closingNovig = computeClosingNovigProb(pick.market, pick.pick_side, closingPriors);

    const clvEdge = closingNovig !== null ? closingNovig - pickTimeNovig : null;

    inserts.push({
      pick_id: pick.id,
      pick_time_novig_prob: pickTimeNovig,
      closing_novig_prob: closingNovig,
      clv_edge: clvEdge,
    });
  }

  if (inserts.length === 0) {
    return NextResponse.json(
      { computed: 0, skipped: unprocessedPicks.length, note: 'no closing priors found' },
      { status: 200 },
    );
  }

  // `pick_clv` was added in migration 0011 but Supabase generated types haven't
  // been regenerated yet, so the table isn't in the Database type. Cast to any
  // until `supabase gen types` runs; then this cast can be removed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: insertError } = await (supabase.from as any)('pick_clv').insert(inserts);

  if (insertError) {
    console.error(JSON.stringify({ event: 'clv_compute_insert_error', error: insertError.message }));
    return NextResponse.json({ error: { code: 'DB_ERROR', message: insertError.message } }, { status: 500 });
  }

  const clvWithData = inserts.filter((r) => r.clv_edge !== null);
  const meanClv =
    clvWithData.length > 0
      ? clvWithData.reduce((sum, r) => sum + (r.clv_edge ?? 0), 0) / clvWithData.length
      : null;

  console.info(
    JSON.stringify({
      event: 'clv_compute_complete',
      computed: inserts.length,
      skipped,
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
      duration_ms: Date.now() - startMs,
    },
    { status: 200 },
  );
}
