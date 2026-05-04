# ADR-003 — Moneyline v0 Schema Additions

**Status:** Accepted  
**Date:** 2026-04-30  
**Author:** mlb-architect  
**Covers:** Four schema gaps identified in `docs/audits/moneyline-v0-data-coverage-2026-04-30.md` that block the v0 feature build.

---

## Objective

Add four schema changes that unblock the moneyline v0 feature construction pipeline without breaking existing ingestion crons or requiring table rewrites.

---

## Context

The analysis layer was wiped 2026-04-30 and rebuilt under methodology-agnostic principles. The v0 moneyline cold-start cycle identified four gaps between the existing schema and the feature spec in `docs/features/moneyline-v0-feature-spec.md`:

1. `lineup_entries` has no `pinned_at` column — T-60min snapshot joins cannot be enforced or audited.
2. No `park_factor_runs` table exists — feature 10 (`park_factor_runs`) has no source.
3. The `games` table has `weather_wind_mph` + `weather_wind_dir` (text), but the feature spec requires `weather_wind_out_mph`, a derived scalar that depends on stadium orientation — which is also not stored anywhere.
4. Closing-line identification in `odds` relies on `snapshotted_at` proximity to `game_time_utc`, which is fragile and will cause false positives in the look-ahead audit when snapshots are sparse.

Existing crons: `news-poll`, `odds-refresh`, `schedule-sync`, `stats-sync`, `lineup-sync`. All must continue operating without modification.

Stack: Supabase Postgres, RLS required on every user-facing table, service-role-only on all analytics/reference tables that are not user-visible. No migrations are applied in this task — mlb-backend translates this spec into migration files.

---

## Decision

### Gap 1: `lineup_entries.pinned_at TIMESTAMPTZ`

**Add a nullable `pinned_at TIMESTAMPTZ` column to `lineup_entries`.**

`pinned_at` records when a lineup row was explicitly snapshotted as the T-60min training pin — distinct from `updated_at`, which changes on any write. The feature construction layer sets `pinned_at` when it materializes a lineup snapshot for a specific `as_of` value. Historical backfill rows without a deliberate pin carry `NULL`.

Why nullable rather than `NOT NULL DEFAULT now()`: existing rows have no meaningful pin timestamp; a default of `now()` at migration time would be a lie. The feature spec already handles the `NULL` case — if `pinned_at IS NULL` for a historical row, the feature layer treats the row as "best available at `updated_at`" and logs a coverage flag. New rows written by the lineup-sync cron after this migration can set `pinned_at` when confirmed.

`updated_at` is not retired. It continues to track the most recent write. `pinned_at` is the explicit T-60min marker used by the feature layer for join correctness and the look-ahead audit.

**No change to RLS.** `lineup_entries` is service-role-only; no policy update needed.

---

### Gap 2: `park_factor_runs` table

**Create a new static table `park_factor_runs` keyed by `venue_name`.**

Schema rationale:
- Keyed by `venue_name` (text) to match `games.venue_name` without requiring a separate venue FK. If a venue FK is added later, the join key survives as a unique constraint.
- `runs_factor NUMERIC(5,2)` — normalized to 100 (100 = league average). Two decimal places are sufficient; public sabermetric sources (FanGraphs, Baseball Reference) publish to one decimal.
- `outfield_bearing_deg SMALLINT` — the home plate-to-center-field compass bearing in degrees (0–359). This column is here, not in a separate `stadium_orientation` table, because stadium orientation and park factor are updated on the same cadence (once per season, from the same seed process) and always joined together. Splitting into two tables adds a join with no benefit at 30 rows.
- `is_dome BOOLEAN NOT NULL DEFAULT false` — needed for the `weather_wind_out_mph` NULL-handling logic in the feature spec (dome = always 0.0 wind).
- `season_years TEXT` — documents the seasons the factor covers (e.g., `'2022-2024'`). Not a PK component; the table holds one current row per venue.
- `source TEXT NOT NULL` — records where the factor came from (`'fangraphs'`, `'bbref'`, `'manual'`). Required for the annual update audit.
- `updated_at TIMESTAMPTZ` — tracks last manual update.

**RLS: no authenticated or anon reads.** This table is referenced only by the feature construction layer (service role). It has no user-facing surface in v1.

**Maintenance protocol:** Update once per season, typically in January or after ~2 months of current-season data when park factors stabilize. The data engineer seeds the initial 30 rows from FanGraphs multi-year park factors. Updates are manual (a small SQL INSERT/UPDATE batch per season from the same source). No automated cron needed. An annual reminder in the data engineer's runbook is sufficient.

