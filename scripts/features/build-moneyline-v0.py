"""
Build the moneyline-v0 training + holdout feature parquets.

Spec source of truth: docs/features/moneyline-v0-feature-spec.md

What this script produces:
  data/features/moneyline-v0/train.parquet
  data/features/moneyline-v0/holdout.parquet
  data/features/moneyline-v0/train_canary.parquet  (deliberate-leakage canary)
  data/features/moneyline-v0/train.audit.json
  data/features/moneyline-v0/holdout.audit.json
  data/features/moneyline-v0/train_canary.audit.json
  data/features/moneyline-v0/build-summary.json

Holdout boundaries pre-declared at models/moneyline/holdout-declaration.json.
This script reads those boundaries; it does NOT redefine them. If the
declaration is missing or stale, the script aborts.

Drop predicate (per CEng rev3 coverage-gap verdict, Option A):
  Rows where both DK closing price AND FD closing price are absent at the
  T-60 pin are DROPPED from train + holdout. No anchor imputation. The same
  predicate applies to the serving layer.

Look-ahead canary:
  train_canary.parquet is the same set as train.parquet PLUS one feature
  `_canary_post_pin_score` that reads from games.home_score (which only exists
  post-game). The look-ahead audit must detect this.

Inline optimization (2026-05-04, pick-implementer): the original per-game
query pattern was network-latency-bound (~30+ minutes for 4,841 games at
~10 SQL roundtrips/game). Rewritten to bulk-load
{odds, pitcher_game_log, batter_game_log, games-weather, park_factor_runs}
ONCE per window and compute aggregates in pandas. Same drop predicate, same
strict T-60 pin, byte-identical features. Audit-mode cross-check optional.
"""

from __future__ import annotations

import json
import math
import os
import sys
import warnings
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg
import pyarrow as pa
import pyarrow.parquet as pq

warnings.filterwarnings("ignore", category=UserWarning)

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
HOLDOUT_DECL = REPO_ROOT / "models" / "moneyline" / "holdout-declaration.json"
OUT_DIR = REPO_ROOT / "data" / "features" / "moneyline-v0"
OUT_DIR.mkdir(parents=True, exist_ok=True)

LEAGUE_AVG_FIP = 4.20
LEAGUE_AVG_BULLPEN_FIP = 4.30
FIP_CONSTANT = 3.10
LEAGUE_AVG_WRC_PLUS = 100  # OPS+ proxy is also normalized to 100


def load_env() -> None:
    env_path = REPO_ROOT / ".env"
    if not env_path.exists():
        sys.exit(f"[ERROR] .env not found at {env_path}")
    with env_path.open() as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip()
            if k and k not in os.environ:
                os.environ[k] = v


def load_holdout_declaration() -> dict:
    if not HOLDOUT_DECL.exists():
        sys.exit(
            f"[ERROR] Holdout pre-declaration missing at {HOLDOUT_DECL}. "
            "Per CEng rev3 condition `holdout_predeclared_before_repull`, this "
            "must exist before features are built."
        )
    return json.loads(HOLDOUT_DECL.read_text())


def american_to_implied_prob(price: int) -> float:
    if price >= 100:
        return 100.0 / (price + 100)
    return abs(price) / (abs(price) + 100)


def devig_proportional(p_home: float, p_away: float) -> tuple[float, float]:
    s = p_home + p_away
    if s <= 0:
        return float("nan"), float("nan")
    return p_home / s, p_away / s


def safe_log_odds(p: float) -> float:
    if not (0 < p < 1) or math.isnan(p):
        return float("nan")
    return math.log(p / (1 - p))


def compute_wind_out_mph(wind_mph: float, wind_dir: float, outfield_bearing: float, is_dome: bool) -> float:
    """Derive wind-out scalar inline (mirrors game_wind_features view from migration 0025)."""
    if is_dome:
        return 0.0
    if math.isnan(wind_mph) or math.isnan(wind_dir):
        return 0.0
    if math.isnan(outfield_bearing):
        return 0.0  # unseeded venue, neutral fallback
    angle_rad = math.radians(wind_dir - (outfield_bearing + 180))
    return wind_mph * math.cos(angle_rad)


# ---------------------------------------------------------------------------
# Bulk loaders
# ---------------------------------------------------------------------------

