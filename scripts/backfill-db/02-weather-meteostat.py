"""
Step 2 (Meteostat fallback) — Backfill weather for 2022-2024 games.

Source:  Meteostat hourly observations via NOAA/DWD CDN (no API key, no rate limit)
Target:  games.weather_temp_f, weather_wind_mph, weather_wind_dir, weather_condition
Idempotency: skips rows where weather_wind_dir IS NOT NULL AND matches r'^\\d+$'

Usage:
    pip install meteostat psycopg[binary]
    python scripts/backfill-db/02-weather-meteostat.py

Reads SUPABASE_DB_URL from repo-root .env (same convention as Node scripts).
"""

import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Env loading — mirrors shared.mjs loadEnv()
# ---------------------------------------------------------------------------
SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent
ENV_PATH = REPO_ROOT / ".env"


def load_env() -> None:
    if not ENV_PATH.exists():
        return
    for raw in ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        eq = line.find("=")
        if eq == -1:
            continue
        key = line[:eq].strip()
        val = line[eq + 1:].strip()
        if key and key not in os.environ:
            os.environ[key] = val


load_env()

# ---------------------------------------------------------------------------
# Lazy imports after env load (packages must be installed)
# ---------------------------------------------------------------------------
try:
    import psycopg  # psycopg3
except ImportError:
    sys.exit(
        "[FATAL] psycopg not installed. Run: pip install psycopg[binary]"
    )

try:
    from meteostat import Point, hourly, stations, Parameter, Provider
    import pandas as pd
except ImportError:
    sys.exit(
        "[FATAL] meteostat not installed. Run: pip install meteostat"
    )

# ---------------------------------------------------------------------------
# Stadium coordinate map (matches 02-weather.mjs STADIUMS)
# ---------------------------------------------------------------------------
STADIUMS: dict[str, tuple[float, float]] = {
    "Yankee Stadium":              (40.8296, -73.9262),
    "Fenway Park":                 (42.3467, -71.0972),
    "Oriole Park at Camden Yards": (39.2838, -76.6218),
    "Tropicana Field":             (27.7683, -82.6534),
    "Rogers Centre":               (43.6414, -79.3894),
    "Guaranteed Rate Field":       (41.8300, -87.6339),
    "Progressive Field":           (41.4954, -81.6854),
    "Comerica Park":               (42.3390, -83.0485),
    "Target Field":                (44.9817, -93.2781),
    "Kauffman Stadium":            (39.0517, -94.4803),
    "Minute Maid Park":            (29.7572, -95.3552),
    "Angel Stadium":               (33.8003, -117.8827),
    "Oakland Coliseum":            (37.7516, -122.2007),
    "T-Mobile Park":               (47.5914, -122.3326),
    "Globe Life Field":            (32.7473, -97.0831),
    "Citizens Bank Park":          (39.9061, -75.1665),
    "Citi Field":                  (40.7571, -73.8458),
    "Nationals Park":              (38.8730, -77.0074),
    "Truist Park":                 (33.8907, -84.4677),
    "loanDepot park":              (25.7781, -80.2195),
    "LoanDepot Park":              (25.7781, -80.2195),
    "Wrigley Field":               (41.9484, -87.6553),
    "American Family Field":       (43.0280, -87.9712),
    "PNC Park":                    (40.4469, -80.0057),
    "Great American Ball Park":    (39.0975, -84.5086),
    "Busch Stadium":               (38.6226, -90.1928),
    "Dodger Stadium":              (34.0739, -118.2400),
    "Oracle Park":                 (37.7786, -122.3893),
    "Chase Field":                 (33.4453, -112.0667),
    "Coors Field":                 (39.7559, -104.9942),
    "Petco Park":                  (32.7076, -117.1570),
    "Sutter Health Park":          (38.5802, -121.5005),
}

# Cache the resolved station-id list per venue coord — stations.nearby() is a remote
# lookup; resolve once and reuse for every game played at that stadium.
_STATION_CACHE: dict[str, list[str]] = {}
_NEARBY_LIMIT = 3
_PARAMETERS = [Parameter.TEMP, Parameter.WSPD, Parameter.WDIR, Parameter.COCO]
_PROVIDERS = [Provider.ISD_LITE, Provider.METAR]

WIND_DIR_NUMERIC_RE = re.compile(r"^\d+$")


# ---------------------------------------------------------------------------
# Structured log — matches shared.mjs log() output shape
# ---------------------------------------------------------------------------
def log(level: str, event: str, **fields) -> None:
    record = {"level": level, "event": event, "ts": datetime.now(timezone.utc).isoformat(), **fields}
    print(json.dumps(record, default=str), flush=True)


