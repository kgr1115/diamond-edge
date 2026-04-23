import { NextRequest, NextResponse } from 'next/server';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function DELETE(_request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { id } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Login required.' } }, { status: 401 });
  }

  const service = createServiceRoleClient();

  // Soft delete — only own entries
  const { error } = await service
    .from('bankroll_entries')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', user.id)
    .is('deleted_at', null);

  if (error) {
    return NextResponse.json({ error: { code: 'DB_ERROR', message: error.message } }, { status: 500 });
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}

export async function PATCH(request: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { id } = await params;

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

  // Only allow settling outcome + profit/loss
  const { outcome, profit_loss_cents } = body as Record<string, unknown>;
  const allowed = ['win', 'loss', 'push', 'void'];
  if (typeof outcome !== 'string' || !allowed.includes(outcome)) {
    return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: 'outcome must be win|loss|push|void.' } }, { status: 422 });
  }

  const service = createServiceRoleClient();
  const { error } = await service
    .from('bankroll_entries')
    .update({
      outcome: outcome as 'win' | 'loss' | 'push' | 'void',
      profit_loss_cents: typeof profit_loss_cents === 'number' ? profit_loss_cents : null,
      settled_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('user_id', user.id)
    .is('deleted_at', null);

  if (error) {
    return NextResponse.json({ error: { code: 'DB_ERROR', message: error.message } }, { status: 500 });
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
