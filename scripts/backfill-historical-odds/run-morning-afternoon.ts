/**
 * Historical odds backfill — morning + afternoon snapshots for 2022–2024.
 *
 * Evening snapshots (03:00 UTC next day) are already in data/historical-odds/.
 * This script adds two additional snapshot times per game day:
 *   Morning   14:00 UTC  (10 AM ET) — opening-prior proxy
 *   Afternoon 19:00 UTC  (3 PM ET)  — pre-game, lineups mostly locked
 *
 * Source: The Odds API v4 historical endpoint
 * Endpoint: GET /v4/historical/sports/baseball_mlb/odds
 * Credit cost: 10 credits/call (historical 10× multiplier) × 3 markets = 30 credits/call
 *
 * Output:
 *   data/historical-odds-morning/{year}/YYYY-MM-DD.json
 *   data/historical-odds-afternoon/{year}/YYYY-MM-DD.json
 *
 * Idempotent: skips dates where the target file exists and has a populated .data array.
 * Skips dates where the evening snapshot file contains zero games (no games played).
 *
 * In-game contamination guard (applied at fetch time):
 *   Morning  (14:00 UTC): prior-day day-games that ran late may produce in-game lines.
 *   Afternoon (19:00 UTC): late-afternoon day-games (start 3–4 PM ET) may be live.
 *   Guard: h2h outcomes where abs(price) > 500 are rejected — identical threshold to
 *   the load_historical_odds.py parser fix in commit 49756e2. Count is logged per
 *   snapshot for auditing.
 *
 * Budget guardrail: aborts if X-Requests-Remaining drops below 40,000.
 * Pre-run cost estimate: printed before any API call is made; user can abort.
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';
const HISTORICAL_ENDPOINT = `${ODDS_API_BASE}/historical/sports/baseball_mlb/odds`;

// Stop and report if remaining drops below this value.
// Leaves headroom for live daily ingestion for the rest of the month.
const CREDITS_REMAINING_FLOOR = 40_000;

// Cost estimate ceiling — pre-run check aborts if projected > this value.
const COST_ESTIMATE_CEILING = 40_000;

// Snapshot hours (UTC) for the two new time slots.
// Morning:   14:00 UTC = 10:00 AM EDT (UTC-4, daylight saving — MLB season)
// Afternoon: 19:00 UTC = 15:00 PM EDT
const SNAPSHOTS: Array<{ slot: 'morning' | 'afternoon'; hourUtc: number }> = [
  { slot: 'morning', hourUtc: 14 },
  { slot: 'afternoon', hourUtc: 19 },
];

const RETRY = {
  MAX_ATTEMPTS: 6,
  BASE_BACKOFF_MS: 2_000,
  MAX_BACKOFF_MS: 60_000,
};

const BOOKMAKERS = ['draftkings', 'fanduel'];
const MARKETS = ['h2h', 'spreads', 'totals'];

// In-game h2h sentinel threshold — identical to load_historical_odds.py guard.
// Pre-game MLB moneylines are always within ±500.
const IN_GAME_PRICE_THRESHOLD = 500;

// Credits per call (historical 10× multiplier × 3 markets).
const CREDITS_PER_CALL = 30;

// ---------------------------------------------------------------------------
// Season date ranges + All-Star break skip list
// ---------------------------------------------------------------------------

const ALL_STAR_SKIP = new Set<string>([
  // 2022 — All-Star break Jul 18–21
  '2022-07-18', '2022-07-19', '2022-07-20', '2022-07-21',
  // 2023 — All-Star break Jul 10–13
  '2023-07-10', '2023-07-11', '2023-07-12', '2023-07-13',
  // 2024 — All-Star break Jul 15–18
  '2024-07-15', '2024-07-16', '2024-07-17', '2024-07-18',
]);

const SEASONS: Array<{ start: string; end: string }> = [
  { start: '2022-04-07', end: '2022-11-05' },
  { start: '2023-03-30', end: '2023-11-02' },
  { start: '2024-03-28', end: '2024-10-31' },
];

// ---------------------------------------------------------------------------
// Env loading
// ---------------------------------------------------------------------------

function loadEnv(): void {
  const scriptDir = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
  const repoRoot = path.resolve(scriptDir, '..', '..');
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

/**
 * Build the snapshot date param for morning/afternoon slots.
 * Both fall on the same calendar day as the game date (unlike evening which
 * is 03:00 UTC the following day).
 */