# ---------------------------------------------------------------------------
# Meteostat fetch for a single game
# ---------------------------------------------------------------------------
def _resolve_stations(lat: float, lon: float) -> list[str]:
    """Return the top-N station ids near the venue, cached per coord."""
    cache_key = f"{lat:.4f},{lon:.4f}"
    cached = _STATION_CACHE.get(cache_key)
    if cached is not None:
        return cached
    near = stations.nearby(Point(lat, lon), limit=_NEARBY_LIMIT)
    ids = list(near.index)
    _STATION_CACHE[cache_key] = ids
    return ids


def fetch_weather(lat: float, lon: float, game_time_utc: datetime) -> dict | None:
    """
    Pull hourly observations around game_time_utc from the nearest Meteostat
    stations. Returns a dict with condition/temp_f/wind_mph/wind_dir, or None
    if data is unavailable.

    Meteostat 2.x uses naive UTC datetimes for the time window. Multi-station
    fetches return a DataFrame indexed by (station, time); pick the row closest
    to game_time_utc, breaking ties by station-distance order.
    """
    station_ids = _resolve_stations(lat, lon)
    if not station_ids:
        return None

    # Window: T-1hr to T+1hr gives three candidate hours; we pick the closest
    start = (game_time_utc - timedelta(hours=1)).replace(tzinfo=None)
    end = (game_time_utc + timedelta(hours=1)).replace(tzinfo=None)
    target_naive = game_time_utc.replace(tzinfo=None)

    try:
        ts = hourly(
            station_ids,
            start,
            end,
            parameters=_PARAMETERS,
            providers=_PROVIDERS,
        )
        data = ts.fetch()
    except Exception:
        return None

    if data is None or data.empty:
        return None

    # data is a MultiIndex (station, time) DataFrame in Meteostat 2.x.
    # Walk stations in nearest-first order and pick the first one with usable
    # readings at the closest available hour to game time.
    if isinstance(data.index, pd.MultiIndex):
        for sid in station_ids:
            if sid not in data.index.get_level_values("station"):
                continue
            sub = data.xs(sid, level="station")
            if sub.empty:
                continue
            sub_idx = pd.to_datetime(sub.index)
            deltas = abs(sub_idx - target_naive)
            row = sub.iloc[deltas.argmin()]
            picked = _row_to_weather(row)
            if picked is not None:
                return picked
        return None

    # Single-station fallback path
    data.index = pd.to_datetime(data.index)
    deltas = abs(data.index - target_naive)
    row = data.iloc[deltas.argmin()]
    return _row_to_weather(row)


def _row_to_weather(row) -> dict | None:
    """Convert a Meteostat hourly row (METRIC units) to our DB-shaped dict.
    Returns None if neither temp nor wind data is present (no signal to record)."""
    temp_c = row.get("temp", None)
    wspd_kmh = row.get("wspd", None)
    wdir = row.get("wdir", None)

    if pd.isna(temp_c) and pd.isna(wspd_kmh) and pd.isna(wdir):
        return None

    temp_f = round(temp_c * 9 / 5 + 32) if pd.notna(temp_c) else None
    wind_mph = round(wspd_kmh * 0.621371) if pd.notna(wspd_kmh) else None
    wind_dir = str(round(wdir)) if pd.notna(wdir) else None

    coco = row.get("coco", None)
    condition = _coco_to_condition(int(coco)) if pd.notna(coco) else "unknown"

    return {
        "condition": condition,
        "temp_f": temp_f,
        "wind_mph": wind_mph,
        "wind_dir": wind_dir,
    }


