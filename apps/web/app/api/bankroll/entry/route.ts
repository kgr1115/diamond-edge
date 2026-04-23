import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const BODY_SCHEMA = z.object({
  bet_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().max(500).optional(),
  market: z.enum(['moneyline', 'run_line', 'total', 'prop', 'parlay', 'future']).optional(),
  sportsbook_id: z.string().uuid().optional(),
  bet_amount_cents: z.number().int().positive(),
  odds_price: z.number().int(),
  pick_id: z.string().uuid().optional(),
  notes: z.string().max(1000).optional(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Login required.' } }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: { code: 'BAD_REQUEST', message: 'Invalid JSON.' } }, { status: 400 });
  }

  const parsed = BODY_SCHEMA.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Invalid input.', details: parsed.error.flatten() } },
      { status: 422 },
    );
  }

  const { bet_date, description, market, sportsbook_id, bet_amount_cents, odds_price, pick_id, notes } = parsed.data;

  const service = createServiceRoleClient();
  const { data, error } = await service
    .from('bankroll_entries')
    .insert({
      user_id: user.id,
      bet_date,
      description: description ?? null,
      market: market ?? null,
      sportsbook_id: sportsbook_id ?? null,
      bet_amount_cents,
      odds_price,
      pick_id: pick_id ?? null,
      notes: notes ?? null,
    })
    .select('id')
    .single();

  if (error) {
    return NextResponse.json({ error: { code: 'DB_ERROR', message: error.message } }, { status: 500 });
  }

  return NextResponse.json({ entry: { id: data.id } }, { status: 201 });
}
