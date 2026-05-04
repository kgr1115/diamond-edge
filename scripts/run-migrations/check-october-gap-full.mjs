/**
 * Full gap diagnostic across the complete 2022-09 to 2024-12-31 window.
 * Cross-checks DB games vs disk files vs closing_snapshot rows.
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

console.log('=== Full Window Gap Diagnostic (2022-09-01 to 2024-12-31) ===\n');

// Total DB rows / games from all closing snapshot sources
const { rows: allOddsRows } = await c.query(`
  SELECT COUNT(*)::int AS total_rows,
         COUNT(DISTINCT game_id)::int AS games_covered
  FROM odds WHERE closing_snapshot = true AND market = 'moneyline'
`);
console.log('All closing snapshot rows (all sources):');
console.log(`  Total rows: ${allOddsRows[0].total_rows}`);
console.log(`  Distinct games: ${allOddsRows[0].games_covered}`);

const { rows: bySource } = await c.query(`
  SELECT source, COUNT(*)::int AS rows, COUNT(DISTINCT game_id)::int AS games
  FROM odds WHERE closing_snapshot = true AND market = 'moneyline'
  GROUP BY source ORDER BY rows DESC
`);
console.log('\nBy source:');
for (const r of bySource) {
  console.log(`  ${r.source}: ${r.rows} rows, ${r.games} games`);
}

// Games in the full window
const { rows: windowGames } = await c.query(`
  SELECT COUNT(*)::int AS total_finals
  FROM games
  WHERE game_date >= '2022-09-01' AND game_date <= '2024-12-31'
    AND status = 'final' AND game_time_utc IS NOT NULL
`);
console.log(`\nDB games in window (2022-09 to 2024-12): ${windowGames[0].total_finals} finals`);

// By year
const { rows: byYear } = await c.query(`
  SELECT EXTRACT(YEAR FROM game_date)::int AS yr, COUNT(*)::int AS finals
  FROM games
  WHERE game_date >= '2022-09-01' AND game_date <= '2024-12-31'
    AND status = 'final' AND game_time_utc IS NOT NULL
  GROUP BY yr ORDER BY yr
`);
console.log('Finals by year:');
for (const r of byYear) {
  console.log(`  ${r.yr}: ${r.finals}`);
}

// Missing from the per-game source (full window)
const { rows: missingAll } = await c.query(`
  SELECT g.id::text AS game_id,
         g.game_date::text AS game_date,
         EXTRACT(YEAR FROM g.game_date)::int AS yr
  FROM games g
  WHERE g.game_date >= '2022-09-01' AND g.game_date <= '2024-12-31'
    AND g.status = 'final' AND g.game_time_utc IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM odds o
      WHERE o.game_id = g.id
        AND o.market = 'moneyline'
        AND o.closing_snapshot = true
        AND o.source = $1
    )
  ORDER BY g.game_date
`, [SOURCE_TAG]);

console.log(`\nGames with no per-game closing snapshot (source=${SOURCE_TAG}): ${missingAll.length}`);

// Check files on disk
let onDisk = 0, notOnDisk = 0;
const needPull = [];
const needLoad = [];

for (const g of missingAll) {
  const yr = String(g.yr);
  const filePath = join(PERGAME_ROOT, yr, `${g.game_id}.json`);
  if (existsSync(filePath)) {
    onDisk++;
    needLoad.push(g);
  } else {
    notOnDisk++;
    needPull.push(g);
  }
}

console.log(`  Files on disk (need load): ${onDisk}`);
console.log(`  Files missing from disk (need API pull): ${notOnDisk}`);

if (notOnDisk > 0) {
  const byYr = {};
  for (const g of needPull) {
    byYr[g.yr] = (byYr[g.yr] ?? 0) + 1;
  }
  console.log('\nGames needing API pull by year:');
  for (const [yr, n] of Object.entries(byYr).sort()) {
    console.log(`  ${yr}: ${n}`);
  }

  const last30 = needPull.slice(0, 30);
  console.log(`\nSample games needing API pull (first 30):`);
  for (const g of last30) {
    console.log(`  ${g.game_date} [${g.game_id}]`);
  }
}

// Per-game T-60 coverage using pergame source
const { rows: pinCoverage } = await c.query(`
  WITH per_game AS (
    SELECT g.id AS game_id, g.game_time_utc,
           EXTRACT(YEAR FROM g.game_date)::int AS yr,
           MAX(o.snapshotted_at) FILTER (WHERE sb.key = 'draftkings') AS dk_snap,
           MAX(o.snapshotted_at) FILTER (WHERE sb.key = 'fanduel')   AS fd_snap
    FROM games g
    LEFT JOIN odds o ON o.game_id = g.id
                    AND o.market = 'moneyline'
                    AND o.closing_snapshot = true
                    AND o.source = $1
    LEFT JOIN sportsbooks sb ON sb.id = o.sportsbook_id
    WHERE g.game_date >= '2022-09-01' AND g.game_date <= '2024-12-31'
      AND g.status = 'final'
    GROUP BY g.id, g.game_time_utc, g.game_date
  )
  SELECT yr,
         COUNT(*)::int AS finals,
         COUNT(*) FILTER (WHERE dk_snap IS NOT NULL)::int AS has_dk,
         COUNT(*) FILTER (WHERE fd_snap IS NOT NULL)::int AS has_fd,
         COUNT(*) FILTER (WHERE dk_snap <= game_time_utc - interval '60 minutes'
                            AND fd_snap <= game_time_utc - interval '60 minutes')::int AS both_pin_ok,
         ROUND(100.0 * COUNT(*) FILTER (
           WHERE dk_snap <= game_time_utc - interval '60 minutes'
             AND fd_snap <= game_time_utc - interval '60 minutes'
         ) / NULLIF(COUNT(*), 0), 1) AS both_pct
  FROM per_game
  GROUP BY yr ORDER BY yr
`, [SOURCE_TAG]);

console.log('\nCurrent T-60 strict pin coverage by year:');
for (const r of pinCoverage) {
  console.log(`  ${r.yr}: finals=${r.finals}  has_dk=${r.has_dk}  has_fd=${r.has_fd}  both_pin_ok=${r.both_pin_ok}  (${r.both_pct}%)`);
}

// Total across full window
const total = pinCoverage.reduce((a, r) => ({ finals: a.finals + r.finals, both_pin_ok: a.both_pin_ok + r.both_pin_ok }), { finals: 0, both_pin_ok: 0 });
const totalPct = total.finals > 0 ? (100 * total.both_pin_ok / total.finals).toFixed(1) : '0.0';
console.log(`\nTotal window: finals=${total.finals}  both_pin_ok=${total.both_pin_ok}  (${totalPct}%)`);

await c.end();
