// One-off backfill: populate calibration_history with the 26 pre-wipe picks.
// Mirrors apps/web/lib/calibration/snapshot.ts logic in SQL.
//
// Computes per (market, tier) over a trailing-60-day window relative to
// snapshot_date. Snapshot date here = today (2026-05-03). Only picks graded
// in [today - 60d, today] are aggregated. Push/void excluded from win-rate /
// ECE / Brier; sparse cells (<10 graded) write metrics as NULL.
//
// Idempotent: PRIMARY KEY (snapshot_date, market, confidence_tier).
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

const SNAPSHOT_DATE = new Date().toISOString().slice(0, 10);
const SPARSE_FLOOR = 10;
const MARKETS = ['moneyline', 'run_line', 'total'];
const TIERS = [1, 2, 3, 4, 5];

console.log(`Snapshot date: ${SNAPSHOT_DATE}`);
console.log(`Window: trailing 60 days from snapshot_date (graded_at)\n`);

const rowsToUpsert = [];

for (const market of MARKETS) {
  for (const tier of TIERS) {
    const r = await c.query(`
      WITH cell AS (
        SELECT
          p.model_probability::numeric AS prob,
          po.result
        FROM picks p
        JOIN pick_outcomes po ON po.pick_id = p.id
        WHERE p.market = $1
          AND p.confidence_tier = $2
          AND po.graded_at >= ($3::date - INTERVAL '60 days')
          AND po.graded_at <  ($3::date + INTERVAL '1 day')
      )
      SELECT
        COUNT(*)::int AS n_picks,
        COUNT(*) FILTER (WHERE result IN ('win','loss'))::int AS n_graded,
        AVG(prob) FILTER (WHERE result IN ('win','loss')) AS predicted_win_rate,
        (COUNT(*) FILTER (WHERE result='win')::numeric /
          NULLIF(COUNT(*) FILTER (WHERE result IN ('win','loss')), 0)) AS actual_win_rate,
        AVG(ABS(prob - CASE WHEN result='win' THEN 1 ELSE 0 END))
          FILTER (WHERE result IN ('win','loss')) AS ece,
        AVG(POWER(prob - CASE WHEN result='win' THEN 1 ELSE 0 END, 2))
          FILTER (WHERE result IN ('win','loss')) AS brier_score
      FROM cell
    `, [market, tier, SNAPSHOT_DATE]);

    const row = r.rows[0];
    const n_picks = row.n_picks;
    const n_graded = row.n_graded;
    const sparse = n_graded < SPARSE_FLOOR;

    rowsToUpsert.push({
      snapshot_date: SNAPSHOT_DATE,
      market,
      confidence_tier: tier,
      predicted_win_rate: sparse ? null : (row.predicted_win_rate !== null ? Number(row.predicted_win_rate) : null),
      actual_win_rate: sparse ? null : (row.actual_win_rate !== null ? Number(row.actual_win_rate) : null),
      n_picks,
      n_graded,
      ece: sparse ? null : (row.ece !== null ? Number(row.ece) : null),
      brier_score: sparse ? null : (row.brier_score !== null ? Number(row.brier_score) : null),
    });
  }
}

console.log('Computed cells:');
console.table(rowsToUpsert);

let written = 0;
for (const row of rowsToUpsert) {
  await c.query(`
    INSERT INTO calibration_history (
      snapshot_date, market, confidence_tier, predicted_win_rate, actual_win_rate,
      n_picks, n_graded, ece, brier_score, computed_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
    ON CONFLICT (snapshot_date, market, confidence_tier)
    DO UPDATE SET
      predicted_win_rate = EXCLUDED.predicted_win_rate,
      actual_win_rate    = EXCLUDED.actual_win_rate,
      n_picks            = EXCLUDED.n_picks,
      n_graded           = EXCLUDED.n_graded,
      ece                = EXCLUDED.ece,
      brier_score        = EXCLUDED.brier_score,
      computed_at        = NOW()
  `, [
    row.snapshot_date, row.market, row.confidence_tier,
    row.predicted_win_rate, row.actual_win_rate,
    row.n_picks, row.n_graded, row.ece, row.brier_score,
  ]);
  written++;
}

console.log(`\nUpserted ${written} cells into calibration_history.`);

await c.end();
