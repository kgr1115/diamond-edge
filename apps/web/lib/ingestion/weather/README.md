# Weather Ingestion

## Source Selection

**Primary:** Open-Meteo (`https://api.open-meteo.com/v1/forecast`)
- Free, no API key required, no account
- Hourly forecasts up to 7 days ahead
- JSON REST API, no scraping required
- No documented usage cap; reasonable non-commercial use is fine

**Secondary (same-day only):** MLB Stats API schedule hydration (`?hydrate=weather`)
- Returns weather for games on game day from MLB's own weather station feed
- Available in `schedule.ts` as part of the schedule sync — no extra API call
- Takes priority over Open-Meteo when present

**Why not Weather.gov or wttr.in?**
- Weather.gov: US-only, more complex REST API, no Canadian coverage (Rogers Centre in Toronto)
- wttr.in: screen-scraping format, not stable for automated ingestion
- Open-Meteo: global coverage, proper JSON API, stable, free

## Cost

**$0/month.** No API key, no billing, no rate-limit overage risk.

## Data Flow

```
schedule-sync cron
  └── fetchSchedule(dates, { hydrate: 'weather,linescore,...' })
        ├── game.weather present (MLB API) → parseWeather() → games.weather_* columns
        └── game.weather null (future games) → fetchVenueWeather(STADIUMS[venueName], gameTimeUtc)
                                                              → games.weather_* columns
```

Weather is written to `games.*` columns during schedule sync. There is no separate Redis key for weather — it lives inside the `de:schedule:{date}` cache entry.

## Files

| File | Purpose |
|---|---|
| `client.ts` | `fetchVenueWeather(venue, gameTimeUtc)` — Open-Meteo call, WMO code parsing, wind direction |
| `stadiums.ts` | All 30 MLB stadium lat/lon + timezone + state code lookup |

## `games` Columns Populated

| Column | Source | Example |
|---|---|---|
| `weather_condition` | WMO code → string | `'clear'`, `'partly cloudy'`, `'rain'` |
| `weather_temp_f` | `temperature_2m` in °F | `72` |
| `weather_wind_mph` | `windspeed_10m` in mph | `10` |
| `weather_wind_dir` | Wind degrees → compass | `'NW'`, `'SE'` |

## Freshness SLA

Weather data is updated every time the schedule-sync cron runs (2×/day). For same-day games, MLB's own weather data (fresher, from field-level sensors) takes precedence. For games 24h+ out, Open-Meteo forecast accuracy is ±3°F / ±5 mph, which is acceptable for the ML model's wind/weather features.

## Failure Modes

| Failure | Handling |
|---|---|
| Unknown venue name | `STADIUMS[venueName]` returns `undefined`; `weather_*` fields left null. Warn log. |
| Open-Meteo HTTP error | `fetchVenueWeather` returns all-null GameWeather. Game row saved with null weather. |
| Open-Meteo unreachable | Same null result. Weather is non-blocking for schedule sync. |
| Hourly time not found | Falls back to first hour of the returned dataset. |

Weather is non-blocking: null `weather_*` columns are valid and the ML model must handle them (it degrades to non-weather features when null).

## Env Vars

None required. Open-Meteo is keyless. `OPEN_METEO_BASE` is defined in `config.ts` with the default value and can be overridden for testing.