def _coco_to_condition(code: int) -> str:
    # Meteostat uses its own 1-27 COCO scale, not WMO directly
    if code in (1, 2):    return "clear"
    if code in (3, 4):    return "partly cloudy"
    if code in (5, 6):    return "foggy"
    if code in (7, 8):    return "rain"
    if code in (9, 10):   return "drizzle"
    if code in (11, 12):  return "drizzle"
    if code in (13, 14):  return "rain"
    if code in (15, 16):  return "snow"
    if code in (17, 18):  return "rain"
    if code in (19, 20):  return "thunderstorm"
    if code in (21, 22):  return "snow"
    if code in (23, 24):  return "snow"
    if code in (25, 26):  return "thunderstorm"
    if code == 27:        return "thunderstorm"
    return "unknown"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> None:
    db_url = os.environ.get("SUPABASE_DB_URL")
    if not db_url:
        sys.exit("[FATAL] SUPABASE_DB_URL not set in environment or .env")

    conn = psycopg.connect(db_url, sslmode="require")
    log("info", "step2_start", source="meteostat")

    start_ts = datetime.now(timezone.utc)

    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, mlb_game_id, game_date::text, game_time_utc::text, venue_name,
                   weather_wind_dir
            FROM games
            WHERE EXTRACT(YEAR FROM game_date) BETWEEN 2022 AND 2026
              AND status IN ('final', 'cancelled', 'postponed', 'scheduled')
            ORDER BY game_date
            """
        )
        games = cur.fetchall()
        col_names = [desc.name for desc in cur.description]

    total = len(games)
    updated = 0
    skipped = 0
    missing_venue = 0
    fetch_null = 0
    errors: list[str] = []
    seen_unknown_venues: set[str] = set()

    log("info", "step2_games_to_process", total=total,
        already_have_wind_dir=sum(
            1 for g in games
            if g[col_names.index("weather_wind_dir")] is not None
        ))

    with conn.cursor() as cur:
        for row in games:
            game = dict(zip(col_names, row))

            # Idempotency: skip rows that already have a valid numeric wind_dir
            existing_wdir = game["weather_wind_dir"]
            if existing_wdir is not None and WIND_DIR_NUMERIC_RE.match(str(existing_wdir)):
                skipped += 1
                continue

            venue = game["venue_name"]
            if not venue:
                missing_venue += 1
                continue

            coords = STADIUMS.get(venue)
            if coords is None:
                if venue not in seen_unknown_venues:
                    errors.append(f"Unknown venue: {venue} (game {game['mlb_game_id']})")
                    seen_unknown_venues.add(venue)
                missing_venue += 1
                continue

            lat, lon = coords

            # Parse game time — fall back to 23:00 UTC if missing (matches Node script)
            raw_time = game["game_time_utc"] or f"{game['game_date']}T23:00:00+00:00"
            try:
                # Postgres returns TIMESTAMPTZ as offset-aware string
                game_time = datetime.fromisoformat(raw_time)
                if game_time.tzinfo is None:
                    game_time = game_time.replace(tzinfo=timezone.utc)
            except ValueError:
                game_time = datetime(
                    int(game["game_date"][:4]),
                    int(game["game_date"][5:7]),
                    int(game["game_date"][8:10]),
                    23, 0, 0, tzinfo=timezone.utc,
                )

            try:
                weather = fetch_weather(lat, lon, game_time)
            except Exception as exc:
                errors.append(f"fetch error game {game['mlb_game_id']}: {exc}")
                fetch_null += 1
                log("warn", "step2_weather_exception",
                    game_id=game["id"], mlb_game_id=game["mlb_game_id"], err=str(exc))
                continue

            if weather is None:
                fetch_null += 1
                log("warn", "step2_weather_null",
                    game_id=game["id"], mlb_game_id=game["mlb_game_id"])
                continue

            cur.execute(
                """
                UPDATE games
                SET weather_condition = %s,
                    weather_temp_f    = %s,
                    weather_wind_mph  = %s,
                    weather_wind_dir  = %s,
                    updated_at        = now()
                WHERE id = %s
                """,
                (
                    weather["condition"],
                    weather["temp_f"],
                    weather["wind_mph"],
                    weather["wind_dir"],
                    game["id"],
                ),
            )
            conn.commit()
            updated += 1

            if updated % 500 == 0:
                log("info", "step2_progress",
                    updated=updated, skipped=skipped,
                    missing_venue=missing_venue, fetch_null=fetch_null)

    # Post-run format check
    with conn.cursor() as cur:
        cur.execute(
            r"""
            SELECT COUNT(*) FROM games
            WHERE EXTRACT(YEAR FROM game_date) BETWEEN 2022 AND 2026
              AND weather_wind_dir IS NOT NULL
              AND weather_wind_dir !~ '^\d+$'
            """
        )
        bad_count = cur.fetchone()[0]

    wall_ms = int((datetime.now(timezone.utc) - start_ts).total_seconds() * 1000)

    log("info", "step2_complete",
        source="meteostat",
        total=total,
        updated=updated,
        skipped=skipped,
        missing_venue=missing_venue,
        fetch_null=fetch_null,
        bad_wind_dir_format=bad_count,
        wall_ms=wall_ms,
        errors=errors[:50])

    print("\n=== STEP 2 COMPLETE: Weather (Meteostat) ===")
    print(f"Games in range:          {total}")
    print(f"Updated:                 {updated}")
    print(f"Skipped (had data):      {skipped}")
    print(f"Missing venue:           {missing_venue}")
    print(f"Fetch returned null:     {fetch_null}")
    print(f"Bad wind_dir remaining:  {bad_count}  (expected: 0)")
    print(f"Wall time:               {wall_ms / 1000:.1f}s")
    if errors:
        print(f"\nErrors/warnings ({len(errors)}):")
        for e in errors[:20]:
            print(f"  {e}")
        if len(errors) > 20:
            print(f"  ... and {len(errors) - 20} more")

    conn.close()
    if bad_count > 0 or fetch_null > total * 0.1:
        sys.exit(1)


if __name__ == "__main__":
    main()
