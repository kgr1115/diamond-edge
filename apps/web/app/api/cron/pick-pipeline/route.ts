import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const maxDuration = 10; // This route returns immediately — the heavy work is in the Edge Function

/**
 * Vercel Cron handler: GET /api/cron/pick-pipeline
 * Scheduled: daily at 9:00 AM ET (after morning lines settle).
 *
 * This route is a thin trigger: it calls supabase.functions.invoke('pick-pipeline')
 * and returns immediately. The Supabase Edge Function does the heavy work asynchronously.
 *
 * Security: CRON_SECRET header required (Vercel Cron sets Authorization: Bearer <CRON_SECRET>).
 *
 * Per pick-pipeline-failure.md runbook: this route logs 'pick_pipeline_trigger' on fire.
 * If the Edge Function invocation itself fails (network, cold start timeout), that is logged
 * here and the runbook's on-call steps apply.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    console.warn(JSON.stringify({ event: 'cron_unauthorized', path: '/api/cron/pick-pipeline' }));
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Unauthorized.' } },
      { status: 401 }
    );
  }

  const startMs = Date.now();
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  console.info(JSON.stringify({ event: 'pick_pipeline_trigger', date: today }));

  const supabase = createServiceRoleClient();

  // Invoke the Edge Function asynchronously. We do NOT await completion here —
  // the Edge Function runs independently and will log its own completion/failure.
  // The invoke call itself should complete in < 2 seconds (fire-and-forget pattern).
  const { error: invokeError } = await supabase.functions.invoke('pick-pipeline', {
    method: 'POST',
  });

  if (invokeError) {
    console.error(JSON.stringify({
      event: 'pick_pipeline_invoke_failed',
      date: today,
      error: invokeError.message,
      duration_ms: Date.now() - startMs,
    }));
    return NextResponse.json(
      { error: { code: 'INVOCATION_FAILED', message: 'Pick pipeline invocation failed.' } },
      { status: 500 }
    );
  }

  console.info(JSON.stringify({
    event: 'pick_pipeline_invoked',
    date: today,
    duration_ms: Date.now() - startMs,
  }));

  return NextResponse.json({ triggered: true, date: today }, { status: 200 });
}
