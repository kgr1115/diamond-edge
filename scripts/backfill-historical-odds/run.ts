/**
 * Historical odds backfill — 2022/2023/2024 MLB regular seasons + postseason.
 *
 * Source: The Odds API v4 historical endpoint
 * Endpoint: GET /v4/historical/sports/baseball_mlb/odds
 * Credit cost: 10 credits/call (historical multiplier) × 3 markets = 30 credits/call
 *   Re-verified from X-Requests-Used header on first call.
 *
 * Output: data/historical-odds/<year>/<YYYY-MM-DD>.json (raw API response, one file per game day)
 * Idempotent: skips dates where the file exists and contains a populated .data array.
 *
 * Safety guardrail: aborts if X-Requests-Remaining drops below 5,000.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';
const HISTORICAL_ENDPOINT = `${ODDS_API_BASE}/historical/sports/baseball_mlb/odds`;
const CREDITS_REMAINING_FLOOR = 5_000;

// Snapshot time: 23:00 ET = 04:00 UTC next day (ET is UTC-5 in standard time,
// UTC-4 in daylight time. MLB season runs Apr–Nov, so EDT=UTC-4 applies.
// 23:00 EDT = 03:00 UTC next day. Using 03:00 UTC to approximate closing lines.
const SNAPSHOT_HOUR_UTC = 3; // 23:00 ET during daylight saving

const RETRY = {
  MAX_ATTEMPTS: 6,
  BASE_BACKOFF_MS: 2_000,
  MAX_BACKOFF_MS: 60_000,
};

const BOOKMAKERS = ['draftkings', 'fanduel'];
const MARKETS = ['h2h', 'spreads', 'totals'];

// ---------------------------------------------------------------------------
// All-Star break skip lists (no regular-season games on these dates)
// ---------------------------------------------------------------------------
const ALL_STAR_SKIP = new Set<string>([
  // 2022 — All-Star Game Jul 19; break Jul 18-21
  '2022-07-18', '2022-07-19', '2022-07-20', '2022-07-21',
  // 2023 — All-Star Game Jul 11; break Jul 10-13
  '2023-07-10', '2023-07-11', '2023-07-12', '2023-07-13',
  // 2024 — All-Star Game Jul 16; break Jul 15-18
  '2024-07-15', '2024-07-16', '2024-07-17', '2024-07-18',
]);

// ---------------------------------------------------------------------------
// Season date ranges (inclusive on both ends)
// ---------------------------------------------------------------------------
const SEASONS: Array<{ start: string; end: string }> = [
  { start: '2022-04-07', end: '2022-11-05' },
  { start: '2023-03-30', end: '2023-11-02' },
  { start: '2024-03-28', end: '2024-10-31' },
];

// ---------------------------------------------------------------------------
// Env loading — manual parse so we don't need a dep and don't require running
// from apps/web/. Looks for .env at the repo root (two dirs up from this script).
// ---------------------------------------------------------------------------
function loadEnv(): void {
  const scriptDir = path.dirname(new URL(import.meta.url).pathname);
  // On Windows, URL.pathname starts with /C:/... strip leading slash
  const normalizedDir = scriptDir.replace(/^\/([A-Za-z]:)/, '$1');
  const repoRoot = path.resolve(normalizedDir, '..', '..');
  const envPath = path.join(repoRoot, '.env');

  if (!fs.existsSync(envPath)) {
    console.error(`[ERROR] .env not found at ${envPath}`);
    process.exit(1);
  }

  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (key && !(key in process.env)) {
      process.env[key] = val;
    }
  }
}

// ---------------------------------------------------------------------------
// Date utilities — UTC everywhere
// ---------------------------------------------------------------------------

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dateRange(start: string, end: string): string[] {
  const dates: string[] = [];
  let cur = start;
  while (cur <= end) {
    dates.push(cur);
    cur = addDays(cur, 1);
  }
  return dates;
}

/** Build the snapshot date param: 03:00 UTC on the day AFTER the game date.
 *  This approximates 23:00 EDT closing lines for the game day. */
