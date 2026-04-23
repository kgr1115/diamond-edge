/**
 * Vercel Cron handler: GET /api/cron/news-poll
 *
 * This route is a thin wrapper around `runNewsPoll()` in `lib/ingestion/news/poll`.
 * The library function is reused by the schedule-sync cron to chain RSS polling
 * after schedule + odds (to stay under Vercel Hobby's 2-cron limit).
 *
 * Bluesky polling runs at higher cadence via pg_cron (see migration 0009 +
 * the runtime reschedule at scripts/run-migrations/setup-pg-cron-inline.mjs).
 *
 * Sources polled: MLB.com RSS, ESPN unofficial, RotoBaller RSS (all free).
 */
import { NextRequest, NextResponse } from 'next/server';
import { runNewsPoll } from '@/lib/ingestion/news/poll';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    console.warn(JSON.stringify({
      level: 'warn',
      event: 'cron_unauthorized',
      path: '/api/cron/news-poll',
    }));
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Unauthorized.' } },
      { status: 401 }
    );
  }

  return runNewsPoll();
}
