-- Migration 0025: game_wind_features view
-- Joins games + park_factor_runs to derive weather_wind_out_mph.
-- Not a materialized view — computation is cheap (one cosine per row).
-- NOT SECURITY DEFINER — RLS evaluated on base tables:
--   games = public-read, park_factor_runs = service-role-only.
-- Authenticated/anon callers will not see park_factor_runs columns.
-- Depends on: 0024_park_factor_runs.sql, 0004_core_tables.sql (games)
--
-- weather_wind_dir note: games.weather_wind_dir is stored as TEXT.
-- The view casts it to NUMERIC assuming numeric degree strings (e.g. '270').
-- If the ingester writes cardinal strings ('N', 'NW', etc.) the cast
-- returns NULL, and the CASE falls back to 0.0 (no wind effect).
-- mlb-data-engineer must confirm/normalize the stored format.

CREATE OR REPLACE VIEW game_wind_features AS
SELECT
  g.id                                              AS game_id,
  g.venue_name,
  g.weather_wind_mph,
  g.weather_wind_dir,
  pf.outfield_bearing_deg,
  pf.is_dome,
  pf.runs_factor                                    AS park_factor_runs,
  -- weather_wind_out_mph derivation:
  --   direction_scalar = COS(wind_direction - (outfield_bearing + 180))
  --   outfield_bearing + 180 converts the home-plate-to-CF bearing to the
  --   "wind blowing out" meteorological convention.
  --   wind_dir == outfield_bearing => blowing out (+1.0)
  --   wind_dir == outfield_bearing + 180 => blowing in (-1.0)
  --   crosswind => 0.0
  CASE
    WHEN pf.is_dome = true
      THEN 0.0
    WHEN g.weather_wind_mph IS NULL OR g.weather_wind_dir IS NULL
      THEN 0.0
    WHEN g.weather_wind_dir !~ '^\s*-?\d+(\.\d+)?\s*$'
      THEN 0.0  -- non-numeric string stored (e.g. 'N', 'NW'); treat as no wind effect
    WHEN pf.outfield_bearing_deg IS NULL
      THEN NULL  -- venue not seeded; feature layer must fall back to 0.0
    ELSE
      ROUND(
        (g.weather_wind_mph * COS(RADIANS(
          g.weather_wind_dir::NUMERIC
          - (pf.outfield_bearing_deg + 180)::NUMERIC
        )))::NUMERIC,
        2
      )
  END                                               AS weather_wind_out_mph,
  g.updated_at                                      AS games_updated_at
FROM games g
LEFT JOIN park_factor_runs pf
  ON g.venue_name = pf.venue_name;

COMMENT ON VIEW game_wind_features IS
  'Derives weather_wind_out_mph from games.weather_wind_mph + '
  'games.weather_wind_dir and park_factor_runs.outfield_bearing_deg. '
  'Positive = wind blowing out toward center field; negative = blowing in; '
  '0.0 = crosswind, dome, or missing wind data. '
  'Returns NULL for weather_wind_out_mph when outfield_bearing_deg is not '
  'seeded; feature layer must substitute 0.0 per moneyline-v0 null rule. '
  'See ADR-003.';

-- Restrict to service-role only, matching the park_factor_runs RLS posture.
-- Anon and authenticated users cannot query this view for park factor data.
REVOKE ALL ON game_wind_features FROM anon, authenticated;
GRANT SELECT ON game_wind_features TO service_role;