function snapshotParam(gameDate: string): string {
  const nextDay = addDays(gameDate, 1);
  return `${nextDay}T0${SNAPSHOT_HOUR_UTC}:00:00Z`;
}

// ---------------------------------------------------------------------------
// Output paths
// ---------------------------------------------------------------------------

function outputDir(year: number): string {
  const scriptDir = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
  const repoRoot = path.resolve(scriptDir, '..', '..');
  return path.join(repoRoot, 'data', 'historical-odds', String(year));
}

function outputPath(gameDate: string): string {
  const year = parseInt(gameDate.slice(0, 4), 10);
  return path.join(outputDir(year), `${gameDate}.json`);
}

// ---------------------------------------------------------------------------
// Idempotency check
// ---------------------------------------------------------------------------

function alreadyFetched(gameDate: string): boolean {
  const filePath = outputPath(gameDate);
  if (!fs.existsSync(filePath)) return false;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    // The historical endpoint wraps results in { timestamp, previous_timestamp, next_timestamp, data: [...] }
    return Array.isArray(parsed.data) && parsed.data.length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// HTTP fetch with retry + exponential backoff
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface FetchResult {
  body: unknown;
  requestsUsed: number;
  requestsRemaining: number;
}

async function fetchWithRetry(url: string, gameDate: string): Promise<FetchResult> {
  let lastError: Error = new Error('Unknown error');

  for (let attempt = 0; attempt < RETRY.MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const backoffMs = Math.min(
        RETRY.BASE_BACKOFF_MS * Math.pow(2, attempt - 1),
        RETRY.MAX_BACKOFF_MS
      );
      console.log(`[${gameDate}] retry attempt=${attempt}, backoff=${backoffMs}ms`);
      await sleep(backoffMs);
    }

    let response: Response;
    try {
      response = await fetch(url);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.error(JSON.stringify({
        level: 'error', event: 'network_error', date: gameDate, attempt, err: lastError.message,
      }));
      continue;
    }

    const requestsUsed = parseInt(response.headers.get('x-requests-used') ?? '-1', 10);
    const requestsRemaining = parseInt(response.headers.get('x-requests-remaining') ?? '-1', 10);

    if (response.status === 429) {
      const retryAfterRaw = response.headers.get('retry-after');
      const retryAfterMs = retryAfterRaw ? parseInt(retryAfterRaw, 10) * 1000 : 60_000;
      console.error(JSON.stringify({
        level: 'error', event: 'rate_limited', date: gameDate, attempt,
        retryAfterMs, requestsUsed, requestsRemaining,
      }));
      lastError = new Error('429 rate limited');
      await sleep(Math.min(retryAfterMs, RETRY.MAX_BACKOFF_MS));
      continue;
    }

    if (response.status >= 500) {
      console.error(JSON.stringify({
        level: 'error', event: 'server_error', date: gameDate, attempt, status: response.status,
      }));
      lastError = new Error(`5xx: ${response.status}`);
      continue;
    }

    if (!response.ok) {
      // 4xx other than 429 — caller error, abort immediately
      const body = await response.text();
      throw new Error(`[${gameDate}] 4xx client error ${response.status}: ${body}`);
    }

    const body = await response.json();
    return { body, requestsUsed, requestsRemaining };
  }

  throw lastError;
}

// ---------------------------------------------------------------------------
// Single date fetch
// ---------------------------------------------------------------------------

async function fetchDate(gameDate: string, apiKey: string): Promise<{
  gamesCount: number;
  requestsUsed: number;
  requestsRemaining: number;
  skipped: boolean;
}> {
  if (alreadyFetched(gameDate)) {
    console.log(`[${gameDate}] skipped (file exists, non-empty)`);
    return { gamesCount: 0, requestsUsed: 0, requestsRemaining: -1, skipped: true };
  }

  const snapshotDate = snapshotParam(gameDate);
  const url = new URL(HISTORICAL_ENDPOINT);
  url.searchParams.set('apiKey', apiKey);
  url.searchParams.set('regions', 'us');
  url.searchParams.set('markets', MARKETS.join(','));
  url.searchParams.set('bookmakers', BOOKMAKERS.join(','));
  url.searchParams.set('date', snapshotDate);
  url.searchParams.set('oddsFormat', 'american');

  const { body, requestsUsed, requestsRemaining } = await fetchWithRetry(url.toString(), gameDate);

  // Persist raw response
  const year = parseInt(gameDate.slice(0, 4), 10);
  fs.mkdirSync(outputDir(year), { recursive: true });
  fs.writeFileSync(outputPath(gameDate), JSON.stringify(body), 'utf-8');

  const data = (body as { data?: unknown[] }).data;
  const gamesCount = Array.isArray(data) ? data.length : 0;

  return { gamesCount, requestsUsed, requestsRemaining, skipped: false };
}

