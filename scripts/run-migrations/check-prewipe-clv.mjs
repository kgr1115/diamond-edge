// One-off diagnostic: assess what CLV/calibration backfill is possible for
// pre-wipe picks (2026-04-23 + 2026-04-24).
//
// Checks:
//   1. Migration 0026 applied? (odds.closing_snapshot column exists)
//   2. Any closing_snapshot=true rows for those games?
//   3. picks.implied_probability populated for those picks?
//   4. calibration_history rows present for the 60-day window?
//
// Read-only. No writes.
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

console.log('=== Migration 0026 (odds.closing_snapshot) applied? ===');
const r1 = await c.query(`
  SELECT column_name, data_type, column_default
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='odds' AND column_name='closing_snapshot'
`);
console.table(r1.rows);

console.log('\n=== Recent migration-relevant columns to confirm 0023-0027 applied ===');
const r2 = await c.query(`
  SELECT table_name, column_name FROM information_schema.columns
  WHERE table_schema='public' AND (
    (table_name='lineup_entries' AND column_name='pinned_at') OR
    (table_name='odds' AND column_name='closing_snapshot') OR
    (table_name='odds' AND column_name='source') OR
    (table_name='games' AND column_name='divisional_flag')
  )
  UNION ALL
  SELECT 'view' AS table_name, table_name AS column_name
    FROM information_schema.views WHERE table_schema='public' AND table_name='game_wind_features'
  UNION ALL
  SELECT 'table' AS table_name, table_name AS column_name
    FROM information_schema.tables WHERE table_schema='public' AND table_name='park_factor_runs'
  ORDER BY table_name, column_name
`);
console.table(r2.rows);

console.log('\n=== Closing snapshots for pre-wipe game dates ===');
const r3 = await c.query(`
  SELECT g.game_date::text,
         COUNT(DISTINCT g.id) AS games,
         COUNT(o.id) FILTER (WHERE o.closing_snapshot = true) AS closing_rows,
         COUNT(o.id) AS total_odds_rows
  FROM games g
  LEFT JOIN odds o ON o.game_id = g.id
  WHERE g.game_date IN ('2026-04-23', '2026-04-24')
  GROUP BY g.game_date
  ORDER BY g.game_date
`);
console.table(r3.rows);

console.log('\n=== picks.implied_probability NULL count ===');
const r4 = await c.query(`
  SELECT g.game_date::text,
         COUNT(*) AS picks,
         COUNT(*) FILTER (WHERE p.implied_probability IS NULL) AS null_implied,
         COUNT(*) FILTER (WHERE p.implied_probability IS NOT NULL) AS has_implied
  FROM picks p JOIN games g ON g.id = p.game_id
  WHERE g.game_date IN ('2026-04-23', '2026-04-24')
  GROUP BY g.game_date
  ORDER BY g.game_date
`);
console.table(r4.rows);

console.log('\n=== calibration_history rows ===');
const r5 = await c.query(`
  SELECT to_char(snapshot_date, 'YYYY-MM-DD') AS snapshot_date,
         market, tier, n_picks
  FROM calibration_history
  ORDER BY snapshot_date DESC, market, tier
  LIMIT 20
`).catch(e => ({ rows: [{ error: e.message }] }));
console.table(r5.rows);

console.log('\n=== pick_clv rows ===');
const r6 = await c.query(`
  SELECT COUNT(*) AS rows,
         COUNT(*) FILTER (WHERE clv_edge IS NOT NULL) AS with_edge
  FROM pick_clv
`);
console.table(r6.rows);

await c.end();
