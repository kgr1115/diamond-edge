# Moneyline v0 — Migration Spec

**Date:** 2026-04-30  
**Author:** mlb-architect  
**ADR:** ADR-003-moneyline-v0-schema-additions.md  
**Status:** Design spec — mlb-backend translates to Supabase migration files. No SQL has been executed.

---

## Migration order

These four changes are independent of each other and can be applied in any order. The recommended order minimizes risk:

1. `0023_lineup_entries_pinned_at.sql` — column addition, no data movement
2. `0024_park_factor_runs.sql` — new table, no dependencies
3. `0025_game_wind_features_view.sql` — view, depends on `park_factor_runs` (migration 0024) and existing `games`
4. `0026_odds_closing_snapshot.sql` — column addition + index on `odds`

Migration 0025 must run after 0024. Migrations 0023 and 0026 are independent of all others.

---

## Migration 0023: `lineup_entries.pinned_at`

### DDL

```sql
-- Migration 0023: add pinned_at to lineup_entries
-- Backward-compatible: nullable column, no DEFAULT.
-- Existing rows get NULL (correct — no historical pin was taken).

ALTER TABLE lineup_entries
  ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ;

COMMENT ON COLUMN lineup_entries.pinned_at IS
  'Timestamp at which this row was explicitly snapshotted as the T-60min training pin. '
  'NULL for historical rows without a deliberate pin. Distinct from updated_at, '
  'which reflects the most recent write. Set by the lineup-sync cron when it '
  'materializes a confirmed lineup snapshot for feature construction.';

-- Index to support the feature layer join:
-- WHERE game_id = :game_id AND team_id = :team_id AND pinned_at <= :as_of
-- and the look-ahead audit:
-- WHERE pinned_at IS NOT NULL ORDER BY pinned_at
CREATE INDEX IF NOT EXISTS idx_le_pinned_at
  ON lineup_entries(game_id, team_id, pinned_at)
  WHERE pinned_at IS NOT NULL;
```

### Backfill plan

**No backfill needed.** Historical rows correctly carry `pinned_at = NULL`. The feature layer's null-handling rule (treat NULL as "use `updated_at` as proxy pin") covers training rows. The look-ahead audit must flag `pinned_at IS NULL` rows as "unauditable" (coverage flag bit, not a hard exclusion) so the audit report shows the proportion of training rows with vs. without a verified pin. mlb-calibrator decides if the unverified-pin proportion disqualifies the 2022–2024 slice.

New rows written by `lineup-sync` after this migration should set `pinned_at` when the lineup is confirmed as the T-60min snapshot. The ingestion code change is mlb-data-engineer's responsibility.

### Idempotency

`IF NOT EXISTS` guards on both `ADD COLUMN` and `CREATE INDEX`. Safe to re-run.

### RLS

`lineup_entries` already has `service_role_only` RLS (from migration 0012). No policy change needed. The new column is within the existing policy boundary.

### Rollback

```sql
DROP INDEX IF EXISTS idx_le_pinned_at;
ALTER TABLE lineup_entries DROP COLUMN IF EXISTS pinned_at;
```

No data loss risk — the column is additive and NULL for all existing rows.

---

## Migration 0024: `park_factor_runs` table

### DDL

```sql
-- Migration 0024: park_factor_runs static lookup table
-- ~30 rows; one per MLB venue. Seeded manually from FanGraphs/BBRef.
-- Updated once per season (January or after ~2 months of current-season data).

CREATE TABLE IF NOT EXISTS park_factor_runs (
  venue_name            TEXT         PRIMARY KEY,
  -- Runs park factor, normalized to 100 (100 = league avg).
  -- Source: multi-year average from FanGraphs or Baseball Reference.
  runs_factor           NUMERIC(5,2) NOT NULL,
  -- Home plate to center field compass bearing, degrees 0-359.
  -- 0 = center field is due North of home plate, etc.
  -- Used by game_wind_features view to derive weather_wind_out_mph.
  outfield_bearing_deg  SMALLINT     CHECK (outfield_bearing_deg BETWEEN 0 AND 359),
  -- True for retractable or fixed dome stadiums.
  -- Weather features default to 0 (temp 72F, wind 0.0) for dome venues.
  is_dome               BOOLEAN      NOT NULL DEFAULT false,
  -- Human-readable note on which seasons the factor covers.
  -- Not a PK component; informational only.
  season_years          TEXT,
  -- Source attribution for annual update audit.
  source                TEXT         NOT NULL DEFAULT 'fangraphs',
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE park_factor_runs IS
  'Static venue-level runs park factor. One row per MLB venue. '
  'Seeded from FanGraphs or Baseball Reference multi-year factors. '
  'Updated once per season. Service-role-only — not user-facing.';

COMMENT ON COLUMN park_factor_runs.outfield_bearing_deg IS
  'Compass bearing from home plate toward center field (0-359 degrees). '
  'Used to derive weather_wind_out_mph in the game_wind_features view. '
  'NULL if not yet seeded for this venue; view returns NULL wind scalar.';

COMMENT ON COLUMN park_factor_runs.runs_factor IS
  'Multi-year average runs park factor, normalized to 100. '
  '100 = league average. >100 = hitter-friendly. <100 = pitcher-friendly.';

ALTER TABLE park_factor_runs ENABLE ROW LEVEL SECURITY;

-- No authenticated or anon reads. Feature construction is service-role only.
CREATE POLICY "park_factor_runs_service_role_only" ON park_factor_runs
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
```

