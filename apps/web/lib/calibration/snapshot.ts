/**
 * Calibration snapshot writer.
 *
 * Reads graded picks from the trailing 60-day window (relative to the snapshot
 * date), buckets by (market, confidence_tier), and upserts one row per cell
 * into `calibration_history` (migration 0020). Markets are restricted to the
 * three the table CHECK allows: 'moneyline', 'run_line', 'total'.
 *
 * Per the proposal scope:
 *   - Trailing-60-day window is computed from `pick_outcomes.graded_at`
 *     (settlement date), NOT `picks.pick_date` (game date).
 *   - Push and void picks are excluded from the win-rate, ECE, and Brier
 *     denominators (`n_graded` = win + loss only). `n_picks` counts ALL
 *     settled picks in the window including push/void.
 *   - Sparse cells (n_graded < 10) write the row with `ece` and `brier_score`
 *     set to NULL — the row still records `n_picks` / `n_graded` for trend
 *     visibility, but per-tier statistics are unreliable below the floor.
 *   - Empty cells (zero settled picks in window) still write a row with
 *     n_picks=0, n_graded=0, both metrics NULL — required so dashboards can
 *     distinguish "no signal" from "missing snapshot run".
 *   - Upsert key is (snapshot_date, market, confidence_tier) so re-running
 *     the same day overwrites cleanly.
 *
 * Service-role-only writes — `calibration_history` ships without an RLS
 * policy in migration 0020 (table-level RLS not enabled).
 */

import { createServiceRoleClient } from '@/lib/supabase/server';
import { computeCellStats } from '@/lib/calibration/metrics';

const SUPPORTED_MARKETS = ['moneyline', 'run_line', 'total'] as const;
type SupportedMarket = (typeof SUPPORTED_MARKETS)[number];
const TIERS = [1, 2, 3, 4, 5] as const;
const WINDOW_DAYS = 60;
const SPARSE_CELL_FLOOR = 10;

export interface CalibrationSnapshotResult {
  snapshotDate: string;
  cellsWritten: number;
  cellsSparse: number;
  cellsEmpty: number;
  totalPicks: number;
  totalGraded: number;
  errors: string[];
  durationMs: number;
}

interface JoinedPickRow {
  market: string;
  confidence_tier: number;
  model_probability: number | string;
  pick_outcomes: { result: string; graded_at: string } | { result: string; graded_at: string }[] | null;
}

interface CalibrationHistoryUpsert {
  snapshot_date: string;
  market: string;
  confidence_tier: number;
  predicted_win_rate: number | null;
  actual_win_rate: number | null;
  n_picks: number;
  n_graded: number;
  ece: number | null;
  brier_score: number | null;
  computed_at: string;
}

function isSupportedMarket(m: string): m is SupportedMarket {
  return (SUPPORTED_MARKETS as readonly string[]).includes(m);
}

/** YYYY-MM-DD in UTC for both today and the window-start. */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Normalise the PostgREST 1:N join shape down to a single row (or null). */
function firstOutcome(
  o: JoinedPickRow['pick_outcomes'],
): { result: string; graded_at: string } | null {
  if (o === null) return null;
  if (Array.isArray(o)) return o.length > 0 ? o[0] : null;
  return o;
}

