"""
Team name normalization: maps Odds API full team names to canonical 3-letter codes
and MLB Stats API team IDs.

Odds API uses full names like "New York Yankees".
MLB Stats API uses team IDs (integers) plus abbreviations.
This table is the single join key between the two data sources.

Park bearing is the compass direction (degrees) of center field from home plate.
Used for weather_wind_to_cf feature computation.
"""

ODDS_NAME_TO_ABBR: dict[str, str] = {
    "Arizona Diamondbacks": "ARI",
    "Atlanta Braves": "ATL",
    "Baltimore Orioles": "BAL",
    "Boston Red Sox": "BOS",
    "Chicago Cubs": "CHC",
    "Chicago White Sox": "CWS",
    "Cincinnati Reds": "CIN",
    "Cleveland Guardians": "CLE",
    "Cleveland Indians": "CLE",
    "Colorado Rockies": "COL",
    "Detroit Tigers": "DET",
    "Houston Astros": "HOU",
    "Kansas City Royals": "KC",
    "Los Angeles Angels": "LAA",
    "Los Angeles Dodgers": "LAD",
    "Miami Marlins": "MIA",
    "Milwaukee Brewers": "MIL",
    "Minnesota Twins": "MIN",
    "New York Mets": "NYM",
    "New York Yankees": "NYY",
    "Oakland Athletics": "OAK",
    "Athletics": "OAK",
    "Philadelphia Phillies": "PHI",
    "Pittsburgh Pirates": "PIT",
    "San Diego Padres": "SD",
    "San Francisco Giants": "SF",
    "Seattle Mariners": "SEA",
    "St. Louis Cardinals": "STL",
    "Tampa Bay Rays": "TB",
    "Texas Rangers": "TEX",
    "Toronto Blue Jays": "TOR",
    "Washington Nationals": "WSH",
}

MLB_STATS_TEAM_ID: dict[str, int] = {
    "ARI": 109,
    "ATL": 144,
    "BAL": 110,
    "BOS": 111,
    "CHC": 112,
    "CWS": 145,
    "CIN": 113,
    "CLE": 114,
    "COL": 115,
    "DET": 116,
    "HOU": 117,
    "KC": 118,
    "LAA": 108,
    "LAD": 119,
    "MIA": 146,
    "MIL": 158,
    "MIN": 142,
    "NYM": 121,
    "NYY": 147,
    "OAK": 133,
    "PHI": 143,
    "PIT": 134,
    "SD": 135,
    "SF": 137,
    "SEA": 136,
    "STL": 138,
    "TB": 139,
    "TEX": 140,
    "TOR": 141,
    "WSH": 120,
}

ABBR_TO_FULL_NAME: dict[str, str] = {v: k for k, v in ODDS_NAME_TO_ABBR.items() if k not in ("Cleveland Indians", "Athletics")}

# Reverse lookup: MLB Stats API team ID → abbreviation
MLB_ID_TO_ABBR: dict[int, str] = {v: k for k, v in MLB_STATS_TEAM_ID.items()}

# Park center-field bearing in compass degrees (from home plate toward CF).
# Used to compute dot product with wind direction → weather_wind_to_cf feature.
# Source: stadium orientation references; static until teams move.
PARK_CF_BEARING: dict[str, float] = {
    "ARI": 340.0,   # Chase Field — retractable dome
    "ATL": 5.0,     # Truist Park
    "BAL": 280.0,   # Camden Yards — wind typically in from left
    "BOS": 55.0,    # Fenway Park — NE-facing CF
    "CHC": 90.0,    # Wrigley Field — due E
    "CWS": 320.0,   # Guaranteed Rate Field
    "CIN": 315.0,   # Great American Ball Park
    "CLE": 335.0,   # Progressive Field
    "COL": 355.0,   # Coors Field — nearly due N
    "DET": 330.0,   # Comerica Park
    "HOU": 10.0,    # Minute Maid Park — retractable dome
    "KC": 5.0,      # Kauffman Stadium
    "LAA": 340.0,   # Angel Stadium
    "LAD": 330.0,   # Dodger Stadium
    "MIA": 0.0,     # loanDepot Park — retractable dome
    "MIL": 350.0,   # American Family Field — retractable dome
    "MIN": 30.0,    # Target Field
    "NYM": 355.0,   # Citi Field
    "NYY": 15.0,    # Yankee Stadium
    "OAK": 295.0,   # Oakland Coliseum (used for 2022-2024)
    "PHI": 350.0,   # Citizens Bank Park
    "PIT": 355.0,   # PNC Park
    "SD": 0.0,      # Petco Park
    "SF": 295.0,    # Oracle Park — wind heavily in from right/CF
    "SEA": 10.0,    # T-Mobile Park — retractable dome
    "STL": 345.0,   # Busch Stadium
    "TB": 0.0,      # Tropicana Field — dome
    "TEX": 15.0,    # Globe Life Field — retractable dome
    "TOR": 0.0,     # Rogers Centre — dome
    "WSH": 355.0,   # Nationals Park
}