### Seed data

The data engineer populates the 30 rows at backfill time. This migration creates the table only; the seed INSERT batch is a separate one-time script (not a migration file) in `scripts/seed/park-factor-runs-seed.sql`. Keeping the seed out of the migration file allows re-seeding without re-running migrations.

The seed script must include `ON CONFLICT (venue_name) DO UPDATE` so it is safely re-runnable.

### Idempotency

`CREATE TABLE IF NOT EXISTS`. `CREATE POLICY` is not idempotent by default — the backend agent should add `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$` guards or use a migration framework that handles this. Pattern recommendation:

```sql
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'park_factor_runs'
      AND policyname = 'park_factor_runs_service_role_only'
  ) THEN
    CREATE POLICY "park_factor_runs_service_role_only" ON park_factor_runs
      USING (auth.role() = 'service_role')
      WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;
```

### RLS

Service-role-only. No authenticated or anon SELECT grant. The table is an analytics reference — no user surface in v1.

### Rollback

```sql
DROP TABLE IF EXISTS park_factor_runs CASCADE;
-- CASCADE drops the game_wind_features view (migration 0025) if present.
-- Re-run migration 0025 after restoring 0024 if rolling back selectively.
```

---

## Migration 0025: `game_wind_features` view

**Depends on:** migration 0024 (`park_factor_runs` must exist).

### DDL

```sql
-- Migration 0025: game_wind_features view
-- Joins games + park_factor_runs to derive weather_wind_out_mph.
-- Not a materialized view — computation is cheap (one cosine per row).
-- NOT SECURITY DEFINER — RLS evaluated on base tables (games = public,
-- park_factor_runs = service_role_only). Authenticated/anon callers
-- will not see park_factor_runs columns through this view.

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
  -- direction_scalar = COS(wind_direction - (outfield_bearing + 180))
  -- outfield_bearing + 180 is the "into center field" wind direction.
  -- wind_dir and outfield_bearing_deg are both 0-359 compass degrees
  -- (Open-Meteo returns wind_dir as degrees where 0/360 = North, 90 = East).
  -- Positive = blowing out, negative = blowing in, zero = crosswind.
  CASE
    WHEN pf.is_dome = true
      THEN 0.0
    WHEN g.weather_wind_mph IS NULL OR g.weather_wind_dir IS NULL
      THEN 0.0
    WHEN pf.outfield_bearing_deg IS NULL
      THEN NULL  -- venue not seeded; feature layer falls back to 0.0
    ELSE
      ROUND(
        (g.weather_wind_mph * COS(RADIANS(
          CAST(g.weather_wind_dir AS NUMERIC)
          - CAST((pf.outfield_bearing_deg + 180) AS NUMERIC)
        )))::NUMERIC,
        2
      )
  END                                               AS weather_wind_out_mph,
  g.updated_at                                      AS games_updated_at
FROM games g
LEFT JOIN park_factor_runs pf
  ON g.venue_name = pf.venue_name;

COMMENT ON VIEW game_wind_features IS
  'Derives weather_wind_out_mph from games.weather_wind_mph + games.weather_wind_dir '
  'and park_factor_runs.outfield_bearing_deg. Positive = wind blowing out toward '
  'center field; negative = wind blowing in; 0 = crosswind or dome. '
  'Returns NULL for weather_wind_out_mph when outfield_bearing_deg is not seeded. '
  'Feature layer must handle NULL per moneyline-v0-feature-spec null rule (fall back to 0.0).';
```

