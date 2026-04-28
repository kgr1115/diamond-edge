-- Migration 0020 — calibration_history table
--
-- Per pick-scope-gate-2026-04-28.md Proposal 8 (P2).
--
-- Daily snapshot of per-(market × tier) calibration health: predicted vs
-- actual win rate, ECE, Brier score, sample size. Populated by the
-- /api/cron/calibration-snapshot route running once per day.
--
-- Enables operational alerting when calibration drifts and trending across
-- model retrains.

CREATE TABLE IF NOT EXISTS calibration_history (
  snapshot_date date NOT NULL,
  market text NOT NULL CHECK (market IN ('moneyline', 'run_line', 'total')),
  confidence_tier smallint NOT NULL CHECK (confidence_tier BETWEEN 1 AND 5),
  -- Aggregates over the trailing 60-day window relative to snapshot_date.
  predicted_win_rate real,         -- mean of model_probability across graded picks
  actual_win_rate real,            -- wins / (wins + losses)
  n_picks integer NOT NULL,        -- total picks in the window
  n_graded integer NOT NULL,       -- wins + losses
  ece real,                        -- expected calibration error
  brier_score real,                -- mean squared error of probability vs binary outcome
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (snapshot_date, market, confidence_tier)
);

CREATE INDEX IF NOT EXISTS calibration_history_market_date_idx
  ON calibration_history (market, snapshot_date DESC);

COMMENT ON TABLE calibration_history IS
  'Daily calibration health snapshot — see docs/ml/tier-calibration.md and '
  '/api/cron/calibration-snapshot. Populated by Vercel cron, queried by '
  'monitoring alerts and the (deferred) auto-calibrated tier-boundary fitter.';
