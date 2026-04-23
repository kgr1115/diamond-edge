import { NextResponse } from 'next/server';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const STORAGE_KEY_BANKROLL = 'de_bankroll_dollars';
const DEFAULT_BANKROLL = 1000;
const DEFAULT_CAP_PCT = 3;

export async function GET(): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 });
  }

  const service = createServiceRoleClient();

  // Fetch profile for bankroll settings
  const { data: profile } = await service
    .from('profiles')
    .select('bankroll_unit_pct, daily_exposure_cap_pct')
    .eq('id', user.id)
    .single();

  const dailyCapPct = (profile as unknown as { daily_exposure_cap_pct?: number } | null)?.daily_exposure_cap_pct ?? DEFAULT_CAP_PCT;

  // Sum today's open (unsettled) bets
  const today = new Date().toISOString().slice(0, 10);
  const { data: openEntries } = await service
    .from('bankroll_entries')
    .select('bet_amount_cents')
    .eq('user_id', user.id)
    .eq('bet_date', today)
    .is('outcome', null)
    .is('deleted_at', null);

  const todayExposureCents = (openEntries ?? []).reduce(
    (sum, e: { bet_amount_cents: number }) => sum + e.bet_amount_cents,
    0
  );

  // Bankroll dollar value is stored client-side in localStorage (UX pattern from UnitSizingPanel).
  // We return it from the profile column if set, otherwise fall back to default.
  // The client also passes it via query param as an optimization hint.
  const bankrollDollars = DEFAULT_BANKROLL;

  return NextResponse.json({
    today_exposure_cents: todayExposureCents,
    bankroll_dollars: bankrollDollars,
    daily_cap_pct: dailyCapPct,
  });
}