**Alternatives considered:** A separate `stadium_venues` table that houses both park factors and orientation was considered. Rejected — 30 rows do not justify a normalized venue entity in v1. If a `venues` table is added for v1.x (e.g., to support travel distance features), `park_factor_runs` can be joined to it by `venue_name` without a schema change here.

---

### Gap 3: Wind direction — `outfield_bearing_deg` in `park_factor_runs` + computed view

**Store `outfield_bearing_deg` in `park_factor_runs` (see Gap 2) and expose `weather_wind_out_mph` as a computed Postgres view, not a materialized column in `games`.**

The feature spec requires:
```
weather_wind_out_mph = weather_wind_mph * direction_scalar
```
where `direction_scalar` is derived from the angle between `weather_wind_dir` and the stadium's outfield bearing.

Two approaches were considered:

**Option A — Materialized column in `games`:** Add `weather_wind_out_mph REAL` to `games`, computed by the weather ingestion job and stored. Simple to query; ingestion job must know stadium orientation at write time.

**Option B — Postgres view (recommended):** Create `game_wind_features` view that joins `games` + `park_factor_runs` on `venue_name` and computes `weather_wind_out_mph` inline. The computation is a pure function of `weather_wind_mph`, `weather_wind_dir`, and `outfield_bearing_deg` — no mutable state.

Option B is recommended for three reasons:
1. Keeps `games` as raw-from-source data only (consistent with how `odds` is handled — see ADR-002 rationale for not storing derived novig in `odds`).
2. Stadium orientation changes at most once a decade; a stored column would need a recompute trigger whenever `outfield_bearing_deg` is corrected, whereas the view recomputes automatically.
3. The computation is cheap (trigonometry on a single row); materializing it buys nothing at this query volume.

The view is not a materialized view — the computation is fast enough (single join, single formula) and a materialized view would need refresh logic.

**Wind direction normalization:** `weather_wind_dir` arrives from Open-Meteo as degrees (0–359, where 0/360 = North, 90 = East, 180 = South, 270 = West). The view converts this to a cosine-based scalar:

```sql
direction_scalar = COS(RADIANS(weather_wind_dir - (outfield_bearing_deg + 180)))
```

`outfield_bearing_deg` is the direction from home plate to center field (e.g., Fenway center field ≈ 45°, so outfield bearing = 45). Wind blowing from home plate toward center field is "blowing out." A wind direction equal to `outfield_bearing_deg` is blowing out (+1.0); the opposite direction is blowing in (−1.0); crosswind is 0.0. The `+ 180` term converts the outfield bearing to the "wind-from direction" convention used by meteorological sources.

If `weather_wind_dir IS NULL` or `weather_wind_mph IS NULL`, the view returns `weather_wind_out_mph = 0.0` (no wind effect). If `outfield_bearing_deg IS NULL` (venue not seeded), the view returns `NULL` and the feature layer falls back to the `0.0` default per the feature spec null-handling rule.

**Source for outfield bearing data:** All 30 MLB stadium orientations are documented in published sabermetric literature (Baseball Reference park dimensions, the sabr.org Ballparks database, and the Statcast pitch coordinate system). This is a one-time manual seed of ~30 rows. The data engineer populates these at the same time as `runs_factor`.

**RLS on the view:** Views inherit the RLS of their underlying tables. `park_factor_runs` is service-role-only (see Gap 2). `games` is public-read. The view will be service-role-queryable without issue; authenticated/anon users cannot see `park_factor_runs` columns even through the view (Postgres evaluates RLS on the base table, not the view, when the view is not SECURITY DEFINER). The view should be created without SECURITY DEFINER to maintain this boundary.

---

### Gap 4: Closing-snapshot identifier on `odds`

**Add a `closing_snapshot BOOLEAN NOT NULL DEFAULT false` flag to `odds`.**

The current approach — identifying closing lines by `snapshotted_at` proximity to `game_time_utc` — has two failure modes: (1) a snapshot taken at T-30min is "closest to game start" in a sparse table and gets treated as a closing line in training, introducing look-ahead leakage; (2) there is no way to distinguish a true post-close snapshot from a pre-game snapshot that happened to be the last one fetched.

Three options were considered:

**Option A — `closing_snapshot BOOLEAN` flag (recommended):** The ingester sets `closing_snapshot = true` when it determines the snapshot is final (e.g., the game has started, or the snapshot was taken within a configurable window of game start with no subsequent movement). Simple column, zero join cost, backward-compatible (existing rows default to `false`). The look-ahead audit checks that no training row with `closing_snapshot = true` has `snapshotted_at <= game_start_utc - 60 minutes` — which would mean a "closing" snapshot was taken before T-60, indicating a mislabel.

