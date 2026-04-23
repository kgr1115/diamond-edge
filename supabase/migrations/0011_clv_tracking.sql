-- Diamond Edge — CLV Tracking Table
-- Run order: 11 (depends on: picks from migration 0005)
--
-- Closing Line Value (CLV) is the primary signal that a model is generating
-- genuine edge vs the market. A pick with positive CLV means the market moved
-- toward our pick between pick-generation time and first pitch — indicating the
-- market later "agreed" with us.
--
-- CLV is computed nightly by the cron at /api/cron/clv-compute after game final.
-- All writes are service-role-only. No user-facing reads.

CREATE TABLE pick_clv (
  pick_id               uuid        PRIMARY KEY REFERENCES picks(id) ON DELETE CASCADE,
  pick_time_novig_prob  real        NOT NULL,   -- model's novig prob at pick generation time
  closing_novig_prob    real,                   -- novig from final odds snapshot before first pitch
  clv_edge              real,                   -- closing_novig_prob - pick_time_novig_prob
                                                -- positive = line moved toward us (real edge signal)
  computed_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_pick_clv_computed ON pick_clv(computed_at DESC);

-- Partial index for quickly finding records with CLV computed
CREATE INDEX idx_pick_clv_edge_nonnull ON pick_clv(clv_edge) WHERE clv_edge IS NOT NULL;

ALTER TABLE pick_clv ENABLE ROW LEVEL SECURITY;

-- Service role manages all CLV writes and reads; no user-facing access.
-- The frontend aggregates CLV via a service-role API route, not direct table access.
CREATE POLICY pick_clv_service_role ON pick_clv
  FOR ALL
  USING (false)
  WITH CHECK (false);
