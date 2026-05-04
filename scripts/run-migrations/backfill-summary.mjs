// One-off: summarize 2026-04-23 + 2026-04-24 grader backfill results.
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

console.log('=== Pick state by date / market / visibility / result ===');
const r1 = await c.query(`
  SELECT g.game_date::text, p.market, p.visibility, p.result, COUNT(*)::int AS n
  FROM picks p JOIN games g ON g.id = p.game_id
  WHERE g.game_date IN ('2026-04-23', '2026-04-24')
  GROUP BY g.game_date, p.market, p.visibility, p.result
  ORDER BY g.game_date, p.market, p.visibility, p.result
`);
console.table(r1.rows);

console.log('\n=== Graded summary by date / result + PnL ===');
// PnL computed inline to mirror apps/web/lib/roi/units.ts unitProfit().
// pick_outcomes has no pnl_units column — units ROI is derived at query time.
//   win:  +unitProfit(best_line_price)  (default -110 when price NULL)
//   loss: -1
//   push/void: 0 (excluded from risked)
const r2 = await c.query(`
  WITH settled AS (
    SELECT g.game_date::date AS game_date, p.result,
           CASE p.result
             WHEN 'win'  THEN CASE
               WHEN COALESCE(p.best_line_price, -110) >= 100
                 THEN COALESCE(p.best_line_price, -110)::numeric / 100
               ELSE 100.0 / ABS(COALESCE(p.best_line_price, -110))::numeric
             END
             WHEN 'loss' THEN -1::numeric
             ELSE 0::numeric
           END AS unit_pl
    FROM picks p JOIN games g ON g.id = p.game_id
    WHERE g.game_date IN ('2026-04-23', '2026-04-24')
      AND p.result IN ('win', 'loss', 'push', 'void')
  )
  SELECT game_date::text, result,
         COUNT(*)::int AS n,
         ROUND(COALESCE(SUM(unit_pl), 0), 2) AS pnl_units
  FROM settled
  GROUP BY game_date, result
  ORDER BY game_date, result
`);
console.table(r2.rows);

console.log('\n=== Pending leftovers ===');
const r3 = await c.query(`
  SELECT g.game_date::text, g.status, COUNT(*)::int AS pending_picks
  FROM picks p JOIN games g ON g.id = p.game_id
  WHERE g.game_date IN ('2026-04-23', '2026-04-24') AND p.result = 'pending'
  GROUP BY g.game_date, g.status
  ORDER BY g.game_date
`);
console.table(r3.rows);

console.log('\n=== CLV state ===');
const r4 = await c.query(`
  SELECT g.game_date::text, COUNT(p.id)::int AS picks_total,
         COUNT(pc.pick_id)::int AS clv_rows,
         ROUND(AVG(pc.clv_edge)::numeric, 4) AS mean_clv_edge
  FROM picks p
  JOIN games g ON g.id = p.game_id
  LEFT JOIN pick_clv pc ON pc.pick_id = p.id
  WHERE g.game_date IN ('2026-04-23', '2026-04-24')
  GROUP BY g.game_date
  ORDER BY g.game_date
`);
console.table(r4.rows);

await c.end();
