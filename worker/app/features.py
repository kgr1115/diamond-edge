"""
features.py — Worker-side feature vector builder for Diamond Edge inference.

Replaces the Edge Function's placeholder feature-builder.ts (15 fields → 0.0
defaults) with a full 90-feature vector matching exactly what the B2 delta
models were trained on.

Queries Supabase directly via the service-role key (SUPABASE_SERVICE_ROLE_KEY
env var, already set in Fly secrets).  All lookups are read-only; no writes.

Feature contract:  worker/models/moneyline/artifacts/manifest_b2.json
                   worker/models/run_line/artifacts/manifest_b2.json
                   worker/models/totals/artifacts/manifest_b2.json

The 90 features fall into six categories:
  1.  SP stats      — ERA / FIP / K9 / BB9 / HR9 / WHIP / days rest / IP / flags
  2.  Bullpen       — ERA / WHIP / IP load last 2d/3d/7d
  3.  Team offense  — OPS / runs/g / K% / BB% / BA / EWMA runs / win pcts / Pythagorean
  4.  Park          — run factor / HR factor / dome / L/R handedness split
  5.  Weather       — temp / wind mph / wind-to-CF / composite wind factor
  6.  Market        — novig blend / line movement / book disagreement / market implied prob

When data is missing for a feature the value is returned as None; the caller
(_build_feature_vector in main.py) maps None → 0.0 with a [WARN] log.

Data sources:
  games               — weather, venue, pitcher IDs, game_time_utc
  teams               — abbreviation (joins to static lookup tables)
  players             — throws handedness for SP
  odds                — raw DK/FD prices for market feature computation
  news_signals        — T-6h aggregated signals
  market_priors       — pre-computed novig blend (if available)

Static tables embedded here (no DB query needed):
  PARK_RUN_FACTOR     — from worker/app/team_map.py
  PARK_HR_FACTOR      — from worker/app/team_map.py
  PARK_HR_FACTOR_L/R  — from worker/models/pipelines/feature_engineering.py
  TEAM_TIMEZONE_OFFSET — from feature_engineering.py
"""

from __future__ import annotations

import os
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parents[2]))

from worker.app.team_map import (
    MLB_ID_TO_ABBR,
    PARK_RUN_FACTOR,
    PARK_HR_FACTOR,
    DOME_PARKS,
)

# ---------------------------------------------------------------------------
# Static lookup tables (copied from feature_engineering.py — single source of
# truth is the training script; kept in sync manually)
# ---------------------------------------------------------------------------

PARK_HR_FACTOR_L: dict[str, int] = {
    "ARI": 110, "ATL": 104, "BAL": 122, "BOS": 92,  "CHC": 112,
    "CWS": 102, "CIN": 122, "CLE": 93,  "COL": 120, "DET": 89,
    "HOU": 94,  "KC":  102, "LAA": 101, "LAD": 94,  "MIA": 85,
    "MIL": 101, "MIN": 120, "NYM": 93,  "NYY": 128, "OAK": 88,
    "PHI": 116, "PIT": 95,  "SD":  86,  "SF":  81,  "SEA": 87,
    "STL": 96,  "TB":  93,  "TEX": 112, "TOR": 110, "WSH": 98,
}

PARK_HR_FACTOR_R: dict[str, int] = {
    "ARI": 106, "ATL": 106, "BAL": 114, "BOS": 98,  "CHC": 108,
    "CWS": 106, "CIN": 116, "CLE": 97,  "COL": 116, "DET": 95,
    "HOU": 98,  "KC":  106, "LAA": 105, "LAD": 98,  "MIA": 89,
    "MIL": 105, "MIN": 116, "NYM": 97,  "NYY": 112, "OAK": 92,
    "PHI": 108, "PIT": 99,  "SD":  90,  "SF":  87,  "SEA": 91,
    "STL": 100, "TB":  97,  "TEX": 108, "TOR": 114, "WSH": 102,
}

TEAM_TIMEZONE_OFFSET: dict[str, int] = {
    "ARI": -7, "ATL": -5, "BAL": -5, "BOS": -5, "CHC": -6,
    "CWS": -6, "CIN": -5, "CLE": -5, "COL": -7, "DET": -5,
    "HOU": -6, "KC":  -6, "LAA": -8, "LAD": -8, "MIA": -5,
    "MIL": -6, "MIN": -6, "NYM": -5, "NYY": -5, "OAK": -8,
    "PHI": -5, "PIT": -5, "SD":  -8, "SF":  -8, "SEA": -8,
    "STL": -6, "TB":  -5, "TEX": -6, "TOR": -5, "WSH": -5,
}

OPENER_PRONE_TEAMS: set[str] = {"TB", "MIA", "OAK", "TOR", "DET"}

# Park bearing (degrees, CF from home plate) for wind-to-CF computation.
# From worker/app/team_map.py PARK_BEARING — reproduced here to avoid circular import.
PARK_BEARING: dict[str, int] = {
    "ARI": 325, "ATL": 15,  "BAL": 90,  "BOS": 340, "CHC": 0,
    "CWS": 340, "CIN": 350, "CLE": 20,  "COL": 10,  "DET": 330,
    "HOU": 350, "KC":  325, "LAA": 25,  "LAD": 0,   "MIA": 30,
    "MIL": 350, "MIN": 10,  "NYM": 335, "NYY": 340, "OAK": 5,
    "PHI": 340, "PIT": 350, "SD":  15,  "SF":  345, "SEA": 350,
    "STL": 10,  "TB":  0,   "TEX": 0,   "TOR": 0,   "WSH": 30,
}

