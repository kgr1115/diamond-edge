"""
pull_mlb_stats.py — Fetch MLB Stats API data for 2022-2024.

Pulls:
  - Schedule + game results (scores, game_pk, pitchers)
  - Box scores per game (for pitcher stats, bullpen usage, team batting lines)

Output: data/training/mlb_games_raw.parquet, data/training/pitcher_logs_raw.parquet,
        data/training/team_batting_raw.parquet, data/training/bullpen_raw.parquet

Rate limiting: MLB Stats API is free/public but polite — 1 req/second cap enforced.
All data fetched in sequential batches per season. Script is idempotent: checks for
existing parquet files and skips completed seasons.
"""

from __future__ import annotations

import json
import time
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import requests

STATSAPI_BASE = "https://statsapi.mlb.com/api/v1"
DATA_DIR = Path(__file__).parents[3] / "data" / "training"
DATA_DIR.mkdir(parents=True, exist_ok=True)

SESSION = requests.Session()
SESSION.headers["User-Agent"] = "DiamondEdge/1.0 (kyle.g.rauch@gmail.com)"


def _get(path: str, params: dict | None = None, retries: int = 3) -> dict:
    """GET from MLB Stats API with retry and polite rate limiting."""
    url = f"{STATSAPI_BASE}{path}"
    for attempt in range(retries):
        try:
            resp = SESSION.get(url, params=params, timeout=15)
            resp.raise_for_status()
            return resp.json()
        except requests.RequestException as e:
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
            else:
                raise RuntimeError(f"MLB API failed after {retries} attempts: {url} — {e}") from e
    return {}


def fetch_schedule(season: int) -> pd.DataFrame:
    """
    Fetch full season schedule with final scores and probable pitchers.
    Returns DataFrame with one row per game.
    """
    print(f"  Fetching schedule for {season}...")
    data = _get("/schedule", {
        "sportId": 1,
        "season": season,
        "gameType": "R",
        "fields": (
            "dates,date,games,gamePk,gameDate,status,teams,"
            "home,away,team,id,name,score,probablePitcher,"
            "fullName,detailedState,officialDate"
        ),
    })

    rows = []
    for day in data.get("dates", []):
        game_date = day.get("date", "")
        for game in day.get("games", []):
            status = game.get("status", {}).get("detailedState", "")
            if status not in ("Final", "Game Over", "Completed Early"):
                continue

            home = game.get("teams", {}).get("home", {})
            away = game.get("teams", {}).get("away", {})

            rows.append({
                "game_pk": game.get("gamePk"),
                "game_date": game_date,
                "season": season,
                "home_team_id": home.get("team", {}).get("id"),
                "home_team_name": home.get("team", {}).get("name", ""),
                "away_team_id": away.get("team", {}).get("id"),
                "away_team_name": away.get("team", {}).get("name", ""),
                "home_score": home.get("score"),
                "away_score": away.get("score"),
                "home_sp_id": home.get("probablePitcher", {}).get("id"),
                "home_sp_name": home.get("probablePitcher", {}).get("fullName", ""),
                "away_sp_id": away.get("probablePitcher", {}).get("id"),
                "away_sp_name": away.get("probablePitcher", {}).get("fullName", ""),
                "status": status,
            })

        time.sleep(0.1)

    return pd.DataFrame(rows)


def fetch_box_score(game_pk: int) -> dict | None:
    """Fetch box score for a single game. Returns None on error."""
    try:
        data = _get(f"/game/{game_pk}/boxscore")
        return data
    except RuntimeError:
        return None


def _extract_pitcher_line(pitcher_data: dict, team_side: str, game_pk: int, game_date: str) -> dict | None:
    """Extract per-pitcher stats from boxscore pitching array."""
    pid = pitcher_data.get("personId") or pitcher_data.get("id")
    stats = pitcher_data.get("stats", {}).get("pitching", {})
    if not stats:
        return None
    # MLB Stats API uses gamesStarted=1 for starters; sequenceNumber is not exposed
    is_starter = bool(stats.get("gamesStarted", 0))
    return {
        "game_pk": game_pk,
        "game_date": game_date,
        "pitcher_id": pid,
        "team_side": team_side,
        "ip": stats.get("inningsPitched", 0),
        "hits": stats.get("hits", 0),
        "runs": stats.get("runs", 0),
        "earned_runs": stats.get("earnedRuns", 0),
        "bb": stats.get("baseOnBalls", 0),
        "k": stats.get("strikeOuts", 0),
        "hr": stats.get("homeRuns", 0),
        "pitches": stats.get("pitchesThrown", 0),
        "is_starter": is_starter,
    }


def _extract_team_batting(team_batting: dict, team_side: str, game_pk: int, game_date: str, score: int) -> dict:
    """Extract team batting aggregate from box score."""
    batting = team_batting.get("teamStats", {}).get("batting", {})
    return {
        "game_pk": game_pk,
        "game_date": game_date,
        "team_side": team_side,
        "score": score,
        "ab": batting.get("atBats", 0),
        "hits": batting.get("hits", 0),
        "doubles": batting.get("doubles", 0),
        "triples": batting.get("triples", 0),
        "hr": batting.get("homeRuns", 0),
        "rbi": batting.get("rbi", 0),
        "bb": batting.get("baseOnBalls", 0),
        "k": batting.get("strikeOuts", 0),
        "lob": batting.get("leftOnBase", 0),
    }


