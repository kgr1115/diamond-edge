/**
 * RSS source configuration for news ingestion.
 *
 * Adding a new source: add an entry here. No code changes needed elsewhere —
 * the RSS client reads from this config map.
 *
 * poll_interval_s: seconds between polls. Set to match freshness SLA per source.
 *   MLB.com + ESPN + RotoBaller: 15 min (900s) during schedule-sync cron.
 *   These are polled from the Vercel Cron schedule-sync endpoint.
 *
 * ESPN endpoint note: this is an unofficial API. ESPN provides no stability
 * guarantees. The client handles 4xx/5xx gracefully and logs schema drift.
 * If ESPN breaks, set `enabled: false` here — no code change needed.
 *
 * RotoBaller RSS: confirmed URL from
 *   https://www.rotoballer.com/free-fantasy-sports-news-widgets-and-apis/335167
 *   Section: "Baseball Injury & News RSS Feed"
 */

export interface RssSource {
  source: 'mlb_rss' | 'espn' | 'rotoballer';
  name: string;           // human-readable label for logs
  url: string;
  poll_interval_s: number;
  enabled: boolean;
  /** For ESPN: response is JSON, not XML RSS. */
  format: 'rss' | 'json_api';
  /** Optional: max items to process per poll (prevent burst on first poll). */
  max_items?: number;
}

export const RSS_SOURCES: RssSource[] = [
  {
    source: 'mlb_rss',
    name: 'MLB.com News RSS',
    url: 'https://www.mlb.com/feeds/news/rss.xml',
    poll_interval_s: 900,
    enabled: true,
    format: 'rss',
    max_items: 50,
  },
  {
    source: 'espn',
    name: 'ESPN MLB News (unofficial)',
    url: 'http://site.api.espn.com/apis/site/v2/sports/baseball/mlb/news',
    poll_interval_s: 900,
    enabled: true,
    format: 'json_api',
    max_items: 50,
  },
  {
    source: 'rotoballer',
    name: 'RotoBaller MLB News RSS',
    // Official MLB injury + news RSS from RotoBaller's free widget/API page
    url: 'https://www.rotoballer.com/feed/news/mlb',
    poll_interval_s: 900,
    enabled: true,
    format: 'rss',
    max_items: 50,
  },
];

/** Only sources currently enabled. */
export const ACTIVE_RSS_SOURCES = RSS_SOURCES.filter(s => s.enabled);