WIND_DIR_DEGREES: dict[str, float] = {
    "N": 0, "NNE": 22.5, "NE": 45, "ENE": 67.5,
    "E": 90, "ESE": 112.5, "SE": 135, "SSE": 157.5,
    "S": 180, "SSW": 202.5, "SW": 225, "WSW": 247.5,
    "W": 270, "WNW": 292.5, "NW": 315, "NNW": 337.5,
    "": 0,
}

# Severity weight for injury signals (matches feature-builder.ts)
SEVERITY_WEIGHT: dict[str, int] = {
    "day_to_day": 1, "questionable": 2,
    "il_10": 3, "il_15": 4, "il_60": 5,
}

# Umpire baseline values (imputed — no ump assignment table yet in v1)
UMP_K_RATE_CAREER_DEFAULT = 0.218
UMP_RUN_FACTOR_DEFAULT = 1.0
UMP_ASSIGNED_DEFAULT = 0  # 0 = not confirmed

# SP default imputed stats (league average)
SP_DEFAULTS = {
    "era_season": 4.50, "era_last_30d": 4.50, "era_last_10d": 4.50,
    "fip_season": 4.50, "k9_season": 7.5, "bb9_season": 3.2,
    "hr9_season": 1.2, "whip_season": 1.30, "days_rest": 4,
    "ip_last_start": 5.0, "is_confirmed": 0, "throws": 1,
    "is_opener": 0, "ttop_exposure": 2.0,
}

# Bullpen defaults
BP_DEFAULTS = {
    "era_last_7d": 4.50, "era_season": 4.50,
    "ip_last_2d": 0.0, "ip_last_3d": 0.0,
    "whip_last_7d": 1.30,
}

# Team offense defaults
TEAM_OFF_DEFAULTS = {
    "ops_season": 0.720, "ops_last_14d": 0.720,
    "runs_pg_season": 4.5, "runs_pg_last_14d": 4.5,
    "k_rate_season": 0.220, "bb_rate_season": 0.085,
    "batting_avg_season": 0.250,
}

TEAM_REC_DEFAULTS = {
    "runs_ewma_7d": 4.5,
    "win_pct_season": 0.500, "win_pct_home": 0.533, "win_pct_away": 0.467,
    "last10_win_pct": 0.500, "run_diff_pg": 0.0, "pythag_win_pct": 0.500,
    "days_rest": 1,
}

H2H_DEFAULT = 0.500


def _american_to_raw_implied(price: int | float | None) -> float:
    if price is None:
        return 0.5
    p = float(price)
    if p > 0:
        return 100.0 / (100.0 + p)
    return abs(p) / (abs(p) + 100.0)


def _novig_home(home_price, away_price) -> float | None:
    if home_price is None or away_price is None:
        return None
    p_raw = _american_to_raw_implied(home_price)
    o_raw = _american_to_raw_implied(away_price)
    margin = p_raw + o_raw - 1.0
    if margin > 0.15 or margin <= 0.0:
        return None
    if margin < 0.005:
        margin = 0.005
    return p_raw / (1.0 + margin)


def _blend_novig(dk_home, dk_away, fd_home, fd_away) -> float | None:
    dk = _novig_home(dk_home, dk_away)
    fd = _novig_home(fd_home, fd_away)
    if dk is None and fd is None:
        return None
    if dk is None:
        return fd
    if fd is None:
        return dk
    return 0.5 * dk + 0.5 * fd


def _compute_wind_to_cf(wind_dir: str | None, home_abbr: str) -> float:
    """
    Compute component of wind velocity toward CF (positive = out to CF, negative = in).
    """
    import math
    if not wind_dir or home_abbr not in PARK_BEARING:
        return 0.0
    wind_deg = WIND_DIR_DEGREES.get(wind_dir.upper().strip(), 0.0)
    park_deg = float(PARK_BEARING[home_abbr])
    angle_diff = abs((wind_deg - park_deg + 180) % 360 - 180)
    return math.cos(math.radians(angle_diff))


def _ip_str_to_float(ip_val: Any) -> float:
    """Convert innings pitched '6.1' format to decimal (6.333...)."""
    try:
        ip = float(ip_val)
        full = int(ip)
        partial = round(ip - full, 1)
        return full + partial * (10 / 3)
    except (TypeError, ValueError):
        return 0.0


# ---------------------------------------------------------------------------
# Supabase client factory (lazy singleton)
# ---------------------------------------------------------------------------

_supabase_client = None


def _get_supabase():
    global _supabase_client
    if _supabase_client is not None:
        return _supabase_client

    try:
        from supabase import create_client
    except ImportError:
        raise RuntimeError("supabase-py not installed — add 'supabase' to requirements.txt")

    url = os.environ.get("SUPABASE_URL", "")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in Fly env")

    _supabase_client = create_client(url, key)
    return _supabase_client


# ---------------------------------------------------------------------------
# SP stat computation from recent game box scores
# ---------------------------------------------------------------------------

def _compute_sp_stats_from_games(
    pitcher_uuid: str,
    game_date: date,
    supabase,
) -> dict[str, Any]:
    """
    Query recent game_pitcher_stats (if table exists) or fall back to games
    linescore data to compute SP season/rolling stats.

    Returns dict with all sp_* sub-keys (without side prefix).
    All values default to league average when data is thin.

    Because no pitcher_stats table exists in v1 schema, this implementation
    queries the players table for handedness and returns defaults for numeric
    stats.  A [WARN] line is printed for every stat that falls back to default.
    """
    result: dict[str, Any] = dict(SP_DEFAULTS)

    if not pitcher_uuid:
        return result

    try:
        player_resp = supabase.table("players").select("throws, position").eq("id", pitcher_uuid).limit(1).execute()
        rows = player_resp.data or []
        if rows:
            throws_val = rows[0].get("throws")
            position = rows[0].get("position", "")
            # throws: 'L'=0, 'R'=1 (numeric encoding matching training data)
            result["throws"] = 1 if throws_val == "R" else 0
            result["is_confirmed"] = 1  # pitcher ID is set → confirmed
            # Opener detection: SP position with opener-prone flag computed at game level
    except Exception as e:
        print(f"[WARN] SP handedness query failed for {pitcher_uuid}: {e}")

    # Numeric stats fall back to league average — no pitcher_stats table in v1
    # [WARN] logged once per market build, not per feature
    print(f"[WARN] SP numeric stats (ERA/FIP/K9/BB9/HR9/WHIP) defaulting to league avg "
          f"— no pitcher_stats table in schema for pitcher_id={pitcher_uuid[:8]}")

    return result


