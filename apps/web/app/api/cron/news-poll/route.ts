/**
 * Vercel Cron handler: GET /api/cron/news-poll
 *
 * SCHEDULING NOTE — Vercel Hobby has a 2-cron hard limit.
 * This route is NOT registered as a separate Vercel Cron job.
 * It is instead called at the tail of the existing schedule-sync cron
 * (which runs at 10am ET / 14:00 UTC daily) for RSS sources.
 *
 * Bluesky polling (5-min cadence during game-day window) requires higher
 * frequency than Vercel Hobby allows. That is handled by a Supabase Edge
 * Function (`supabase/functions/late-news-pipeline/index.ts`) triggered by
 * pg_cron — scaffolded as a separate Phase 5 deliverable (backend's job per ADR-002).
 * See the pg_cron schedule in ADR-002 §Recommended cron strategy.
 *
 * This route CAN be hit directly:
 *   - By the schedule-sync cron handler via internal fetch
 *   - Manually by Kyle for debugging (curl with CRON_SECRET header)
 *   - Later by pg_cron if we add a Supabase Edge Function wrapper
 *
 * Sources polled here (RSS only, no Bluesky):
 *   - MLB.com RSS        (every 15 min is the target; here it runs on schedule-sync cadence)
 *   - ESPN unofficial   (fragile; enabled flag in sources.ts is the kill switch)
 *   - RotoBaller RSS    (free feed)
 *
 * Rate budget:
 *   3 sources × 1 req/poll × 2 polls/day (via schedule-sync) = 6 req/day = ~180 req/mo.
 *   All free sources. No monthly cap risk.
 */

import { NextRequest, NextResponse } from 'next/server';
import { ACTIVE_RSS_SOURCES } from '@/lib/ingestion/news/rss/sources';
import { pollRssSource } from '@/lib/ingestion/news/rss/client';
import { upsertNewsEvents } from '@/lib/ingestion/news/upsert';

export const runtime = 'nodejs';
export const maxDuration = 60;

export interface NewsPollResult {
  sources: Array<{
    source: string;
    eventsFound: number;
    errors: string[];
  }>;
  totalAttempted: number;
  totalInserted: number;
  errors: string[];
  durationMs: number;
}

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

/** Exported so schedule-sync can call this directly without HTTP round-trip. */
export async function runNewsPoll(): Promise<NextResponse<NewsPollResult>> {
  const startMs = Date.now();

  console.info(JSON.stringify({
    level: 'info',
    event: 'news_poll_start',
    sources: ACTIVE_RSS_SOURCES.map(s => s.source),
    time: new Date().toISOString(),
  }));

  const sourceResults: NewsPollResult['sources'] = [];
  let totalAttempted = 0;
  let totalInserted = 0;
  const topLevelErrors: string[] = [];

  for (const source of ACTIVE_RSS_SOURCES) {
    const pollResult = await pollRssSource(source);

    if (pollResult.events.length > 0) {
      const upsertResult = await upsertNewsEvents(pollResult.events);
      totalAttempted += upsertResult.attempted;
      totalInserted  += upsertResult.inserted;
      if (upsertResult.errors.length > 0) {
        topLevelErrors.push(...upsertResult.errors.map(e => `[${source.source}] ${e}`));
      }
    }

    sourceResults.push({
      source: source.source,
      eventsFound: pollResult.events.length,
      errors: pollResult.errors,
    });
  }

  const durationMs = Date.now() - startMs;
  const hadErrors = topLevelErrors.length > 0 ||
    sourceResults.some(r => r.errors.length > 0);

  console.info(JSON.stringify({
    level: hadErrors ? 'warn' : 'info',
    event: 'news_poll_complete',
    durationMs,
    totalAttempted,
    totalInserted,
    sources: sourceResults,
    errors: topLevelErrors,
  }));

  const result: NewsPollResult = {
    sources: sourceResults,
    totalAttempted,
    totalInserted,
    errors: topLevelErrors,
    durationMs,
  };

  return NextResponse.json(result, { status: hadErrors ? 207 : 200 });
}
