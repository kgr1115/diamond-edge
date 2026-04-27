/**
 * Vercel Cron handler: GET /api/cron/outcome-grader
 * Also called from pg_cron job 'outcome-grader' at 08:00 UTC (3 AM ET).
 *
 * Grades all pending picks for games that reached status='final' at least
 * 6 hours ago. Actual logic lives in @/lib/outcome-grader/lib to keep this
 * route file within Next.js's route-export rules.
 */
import { NextRequest, NextResponse } from 'next/server';
import { runOutcomeGrader } from '@/lib/outcome-grader/lib';
import { startCronRun, finishCronRun } from '@/lib/ops/cron-run-log';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    console.warn(JSON.stringify({ level: 'warn', event: 'cron_unauthorized', path: '/api/cron/outcome-grader' }));
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Unauthorized.' } },
      { status: 401 },
    );
  }

  const runHandle = await startCronRun('outcome-grader');
  const startMs = Date.now();
  try {
    const response = await runOutcomeGrader();
    // runOutcomeGrader returns 207 on partial errors — treat 2xx as success for telemetry.
    await finishCronRun(runHandle, {
      status: response.status >= 200 && response.status < 300 ? 'success' : 'failure',
      errorMsg: response.status >= 300 ? `HTTP ${response.status}` : null,
    });
    return response;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({
      level: 'error',
      event: 'cron_outcome_grader_unhandled',
      error: msg,
      ms: Date.now() - startMs,
    }));
    await finishCronRun(runHandle, { status: 'failure', errorMsg: msg });
    return NextResponse.json(
      { graded: 0, wins: 0, losses: 0, pushes: 0, voids: 0, errors: [msg], durationMs: Date.now() - startMs },
      { status: 207 },
    );
  }
}

export const POST = GET;