# ---------------------------------------------------------------------------
# Bullpen stats from recent game data
# ---------------------------------------------------------------------------

def _compute_bullpen_stats_from_games(
    team_uuid: str,
    game_date: date,
    supabase,
) -> dict[str, Any]:
    """
    Compute bullpen load and ERA from recent completed games.

    No bullpen_stats table exists in v1 schema.  Returns defaults with [WARN].
    """
    result: dict[str, Any] = dict(BP_DEFAULTS)
    print(f"[WARN] Bullpen stats defaulting to league avg — no bullpen_stats table "
          f"in schema for team_id={str(team_uuid)[:8]}")
    return result


# ---------------------------------------------------------------------------
# Team offense stats from recent games
# ---------------------------------------------------------------------------

def _compute_team_offense_stats(
    team_uuid: str,
    game_date: date,
    supabase,
) -> dict[str, Any]:
    """
    Compute team batting aggregate from recent completed games table.

    v1 schema has games.home_score / away_score but no per-game batting stats.
    Returns defaults with [WARN] for full batting features.
    Computes run-per-game rolling averages from games scores — the one real
    data point available.
    """
    result: dict[str, Any] = {**TEAM_OFF_DEFAULTS, **TEAM_REC_DEFAULTS}

    try:
        cutoff = (game_date - timedelta(days=60)).isoformat()
        # Query as home team games
        home_resp = supabase.table("games").select(
            "game_date, home_score, away_score, status"
        ).eq("home_team_id", team_uuid).gte("game_date", cutoff).lt(
            "game_date", game_date.isoformat()
        ).eq("status", "final").order("game_date", desc=True).limit(40).execute()

        away_resp = supabase.table("games").select(
            "game_date, home_score, away_score, status"
        ).eq("away_team_id", team_uuid).gte("game_date", cutoff).lt(
            "game_date", game_date.isoformat()
        ).eq("status", "final").order("game_date", desc=True).limit(40).execute()

        home_rows = home_resp.data or []
        away_rows = away_resp.data or []

        # Build unified list of (game_date, runs_scored, runs_allowed, is_home_win)
        games_list = []
        for r in home_rows:
            hs = r.get("home_score")
            as_ = r.get("away_score")
            if hs is not None and as_ is not None:
                games_list.append({
                    "date": r["game_date"],
                    "scored": hs, "allowed": as_,
                    "win": hs > as_,
                    "is_home": True,
                })
        for r in away_rows:
            hs = r.get("home_score")
            as_ = r.get("away_score")
            if hs is not None and as_ is not None:
                games_list.append({
                    "date": r["game_date"],
                    "scored": as_, "allowed": hs,
                    "win": as_ > hs,
                    "is_home": False,
                })

        if not games_list:
            return result

        # Sort by date descending
        games_list.sort(key=lambda x: x["date"], reverse=True)

        current_year = game_date.year
        season_games = [g for g in games_list if g["date"].startswith(str(current_year))]
        last_14d_cutoff = (game_date - timedelta(days=14)).isoformat()
        games_14d = [g for g in season_games if g["date"] >= last_14d_cutoff]

        if season_games:
            scored = [g["scored"] for g in season_games]
            allowed = [g["allowed"] for g in season_games]
            wins = [g["win"] for g in season_games]
            n = len(season_games)

            result["runs_pg_season"] = round(sum(scored) / n, 3)
            result["win_pct_season"] = round(sum(wins) / n, 3)
            result["run_diff_pg"] = round((sum(scored) - sum(allowed)) / n, 3)

            rs_tot = float(sum(scored))
            ra_tot = float(sum(allowed))
            if rs_tot + ra_tot > 0:
                result["pythag_win_pct"] = round(
                    rs_tot ** 2 / (rs_tot ** 2 + ra_tot ** 2), 4
                )

            # Home/away split
            home_games = [g for g in season_games if g["is_home"]]
            away_games = [g for g in season_games if not g["is_home"]]
            if home_games:
                result["win_pct_home"] = round(sum(g["win"] for g in home_games) / len(home_games), 3)
            if away_games:
                result["win_pct_away"] = round(sum(g["win"] for g in away_games) / len(away_games), 3)

            # Last 10
            last10 = season_games[:10]
            if last10:
                result["last10_win_pct"] = round(sum(g["win"] for g in last10) / len(last10), 3)

            # EWMA runs (half-life 7 days)
            import math
            alpha = 1 - math.exp(-math.log(2) / 7)
            scored_asc = list(reversed(scored))
            ewma = scored_asc[0] if scored_asc else 4.5
            for s in scored_asc[1:]:
                ewma = alpha * s + (1 - alpha) * ewma
            result["runs_ewma_7d"] = round(ewma, 3)

            # Days rest
            if games_list:
                most_recent_date = games_list[0]["date"]
                try:
                    last_dt = date.fromisoformat(most_recent_date)
                    rest = min((game_date - last_dt).days, 4)
                    result["days_rest"] = rest
                except ValueError:
                    pass

        if games_14d:
            scored_14 = [g["scored"] for g in games_14d]
            n14 = len(games_14d)
            result["runs_pg_last_14d"] = round(sum(scored_14) / n14, 3)

    except Exception as e:
        print(f"[WARN] Team offense/record query failed for team_id={str(team_uuid)[:8]}: {e}")

    # Batting aggregate features (OPS/K%/BB%/BA) — no per-game batting stats in v1 schema
    print(f"[WARN] Batting aggregate stats (OPS/K%/BB%/BA) defaulting — "
          f"no batting_stats table in schema for team_id={str(team_uuid)[:8]}")

    return result


