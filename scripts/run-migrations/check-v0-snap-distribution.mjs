// Check distribution of snap timing relative to game start - per game
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

// Bucket games by where their book snapshot lands relative to game start
console.log('=== DK snap timing distribution per game (training window) ===');
const r1 = await c.query(`
  WITH best_snap AS (
    SELECT g.id AS game_id, g.game_time_utc,
           MAX(o.snapshotted_at) AS latest_snap_before_start
    FROM games g
    LEFT JOIN odds o ON o.game_id = g.id
    LEFT JOIN sportsbooks sb ON sb.id = o.sportsbook_id
    WHERE g.game_date >= '2022-09-01' AND g.game_date <= '2024-12-31'
      AND g.status = 'final'
      AND sb.key = 'draftkings'
      AND o.market = 'moneyline'
    GROUP BY g.id, g.game_time_utc
  )
  SELECT
    CASE
      WHEN latest_snap_before_start IS NULL THEN 'no_snap'
      WHEN latest_snap_before_start <= game_time_utc - interval '60 minutes' THEN 'good (<= T-60)'
      WHEN latest_snap_before_start <= game_time_utc THEN 'after T-60 but before start'
      WHEN latest_snap_before_start <= game_time_utc + interval '4 hours' THEN 'within 4h after start'
      ELSE 'long after game'
    END AS bucket,
    COUNT(*)::int AS n
  FROM best_snap
  GROUP BY bucket ORDER BY n DESC
`);
console.table(r1.rows);

console.log('\n=== FD snap timing distribution per game (training window) ===');
const r2 = await c.query(`
  WITH best_snap AS (
    SELECT g.id AS game_id, g.game_time_utc,
           MAX(o.snapshotted_at) AS latest_snap_before_start
    FROM games g
    LEFT JOIN odds o ON o.game_id = g.id
    LEFT JOIN sportsbooks sb ON sb.id = o.sportsbook_id
    WHERE g.game_date >= '2022-09-01' AND g.game_date <= '2024-12-31'
      AND g.status = 'final'
      AND sb.key = 'fanduel'
      AND o.market = 'moneyline'
    GROUP BY g.id, g.game_time_utc
  )
  SELECT
    CASE
      WHEN latest_snap_before_start IS NULL THEN 'no_snap'
      WHEN latest_snap_before_start <= game_time_utc - interval '60 minutes' THEN 'good (<= T-60)'
      WHEN latest_snap_before_start <= game_time_utc THEN 'after T-60 but before start'
      WHEN latest_snap_before_start <= game_time_utc + interval '4 hours' THEN 'within 4h after start'
      ELSE 'long after game'
    END AS bucket,
    COUNT(*)::int AS n
  FROM best_snap
  GROUP BY bucket ORDER BY n DESC
`);
console.table(r2.rows);

// What if we use the snap that's nearest BEFORE game start (not strictly T-60)?
// This is what the brief calls "best available proxy for T-60" per audit memo.
console.log('\n=== Coverage with both DK+FD any snap STRICTLY before game start ===');
const r3 = await c.query(`
  SELECT EXTRACT(YEAR FROM g.game_date)::int AS yr,
         COUNT(*)::int AS games,
         COUNT(*) FILTER (
           WHERE EXISTS (SELECT 1 FROM odds o JOIN sportsbooks sb ON sb.id = o.sportsbook_id
                         WHERE o.game_id = g.id AND sb.key = 'draftkings'
                           AND o.market = 'moneyline' AND o.snapshotted_at < g.game_time_utc)
             AND EXISTS (SELECT 1 FROM odds o JOIN sportsbooks sb ON sb.id = o.sportsbook_id
                         WHERE o.game_id = g.id AND sb.key = 'fanduel'
                           AND o.market = 'moneyline' AND o.snapshotted_at < g.game_time_utc)
         )::int AS games_with_both_strict_pregame
  FROM games g
  WHERE g.game_date >= '2022-09-01' AND g.game_date <= '2024-12-31'
    AND g.status = 'final'
  GROUP BY yr ORDER BY yr
`);
console.table(r3.rows);

