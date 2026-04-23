"""
load_historical_odds_v2.py — 3-snapshot odds loader with per-slot novig columns.

Extends load_historical_odds.py (single evening snapshot) to read all three
intraday slots:
  morning   — data/historical-odds-morning/{year}/*.json  (14:00 UTC)
  afternoon — data/historical-odds-afternoon/{year}/*.json (19:00 UTC)
  evening   — data/historical-odds/{year}/*.json           (03:00 UTC next day)

Output: wide DataFrame with columns suffixed by _morning / _afternoon / _evening
for all price fields, plus computed novig columns per slot.

Novig formula (matching ADR-002 and run_backtest_v3.py):
  novig_home_dk = (1/dk_home_decimal) / (1/dk_home_decimal + 1/dk_away_decimal)
  market_novig_blend = 0.5 * novig_home_dk + 0.5 * novig_home_fd

The blend is what ADR-002 calls market_novig_prior when applied to the morning
slot.  All three slot blends are emitted so the training pipeline can compute
line movement features (afternoon - morning delta, etc.).

Join key: (home_team, away_team, game_date) using 3-letter abbreviations.
De-dup per slot: if a slot has multiple files touching the same game (impossible
by design — one file per date per slot), take the latest snapshot_ts.

Contamination guard: abs(h2h price) > 500 treated as in-game line, discarded.
This mirrors the guard in load_historical_odds.py and run-morning-afternoon.ts.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Literal

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parents[3]))
from worker.app.team_map import odds_name_to_abbr

REPO_ROOT = Path(__file__).parents[3]
SLOT_DIRS: dict[str, Path] = {
    "morning":   REPO_ROOT / "data" / "historical-odds-morning",
    "afternoon": REPO_ROOT / "data" / "historical-odds-afternoon",
    "evening":   REPO_ROOT / "data" / "historical-odds",
}

SlotName = Literal["morning", "afternoon", "evening"]

# Price fields produced per slot (before suffixing)
_BASE_PRICE_FIELDS = [
    "dk_ml_home", "dk_ml_away",
    "fd_ml_home", "fd_ml_away",
    "dk_rl_home_price", "dk_rl_home_point",
    "dk_rl_away_price", "dk_rl_away_point",
    "fd_rl_home_price", "fd_rl_home_point",
    "fd_rl_away_price", "fd_rl_away_point",
    "dk_over_price", "dk_over_point",
    "dk_under_price",
    "fd_over_price", "fd_over_point",
    "fd_under_price",
]


# ---------------------------------------------------------------------------
# Low-level: parse one file → list[dict]
# ---------------------------------------------------------------------------

def _parse_bookmaker_markets(
    bookmakers: list[dict],
    home_abbr: str,
    away_abbr: str,
) -> dict:
    """Extract DK + FD prices from a bookmakers list. Identical logic to v1."""
    result: dict = {f: None for f in _BASE_PRICE_FIELDS}

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
                    price = o.get("price")
                    if price is not None and abs(price) > 500:
                        continue  # in-game sentinel
                    abbr = odds_name_to_abbr(o["name"])
                    if abbr == home_abbr:
                        result[f"{prefix}_ml_home"] = price
                    elif abbr == away_abbr:
                        result[f"{prefix}_ml_away"] = price

            elif mk == "spreads":
                for o in outcomes:
                    abbr = odds_name_to_abbr(o["name"])
                    if abbr == home_abbr:
                        result[f"{prefix}_rl_home_price"] = o.get("price")
                        result[f"{prefix}_rl_home_point"] = o.get("point")
                    elif abbr == away_abbr:
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
                        if result[f"{prefix}_over_point"] is None:
                            result[f"{prefix}_over_point"] = o.get("point")

    return result


def _load_slot_year(slot: SlotName, year: int) -> pd.DataFrame:
    """
    Load all JSON files for one slot + year.
    Returns DataFrame with un-suffixed price columns plus
    snapshot_ts, game_date, home_team, away_team, season.
    """
    slot_dir = SLOT_DIRS[slot] / str(year)
    if not slot_dir.exists():
        return pd.DataFrame()

    rows: list[dict] = []

    for json_file in sorted(slot_dir.glob("*.json")):
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
    df["snapshot_dt"] = pd.to_datetime(df["snapshot_ts"], utc=True, errors="coerce")

    # De-dup: same home+away+game_date across multiple snapshot files → keep latest
    df = (
        df.sort_values("snapshot_dt")
        .groupby(["home_team", "away_team", "game_date"], as_index=False)
        .last()
    )
    df = df.drop(columns=["snapshot_dt"], errors="ignore")
    return df


# ---------------------------------------------------------------------------
# Novig computation (matches ADR-002 formula exactly)
# ---------------------------------------------------------------------------

def _american_to_raw_implied(price: float | None) -> float:
    """Raw implied prob (includes vig) from American odds. Returns 0.5 on None/NaN."""
    if price is None or (isinstance(price, float) and np.isnan(price)):
        return 0.5
    p = float(price)
    if p > 0:
        return 100.0 / (100.0 + p)
    else:
        return abs(p) / (abs(p) + 100.0)


def _remove_vig(
    home_price: float | None,
    away_price: float | None,
) -> tuple[float | None, float | None]:
    """
    Remove vig from a two-outcome market. Returns (novig_home, novig_away).

    Returns (None, None) if prices are missing or margin is outside [0.005, 0.15].
    Broken data guard: margin > 15% or margin <= 0 → treat as invalid.
    """
    if home_price is None or away_price is None:
        return None, None
    if pd.isna(home_price) or pd.isna(away_price):
        return None, None

    p_raw = _american_to_raw_implied(home_price)
    o_raw = _american_to_raw_implied(away_price)
    margin = p_raw + o_raw - 1.0

    if margin > 0.15 or margin <= 0.0:
        return None, None
    if margin < 0.005:
        margin = 0.005

    return p_raw / (1.0 + margin), o_raw / (1.0 + margin)


def _novig_blend(dk_home: float | None, dk_away: float | None,
                 fd_home: float | None, fd_away: float | None) -> float | None:
    """
    50/50 DK+FD blend novig home probability per ADR-002.
    Returns None if both books are missing.
    """
    novig_dk_home, _ = _remove_vig(dk_home, dk_away)
    novig_fd_home, _ = _remove_vig(fd_home, fd_away)

    if novig_dk_home is None and novig_fd_home is None:
        return None
    if novig_dk_home is None:
        return novig_fd_home
    if novig_fd_home is None:
        return novig_dk_home
    return 0.5 * novig_dk_home + 0.5 * novig_fd_home


def _add_novig_columns(df: pd.DataFrame, slot: str) -> pd.DataFrame:
    """
    Add computed novig columns for moneyline (home) for a given slot.

    Adds:
      novig_ml_home_dk_{slot}
      novig_ml_home_fd_{slot}
      novig_ml_home_{slot}           — DK+FD blend (market_novig_prior when slot=morning)
      book_disagreement_ml_{slot}    — |novig_dk - novig_fd| on home ML
    """
    df = df.copy()

    dk_h = df.get(f"dk_ml_home_{slot}")
    dk_a = df.get(f"dk_ml_away_{slot}")
    fd_h = df.get(f"fd_ml_home_{slot}")
    fd_a = df.get(f"fd_ml_away_{slot}")

    if dk_h is None:
        df[f"novig_ml_home_{slot}"] = None
        df[f"novig_ml_home_dk_{slot}"] = None
        df[f"novig_ml_home_fd_{slot}"] = None
        df[f"book_disagreement_ml_{slot}"] = None
        return df

    nv_dk = [_remove_vig(h, a)[0] for h, a in zip(dk_h, dk_a)]
    nv_fd = [_remove_vig(h, a)[0] for h, a in zip(fd_h, fd_a)]

    nv_dk_s = pd.Series(nv_dk, dtype="Float64")
    nv_fd_s = pd.Series(nv_fd, dtype="Float64")

    df[f"novig_ml_home_dk_{slot}"] = nv_dk_s.values
    df[f"novig_ml_home_fd_{slot}"] = nv_fd_s.values

    # Blend: average where both present, fall back to whichever is available
    both_present = nv_dk_s.notna() & nv_fd_s.notna()
    dk_only = nv_dk_s.notna() & nv_fd_s.isna()
    fd_only = nv_dk_s.isna() & nv_fd_s.notna()

    blend = pd.Series([None] * len(df), dtype="Float64")
    blend[both_present] = (nv_dk_s[both_present] + nv_fd_s[both_present]) / 2
    blend[dk_only] = nv_dk_s[dk_only]
    blend[fd_only] = nv_fd_s[fd_only]

    df[f"novig_ml_home_{slot}"] = blend.values

    # Book disagreement (DK vs FD novig spread)
    disagree = pd.Series([None] * len(df), dtype="Float64")
    disagree[both_present] = (nv_dk_s[both_present] - nv_fd_s[both_present]).abs()
    df[f"book_disagreement_ml_{slot}"] = disagree.values

    return df


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def load_slot_year(slot: SlotName, year: int) -> pd.DataFrame:
    """Load one slot × year. Returns DataFrame with un-suffixed price columns."""
    return _load_slot_year(slot, year)


def load_all_slots(years: list[int] | None = None) -> pd.DataFrame:
    """
    Load morning, afternoon, and evening snapshots for all years.

    Returns a wide DataFrame joined on (home_team, away_team, game_date) with
    all price columns suffixed by _morning / _afternoon / _evening, plus
    computed novig columns per slot.

    Join strategy: outer join across slots so games with partial slot coverage
    are still included (some game days may lack afternoon data).
    """
    if years is None:
        years = [2022, 2023, 2024]

    slots: list[SlotName] = ["morning", "afternoon", "evening"]
    key_cols = ["home_team", "away_team", "game_date", "season"]

    combined: pd.DataFrame | None = None

    for slot in slots:
        frames: list[pd.DataFrame] = []
        for year in years:
            df_year = _load_slot_year(slot, year)
            if not df_year.empty:
                frames.append(df_year)

        if not frames:
            continue

        slot_df = pd.concat(frames, ignore_index=True)

        # Suffix price + snapshot columns with slot name
        price_cols = [c for c in slot_df.columns if c not in key_cols]
        rename_map = {c: f"{c}_{slot}" for c in price_cols}
        slot_df = slot_df.rename(columns=rename_map)

        if combined is None:
            combined = slot_df
        else:
            combined = combined.merge(
                slot_df,
                on=key_cols,
                how="outer",
            )

    if combined is None or combined.empty:
        return pd.DataFrame()

    # Add novig columns for each slot
    for slot in slots:
        combined = _add_novig_columns(combined, slot)

    # Add line movement feature: morning→afternoon implied prob delta
    m_blend = combined.get(f"novig_ml_home_morning")
    a_blend = combined.get(f"novig_ml_home_afternoon")
    if m_blend is not None and a_blend is not None:
        m_ser = pd.Series(m_blend, dtype="Float64")
        a_ser = pd.Series(a_blend, dtype="Float64")
        both = m_ser.notna() & a_ser.notna()
        mv = pd.Series([None] * len(combined), dtype="Float64")
        mv[both] = a_ser[both] - m_ser[both]
        combined["line_movement_morning_to_afternoon"] = mv.values
    else:
        combined["line_movement_morning_to_afternoon"] = None

    combined = combined.sort_values(["season", "game_date", "home_team"]).reset_index(drop=True)
    return combined


def load_all_seasons_wide(years: list[int] | None = None) -> pd.DataFrame:
    """Alias for load_all_slots — name matches the v1 API convention."""
    return load_all_slots(years)


if __name__ == "__main__":
    df = load_all_slots()
    print(f"Wide odds DataFrame: {len(df)} rows, {len(df.columns)} columns")
    print("\nColumns:")
    for col in sorted(df.columns):
        print(f"  {col}")
    print("\nSample row (first game):")
    if not df.empty:
        sample = df.iloc[0]
        key_fields = [
            "game_date", "home_team", "away_team",
            "dk_ml_home_morning", "dk_ml_home_afternoon", "dk_ml_home_evening",
            "novig_ml_home_morning", "novig_ml_home_afternoon", "novig_ml_home_evening",
            "line_movement_morning_to_afternoon",
            "book_disagreement_ml_morning",
        ]
        for f in key_fields:
            print(f"  {f}: {sample.get(f)}")