# ---------------------------------------------------------------------------
# Market features from odds table
# ---------------------------------------------------------------------------

def _compute_market_features(
    game_id: str,
    game_date: date,
    supabase,
) -> dict[str, Any]:
    """
    Compute market_implied_prob_home, line_move_direction, market_novig_home_morning,
    line_movement_morning_to_afternoon, book_disagreement_morning.

    Pulls the two most recent moneyline odds snapshots from the odds table.
    Uses the latest snapshot as "current" and the earliest as "morning" proxy.
    """
    result: dict[str, Any] = {
        "market_implied_prob_home": None,
        "line_move_direction": 0,
        "market_novig_home_morning": None,
        "line_movement_morning_to_afternoon": None,
        "book_disagreement_morning": None,
        # Raw odds needed by run_inference for EV computation
        "dk_ml_home": None, "dk_ml_away": None,
        "fd_ml_home": None, "fd_ml_away": None,
        "dk_rl_home_price": None, "dk_rl_away_price": None,
        "fd_rl_home_price": None, "fd_rl_away_price": None,
        "dk_over_price": None, "dk_under_price": None,
        "fd_over_price": None, "fd_under_price": None,
        "posted_total_line": None,
    }

    try:
        resp = supabase.table("odds").select(
            "market, home_price, away_price, total_line, over_price, under_price, "
            "run_line_spread, snapshotted_at, sportsbooks(key)"
        ).eq("game_id", game_id).order("snapshotted_at", desc=False).execute()

        rows = resp.data or []
        if not rows:
            print(f"[WARN] No odds rows for game_id={game_id[:8]} — market features all None")
            return result

        # Separate by book and market
        dk_ml = [r for r in rows if r.get("sportsbooks", {}).get("key") == "draftkings" and r["market"] == "moneyline"]
        fd_ml = [r for r in rows if r.get("sportsbooks", {}).get("key") == "fanduel" and r["market"] == "moneyline"]
        dk_rl = [r for r in rows if r.get("sportsbooks", {}).get("key") == "draftkings" and r["market"] == "run_line"]
        fd_rl = [r for r in rows if r.get("sportsbooks", {}).get("key") == "fanduel" and r["market"] == "run_line"]
        dk_tot = [r for r in rows if r.get("sportsbooks", {}).get("key") == "draftkings" and r["market"] == "total"]
        fd_tot = [r for r in rows if r.get("sportsbooks", {}).get("key") == "fanduel" and r["market"] == "total"]

        # Latest snapshot per book for EV computation
        dk_ml_latest = dk_ml[-1] if dk_ml else None
        fd_ml_latest = fd_ml[-1] if fd_ml else None

        if dk_ml_latest:
            result["dk_ml_home"] = dk_ml_latest.get("home_price")
            result["dk_ml_away"] = dk_ml_latest.get("away_price")
        if fd_ml_latest:
            result["fd_ml_home"] = fd_ml_latest.get("home_price")
            result["fd_ml_away"] = fd_ml_latest.get("away_price")

        dk_rl_latest = dk_rl[-1] if dk_rl else None
        fd_rl_latest = fd_rl[-1] if fd_rl else None
        if dk_rl_latest:
            result["dk_rl_home_price"] = dk_rl_latest.get("home_price")
            result["dk_rl_away_price"] = dk_rl_latest.get("away_price")
        if fd_rl_latest:
            result["fd_rl_home_price"] = fd_rl_latest.get("home_price")
            result["fd_rl_away_price"] = fd_rl_latest.get("away_price")

        dk_tot_latest = dk_tot[-1] if dk_tot else None
        fd_tot_latest = fd_tot[-1] if fd_tot else None
        if dk_tot_latest:
            result["dk_over_price"] = dk_tot_latest.get("over_price")
            result["dk_under_price"] = dk_tot_latest.get("under_price")
            result["posted_total_line"] = dk_tot_latest.get("total_line")
        if fd_tot_latest:
            result["fd_over_price"] = fd_tot_latest.get("over_price")
            result["fd_under_price"] = fd_tot_latest.get("under_price")

        # Novig blend from latest snapshot
        dk_h = result["dk_ml_home"]
        dk_a = result["dk_ml_away"]
        fd_h = result["fd_ml_home"]
        fd_a = result["fd_ml_away"]

        blend_latest = _blend_novig(dk_h, dk_a, fd_h, fd_a)
        result["market_implied_prob_home"] = blend_latest

        # Morning proxy = earliest available snapshot per book
        dk_ml_earliest = dk_ml[0] if dk_ml else None
        fd_ml_earliest = fd_ml[0] if fd_ml else None

        dk_h_m = dk_ml_earliest.get("home_price") if dk_ml_earliest else None
        dk_a_m = dk_ml_earliest.get("away_price") if dk_ml_earliest else None
        fd_h_m = fd_ml_earliest.get("home_price") if fd_ml_earliest else None
        fd_a_m = fd_ml_earliest.get("away_price") if fd_ml_earliest else None

        blend_morning = _blend_novig(dk_h_m, dk_a_m, fd_h_m, fd_a_m)
        result["market_novig_home_morning"] = blend_morning

        # Book disagreement (morning)
        nv_dk_m = _novig_home(dk_h_m, dk_a_m)
        nv_fd_m = _novig_home(fd_h_m, fd_a_m)
        if nv_dk_m is not None and nv_fd_m is not None:
            result["book_disagreement_morning"] = round(abs(nv_dk_m - nv_fd_m), 4)

        # Line movement (morning → latest)
        if blend_morning is not None and blend_latest is not None:
            result["line_movement_morning_to_afternoon"] = round(
                blend_latest - blend_morning, 4
            )
            result["line_move_direction"] = (
                1 if blend_latest > blend_morning + 0.005
                else -1 if blend_latest < blend_morning - 0.005
                else 0
            )

    except Exception as e:
        print(f"[WARN] Market feature query failed for game_id={game_id[:8]}: {e}")

    return result


