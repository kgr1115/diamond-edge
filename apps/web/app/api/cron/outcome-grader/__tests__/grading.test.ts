/**
 * Unit tests for the outcome grader pure-logic functions.
 * These tests have zero I/O — no DB, no Redis, no HTTP.
 * Run with: npx jest apps/web/app/api/cron/outcome-grader
 */

import {
  gradeMoneyline,
  gradeRunLine,
  gradeTotal,
  computePnL,
} from '@/lib/outcome-grader/lib';

// ---------------------------------------------------------------------------
// Helper: placeholder UUIDs for team IDs
// ---------------------------------------------------------------------------
const HOME_ID = 'aaaa0000-0000-0000-0000-000000000000';
const AWAY_ID = 'bbbb0000-0000-0000-0000-000000000000';

// ---------------------------------------------------------------------------
// gradeMoneyline
// ---------------------------------------------------------------------------
describe('gradeMoneyline', () => {
  it('returns win when home team wins and pick_side=home', () => {
    expect(gradeMoneyline('home', 5, 3, HOME_ID, AWAY_ID)).toBe('win');
  });

  it('returns loss when home team wins and pick_side=away', () => {
    expect(gradeMoneyline('away', 5, 3, HOME_ID, AWAY_ID)).toBe('loss');
  });

  it('returns win when away team wins and pick_side=away', () => {
    expect(gradeMoneyline('away', 2, 7, HOME_ID, AWAY_ID)).toBe('win');
  });

  it('returns loss when away team wins and pick_side=home', () => {
    expect(gradeMoneyline('home', 2, 7, HOME_ID, AWAY_ID)).toBe('loss');
  });

  it('returns void on tie (edge case / data issue)', () => {
    expect(gradeMoneyline('home', 3, 3, HOME_ID, AWAY_ID)).toBe('void');
  });

  it('accepts team_id as pick_side (home)', () => {
    expect(gradeMoneyline(HOME_ID, 5, 2, HOME_ID, AWAY_ID)).toBe('win');
  });

  it('accepts team_id as pick_side (away)', () => {
    expect(gradeMoneyline(AWAY_ID, 5, 2, HOME_ID, AWAY_ID)).toBe('loss');
  });

  it('returns void for unrecognized pick_side', () => {
    expect(gradeMoneyline('unknown-team-id', 5, 2, HOME_ID, AWAY_ID)).toBe('void');
  });
});

// ---------------------------------------------------------------------------
// gradeRunLine
// ---------------------------------------------------------------------------
describe('gradeRunLine', () => {
  // Standard spread: home -1.5 (stored as -1.5)
  const SPREAD = -1.5;

  it('home wins by 2+: home cover (win when pick=home)', () => {
    // home wins 5-2 (diff=3 > 1.5) → home covered
    expect(gradeRunLine('home', 5, 2, HOME_ID, AWAY_ID, SPREAD)).toBe('win');
  });

  it('home wins by exactly 1: away covers (win when pick=away)', () => {
    // home wins 4-3 (diff=1 < 1.5) → home did not cover
    expect(gradeRunLine('away', 4, 3, HOME_ID, AWAY_ID, SPREAD)).toBe('win');
  });

  it('away wins: away covers (win when pick=away)', () => {
    expect(gradeRunLine('away', 3, 7, HOME_ID, AWAY_ID, SPREAD)).toBe('win');
  });

  it('home wins by more than absSpread when home is fav: home covers', () => {
    // spread=-10, home wins by 15 → home covered
    expect(gradeRunLine('home', 20, 5, HOME_ID, AWAY_ID, -10)).toBe('win');
  });

  it('push when home win margin equals absSpread exactly', () => {
    // spread=-2: home must win by more than 2. Win by exactly 2 → push.
    expect(gradeRunLine('home', 5, 3, HOME_ID, AWAY_ID, -2)).toBe('push');
    // spread=+2 (away is fav): away must win by more than 2. Win by exactly 2 → push.
    expect(gradeRunLine('away', 3, 5, HOME_ID, AWAY_ID, 2)).toBe('push');
  });

  it('away pick_side with team_id resolves correctly', () => {
    expect(gradeRunLine(AWAY_ID, 5, 2, HOME_ID, AWAY_ID, SPREAD)).toBe('loss');
  });
});

