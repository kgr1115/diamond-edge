import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(readFileSync(join(__dirname, '..', '..', '.env'), 'utf8').split('\n').filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => { const e = l.indexOf('='); return [l.slice(0, e).trim(), l.slice(e + 1).trim()]; }));

const client = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await client.connect();

console.log('=== 1. Constraints on picks table ===');
const cons = await client.query(`
  SELECT conname, contype, pg_get_constraintdef(oid) AS def
  FROM pg_constraint WHERE conrelid = 'picks'::regclass ORDER BY contype, conname;
`);
console.table(cons.rows);

console.log('\n=== 2. Indexes on picks table ===');
const idx = await client.query(`
  SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'picks' ORDER BY indexname;
`);
console.table(idx.rows);

console.log('\n=== 3. Dup groups in last 7 days by (game_id, market, pick_side, best_line_price, pick_date) ===');
const dups = await client.query(`
  SELECT game_id, market, pick_side, best_line_price, pick_date, COUNT(*) AS dup_count
  FROM picks
  WHERE pick_date >= (CURRENT_DATE - INTERVAL '7 days')
  GROUP BY game_id, market, pick_side, best_line_price, pick_date
  HAVING COUNT(*) > 1
  ORDER BY pick_date DESC, dup_count DESC
  LIMIT 50;
`);
console.log(`Total dup-group rows returned: ${dups.rows.length}`);
console.table(dups.rows);

console.log('\n=== 4. Same as #3 but ignoring odds (game_id, market, pick_side, pick_date) ===');
const dups2 = await client.query(`
  SELECT pick_date, COUNT(*) AS dup_groups, SUM(c - 1) AS extra_rows
  FROM (
    SELECT pick_date, COUNT(*) AS c FROM picks
    WHERE pick_date >= (CURRENT_DATE - INTERVAL '7 days')
    GROUP BY game_id, market, pick_side, pick_date HAVING COUNT(*) > 1
  ) s GROUP BY pick_date ORDER BY pick_date DESC;
`);
console.table(dups2.rows);

console.log('\n=== 5. Concrete examples (with ids + timestamps) ===');
const examples = await client.query(`
  WITH d AS (
    SELECT game_id, market, pick_side, pick_date FROM picks
    WHERE pick_date >= (CURRENT_DATE - INTERVAL '7 days')
    GROUP BY game_id, market, pick_side, pick_date HAVING COUNT(*) > 1
    ORDER BY pick_date DESC LIMIT 5
  )
  SELECT p.id, p.game_id, p.market, p.pick_side, p.best_line_price,
         p.pick_date, p.visibility, p.confidence_tier,
         p.generated_at, p.created_at,
         ht.abbreviation AS home, at.abbreviation AS away
  FROM picks p
  JOIN d USING (game_id, market, pick_side, pick_date)
  JOIN games g ON g.id = p.game_id
  LEFT JOIN teams ht ON ht.id = g.home_team_id
  LEFT JOIN teams at ON at.id = g.away_team_id
  ORDER BY p.game_id, p.market, p.pick_side, p.created_at;
`);
console.table(examples.rows);

console.log('\n=== 6. Identical-created_at vs distinct: distribution of intra-group timestamp spread ===');
const spread = await client.query(`
  WITH g AS (
    SELECT game_id, market, pick_side, pick_date,
           MAX(created_at) - MIN(created_at) AS spread
    FROM picks WHERE pick_date >= (CURRENT_DATE - INTERVAL '7 days')
    GROUP BY game_id, market, pick_side, pick_date HAVING COUNT(*) > 1
  )
  SELECT
    SUM(CASE WHEN spread = INTERVAL '0' THEN 1 ELSE 0 END) AS identical_ts,
    SUM(CASE WHEN spread > INTERVAL '0' AND spread < INTERVAL '1 hour' THEN 1 ELSE 0 END) AS within_1h,
    SUM(CASE WHEN spread >= INTERVAL '1 hour' AND spread < INTERVAL '1 day' THEN 1 ELSE 0 END) AS within_1d,
    SUM(CASE WHEN spread >= INTERVAL '1 day' THEN 1 ELSE 0 END) AS over_1d
  FROM g;
`);
console.table(spread.rows);

// Repository-wide dup-group count on the natural key (post-0021 invariant: must be 0).
const totalDupGroups = await client.query(`
  SELECT COUNT(*)::int AS n FROM (
    SELECT 1 FROM picks
    GROUP BY game_id, market, pick_side, pick_date
    HAVING COUNT(*) > 1
  ) s;
`);
const dupGroupCount = totalDupGroups.rows[0].n;
console.log(`\n=== 7. Total dup-group count on natural key (whole table): ${dupGroupCount} ===`);

await client.end();

if (dupGroupCount > 0) {
  console.error(`FAIL: ${dupGroupCount} natural-key dup groups remain in picks. Run dedupe-picks-backfill.mjs --apply.`);
  process.exit(1);
}