DOME_PARKS: set[str] = {"ARI", "HOU", "MIA", "MIL", "MIN", "SEA", "TB", "TEX", "TOR"}

# Park run factors (5-year regressed, 2020-2024). 100 = league average.
# Source: Statcast park factors (approximate). Updated annually pre-season.
PARK_RUN_FACTOR: dict[str, int] = {
    "ARI": 102,
    "ATL": 100,
    "BAL": 106,
    "BOS": 104,
    "CHC": 101,
    "CWS": 97,
    "CIN": 105,
    "CLE": 97,
    "COL": 115,
    "DET": 96,
    "HOU": 100,
    "KC": 103,
    "LAA": 99,
    "LAD": 98,
    "MIA": 94,
    "MIL": 98,
    "MIN": 104,
    "NYM": 97,
    "NYY": 107,
    "OAK": 96,
    "PHI": 104,
    "PIT": 99,
    "SD": 94,
    "SF": 93,
    "SEA": 96,
    "STL": 99,
    "TB": 98,
    "TEX": 103,
    "TOR": 105,
    "WSH": 100,
}

PARK_HR_FACTOR: dict[str, int] = {
    "ARI": 108,
    "ATL": 105,
    "BAL": 118,
    "BOS": 95,
    "CHC": 110,
    "CWS": 104,
    "CIN": 119,
    "CLE": 95,
    "COL": 118,
    "DET": 92,
    "HOU": 96,
    "KC": 104,
    "LAA": 103,
    "LAD": 96,
    "MIA": 87,
    "MIL": 103,
    "MIN": 118,
    "NYM": 95,
    "NYY": 120,
    "OAK": 90,
    "PHI": 112,
    "PIT": 97,
    "SD": 88,
    "SF": 84,
    "SEA": 89,
    "STL": 98,
    "TB": 95,
    "TEX": 110,
    "TOR": 112,
    "WSH": 100,
}


def odds_name_to_abbr(team_name: str) -> str | None:
    """Convert Odds API full team name to 3-letter abbreviation."""
    return ODDS_NAME_TO_ABBR.get(team_name)


def wind_dir_to_degrees(wind_dir: str) -> float | None:
    """Convert compass direction string to degrees. Returns None if unrecognized."""
    mapping = {
        "N": 0.0, "NNE": 22.5, "NE": 45.0, "ENE": 67.5,
        "E": 90.0, "ESE": 112.5, "SE": 135.0, "SSE": 157.5,
        "S": 180.0, "SSW": 202.5, "SW": 225.0, "WSW": 247.5,
        "W": 270.0, "WNW": 292.5, "NW": 315.0, "NNW": 337.5,
        "CALM": 0.0, "VAR": 0.0,
    }
    return mapping.get(wind_dir.strip().upper())


def compute_wind_to_cf(wind_dir: str, wind_mph: float, team_abbr: str) -> float:
    """
    Returns signed wind contribution toward CF:
      +1 if wind blowing out to CF (offense favored)
      -1 if wind blowing in from CF (pitcher favored)
       0 if crosswind, dome, or calm
    """
    if team_abbr in DOME_PARKS:
        return 0.0

    wind_deg = wind_dir_to_degrees(wind_dir)
    if wind_deg is None or wind_mph < 2:
        return 0.0

    cf_bearing = PARK_CF_BEARING.get(team_abbr, 0.0)

    import math
    wind_rad = math.radians(wind_deg)
    cf_rad = math.radians(cf_bearing)

    # Dot product of wind vector with CF direction vector
    dot = math.cos(wind_rad - cf_rad)

    if dot > 0.707:   # within 45 degrees of CF direction → blowing out
        return 1.0
    elif dot < -0.707:  # within 45 degrees of opposite → blowing in
        return -1.0
    else:
        return 0.0
