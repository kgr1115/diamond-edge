/**
 * Bluesky API poller — AT Protocol public read-only endpoint.
 *
 * Source: https://public.api.bsky.app (no auth required for public feeds)
 * Rate limit: documented at ~3000 req/5min per IP (generous). Our cadence
 *   at 100 handles × 1 req/handle every 5min = 100 req/5min — well inside.
 *   Monthly: 100 handles × 12 polls/hr × 22 hrs/day × 30 days = 792,000 req.
 *   BUT: we only poll during game-day windows (06:00–04:00 UTC, ~22hrs).
 *   Actual monthly: well within limits; Bluesky imposes no documented monthly cap.
 *
 * Freshness SLA: 5 min during game-day window. Posts older than lookback window
 *   are ignored (dedup via source_id = post URI anyway).
 *
 * Failure modes:
 *   - 429: back off 60s, retry up to 3×
 *   - 5xx: exponential backoff, log, dead-letter to structured log
 *   - Schema drift: validate response shape before writing; log and skip invalid posts
 *   - Bluesky actor not found (404): mark handle as invalid in structured log; skip
 *
 * pg_cron schedule note: This client is invoked from a Supabase Edge Function
 * (`late-news-pipeline`) triggered by pg_cron. The Vercel Cron route
 * `/api/cron/news-poll` calls RSS sources only; Bluesky is handled by the
 * Supabase function to satisfy the 5-min cadence without burning Vercel cron slots.
 */

import { ALL_HANDLES } from './beat-writers';
import type { NewsEventInsert } from '../upsert';

export const BSKY_API_BASE =
  process.env.BSKY_API_BASE ?? 'https://public.api.bsky.app';

/** How far back to look for posts on each poll (ms). */
const LOOKBACK_MS = 6 * 60 * 60 * 1000; // 6 hours — catches any posts since last sweep

/** UTC hours (0–23) defining the game-day polling window. */
const GAME_DAY_START_UTC = 6;   // 06:00 UTC
const GAME_DAY_END_UTC   = 28;  // 04:00 UTC next day (represented as 28 for easy comparison)

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS  = 60_000; // 60s cap for 429 responses

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

interface BskyPost {
  uri: string;           // e.g. "at://did:plc:xxx/app.bsky.feed.post/yyy"
  cid: string;
  author: {
    handle: string;      // e.g. "ken.rosenthal.bsky.social"
    displayName?: string;
  };
  record: {
    text: string;
    createdAt: string;   // ISO 8601
    '$type': string;     // should be 'app.bsky.feed.post'
  };
  indexedAt: string;     // when Bluesky indexed it (UTC ISO 8601)
}

interface BskyAuthorFeedResponse {
  feed: Array<{ post: BskyPost }>;
  cursor?: string;
}

export interface BskyPollResult {
  totalFetched: number;
  events: NewsEventInsert[];
  skippedHandles: string[];
  errors: string[];
}

// ---------------------------------------------------------------------------
// Game-day window guard
// ---------------------------------------------------------------------------

function isGameDayWindow(): boolean {
  const nowUTC = new Date();
  const hour = nowUTC.getUTCHours();
  // Window: 06:00–04:00 UTC (wraps midnight)
  return hour >= GAME_DAY_START_UTC || hour < (GAME_DAY_END_UTC - 24);
}

// ---------------------------------------------------------------------------
// Main poller
// ---------------------------------------------------------------------------

/**
 * Poll all beat-writer handles for recent posts.
 * Skips polling outside the game-day window unless `force` is true.
 */
