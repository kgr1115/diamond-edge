import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 10;

/**
 * Vercel Cron handler: GET /api/cron/outcome-grader
 * Scheduled: daily at 2:00 AM ET (after all games complete).
 *
 * Grades completed game outcomes → updates pick_outcomes and picks.result.
 * Full implementation: TASK-011 (QA/backend). This stub returns 200 so the cron job
 * doesn't fail before the grader is wired up.
 *
 * Security: CRON_SECRET header required.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Unauthorized.' } },
      { status: 401 }
    );
  }

  // TODO (TASK-011): Implement pick outcome grading.
  // Steps:
  //   1. Fetch picks with result = 'pending' for completed games (games.status = 'final').
  //   2. Compare pick_side to actual game outcome (home_score vs away_score).
  //   3. Upsert pick_outcomes table.
  //   4. Update picks.result field.
  //   5. Invalidate history cache.
  console.info(JSON.stringify({ event: 'outcome_grader_stub', note: 'not yet implemented' }));

  return NextResponse.json({ graded: 0, status: 'stub' }, { status: 200 });
}
