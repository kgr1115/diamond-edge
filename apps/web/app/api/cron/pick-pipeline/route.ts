import { NextRequest, NextResponse } from 'next/server';
import { startCronRun, finishCronRun } from '@/lib/ops/cron-run-log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Vercel Cron handler: GET /api/cron/pick-pipeline
 * Scheduled: 12pm ET daily (16:00 UTC).
 *
 * STUB. The v0 model artifact + analysis layer were wiped on 2026-04-30 and
 * have not yet shipped, so there is no pick-generation logic to invoke. This
 * route exists to (a) stop the daily 404 from the registered cron, and (b)
 * emit a `failure` cron_runs row so the admin pipelines page surfaces the
 * gap honestly. It will be replaced — not extended — when the v0 pipeline
 * lands. A 501 here is the correct telemetry signal: the cron ran and could
 * not produce picks.
 */
const STUB_MESSAGE =
  'pick-pipeline route is a stub; v0 model artifact has not shipped, no picks generated.';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    console.warn(
      JSON.stringify({ level: 'warn', event: 'cron_unauthorized', path: '/api/cron/pick-pipeline' })
    );
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Unauthorized.' } },
      { status: 401 }
    );
  }

  const runHandle = await startCronRun('pick-pipeline');
  console.info(
    JSON.stringify({
      level: 'info',
      event: 'cron_pick_pipeline_stub_invoked',
      time: new Date().toISOString(),
      status: 'not_implemented',
      message: STUB_MESSAGE,
    })
  );

  await finishCronRun(runHandle, {
    status: 'failure',
    errorMsg: 'stub: not_implemented',
  });

  return NextResponse.json(
    { status: 'not_implemented', message: STUB_MESSAGE },
    { status: 501 }
  );
}

export const POST = GET;
