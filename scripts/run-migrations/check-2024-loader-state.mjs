/**
 * Check what 2024 games are already loaded vs not, to understand the loader stall point.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

const env = Object.fromEntries(
  readFileSync(join(REPO_ROOT, '.env'), 'utf8')
    .split('\n').filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => { const e = l.indexOf('='); return [l.slice(0, e).trim(), l.slice(e + 1).trim()]; })
);

const c = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

const SOURCE_TAG = 'odds_api_historical_pergame';

// What is the latest snapshotted_at for 2024 games loaded under per-game source?
const { rows: latest } = await c.query(`
  SELECT MAX(o.snapshotted_at)::text AS latest_snap,
         COUNT(DISTINCT o.game_id)::int AS games_loaded_2024,
         MAX(g.game_date)::text AS latest_game_date
  FROM odds o
  JOIN games g ON g.id = o.game_id
  WHERE o.source = $1 AND o.closing_snapshot = true AND o.market = 'moneyline'
    AND g.game_date >= '2024-01-01' AND g.game_date <= '2024-12-31'
`, [SOURCE_TAG]);
console.log('2024 pergame source current state:');
console.log(latest[0]);

// Monthly breakdown of what's loaded for 2024
const { rows: monthly } = await c.query(`
  SELECT TO_CHAR(g.game_date, 'YYYY-MM') AS month,
         COUNT(DISTINCT g.id)::int AS total_finals,
         COUNT(DISTINCT o.game_id)::int AS loaded
  FROM games g
  LEFT JOIN odds o ON o.game_id = g.id
                  AND o.source = $1 AND o.closing_snapshot = true AND o.market = 'moneyline'
  WHERE g.game_date >= '2024-01-01' AND g.game_date <= '2024-12-31'
    AND g.status = 'final' AND g.game_time_utc IS NOT NULL
  GROUP BY 1 ORDER BY 1
`, [SOURCE_TAG]);
console.log('\nMonthly 2024 loaded state:');
for (const r of monthly) {
  const pct = r.total_finals > 0 ? Math.round(100 * r.loaded / r.total_finals) : 0;
  console.log(`  ${r.month}: ${r.loaded}/${r.total_finals} (${pct}%)`);
}

await c.end();
