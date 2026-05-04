// Final coverage report after the per-game odds re-pull + loader complete.
// Reports per-year T-60 strict pin coverage for the v0 source
// (odds_api_historical_pergame). Used as input to the bundled report's
// section 4 ("Post-pull coverage actuals").
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

const SOURCE_TAG = 'odds_api_historical_pergame';

console.log('=== V0 final post-re-pull coverage report ===\n');

// 1. Per-year T-60 strict pin coverage
console.log('Per-year T-60 strict pin coverage:');
const r1 = await c.query(`
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
         COUNT(*) FILTER (WHERE dk_snap <= game_time_utc - interval '60 minutes')::int AS dk_pin_ok,
         COUNT(*) FILTER (WHERE fd_snap <= game_time_utc - interval '60 minutes')::int AS fd_pin_ok,
         COUNT(*) FILTER (WHERE dk_snap <= game_time_utc - interval '60 minutes'
                            AND fd_snap <= game_time_utc - interval '60 minutes')::int AS both_pin_ok,
         ROUND(100.0 * COUNT(*) FILTER (
           WHERE dk_snap <= game_time_utc - interval '60 minutes'
             AND fd_snap <= game_time_utc - interval '60 minutes'
         ) / COUNT(*), 1) AS both_pct
  FROM per_game
  GROUP BY yr ORDER BY yr
`, [SOURCE_TAG]);
console.table(r1.rows);

// 2. Train window vs holdout window
console.log('\nTrain (2023-04-01 to 2024-07-15) vs holdout (2024-07-19 to 2024-12-31):');
const r2 = await c.query(`
  WITH per_game AS (
    SELECT g.id AS game_id, g.game_time_utc, g.game_date,
           MAX(o.snapshotted_at) FILTER (WHERE sb.key = 'draftkings') AS dk_snap,
           MAX(o.snapshotted_at) FILTER (WHERE sb.key = 'fanduel')   AS fd_snap
    FROM games g
    LEFT JOIN odds o ON o.game_id = g.id
                    AND o.market = 'moneyline'
                    AND o.closing_snapshot = true
                    AND o.source = $1
    LEFT JOIN sportsbooks sb ON sb.id = o.sportsbook_id
    WHERE g.status = 'final'
      AND g.game_date >= '2022-09-01' AND g.game_date <= '2024-12-31'
    GROUP BY g.id, g.game_time_utc, g.game_date
  )
  SELECT
    CASE WHEN game_date >= '2023-04-01' AND game_date <= '2024-07-15' THEN 'effective_train'
         WHEN game_date >= '2024-07-19' AND game_date <= '2024-12-31' THEN 'holdout'
         WHEN game_date >= '2022-09-01' AND game_date <= '2023-03-29' THEN 'warmup_only'
         ELSE 'other' END AS slice,
    COUNT(*)::int AS finals,
    COUNT(*) FILTER (
      WHERE dk_snap <= game_time_utc - interval '60 minutes'
        AND fd_snap <= game_time_utc - interval '60 minutes'
    )::int AS both_pin_ok
  FROM per_game
  GROUP BY slice ORDER BY
    CASE slice WHEN 'warmup_only' THEN 1 WHEN 'effective_train' THEN 2 WHEN 'holdout' THEN 3 ELSE 4 END
`, [SOURCE_TAG]);
console.table(r2.rows);

// 3. Anchor coverage (at least one of DK or FD has T-60 pin — feature is buildable)
console.log('\nAnchor coverage (≥1 book at T-60 pin = feature buildable):');
const r3 = await c.query(`
  WITH per_game AS (
    SELECT g.id AS game_id, g.game_time_utc, EXTRACT(YEAR FROM g.game_date)::int AS yr,
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
         COUNT(*) FILTER (
           WHERE dk_snap <= game_time_utc - interval '60 minutes'
              OR fd_snap <= game_time_utc - interval '60 minutes'
         )::int AS at_least_one_book
  FROM per_game
  GROUP BY yr ORDER BY yr
`, [SOURCE_TAG]);
console.table(r3.rows);

// 4. Total odds rows with new source
console.log('\nTotal rows with new source:');
const r4 = await c.query(`
  SELECT COUNT(*)::int AS rows, COUNT(DISTINCT game_id)::int AS games_covered
  FROM odds WHERE source = $1
`, [SOURCE_TAG]);
console.table(r4.rows);

await c.end();