**Option B — Separate `closing_odds` table:** Stores only finalized closing lines. Cleaner conceptually; avoids the `odds` table growing the column. But adds a join in every training and serving query, and the ingester must write to two tables atomically (or introduce eventual consistency risk).

**Option C — `final_at` timestamp + constraint:** A `final_at TIMESTAMPTZ` column, non-null only on closing rows, with a partial unique index `(game_id, sportsbook_id, market) WHERE final_at IS NOT NULL`. Expressive, but the partial unique constraint still allows the ingester to accidentally set multiple rows as "final" if it runs twice near game start. A boolean flag with application-level discipline is simpler to audit.

Option A is recommended. The flag is set by the ingester under one rule: a snapshot is `closing_snapshot = true` if and only if it was captured at or after `game_time_utc` OR within a configurable pre-game window (default: `game_time_utc - 5 minutes`) with no subsequent odds change detected. The mlb-data-engineer owns this logic definition; the schema just provides the column.

**Index:** A partial index on `(game_id, sportsbook_id, market) WHERE closing_snapshot = true` supports the common training query pattern (fetch the closing row per game per book per market) without scanning the full `odds` append log.

**RLS:** `odds` is already public-read. The new column is visible to all readers, which is correct — closing-line data is part of the pick performance record.

---

## Consequences

### Enables

- T-60min snapshot joins on `lineup_entries` are enforceable and auditable via `pinned_at`.
- `park_factor_runs` (feature 10) has a source table; the feature layer can do a simple join without a schema change to `games`.
- `weather_wind_out_mph` (feature 12) can be derived correctly for all 30 venues from a single view join, using real stadium geometry rather than a hardcoded approximation.
- Closing-line identification in training is explicit and auditable; look-ahead audit has a clean test (`closing_snapshot = true AND snapshotted_at <= as_of` should never appear in a training row).
- The `outfield_bearing_deg` column in `park_factor_runs` can serve future features (e.g., pull-side fly ball tendencies vs. wind angle) without a schema change.

### Closes off

- Storing derived wind data in `games` (this would couple the ingestion job to stadium orientation data and make `games` non-raw-from-source).
- Using `snapshotted_at` proximity as the closing-line selector (the `closing_snapshot` flag supersedes this pattern; existing ingestion code that uses proximity must be updated by mlb-data-engineer).
- A separate `stadium_orientation` table (consolidated into `park_factor_runs`; 30 rows do not justify normalization).

---

## Alternatives Considered

| Gap | Alternative | Why rejected |
|---|---|---|
| 1 | `snapshot_time` column instead of `pinned_at` | Less precise name; `pinned_at` matches the feature spec's "snapshot-pinned" language and is self-documenting |
| 2 | Separate `venues` table with park data as columns | Over-normalized for 30 rows; no v1 requirement for a venue entity |
| 3 | Materialized column in `games` | Couples ingestion to stadium orientation; invalidation logic required on `outfield_bearing_deg` change |
| 3 | Separate `stadium_orientation` table | Extra join, same data, no benefit at 30 rows |
| 4 | Separate `closing_odds` table | Two-table write per snapshot creates consistency risk; adds join to every training query |
| 4 | `final_at` timestamp + partial unique index | More expressive but allows duplicate finals if ingester runs twice; boolean with application discipline is simpler |

---

## Open Questions

1. **`pinned_at` backfill source:** Historical `lineup_entries` rows (once the 2022–2024 backfill runs) will have `pinned_at = NULL`. The feature layer must treat NULL as "best available at `updated_at`" and set a coverage flag. Is this acceptable to mlb-calibrator for the 2022–2024 training slice, or does the absence of `pinned_at` on historical rows disqualify those rows for the holdout? Escalate to CEng if the look-ahead audit finds systematic issues with NULL-`pinned_at` rows.

2. **`closing_snapshot` ingester logic:** The exact rule for setting `closing_snapshot = true` is mlb-data-engineer's to define. The schema is ready; the logic must be documented in the ingestion runbook before backfill of 2022–2024 closing lines starts.

3. **`outfield_bearing_deg` source precision:** Published stadium orientations vary by a few degrees across sources. The `direction_scalar` computation uses a cosine, so ±5° error near a crosswind produces `cos(85°) ≈ 0.087` vs. `cos(90°) = 0.0` — a small but non-zero difference. For v0, any published value is sufficient. Document the source in each `park_factor_runs` row's `source` column.

4. **View naming and location:** The `game_wind_features` view should live in the public schema alongside the tables it joins. mlb-backend confirms schema ownership conventions.