export async function runCalibrationSnapshot(
  now: Date = new Date(),
): Promise<CalibrationSnapshotResult> {
  const startMs = Date.now();
  const errors: string[] = [];

  const snapshotDate = isoDate(now);
  const windowStart = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const windowStartIso = windowStart.toISOString();

  const supabase = createServiceRoleClient();

  // Inner-join via PostgREST: only picks with a pick_outcomes row in the
  // trailing window. The denormalised filter on a joined column requires the
  // `!inner` hint plus the dot-prefixed column name in `.gte`/`.in`.
  const { data: rowsData, error: rowsErr } = await supabase
    .from('picks')
    .select(`
      market, confidence_tier, model_probability,
      pick_outcomes!inner ( result, graded_at )
    `)
    .in('market', SUPPORTED_MARKETS as unknown as never)
    .gte('pick_outcomes.graded_at', windowStartIso);

  if (rowsErr) {
    const msg = `picks/pick_outcomes read failed: ${rowsErr.message}`;
    console.error(JSON.stringify({
      level: 'error',
      event: 'calibration_snapshot_read_failed',
      error: msg,
    }));
    return {
      snapshotDate,
      cellsWritten: 0,
      cellsSparse: 0,
      cellsEmpty: 0,
      totalPicks: 0,
      totalGraded: 0,
      errors: [msg],
      durationMs: Date.now() - startMs,
    };
  }

  const rows = (rowsData ?? []) as unknown as JoinedPickRow[];

  // Bucket: cellKey -> { allPicks: count, graded: CellSample[] }
  // allPicks counts every settled pick in the window (win/loss/push/void).
  // graded holds only win+loss for the metric calculations.
  type Bucket = { allPicks: number; graded: { predictedProb: number; outcome: 0 | 1 }[] };
  const buckets = new Map<string, Bucket>();
  const cellKey = (m: string, t: number) => `${m}::${t}`;

  for (const m of SUPPORTED_MARKETS) {
    for (const t of TIERS) {
      buckets.set(cellKey(m, t), { allPicks: 0, graded: [] });
    }
  }

  for (const row of rows) {
    if (!isSupportedMarket(row.market)) continue;
    const tier = Number(row.confidence_tier);
    if (!Number.isInteger(tier) || tier < 1 || tier > 5) continue;

    const outcome = firstOutcome(row.pick_outcomes);
    if (!outcome) continue;

    const bucket = buckets.get(cellKey(row.market, tier));
    if (!bucket) continue;

    bucket.allPicks += 1;

    if (outcome.result === 'win' || outcome.result === 'loss') {
      const predictedProb = Number(row.model_probability);
      if (!Number.isFinite(predictedProb)) continue;
      bucket.graded.push({
        predictedProb,
        outcome: outcome.result === 'win' ? 1 : 0,
      });
    }
  }

  const upserts: CalibrationHistoryUpsert[] = [];
  let cellsSparse = 0;
  let cellsEmpty = 0;
  let totalPicks = 0;
  let totalGraded = 0;
  const computedAt = new Date().toISOString();

  for (const market of SUPPORTED_MARKETS) {
    for (const tier of TIERS) {
      const bucket = buckets.get(cellKey(market, tier))!;
      const nPicks = bucket.allPicks;
      const nGraded = bucket.graded.length;
      totalPicks += nPicks;
      totalGraded += nGraded;

      if (nGraded === 0) {
        cellsEmpty += 1;
        upserts.push({
          snapshot_date: snapshotDate,
          market,
          confidence_tier: tier,
          predicted_win_rate: null,
          actual_win_rate: null,
          n_picks: nPicks,
          n_graded: 0,
          ece: null,
          brier_score: null,
          computed_at: computedAt,
        });
        continue;
      }

      const stats = computeCellStats(bucket.graded);
      // computeCellStats only returns null on empty input — guarded above.
      const sparse = nGraded < SPARSE_CELL_FLOOR;
      if (sparse) cellsSparse += 1;

      upserts.push({
        snapshot_date: snapshotDate,
        market,
        confidence_tier: tier,
        predicted_win_rate: stats!.predictedWinRate,
        actual_win_rate: stats!.actualWinRate,
        n_picks: nPicks,
        n_graded: nGraded,
        ece: sparse ? null : stats!.ece,
        brier_score: sparse ? null : stats!.brierScore,
        computed_at: computedAt,
      });
    }
  }

  // calibration_history is absent from the generated database.ts (migration
  // 0020 landed after the last `supabase gen types` run). Use a loose client
  // for the upsert until types regenerate — same pattern as pickClvFrom.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const looseClient = supabase as unknown as { from: (t: string) => any };
  const { error: upsertErr } = await looseClient
    .from('calibration_history')
    .upsert(upserts, { onConflict: 'snapshot_date,market,confidence_tier' });

  if (upsertErr) {
    const msg = `calibration_history upsert failed: ${upsertErr.message}`;
    console.error(JSON.stringify({
      level: 'error',
      event: 'calibration_snapshot_upsert_failed',
      error: msg,
      batch: upserts.length,
    }));
    errors.push(msg);
  }

  const cellsWritten = errors.length === 0 ? upserts.length : 0;
  const durationMs = Date.now() - startMs;

  console.info(JSON.stringify({
    level: errors.length > 0 ? 'warn' : 'info',
    event: 'calibration_snapshot_complete',
    snapshot_date: snapshotDate,
    cells_written: cellsWritten,
    cells_sparse: cellsSparse,
    cells_empty: cellsEmpty,
    total_picks: totalPicks,
    total_graded: totalGraded,
    errors: errors.length,
    durationMs,
  }));

  return {
    snapshotDate,
    cellsWritten,
    cellsSparse,
    cellsEmpty,
    totalPicks,
    totalGraded,
    errors,
    durationMs,
  };
}
