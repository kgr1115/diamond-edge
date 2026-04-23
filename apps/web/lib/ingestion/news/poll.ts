import { NextResponse } from 'next/server';
import { ACTIVE_RSS_SOURCES } from '@/lib/ingestion/news/rss/sources';
import { pollRssSource } from '@/lib/ingestion/news/rss/client';
import { upsertNewsEvents } from '@/lib/ingestion/news/upsert';

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

/**
 * Poll all active RSS news sources (MLB.com, ESPN, RotoBaller), upsert into
 * `news_events`. Callable from:
 *   - The `/api/cron/news-poll` route (direct cron invocation)
 *   - The `/api/cron/schedule-sync` route (chained after schedule + odds)
 *
 * Exported from a lib module — not a route file — because Next.js restricts
 * route files to exporting only the handler verbs (GET, POST, etc.) plus
 * specific config symbols (`runtime`, `dynamic`, `maxDuration`, …). Exporting
 * an arbitrary helper from `app/api/.../route.ts` breaks the build.
 */
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
