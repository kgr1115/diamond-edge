/**
 * Per-game historical odds backfill — re-pull at `game_time_utc - 75min` per game.
 *
 * REPLACES the per-game-date batched approach in run.ts which silently mis-stamped
 * snapshots (it requested 03:00 UTC next-day for every game, recording wall-clock
 * 1-4 hours AFTER first pitch on night games). See:
 *   - docs/audits/moneyline-v0-backfill-results-2026-04-30.json (audit finding)
 *   - docs/proposals/moneyline-v0-2026-04-30-rev3-three-blockers-verdict-ceng.md
 *   - docs/proposals/moneyline-v0-2026-04-30-rev3-backfill-option-verdict-coo.md
 *
 * Source: The Odds API v4 historical endpoint
 * Endpoint: GET /v4/historical/sports/baseball_mlb/odds
 * Credit cost: 10 credits/call (historical multiplier) × 1 market (h2h) = 10 credits/call
 *   For full 2022-09 → 2024 (~5,000 finals), projected ~50K credits. COO ceiling 100K.
 *   For 2024-only fallback (~2,400 finals), projected ~24K credits. COO 7K cap → use --window=2024-fallback.
 *
 * Output: data/historical-odds-pergame/{year}/{game_id}.json (one file per game)
 *   The response's top-level `timestamp` field is the actual archived snap returned
 *   by the API and gets stored verbatim by the loader (03b-odds-historical-pergame.mjs)
 *   into odds.snapshotted_at.
 *
 * Idempotency: skips files that already exist with a populated `data` array.
 *
 * COO conditions enforced:
 *   - script_fix_committed: snapshot is computed per-game as game_time_utc - 75min,
 *     not per-batch wall-clock.
 *   - credit_reconciliation_extended: per-month credit ledger emitted to a JSON
 *     receipt file at the end of the run.
 *   - hard_halt_at_100k: explicit X-Requests-Remaining floor check between calls.
 *   - snap_param_validation: probe step (check-v0-snap-param-probe.mjs) gates this
 *     script; do not run before the probe passes.
 *   - reuse_existing_cron_telemetry: structured JSON logs for every fetch.
 *
 * CEng conditions enforced:
 *   - per_game_snapshot_param: target = game_time_utc - 75min per game.
 *   - response_timestamp_recorded: the loader (03b) reads raw.timestamp from the
 *     persisted file and writes it to snapshotted_at. This script preserves the
 *     entire response body so the loader has access to the API's actual snap time.
 *   - credit_ceiling: hard cap at 100K credits.
 *
 * USAGE:
 *   tsx run-per-game.ts --probe         # tiny dry-run on 5 games (~50 credits)
 *   tsx run-per-game.ts --window=2024   # 2024 only (Option C / fallback)
 *   tsx run-per-game.ts --window=full   # 2022-09 → 2024 (Option B / primary)
 *   tsx run-per-game.ts --skip-precheck # skip 5-second confirmation pause
 */

import * as fs from 'fs';
import * as path from 'path';
import pg from 'pg';
import { computeSnapshotParam, SNAPSHOT_OFFSET_MIN } from './snapshot-param.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';
const HISTORICAL_ENDPOINT = `${ODDS_API_BASE}/historical/sports/baseball_mlb/odds`;
// SNAPSHOT_OFFSET_MIN imported from snapshot-param.ts (single source of truth)
const HARD_CREDIT_FLOOR = 100; // X-Requests-Remaining floor — abort if remaining < this
const COO_CREDIT_CEILING = 100_000; // hard halt total burn
const REGION = 'us';
const MARKETS = 'h2h'; // moneyline only for v0 — keeps cost at 10 credits/call
const BOOKMAKERS = 'draftkings,fanduel';

const RETRY = {
  MAX_ATTEMPTS: 6,
  BASE_BACKOFF_MS: 2_000,
  MAX_BACKOFF_MS: 60_000,
};

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

let _repoRoot: string | null = null;
function repoRoot(): string {
  if (_repoRoot) return _repoRoot;
  const scriptDir = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
  _repoRoot = path.resolve(scriptDir, '..', '..');
  return _repoRoot;
}

// ---------------------------------------------------------------------------
// Per-game snapshot timestamp computation lives in ./snapshot-param.ts so the
// regression test can import it without pulling in pg / fs.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// HTTP fetch with retry + exponential backoff
// ---------------------------------------------------------------------------

