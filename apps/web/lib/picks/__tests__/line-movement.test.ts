/**
 * Unit tests for the line-movement sparkline direction helper.
 * Pure logic — no DOM, no I/O.
 * Run with: npx jest apps/web/lib/picks/__tests__/line-movement.test.ts
 *
 * Stored snapshot prices are always the home-side (moneyline/run_line) or
 * over-side (totals) American odds, per load-slate.ts. These tests cover
 * all 8 pick_side × favorite/dog combinations to prevent polarity regressions.
 */

import {
  computeLineDirection,
  pickSideImpliedProb,
  type OddsSnapshot,
} from '@/lib/picks/line-movement';

const snap = (price: number, label = 'X'): OddsSnapshot => ({ label, price });

describe('pickSideImpliedProb', () => {
  it('returns the raw implied prob for home pick', () => {
    // -150 implied prob = 150/250 = 0.60
    expect(pickSideImpliedProb(-150, 'home')).toBeCloseTo(0.6, 5);
  });

  it('returns the raw implied prob for over pick', () => {
    // +120 implied prob = 100/220 ≈ 0.4545
    expect(pickSideImpliedProb(120, 'over')).toBeCloseTo(100 / 220, 5);
  });

  it('flips to opposite side for away pick (stored price is home_price)', () => {
    // home at -150 = 0.60 → away = 0.40
    expect(pickSideImpliedProb(-150, 'away')).toBeCloseTo(0.4, 5);
  });

  it('flips to opposite side for under pick (stored price is over_price)', () => {
    // over at -110 = 110/210 ≈ 0.5238 → under ≈ 0.4762
    expect(pickSideImpliedProb(-110, 'under')).toBeCloseTo(1 - 110 / 210, 5);
  });
});

describe('computeLineDirection — home side', () => {
  it('home favorite shortens (-150 → -170) → shortened (favorable)', () => {
    expect(computeLineDirection([snap(-150), snap(-170)], 'home')).toBe('shortened');
  });

  it('home favorite lengthens (-170 → -150) → lengthened', () => {
    expect(computeLineDirection([snap(-170), snap(-150)], 'home')).toBe('lengthened');
  });

  it('home dog shortens (+140 → +120) → shortened (favorable)', () => {
    expect(computeLineDirection([snap(140), snap(120)], 'home')).toBe('shortened');
  });

  it('home dog lengthens (+120 → +140) → lengthened', () => {
    expect(computeLineDirection([snap(120), snap(140)], 'home')).toBe('lengthened');
  });
});

describe('computeLineDirection — away side (stored price is home_price)', () => {
  it('away dog shortens (home -150 → -130, i.e. away +130 → +110) → shortened (favorable)', () => {
    // home price getting LESS favorable means away price getting MORE favorable
    expect(computeLineDirection([snap(-150), snap(-130)], 'away')).toBe('shortened');
  });

  it('away dog lengthens (home -130 → -150) → lengthened', () => {
    expect(computeLineDirection([snap(-130), snap(-150)], 'away')).toBe('lengthened');
  });

  it('away favorite shortens (home +140 → +160) → shortened (favorable)', () => {
    // home at +140 means home is the dog; away at roughly -160 is the favorite.
    // home price moving from +140 to +160 = home less likely = away more likely.
    expect(computeLineDirection([snap(140), snap(160)], 'away')).toBe('shortened');
  });

  it('away favorite lengthens (home +160 → +140) → lengthened', () => {
    expect(computeLineDirection([snap(160), snap(140)], 'away')).toBe('lengthened');
  });
});

describe('computeLineDirection — over side', () => {
  it('over dog shortens (+105 → -105) → shortened (favorable)', () => {
    expect(computeLineDirection([snap(105), snap(-105)], 'over')).toBe('shortened');
  });

  it('over favorite lengthens (-120 → -105) → lengthened', () => {
    expect(computeLineDirection([snap(-120), snap(-105)], 'over')).toBe('lengthened');
  });
});

describe('computeLineDirection — under side (stored price is over_price)', () => {
  it('under lengthens when over price drops (over -110 → -125 = over prob up = under prob down)', () => {
    // over at -110 → over prob 0.5238; under prob 0.4762
    // over at -125 → over prob 0.5556; under prob 0.4444 (lower) → lengthened
    expect(computeLineDirection([snap(-110), snap(-125)], 'under')).toBe('lengthened');
  });

  it('under shortens (over -125 → -110) → shortened (favorable)', () => {
    // over prob 0.5556 → 0.5238; under prob 0.4444 → 0.4762 (rises) = favorable
    expect(computeLineDirection([snap(-125), snap(-110)], 'under')).toBe('shortened');
  });
});

describe('computeLineDirection — edge cases', () => {
  it('zero movement (first === last) → flat', () => {
    expect(computeLineDirection([snap(-150), snap(-150)], 'home')).toBe('flat');
  });

  it('single snapshot → flat (no direction claim)', () => {
    expect(computeLineDirection([snap(-150)], 'home')).toBe('flat');
  });

  it('empty snapshots → flat (no crash)', () => {
    expect(computeLineDirection([], 'home')).toBe('flat');
  });

  it('three-snapshot trend uses first and last (middle bounces)', () => {
    // home -150 → -120 → -170: first=0.60, last≈0.6296 → shortened
    expect(computeLineDirection([snap(-150), snap(-120), snap(-170)], 'home')).toBe('shortened');
  });
});
