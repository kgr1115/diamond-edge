import { NextRequest, NextResponse } from 'next/server';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { unitsRoiPct } from '@/lib/roi/units';

export const dynamic = 'force-dynamic';

interface BankrollSummary {
  total_wagered_cents: number;
  total_profit_loss_cents: number;
  roi_pct: number;
  win_count: number;
  loss_count: number;
  push_count: number;
  void_count: number;
  pending_count: number;
  win_rate: number;
  units_won_7d: number;
  units_won_30d: number;
  units_won_all: number;
  dollars_won_7d: number;
  dollars_won_30d: number;
  dollars_won_all: number;
  open_exposure_cents: number;
}

interface BankrollEntry {
  id: string;
  bet_date: string;
  description: string | null;
  market: string | null;
  sportsbook: string | null;
  bet_amount_cents: number;
  odds_price: number;
  outcome: string | null;
  profit_loss_cents: number | null;
  settled_at: string | null;
  pick_id: string | null;
  notes: string | null;
}

interface CumulativePoint {
  date: string;
  cumulative_units: number;
}

/** Derive profit/loss from American odds. Returns profit in cents for a win. */
function computeProfitCents(amountCents: number, oddsPrice: number): number {
  if (oddsPrice >= 100) return Math.round(amountCents * (oddsPrice / 100));
  return Math.round(amountCents * (100 / Math.abs(oddsPrice)));
}

interface BankrollEntryRaw {
  id: string;
  bet_date: string;
  description: string | null;
  market: string | null;
  sportsbook_id: string | null;
  bet_amount_cents: number;
  odds_price: number;
  outcome: string | null;
  profit_loss_cents: number | null;
  settled_at: string | null;
  pick_id: string | null;
  notes: string | null;
  deleted_at: string | null;
  sportsbooks: { name: string } | null;
}

export async function GET(): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Login required.' } }, { status: 401 });
  }

  const service = createServiceRoleClient();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rawData, error } = await (service as any)
    .from('bankroll_entries')
    .select('id, bet_date, description, market, sportsbook_id, bet_amount_cents, odds_price, outcome, profit_loss_cents, settled_at, pick_id, notes, deleted_at, sportsbooks:sportsbook_id ( name )')
    .eq('user_id', user.id)
    .is('deleted_at', null)
    .order('bet_date', { ascending: false });

  if (error) {
    return NextResponse.json({ error: { code: 'DB_ERROR', message: error.message } }, { status: 500 });
  }

  const entries = (rawData ?? []) as BankrollEntryRaw[];

  const now = new Date();
  const cutoff7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const cutoff30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  let totalWageredCents = 0;
  let totalPLCents = 0;
  let winCount = 0;
  let lossCount = 0;
  let pushCount = 0;
  let voidCount = 0;
  let pendingCount = 0;
  let openExposureCents = 0;

  let plCents7d = 0;
  let plCents30d = 0;
  let wagered7d = 0;
  let wagered30d = 0;

  for (const e of entries) {
    totalWageredCents += e.bet_amount_cents;

    if (!e.outcome) {
      pendingCount++;
      openExposureCents += e.bet_amount_cents;
      continue;
    }

    const pl = e.profit_loss_cents ?? 0;
    totalPLCents += pl;

    if (e.outcome === 'win') winCount++;
    else if (e.outcome === 'loss') lossCount++;
    else if (e.outcome === 'push') pushCount++;
    else if (e.outcome === 'void') voidCount++;

    if (e.bet_date >= cutoff7d) {
      plCents7d += pl;
      wagered7d += e.bet_amount_cents;
    }
    if (e.bet_date >= cutoff30d) {
      plCents30d += pl;
      wagered30d += e.bet_amount_cents;
    }
  }

  const gradedCount = winCount + lossCount;
  const winRate = gradedCount > 0 ? winCount / gradedCount : 0;

  // ROI must match /api/history exactly — both surfaces label the number "ROI"
  // and divergence between them is a credibility break. Units-based formula
  // (1 unit = 1 bet, win profit from American odds, loss = -1u) lives in
  // lib/roi/units.ts. Dollar totals below remain dollar-weighted because
  // they're wager totals, not return rates.
  const roiPct = unitsRoiPct(
    entries
      .filter((e) => e.outcome === 'win' || e.outcome === 'loss')
      .map((e) => ({ outcome: e.outcome, price: e.odds_price })),
  );

  const summary: BankrollSummary = {
    total_wagered_cents: totalWageredCents,
    total_profit_loss_cents: totalPLCents,
    roi_pct: roiPct,
    win_count: winCount,
    loss_count: lossCount,
    push_count: pushCount,
    void_count: voidCount,
    pending_count: pendingCount,
    win_rate: Math.round(winRate * 10000) / 10000,
    units_won_7d: Math.round((plCents7d / 100) * 100) / 100,
    units_won_30d: Math.round((plCents30d / 100) * 100) / 100,
    units_won_all: Math.round((totalPLCents / 100) * 100) / 100,
    dollars_won_7d: plCents7d,
    dollars_won_30d: plCents30d,
    dollars_won_all: totalPLCents,
    open_exposure_cents: openExposureCents,
  };

  // Build cumulative unit series for drawdown chart — sorted ascending by date
  const settled = entries
    .filter((e) => e.outcome && e.profit_loss_cents !== null)
    .sort((a, b) => a.bet_date.localeCompare(b.bet_date));

  const cumulativeSeries: CumulativePoint[] = [];
  let running = 0;
  for (const e of settled) {
    running += (e.profit_loss_cents ?? 0) / 100;
    cumulativeSeries.push({ date: e.bet_date, cumulative_units: Math.round(running * 100) / 100 });
  }

  const mappedEntries: BankrollEntry[] = entries.map((e) => ({
    id: e.id,
    bet_date: e.bet_date,
    description: e.description,
    market: e.market,
    sportsbook: e.sportsbooks?.name ?? null,
    bet_amount_cents: e.bet_amount_cents,
    odds_price: e.odds_price,
    outcome: e.outcome,
    profit_loss_cents: e.profit_loss_cents,
    settled_at: e.settled_at,
    pick_id: e.pick_id,
    notes: e.notes,
  }));

  return NextResponse.json({ summary, entries: mappedEntries, cumulative_series: cumulativeSeries }, { status: 200 });
}
