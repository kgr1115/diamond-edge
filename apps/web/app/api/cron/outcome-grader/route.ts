import { NextRequest, NextResponse } from 'next/server';
import { runOutcomeGrader, type OutcomeGraderResult } from '@/lib/outcome-grader/lib';
import { startCronRun, finishCronRun } from '@/lib/ops/cron-run-log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Vercel Cron handler: GET /api/cron/outcome-grader
 * Scheduled: 4am ET daily (08:00 UTC).
 *
 * Grades pending picks whose games are final with both scores populated.
 * Lib uses the service-role Supabase client internally; that client is never
 * exposed to the caller — we only forward the lib's JSON body + status.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    console.warn(
      JSON.stringify({ level: 'warn', event: 'cron_unauthorized', path: '/api/cron/outcome-grader' })
    );
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Unauthorized.' } },
      { status: 401 }
    );
  }

  const runHandle = await startCronRun('outcome-grader');
  console.info(
    JSON.stringify({ level: 'info', event: 'cron_outcome_grader_start', time: new Date().toISOString() })
  );

  let body: OutcomeGraderResult;
  let status: number;
  try {
    const response = await runOutcomeGrader();
    body = (await response.json()) as OutcomeGraderResult;
    status = response.status;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ level: 'error', event: 'cron_outcome_grader_threw', error: msg }));
    await finishCronRun(runHandle, { status: 'failure', errorMsg: msg });
    return NextResponse.json(
      { graded: 0, wins: 0, losses: 0, pushes: 0, voids: 0, errors: [msg], durationMs: 0 },
      { status: 500 },
    );
  }

  const hadErrors = status >= 400 || (body.errors?.length ?? 0) > 0;

  console.info(JSON.stringify({
    level: hadErrors ? 'warn' : 'info',
    event: 'cron_outcome_grader_complete',
    status,
    graded: body.graded,
    wins: body.wins,
    losses: body.losses,
    pushes: body.pushes,
    voids: body.voids,
    errors: body.errors,
    durationMs: body.durationMs,
  }));

  await finishCronRun(runHandle, {
    status: hadErrors ? 'failure' : 'success',
    errorMsg: hadErrors ? (body.errors ?? []).join(' | ') || `http ${status}` : null,
  });

  return NextResponse.json(body, { status });
}

export const POST = GET;