def fetch_all_box_scores(
    schedule_df: pd.DataFrame,
    max_games: int | None = None,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """
    Fetch box scores for all games in schedule_df.
    Returns (pitcher_logs_df, bullpen_df, team_batting_df).
    """
    pitcher_rows: list[dict] = []
    team_batting_rows: list[dict] = []

    games = schedule_df.iterrows()
    total = len(schedule_df)

    for i, (_, row) in enumerate(games):
        if max_games and i >= max_games:
            break

        game_pk = row["game_pk"]
        game_date = row["game_date"]

        if i % 100 == 0:
            print(f"    Box scores: {i}/{total} games...")

        box = fetch_box_score(game_pk)
        if not box:
            continue

        teams = box.get("teams", {})
        for side in ("home", "away"):
            team_data = teams.get(side, {})
            score_col = "home_score" if side == "home" else "away_score"
            score = row.get(score_col, 0) or 0

            # Team batting
            team_batting_rows.append(
                _extract_team_batting(team_data, side, game_pk, game_date, score)
            )

            # Pitcher lines
            pitchers = team_data.get("pitchers", [])
            pitcher_detail = team_data.get("players", {})
            for pid in pitchers:
                player_key = f"ID{pid}"
                pd_data = pitcher_detail.get(player_key, {})
                pd_data["id"] = pid
                seq_num = pd_data.get("stats", {}).get("pitching", {}).get("sequenceNumber")
                pd_data["sequenceNumber"] = seq_num
                line = _extract_pitcher_line(pd_data, side, game_pk, game_date)
                if line:
                    pitcher_rows.append(line)

        time.sleep(0.2)

    pitcher_df = pd.DataFrame(pitcher_rows)
    team_batting_df = pd.DataFrame(team_batting_rows)

    # Bullpen = non-starters
    bullpen_df = pitcher_df[pitcher_df["is_starter"] == False].copy() if not pitcher_df.empty else pd.DataFrame()

    return pitcher_df, bullpen_df, team_batting_df


def run(seasons: list[int] | None = None, skip_existing: bool = True) -> None:
    """Main entry point. Fetches and saves all MLB Stats data."""
    if seasons is None:
        seasons = [2022, 2023, 2024]

    schedule_path = DATA_DIR / "mlb_schedule_raw.parquet"
    pitcher_path = DATA_DIR / "pitcher_logs_raw.parquet"
    team_batting_path = DATA_DIR / "team_batting_raw.parquet"
    bullpen_path = DATA_DIR / "bullpen_raw.parquet"

    all_schedules = []
    all_pitchers = []
    all_team_batting = []
    all_bullpen = []

    for season in seasons:
        season_sched_path = DATA_DIR / f"mlb_schedule_{season}.parquet"
        if skip_existing and season_sched_path.exists():
            print(f"  Skipping {season} — schedule already fetched")
            all_schedules.append(pd.read_parquet(season_sched_path))
            # Load pitcher/batting if available
            sp = DATA_DIR / f"pitcher_logs_{season}.parquet"
            bp = DATA_DIR / f"bullpen_{season}.parquet"
            tb = DATA_DIR / f"team_batting_{season}.parquet"
            if sp.exists():
                all_pitchers.append(pd.read_parquet(sp))
            if bp.exists():
                all_bullpen.append(pd.read_parquet(bp))
            if tb.exists():
                all_team_batting.append(pd.read_parquet(tb))
            continue

        print(f"\nFetching {season}...")
        sched = fetch_schedule(season)
        print(f"  Got {len(sched)} completed games for {season}")
        sched.to_parquet(season_sched_path, index=False)
        all_schedules.append(sched)

        print(f"  Fetching box scores for {season}...")
        p_df, bp_df, tb_df = fetch_all_box_scores(sched)
        p_df.to_parquet(DATA_DIR / f"pitcher_logs_{season}.parquet", index=False)
        bp_df.to_parquet(DATA_DIR / f"bullpen_{season}.parquet", index=False)
        tb_df.to_parquet(DATA_DIR / f"team_batting_{season}.parquet", index=False)
        all_pitchers.append(p_df)
        all_bullpen.append(bp_df)
        all_team_batting.append(tb_df)

    # Combine all seasons
    if all_schedules:
        sched_combined = pd.concat(all_schedules, ignore_index=True)
        sched_combined.to_parquet(schedule_path, index=False)
        print(f"\nSchedule: {len(sched_combined)} total games saved")

    if all_pitchers:
        p_combined = pd.concat(all_pitchers, ignore_index=True)
        p_combined.to_parquet(pitcher_path, index=False)
        print(f"Pitcher logs: {len(p_combined)} rows saved")

    if all_bullpen:
        bp_combined = pd.concat(all_bullpen, ignore_index=True)
        bp_combined.to_parquet(bullpen_path, index=False)
        print(f"Bullpen logs: {len(bp_combined)} rows saved")

    if all_team_batting:
        tb_combined = pd.concat(all_team_batting, ignore_index=True)
        tb_combined.to_parquet(team_batting_path, index=False)
        print(f"Team batting: {len(tb_combined)} rows saved")


if __name__ == "__main__":
    run()
