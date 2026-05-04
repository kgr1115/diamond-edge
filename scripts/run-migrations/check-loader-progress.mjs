// One-off check: loader + batter backfill progress for v0 cold-start lane.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(join(__dirname, '..', '..', '.env'), 'utf8')
    .split('\n').filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => { const e = l.indexOf('='); return [l.slice(0, e).trim(), l.slice(e + 1).trim()]; })
);
const c = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

console.log('=== Odds re-pull loader: closing-snapshot rows by year ===');
const r1 = await c.query(`
  SELECT EXTRACT(YEAR FROM g.game_time_utc)::int AS yr,
         COUNT(DISTINCT g.id) AS games_in_window,
         COUNT(DISTINCT CASE WHEN o.closing_snapshot = true THEN g.id END) AS games_with_close,
         COUNT(o.id) FILTER (WHERE o.closing_snapshot = true) AS closing_rows
  FROM games g
  LEFT JOIN odds o ON o.game_id = g.id
  WHERE g.game_time_utc >= '2022-09-01' AND g.game_time_utc < '2025-01-01'
    AND g.status = 'final'
  GROUP BY yr ORDER BY yr
`);
console.table(r1.rows);

console.log('\n=== Latest closing-snapshot row (loader heartbeat) ===');
const r2 = await c.query(`
  SELECT MAX(snapshotted_at) AS latest_snap_ts,
         COUNT(*) AS total_closing_rows,
         COUNT(DISTINCT game_id) AS distinct_games
  FROM odds WHERE closing_snapshot = true
`);
console.table(r2.rows);

console.log('\n=== Strict T-60 pin coverage on training window ===');
const r3 = await c.query(`
  WITH eligible AS (
    SELECT g.id, g.game_time_utc,
      COUNT(DISTINCT o.sportsbook_id) FILTER (
        WHERE o.closing_snapshot = true
          AND o.snapshotted_at <= g.game_time_utc - INTERVAL '60 minutes'
          AND o.market = 'moneyline'
      ) AS books_with_t60
    FROM games g
    LEFT JOIN odds o ON o.game_id = g.id
    WHERE g.game_time_utc >= '2022-09-01' AND g.game_time_utc < '2025-01-01'
      AND g.status = 'final'
    GROUP BY g.id, g.game_time_utc
  )
  SELECT
    COUNT(*) AS games,
    COUNT(*) FILTER (WHERE books_with_t60 >= 1) AS with_any,
    COUNT(*) FILTER (WHERE books_with_t60 >= 2) AS with_both,
    ROUND(100.0 * COUNT(*) FILTER (WHERE books_with_t60 >= 2) / NULLIF(COUNT(*), 0), 1) AS pct_both
  FROM eligible
`);
console.table(r3.rows);

console.log('\n=== Batter game log progress ===');
const r4 = await c.query(`
  SELECT EXTRACT(YEAR FROM game_date)::int AS yr,
         COUNT(*) AS rows,
         COUNT(DISTINCT game_id) AS games,
         MIN(game_date)::text AS earliest,
         MAX(game_date)::text AS latest
  FROM batter_game_log
  GROUP BY yr ORDER BY yr
`).catch(e => ({ rows: [{ error: e.message }] }));
console.table(r4.rows);

await c.end();