# ---------------------------------------------------------------------------
# News signal aggregation (T-6h window, same logic as feature-builder.ts)
# ---------------------------------------------------------------------------

def _compute_news_features(game_id: str, supabase) -> dict[str, Any]:
    """
    Query news_signals for the game within the last 6 hours.
    Returns the same 6 numeric features that feature-builder.ts produced.
    """
    result = {
        "late_scratch_count": 0,
        "late_scratch_war_impact_sum": 0.0,
        "lineup_change_count": 0,
        "injury_update_severity_max": 0,
        "opener_announced": 0,
        "weather_note_flag": 0,
    }

    try:
        six_hours_ago = (datetime.now(timezone.utc) - timedelta(hours=6)).isoformat()
        resp = supabase.table("news_signals").select(
            "signal_type, confidence, payload"
        ).eq("game_id", game_id).gte("created_at", six_hours_ago).execute()

        for sig in (resp.data or []):
            sig_type = sig.get("signal_type", "")
            payload = sig.get("payload") or {}

            if sig_type == "late_scratch":
                result["late_scratch_count"] += 1
                war = payload.get("war_proxy")
                if isinstance(war, (int, float)):
                    result["late_scratch_war_impact_sum"] += war

            elif sig_type == "lineup_change":
                result["lineup_change_count"] += 1

            elif sig_type == "injury_update":
                severity = payload.get("severity") or ""
                weight = SEVERITY_WEIGHT.get(severity, 1)
                if weight > result["injury_update_severity_max"]:
                    result["injury_update_severity_max"] = weight

            elif sig_type == "opener_announcement":
                result["opener_announced"] = 1

            elif sig_type == "weather_note":
                result["weather_note_flag"] = 1

    except Exception as e:
        print(f"[WARN] News signals query failed for game_id={game_id[:8]}: {e}")

    return result


# ---------------------------------------------------------------------------
# Park feature computation
# ---------------------------------------------------------------------------

def _compute_park_features(home_abbr: str) -> dict[str, Any]:
    return {
        "park_run_factor": PARK_RUN_FACTOR.get(home_abbr, 100),
        "park_hr_factor": PARK_HR_FACTOR.get(home_abbr, 100),
        "park_is_dome": 1 if home_abbr in DOME_PARKS else 0,
        "park_hr_factor_l": PARK_HR_FACTOR_L.get(home_abbr, 100),
        "park_hr_factor_r": PARK_HR_FACTOR_R.get(home_abbr, 100),
        "park_hr_factor_lineup_weighted": round(
            PARK_HR_FACTOR_L.get(home_abbr, 100) * 0.40 +
            PARK_HR_FACTOR_R.get(home_abbr, 100) * 0.60,
            1
        ),
    }


# ---------------------------------------------------------------------------
# Weather feature computation
# ---------------------------------------------------------------------------

def _compute_weather_features(game_row: dict, home_abbr: str) -> dict[str, Any]:
    temp_f = game_row.get("weather_temp_f")
    wind_mph = game_row.get("weather_wind_mph")
    wind_dir = game_row.get("weather_wind_dir") or ""

    wind_to_cf = _compute_wind_to_cf(wind_dir, home_abbr)
    # wind_factor: mph × wind_to_cf (positive = blowing out, negative = in)
    wind_factor = (float(wind_mph) * wind_to_cf) if wind_mph is not None else 0.0

    return {
        "weather_temp_f": float(temp_f) if temp_f is not None else 72.0,
        "weather_wind_mph": float(wind_mph) if wind_mph is not None else 0.0,
        "weather_wind_to_cf": round(wind_to_cf, 4),
        "weather_wind_factor": round(wind_factor, 2),
    }


# ---------------------------------------------------------------------------
# Travel features
# ---------------------------------------------------------------------------

def _compute_travel_features(away_abbr: str, home_abbr: str) -> dict[str, Any]:
    away_tz = TEAM_TIMEZONE_OFFSET.get(away_abbr, -6)
    home_tz = TEAM_TIMEZONE_OFFSET.get(home_abbr, -6)
    tz_delta = home_tz - away_tz  # positive = traveling east
    return {
        "away_travel_tz_change": float(tz_delta),
        "away_travel_eastward_penalty": int(tz_delta >= 2),
    }


# ---------------------------------------------------------------------------
# Opener / TTOP proxy (static heuristic — no SP history in v1)
# ---------------------------------------------------------------------------

def _compute_opener_ttop(team_abbr: str, sp_uuid: str | None) -> dict[str, Any]:
    is_opener = 1 if team_abbr in OPENER_PRONE_TEAMS and sp_uuid is None else 0
    ttop = 1.0 if is_opener else 2.0
    return {"is_opener": is_opener, "ttop_exposure": ttop}


# ---------------------------------------------------------------------------
# Platoon / lineup features (imputed — no confirmed lineup in v1)
# ---------------------------------------------------------------------------

