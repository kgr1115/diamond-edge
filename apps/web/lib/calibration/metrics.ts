/**
 * Calibration metric primitives — shared across the calibration-snapshot cron
 * and `pick-tester`. Extracted to a single file so the formula does not drift
 * between surfaces (per scope-gate annotation on
 * proposal `calibration-snapshot-cron-2026-05-03`).
 *
 * Conventions (per the proposal):
 *   - Push and void picks are EXCLUDED from win-rate, ECE, and Brier
 *     denominators. The caller filters those out before invoking these
 *     functions; this module does not look at result strings.
 *   - `outcome` is binary: 1 for win, 0 for loss.
 *   - `predictedProb` is the model's calibrated probability for the picked
 *     side at pick-generation time.
 */

export interface CellSample {
  predictedProb: number;
  outcome: 0 | 1;
}

export interface CellStats {
  predictedWinRate: number;
  actualWinRate: number;
  ece: number;
  brierScore: number;
}

/**
 * Per-tier (per-cell) stats. The "binning" used by ECE here IS the tier
 * itself — so the per-cell ECE is the absolute deviation between the cell's
 * mean predicted probability and its empirical win rate. Aggregate ECE
 * across cells should be computed by `aggregateEce` over the per-cell
 * absolute deviations weighted by sample count.
 *
 * Caller MUST filter out push/void picks before calling. Returns null if
 * `samples` is empty (caller decides how to surface that — the cron writes
 * NULL into ece/brier_score for sparse cells).
 */
export function computeCellStats(samples: CellSample[]): CellStats | null {
  if (samples.length === 0) return null;

  let predictedSum = 0;
  let outcomeSum = 0;
  let squaredErrorSum = 0;

  for (const s of samples) {
    predictedSum += s.predictedProb;
    outcomeSum += s.outcome;
    const err = s.predictedProb - s.outcome;
    squaredErrorSum += err * err;
  }

  const predictedWinRate = predictedSum / samples.length;
  const actualWinRate = outcomeSum / samples.length;
  const ece = Math.abs(predictedWinRate - actualWinRate);
  const brierScore = squaredErrorSum / samples.length;

  return { predictedWinRate, actualWinRate, ece, brierScore };
}

export interface CellEceInput {
  predictedWinRate: number;
  actualWinRate: number;
  n: number;
}

/**
 * Aggregate ECE across multiple cells using n-weighted mean of per-cell
 * absolute deviations. Cells with n=0 are ignored. Returns null if all cells
 * are empty.
 */
export function aggregateEce(cells: CellEceInput[]): number | null {
  let weightedAbsDevSum = 0;
  let totalN = 0;
  for (const c of cells) {
    if (c.n <= 0) continue;
    weightedAbsDevSum += Math.abs(c.predictedWinRate - c.actualWinRate) * c.n;
    totalN += c.n;
  }
  if (totalN === 0) return null;
  return weightedAbsDevSum / totalN;
}
