/**
 * Units-based ROI — single source of truth.
 *
 * Both /api/history (pick performance) and /api/bankroll (user-logged bets)
 * surface a "ROI" number that must be computed identically. Any divergence
 * here causes the two pages to disagree on the same underlying picks.
 *
 * Convention:
 *   - Each settled bet is 1 unit risked (stake is normalised away).
 *   - Win profit = unitProfit(american_odds), in units. Default odds = -110.
 *   - Loss = -1 unit. Push / void = 0 units (and not counted in risked).
 *   - ROI% = sum(unit_pl) / sum(units_risked) * 100.
 *
 * For the bankroll surface, "settled" means outcome ∈ { win, loss }. Push
 * and void are excluded from the denominator so a bankroll consisting only
 * of voids returns 0% rather than dividing by zero.
 */

export type SettledOutcome = 'win' | 'loss' | 'push' | 'void';

/** Profit (in units) for a winning bet at American `price`. Default -110. */
export function unitProfit(price: number | null | undefined): number {
  const p = price ?? -110;
  return p >= 100 ? p / 100 : 100 / Math.abs(p);
}

export interface SettledBet {
  outcome: SettledOutcome | string | null;
  /** American odds; null treated as -110 to match the history-page default. */
  price: number | null;
}

/** Returns ROI as a percentage rounded to 2 decimal places. 0 when no graded bets. */
export function unitsRoiPct(bets: SettledBet[]): number {
  let totalReturn = 0;
  let totalRisked = 0;
  for (const b of bets) {
    if (b.outcome === 'win') {
      totalReturn += unitProfit(b.price);
      totalRisked += 1;
    } else if (b.outcome === 'loss') {
      totalReturn -= 1;
      totalRisked += 1;
    }
  }
  if (totalRisked <= 0) return 0;
  return Math.round((totalReturn / totalRisked) * 10000) / 100;
}
