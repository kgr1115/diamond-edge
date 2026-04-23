import { NextRequest, NextResponse } from 'next/server';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { pickClvFrom } from '@/lib/types/pick-clv';
import type { PickClvWithPick, PickClvWithPickRaw } from '@/lib/types/pick-clv';

export const dynamic = 'force-dynamic';

/**
 * GET /api/stats/clv-summary
 * Elite-gated. Returns aggregated CLV data for the dashboard.
 *
 * pick_clv schema (migration 0011):
 *   pick_id, pick_time_novig_prob, closing_novig_prob, clv_edge, computed_at
 *
 * clv_edge = closing_novig_prob - pick_time_novig_prob
 * Positive = market moved toward our pick after generation time (sharp signal).
 */

type ClvRow = PickClvWithPick;

interface MarketClvSummary {
  market: string;
  count: number;
  mean_clv_edge: number;
  positive_count: number;
  positive_rate: number;
}

interface ClvTimePoint {
  date: string;
  pick_id: string;
  market: string;
  clv_edge: number;
}

export async function GET(_request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Login required.' } }, { status: 401 });
  }

  // Tier check — Elite only
  const { data: profile } = await supabase
    .from('profiles')
    .select('subscription_tier')
    .eq('id', user.id)
    .single();

  if (profile?.subscription_tier !== 'elite') {
    return NextResponse.json(
      { error: { code: 'FORBIDDEN', message: 'CLV analytics require an Elite subscription.' } },
      { status: 403 },
    );
  }

  const service = createServiceRoleClient();

  const { data: rawClv, error } = await pickClvFrom(service)
    .select('pick_id, pick_time_novig_prob, closing_novig_prob, clv_edge, computed_at, picks ( pick_date, market )')
    .not('clv_edge', 'is', null)
    .order('computed_at', { ascending: false })
    .limit(500);

  if (error) {
    return NextResponse.json({ error: { code: 'DB_ERROR', message: error.message } }, { status: 500 });
  }

  // Normalise: PostgREST returns joined picks as an array; unwrap to single object.
  const clvRows: ClvRow[] = ((rawClv ?? []) as unknown as PickClvWithPickRaw[]).map((r) => ({
    ...r,
    picks: r.picks?.[0] ?? null,
  }));

  // Aggregate by market
  const byMarket: Record<string, { count: number; sum: number; positive: number }> = {};
  const timePoints: ClvTimePoint[] = [];

  for (const row of clvRows) {
    if (row.clv_edge === null) continue;
    const mkt = row.picks?.market ?? 'unknown';

    if (!byMarket[mkt]) byMarket[mkt] = { count: 0, sum: 0, positive: 0 };
    byMarket[mkt].count++;
    byMarket[mkt].sum += row.clv_edge;
    if (row.clv_edge > 0) byMarket[mkt].positive++;

    if (row.picks?.pick_date) {
      timePoints.push({
        date: row.picks.pick_date,
        pick_id: row.pick_id,
        market: mkt,
        clv_edge: Math.round(row.clv_edge * 10000) / 10000,
      });
    }
  }

  const marketSummaries: MarketClvSummary[] = Object.entries(byMarket).map(([market, stats]) => ({
    market,
    count: stats.count,
    mean_clv_edge: Math.round((stats.sum / stats.count) * 10000) / 10000,
    positive_count: stats.positive,
    positive_rate: Math.round((stats.positive / stats.count) * 10000) / 10000,
  }));

  // Overall mean
  const allEdges = clvRows.map((r) => r.clv_edge).filter((v): v is number => v !== null);
  const overallMean = allEdges.length > 0
    ? Math.round((allEdges.reduce((a, b) => a + b, 0) / allEdges.length) * 10000) / 10000
    : null;

  // Sort time points ascending for chart rendering
  timePoints.sort((a, b) => a.date.localeCompare(b.date));

  return NextResponse.json({
    overall_mean_clv: overallMean,
    total_picks: clvRows.length,
    by_market: marketSummaries,
    time_series: timePoints,
  });
}