export async function pollBeatWriters(
  handles: string[] = ALL_HANDLES,
  force = false
): Promise<BskyPollResult> {
  if (!force && !isGameDayWindow()) {
    console.info(JSON.stringify({
      level: 'info',
      event: 'bluesky_poll_skipped_outside_window',
      utcHour: new Date().getUTCHours(),
    }));
    return { totalFetched: 0, events: [], skippedHandles: [], errors: [] };
  }

  const cutoff = new Date(Date.now() - LOOKBACK_MS).toISOString();
  const events: NewsEventInsert[] = [];
  const skippedHandles: string[] = [];
  const errors: string[] = [];

  for (const handle of handles) {
    const result = await fetchAuthorFeed(handle, cutoff);
    if (result.error) {
      errors.push(`${handle}: ${result.error}`);
      if (result.skip) skippedHandles.push(handle);
      continue;
    }
    events.push(...result.events);
  }

  console.info(JSON.stringify({
    level: 'info',
    event: 'bluesky_poll_complete',
    handlesPolled: handles.length,
    eventsFound: events.length,
    skippedHandles: skippedHandles.length,
    errors: errors.length,
  }));

  return {
    totalFetched: events.length,
    events,
    skippedHandles,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Per-handle fetch with retry
// ---------------------------------------------------------------------------

interface FetchResult {
  events: NewsEventInsert[];
  error?: string;
  skip?: boolean; // true = permanently skip this handle (e.g. not found)
}

async function fetchAuthorFeed(handle: string, cutoff: string): Promise<FetchResult> {
  const url = `${BSKY_API_BASE}/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(handle)}&limit=50`;
  let lastError = '';

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const backoff = Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt - 1), MAX_BACKOFF_MS);
      await sleep(backoff);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { 'User-Agent': 'DiamondEdge/1.0 (data ingestion; contact kyle.g.rauch@gmail.com)' },
      });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.error(JSON.stringify({
        level: 'error', event: 'bluesky_network_error', handle, attempt, err: lastError,
      }));
      continue;
    }

    if (response.status === 404) {
      // Handle not found — log and skip permanently for this poll cycle
      console.warn(JSON.stringify({
        level: 'warn', event: 'bluesky_handle_not_found', handle,
      }));
      return { events: [], error: 'handle not found (404)', skip: true };
    }

    if (response.status === 429) {
      console.error(JSON.stringify({
        level: 'error', event: 'bluesky_rate_limited', handle, attempt,
      }));
      lastError = 'rate limited (429)';
      await sleep(MAX_BACKOFF_MS);
      continue;
    }

    if (response.status >= 500) {
      console.error(JSON.stringify({
        level: 'error', event: 'bluesky_server_error', handle, status: response.status, attempt,
      }));
      lastError = `server error ${response.status}`;
      continue;
    }

    if (!response.ok) {
      return { events: [], error: `unexpected status ${response.status}` };
    }

    let body: BskyAuthorFeedResponse;
    try {
      body = await response.json() as BskyAuthorFeedResponse;
    } catch {
      return { events: [], error: 'JSON parse error' };
    }

    const events = extractEvents(body, handle, cutoff);
    return { events };
  }

  return { events: [], error: lastError || 'max retries exceeded' };
}

// ---------------------------------------------------------------------------
// Response → NewsEventInsert
// ---------------------------------------------------------------------------

function extractEvents(
  body: BskyAuthorFeedResponse,
  handle: string,
  cutoff: string
): NewsEventInsert[] {
  const events: NewsEventInsert[] = [];

  for (const item of body.feed ?? []) {
    const post = item?.post;
    if (!isValidPost(post)) continue;

    // Only posts at or after the cutoff window
    if (post.record.createdAt < cutoff) continue;

    // Only original posts — skip reposts (record.$type check)
    if (post.record['$type'] !== 'app.bsky.feed.post') continue;

    const body_text = post.record.text?.trim();
    if (!body_text) continue;

    events.push({
      source: 'bluesky',
      source_id: post.uri,
      author: post.author.handle,
      body: body_text,
      url: bskyPostUrl(post),
      published_at: post.record.createdAt,
    });
  }

  return events;
}

function isValidPost(post: unknown): post is BskyPost {
  if (!post || typeof post !== 'object') return false;
  const p = post as Record<string, unknown>;
  return (
    typeof p.uri === 'string' &&
    typeof p.record === 'object' &&
    p.record !== null &&
    typeof (p.record as Record<string, unknown>).text === 'string' &&
    typeof (p.record as Record<string, unknown>).createdAt === 'string'
  );
}

function bskyPostUrl(post: BskyPost): string {
  // AT URI format: at://did:plc:xxx/app.bsky.feed.post/rkey
  const parts = post.uri.split('/');
  const rkey = parts[parts.length - 1];
  const did = post.author.handle;
  return `https://bsky.app/profile/${did}/post/${rkey}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