// ---------------------------------------------------------------------------
// Test call — validates response shape before full backfill
// ---------------------------------------------------------------------------

async function runTestCall(apiKey: string): Promise<void> {
  const testDate = '2024-06-15';
  const snapshotDate = snapshotParam(testDate);

  console.log(`\n=== TEST CALL ===`);
  console.log(`Date: ${testDate}, Snapshot: ${snapshotDate}`);

  const url = new URL(HISTORICAL_ENDPOINT);
  url.searchParams.set('apiKey', apiKey);
  url.searchParams.set('regions', 'us');
  url.searchParams.set('markets', MARKETS.join(','));
  url.searchParams.set('bookmakers', BOOKMAKERS.join(','));
  url.searchParams.set('date', snapshotDate);
  url.searchParams.set('oddsFormat', 'american');

  const { body, requestsUsed, requestsRemaining } = await fetchWithRetry(url.toString(), testDate);

  const response = body as {
    timestamp?: string;
    data?: Array<{
      id: string;
      home_team: string;
      away_team: string;
      bookmakers?: Array<{ key: string; markets?: Array<{ key: string }> }>;
    }>;
  };

  const games = response.data ?? [];
  console.log(`\nHTTP: 200 OK`);
  console.log(`Games in response: ${games.length}`);
  console.log(`Snapshot timestamp: ${response.timestamp ?? 'N/A'}`);
  console.log(`Credits used (X-Requests-Used): ${requestsUsed}`);
  console.log(`Credits remaining (X-Requests-Remaining): ${requestsRemaining}`);

  if (games.length === 0) {
    console.warn(`[WARN] No games returned for test date. Verify date is a game day.`);
  } else {
    const sample = games[0];
    console.log(`\nSample game: ${sample.away_team} @ ${sample.home_team}`);

    const booksPresent = (sample.bookmakers ?? []).map(b => b.key);
    const marketsPresent = (sample.bookmakers?.[0]?.markets ?? []).map(m => m.key);
    console.log(`Bookmakers in sample: ${booksPresent.join(', ')}`);
    console.log(`Markets in sample: ${marketsPresent.join(', ')}`);

    const hasDK = booksPresent.includes('draftkings');
    const hasFD = booksPresent.includes('fanduel');
    const hasH2H = marketsPresent.includes('h2h');
    const hasSpreads = marketsPresent.includes('spreads');
    const hasTotals = marketsPresent.includes('totals');

    if (!hasDK) console.error('[FAIL] DraftKings missing from sample game');
    if (!hasFD) console.error('[FAIL] FanDuel missing from sample game');
    if (!hasH2H) console.error('[FAIL] h2h market missing');
    if (!hasSpreads) console.error('[FAIL] spreads market missing');
    if (!hasTotals) console.error('[FAIL] totals market missing');

    if (hasDK && hasFD && hasH2H && hasSpreads && hasTotals) {
      console.log(`\n[PASS] All required bookmakers and markets present.`);
    } else {
      console.error(`\n[FAIL] Response shape validation failed. Aborting before full backfill.`);
      process.exit(1);
    }
  }

  console.log(`\n=== TEST CALL COMPLETE ===\n`);
}