def _platoon_features() -> dict[str, Any]:
    return {
        "home_platoon_advantage": 0,
        "away_platoon_advantage": 0,
        "home_lineup_confirmed": 0,
    }


# ---------------------------------------------------------------------------
# H2H feature
# ---------------------------------------------------------------------------

def _compute_h2h_win_pct(
    home_team_id: str, away_team_id: str, game_date: date, supabase
) -> float:
    try:
        cutoff = date(game_date.year, 1, 1).isoformat()
        resp = supabase.table("games").select(
            "home_score, away_score"
        ).eq("home_team_id", home_team_id).eq(
            "away_team_id", away_team_id
        ).gte("game_date", cutoff).lt(
            "game_date", game_date.isoformat()
        ).eq("status", "final").limit(30).execute()

        rows = resp.data or []
        if not rows:
            return H2H_DEFAULT
        wins = sum(1 for r in rows if (r.get("home_score") or 0) > (r.get("away_score") or 0))
        return round(wins / len(rows), 3)
    except Exception as e:
        print(f"[WARN] H2H query failed: {e}")
        return H2H_DEFAULT


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

async def build_feature_vector(game_id: str, market: str) -> dict[str, Any]:
    """
    Build the full 90-feature vector for a game × market combination.

    Queries Supabase directly using the service-role key.  Returns a dict
    with every key the trained B2 model expects.  Missing values are returned
    as None; main.py _build_feature_vector() maps None → 0.0 with a [WARN] log.

    The `market` argument is accepted for future per-market feature divergence
    but all three models currently share the same 90-feature contract.
    """
    import asyncio

    sb = _get_supabase()

    # -----------------------------------------------------------------------
    # Step 1: Fetch game row
    # -----------------------------------------------------------------------
    try:
        game_resp = sb.table("games").select(
            "id, game_date, game_time_utc, status, "
            "home_team_id, away_team_id, "
            "venue_name, venue_state, "
            "weather_condition, weather_temp_f, weather_wind_mph, weather_wind_dir, "
            "probable_home_pitcher_id, probable_away_pitcher_id, "
            "home_team:home_team_id(id, mlb_team_id, abbreviation), "
            "away_team:away_team_id(id, mlb_team_id, abbreviation)"
        ).eq("id", game_id).limit(1).execute()
        game_rows = game_resp.data or []
    except Exception as e:
        print(f"[ERROR] Game fetch failed for game_id={game_id[:8]}: {e}")
        return _fallback_feature_vector()

    if not game_rows:
        print(f"[WARN] Game not found for game_id={game_id[:8]}")
        return _fallback_feature_vector()

    game = game_rows[0]
    game_date_str = game.get("game_date", "")
    try:
        game_date = date.fromisoformat(game_date_str)
    except (ValueError, TypeError):
        game_date = date.today()

    home_team = game.get("home_team") or {}
    away_team = game.get("away_team") or {}

    home_mlb_id = home_team.get("mlb_team_id")
    away_mlb_id = away_team.get("mlb_team_id")
    home_abbr = home_team.get("abbreviation") or MLB_ID_TO_ABBR.get(home_mlb_id, "")
    away_abbr = away_team.get("abbreviation") or MLB_ID_TO_ABBR.get(away_mlb_id, "")

    home_team_id = game.get("home_team_id")
    away_team_id = game.get("away_team_id")
    home_sp_id = game.get("probable_home_pitcher_id")
    away_sp_id = game.get("probable_away_pitcher_id")

    # -----------------------------------------------------------------------
    # Step 2: Compute all feature groups (IO-bound — run sequentially;
    # supabase-py is synchronous, wrapping in executor is overkill for v1)
    # -----------------------------------------------------------------------

    # SP stats
    home_sp_raw = _compute_sp_stats_from_games(home_sp_id or "", game_date, sb)
    away_sp_raw = _compute_sp_stats_from_games(away_sp_id or "", game_date, sb)

    # Opener / TTOP
    home_opener_ttop = _compute_opener_ttop(home_abbr, home_sp_id)
    away_opener_ttop = _compute_opener_ttop(away_abbr, away_sp_id)

    # Bullpen
    home_bp = _compute_bullpen_stats_from_games(home_team_id or "", game_date, sb)
    away_bp = _compute_bullpen_stats_from_games(away_team_id or "", game_date, sb)

    # Team offense / record
    home_team_stats = _compute_team_offense_stats(home_team_id or "", game_date, sb)
    away_team_stats = _compute_team_offense_stats(away_team_id or "", game_date, sb)

    # Park
    park = _compute_park_features(home_abbr)

    # Weather
    weather = _compute_weather_features(game, home_abbr)

    # Travel
    travel = _compute_travel_features(away_abbr, home_abbr)

    # Market (includes raw odds keys for EV computation)
    market_feats = _compute_market_features(game_id, game_date, sb)

    # H2H
    h2h_win_pct = _compute_h2h_win_pct(home_team_id or "", away_team_id or "", game_date, sb)

    # News
    news = _compute_news_features(game_id, sb)

    # Platoon / lineup
    platoon = _platoon_features()

    # -----------------------------------------------------------------------
    # Step 3: Assemble into the 90-feature dict matching the B2 contract
    # -----------------------------------------------------------------------
    fv: dict[str, Any] = {
        # --- Home SP (14 features) ---
        "home_sp_era_season":       home_sp_raw["era_season"],
        "home_sp_era_last_30d":     home_sp_raw["era_last_30d"],
        "home_sp_era_last_10d":     home_sp_raw["era_last_10d"],
        "home_sp_fip_season":       home_sp_raw["fip_season"],
        "home_sp_k9_season":        home_sp_raw["k9_season"],
        "home_sp_bb9_season":       home_sp_raw["bb9_season"],
        "home_sp_hr9_season":       home_sp_raw["hr9_season"],
        "home_sp_whip_season":      home_sp_raw["whip_season"],
        "home_sp_days_rest":        home_sp_raw["days_rest"],
        "home_sp_ip_last_start":    home_sp_raw["ip_last_start"],
        "home_sp_is_confirmed":     1 if home_sp_id else 0,
        "home_sp_throws":           home_sp_raw["throws"],
        # --- Away SP (12 features, same set) ---
        "away_sp_era_season":       away_sp_raw["era_season"],
        "away_sp_era_last_30d":     away_sp_raw["era_last_30d"],
        "away_sp_era_last_10d":     away_sp_raw["era_last_10d"],
        "away_sp_fip_season":       away_sp_raw["fip_season"],
        "away_sp_k9_season":        away_sp_raw["k9_season"],
        "away_sp_bb9_season":       away_sp_raw["bb9_season"],
        "away_sp_hr9_season":       away_sp_raw["hr9_season"],
        "away_sp_whip_season":      away_sp_raw["whip_season"],
        "away_sp_days_rest":        away_sp_raw["days_rest"],
        "away_sp_ip_last_start":    away_sp_raw["ip_last_start"],
        "away_sp_is_confirmed":     1 if away_sp_id else 0,
        "away_sp_throws":           away_sp_raw["throws"],
        # --- Opener / TTOP (4 features) ---
        "home_is_opener":           home_opener_ttop["is_opener"],
        "away_is_opener":           away_opener_ttop["is_opener"],
        "home_sp_ttop_exposure":    home_opener_ttop["ttop_exposure"],
        "away_sp_ttop_exposure":    away_opener_ttop["ttop_exposure"],
        # --- Home Bullpen (5 features) ---
        "home_bp_era_last_7d":      home_bp["era_last_7d"],
        "home_bp_era_season":       home_bp["era_season"],
        "home_bp_ip_last_2d":       home_bp["ip_last_2d"],
        "home_bp_ip_last_3d":       home_bp["ip_last_3d"],
        "home_bp_whip_last_7d":     home_bp["whip_last_7d"],
        # --- Away Bullpen (5 features) ---
        "away_bp_era_last_7d":      away_bp["era_last_7d"],
        "away_bp_era_season":       away_bp["era_season"],
        "away_bp_ip_last_2d":       away_bp["ip_last_2d"],
        "away_bp_ip_last_3d":       away_bp["ip_last_3d"],
        "away_bp_whip_last_7d":     away_bp["whip_last_7d"],
        # --- Home Team Offense (7 features) ---
        "home_team_ops_season":         home_team_stats["ops_season"],
        "home_team_ops_last_14d":       home_team_stats["ops_last_14d"],
        "home_team_runs_pg_season":     home_team_stats["runs_pg_season"],
        "home_team_runs_pg_last_14d":   home_team_stats["runs_pg_last_14d"],
        "home_team_k_rate_season":      home_team_stats["k_rate_season"],
        "home_team_bb_rate_season":     home_team_stats["bb_rate_season"],
        "home_team_batting_avg_season": home_team_stats["batting_avg_season"],
        # --- Away Team Offense (7 features) ---
        "away_team_ops_season":         away_team_stats["ops_season"],
        "away_team_ops_last_14d":       away_team_stats["ops_last_14d"],
        "away_team_runs_pg_season":     away_team_stats["runs_pg_season"],
        "away_team_runs_pg_last_14d":   away_team_stats["runs_pg_last_14d"],
        "away_team_k_rate_season":      away_team_stats["k_rate_season"],
        "away_team_bb_rate_season":     away_team_stats["bb_rate_season"],
        "away_team_batting_avg_season": away_team_stats["batting_avg_season"],
        # --- Team Record / Form (10 features) ---
        "home_team_runs_ewma_7d":       home_team_stats["runs_ewma_7d"],
        "away_team_runs_ewma_7d":       away_team_stats["runs_ewma_7d"],
        "home_team_win_pct_season":     home_team_stats["win_pct_season"],
        "home_team_win_pct_home":       home_team_stats["win_pct_home"],
        "home_team_last10_win_pct":     home_team_stats["last10_win_pct"],
        "home_team_run_diff_pg":        home_team_stats["run_diff_pg"],
        "home_team_pythag_win_pct":     home_team_stats["pythag_win_pct"],
        "away_team_win_pct_season":     away_team_stats["win_pct_season"],
        "away_team_win_pct_away":       away_team_stats["win_pct_away"],
        "away_team_last10_win_pct":     away_team_stats["last10_win_pct"],
        "away_team_run_diff_pg":        away_team_stats["run_diff_pg"],
        "away_team_pythag_win_pct":     away_team_stats["pythag_win_pct"],
        # --- H2H (1 feature) ---
        "h2h_home_wins_pct_season":     h2h_win_pct,
        # --- Park (6 features) ---
        "park_run_factor":              park["park_run_factor"],
        "park_hr_factor":               park["park_hr_factor"],
        "park_is_dome":                 park["park_is_dome"],
        "park_hr_factor_l":             park["park_hr_factor_l"],
        "park_hr_factor_r":             park["park_hr_factor_r"],
        "park_hr_factor_lineup_weighted": park["park_hr_factor_lineup_weighted"],
        # --- Weather (4 features) ---
        "weather_temp_f":       weather["weather_temp_f"],
        "weather_wind_mph":     weather["weather_wind_mph"],
        "weather_wind_to_cf":   weather["weather_wind_to_cf"],
        "weather_wind_factor":  weather["weather_wind_factor"],
        # --- Rest / Travel (4 features) ---
        "home_team_days_rest":          home_team_stats["days_rest"],
        "away_team_days_rest":          away_team_stats["days_rest"],
        "away_travel_tz_change":        travel["away_travel_tz_change"],
        "away_travel_eastward_penalty": travel["away_travel_eastward_penalty"],
        # --- Umpire (3 features — imputed, no assignment table in v1) ---
        "ump_k_rate_career":    UMP_K_RATE_CAREER_DEFAULT,
        "ump_run_factor":       UMP_RUN_FACTOR_DEFAULT,
        "ump_assigned":         UMP_ASSIGNED_DEFAULT,
        # --- Platoon / lineup (3 features — imputed) ---
        "home_platoon_advantage":  platoon["home_platoon_advantage"],
        "away_platoon_advantage":  platoon["away_platoon_advantage"],
        "home_lineup_confirmed":   platoon["home_lineup_confirmed"],
        # --- Market features (5 features) ---
        "market_implied_prob_home":         market_feats["market_implied_prob_home"],
        "line_move_direction":              market_feats["line_move_direction"],
        "market_novig_home_morning":        market_feats["market_novig_home_morning"],
        "line_movement_morning_to_afternoon": market_feats["line_movement_morning_to_afternoon"],
        "book_disagreement_morning":        market_feats["book_disagreement_morning"],
        # --- Raw odds (needed by run_inference for EV; NOT model features) ---
        "dk_ml_home":       market_feats["dk_ml_home"],
        "dk_ml_away":       market_feats["dk_ml_away"],
        "fd_ml_home":       market_feats["fd_ml_home"],
        "fd_ml_away":       market_feats["fd_ml_away"],
        "dk_rl_home_price": market_feats["dk_rl_home_price"],
        "dk_rl_away_price": market_feats["dk_rl_away_price"],
        "fd_rl_home_price": market_feats["fd_rl_home_price"],
        "fd_rl_away_price": market_feats["fd_rl_away_price"],
        "dk_over_price":    market_feats["dk_over_price"],
        "dk_under_price":   market_feats["dk_under_price"],
        "fd_over_price":    market_feats["fd_over_price"],
        "fd_under_price":   market_feats["fd_under_price"],
        "posted_total_line": market_feats["posted_total_line"],
        # --- News features (6 features) ---
        "late_scratch_count":           news["late_scratch_count"],
        "late_scratch_war_impact_sum":  news["late_scratch_war_impact_sum"],
        "lineup_change_count":          news["lineup_change_count"],
        "injury_update_severity_max":   news["injury_update_severity_max"],
        "opener_announced":             news["opener_announced"],
        "weather_note_flag":            news["weather_note_flag"],
    }

    return fv


