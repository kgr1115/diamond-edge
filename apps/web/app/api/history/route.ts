import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { unitProfit, unitsRoiPct } from '@/lib/roi/units';

export const dynamic = 'force-dynamic';

const QUERY_SCHEMA = z.object({
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(50),
  market: z.enum(['moneyline', 'run_line', 'total', 'prop', 'parlay', 'future']).optional(),
  result: z.enum(['win', 'loss', 'push', 'void', 'pending']).optional(),
  visibility: z.enum(['live', 'shadow']).optional(),
  confidence_tier: z.coerce.number().int().min(1).max(5).optional(),
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
    confidence_tier: searchParams.get('confidence_tier') ?? undefined,
    date_from: searchParams.get('date_from') ?? undefined,
    date_to: searchParams.get('date_to') ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Invalid query parameters.', details: parsed.error.flatten() } },
      { status: 422 },
    );
  }

  const { page, per_page, market, result, confidence_tier, date_from, date_to } = parsed.data;
  const offset = (page - 1) * per_page;

  const service = createServiceRoleClient();

  let query = service
    .from('picks')
    .select(
      `id, pick_date, market, pick_side, confidence_tier, result, best_line_price,
       generated_at, best_line_book_id,
       games!inner (
         id, status, home_score, away_score,
         home_team:home_team_id ( name ),
         away_team:away_team_id ( name )
       )`,
      { count: 'exact' },
    )
    .order('pick_date', { ascending: false })
    .range(offset, offset + per_page - 1);

  if (market) query = query.eq('market', market);
  if (result) query = query.eq('result', result);
  if (confidence_tier) query = query.eq('confidence_tier', confidence_tier);
  if (date_from) query = query.gte('pick_date', date_from);
  if (date_to) query = query.lte('pick_date', date_to);

  const { data: picksRaw, count, error: dbError } = await query;

  if (dbError) {
    return NextResponse.json({ error: { code: 'DB_ERROR', message: dbError.message } }, { status: 500 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const picks = (picksRaw as any[]) ?? [];

  // Aggregate stats over the filtered result set — pull all (up to 5000) for rollup.
  // Joins games for game_time_utc + selects generated_at so we can compute lead-time
  // bucket per pick (used by the lead-time grid below).
  let statsQuery = service
    .from('picks')
    .select(`
      result, best_line_price, market, confidence_tier, generated_at,
      games!inner ( game_time_utc )
    `);

  if (market) statsQuery = statsQuery.eq('market', market);
  if (result) statsQuery = statsQuery.eq('result', result);
  if (confidence_tier) statsQuery = statsQuery.eq('confidence_tier', confidence_tier);
  if (date_from) statsQuery = statsQuery.gte('pick_date', date_from);
  if (date_to) statsQuery = statsQuery.lte('pick_date', date_to);

  statsQuery = statsQuery.limit(5000);

  const { data: allForStats } = await statsQuery;
  const statsRows = (allForStats ?? []) as Array<{
    result: string;
    best_line_price: number | null;
    market: string;
    confidence_tier: number | null;
    generated_at: string | null;
    games: { game_time_utc: string | null } | null;
  }>;

  // unitProfit + unitsRoiPct live in lib/roi/units.ts so /api/bankroll computes
  // ROI identically. Local breakdowns below still use unitProfit directly because
  // they slice by market / confidence / lead-time.

  let wins = 0;
  let losses = 0;
  let pushes = 0;

  const byMarket: Record<string, { picks: number; wins: number; win_rate: number; roi_pct: number }> = {};

  for (const row of statsRows) {
    const mkt = row.market;
    if (!byMarket[mkt]) byMarket[mkt] = { picks: 0, wins: 0, win_rate: 0, roi_pct: 0 };
    byMarket[mkt].picks++;

    if (row.result === 'win') {
      wins++;
      byMarket[mkt].wins++;
    } else if (row.result === 'loss') {
      losses++;
    } else if (row.result === 'push') {
      pushes++;
    }
  }

  for (const mkt of Object.keys(byMarket)) {
    const m = byMarket[mkt];
    const graded = statsRows.filter((r) => r.market === mkt && (r.result === 'win' || r.result === 'loss')).length;
    m.win_rate = graded > 0 ? m.wins / graded : 0;
    const mktReturn = statsRows
      .filter((r) => r.market === mkt)
      .reduce((sum, r) => {
        if (r.result === 'win') return sum + unitProfit(r.best_line_price);
        if (r.result === 'loss') return sum - 1;
        return sum;
      }, 0);
    const mktRisked = statsRows.filter((r) => r.market === mkt && r.result !== 'pending' && r.result !== 'void').length;
    m.roi_pct = mktRisked > 0 ? Math.round((mktReturn / mktRisked) * 10000) / 100 : 0;
  }

  const byConfidence: Record<string, { picks: number; wins: number; losses: number; pushes: number; win_rate: number; roi_pct: number }> = {};
  for (const row of statsRows) {
    if (row.confidence_tier == null) continue;
    const key = String(row.confidence_tier);
    if (!byConfidence[key]) byConfidence[key] = { picks: 0, wins: 0, losses: 0, pushes: 0, win_rate: 0, roi_pct: 0 };
    byConfidence[key].picks++;
    if (row.result === 'win') byConfidence[key].wins++;
    else if (row.result === 'loss') byConfidence[key].losses++;
    else if (row.result === 'push') byConfidence[key].pushes++;
  }
  for (const tier of Object.keys(byConfidence)) {
    const c = byConfidence[tier];
    const graded = c.wins + c.losses;
    c.win_rate = graded > 0 ? c.wins / graded : 0;
    const tierRows = statsRows.filter((r) => String(r.confidence_tier) === tier);
    const tierReturn = tierRows.reduce((sum, r) => {
      if (r.result === 'win') return sum + unitProfit(r.best_line_price);
      if (r.result === 'loss') return sum - 1;
      return sum;
    }, 0);
    const tierRisked = tierRows.filter((r) => r.result !== 'pending' && r.result !== 'void').length;
    c.roi_pct = tierRisked > 0 ? Math.round((tierReturn / tierRisked) * 10000) / 100 : 0;
  }

  // -----------------------------------------------------------------------
  // Lead-time grid breakdown
  // -----------------------------------------------------------------------
  // Buckets per pick-researcher 2026-04-27 audit:
  //   same_day  :  0–6h   (lineups confirmed)
  //   next_day  :  6–30h  (probable starter known, lineups not confirmed)
  //   multi_day : 30h+    (feature coverage degraded)
  // Picks with negative lead time (generated_at > game_time_utc — happens when
  // the pipeline ran post-first-pitch) are excluded entirely.

  const LEAD_TIME_BUCKETS = ['same_day', 'next_day', 'multi_day'] as const;
  type LeadTimeBucket = typeof LEAD_TIME_BUCKETS[number];
  const SAMPLE_MIN = 30;
  const MARKETS = ['moneyline', 'run_line', 'total'] as const;

  function classifyBucket(leadHours: number): LeadTimeBucket | null {
    if (!Number.isFinite(leadHours) || leadHours < 0) return null;
    if (leadHours < 6) return 'same_day';
    if (leadHours < 30) return 'next_day';
    return 'multi_day';
  }

  interface LeadTimeCell {
    picks: number;
    wins: number;
    losses: number;
    pushes: number;
    /** Win rate (0..1). Only meaningful when has_min_sample is true. */
    win_rate: number;
    /** ROI percent. Only meaningful when has_min_sample is true. */
    roi_pct: number;
    /** True when picks >= SAMPLE_MIN — controls whether UI displays metrics. */
    has_min_sample: boolean;
    /** Graded count = wins + losses (denominator for win_rate). */
    graded: number;
  }

  const byLeadTime: Record<LeadTimeBucket, Record<string, LeadTimeCell>> = {
    same_day:  Object.fromEntries(MARKETS.map((m) => [m, emptyCell()])) as Record<string, LeadTimeCell>,
    next_day:  Object.fromEntries(MARKETS.map((m) => [m, emptyCell()])) as Record<string, LeadTimeCell>,
    multi_day: Object.fromEntries(MARKETS.map((m) => [m, emptyCell()])) as Record<string, LeadTimeCell>,
  };

  function emptyCell(): LeadTimeCell {
    return { picks: 0, wins: 0, losses: 0, pushes: 0, win_rate: 0, roi_pct: 0, has_min_sample: false, graded: 0 };
  }

  let leadTimeExcluded = 0;
  for (const row of statsRows) {
    if (!row.generated_at || !row.games?.game_time_utc) {
      leadTimeExcluded++;
      continue;
    }
    const leadMs = new Date(row.games.game_time_utc).getTime() - new Date(row.generated_at).getTime();
    const bucket = classifyBucket(leadMs / 3_600_000);
    if (bucket === null) {
      leadTimeExcluded++;
      continue;
    }
    if (!byLeadTime[bucket][row.market]) continue;

    const cell = byLeadTime[bucket][row.market];
    cell.picks++;
    if (row.result === 'win') cell.wins++;
    else if (row.result === 'loss') cell.losses++;
    else if (row.result === 'push') cell.pushes++;
  }

  for (const bucket of LEAD_TIME_BUCKETS) {
    for (const mkt of MARKETS) {
      const cell = byLeadTime[bucket][mkt];
      cell.graded = cell.wins + cell.losses;
      cell.has_min_sample = cell.picks >= SAMPLE_MIN;
      if (!cell.has_min_sample) continue;

      cell.win_rate = cell.graded > 0 ? cell.wins / cell.graded : 0;

      const cellRows = statsRows.filter((r) => {
        if (r.market !== mkt) return false;
        if (!r.generated_at || !r.games?.game_time_utc) return false;
        const lead = (new Date(r.games.game_time_utc).getTime() - new Date(r.generated_at).getTime()) / 3_600_000;
        return classifyBucket(lead) === bucket;
      });
      const cellReturn = cellRows.reduce((sum, r) => {
        if (r.result === 'win') return sum + unitProfit(r.best_line_price);
        if (r.result === 'loss') return sum - 1;
        return sum;
      }, 0);
      const cellRisked = cellRows.filter((r) => r.result !== 'pending' && r.result !== 'void').length;
      cell.roi_pct = cellRisked > 0 ? Math.round((cellReturn / cellRisked) * 10000) / 100 : 0;
    }
  }

  const gradedTotal = wins + losses;
  const winRate = gradedTotal > 0 ? wins / gradedTotal : 0;
  const roiPct = unitsRoiPct(
    statsRows.map((r) => ({ outcome: r.result, price: r.best_line_price })),
  );

  // Per-pick line lookup (total_line for totals, run_line_spread for run-line picks).
  // Mirrors the per-pick odds-pinning logic in lib/picks/load-slate.ts: match the
  // pick's best_line_book_id + newest snapshot at-or-before generated_at, falling
  // back to most-recent-pre-pick row of any book, then to most-recent overall.
  const lineByPickId = new Map<string, { total_line: number | null; run_line_spread: number | null }>();
  if (picks.length > 0) {
    const gameIds = [...new Set(picks.map((p) => p.games?.id).filter(Boolean))] as string[];
    if (gameIds.length > 0) {
      const { data: oddsRows } = await service
        .from('odds')
        .select('game_id, sportsbook_id, market, total_line, run_line_spread, snapshotted_at')
        .in('game_id', gameIds)
        .in('market', ['total', 'run_line'])
        .order('snapshotted_at', { ascending: false });
      type OddsRow = {
        game_id: string;
        sportsbook_id: string | null;
        market: string;
        total_line: number | null;
        run_line_spread: number | null;
        snapshotted_at: string;
      };
      const byGM = new Map<string, OddsRow[]>();
      for (const r of (oddsRows ?? []) as OddsRow[]) {
        const k = `${r.game_id}:${r.market}`;
        if (!byGM.has(k)) byGM.set(k, []);
        byGM.get(k)!.push(r);
      }
      for (const p of picks) {
        const gid = p.games?.id;
        if (!gid) continue;
        if (p.market !== 'total' && p.market !== 'run_line') continue;
        const bucket = byGM.get(`${gid}:${p.market}`) ?? [];
        if (bucket.length === 0) continue;

        const generatedMs = p.generated_at ? new Date(p.generated_at).getTime() : NaN;
        const cutoff = Number.isFinite(generatedMs) ? generatedMs + 5 * 60_000 : Infinity;
        const eligible = (r: OddsRow) => new Date(r.snapshotted_at).getTime() <= cutoff;
        const sameBook = p.best_line_book_id
          ? bucket.find((r) => r.sportsbook_id === p.best_line_book_id && eligible(r))
          : undefined;
        const matched = sameBook ?? bucket.find(eligible) ?? bucket[0];
        lineByPickId.set(p.id, {
          total_line: matched.total_line,
          run_line_spread: matched.run_line_spread,
        });
      }
    }
  }

  const shapedPicks = picks.map((p) => {
    const home = p.games?.home_score;
    const away = p.games?.away_score;
    const final =
      typeof home === 'number' && typeof away === 'number'
        ? { home, away, total: home + away, runline: home - away }
        : null;
    const line = lineByPickId.get(p.id);
    let runLineSpread: number | null = null;
    if (p.market === 'run_line' && line && line.run_line_spread !== null) {
      // odds.run_line_spread is stored from home's perspective; flip for away
      // picks so the displayed value matches the side the pick actually took.
      runLineSpread = p.pick_side === 'away' ? -line.run_line_spread : line.run_line_spread;
    }
    return {
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
      final_score: final,
      total_line: p.market === 'total' ? line?.total_line ?? null : null,
      run_line_spread: runLineSpread,
    };
  });

  return NextResponse.json({
    stats: {
      total_picks: count ?? 0,
      wins,
      losses,
      pushes,
      win_rate: Math.round(winRate * 10000) / 10000,
      roi_pct: roiPct,
      by_market: byMarket,
      by_confidence: byConfidence,
      by_lead_time: byLeadTime,
      lead_time_meta: {
        sample_min: SAMPLE_MIN,
        excluded_no_lead_time: leadTimeExcluded,
        bucket_definitions: {
          same_day: '0–6h before first pitch (lineups confirmed)',
          next_day: '6–30h (probable starter known)',
          multi_day: '30h+ (feature coverage degraded)',
        },
      },
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
