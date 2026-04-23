-- Diamond Edge — picks.feature_attributions column
-- Run order: 13 (depends on: 0005_pick_tables)
--
-- Stores SHAP-style feature attributions produced by the Fly.io worker /predict
-- endpoint. The pipeline writes this at insert time; the picks-today API route
-- reads it and passes it through as shap_attributions for Elite users.
--
-- Structure mirrors FeatureAttribution in worker/models/pick_candidate_schema.py
-- and apps/web/lib/ai/types.ts — kept in sync manually.
--
-- Example value:
-- [{"feature_name":"home_starter_era","feature_value":2.14,"shap_value":0.31,
--   "direction":"positive","label":"Home Starter ERA (30-day): 2.14"}]
--
-- Nullable: pre-migration picks and shadow picks without attributions land with null.

ALTER TABLE picks
  ADD COLUMN IF NOT EXISTS feature_attributions jsonb;

COMMENT ON COLUMN picks.feature_attributions IS
  'Top-N SHAP feature attributions from /predict. Array of {feature_name, feature_value, shap_value, direction, label}. Null for pre-0013 picks and shadow picks.';

CREATE INDEX IF NOT EXISTS idx_picks_feature_attributions_not_null
  ON picks(id)
  WHERE feature_attributions IS NOT NULL;