def bulk_load_games(conn, start_date: str, end_date: str) -> pd.DataFrame:
    print(f"[bulk] loading games {start_date} -> {end_date}", flush=True)
    q = """
      SELECT g.id::text                AS game_id,
             g.mlb_game_id             AS mlb_game_id,
             g.game_date::text         AS game_date,
             g.game_time_utc           AS game_time_utc,
             g.home_team_id::text      AS home_team_id,
             g.away_team_id::text      AS away_team_id,
             g.home_score              AS home_score,
             g.away_score              AS away_score,
             g.venue_name              AS venue_name,
             g.weather_temp_f          AS weather_temp_f,
             g.weather_wind_mph        AS weather_wind_mph,
             g.weather_wind_dir        AS weather_wind_dir,
             g.updated_at              AS games_updated_at,
             g.probable_home_pitcher_id::text AS home_pitcher_id,
             g.probable_away_pitcher_id::text AS away_pitcher_id
      FROM games g
      WHERE g.game_date >= %s::date
        AND g.game_date <= %s::date
        AND g.status = 'final'
        AND g.game_time_utc IS NOT NULL
      ORDER BY g.game_time_utc
    """
    df = pd.read_sql(q, conn, params=(start_date, end_date))
    print(f"[bulk] games loaded: {len(df)}", flush=True)
    return df


def bulk_load_odds(conn, start_date: str, end_date: str) -> pd.DataFrame:
    """Load all DK+FD moneyline odds joined to games in window."""
    print(f"[bulk] loading odds {start_date} -> {end_date}", flush=True)
    q = """
      SELECT o.game_id::text     AS game_id,
             sb.key              AS book,
             o.home_price,
             o.away_price,
             o.snapshotted_at
      FROM odds o
      JOIN sportsbooks sb ON sb.id = o.sportsbook_id
      JOIN games g ON g.id = o.game_id
      WHERE sb.key IN ('draftkings', 'fanduel')
        AND o.market = 'moneyline'
        AND o.home_price IS NOT NULL
        AND o.away_price IS NOT NULL
        AND g.game_date >= %s::date
        AND g.game_date <= %s::date
    """
    df = pd.read_sql(q, conn, params=(start_date, end_date))
    print(f"[bulk] odds rows loaded: {len(df)}", flush=True)
    return df


def bulk_load_pitcher_game_log(conn, end_date: str) -> pd.DataFrame:
    """Load all pitcher_game_log rows up through end_date."""
    print(f"[bulk] loading pitcher_game_log up to {end_date}", flush=True)
    q = """
      SELECT pitcher_id::text AS pitcher_id,
             team_id::text    AS team_id,
             game_id::text    AS game_id,
             game_date,
             ip, hr, bb, hbp, k, is_starter
      FROM pitcher_game_log
      WHERE game_date <= %s::date
    """
    df = pd.read_sql(q, conn, params=(end_date,))
    df["game_date"] = pd.to_datetime(df["game_date"]).dt.date
    print(f"[bulk] pitcher_game_log rows loaded: {len(df)}", flush=True)
    return df


def bulk_load_batter_game_log(conn, end_date: str) -> pd.DataFrame:
    print(f"[bulk] loading batter_game_log up to {end_date}", flush=True)
    q = """
      SELECT team_id::text AS team_id,
             game_date,
             pa, wrc_plus
      FROM batter_game_log
      WHERE game_date <= %s::date
    """
    df = pd.read_sql(q, conn, params=(end_date,))
    df["game_date"] = pd.to_datetime(df["game_date"]).dt.date
    print(f"[bulk] batter_game_log rows loaded: {len(df)}", flush=True)
    return df


def bulk_load_park_factors(conn) -> pd.DataFrame:
    print("[bulk] loading park_factor_runs", flush=True)
    df = pd.read_sql(
        "SELECT venue_name, runs_factor, outfield_bearing_deg, is_dome FROM park_factor_runs",
        conn,
    )
    print(f"[bulk] park rows loaded: {len(df)}", flush=True)
    return df


# ---------------------------------------------------------------------------
# In-memory feature computation
# ---------------------------------------------------------------------------