interface FetchResult {
  body: { timestamp?: string; data?: unknown[]; previous_timestamp?: string; next_timestamp?: string };
  requestsUsed: number;
  requestsRemaining: number;
  status: number;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string, label: string): Promise<FetchResult> {
  let lastError: Error = new Error('Unknown error');

  for (let attempt = 0; attempt < RETRY.MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const backoffMs = Math.min(
        RETRY.BASE_BACKOFF_MS * Math.pow(2, attempt - 1),
        RETRY.MAX_BACKOFF_MS,
      );
      console.log(JSON.stringify({ level: 'info', event: 'retry', label, attempt, backoffMs }));
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
      const body = await response.text();
      throw new Error(`[${label}] 4xx client error ${response.status}: ${body}`);
    }

    const body = (await response.json()) as FetchResult['body'];
    return { body, requestsUsed, requestsRemaining, status: response.status };
  }

  throw lastError;
}

// ---------------------------------------------------------------------------
// Output paths
// ---------------------------------------------------------------------------

function outputDir(year: number): string {
  return path.join(repoRoot(), 'data', 'historical-odds-pergame', String(year));
}

function outputPath(year: number, gameId: string): string {
  return path.join(outputDir(year), `${gameId}.json`);
}

function alreadyFetched(year: number, gameId: string): boolean {
  const fp = outputPath(year, gameId);
  if (!fs.existsSync(fp)) return false;
  try {
    const raw = fs.readFileSync(fp, 'utf-8').trim();
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    // Accept any non-empty payload (even data: [] is a valid response when no games match)
    return typeof parsed === 'object' && parsed !== null && 'timestamp' in parsed;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Game enumeration from DB
// ---------------------------------------------------------------------------

interface GameRow {
  game_id: string;
  game_date: string;
  game_time_utc: string;
  home_name: string;
  away_name: string;
}

function dateRangeForWindow(window: 'full' | '2024' | 'probe'): { startDate: string; endDate: string } {
  if (window === 'full') return { startDate: '2022-09-01', endDate: '2024-12-31' };
  if (window === '2024') return { startDate: '2024-03-01', endDate: '2024-12-31' };
  // Probe: just 5 games on the snap-param probe date
  return { startDate: '2024-07-23', endDate: '2024-07-23' };
}

async function loadGames(window: 'full' | '2024' | 'probe'): Promise<GameRow[]> {
  const { startDate, endDate } = dateRangeForWindow(window);

  const client = new pg.Client({
    connectionString: process.env.SUPABASE_DB_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  const { rows } = await client.query<GameRow>(
    `SELECT g.id::text                  AS game_id,
            g.game_date::text           AS game_date,
            g.game_time_utc::text       AS game_time_utc,
            ht.name                     AS home_name,
            at.name                     AS away_name
     FROM games g
     JOIN teams ht ON ht.id = g.home_team_id
     JOIN teams at ON at.id = g.away_team_id
     WHERE g.game_date >= $1::date
       AND g.game_date <= $2::date
       AND g.status = 'final'
       AND g.game_time_utc IS NOT NULL
     ORDER BY g.game_time_utc`,
    [startDate, endDate],
  );
  await client.end();

  if (window === 'probe') return rows.slice(0, 5);
  return rows;
}

// ---------------------------------------------------------------------------
// Single game fetch
// ---------------------------------------------------------------------------

async function fetchGame(g: GameRow, apiKey: string): Promise<{
  fetched: boolean;
  apiTimestamp: string | null;
  gamesInResponse: number;
  requestsUsed: number;
  requestsRemaining: number;
  skipReason?: string;
}> {
  const year = parseInt(g.game_date.slice(0, 4), 10);

  if (alreadyFetched(year, g.game_id)) {
    return { fetched: false, apiTimestamp: null, gamesInResponse: 0, requestsUsed: 0, requestsRemaining: -1, skipReason: 'file_exists' };
  }

  const snapshotParam = computeSnapshotParam(g.game_time_utc);
  const url = new URL(HISTORICAL_ENDPOINT);
  url.searchParams.set('apiKey', apiKey);
  url.searchParams.set('regions', REGION);
  url.searchParams.set('markets', MARKETS);
  url.searchParams.set('bookmakers', BOOKMAKERS);
  url.searchParams.set('date', snapshotParam);
  url.searchParams.set('oddsFormat', 'american');

  const label = `${g.game_date}/${g.game_id}`;
  const { body, requestsUsed, requestsRemaining } = await fetchWithRetry(url.toString(), label);

  const dir = outputDir(year);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outputPath(year, g.game_id), JSON.stringify(body), 'utf-8');

  return {
    fetched: true,
    apiTimestamp: body.timestamp ?? null,
    gamesInResponse: Array.isArray(body.data) ? body.data.length : 0,
    requestsUsed,
    requestsRemaining,
  };
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

interface MonthLedgerEntry {
  month: string; // YYYY-MM
  games_processed: number;
  games_fetched: number;
  games_skipped: number;
  credits_used_during_month: number;
  credits_remaining_after_month: number;
}

async function main(): Promise<void> {
  loadEnv();

  const apiKey = process.env.THE_ODDS_API_KEY;
  if (!apiKey) {
    console.error('[ERROR] THE_ODDS_API_KEY not set');
    process.exit(1);
  }
  if (!process.env.SUPABASE_DB_URL) {
    console.error('[ERROR] SUPABASE_DB_URL not set');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const skipPrecheck = args.includes('--skip-precheck');
  let window: 'full' | '2024' | 'probe' = 'full';
  if (args.includes('--probe')) window = 'probe';
  else if (args.find(a => a.startsWith('--window='))) {
    const w = args.find(a => a.startsWith('--window='))!.slice('--window='.length);
    if (w === '2024') window = '2024';
    else if (w === 'full') window = 'full';
    else { console.error(`[ERROR] unknown --window=${w}`); process.exit(1); }
  }

  console.log(`\n=== PER-GAME HISTORICAL ODDS RE-PULL ===`);
  console.log(`Window: ${window}`);
  console.log(`Snapshot offset: game_time_utc - ${SNAPSHOT_OFFSET_MIN}min`);
  console.log(`Credit ceiling (hard halt): ${COO_CREDIT_CEILING}`);
  console.log(`X-Requests-Remaining floor: ${HARD_CREDIT_FLOOR}\n`);

  const games = await loadGames(window);
  console.log(`Games to process: ${games.length}`);
  console.log(`Estimated credit cost: ${games.length * 10} credits (h2h only, 10 credits/call)\n`);

  if (games.length * 10 > COO_CREDIT_CEILING) {
    console.error(`[ABORT] Estimated cost ${games.length * 10} exceeds ceiling ${COO_CREDIT_CEILING}`);
    process.exit(1);
  }

  if (!skipPrecheck && window !== 'probe') {
    console.log('Starting in 5 seconds... Ctrl+C to abort.');
    await sleep(5_000);
  }

  let totalFetched = 0;
  let totalSkipped = 0;
  let totalGamesInResponses = 0;
  let initialCreditsUsed = -1;
  let lastCreditsUsed = -1;
  let lastCreditsRemaining = -1;
  const errors: Array<{ game_id: string; date: string; error: string }> = [];

  // Per-month ledger
  const monthLedger = new Map<string, MonthLedgerEntry>();
  function getMonthEntry(date: string): MonthLedgerEntry {
    const m = date.slice(0, 7);
    let e = monthLedger.get(m);
    if (!e) {
      e = {
        month: m, games_processed: 0, games_fetched: 0, games_skipped: 0,
        credits_used_during_month: 0, credits_remaining_after_month: -1,
      };
      monthLedger.set(m, e);
    }
    return e;
  }

  let creditsAtMonthStart = -1;
  let prevMonth = '';

  for (let i = 0; i < games.length; i++) {
    const g = games[i];
    if (!g) continue; // satisfy noUncheckedIndexedAccess; loop bound makes this dead
    const monthKey = g.game_date.slice(0, 7);
    if (monthKey !== prevMonth) {
      // Close out previous month ledger
      if (prevMonth && creditsAtMonthStart !== -1 && lastCreditsUsed !== -1) {
        const prevEntry = monthLedger.get(prevMonth)!;
        prevEntry.credits_used_during_month = lastCreditsUsed - creditsAtMonthStart;
        prevEntry.credits_remaining_after_month = lastCreditsRemaining;
      }
      creditsAtMonthStart = lastCreditsUsed === -1 ? 0 : lastCreditsUsed;
      prevMonth = monthKey;
    }

    const monthEntry = getMonthEntry(g.game_date);
    monthEntry.games_processed++;

    // Hard halt check
    if (lastCreditsRemaining !== -1 && lastCreditsRemaining < HARD_CREDIT_FLOOR) {
      console.error(`\n[HARD HALT] X-Requests-Remaining=${lastCreditsRemaining} < floor ${HARD_CREDIT_FLOOR}. Aborting at game ${i + 1}/${games.length}.`);
      break;
    }

    if (initialCreditsUsed !== -1 && (lastCreditsUsed - initialCreditsUsed) >= COO_CREDIT_CEILING) {
      console.error(`\n[HARD HALT] Total burn ${lastCreditsUsed - initialCreditsUsed} >= COO ceiling ${COO_CREDIT_CEILING}. Aborting at game ${i + 1}/${games.length}.`);
      break;
    }

    try {
      const result = await fetchGame(g, apiKey);

      if (!result.fetched) {
        totalSkipped++;
        monthEntry.games_skipped++;
        if ((i + 1) % 100 === 0) {
          console.log(`[${i + 1}/${games.length}] progress: fetched=${totalFetched} skipped=${totalSkipped} remaining=${lastCreditsRemaining}`);
        }
        continue;
      }

      totalFetched++;
      monthEntry.games_fetched++;
      totalGamesInResponses += result.gamesInResponse;

      if (result.requestsUsed !== -1) {
        if (initialCreditsUsed === -1) initialCreditsUsed = result.requestsUsed - 10;
        lastCreditsUsed = result.requestsUsed;
        lastCreditsRemaining = result.requestsRemaining;
      }

      if ((i + 1) % 50 === 0 || i < 5) {
        console.log(JSON.stringify({
          level: 'info', event: 'progress',
          idx: i + 1, total: games.length,
          game_id: g.game_id, game_date: g.game_date,
          api_timestamp: result.apiTimestamp,
          games_in_response: result.gamesInResponse,
          requests_used: result.requestsUsed,
          requests_remaining: result.requestsRemaining,
        }));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${g.game_date}/${g.game_id}] ERROR: ${msg}`);
      errors.push({ game_id: g.game_id, date: g.game_date, error: msg });
      if (msg.includes('4xx client error')) {
        console.error('[ABORT] 4xx — fix before re-running.');
        break;
      }
    }

    await sleep(150); // polite delay
  }

  // Close out final month
  if (prevMonth && creditsAtMonthStart !== -1 && lastCreditsUsed !== -1) {
    const prevEntry = monthLedger.get(prevMonth)!;
    prevEntry.credits_used_during_month = lastCreditsUsed - creditsAtMonthStart;
    prevEntry.credits_remaining_after_month = lastCreditsRemaining;
  }

  // ---------------------------------------------------------------------------
  // Receipt + summary
  // ---------------------------------------------------------------------------
  const totalBurn = initialCreditsUsed === -1 ? 0 : lastCreditsUsed - initialCreditsUsed;

  const receipt = {
    run_completed_at_utc: new Date().toISOString(),
    window,
    snapshot_offset_min: SNAPSHOT_OFFSET_MIN,
    games_planned: games.length,
    games_fetched: totalFetched,
    games_skipped: totalSkipped,
    games_in_responses: totalGamesInResponses,
    initial_credits_used: initialCreditsUsed,
    final_credits_used: lastCreditsUsed,
    final_credits_remaining: lastCreditsRemaining,
    total_burn: totalBurn,
    coo_ceiling: COO_CREDIT_CEILING,
    coo_compliant: totalBurn <= COO_CREDIT_CEILING,
    error_count: errors.length,
    errors_sample: errors.slice(0, 20),
    monthly_ledger: [...monthLedger.values()],
  };

  const receiptPath = path.join(repoRoot(), 'docs', 'audits', `moneyline-v0-pergame-repull-receipt-${window}-${new Date().toISOString().slice(0, 10)}.json`);
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));

  console.log('\n=== PER-GAME RE-PULL COMPLETE ===');
  console.log(`Games fetched:    ${totalFetched}`);
  console.log(`Games skipped:    ${totalSkipped}`);
  console.log(`Errors:           ${errors.length}`);
  console.log(`Total credit burn: ${totalBurn}`);
  console.log(`Final remaining:  ${lastCreditsRemaining}`);
  console.log(`Receipt:          ${receiptPath}`);

  if (errors.length > 0) {
    process.exitCode = 1;
  }
}

// Run main only when invoked directly (not when imported by tests)
const isDirectInvocation = process.argv[1] && import.meta.url.includes(path.basename(process.argv[1]));
if (isDirectInvocation) {
  main().catch(err => {
    console.error('[FATAL]', err);
    process.exit(1);
  });
}
