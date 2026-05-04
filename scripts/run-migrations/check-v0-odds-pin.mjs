// Investigate the odds snapshot timing relative to T-60min pin.
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

// What is the relationship between odds snapshotted_at and game_time_utc?
console.log('=== Odds snapshot timing vs game start (sample, training window) ===');
const r1 = await c.query(`
  SELECT g.id::text AS game_id,
         g.game_time_utc::text AS game_start,
         o.snapshotted_at::text AS snap,
         EXTRACT(EPOCH FROM (g.game_time_utc - o.snapshotted_at))/60 AS min_before_start,
         sb.key AS book
  FROM games g
  JOIN odds o ON o.game_id = g.id
  JOIN sportsbooks sb ON sb.id = o.sportsbook_id
  WHERE o.market = 'moneyline'
    AND g.game_date >= '2024-08-15' AND g.game_date <= '2024-08-16'
  ORDER BY g.id, sb.key, o.snapshotted_at
  LIMIT 20
`);
console.table(r1.rows);

// Does the historical odds API snapshot timestamp differ from game start?
console.log('\n=== Per-game odds row count + earliest snapshot relative to start ===');
const r2 = await c.query(`
  WITH game_odds AS (
    SELECT g.id, sb.key AS book,
           COUNT(*) AS n,
           MIN(o.snapshotted_at) AS first_snap,
           MAX(o.snapshotted_at) AS last_snap,
           g.game_time_utc
    FROM games g
    JOIN odds o ON o.game_id = g.id
    JOIN sportsbooks sb ON sb.id = o.sportsbook_id
    WHERE o.market = 'moneyline' AND g.status = 'final'
      AND g.game_date >= '2024-01-01' AND g.game_date <= '2024-12-31'
    GROUP BY g.id, sb.key, g.game_time_utc
  )
  SELECT book,
         COUNT(*)::int AS games,
         AVG(n)::numeric(6,2) AS avg_odds_per_game,
         AVG(EXTRACT(EPOCH FROM (game_time_utc - first_snap))/60)::int AS avg_first_snap_minutes_before_start,
         AVG(EXTRACT(EPOCH FROM (game_time_utc - last_snap))/60)::int AS avg_last_snap_minutes_before_start
  FROM game_odds
  GROUP BY book ORDER BY book
`);
console.table(r2.rows);

// What about the T-60min pin specifically? How many games would survive?
console.log('\n=== Coverage with relaxed pin (any odds snapshot before game_time_utc) ===');
const r3 = await c.query(`
  SELECT EXTRACT(YEAR FROM g.game_date)::int AS yr,
         COUNT(DISTINCT g.id)::int AS games,
         COUNT(DISTINCT g.id) FILTER (
           WHERE EXISTS (
             SELECT 1 FROM odds o JOIN sportsbooks sb ON sb.id = o.sportsbook_id
             WHERE o.game_id = g.id AND sb.key = 'draftkings'
               AND o.market = 'moneyline' AND o.snapshotted_at <= g.game_time_utc
           ) AND EXISTS (
             SELECT 1 FROM odds o JOIN sportsbooks sb ON sb.id = o.sportsbook_id
             WHERE o.game_id = g.id AND sb.key = 'fanduel'
               AND o.market = 'moneyline' AND o.snapshotted_at <= g.game_time_utc
           )
         )::int AS games_with_both_pre_start
  FROM games g
  WHERE g.game_date >= '2022-09-01' AND g.game_date <= '2024-12-31'
    AND g.status = 'final'
  GROUP BY yr ORDER BY yr
`);
console.table(r3.rows);

// What if we don't require T-60 but allow any snap up to game start?
console.log('\n=== What does closing_snapshot column show? ===');
const r4 = await c.query(`
  SELECT closing_snapshot, COUNT(*)::int AS n
  FROM odds
  WHERE market = 'moneyline'
    AND snapshotted_at >= '2022-09-01' AND snapshotted_at <= '2024-12-31'
  GROUP BY closing_snapshot
`);
console.table(r4.rows);

await c.end();
