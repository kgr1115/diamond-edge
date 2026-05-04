// One-off: verify v0 backfill coverage on training window 2022-09 → 2024.
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

const out = {};

// 1. Games coverage by year
console.log('=== Games by season ===');
const games = await c.query(`
  SELECT EXTRACT(YEAR FROM game_date)::int AS yr,
         COUNT(*)::int AS n,
         COUNT(*) FILTER (WHERE status = 'final')::int AS finals
  FROM games
  WHERE game_date >= '2022-09-01' AND game_date <= '2024-12-31'
  GROUP BY yr ORDER BY yr
`);
console.table(games.rows);
out.games_by_year = games.rows;

// 2. Odds coverage with closing snapshots
console.log('\n=== Closing odds coverage (DK + FD) by season ===');
const odds = await c.query(`
  SELECT EXTRACT(YEAR FROM g.game_date)::int AS yr,
         COUNT(DISTINCT g.id)::int AS games,
         COUNT(DISTINCT g.id) FILTER (
           WHERE EXISTS (
             SELECT 1 FROM odds o
             JOIN sportsbooks sb ON sb.id = o.sportsbook_id
             WHERE o.game_id = g.id AND sb.key = 'draftkings'
               AND o.market = 'moneyline' AND o.snapshotted_at <= g.game_time_utc - interval '60 minutes'
           )
         )::int AS games_with_dk_close,
         COUNT(DISTINCT g.id) FILTER (
           WHERE EXISTS (
             SELECT 1 FROM odds o
             JOIN sportsbooks sb ON sb.id = o.sportsbook_id
             WHERE o.game_id = g.id AND sb.key = 'fanduel'
               AND o.market = 'moneyline' AND o.snapshotted_at <= g.game_time_utc - interval '60 minutes'
           )
         )::int AS games_with_fd_close,
         COUNT(DISTINCT g.id) FILTER (
           WHERE EXISTS (
             SELECT 1 FROM odds o JOIN sportsbooks sb ON sb.id = o.sportsbook_id
             WHERE o.game_id = g.id AND sb.key = 'draftkings'
               AND o.market = 'moneyline' AND o.snapshotted_at <= g.game_time_utc - interval '60 minutes'
           ) AND EXISTS (
             SELECT 1 FROM odds o JOIN sportsbooks sb ON sb.id = o.sportsbook_id
             WHERE o.game_id = g.id AND sb.key = 'fanduel'
               AND o.market = 'moneyline' AND o.snapshotted_at <= g.game_time_utc - interval '60 minutes'
           )
         )::int AS games_with_both
  FROM games g
  WHERE g.game_date >= '2022-09-01' AND g.game_date <= '2024-12-31'
    AND g.status = 'final'
  GROUP BY yr ORDER BY yr
`);
console.table(odds.rows);
out.odds_by_year = odds.rows;

// 3. Pitcher game logs
console.log('\n=== Pitcher game log coverage by season ===');
const pgl = await c.query(`
  SELECT EXTRACT(YEAR FROM game_date)::int AS yr,
         COUNT(*)::int AS rows,
         COUNT(DISTINCT pitcher_id)::int AS unique_pitchers,
         COUNT(DISTINCT game_id)::int AS unique_games
  FROM pitcher_game_log
  WHERE game_date >= '2022-09-01' AND game_date <= '2024-12-31'
  GROUP BY yr ORDER BY yr
`);
console.table(pgl.rows);
out.pitcher_game_log = pgl.rows;

// 4. Batter game logs
console.log('\n=== Batter game log coverage by season ===');
const bgl = await c.query(`
  SELECT EXTRACT(YEAR FROM game_date)::int AS yr,
         COUNT(*)::int AS rows,
         COUNT(DISTINCT batter_id)::int AS unique_batters,
         COUNT(DISTINCT game_id)::int AS unique_games
  FROM batter_game_log
  WHERE game_date >= '2022-09-01' AND game_date <= '2024-12-31'
  GROUP BY yr ORDER BY yr
`);
console.table(bgl.rows);
out.batter_game_log = bgl.rows;

// 5. Weather coverage
console.log('\n=== Weather coverage by season ===');
const wx = await c.query(`
  SELECT EXTRACT(YEAR FROM game_date)::int AS yr,
         COUNT(*)::int AS games,
         COUNT(weather_temp_f)::int AS with_temp,
         COUNT(weather_wind_mph)::int AS with_wind,
         COUNT(weather_wind_dir)::int AS with_dir
  FROM games
  WHERE game_date >= '2022-09-01' AND game_date <= '2024-12-31'
  GROUP BY yr ORDER BY yr
`);
console.table(wx.rows);
out.weather = wx.rows;

// 6. Park factor runs coverage
console.log('\n=== Park factor runs by venue ===');
const pf = await c.query(`
  SELECT COUNT(*)::int AS rows,
         COUNT(*) FILTER (WHERE outfield_bearing_deg IS NOT NULL)::int AS with_bearing,
         COUNT(*) FILTER (WHERE is_dome = true)::int AS domes
  FROM park_factor_runs
`);
console.table(pf.rows);
out.park_factor_runs = pf.rows;

// 7. Probable starters check (games table columns)
console.log('\n=== Games with probable starters identified ===');
const ps = await c.query(`
  SELECT EXTRACT(YEAR FROM game_date)::int AS yr,
         COUNT(*)::int AS games,
         COUNT(probable_home_pitcher_id)::int AS with_home_pitcher,
         COUNT(probable_away_pitcher_id)::int AS with_away_pitcher
  FROM games
  WHERE game_date >= '2022-09-01' AND game_date <= '2024-12-31'
    AND status = 'final'
  GROUP BY yr ORDER BY yr
`);
console.table(ps.rows);
out.probable_starters = ps.rows;

// 8. Odds source distribution (live vs closing snapshot)
console.log('\n=== Odds rows distribution by source on training window ===');
const odds_src = await c.query(`
  SELECT sb.key AS book,
         o.source,
         COUNT(*)::int AS n,
         MIN(o.snapshotted_at)::text AS earliest,
         MAX(o.snapshotted_at)::text AS latest
  FROM odds o
  JOIN sportsbooks sb ON sb.id = o.sportsbook_id
  WHERE o.market = 'moneyline'
    AND o.snapshotted_at >= '2022-09-01'
    AND o.snapshotted_at <= '2024-12-31'
  GROUP BY sb.key, o.source
  ORDER BY sb.key, o.source
`);
console.table(odds_src.rows);
out.odds_sources = odds_src.rows;

// Write report
const path = join(__dirname, '..', '..', 'docs', 'audits', 'moneyline-v0-backfill-results-2026-04-30.json');
const fs = await import('node:fs');
fs.writeFileSync(path, JSON.stringify(out, null, 2));
console.log(`\nWrote ${path}`);

await c.end();
