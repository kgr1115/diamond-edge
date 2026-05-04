/**
 * Diagnose the October 2024 gap:
 * - Find games in DB with game_date >= 2024-09-30 and status=final that have
 *   no closing_snapshot odds row with source = 'odds_api_historical_pergame'
 * - For each, check whether the file exists on disk
 * - Report credit balance
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const PERGAME_ROOT = join(REPO_ROOT, 'data', 'historical-odds-pergame');

const env = Object.fromEntries(
  readFileSync(join(REPO_ROOT, '.env'), 'utf8')
    .split('\n').filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => { const e = l.indexOf('='); return [l.slice(0, e).trim(), l.slice(e + 1).trim()]; })
);

const c = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

const SOURCE_TAG = 'odds_api_historical_pergame';

console.log('=== October 2024 Gap Diagnostic ===\n');

// 1. Find missing games
const { rows: missing } = await c.query(`
  SELECT g.id::text AS game_id,
         g.game_date::text AS game_date,
         g.game_time_utc::text AS game_time_utc,
         ht.name AS home_name,
         at.name AS away_name
  FROM games g
  JOIN teams ht ON ht.id = g.home_team_id
  JOIN teams at ON at.id = g.away_team_id
  WHERE g.game_date >= '2024-09-30'
    AND g.game_date <= '2024-12-31'
    AND g.status = 'final'
    AND g.game_time_utc IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM odds o
      WHERE o.game_id = g.id
        AND o.market = 'moneyline'
        AND o.closing_snapshot = true
        AND o.source = $1
    )
  ORDER BY g.game_time_utc
`, [SOURCE_TAG]);

console.log(`Missing games (no closing snapshot in DB): ${missing.length}`);

// 2. Check which ones have files on disk vs not
let filesOnDisk = 0;
let filesMissing = 0;
const gamesNeedingPull = [];
const gamesNeedingLoad = [];

for (const g of missing) {
  const filePath = join(PERGAME_ROOT, '2024', `${g.game_id}.json`);
  if (existsSync(filePath)) {
    filesOnDisk++;
    gamesNeedingLoad.push(g);
  } else {
    filesMissing++;
    gamesNeedingPull.push(g);
  }
}

console.log(`  Files already on disk (need loader re-run): ${filesOnDisk}`);
console.log(`  Files missing from disk (need API pull): ${filesMissing}`);

// 3. For games with files on disk, inspect the file contents
let noTimestamp = 0;
let noMatchingGame = 0;
let hasValidData = 0;
let parseError = 0;

for (const g of gamesNeedingLoad.slice(0, 50)) {
  const filePath = join(PERGAME_ROOT, '2024', `${g.game_id}.json`);
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!raw.timestamp) {
      noTimestamp++;
    } else if (!Array.isArray(raw.data) || raw.data.length === 0) {
      noMatchingGame++;
    } else {
      hasValidData++;
    }
  } catch {
    parseError++;
  }
}

if (gamesNeedingLoad.length > 0) {
  console.log(`\nFile content analysis (first ${Math.min(50, gamesNeedingLoad.length)} files with disk data):`);
  console.log(`  Has valid timestamp + data: ${hasValidData}`);
  console.log(`  Missing timestamp: ${noTimestamp}`);
  console.log(`  Empty data array: ${noMatchingGame}`);
  console.log(`  Parse errors: ${parseError}`);
}

// Full scan of all gamesNeedingLoad files
let allNoTimestamp = 0;
let allNoData = 0;
let allHasData = 0;
let allParseError = 0;

for (const g of gamesNeedingLoad) {
  const filePath = join(PERGAME_ROOT, '2024', `${g.game_id}.json`);
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!raw.timestamp) {
      allNoTimestamp++;
    } else if (!Array.isArray(raw.data) || raw.data.length === 0) {
      allNoData++;
    } else {
      allHasData++;
    }
  } catch {
    allParseError++;
  }
}

console.log(`\nFull file scan for all ${gamesNeedingLoad.length} on-disk games:`);
console.log(`  Has valid timestamp + data: ${allHasData}`);
console.log(`  Missing timestamp: ${allNoTimestamp}`);
console.log(`  Empty data array (data:[]): ${allNoData}`);
console.log(`  Parse errors: ${allParseError}`);

// 4. Show some sample missing games (need pull)
if (gamesNeedingPull.length > 0) {
  console.log(`\nSample games needing API pull (first 10):`);
  for (const g of gamesNeedingPull.slice(0, 10)) {
    console.log(`  ${g.game_date} ${g.away_name} @ ${g.home_name} [${g.game_id}]`);
  }
}

// 5. Date distribution of missing games
const dateCounts = new Map();
for (const g of missing) {
  const d = g.game_date;
  dateCounts.set(d, (dateCounts.get(d) ?? 0) + 1);
}
const sortedDates = [...dateCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
console.log(`\nDate distribution of missing games:`);
for (const [date, count] of sortedDates) {
  console.log(`  ${date}: ${count}`);
}

// 6. Overall closing snapshot summary
const { rows: totals } = await c.query(`
  SELECT COUNT(*)::int AS total_rows,
         COUNT(DISTINCT game_id)::int AS games_covered
  FROM odds WHERE source = $1 AND closing_snapshot = true AND market = 'moneyline'
`, [SOURCE_TAG]);
console.log(`\nCurrent DB state (source=${SOURCE_TAG}):`);
console.log(`  Total closing rows: ${totals[0].total_rows}`);
console.log(`  Distinct games covered: ${totals[0].games_covered}`);

// 7. Check Odds API credit balance (1 credit call)
console.log('\nChecking Odds API credit balance...');
const apiKey = env.THE_ODDS_API_KEY;
if (apiKey) {
  try {
    const resp = await fetch(`https://api.the-odds-api.com/v4/sports?apiKey=${apiKey}`);
    const used = resp.headers.get('x-requests-used');
    const remaining = resp.headers.get('x-requests-remaining');
    console.log(`  X-Requests-Used:      ${used}`);
    console.log(`  X-Requests-Remaining: ${remaining}`);
    const remainingN = parseInt(remaining ?? '0', 10);
    console.log(`  Estimated credits for ${filesMissing} pulls @ 10 each: ${filesMissing * 10}`);
    console.log(`  Budget headroom: ${remainingN - filesMissing * 10} remaining after pull`);
  } catch (err) {
    console.log(`  [ERROR] Could not check balance: ${err.message}`);
  }
} else {
  console.log('  THE_ODDS_API_KEY not set');
}

await c.end();