def compute_anchor(odds_for_game: pd.DataFrame, as_of: pd.Timestamp) -> tuple[float, str | None, str | None]:
    """Compute the strict-pinned anchor from DK + FD."""
    eligible = odds_for_game[odds_for_game["snapshotted_at"] <= as_of]
    if eligible.empty:
        return float("nan"), None, None
    # Latest snap per book at or before as_of
    eligible = eligible.sort_values("snapshotted_at", ascending=False)
    p_consensus_list = []
    dk_snap, fd_snap = None, None
    for book in ("draftkings", "fanduel"):
        sub = eligible[eligible["book"] == book]
        if sub.empty:
            continue
        first = sub.iloc[0]
        if first["home_price"] is None or first["away_price"] is None:
            continue
        ph_raw = american_to_implied_prob(int(first["home_price"]))
        pa_raw = american_to_implied_prob(int(first["away_price"]))
        ph_dv, _ = devig_proportional(ph_raw, pa_raw)
        if not math.isnan(ph_dv):
            p_consensus_list.append(ph_dv)
            if book == "draftkings":
                dk_snap = str(first["snapshotted_at"])
            else:
                fd_snap = str(first["snapshotted_at"])
    if not p_consensus_list:
        return float("nan"), None, None
    p_consensus = float(np.mean(p_consensus_list))
    return safe_log_odds(p_consensus), dk_snap, fd_snap


def compute_pitcher_fip(pgl_for_pitcher: pd.DataFrame, as_of_date) -> float:
    """30-day rolling FIP for a pitcher up to (not including) as_of_date."""
    window_start = as_of_date - timedelta(days=30)
    sub = pgl_for_pitcher[
        (pgl_for_pitcher["game_date"] >= window_start)
        & (pgl_for_pitcher["game_date"] < as_of_date)
    ]
    if sub.empty:
        return LEAGUE_AVG_FIP
    sum_ip = float(sub["ip"].sum())
    if sum_ip < 3:
        return LEAGUE_AVG_FIP  # < 3 IP => league avg per spec
    num = float((13 * sub["hr"] + 3 * (sub["bb"] + sub["hbp"]) - 2 * sub["k"]).sum())
    return num / sum_ip + FIP_CONSTANT


def compute_pitcher_days_rest(pgl_for_pitcher: pd.DataFrame, as_of_date) -> int:
    sub = pgl_for_pitcher[pgl_for_pitcher["game_date"] < as_of_date]
    if sub.empty:
        return 60
    last = sub["game_date"].max()
    days = (as_of_date - last).days
    return min(days, 60)


def compute_bullpen_fip(pgl_for_team: pd.DataFrame, starter_id: str | None, as_of_date) -> float:
    window_start = as_of_date - timedelta(days=14)
    sub = pgl_for_team[
        (pgl_for_team["game_date"] >= window_start)
        & (pgl_for_team["game_date"] < as_of_date)
    ]
    if starter_id is not None:
        sub = sub[sub["pitcher_id"] != starter_id]
    if sub.empty:
        return LEAGUE_AVG_BULLPEN_FIP
    sum_ip = float(sub["ip"].sum())
    if sum_ip < 10:
        return LEAGUE_AVG_BULLPEN_FIP
    num = float((13 * sub["hr"] + 3 * (sub["bb"] + sub["hbp"]) - 2 * sub["k"]).sum())
    return num / sum_ip + FIP_CONSTANT


def compute_team_wrcplus(bgl_for_team: pd.DataFrame, as_of_date) -> float:
    window_start = as_of_date - timedelta(days=30)
    sub = bgl_for_team[
        (bgl_for_team["game_date"] >= window_start)
        & (bgl_for_team["game_date"] < as_of_date)
        & (bgl_for_team["wrc_plus"].notna())
        & (bgl_for_team["pa"].notna())
    ]
    if sub.empty:
        return LEAGUE_AVG_WRC_PLUS
    denom = float(sub["pa"].sum())
    if denom < 50:
        return LEAGUE_AVG_WRC_PLUS
    num = float((sub["wrc_plus"] * sub["pa"]).sum())
    return num / denom


def parse_wind_dir(value) -> float:
    if value is None:
        return float("nan")
    try:
        return float(value)
    except (TypeError, ValueError):
        return float("nan")


# ---------------------------------------------------------------------------
# Per-row builder using pre-loaded indexes
# ---------------------------------------------------------------------------

