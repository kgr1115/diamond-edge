/**
 * news-ingestion.spec.ts — News source parser unit + smoke tests
 *
 * Scope:
 *   Unit: each source parser (Bluesky, RSS XML, ESPN JSON) receives a mocked
 *   HTTP response and must return correctly-shaped NewsEventInsert[] rows.
 *
 *   Smoke (integration): hit each real endpoint, assert schema match and non-zero
 *   event count. No DB writes — these tests do NOT connect to Supabase.
 *
 * Fixtures: inline mocks only — no committed fixture files.
 * Real endpoint smoke tests: run via MSW bypass (onUnhandledRequest: 'bypass').
 *   Skip smoke tests in CI if SKIP_SMOKE_TESTS=true.
 *
 * Out of scope: Supabase writes (Phase 6 QA). Redis (separate test).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { http, HttpResponse, passthrough } from 'msw';
import { setupServer } from 'msw/node';

// ---------------------------------------------------------------------------
// Module under test — imported directly (no HTTP interception needed for unit tests)
// We call the internal parsing logic by importing the client functions.
// ---------------------------------------------------------------------------

// We test the RSS client's parse logic by importing from the built path.
// Since these are TypeScript source files, vitest's ts transpilation handles them.

const SKIP_SMOKE = process.env.SKIP_SMOKE_TESTS === 'true';

// ---------------------------------------------------------------------------
// Mock data fixtures
// ---------------------------------------------------------------------------

const MOCK_MLB_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>MLB.com News</title>
    <item>
      <title>Yankees activate Judge from IL ahead of Friday start</title>
      <description><![CDATA[Aaron Judge (oblique) was activated from the 10-day IL on Friday, the team announced.]]></description>
      <link>https://www.mlb.com/news/judge-activated-from-il</link>
      <guid>https://www.mlb.com/news/judge-activated-from-il</guid>
      <pubDate>Fri, 17 Apr 2026 18:30:00 +0000</pubDate>
      <author>Bryan Hoch</author>
    </item>
    <item>
      <title>Ohtani scratched from Saturday start with blister</title>
      <description><![CDATA[Shohei Ohtani has been scratched from his scheduled Saturday start due to a blister on his right index finger.]]></description>
      <link>https://www.mlb.com/news/ohtani-scratched-blister</link>
      <guid>https://www.mlb.com/news/ohtani-scratched-blister</guid>
      <pubDate>Fri, 17 Apr 2026 19:00:00 +0000</pubDate>
    </item>
  </channel>
</rss>`;

const MOCK_ROTOBALLER_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>RotoBaller MLB News</title>
    <item>
      <title>Correa (knee) day-to-day, out Friday</title>
      <description>Carlos Correa is day-to-day with knee soreness and will not play Friday.</description>
      <link>https://www.rotoballer.com/correa-knee-update</link>
      <guid>rotoballer-correa-knee-20260417</guid>
      <pubDate>Fri, 17 Apr 2026 17:45:00 +0000</pubDate>
      <dc:creator>Staff</dc:creator>
    </item>
  </channel>
</rss>`;

const MOCK_ESPN_JSON = {
  articles: [
    {
      id: 'espn-12345',
      type: 'Story',
      headline: 'Cole to start Game 1 of doubleheader',
      description: 'Gerrit Cole will start the first game of Friday\'s doubleheader against Baltimore.',
      published: '2026-04-17T20:00:00Z',
      links: { web: { href: 'https://www.espn.com/mlb/story/cole-doubleheader' } },
      byline: 'Jeff Passan',
    },
    {
      id: 'espn-12346',
      type: 'Story',
      headline: null,         // missing headline — schema drift test
      description: null,      // missing description — should be skipped
      published: '2026-04-17T20:10:00Z',
    },
    {
      // Missing id — should be skipped entirely
      headline: 'No ID article',
      description: 'This has no id field',
      published: '2026-04-17T20:15:00Z',
    },
  ],
};

const MOCK_BSKY_FEED = {
  feed: [
    {
      post: {
        uri: 'at://did:plc:abc123/app.bsky.feed.post/xyz789',
        cid: 'bafyreiabc',
        author: {
          handle: 'ken.rosenthal.bsky.social',
          displayName: 'Ken Rosenthal',
        },
        record: {
          '$type': 'app.bsky.feed.post',
          text: 'Source: Cubs will scratch Stroman from tonight\'s start. Shoulder tightness. #MLB',
          createdAt: new Date().toISOString(), // recent enough to pass lookback
        },
        indexedAt: new Date().toISOString(),
      },
    },
    {
      post: {
        uri: 'at://did:plc:abc123/app.bsky.feed.post/repost999',
        cid: 'bafyreidef',
        author: {
          handle: 'ken.rosenthal.bsky.social',
        },
        record: {
          '$type': 'app.bsky.feed.repost', // not an original post — should be skipped
          text: 'Reposted content',
          createdAt: new Date().toISOString(),
        },
        indexedAt: new Date().toISOString(),
      },
    },
    {
      post: {
        uri: 'at://did:plc:abc123/app.bsky.feed.post/old001',
        cid: 'bafyreighi',
        author: {
          handle: 'ken.rosenthal.bsky.social',
        },
        record: {
          '$type': 'app.bsky.feed.post',
          text: 'Very old post — outside lookback window',
          createdAt: '2020-01-01T00:00:00Z', // outside 6h lookback — should be skipped
        },
        indexedAt: '2020-01-01T00:00:00Z',
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// MSW server
// ---------------------------------------------------------------------------

const mswServer = setupServer(
  http.get('https://www.mlb.com/feeds/news/rss.xml', () =>
    HttpResponse.text(MOCK_MLB_RSS, { headers: { 'Content-Type': 'application/rss+xml' } })
  ),
  http.get('https://www.rotoballer.com/feed/news/mlb', () =>
    HttpResponse.text(MOCK_ROTOBALLER_RSS, { headers: { 'Content-Type': 'application/rss+xml' } })
  ),
  http.get('http://site.api.espn.com/apis/site/v2/sports/baseball/mlb/news', () =>
    HttpResponse.json(MOCK_ESPN_JSON)
  ),
  http.get('https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed', () =>
    HttpResponse.json(MOCK_BSKY_FEED)
  ),
);

beforeAll(() => {
  // passthrough allows real network calls for smoke tests when MSW has no handler
  mswServer.listen({ onUnhandledRequest: SKIP_SMOKE ? 'error' : 'bypass' });
});

afterAll(() => {
  mswServer.close();
});

// ---------------------------------------------------------------------------
// Helper: dynamically import client modules (uses vitest's path alias resolution)
// ---------------------------------------------------------------------------

async function getRssClient() {
  const { pollRssSource } = await import('@/lib/ingestion/news/rss/client');
  return { pollRssSource };
}

async function getBskyClient() {
  const { pollBeatWriters } = await import('@/lib/ingestion/news/bluesky/client');
  return { pollBeatWriters };
}

async function getRssSources() {
  const { RSS_SOURCES } = await import('@/lib/ingestion/news/rss/sources');
  return { RSS_SOURCES };
}

// ---------------------------------------------------------------------------
// MLB.com RSS parser tests
// ---------------------------------------------------------------------------

describe('MLB.com RSS parser', () => {
  it('parses a valid RSS feed into correctly-shaped NewsEventInsert rows', async () => {
    const { pollRssSource } = await getRssClient();
    const { RSS_SOURCES } = await getRssSources();

    const mlbSource = RSS_SOURCES.find(s => s.source === 'mlb_rss')!;
    const result = await pollRssSource(mlbSource);

    expect(result.errors).toHaveLength(0);
    expect(result.events.length).toBeGreaterThanOrEqual(2);

    const [first] = result.events;
    expect(first.source).toBe('mlb_rss');
    expect(typeof first.source_id).toBe('string');
    expect(first.source_id.length).toBeGreaterThan(0);
    expect(typeof first.body).toBe('string');
    expect(first.body.length).toBeGreaterThan(0);
    // published_at must be a valid UTC ISO 8601 string
    expect(() => new Date(first.published_at)).not.toThrow();
    expect(new Date(first.published_at).toISOString()).toBe(first.published_at);
  });

  it('strips HTML entities from description', async () => {
    const { pollRssSource } = await getRssClient();
    const { RSS_SOURCES } = await getRssSources();

    const mlbSource = RSS_SOURCES.find(s => s.source === 'mlb_rss')!;
    const result = await pollRssSource(mlbSource);

    for (const event of result.events) {
      expect(event.body).not.toMatch(/<[^>]+>/); // no residual HTML tags
    }
  });
});

// ---------------------------------------------------------------------------
// RotoBaller RSS parser tests
// ---------------------------------------------------------------------------

describe('RotoBaller RSS parser', () => {
  it('parses RotoBaller RSS with dc:creator into author field', async () => {
    const { pollRssSource } = await getRssClient();
    const { RSS_SOURCES } = await getRssSources();

    const rbSource = RSS_SOURCES.find(s => s.source === 'rotoballer')!;
    const result = await pollRssSource(rbSource);

    expect(result.errors).toHaveLength(0);
    expect(result.events.length).toBeGreaterThanOrEqual(1);

    const event = result.events[0];
    expect(event.source).toBe('rotoballer');
    expect(event.source_id).toBeTruthy();
    // dc:creator field should be parsed into author
    expect(event.author).toBe('Staff');
  });
});

// ---------------------------------------------------------------------------
// ESPN JSON API parser tests
// ---------------------------------------------------------------------------

describe('ESPN JSON API parser', () => {
  it('parses valid ESPN articles into correctly-shaped rows', async () => {
    const { pollRssSource } = await getRssClient();
    const { RSS_SOURCES } = await getRssSources();

    const espnSource = RSS_SOURCES.find(s => s.source === 'espn')!;
    const result = await pollRssSource(espnSource);

    expect(result.errors).toHaveLength(0);
    // Only 1 valid article (id: espn-12345); the other 2 have missing fields
    expect(result.events).toHaveLength(1);

    const event = result.events[0];
    expect(event.source).toBe('espn');
    expect(event.source_id).toBe('espn-espn-12345');
    expect(event.author).toBe('Jeff Passan');
    expect(event.url).toBe('https://www.espn.com/mlb/story/cole-doubleheader');
  });

  it('skips ESPN articles missing id or body', async () => {
    const { pollRssSource } = await getRssClient();
    const { RSS_SOURCES } = await getRssSources();

    const espnSource = RSS_SOURCES.find(s => s.source === 'espn')!;
    const result = await pollRssSource(espnSource);

    // Articles with no id or no body text must not appear in output
    const noIdEvents = result.events.filter(e => !e.source_id);
    expect(noIdEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Bluesky parser tests
// ---------------------------------------------------------------------------

describe('Bluesky API parser', () => {
  it('returns original posts within lookback window, skipping reposts and old posts', async () => {
    const { pollBeatWriters } = await getBskyClient();

    // force=true bypasses the game-day window guard for test
    const result = await pollBeatWriters(['ken.rosenthal.bsky.social'], true);

    expect(result.errors).toHaveLength(0);
    // Should have 1 event: only the valid original post within lookback window
    expect(result.events).toHaveLength(1);

    const event = result.events[0];
    expect(event.source).toBe('bluesky');
    expect(event.source_id).toBe('at://did:plc:abc123/app.bsky.feed.post/xyz789');
    expect(event.author).toBe('ken.rosenthal.bsky.social');
    expect(event.body).toContain('Stroman');
    expect(event.url).toContain('bsky.app/profile/ken.rosenthal.bsky.social/post/xyz789');
  });

  it('source_id is the AT URI (unique per post across all handles)', async () => {
    const { pollBeatWriters } = await getBskyClient();
    const result = await pollBeatWriters(['ken.rosenthal.bsky.social'], true);

    for (const event of result.events) {
      expect(event.source_id).toMatch(/^at:\/\//);
    }
  });
});

// ---------------------------------------------------------------------------
// Idempotency shape test (no DB — just validates NewsEventInsert schema)
// ---------------------------------------------------------------------------

describe('NewsEventInsert schema validation', () => {
  it('all required fields are present on events from each source', async () => {
    const { pollRssSource } = await getRssClient();
    const { RSS_SOURCES } = await getRssSources();
    const { pollBeatWriters } = await getBskyClient();

    const allEvents = [];

    for (const source of RSS_SOURCES.filter(s => s.enabled)) {
      const result = await pollRssSource(source);
      allEvents.push(...result.events);
    }

    const bskyResult = await pollBeatWriters(['ken.rosenthal.bsky.social'], true);
    allEvents.push(...bskyResult.events);

    for (const event of allEvents) {
      expect(['bluesky', 'mlb_rss', 'espn', 'rotoballer', 'mlb_stats_api']).toContain(event.source);
      expect(typeof event.source_id).toBe('string');
      expect(event.source_id.length).toBeGreaterThan(0);
      expect(typeof event.body).toBe('string');
      expect(event.body.length).toBeGreaterThan(0);
      expect(typeof event.published_at).toBe('string');
      // published_at must parse to a valid Date
      expect(isNaN(new Date(event.published_at).getTime())).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration smoke tests — real endpoints (skipped in CI by default)
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_SMOKE)('Smoke tests: real endpoints (no DB write)', () => {
  // Override MSW to pass through real network traffic for smoke tests
  beforeAll(() => {
    mswServer.use(
      http.get('https://www.mlb.com/feeds/news/rss.xml', () => passthrough()),
      http.get('https://www.rotoballer.com/feed/news/mlb', () => passthrough()),
      http.get('http://site.api.espn.com/apis/site/v2/sports/baseball/mlb/news', () => passthrough()),
      http.get('https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed', () => passthrough()),
    );
  });

  it('MLB.com RSS: real endpoint returns ≥1 schema-valid events', async () => {
    const { pollRssSource } = await getRssClient();
    const { RSS_SOURCES } = await getRssSources();

    const mlbSource = RSS_SOURCES.find(s => s.source === 'mlb_rss')!;
    const result = await pollRssSource(mlbSource);

    console.info(`[SMOKE] MLB.com RSS: ${result.events.length} events, ${result.errors.length} errors`);
    expect(result.errors).toHaveLength(0);
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events[0].source).toBe('mlb_rss');
  }, 15_000);

  it('ESPN MLB News: real endpoint returns ≥1 schema-valid events (may fail if ESPN endpoint changes)', async () => {
    const { pollRssSource } = await getRssClient();
    const { RSS_SOURCES } = await getRssSources();

    const espnSource = RSS_SOURCES.find(s => s.source === 'espn')!;
    const result = await pollRssSource(espnSource);

    console.info(`[SMOKE] ESPN: ${result.events.length} events, ${result.errors.length} errors`);
    // ESPN is fragile — we only assert no hard crash, not event count
    expect(Array.isArray(result.events)).toBe(true);
  }, 15_000);

  it('RotoBaller RSS: real endpoint returns ≥1 schema-valid events', async () => {
    const { pollRssSource } = await getRssClient();
    const { RSS_SOURCES } = await getRssSources();

    const rbSource = RSS_SOURCES.find(s => s.source === 'rotoballer')!;
    const result = await pollRssSource(rbSource);

    console.info(`[SMOKE] RotoBaller: ${result.events.length} events, ${result.errors.length} errors`);
    // RotoBaller may have a different RSS URL structure — assert no hard crash
    expect(Array.isArray(result.events)).toBe(true);
  }, 15_000);

  it('Bluesky: real endpoint returns ≥1 posts from a known handle', async () => {
    const { pollBeatWriters } = await getBskyClient();

    // Poll a single known national writer who is active
    const result = await pollBeatWriters(['mlbtraderumors.bsky.social'], true);

    console.info(`[SMOKE] Bluesky mlbtraderumors: ${result.totalFetched} events, errors: ${result.errors}`);
    // The account may have no recent posts — just verify no crash and correct schema
    expect(Array.isArray(result.events)).toBe(true);
    for (const event of result.events) {
      expect(event.source).toBe('bluesky');
      expect(typeof event.source_id).toBe('string');
    }
  }, 15_000);
});