// ---------------------------------------------------------------------------
// gradeTotal
// ---------------------------------------------------------------------------
describe('gradeTotal', () => {
  it('over wins when combined > line', () => {
    expect(gradeTotal('over', 5, 6, 9.5)).toBe('win');
  });

  it('under wins when combined < line', () => {
    expect(gradeTotal('under', 2, 3, 9.5)).toBe('win');
  });

  it('over loses when combined < line', () => {
    expect(gradeTotal('over', 2, 3, 9.5)).toBe('loss');
  });

  it('under loses when combined > line', () => {
    expect(gradeTotal('under', 5, 6, 9.5)).toBe('loss');
  });

  it('push when combined equals line exactly', () => {
    expect(gradeTotal('over', 4, 5, 9)).toBe('push');
    expect(gradeTotal('under', 4, 5, 9)).toBe('push');
  });

  it('void for unrecognized pick_side', () => {
    expect(gradeTotal('both' as 'over', 5, 6, 9.5)).toBe('void');
  });
});

// ---------------------------------------------------------------------------
// computePnL
// ---------------------------------------------------------------------------
describe('computePnL', () => {
  it('push returns 0', () => {
    expect(computePnL('push', -110)).toBe(0);
  });

  it('void returns 0', () => {
    expect(computePnL('void', null)).toBe(0);
  });

  it('loss returns -1', () => {
    expect(computePnL('loss', -110)).toBe(-1);
  });

  it('win at -110 returns ~0.909', () => {
    const pnl = computePnL('win', -110);
    expect(pnl).toBeCloseTo(100 / 110, 4);
  });

  it('win at +150 returns 1.5', () => {
    expect(computePnL('win', 150)).toBe(1.5);
  });

  it('win at +100 returns 1.0', () => {
    expect(computePnL('win', 100)).toBe(1.0);
  });

  it('win with null odds defaults to -110 payout', () => {
    expect(computePnL('win', null)).toBeCloseTo(0.909, 2);
  });
});

// ---------------------------------------------------------------------------
// Smoke test: full grading scenario simulating 3 completed games
// This matches the brief's requirement: "simulate grading, show results"
// ---------------------------------------------------------------------------
describe('smoke test: 3 completed game scenarios', () => {
  it('Game 1: NYY 5, BOS 3 — moneyline home win + run line home cover + over 8.5', () => {
    // Moneyline pick: home
    expect(gradeMoneyline('home', 5, 3, HOME_ID, AWAY_ID)).toBe('win');
    // Run line: home -1.5, home wins by 2 → home covers
    expect(gradeRunLine('home', 5, 3, HOME_ID, AWAY_ID, -1.5)).toBe('win');
    // Total: 5+3=8, line=8.5 → under wins
    expect(gradeTotal('under', 5, 3, 8.5)).toBe('win');
    expect(gradeTotal('over', 5, 3, 8.5)).toBe('loss');
  });

  it('Game 2: LAD 2, SD 4 — moneyline away win + home run line loss + under win', () => {
    // Moneyline pick: home → loss
    expect(gradeMoneyline('home', 2, 4, HOME_ID, AWAY_ID)).toBe('loss');
    // Moneyline pick: away → win
    expect(gradeMoneyline('away', 2, 4, HOME_ID, AWAY_ID)).toBe('win');
    // Run line: home -1.5, away wins → away covers
    expect(gradeRunLine('home', 2, 4, HOME_ID, AWAY_ID, -1.5)).toBe('loss');
    // Total: 2+4=6, line=8.5 → under wins
    expect(gradeTotal('under', 2, 4, 8.5)).toBe('win');
  });

  it('Game 3: HOU 3, TEX 3 (void after tie edge case)', () => {
    // In MLB ties go to extra innings so this is a data anomaly; grade as void
    expect(gradeMoneyline('home', 3, 3, HOME_ID, AWAY_ID)).toBe('void');
    // Total push: 3+3=6, line=6 → push
    expect(gradeTotal('over', 3, 3, 6)).toBe('push');
    expect(gradeTotal('under', 3, 3, 6)).toBe('push');
  });
});