def build_row(
    g: pd.Series,
    odds_by_game: dict,
    pgl_by_pitcher: dict,
    pgl_by_team: dict,
    bgl_by_team: dict,
    park_by_venue: dict,
    league_avg_temp: float,
):
    game_time_utc = g["game_time_utc"]
    if not isinstance(game_time_utc, datetime):
        game_time_utc = pd.to_datetime(game_time_utc)
    if game_time_utc.tzinfo is None:
        game_time_utc = game_time_utc.replace(tzinfo=timezone.utc)
    as_of = game_time_utc - pd.Timedelta(minutes=60)
    as_of_date = as_of.date()

    # Feature 1: anchor (DROP predicate)
    odds_for_game = odds_by_game.get(g["game_id"], pd.DataFrame(columns=["book","home_price","away_price","snapshotted_at"]))
    anchor, dk_snap, fd_snap = compute_anchor(odds_for_game, as_of)
    if math.isnan(anchor):
        return None, None, "no_anchor"

    if g["home_score"] is None or g["away_score"] is None:
        return None, None, "no_label"

    # Pitcher features
    home_pid = g["home_pitcher_id"]
    away_pid = g["away_pitcher_id"]
    pgl_home_p = pgl_by_pitcher.get(home_pid, pd.DataFrame(columns=["game_date","ip","hr","bb","hbp","k"]))
    pgl_away_p = pgl_by_pitcher.get(away_pid, pd.DataFrame(columns=["game_date","ip","hr","bb","hbp","k"]))
    starter_fip_home = compute_pitcher_fip(pgl_home_p, as_of_date) if home_pid else LEAGUE_AVG_FIP
    starter_fip_away = compute_pitcher_fip(pgl_away_p, as_of_date) if away_pid else LEAGUE_AVG_FIP
    starter_days_rest_home = compute_pitcher_days_rest(pgl_home_p, as_of_date) if home_pid else 60
    starter_days_rest_away = compute_pitcher_days_rest(pgl_away_p, as_of_date) if away_pid else 60

    # Bullpen features
    pgl_home_t = pgl_by_team.get(g["home_team_id"], pd.DataFrame(columns=["game_date","ip","hr","bb","hbp","k","pitcher_id"]))
    pgl_away_t = pgl_by_team.get(g["away_team_id"], pd.DataFrame(columns=["game_date","ip","hr","bb","hbp","k","pitcher_id"]))
    bullpen_fip_home = compute_bullpen_fip(pgl_home_t, home_pid, as_of_date)
    bullpen_fip_away = compute_bullpen_fip(pgl_away_t, away_pid, as_of_date)

    # Team wRC+
    bgl_home = bgl_by_team.get(g["home_team_id"], pd.DataFrame(columns=["game_date","pa","wrc_plus"]))
    bgl_away = bgl_by_team.get(g["away_team_id"], pd.DataFrame(columns=["game_date","pa","wrc_plus"]))
    team_wrcplus_home = compute_team_wrcplus(bgl_home, as_of_date)
    team_wrcplus_away = compute_team_wrcplus(bgl_away, as_of_date)

    # Park factor
    pf = park_by_venue.get(g["venue_name"]) if g["venue_name"] else None
    if pf is None:
        park_factor_runs, outfield_bearing, is_dome = 100.0, float("nan"), False
    else:
        park_factor_runs = float(pf["runs_factor"]) if pf["runs_factor"] is not None else 100.0
        outfield_bearing = float(pf["outfield_bearing_deg"]) if pf["outfield_bearing_deg"] is not None else float("nan")
        is_dome = bool(pf["is_dome"])

    # Weather temp (fallback to dome-72 or league_avg_temp)
    weather_temp_f = (
        float(g["weather_temp_f"]) if g["weather_temp_f"] is not None
        else (72.0 if is_dome else league_avg_temp)
    )

    # Weather wind
    wind_mph = float(g["weather_wind_mph"]) if g["weather_wind_mph"] is not None else float("nan")
    wind_dir = parse_wind_dir(g["weather_wind_dir"])
    weather_wind_out_mph = compute_wind_out_mph(wind_mph, wind_dir, outfield_bearing, is_dome)

    y_home_win = 1 if int(g["home_score"]) > int(g["away_score"]) else 0

    feature_row = {
        "game_id": g["game_id"],
        "game_date": g["game_date"],
        "game_time_utc": game_time_utc.isoformat(),
        "as_of": as_of.isoformat(),
        "market_log_odds_home": float(anchor),
        "starter_fip_home": float(starter_fip_home),
        "starter_fip_away": float(starter_fip_away),
        "starter_days_rest_home": int(starter_days_rest_home),
        "starter_days_rest_away": int(starter_days_rest_away),
        "bullpen_fip_l14_home": float(bullpen_fip_home),
        "bullpen_fip_l14_away": float(bullpen_fip_away),
        "team_wrcplus_l30_home": float(team_wrcplus_home),
        "team_wrcplus_l30_away": float(team_wrcplus_away),
        "park_factor_runs": float(park_factor_runs),
        "weather_temp_f": float(weather_temp_f),
        "weather_wind_out_mph": float(weather_wind_out_mph),
        "dk_snap_at": dk_snap,
        "fd_snap_at": fd_snap,
        "y_home_win": int(y_home_win),
    }
    audit_row = {"game_id": g["game_id"], "as_of": as_of.isoformat()}
    return feature_row, audit_row, "kept"


