import { NextRequest, NextResponse } from 'next/server';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

interface BankrollSettings {
  bankroll_unit_pct: number;
  daily_exposure_cap_pct: number;
  kelly_fraction: number;
}

export async function GET(): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 });
  }

  const service = createServiceRoleClient();
  const { data, error } = await service
    .from('profiles')
    .select('bankroll_unit_pct, daily_exposure_cap_pct, kelly_fraction')
    .eq('id', user.id)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: { code: 'DB_ERROR', message: error?.message } }, { status: 500 });
  }

  const profile = data as unknown as {
    bankroll_unit_pct: number | null;
    daily_exposure_cap_pct: number | null;
    kelly_fraction: number | null;
  };

  const settings: BankrollSettings = {
    bankroll_unit_pct: profile.bankroll_unit_pct ?? 1.0,
    daily_exposure_cap_pct: profile.daily_exposure_cap_pct ?? 3.0,
    kelly_fraction: profile.kelly_fraction ?? 0.25,
  };

  return NextResponse.json(settings);
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 });
  }

  let body: Partial<BankrollSettings>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON.' } }, { status: 400 });
  }

  const patch: Partial<BankrollSettings> = {};

  if (body.bankroll_unit_pct !== undefined) {
    const v = Number(body.bankroll_unit_pct);
    if (isNaN(v) || v < 0.1 || v > 25) {
      return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: 'bankroll_unit_pct must be 0.1–25.' } }, { status: 422 });
    }
    patch.bankroll_unit_pct = Math.round(v * 100) / 100;
  }

  if (body.daily_exposure_cap_pct !== undefined) {
    const v = Number(body.daily_exposure_cap_pct);
    if (isNaN(v) || v < 0.5 || v > 20) {
      return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: 'daily_exposure_cap_pct must be 0.5–20.' } }, { status: 422 });
    }
    patch.daily_exposure_cap_pct = Math.round(v * 100) / 100;
  }

  if (body.kelly_fraction !== undefined) {
    const v = Number(body.kelly_fraction);
    if (isNaN(v) || v < 0.1 || v > 1.0) {
      return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: 'kelly_fraction must be 0.1–1.0.' } }, { status: 422 });
    }
    patch.kelly_fraction = Math.round(v * 100) / 100;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ ok: true });
  }

  const service = createServiceRoleClient();
  const { error } = await service
    .from('profiles')
    .update(patch)
    .eq('id', user.id);

  if (error) {
    return NextResponse.json({ error: { code: 'DB_ERROR', message: error.message } }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