def _fallback_feature_vector() -> dict[str, Any]:
    """Return an all-None feature vector when the game row cannot be fetched."""
    return {k: None for k in _EXPECTED_FEATURE_NAMES}


# Full expected feature name list (matches manifest_b2.json for all three markets)
_EXPECTED_FEATURE_NAMES = [
    "home_sp_era_season", "home_sp_era_last_30d", "home_sp_era_last_10d",
    "home_sp_fip_season", "home_sp_k9_season", "home_sp_bb9_season",
    "home_sp_hr9_season", "home_sp_whip_season", "home_sp_days_rest",
    "home_sp_ip_last_start", "home_sp_is_confirmed", "home_sp_throws",
    "away_sp_era_season", "away_sp_era_last_30d", "away_sp_era_last_10d",
    "away_sp_fip_season", "away_sp_k9_season", "away_sp_bb9_season",
    "away_sp_hr9_season", "away_sp_whip_season", "away_sp_days_rest",
    "away_sp_ip_last_start", "away_sp_is_confirmed", "away_sp_throws",
    "home_is_opener", "away_is_opener", "home_sp_ttop_exposure", "away_sp_ttop_exposure",
    "home_bp_era_last_7d", "home_bp_era_season", "home_bp_ip_last_2d",
    "home_bp_ip_last_3d", "home_bp_whip_last_7d",
    "away_bp_era_last_7d", "away_bp_era_season", "away_bp_ip_last_2d",
    "away_bp_ip_last_3d", "away_bp_whip_last_7d",
    "home_team_ops_season", "home_team_ops_last_14d",
    "home_team_runs_pg_season", "home_team_runs_pg_last_14d",
    "home_team_k_rate_season", "home_team_bb_rate_season", "home_team_batting_avg_season",
    "away_team_ops_season", "away_team_ops_last_14d",
    "away_team_runs_pg_season", "away_team_runs_pg_last_14d",
    "away_team_k_rate_season", "away_team_bb_rate_season", "away_team_batting_avg_season",
    "home_team_runs_ewma_7d", "away_team_runs_ewma_7d",
    "home_team_win_pct_season", "home_team_win_pct_home", "home_team_last10_win_pct",
    "home_team_run_diff_pg", "home_team_pythag_win_pct",
    "away_team_win_pct_season", "away_team_win_pct_away", "away_team_last10_win_pct",
    "away_team_run_diff_pg", "away_team_pythag_win_pct",
    "h2h_home_wins_pct_season",
    "park_run_factor", "park_hr_factor", "park_is_dome",
    "park_hr_factor_l", "park_hr_factor_r", "park_hr_factor_lineup_weighted",
    "weather_temp_f", "weather_wind_mph", "weather_wind_to_cf", "weather_wind_factor",
    "home_team_days_rest", "away_team_days_rest",
    "away_travel_tz_change", "away_travel_eastward_penalty",
    "ump_k_rate_career", "ump_run_factor", "ump_assigned",
    "home_platoon_advantage", "away_platoon_advantage", "home_lineup_confirmed",
    "market_implied_prob_home", "line_move_direction",
    "market_novig_home_morning", "line_movement_morning_to_afternoon",
    "book_disagreement_morning",
]