// More detailed: what's the latest pre-start snap distribution by minutes?
console.log('\n=== Latest pre-start snap distribution (DK) ===');
const r4 = await c.query(`
  WITH best_snap AS (
    SELECT g.id AS game_id, g.game_time_utc,
           MAX(o.snapshotted_at) FILTER (WHERE o.snapshotted_at < g.game_time_utc) AS pregame_snap
    FROM games g
    LEFT JOIN odds o ON o.game_id = g.id
    LEFT JOIN sportsbooks sb ON sb.id = o.sportsbook_id
    WHERE g.game_date >= '2022-09-01' AND g.game_date <= '2024-12-31'
      AND g.status = 'final'
      AND sb.key = 'draftkings'
      AND o.market = 'moneyline'
    GROUP BY g.id, g.game_time_utc
  )
  SELECT
    CASE
      WHEN pregame_snap IS NULL THEN 'no_pregame_snap'
      WHEN pregame_snap >= game_time_utc - interval '60 minutes' THEN '0-60min before start'
      WHEN pregame_snap >= game_time_utc - interval '6 hours' THEN '1-6h before start'
      WHEN pregame_snap >= game_time_utc - interval '24 hours' THEN '6-24h before start'
      WHEN pregame_snap >= game_time_utc - interval '48 hours' THEN '1-2 days before'
      ELSE '>2 days before'
    END AS bucket,
    COUNT(*)::int AS n
  FROM best_snap
  GROUP BY bucket
  ORDER BY n DESC
`);
console.table(r4.rows);

// Total: how many games have ANY single odds row at all
console.log('\n=== Games with ANY odds row (DK or FD, any time) ===');
const r5 = await c.query(`
  SELECT EXTRACT(YEAR FROM g.game_date)::int AS yr,
         COUNT(DISTINCT g.id)::int AS games,
         COUNT(DISTINCT g.id) FILTER (
           WHERE EXISTS (SELECT 1 FROM odds o JOIN sportsbooks sb ON sb.id = o.sportsbook_id
                         WHERE o.game_id = g.id AND sb.key = 'draftkings' AND o.market = 'moneyline')
         )::int AS with_dk_any,
         COUNT(DISTINCT g.id) FILTER (
           WHERE EXISTS (SELECT 1 FROM odds o JOIN sportsbooks sb ON sb.id = o.sportsbook_id
                         WHERE o.game_id = g.id AND sb.key = 'fanduel' AND o.market = 'moneyline')
         )::int AS with_fd_any,
         COUNT(DISTINCT g.id) FILTER (
           WHERE EXISTS (SELECT 1 FROM odds o JOIN sportsbooks sb ON sb.id = o.sportsbook_id
                         WHERE o.game_id = g.id AND sb.key = 'draftkings' AND o.market = 'moneyline')
             AND EXISTS (SELECT 1 FROM odds o JOIN sportsbooks sb ON sb.id = o.sportsbook_id
                         WHERE o.game_id = g.id AND sb.key = 'fanduel' AND o.market = 'moneyline')
         )::int AS with_both_any
  FROM games g
  WHERE g.game_date >= '2022-09-01' AND g.game_date <= '2024-12-31'
    AND g.status = 'final'
  GROUP BY yr ORDER BY yr
`);
console.table(r5.rows);

// Date range of odds: what's the coverage by month?
console.log('\n=== Odds row count by month + book ===');
const r6 = await c.query(`
  SELECT date_trunc('month', g.game_date)::date AS month,
         sb.key AS book,
         COUNT(DISTINCT g.id)::int AS games_with_odds
  FROM games g
  JOIN odds o ON o.game_id = g.id
  JOIN sportsbooks sb ON sb.id = o.sportsbook_id
  WHERE g.game_date >= '2022-09-01' AND g.game_date <= '2024-12-31'
    AND o.market = 'moneyline'
  GROUP BY month, sb.key ORDER BY month, sb.key
`);
console.table(r6.rows);

await c.end();