// ---------------------------------------------------------------------------
// Main backfill loop
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  loadEnv();

  const apiKey = process.env.THE_ODDS_API_KEY;
  if (!apiKey) {
    console.error('[ERROR] THE_ODDS_API_KEY not set in .env');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const testOnly = args.includes('--test-only');
  const skipTest = args.includes('--skip-test');

  if (!skipTest) {
    await runTestCall(apiKey);
    if (testOnly) {
      console.log('--test-only flag set. Exiting after test call.');
      process.exit(0);
    }

    // Wait for user confirmation before burning credits
    console.log('Test call succeeded. Starting full backfill in 5 seconds...');
    console.log('Press Ctrl+C to abort.\n');
    await sleep(5_000);
  }

  // Build full date list
  const allDates: string[] = [];
  for (const season of SEASONS) {
    for (const date of dateRange(season.start, season.end)) {
      if (!ALL_STAR_SKIP.has(date)) {
        allDates.push(date);
      }
    }
  }

  console.log(`Total game-day dates to process: ${allDates.length}`);
  console.log(`All-Star break dates skipped: ${ALL_STAR_SKIP.size}`);
  console.log('');

  let totalFetched = 0;
  let totalSkipped = 0;
  let totalGames = 0;
  let totalCreditsUsed = 0;
  let creditsRemaining = -1;
  const errors: string[] = [];
  // Track actual credit cost per call (measured from first real call)
  let creditsPerCall = 30; // initial estimate; corrected after first call
  let firstCallCreditsBefore = -1;

  for (let i = 0; i < allDates.length; i++) {
    const gameDate = allDates[i];

    // Guardrail check
    if (creditsRemaining !== -1 && creditsRemaining < CREDITS_REMAINING_FLOOR) {
      console.error(`\n[ABORT] X-Requests-Remaining=${creditsRemaining} is below safety floor of ${CREDITS_REMAINING_FLOOR}.`);
      console.error(`Processed ${i} of ${allDates.length} dates. Resume with --skip-test after credits reset.`);
      break;
    }

    try {
      // Capture credits before first non-skipped call to measure actual cost
      if (totalFetched === 0) {
        firstCallCreditsBefore = creditsRemaining;
      }

      const result = await fetchDate(gameDate, apiKey);

      if (result.skipped) {
        totalSkipped++;
      } else {
        totalFetched++;
        totalGames += result.gamesCount;

        if (result.requestsRemaining !== -1) {
          // Measure actual credit cost on the second fetch (after we have two data points)
          if (totalFetched === 2 && firstCallCreditsBefore !== -1 && creditsRemaining !== -1) {
            // creditsRemaining was set after call 1; result.requestsRemaining is after call 2
            const delta = creditsRemaining - result.requestsRemaining;
            if (delta > 0) {
              creditsPerCall = delta;
              console.log(`[INFO] Measured credit cost per call: ${creditsPerCall}`);
            }
          }
          creditsRemaining = result.requestsRemaining;
          totalCreditsUsed = result.requestsUsed;
        }

        console.log(
          `[${gameDate}] fetched, games=${result.gamesCount}, ` +
          `credits_used=${result.requestsUsed}, remaining=${result.requestsRemaining}`
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${gameDate}] ERROR: ${msg}`);
      errors.push(`${gameDate}: ${msg}`);

      // Hard stop on 4xx (already thrown by fetchWithRetry for non-429 4xx)
      if (msg.includes('4xx client error')) {
        console.error('[ABORT] Unrecoverable 4xx error. Fix before re-running.');
        process.exit(1);
      }
      // For other errors (network, 5xx exhausted), log and continue
    }

    // Small inter-request delay to be polite — historical endpoint has no documented rate limit
    // per minute but we avoid hammering with no delay
    await sleep(200);
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log('\n=== BACKFILL COMPLETE ===');
  console.log(`Dates fetched:    ${totalFetched}`);
  console.log(`Dates skipped:    ${totalSkipped} (already on disk)`);
  console.log(`Total games:      ${totalGames}`);
  console.log(`Credits used:     ${totalCreditsUsed}`);
  console.log(`Credits remaining: ${creditsRemaining}`);
  console.log(`Measured cost/call: ${creditsPerCall} credits`);
  console.log(`Errors (${errors.length}):`);
  for (const e of errors) {
    console.log(`  ${e}`);
  }
  console.log('');

  if (errors.length > 0) {
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
