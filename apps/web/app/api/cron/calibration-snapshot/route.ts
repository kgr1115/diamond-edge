import { NextRequest, NextResponse } from 'next/server';
import {
  runCalibrationSnapshot,
  type CalibrationSnapshotResult,
} from '@/lib/calibration/snapshot';
import { startCronRun, finishCronRun } from '@/lib/ops/cron-run-log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Vercel Cron handler: GET /api/cron/calibration-snapshot
 * Scheduled: 6am ET daily (10:00 UTC) — one hour after clv-compute (09:00)
 * and two hours after outcome-grader (08:00) so settlements and CLV writes
 * are stable before the per-tier calibration cells are computed.
 *
 * Writes one row per (snapshot_date, market, confidence_tier) into
 * `calibration_history` (migration 0020). Service-role-only writes; no RLS
 * policy on the table.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'cron_unauthorized',
        path: '/api/cron/calibration-snapshot',
      }),
    );
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Unauthorized.' } },
      { status: 401 },
    );
  }

  const runHandle = await startCronRun('calibration-snapshot');
  console.info(
    JSON.stringify({
      level: 'info',
      event: 'cron_calibration_snapshot_start',
      time: new Date().toISOString(),
    }),
  );

  let body: CalibrationSnapshotResult;
  try {
    body = await runCalibrationSnapshot();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'cron_calibration_snapshot_threw',
        error: msg,
      }),
    );
    await finishCronRun(runHandle, { status: 'failure', errorMsg: msg });
    return NextResponse.json(
      {
        snapshotDate: new Date().toISOString().slice(0, 10),
        cellsWritten: 0,
        cellsSparse: 0,
        cellsEmpty: 0,
        totalPicks: 0,
        totalGraded: 0,
        errors: [msg],
        durationMs: 0,
      },
      { status: 500 },
    );
  }

  const hadErrors = body.errors.length > 0;

  console.info(
    JSON.stringify({
      level: hadErrors ? 'warn' : 'info',
      event: 'cron_calibration_snapshot_complete',
      snapshot_date: body.snapshotDate,
      cells_written: body.cellsWritten,
      cells_sparse: body.cellsSparse,
      cells_empty: body.cellsEmpty,
      total_picks: body.totalPicks,
      total_graded: body.totalGraded,
      errors: body.errors,
      durationMs: body.durationMs,
    }),
  );

  await finishCronRun(runHandle, {
    status: hadErrors ? 'failure' : 'success',
    errorMsg: hadErrors ? body.errors.join(' | ') : null,
  });

  return NextResponse.json(body, { status: hadErrors ? 207 : 200 });
}

export const POST = GET;
