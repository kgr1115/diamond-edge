import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createServiceRoleClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const QUERY_SCHEMA = z.object({
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(50),
  market: z.enum(['moneyline', 'run_line', 'total', 'prop', 'parlay', 'future']).optional(),
  result: z.enum(['win', 'loss', 'push', 'void', 'pending']).optional(),
  visibility: z.enum(['live', 'shadow']).optional(),
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = request.nextUrl;

  const parsed = QUERY_SCHEMA.safeParse({
    page: searchParams.get('page') ?? undefined,
    per_page: searchParams.get('per_page') ?? undefined,
    market: searchParams.get('market') ?? undefined,
    result: searchParams.get('result') ?? undefined,
    visibility: searchParams.get('visibility') ?? undefined,
    date_from: searchParams.get('date_from') ?? undefined,
    date_to: searchParams.get('date_to') ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Invalid query parameters.', details: parsed.error.flatten() } },
      { status: 422 },
    );
  }

  const { page, per_page, market, result, date_from, date_to } = parsed.data;
  const offset = (page - 1) * per_page;

  const service = createServiceRoleClient();

  let query = service
    .from('picks')
    .select(
      `id, pick_date, market, pick_side, confidence_tier, result, best_line_price,
       games!inner ( home_team:home_team_id ( name ), away_team:away_team_id ( name ) )`,
      { count: 'exact' },
    )
    .order('pick_date', { ascending: false })
    .range(offset, offset + per_page - 1);

  if (market) query = query.eq('market', market);
  if (result) query = query.eq('result', result);
  if (date_from) query = query.gte('pick_date', date_from);
  if (date_to) query = query.lte('pick_date', date_to);

  const { data: picksRaw, count, error: dbError } = await query;

  if (dbError) {
    return NextResponse.json({ error: { code: 'DB_ERROR', message: dbError.message } }, { status: 500 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const picks = (picksRaw as any[]) ?? [];

  // Aggregate stats over the filtered result set — pull all (up to 5000) for rollup
  let statsQuery = service
    .from('picks')
    .select('result, best_line_price, market');

  if (market) statsQuery = statsQuery.eq('market', market);
  if (result) statsQuery = statsQuery.eq('result', result);
  if (date_from) statsQuery = statsQuery.gte('pick_date', date_from);
  if (date_to) statsQuery = statsQuery.lte('pick_date', date_to);

  statsQuery = statsQuery.limit(5000);

  const { data: allForStats } = await statsQuery;
  const statsRows = (allForStats ?? []) as Array<{ result: string; best_line_price: number | null; market: string }>;

  let wins = 0;
  let losses = 0;
  let pushes = 0;
  let totalUnitsRisked = 0;
  let totalReturn = 0;

  const byMarket: Record<string, { picks: number; wins: number; win_rate: number; roi_pct: number }> = {};

  for (const row of statsRows) {
    const mkt = row.market;
    if (!byMarket[mkt]) byMarket[mkt] = { picks: 0, wins: 0, win_rate: 0, roi_pct: 0 };
    byMarket[mkt].picks++;

    if (row.result === 'win') {
      wins++;
      byMarket[mkt].wins++;
      // Profit in units based on best_line_price; default -110 if null
      const price = row.best_line_price ?? -110;
      const profit = price >= 100 ? price / 100 : 100 / Math.abs(price);
      totalReturn += profit;
    } else if (row.result === 'loss') {
      losses++;
      totalReturn -= 1;
    } else if (row.result === 'push') {
      pushes++;
    }

    if (row.result !== 'pending' && row.result !== 'void') {
      totalUnitsRisked += 1;
    }
  }

  for (const mkt of Object.keys(byMarket)) {
    const m = byMarket[mkt];
    const graded = statsRows.filter((r) => r.market === mkt && (r.result === 'win' || r.result === 'loss')).length;
    m.win_rate = graded > 0 ? m.wins / graded : 0;
    // ROI for this market
    const mktReturn = statsRows
      .filter((r) => r.market === mkt)
      .reduce((sum, r) => {
        if (r.result === 'win') {
          const p = r.best_line_price ?? -110;
          return sum + (p >= 100 ? p / 100 : 100 / Math.abs(p));
        }
        if (r.result === 'loss') return sum - 1;
        return sum;
      }, 0);
    const mktRisked = statsRows.filter((r) => r.market === mkt && r.result !== 'pending' && r.result !== 'void').length;
    m.roi_pct = mktRisked > 0 ? Math.round((mktReturn / mktRisked) * 10000) / 100 : 0;
  }

  const gradedTotal = wins + losses;
  const winRate = gradedTotal > 0 ? wins / gradedTotal : 0;
  const roiPct = totalUnitsRisked > 0
    ? Math.round((totalReturn / totalUnitsRisked) * 10000) / 100
    : 0;

  const shapedPicks = picks.map((p) => ({
    id: p.id,
    pick_date: p.pick_date,
    game: {
      home_team: p.games?.home_team?.name ?? '',
      away_team: p.games?.away_team?.name ?? '',
    },
    market: p.market,
    pick_side: p.pick_side,
    confidence_tier: p.confidence_tier,
    result: p.result,
    best_line_price: p.best_line_price,
  }));

  return NextResponse.json({
    stats: {
      total_picks: count ?? 0,
      wins,
      losses,
      pushes,
      win_rate: Math.round(winRate * 10000) / 10000,
      roi_pct: roiPct,
      by_market: byMarket,
      by_confidence: {},
    },
    picks: shapedPicks,
    pagination: {
      page,
      per_page,
      total: count ?? 0,
      total_pages: Math.ceil((count ?? 0) / per_page),
    },
  });
}
