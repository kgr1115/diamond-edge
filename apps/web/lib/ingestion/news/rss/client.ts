/**
 * Generic RSS / JSON-API poller for MLB news sources.
 *
 * Handles two response formats:
 *   - 'rss'      — standard XML RSS (MLB.com, RotoBaller). Parsed with DOMParser
 *                  in Edge runtime or xmldom fallback in Node.
 *   - 'json_api' — ESPN's unofficial JSON endpoint.
 *
 * Rate-limit envelope (per source):
 *   - 15-min poll interval → 4 req/hr → 96 req/day → ~2,880 req/mo per source.
 *   - 3 sources × 2,880 = 8,640 req/mo total. All free; no documented caps.
 *
 * Failure modes:
 *   - 429: exponential backoff, max 3 attempts, log structured error.
 *   - 5xx: same backoff. After max retries: log dead-letter event, return [].
 *   - Schema drift (ESPN JSON changes): log warning, skip malformed items.
 *   - XML parse failure: log warning, return [].
 *   - ESPN endpoint unavailable (expected fragile): `enabled: false` in sources.ts
 *     is the kill switch; no code change needed.
 *
 * Freshness SLA: 15 min (triggered by schedule-sync cron).
 */

import type { RssSource } from './sources';
import type { NewsEventInsert } from '../upsert';

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 16_000;

export interface RssPollResult {
  source: string;
  events: NewsEventInsert[];
  errors: string[];
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/** Fetch and parse a single RSS source. Returns empty events on non-fatal errors. */
export async function pollRssSource(source: RssSource): Promise<RssPollResult> {
  if (!source.enabled) {
    return { source: source.source, events: [], errors: [] };
  }

  const raw = await fetchWithRetry(source);
  if (raw.error) {
    return { source: source.source, events: [], errors: [raw.error] };
  }

  let events: NewsEventInsert[];
  try {
    if (source.format === 'json_api') {
      events = parseEspnJson(raw.body, source.max_items);
    } else {
      events = parseRssXml(raw.body, source.source, source.max_items);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({
      level: 'error',
      event: 'rss_parse_error',
      source: source.source,
      err: msg,
    }));
    return { source: source.source, events: [], errors: [msg] };
  }

  console.info(JSON.stringify({
    level: 'info',
    event: 'rss_poll_complete',
    source: source.source,
    eventsFound: events.length,
  }));

  return { source: source.source, events, errors: [] };
}

// ---------------------------------------------------------------------------
// HTTP fetch with retry + backoff
// ---------------------------------------------------------------------------

interface FetchResult {
  body: string;
  error?: string;
}

async function fetchWithRetry(source: RssSource): Promise<FetchResult> {
  let lastError = '';

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const backoff = Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt - 1), MAX_BACKOFF_MS);
      await sleep(backoff);
    }

    let response: Response;
    try {
      response = await fetch(source.url, {
        headers: {
          'User-Agent': 'DiamondEdge/1.0 (data ingestion)',
          'Accept': source.format === 'json_api'
            ? 'application/json'
            : 'application/rss+xml, application/xml, text/xml',
        },
      });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.error(JSON.stringify({
        level: 'error', event: 'rss_network_error', source: source.source, attempt, err: lastError,
      }));
      continue;
    }

    if (response.status === 429) {
      lastError = 'rate limited (429)';
      console.error(JSON.stringify({
        level: 'error', event: 'rss_rate_limited', source: source.source, attempt,
      }));
      await sleep(MAX_BACKOFF_MS);
      continue;
    }

    if (response.status >= 500) {
      lastError = `server error ${response.status}`;
      console.error(JSON.stringify({
        level: 'error', event: 'rss_server_error', source: source.source,
        status: response.status, attempt,
      }));
      continue;
    }

    if (!response.ok) {
      lastError = `unexpected status ${response.status}`;
      console.warn(JSON.stringify({
        level: 'warn', event: 'rss_unexpected_status', source: source.source,
        status: response.status,
      }));
      return { body: '', error: lastError };
    }

    const body = await response.text();
    return { body };
  }

  console.error(JSON.stringify({
    level: 'error', event: 'rss_max_retries', source: source.source, lastError,
  }));
  return { body: '', error: `max retries exceeded: ${lastError}` };
}