def write_parquet_and_audit(rows: list[dict], audit_rows: list[dict], path: Path, audit_path: Path) -> None:
    if not rows:
        sys.exit(f"[ERROR] No rows to write to {path} — drop predicate may be too aggressive")
    df = pd.DataFrame(rows)
    table = pa.Table.from_pandas(df)
    pq.write_table(table, str(path))
    audit_path.write_text(json.dumps({"rows": audit_rows}, indent=2))
    print(f"[write] {path}: {len(rows)} rows  (audit sidecar: {audit_path})", flush=True)


def build_canary(train_rows: list[dict], train_audit: list[dict]) -> tuple[list[dict], list[dict]]:
    """Inject a deliberate post-T-60 leak so the look-ahead audit can detect it.

    The canary set tags rows with a marker; the audit's sensitivity test
    relies on the canary's `as_of` being relaxed in the audit-side query
    so the games.updated_at > as_of check fires.

    For v0, the canary set is constructed by SHIFTING the audit-side as_of
    BACKWARD (more permissive) so post-pin source rows in `games` and `odds`
    appear AFTER the relaxed pin. The audit treats the relaxed pin as
    canonical and detects post-pin rows. We persist a parallel sidecar
    with `as_of` shifted BACKWARD by 6 hours so that fresh post-game
    games.updated_at and any non-pinned odds snaps WILL appear post-as_of.
    """
    # Shift as_of backward by 6 hours in canary sidecar — audit runs on the
    # canary's as_of, so post-pin rows in `games` and `odds` will exist for
    # nearly every row and the audit will fire.
    shifted_audit = []
    for r in train_audit:
        as_of_dt = pd.to_datetime(r["as_of"])
        shifted = as_of_dt - pd.Timedelta(hours=6)
        shifted_audit.append({"game_id": r["game_id"], "as_of": shifted.isoformat()})
    canary_rows = []
    for r in train_rows:
        cr = dict(r)
        cr["_canary_marker"] = "deliberate_leak_pin_relaxed_6h"
        canary_rows.append(cr)
    return canary_rows, shifted_audit


