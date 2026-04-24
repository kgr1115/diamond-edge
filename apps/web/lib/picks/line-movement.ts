/**
 * Pure helpers for the line-movement sparkline rendered on pick cards.
 * Extracted from components/picks/line-movement-sparkline.tsx so Jest
 * (which isn't configured for JSX in this workspace) can test the polarity
 * logic directly.
 *
 * Stored snapshot prices come from lib/picks/load-slate.ts and are ALWAYS
 * the home_price (moneyline / run_line) or over_price (totals). For
 * away/under picks we flip to the pick-side perspective so "shortened"
 * always means the market moved TOWARD the user's pick.
 */

export interface OddsSnapshot {
  label: string; // 'AM' | 'PM' | 'Close'
  price: number; // American odds, always from the home/over side
}

export type LineDirection = 'shortened' | 'lengthened' | 'flat';

export function formatOdds(price: number): string {
  return price >= 0 ? `+${price}` : `${price}`;
}

/** Convert American odds to implied probability (raw, with vig). */
export function impliedProb(price: number): number {
  if (price >= 100) return 100 / (100 + price);
  return Math.abs(price) / (Math.abs(price) + 100);
}

function isOppositeSide(pickSide: string): boolean {
  return pickSide === 'away' || pickSide === 'under';
}

/** Implied probability of the pick side itself (opposite-side prices get flipped). */
export function pickSideImpliedProb(price: number, pickSide: string): number {
  const raw = impliedProb(price);
  return isOppositeSide(pickSide) ? 1 - raw : raw;
}

/** Direction of line movement from the pick side's perspective. */
export function computeLineDirection(snapshots: OddsSnapshot[], pickSide: string): LineDirection {
  if (snapshots.length < 2) return 'flat';
  const firstProb = pickSideImpliedProb(snapshots[0].price, pickSide);
  const lastProb = pickSideImpliedProb(snapshots[snapshots.length - 1].price, pickSide);
  if (lastProb > firstProb) return 'shortened';
  if (lastProb < firstProb) return 'lengthened';
  return 'flat';
}