// ---------------------------------------------------------------------------
// XML RSS parser (MLB.com, RotoBaller)
// ---------------------------------------------------------------------------

function parseRssXml(
  xml: string,
  sourceName: NewsEventInsert['source'],
  maxItems = 50
): NewsEventInsert[] {
  // Use a minimal regex-based parser to avoid DOM dependencies in Edge runtime.
  // This handles well-formed RSS 2.0 (both sources produce standard RSS).
  const items = extractXmlBlocks(xml, 'item');
  const events: NewsEventInsert[] = [];

  for (const item of items.slice(0, maxItems)) {
    const title    = extractXmlText(item, 'title');
    const desc     = extractXmlText(item, 'description');
    const link     = extractXmlText(item, 'link');
    const guid     = extractXmlText(item, 'guid');
    const pubDate  = extractXmlText(item, 'pubDate');
    const author   = extractXmlText(item, 'author') ?? extractXmlText(item, 'dc:creator');

    const body = stripHtml(desc ?? title ?? '').trim();
    if (!body) continue;

    const source_id = guid ?? link ?? '';
    if (!source_id) continue;

    const published_at = pubDate ? parsePubDate(pubDate) : null;
    if (!published_at) continue;

    events.push({
      source: sourceName,
      source_id,
      author: author ?? null,
      body,
      url: link ?? null,
      published_at,
    });
  }

  return events;
}

// ---------------------------------------------------------------------------
// ESPN JSON API parser
// ---------------------------------------------------------------------------

interface EspnArticle {
  id?: string;
  type?: string;
  headline?: string;
  description?: string;
  published?: string;  // ISO 8601
  links?: { web?: { href?: string } };
  byline?: string;
}

interface EspnResponse {
  articles?: EspnArticle[];
}

function parseEspnJson(raw: string, maxItems = 50): NewsEventInsert[] {
  let parsed: EspnResponse;
  try {
    parsed = JSON.parse(raw) as EspnResponse;
  } catch {
    throw new Error('ESPN response is not valid JSON');
  }

  const articles = parsed.articles ?? [];
  const events: NewsEventInsert[] = [];

  for (const article of articles.slice(0, maxItems)) {
    // Schema drift guard: skip items missing required fields
    if (!article.id || (!article.headline && !article.description)) {
      console.warn(JSON.stringify({
        level: 'warn', event: 'espn_schema_drift', article_id: article.id ?? 'unknown',
      }));
      continue;
    }

    const body = stripHtml(article.description ?? article.headline ?? '').trim();
    if (!body) continue;

    const published_at = article.published ?? null;
    if (!published_at) continue;

    events.push({
      source: 'espn',
      source_id: `espn-${article.id}`,
      author: article.byline ?? null,
      body,
      url: article.links?.web?.href ?? null,
      published_at,
    });
  }

  return events;
}

// ---------------------------------------------------------------------------
// Minimal XML helpers (regex-based, avoids DOM dependency in Edge runtime)
// ---------------------------------------------------------------------------

function extractXmlBlocks(xml: string, tag: string): string[] {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml)) !== null) {
    blocks.push(match[1]);
  }
  return blocks;
}

function extractXmlText(block: string, tag: string): string | null {
  // Handle CDATA and plain text content
  const cdataRegex = new RegExp(
    `<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`,
    'i'
  );
  const plainRegex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');

  const cdataMatch = block.match(cdataRegex);
  if (cdataMatch) return cdataMatch[1].trim();

  const plainMatch = block.match(plainRegex);
  if (plainMatch) return plainMatch[1].trim();

  return null;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function parsePubDate(pubDate: string): string | null {
  try {
    const d = new Date(pubDate);
    if (isNaN(d.getTime())) return null;
    return d.toISOString(); // UTC ISO 8601
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
