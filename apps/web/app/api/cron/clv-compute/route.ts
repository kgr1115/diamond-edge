import { NextRequest, NextResponse } from 'next/server';
import { runClvCompute, type ClvComputeResult } from '@/lib/clv/compute';
import { startCronRun, finishCronRun } from '@/lib/ops/cron-run-log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Vercel Cron handler: GET /api/cron/clv-compute
 * Scheduled: 5am ET daily (09:00 UTC) — one hour after outcome-grader so
 * grading has settled and closing snapshots are stable.
 *
 * Writes one row per pick to `pick_clv` (service-role-only RLS). Picks
 * already in `pick_clv` are upserted on `pick_id` so re-runs are idempotent.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    console.warn(
      JSON.stringify({ level: 'warn', event: 'cron_unauthorized', path: '/api/cron/clv-compute' })
    );
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Unauthorized.' } },
      { status: 401 }
    );
  }

  const runHandle = await startCronRun('clv-compute');
  console.info(
    JSON.stringify({ level: 'info', event: 'cron_clv_compute_start', time: new Date().toISOString() })
  );

  let body: ClvComputeResult;
  try {
    body = await runClvCompute();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ level: 'error', event: 'cron_clv_compute_threw', error: msg }));
    await finishCronRun(runHandle, { status: 'failure', errorMsg: msg });
    return NextResponse.json(
      {
        considered: 0, written: 0, skippedNoImplied: 0, skippedVoidGame: 0,
        noClosingSnapshot: 0, errors: [msg], durationMs: 0,
      },
      { status: 500 },
    );
  }

  const hadErrors = body.errors.length > 0;

  console.info(JSON.stringify({
    level: hadErrors ? 'warn' : 'info',
    event: 'cron_clv_compute_complete',
    considered: body.considered,
    written: body.written,
    skipped_no_implied: body.skippedNoImplied,
    skipped_void_game: body.skippedVoidGame,
    no_closing_snapshot: body.noClosingSnapshot,
    errors: body.errors,
    durationMs: body.durationMs,
  }));

  await finishCronRun(runHandle, {
    status: hadErrors ? 'failure' : 'success',
    errorMsg: hadErrors ? body.errors.join(' | ') : null,
  });

  return NextResponse.json(body, { status: hadErrors ? 207 : 200 });
}

export const POST = GET;
