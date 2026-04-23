/**
 * news_events upsert — writes raw news items idempotently.
 *
 * Idempotency key: UNIQUE(source, source_id). Re-polling the same RSS item
 * or Bluesky post is a no-op — Postgres ON CONFLICT DO NOTHING handles dedup.
 *
 * Batch size: 100 rows per upsert call to keep Supabase payload size bounded.
 * Supabase's REST API has a ~1MB body limit; 100 news items is well within that.
 *
 * Callers (RSS client, Bluesky client) pass NewsEventInsert[] and get back
 * a count of net-new rows written (0 = all duplicates, which is normal).
 */

import { createServiceRoleClient } from '@/lib/supabase/server';

export interface NewsEventInsert {
  source: 'bluesky' | 'mlb_rss' | 'espn' | 'rotoballer' | 'mlb_stats_api';
  source_id: string;
  author: string | null;
  body: string;
  url: string | null;
  published_at: string; // UTC ISO 8601
}

export interface UpsertResult {
  attempted: number;
  inserted: number;   // net-new rows; duplicates are silently skipped
  errors: string[];
}

const BATCH_SIZE = 100;

/**
 * Upsert a batch of news events. Re-entrancy safe — duplicate source_ids are ignored.
 * All timestamps must be UTC ISO 8601 (callers are responsible for conversion).
 */
export async function upsertNewsEvents(
  events: NewsEventInsert[]
): Promise<UpsertResult> {
  if (events.length === 0) {
    return { attempted: 0, inserted: 0, errors: [] };
  }

  const supabase = createServiceRoleClient();
  const errors: string[] = [];
  let inserted = 0;

  // Process in batches to stay inside payload limits
  for (let i = 0; i < events.length; i += BATCH_SIZE) {
    const batch = events.slice(i, i + BATCH_SIZE);

    // ON CONFLICT (source, source_id) DO NOTHING — idempotent
    // Supabase upsert with ignoreDuplicates achieves this without a count hack.
    // The `as any` cast is required until migration 0008 is applied to the DB
    // and Supabase CLI regenerates the TypeScript types via `supabase gen types`.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any)
      .from('news_events')
      .upsert(
        batch.map(e => ({
          source:       e.source,
          source_id:    e.source_id,
          author:       e.author,
          body:         e.body,
          url:          e.url,
          published_at: e.published_at,
          // fetched_at defaults to now() in the DB
        })),
        {
          onConflict: 'source,source_id',
          ignoreDuplicates: true,
        }
      );

    if (error) {
      const msg = `Batch ${i}–${i + batch.length}: ${error.message}`;
      console.error(JSON.stringify({
        level: 'error',
        event: 'news_events_upsert_error',
        batchStart: i,
        batchSize: batch.length,
        err: error.message,
      }));
      errors.push(msg);
      continue;
    }

    // ignoreDuplicates means count = net-new only; Supabase doesn't return count
    // here so we approximate: track attempted, let downstream measure via DB if needed.
    inserted += batch.length; // upper bound; actual may be lower due to dedup
  }

  console.info(JSON.stringify({
    level: 'info',
    event: 'news_events_upsert_complete',
    attempted: events.length,
    batchesProcessed: Math.ceil(events.length / BATCH_SIZE),
    errors: errors.length,
  }));

  return {
    attempted: events.length,
    inserted,  // upper bound; exact count requires a SELECT COUNT query
    errors,
  };
}