function snapshotParam(gameDate: string, hourUtc: number): string {
  const hh = String(hourUtc).padStart(2, '0');
  return `${gameDate}T${hh}:00:00Z`;
}

// ---------------------------------------------------------------------------
// Repo-root resolver (called once, cached)
// ---------------------------------------------------------------------------

let _repoRoot: string | null = null;
function repoRoot(): string {
  if (_repoRoot) return _repoRoot;
  const scriptDir = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
  _repoRoot = path.resolve(scriptDir, '..', '..');
  return _repoRoot;
}

// ---------------------------------------------------------------------------
// Output paths
// ---------------------------------------------------------------------------

function outputDir(slot: 'morning' | 'afternoon', year: number): string {
  return path.join(repoRoot(), 'data', `historical-odds-${slot}`, String(year));
}

function outputPath(slot: 'morning' | 'afternoon', gameDate: string): string {
  const year = parseInt(gameDate.slice(0, 4), 10);
  return path.join(outputDir(slot, year), `${gameDate}.json`);
}

/** Path to the existing evening snapshot for this game date. */
function eveningPath(gameDate: string): string {
  const year = parseInt(gameDate.slice(0, 4), 10);
  return path.join(repoRoot(), 'data', 'historical-odds', String(year), `${gameDate}.json`);
}

// ---------------------------------------------------------------------------
// Idempotency + skip guards
// ---------------------------------------------------------------------------

function alreadyFetched(slot: 'morning' | 'afternoon', gameDate: string): boolean {
  const filePath = outputPath(slot, gameDate);
  if (!fs.existsSync(filePath)) return false;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.data);
  } catch {
    return false;
  }
}

/**
 * Return true if the evening snapshot for this date has zero games.
 * Means no MLB games were played — skip to save credits.
 */
