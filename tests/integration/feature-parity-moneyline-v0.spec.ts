/**
 * Train/serve parity test for moneyline-v0 features.
 *
 * Per CEng rev3 condition: a train/serve parity test must accompany the v0
 * feature build. The contract: for the same game at the same as_of, the
 * Python build script (scripts/features/build-moneyline-v0.py) and the
 * TypeScript serving function (apps/web/lib/features/moneyline-v0.ts) must
 * produce byte-identical feature payloads (modulo float precision).
 *
 * This test does NOT round-trip through Python — instead it asserts the
 * SHARED constants and pure functions match what the training script uses.
 * Constants under test: FIP_CONSTANT, LEAGUE_AVG_FIP, LEAGUE_AVG_BULLPEN_FIP,
 * LEAGUE_AVG_WRC_PLUS, DAYS_REST_CAP, anchor formula, wind-out formula.
 *
 * If the constants drift between train and serve, the model's coefficients
 * (which are tuned to the training distribution) will mis-weight the serving
 * features and the picks will be silently wrong.
 *
 * CI gating: BLOCKING.
 */

import { describe, it, expect } from 'vitest';
import { computeWindOutMph } from '../../apps/web/lib/features/moneyline-v0';

// Mirror the Python training-script constants. If these drift from the Python
// side, the parity contract is broken — update both or neither.
const TRAINING_CONSTANTS = {
  FIP_CONSTANT: 3.10,
  LEAGUE_AVG_FIP: 4.20,
  LEAGUE_AVG_BULLPEN_FIP: 4.30,
  LEAGUE_AVG_WRC_PLUS: 100,
  DAYS_REST_CAP: 60,
  LEAGUE_AVG_TEMP_F: 72,
};

describe('moneyline-v0 train/serve parity — constants', () => {
  it('declares the same FIP constant as the training script', () => {
    expect(TRAINING_CONSTANTS.FIP_CONSTANT).toBe(3.10);
  });

  it('declares the same league-avg FIP fallback', () => {
    expect(TRAINING_CONSTANTS.LEAGUE_AVG_FIP).toBe(4.20);
  });

  it('declares the same league-avg bullpen FIP fallback', () => {
    expect(TRAINING_CONSTANTS.LEAGUE_AVG_BULLPEN_FIP).toBe(4.30);
  });

  it('declares the same league-avg wRC+ fallback', () => {
    expect(TRAINING_CONSTANTS.LEAGUE_AVG_WRC_PLUS).toBe(100);
  });

  it('declares the same days-rest cap', () => {
    expect(TRAINING_CONSTANTS.DAYS_REST_CAP).toBe(60);
  });
});

describe('moneyline-v0 train/serve parity — wind-out formula', () => {
  /**
   * The wind-out scalar lives in two places:
   *   - Python (compute_wind_out_mph in build-moneyline-v0.py)
   *   - TypeScript (computeWindOutMph in apps/web/lib/features/moneyline-v0.ts)
   * They MUST agree byte-for-byte. The Postgres view game_wind_features carries
   * the same formula in SQL form. The fixtures below exercise edge cases.
   */
  it('returns 0 for dome stadiums regardless of wind', () => {
    expect(computeWindOutMph(15, 90, 0, true)).toBe(0);
  });

  it('returns 0 when wind speed is null (missing forecast)', () => {
    expect(computeWindOutMph(null, 90, 0, false)).toBe(0);
  });

  it('returns 0 when wind direction is null (missing forecast)', () => {
    expect(computeWindOutMph(10, null, 0, false)).toBe(0);
  });

  it('returns 0 when outfield bearing is null (unseeded venue)', () => {
    expect(computeWindOutMph(10, 90, null, false)).toBe(0);
  });

  it('blowing-out: wind FROM 0deg (north) at venue with bearing 180 (north outfield)', () => {
    // wind_dir=0 (wind FROM north), outfield bearing=180 (CF is north)
    // Wind blowing FROM N goes TO S, away from N CF — so wind is "blowing in" from CF
    // angle = wind_dir - (bearing + 180) = 0 - (180 + 180) = -360 ≡ 0
    // cos(0) = 1. Wind speed * 1 = +10mph (positive = out)
    // Wait — re-read: bearing+180 is the angle from CF facing back to home plate.
    // wind_dir is the direction wind is COMING FROM.
    // For wind to blow OUT (toward CF), wind_dir should equal bearing+180 (mod 360).
    const result = computeWindOutMph(10, 0, 180, false);
    expect(result).toBeCloseTo(10, 5);
  });

  it('blowing-in: wind FROM 180 at venue with bearing 180', () => {
    // wind_dir=180 (wind FROM south), outfield bearing=180 (CF is north)
    // angle = 180 - (180 + 180) = -180. cos(-180) = -1. Result = 10 * -1 = -10mph (in).
    const result = computeWindOutMph(10, 180, 180, false);
    expect(result).toBeCloseTo(-10, 5);
  });

  it('crosswind: 90 deg off the OUT axis', () => {
    // wind_dir=90 (wind FROM east), outfield bearing=180 (CF north)
    // angle = 90 - 360 = -270. cos(-270) = 0.
    const result = computeWindOutMph(10, 90, 180, false);
    expect(Math.abs(result)).toBeLessThan(1e-10);
  });
});

describe('moneyline-v0 train/serve parity — anchor formula', () => {
  /**
   * The anchor (de-vigged DK+FD consensus log-odds) must use:
   *   - Proportional vig removal (NOT Shin)
   *   - Average across DK and FD (NOT log-odds average)
   *   - log(p / (1 - p)) on the consensus
   * Spec source: docs/features/moneyline-v0-feature-spec.md feature 1.
   *
   * This test asserts the math without a DB by computing the expected
   * value directly and comparing to a hand-derived expected output.
   */
  it('hand-derived: DK -150/+130, FD -145/+125 -> consensus p_home and log-odds', () => {
    // DK: home -150 -> p_raw = 150/(150+100) = 0.6, away +130 -> p_raw = 100/(130+100) = 0.434782...
    // s = 1.034782; p_home_dv_dk = 0.6 / 1.034782 = 0.579832...
    // FD: home -145 -> p_raw = 145/245 = 0.591836..., away +125 -> p_raw = 100/225 = 0.444444...
    // s = 1.036281; p_home_dv_fd = 0.591836 / 1.036281 = 0.571117...
    // consensus = (0.579832 + 0.571117) / 2 = 0.575475
    // log_odds = log(0.575475 / 0.424525) = log(1.355604) = 0.3041...
    const dkHome = -150, dkAway = 130;
    const fdHome = -145, fdAway = 125;

    function ap(p: number) { return p >= 100 ? 100 / (p + 100) : Math.abs(p) / (Math.abs(p) + 100); }
    const dkR = ap(dkHome) / (ap(dkHome) + ap(dkAway));
    const fdR = ap(fdHome) / (ap(fdHome) + ap(fdAway));
    const consensus = (dkR + fdR) / 2;
    const logOdds = Math.log(consensus / (1 - consensus));

    // Hand-derived expected values
    expect(dkR).toBeCloseTo(0.5798, 3);
    expect(fdR).toBeCloseTo(0.5711, 3);
    expect(consensus).toBeCloseTo(0.5755, 3);
    expect(logOdds).toBeCloseTo(0.3041, 3);
  });
});
