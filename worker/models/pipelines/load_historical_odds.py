"""
load_historical_odds.py — Load and normalize historical odds from disk.

Reads the backfilled JSON files in data/historical-odds/{year}/*.json,
parses DK + FD lines for h2h (moneyline), spreads (run line), and totals,
normalizes team names via team_map, and outputs a normalized DataFrame.

Join hazard: Odds API uses full team names; MLB Stats API uses gamePk/abbreviation.
Resolution: team_map.ODDS_NAME_TO_ABBR normalizes all names to 3-letter codes.
Games in the same snapshot file with the same home+away+date are de-duped
by taking the closest snapshot to game time.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).parents[3]))
from worker.app.team_map import odds_name_to_abbr

DATA_ROOT = Path(__file__).parents[3] / "data" / "historical-odds"


def _parse_bookmaker_markets(
    bookmakers: list[dict],
    home_team_abbr: str,
    away_team_abbr: str,
) -> dict:
    """Extract DK and FD lines for h2h, spreads, totals from bookmakers list."""
    result: dict = {
        "dk_ml_home": None,
        "dk_ml_away": None,
        "fd_ml_home": None,
        "fd_ml_away": None,
        "dk_rl_home_price": None,
        "dk_rl_home_point": None,
        "dk_rl_away_price": None,
        "dk_rl_away_point": None,
        "fd_rl_home_price": None,
        "fd_rl_home_point": None,
        "fd_rl_away_price": None,
        "fd_rl_away_point": None,
        "dk_over_price": None,
        "dk_over_point": None,
        "dk_under_price": None,
        "fd_over_price": None,
        "fd_over_point": None,
        "fd_under_price": None,
    }

    for bm in bookmakers:
        bk = bm.get("key", "")
        if bk not in ("draftkings", "fanduel"):
            continue
        prefix = "dk" if bk == "draftkings" else "fd"

        for market in bm.get("markets", []):
            mk = market.get("key", "")
            outcomes = market.get("outcomes", [])

            if mk == "h2h":
                for o in outcomes:
                    abbr = odds_name_to_abbr(o["name"])
                    if abbr == home_team_abbr:
                        result[f"{prefix}_ml_home"] = o.get("price")
                    elif abbr == away_team_abbr:
                        result[f"{prefix}_ml_away"] = o.get("price")

            elif mk == "spreads":
                for o in outcomes:
                    abbr = odds_name_to_abbr(o["name"])
                    if abbr == home_team_abbr:
                        result[f"{prefix}_rl_home_price"] = o.get("price")
                        result[f"{prefix}_rl_home_point"] = o.get("point")
                    elif abbr == away_team_abbr:
                        result[f"{prefix}_rl_away_price"] = o.get("price")
                        result[f"{prefix}_rl_away_point"] = o.get("point")

            elif mk == "totals":
                for o in outcomes:
                    side = o.get("name", "").lower()
                    if side == "over":
                        result[f"{prefix}_over_price"] = o.get("price")
                        result[f"{prefix}_over_point"] = o.get("point")
                    elif side == "under":
                        result[f"{prefix}_under_price"] = o.get("price")
                        if f"{prefix}_over_point" is None:
                            result[f"{prefix}_over_point"] = o.get("point")

    return result


def load_year(year: int) -> pd.DataFrame:
    """Load all odds files for a given year. Returns normalized DataFrame."""
    year_dir = DATA_ROOT / str(year)
    if not year_dir.exists():
        return pd.DataFrame()

    rows: list[dict] = []

    for json_file in sorted(year_dir.glob("*.json")):
        try:
            with open(json_file, encoding="utf-8") as f:
                blob = json.load(f)
        except (json.JSONDecodeError, OSError):
            continue

        snapshot_ts = blob.get("timestamp", "")
        games_data = blob.get("data", [])
        if not games_data:
            continue

        for game in games_data:
            home_full = game.get("home_team", "")
            away_full = game.get("away_team", "")

            home_abbr = odds_name_to_abbr(home_full)
            away_abbr = odds_name_to_abbr(away_full)

            if not home_abbr or not away_abbr:
                continue

            commence_utc = game.get("commence_time", "")
            try:
                game_dt = datetime.fromisoformat(commence_utc.replace("Z", "+00:00"))
                game_date = game_dt.date().isoformat()
            except (ValueError, AttributeError):
                game_date = str(year)

            markets = _parse_bookmaker_markets(
                game.get("bookmakers", []),
                home_abbr,
                away_abbr,
            )

            rows.append({
                "odds_api_id": game.get("id", ""),
                "game_date": game_date,
                "commence_time_utc": commence_utc,
                "snapshot_ts": snapshot_ts,
                "home_team": home_abbr,
                "away_team": away_abbr,
                "season": year,
                **markets,
            })

    if not rows:
        return pd.DataFrame()

    df = pd.DataFrame(rows)

    # De-dup: if multiple snapshots have same home+away+game_date, keep
    # the one whose snapshot_ts is latest (closest to closing line).
    df["snapshot_dt"] = pd.to_datetime(df["snapshot_ts"], utc=True, errors="coerce")
    df = (
        df.sort_values("snapshot_dt")
        .groupby(["home_team", "away_team", "game_date"], as_index=False)
        .last()
    )
    df = df.drop(columns=["snapshot_dt"], errors="ignore")

    return df


def load_all_seasons(years: list[int] | None = None) -> pd.DataFrame:
    """Load odds for all specified seasons. Defaults to 2022–2024."""
    if years is None:
        years = [2022, 2023, 2024]
    frames = [load_year(y) for y in years]
    frames = [f for f in frames if not f.empty]
    if not frames:
        return pd.DataFrame()
    return pd.concat(frames, ignore_index=True)


if __name__ == "__main__":
    df = load_all_seasons()
    print(f"Loaded {len(df)} game-odds rows across seasons 2022-2024")
    print(df.dtypes)
    print(df.head(3).to_string())
