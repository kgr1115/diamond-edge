import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { startCronRun, finishCronRun } from '@/lib/ops/cron-run-log';

export const runtime = 'nodejs';
export const maxDuration = 10; // This route returns immediately — the heavy work is in the Edge Function

/**
 * Vercel Cron handler: GET /api/cron/pick-pipeline
 * Scheduled: daily at 16:00 UTC (12:00 PM ET / 11:00 AM EST). Fires after schedule-sync (14:00 UTC) and stats-sync (14:30 UTC).
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

  const runHandle = await startCronRun('pick-pipeline');
  const startMs = Date.now();
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  console.info(JSON.stringify({ event: 'pick_pipeline_trigger', date: today }));

  let supabase;
  try {
    supabase = createServiceRoleClient();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ event: 'pick_pipeline_client_init_failed', error: msg, date: today }));
    await finishCronRun(runHandle, { status: 'failure', errorMsg: `client init: ${msg}` });
    // Misconfigured service-role key — this IS a hard config error, not a partial failure
    return NextResponse.json(
      { error: { code: 'CONFIG_ERROR', message: 'Supabase client init failed.' } },
      { status: 500 },
    );
  }

  // Invoke the Edge Function asynchronously. We do NOT await completion here —
  // the Edge Function runs independently and will log its own completion/failure.
  // The invoke call itself should complete in < 2 seconds (fire-and-forget pattern).
  let invokeError: { message: string } | null = null;
  try {
    const invokeResult = await supabase.functions.invoke('pick-pipeline', { method: 'POST' });
    invokeError = invokeResult.error ?? null;
  } catch (err) {
    invokeError = { message: err instanceof Error ? err.message : String(err) };
  }

  if (invokeError) {
    console.error(JSON.stringify({
      event: 'pick_pipeline_invoke_failed',
      date: today,
      error: invokeError.message,
      duration_ms: Date.now() - startMs,
    }));
    await finishCronRun(runHandle, { status: 'failure', errorMsg: invokeError.message });
    // 207 instead of 500: the trigger route itself is functional; the edge fn invocation failed.
    // Vercel Cron will NOT retry on 207, which is correct — a retry storm would compound the issue.
    return NextResponse.json(
      {
        triggered: false,
        date: today,
        pipeline: { ok: false, errors: [invokeError.message] },
        duration_ms: Date.now() - startMs,
      },
      { status: 207 },
    );
  }

  console.info(JSON.stringify({
    event: 'pick_pipeline_invoked',
    date: today,
    duration_ms: Date.now() - startMs,
  }));

  await finishCronRun(runHandle, { status: 'success', errorMsg: null });
  return NextResponse.json({ triggered: true, date: today, pipeline: { ok: true, errors: [] } }, { status: 200 });
}