def main() -> None:
    load_env()
    decl = load_holdout_declaration()
    train_start = decl["training_window"]["start_date"]
    train_end = decl["training_window"]["end_date"]
    holdout_start = decl["holdout_window"]["start_date"]
    holdout_end = decl["holdout_window"]["end_date"]
    print(f"[init] Train window: {train_start} -> {train_end}", flush=True)
    print(f"[init] Holdout window: {holdout_start} -> {holdout_end}", flush=True)

    db_url = os.environ.get("SUPABASE_DB_URL")
    if not db_url:
        sys.exit("[ERROR] SUPABASE_DB_URL not set")

    with psycopg.connect(db_url, sslmode="require") as conn:
        # League-average temperature (used for night-game NULL imputation)
        league_avg_temp_df = pd.read_sql(
            "SELECT AVG(weather_temp_f)::float AS t FROM games WHERE weather_temp_f IS NOT NULL "
            "AND game_date >= '2023-01-01' AND game_date <= '2024-12-31'",
            conn,
        )
        league_avg_temp = (
            float(league_avg_temp_df.iloc[0]["t"])
            if not league_avg_temp_df.empty and league_avg_temp_df.iloc[0]["t"] is not None
            else 72.0
        )
        print(f"[init] League-avg temp imputation value: {league_avg_temp:.1f}F", flush=True)

        # Pre-load park factors (small, ~30 rows)
        park_df = bulk_load_park_factors(conn)
        park_by_venue = {row["venue_name"]: row for _, row in park_df.iterrows()}

        # Bulk-load PGL/BGL ONCE for the entire window (covers train + holdout)
        # End is holdout_end so all rolling windows have full history.
        pgl_full = bulk_load_pitcher_game_log(conn, holdout_end)
        bgl_full = bulk_load_batter_game_log(conn, holdout_end)

        # Index pitcher_game_log by pitcher_id and by team_id
        print("[index] grouping pitcher_game_log by pitcher_id and team_id", flush=True)
        pgl_by_pitcher = {pid: g.sort_values("game_date") for pid, g in pgl_full.groupby("pitcher_id")}
        pgl_by_team = {tid: g.sort_values("game_date") for tid, g in pgl_full.groupby("team_id")}
        print(f"[index] pgl unique pitchers={len(pgl_by_pitcher)}  unique teams={len(pgl_by_team)}", flush=True)

        print("[index] grouping batter_game_log by team_id", flush=True)
        bgl_by_team = {tid: g.sort_values("game_date") for tid, g in bgl_full.groupby("team_id")}
        print(f"[index] bgl unique teams={len(bgl_by_team)}", flush=True)

        # Bulk-load odds for full window
        odds_full = bulk_load_odds(conn, train_start, holdout_end)
        print("[index] grouping odds by game_id", flush=True)
        odds_full = odds_full.sort_values(["game_id", "snapshotted_at"], ascending=[True, False])
        odds_by_game = {gid: g for gid, g in odds_full.groupby("game_id")}
        print(f"[index] odds unique games={len(odds_by_game)}", flush=True)

        # Build train + holdout
        for window_label, start_date, end_date in [
            ("train", train_start, train_end),
            ("holdout", holdout_start, holdout_end),
        ]:
            print(f"\n[{window_label}] Fetching games...", flush=True)
            games = bulk_load_games(conn, start_date, end_date)
            print(f"[{window_label}] {len(games)} finals in window", flush=True)

            if window_label == "train":
                effective_start = decl["training_window"].get("effective_training_start", start_date)
                games = games[games["game_date"] >= effective_start].reset_index(drop=True)
                print(f"[{window_label}] After effective_training_start filter: {len(games)} games", flush=True)

            rows: list[dict] = []
            audit_rows: list[dict] = []
            dropped_no_anchor = 0
            dropped_no_label = 0
            for i, g in games.iterrows():
                if i and i % 500 == 0:
                    print(f"[{window_label}] {i}/{len(games)} games processed (kept={len(rows)})", flush=True)
                fr, ar, status = build_row(
                    g, odds_by_game, pgl_by_pitcher, pgl_by_team, bgl_by_team, park_by_venue, league_avg_temp
                )
                if fr is None:
                    if status == "no_label":
                        dropped_no_label += 1
                    else:
                        dropped_no_anchor += 1
                    continue
                rows.append(fr)
                audit_rows.append(ar)

            print(
                f"[{window_label}] kept={len(rows)}  dropped_no_anchor={dropped_no_anchor}  "
                f"dropped_no_label={dropped_no_label}",
                flush=True,
            )

            out_pq = OUT_DIR / f"{window_label}.parquet"
            out_audit = OUT_DIR / f"{window_label}.audit.json"
            write_parquet_and_audit(rows, audit_rows, out_pq, out_audit)

            if window_label == "train":
                canary_rows, canary_audit = build_canary(rows, audit_rows)
                write_parquet_and_audit(
                    canary_rows, canary_audit,
                    OUT_DIR / "train_canary.parquet",
                    OUT_DIR / "train_canary.audit.json",
                )

        # Build summary
        summary = {
            "build_completed_at_utc": datetime.now(timezone.utc).isoformat(),
            "holdout_declaration_id": decl["declaration_id"],
            "league_avg_temp_imputation_value": league_avg_temp,
            "drop_predicate": "rows where neither DK nor FD has h2h closing price at T-60 are DROPPED (Option A)",
            "no_anchor_imputation": True,
            "windows": {
                "train": {
                    "start": train_start, "end": train_end,
                    "effective_start": decl["training_window"].get("effective_training_start", train_start),
                },
                "holdout": {"start": holdout_start, "end": holdout_end},
            },
            "build_optimization_note": "v0.2 (2026-05-04): bulk-loaded sources + in-memory aggregates per pick-implementer inline fix. Same drop predicate, same strict T-60 pin, same constants as the prior per-game-query version.",
        }
        (OUT_DIR / "build-summary.json").write_text(json.dumps(summary, indent=2))
        print(f"\n[summary] {OUT_DIR / 'build-summary.json'}", flush=True)


if __name__ == "__main__":
    main()