function eveningHasZeroGames(gameDate: string): boolean {
  const fp = eveningPath(gameDate);
  if (!fs.existsSync(fp)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(fp, 'utf-8').trim());
    return Array.isArray(parsed.data) && parsed.data.length === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// In-game contamination filter
// ---------------------------------------------------------------------------

interface FilterResult {
  filteredGames: unknown[];
  sentinelRowsRemoved: number;
}

/**
 * Apply the in-game h2h sentinel guard to a raw API response body.
 * Games where every h2h outcome for a given bookmaker has abs(price) > 500
 * are flagged as in-game captures. We remove those bookmaker-market entries
 * from the game rather than dropping the whole game — a game may have one
 * book's h2h contaminated while spreads/totals are still valid pre-game lines.
 *
 * "Sentinel row" count = number of (game × bookmaker × market) triples
 * where all h2h prices exceeded the threshold and were stripped.
 */
function filterInGameSentinels(body: unknown): FilterResult {
  const blob = body as { timestamp?: string; data?: unknown[] };
  if (!Array.isArray(blob.data)) return { filteredGames: [], sentinelRowsRemoved: 0 };

  let sentinelRowsRemoved = 0;
  const filteredGames: unknown[] = [];

  for (const game of blob.data) {
    const g = game as {
      bookmakers?: Array<{
        key: string;
        markets?: Array<{ key: string; outcomes?: Array<{ price?: number; name?: string; point?: number }> }>;
      }>;
    };

    let gameSentinels = 0;

    if (Array.isArray(g.bookmakers)) {
      for (const bm of g.bookmakers) {
        if (!Array.isArray(bm.markets)) continue;
        for (const market of bm.markets) {
          if (market.key !== 'h2h') continue;
          if (!Array.isArray(market.outcomes)) continue;

          const before = market.outcomes.length;
          market.outcomes = market.outcomes.filter(o => {
            if (o.price === null || o.price === undefined) return true;
            return Math.abs(o.price) <= IN_GAME_PRICE_THRESHOLD;
          });
          const removed = before - market.outcomes.length;
          if (removed > 0) {
            gameSentinels += removed;
          }
        }
      }
    }

    if (gameSentinels > 0) {
      sentinelRowsRemoved += gameSentinels;
    }

    filteredGames.push(game);
  }

  return { filteredGames, sentinelRowsRemoved };
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

async function fetchWithRetry(url: string, label: string): Promise<FetchResult> {
  let lastError: Error = new Error('Unknown error');

  for (let attempt = 0; attempt < RETRY.MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const backoffMs = Math.min(
        RETRY.BASE_BACKOFF_MS * Math.pow(2, attempt - 1),
        RETRY.MAX_BACKOFF_MS
      );
      console.log(`[${label}] retry attempt=${attempt}, backoff=${backoffMs}ms`);
      await sleep(backoffMs);
    }

    let response: Response;
    try {
      response = await fetch(url);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.error(JSON.stringify({
        level: 'error', event: 'network_error', label, attempt, err: lastError.message,
      }));
      continue;
    }

    const requestsUsed = parseInt(response.headers.get('x-requests-used') ?? '-1', 10);
    const requestsRemaining = parseInt(response.headers.get('x-requests-remaining') ?? '-1', 10);

    if (response.status === 429) {
      const retryAfterRaw = response.headers.get('retry-after');
      const retryAfterMs = retryAfterRaw ? parseInt(retryAfterRaw, 10) * 1000 : 60_000;
      console.error(JSON.stringify({
        level: 'error', event: 'rate_limited', label, attempt,
        retryAfterMs, requestsUsed, requestsRemaining,
      }));
      lastError = new Error('429 rate limited');
      await sleep(Math.min(retryAfterMs, RETRY.MAX_BACKOFF_MS));
      continue;
    }

    if (response.status >= 500) {
      console.error(JSON.stringify({
        level: 'error', event: 'server_error', label, attempt, status: response.status,
      }));
      lastError = new Error(`5xx: ${response.status}`);
      continue;
    }

    if (!response.ok) {
      // 4xx other than 429 — caller error, abort immediately
      const errBody = await response.text();
      throw new Error(`[${label}] 4xx client error ${response.status}: ${errBody}`);
    }

    const body = await response.json();
    return { body, requestsUsed, requestsRemaining };
  }

  throw lastError;
}

// ---------------------------------------------------------------------------
// Single snapshot fetch
// ---------------------------------------------------------------------------

interface SnapshotResult {
  gamesCount: number;
  sentinelRowsRemoved: number;
  requestsUsed: number;
  requestsRemaining: number;
  skipped: boolean;
  skipReason?: string;
}

async function fetchSnapshot(
  gameDate: string,
  slot: 'morning' | 'afternoon',
  hourUtc: number,
  apiKey: string,
): Promise<SnapshotResult> {
  const label = `${gameDate}/${slot}`;

  if (alreadyFetched(slot, gameDate)) {
    console.log(`[${label}] skipped (file exists)`);
    return { gamesCount: 0, sentinelRowsRemoved: 0, requestsUsed: 0, requestsRemaining: -1, skipped: true, skipReason: 'file_exists' };
  }

  if (eveningHasZeroGames(gameDate)) {
    console.log(`[${label}] skipped (evening file has zero games — no games on this date)`);
    return { gamesCount: 0, sentinelRowsRemoved: 0, requestsUsed: 0, requestsRemaining: -1, skipped: true, skipReason: 'no_games' };
  }

  const snapshotDate = snapshotParam(gameDate, hourUtc);
  const url = new URL(HISTORICAL_ENDPOINT);
  url.searchParams.set('apiKey', apiKey);
  url.searchParams.set('regions', 'us');
  url.searchParams.set('markets', MARKETS.join(','));
  url.searchParams.set('bookmakers', BOOKMAKERS.join(','));
  url.searchParams.set('date', snapshotDate);
  url.searchParams.set('oddsFormat', 'american');

  const { body, requestsUsed, requestsRemaining } = await fetchWithRetry(url.toString(), label);

  // Apply in-game sentinel filter before persisting
  const { filteredGames, sentinelRowsRemoved } = filterInGameSentinels(body);

  if (sentinelRowsRemoved > 0) {
    console.log(JSON.stringify({
      level: 'warn',
      event: 'in_game_sentinels_filtered',
      label,
      snapshotDate,
      sentinelOutcomesRemoved: sentinelRowsRemoved,
    }));
  }

  // Write filtered response (replaces body.data with filteredGames)
  const persistBody = { ...(body as object), data: filteredGames };
  const year = parseInt(gameDate.slice(0, 4), 10);
  fs.mkdirSync(outputDir(slot, year), { recursive: true });
  fs.writeFileSync(outputPath(slot, gameDate), JSON.stringify(persistBody), 'utf-8');

  const gamesCount = filteredGames.length;

  console.log(JSON.stringify({
    level: 'info',
    event: 'snapshot_fetched',
    label,
    snapshotDate,
    gamesCount,
    sentinelOutcomesRemoved: sentinelRowsRemoved,
    requestsUsed,
    requestsRemaining,
  }));

  return { gamesCount, sentinelRowsRemoved, requestsUsed, requestsRemaining, skipped: false };
}

// ---------------------------------------------------------------------------
// Pre-run cost estimate
// ---------------------------------------------------------------------------

function computeCostEstimate(): { gameDays: number; projectedCalls: number; projectedCredits: number } {
  const gameDays: string[] = [];
  for (const season of SEASONS) {
    for (const d of dateRange(season.start, season.end)) {
      if (ALL_STAR_SKIP.has(d)) continue;
      if (eveningHasZeroGames(d)) continue;
      gameDays.push(d);
    }
  }

  // Subtract already-fetched snapshots from both slots
  let projectedCalls = 0;
  for (const d of gameDays) {
    for (const { slot } of SNAPSHOTS) {
      if (!alreadyFetched(slot, d)) {
        projectedCalls++;
      }
    }
  }

  return {
    gameDays: gameDays.length,
    projectedCalls,
    projectedCredits: projectedCalls * CREDITS_PER_CALL,
  };
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
  const skipPrecheck = args.includes('--skip-precheck');

  // Pre-run cost estimate
  const estimate = computeCostEstimate();
  console.log('\n=== PRE-RUN COST ESTIMATE ===');
  console.log(`Game days with data (evening non-empty): ${estimate.gameDays}`);
  console.log(`Projected API calls (2 slots, minus already-fetched): ${estimate.projectedCalls}`);
  console.log(`Projected credits: ${estimate.projectedCredits} (@ ${CREDITS_PER_CALL} credits/call)`);
  console.log(`Credit ceiling before abort: ${COST_ESTIMATE_CEILING}`);

  if (estimate.projectedCredits > COST_ESTIMATE_CEILING) {
    console.error(
      `\n[ABORT] Projected credit spend (${estimate.projectedCredits}) exceeds ceiling ` +
      `(${COST_ESTIMATE_CEILING}). Requires explicit approval before proceeding.\n`
    );
    process.exit(1);
  }

  console.log(`[OK] Projected cost within ceiling. Proceeding.\n`);

  if (!skipPrecheck) {
    console.log('Starting backfill in 5 seconds... Press Ctrl+C to abort.');
    await sleep(5_000);
  }

  // Build ordered work list: iterate dates, then slots within each date.
  // Morning and afternoon for a date are fetched sequentially so we can
  // check the credit floor between calls.
  const allDates: string[] = [];
  for (const season of SEASONS) {
    for (const d of dateRange(season.start, season.end)) {
      if (!ALL_STAR_SKIP.has(d)) {
        allDates.push(d);
      }
    }
  }

  let totalFetched = 0;
  let totalSkipped = 0;
  let totalGames = 0;
  let totalSentinelOutcomesRemoved = 0;
  let creditsRemaining = -1;
  let totalCreditsUsed = 0;
  const errors: string[] = [];
  const skippedNoGames: string[] = [];

  // Per-year/slot counters for the return summary
  const yearSlotCounts: Record<string, number> = {};

  for (const gameDate of allDates) {
    // Evening zero-game guard (applies to all slots for this date)
    if (eveningHasZeroGames(gameDate)) {
      skippedNoGames.push(gameDate);
      continue;
    }

    for (const { slot, hourUtc } of SNAPSHOTS) {
      // Credit floor guard before each call
      if (creditsRemaining !== -1 && creditsRemaining < CREDITS_REMAINING_FLOOR) {
        console.error(
          `\n[ABORT] X-Requests-Remaining=${creditsRemaining} dropped below floor of ` +
          `${CREDITS_REMAINING_FLOOR}. Halting to preserve live-ingestion headroom.`
        );
        console.error(
          `Fetched ${totalFetched} snapshots. Re-run with --skip-precheck to resume ` +
          `(already-fetched files are skipped automatically).`
        );
        printSummary(totalFetched, totalSkipped, totalGames, totalSentinelOutcomesRemoved,
          totalCreditsUsed, creditsRemaining, errors, skippedNoGames, yearSlotCounts);
        process.exit(1);
      }

      if (alreadyFetched(slot, gameDate)) {
        totalSkipped++;
        continue;
      }

      try {
        const result = await fetchSnapshot(gameDate, slot, hourUtc, apiKey);

        if (result.skipped) {
          totalSkipped++;
        } else {
          totalFetched++;
          totalGames += result.gamesCount;
          totalSentinelOutcomesRemoved += result.sentinelRowsRemoved;

          if (result.requestsRemaining !== -1) {
            creditsRemaining = result.requestsRemaining;
            totalCreditsUsed = result.requestsUsed;
          }

          const year = gameDate.slice(0, 4);
          const key = `${year}/${slot}`;
          yearSlotCounts[key] = (yearSlotCounts[key] ?? 0) + 1;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const label = `${gameDate}/${slot}`;
        console.error(`[${label}] ERROR: ${msg}`);
        errors.push(`${label}: ${msg}`);

        if (msg.includes('4xx client error')) {
          console.error('[ABORT] Unrecoverable 4xx error. Fix before re-running.');
          process.exit(1);
        }
        // Network or 5xx exhausted — log and continue to next slot/date
      }

      // Polite inter-request delay
      await sleep(200);
    }
  }

  printSummary(totalFetched, totalSkipped, totalGames, totalSentinelOutcomesRemoved,
    totalCreditsUsed, creditsRemaining, errors, skippedNoGames, yearSlotCounts);

  if (errors.length > 0) {
    process.exitCode = 1;
  }
}

function printSummary(
  totalFetched: number,
  totalSkipped: number,
  totalGames: number,
  totalSentinelOutcomesRemoved: number,
  totalCreditsUsed: number,
  creditsRemaining: number,
  errors: string[],
  skippedNoGames: string[],
  yearSlotCounts: Record<string, number>,
): void {
  console.log('\n=== BACKFILL COMPLETE ===');
  console.log(`Snapshots fetched:            ${totalFetched}`);
  console.log(`Snapshots skipped:            ${totalSkipped} (file exists or zero-game day)`);
  console.log(`Game-day dates with no games: ${skippedNoGames.length}`);
  console.log(`Total game entries written:   ${totalGames}`);
  console.log(`In-game sentinel outcomes removed: ${totalSentinelOutcomesRemoved}`);
  console.log(`Credits used (cumulative):    ${totalCreditsUsed}`);
  console.log(`Credits remaining:            ${creditsRemaining}`);
  console.log('');
  console.log('Files written per year/slot:');
  for (const [key, count] of Object.entries(yearSlotCounts).sort()) {
    console.log(`  ${key}: ${count} files`);
  }
  console.log('');
  if (errors.length > 0) {
    console.log(`Errors (${errors.length}):`);
    for (const e of errors) {
      console.log(`  ${e}`);
    }
  } else {
    console.log('Errors: none');
  }
  console.log('');
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