### Note on `weather_wind_dir` type

The `games` table stores `weather_wind_dir` as `TEXT`. Open-Meteo returns wind direction as numeric degrees (e.g., `"270"` for due west). The view casts the text to NUMERIC for the cosine computation. If the data engineer stores cardinal strings (`"N"`, `"NW"`, etc.) instead of degrees, the cast will fail — the ingestion job must normalize to numeric degrees before writing. mlb-data-engineer must confirm the format written to `games.weather_wind_dir` matches the numeric-degree assumption.

### Idempotency

`CREATE OR REPLACE VIEW` is idempotent. Safe to re-run.

### RLS

View inherits base table RLS. `games` is public-read; `park_factor_runs` is service-role-only. Postgres evaluates RLS on base tables when the view is not SECURITY DEFINER, so authenticated/anon users querying `game_wind_features` will see `game_id`, `venue_name`, and weather columns from `games`, but `park_factor_runs` columns (`outfield_bearing_deg`, `is_dome`, `park_factor_runs`, `weather_wind_out_mph`) will return NULL or raise a permission error depending on Supabase's view security mode. mlb-backend should test this boundary and, if needed, restrict the view to service-role with a GRANT.

Recommended explicit grant:
```sql
REVOKE ALL ON game_wind_features FROM anon, authenticated;
GRANT SELECT ON game_wind_features TO service_role;
```

### Rollback

```sql
DROP VIEW IF EXISTS game_wind_features;
```

No data loss. Re-run migration 0025 to restore.

---

## Migration 0026: `odds.closing_snapshot`

### DDL

```sql
-- Migration 0026: add closing_snapshot flag to odds
-- Backward-compatible: NOT NULL DEFAULT false — existing rows correctly
-- default to "not a closing snapshot" without a backfill pass.

ALTER TABLE odds
  ADD COLUMN IF NOT EXISTS closing_snapshot BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN odds.closing_snapshot IS
  'True when this snapshot was captured at or after game_time_utc, or within '
  'the pre-game closing window (default: game_time_utc - 5 minutes) with no '
  'subsequent line movement detected. Set by the odds-refresh ingester. '
  'Used by the feature layer to identify the closing line for CLV computation '
  'and training-data construction. See ADR-003 for the flag semantics.';

-- Partial index: supports the common query pattern
-- "fetch the closing row per game per book per market"
-- without scanning the full odds append log.
CREATE UNIQUE INDEX IF NOT EXISTS idx_odds_closing_per_game_book_market
  ON odds(game_id, sportsbook_id, market)
  WHERE closing_snapshot = true;

-- Secondary index for the look-ahead audit query:
-- WHERE closing_snapshot = true AND snapshotted_at <= :as_of
-- (this combination should never appear in a valid training row)
CREATE INDEX IF NOT EXISTS idx_odds_closing_snapshotted_at
  ON odds(snapshotted_at DESC)
  WHERE closing_snapshot = true;
```

**Why a UNIQUE partial index:** Enforces at most one closing snapshot per (game, book, market) triple at the database level. If the ingester accidentally runs twice near game start and tries to flag two rows as closing, the second INSERT/UPDATE fails rather than silently creating duplicate closing lines. The constraint is intentional — mlb-data-engineer's ingester logic should handle the unique violation by treating the earlier closing row as authoritative (or by setting the existing `closing_snapshot = false` before inserting the new one).

### Backfill plan

Existing 2026 `odds` rows: leave `closing_snapshot = false`. The `odds-refresh` cron will begin setting the flag on new snapshots after this migration. For historical backfill (2022–2024 via Odds API historical endpoint), mlb-data-engineer's backfill script should set `closing_snapshot = true` on whichever row per (game, book, market) represents the closest available snapshot to game end. The exact logic is mlb-data-engineer's to define; the schema is ready.

**Historical rows cannot be retroactively flagged without the backfill script** — this is expected. For the 2026 live season, the flag becomes meaningful immediately after migration 0026 applies.

### Idempotency

`ADD COLUMN IF NOT EXISTS` and `CREATE UNIQUE INDEX IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`. Safe to re-run. Note: the unique index will fail on re-run if duplicate `closing_snapshot = true` rows already exist for the same (game, book, market) — this would indicate a data integrity problem, not a migration problem.

### RLS

`odds` is already public-read (from migration 0004). `closing_snapshot` is a public column — closing-line data is part of the pick performance record and must be visible for CLV display. No RLS change needed.

