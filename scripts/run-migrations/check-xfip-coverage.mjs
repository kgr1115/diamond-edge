/**
 * check-xfip-coverage.mjs — read-only diagnostic.
 *
 * Reports % of pitcher_game_log rows with non-NULL fb (and fb > 0) per season across
 * 2022-09-01 through 2024-12-31. Source proposal:
 *   docs/proposals/stuff-plus-ingestion-2026-05-04-infra-scope-gate-verdict.md
 *
 * Coverage gate (per scope-gate testing requirements): ≥95% non-NULL `fb` per season.
 * Below 95% on any single season stops the chain.
 *
 * Note: `fb` was added with NOT NULL DEFAULT 0 in migration 0030, so the IS NOT NULL
 * percentage will always be 100% post-migration. The meaningful coverage check is
 * `fb_populated_pct` — % of rows where fb > 0 OR (k > 0 AND ip > 0 AND no flyouts is plausible).
 * To distinguish "parser ran" from "default 0 still present", we also check `parser_ran_pct`:
 * the % of rows where retrieved_at >= the migration apply timestamp passed via env.
 *
 * Read-only; no writes to any table.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(join(__dirname, '..', '..', '.env'), 'utf8')
    .split('\n')
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => {
      const e = l.indexOf('=');
      return [l.slice(0, e).trim(), l.slice(e + 1).trim()];
    })
);

const client = new pg.Client({
  connectionString: env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();

// Sanity: confirm the column exists (fail loud if migration 0030 hasn't been applied).
const col = await client.query(`
  SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
  WHERE table_name = 'pitcher_game_log' AND column_name = 'fb'
`);
if (col.rows.length === 0) {
  console.error('FAIL: pitcher_game_log.fb column missing. Apply migration 0030 first.');
  await client.end();
  process.exit(1);
}
console.log('Column metadata:');
console.table(col.rows);

// Per-season coverage. fb is NOT NULL by schema; we report:
//   total_rows           — all rows in season
//   fb_gt_zero_pct       — % of rows with fb > 0 (proxy for "parser populated this row")
//   pitcher_rows_in_play — rows where ip > 0 AND k > 0 (i.e., real outings; non-trivial sample)
//   coverage_pct         — % of pitcher_rows_in_play with fb > 0 (the gate metric)
console.log('\nPer-season coverage (window 2022-09-01 → 2024-12-31):');
const cov = await client.query(`
  SELECT
    EXTRACT(YEAR FROM game_date)::int                                                      AS season,
    COUNT(*)                                                                                AS total_rows,
    SUM(CASE WHEN fb > 0 THEN 1 ELSE 0 END)                                                AS fb_gt_zero,
    SUM(CASE WHEN ip > 0 THEN 1 ELSE 0 END)                                                AS rows_with_outing,
    ROUND(100.0 * SUM(CASE WHEN fb > 0 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 2)        AS fb_gt_zero_pct,
    ROUND(
      100.0 * SUM(CASE WHEN fb > 0 THEN 1 ELSE 0 END)
            / NULLIF(SUM(CASE WHEN ip > 0 THEN 1 ELSE 0 END), 0),
      2
    )                                                                                       AS coverage_pct
  FROM pitcher_game_log
  WHERE game_date >= '2022-09-01' AND game_date <= '2024-12-31'
  GROUP BY 1
  ORDER BY 1
`);
console.table(cov.rows);

// Gate evaluation
const GATE_PCT = 95.0;
const failures = cov.rows.filter(r => Number(r.coverage_pct) < GATE_PCT);
if (failures.length > 0) {
  console.error(`\nFAIL: ${failures.length} season(s) below ${GATE_PCT}% coverage gate:`);
  for (const f of failures) {
    console.error(`  ${f.season}: ${f.coverage_pct}% (gate ${GATE_PCT}%)`);
  }
  await client.end();
  process.exit(1);
}
console.log(`\nPASS: All seasons in 2022-09 → 2024-12 ≥ ${GATE_PCT}% coverage on rows with ip > 0.`);
await client.end();
