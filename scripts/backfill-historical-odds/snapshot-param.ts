/**
 * Pure snapshot-timestamp computation for the per-game historical odds re-pull.
 *
 * Extracted as its own module so the regression test
 * (tests/integration/backfill-historical-odds-pergame.spec.ts) can import the
 * function without pulling in pg / fs / dotenv.
 *
 * THE FIX: snapshot is computed per game as `game_time_utc - 75min`.
 *
 * Why a dedicated 75-minute offset:
 *   - The live ingester pins the closing snapshot at game_time_utc - 60min.
 *   - The look-ahead audit filter is `snapshotted_at <= as_of` where as_of =
 *     game_time_utc - 60min for v0.
 *   - Targeting T-75min in the historical pull gives the API archive a 15-min
 *     cushion to find the nearest archived snap that still satisfies the
 *     strict T-60 audit predicate.
 *
 * Bug under regression: the original per-batch script (run.ts) used
 * `nextDay 03:00 UTC` for every game in a batch — wall-clock-style stamping
 * that landed AFTER first pitch on night games.
 */

export const SNAPSHOT_OFFSET_MIN = 75;

export function computeSnapshotParam(gameTimeUtc: Date | string): string {
  const t = typeof gameTimeUtc === 'string' ? new Date(gameTimeUtc) : gameTimeUtc;
  if (Number.isNaN(t.getTime())) {
    throw new Error(`Invalid game_time_utc: ${String(gameTimeUtc)}`);
  }
  const target = new Date(t.getTime() - SNAPSHOT_OFFSET_MIN * 60 * 1000);
  // The Odds API historical endpoint REJECTS millisecond-precision ISO 8601
  // (returns 422 INVALID_HISTORICAL_TIMESTAMP). Strip the .000 to get the
  // YYYY-MM-DDTHH:MM:SSZ form the API actually accepts.
  return target.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