### Rollback

```sql
DROP INDEX IF EXISTS idx_odds_closing_per_game_book_market;
DROP INDEX IF EXISTS idx_odds_closing_snapshotted_at;
ALTER TABLE odds DROP COLUMN IF EXISTS closing_snapshot;
```

Data loss: `closing_snapshot` flag values on live rows are lost. Re-flagging requires re-running the ingester's closing-snapshot logic against already-processed games, which may not be feasible for past games. Roll back only if the column itself is problematic — not as a routine revert.

---

## Cross-Cutting Concerns

### What mlb-data-engineer must do before feature construction starts

1. **Confirm `weather_wind_dir` format.** The view in migration 0025 assumes numeric degrees (0–359) stored as TEXT. If the ingester writes cardinal strings, the cast fails. This must be resolved before 0025 is applied.

2. **Seed `park_factor_runs`.** Migration 0024 creates the empty table. The feature layer cannot produce a non-null `park_factor_runs` feature until the 30-row seed is applied. Seed script: `scripts/seed/park-factor-runs-seed.sql` (to be written by mlb-data-engineer with data from FanGraphs).

3. **Update `lineup-sync` to set `pinned_at`.** New lineup rows confirmed as the T-60min snapshot should have `pinned_at` set by the ingester. The exact trigger (e.g., when `confirmed = true AND game_time_utc - now() <= interval '65 minutes'`) is mlb-data-engineer's to define.

4. **Update `odds-refresh` to set `closing_snapshot`.** The closing-flag logic must be added to the ingester. Until then, all new `odds` rows correctly default to `closing_snapshot = false`.

5. **Historical backfill scripts for 2022–2024 `odds` rows** must set `closing_snapshot = true` on the designated closing row per (game, book, market). The unique partial index enforces at most one; the backfill script must handle conflicts.

### What mlb-feature-eng must update in their feature spec

1. **Feature 12 (`weather_wind_out_mph`) source:** Replace the raw column reference with the `game_wind_features` view. The snapshot pin remains `updated_at <= :as_of` (from the `games` side of the view). The derivation formula no longer needs to be in the feature construction code — the view handles it. The feature layer reads `game_wind_features.weather_wind_out_mph` directly.

2. **Feature 10 (`park_factor_runs`) source:** The SCHEMA DEPENDENCY note in the feature spec points to a `park_factors` table with a `venue_name` join key. The actual table is `park_factor_runs` with PK `venue_name`. Update the join reference accordingly.

3. **`lineup_entries` join key:** The feature spec's lineup lock check uses `locked_at` — but the current `lineup_entries` schema does not have a `locked_at` column; it has `pinned_at` (new, from migration 0023) and `confirmed BOOLEAN`. mlb-feature-eng must decide whether to use `pinned_at IS NOT NULL AND pinned_at <= :as_of` as the lock check, or `confirmed = true AND updated_at <= :as_of`. This is a feature spec correction, not a schema correction. Recommend `confirmed = true AND updated_at <= :as_of` for simplicity; `pinned_at` is the auditable join key for the look-ahead audit, not the serving-time lock check.

4. **Null handling for `weather_wind_out_mph` when `outfield_bearing_deg IS NULL`:** The view returns NULL, not 0.0, when the venue is not seeded. The feature layer must handle this NULL and substitute 0.0 per the feature spec's null rule. The view comment documents this explicitly.

### Cron compatibility

All four migrations are additive (new columns or new objects). No existing cron reads or writes need modification to continue functioning:

- `news-poll`: no dependency on any changed table
- `odds-refresh`: continues INSERTing to `odds`; `closing_snapshot` defaults to `false` for new rows until the ingester is updated
- `schedule-sync`: continues UPSERTing to `games`; `weather_wind_dir` column is unchanged
- `stats-sync`: no dependency on any changed table
- `lineup-sync`: continues writing to `lineup_entries`; `pinned_at` is nullable, so existing INSERT statements do not need updating immediately

---

## RLS Summary for New Objects

| Object | anon SELECT | authenticated SELECT | service_role |
|---|---|---|---|
| `lineup_entries.pinned_at` | No (inherited: service-role-only) | No | Read + Write |
| `park_factor_runs` | No | No | Read + Write |
| `game_wind_features` (view) | No (recommended REVOKE) | No (recommended REVOKE) | Read |
| `odds.closing_snapshot` | Yes (inherited: public-read) | Yes | Read + Write |
