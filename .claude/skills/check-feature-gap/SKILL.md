---
name: check-feature-gap
description: Audit Diamond Edge's ML worker feature population — which of the model's declared features are actively pulled from data vs defaulting to league averages. Use when picks look off or when adding new data sources. Invoked via /check-feature-gap or when Kyle says "which features are live?", "what's populated?".
---

# Check Feature Gap

Identifies the gap between the active model's declared features (post zero-variance drop; exact count is per-market, reported by the worker) and those actually populated from real data vs defaulting to league-average imputation.

## Instructions

### Step 1 — Hit the worker

```bash
curl -s https://diamond-edge-worker.fly.dev/health | python -m json.tool
```

Report `live_feature_count`, `feature_count_total`, `models_loaded`.

### Step 2 — Identify feature categories from DB presence

```sql
SELECT
  'pitcher_season_stats' AS feature_source,
  COUNT(*)::int AS rows_live
FROM pitcher_season_stats
WHERE season = EXTRACT(YEAR FROM NOW())::int

UNION ALL SELECT 'bullpen_team_stats', COUNT(*)::int FROM bullpen_team_stats WHERE season = EXTRACT(YEAR FROM NOW())::int
UNION ALL SELECT 'team_batting_stats', COUNT(*)::int FROM team_batting_stats WHERE season = EXTRACT(YEAR FROM NOW())::int
UNION ALL SELECT 'umpire_assignments (today)', COUNT(*)::int FROM umpire_assignments ua JOIN games g ON g.id = ua.game_id WHERE g.game_date = CURRENT_DATE
UNION ALL SELECT 'lineup_entries (today)', COUNT(*)::int FROM lineup_entries le JOIN games g ON g.id = le.game_id WHERE g.game_date = CURRENT_DATE
UNION ALL SELECT 'odds (today morning)', COUNT(*)::int FROM odds o JOIN games g ON g.id = o.game_id WHERE g.game_date = CURRENT_DATE
UNION ALL SELECT 'news_signals (T-6h)', COUNT(*)::int FROM news_signals WHERE created_at >= NOW() - interval '6 hours';
```

### Step 3 — Cross-reference with features.py

Read `worker/app/features.py` and count:
- Features that read from the DB tables above ("live")
- Features that return 0.0 / league-average ("imputed")

The ML engineer's return reports showed the mapping:

| Category | Features | Source | Status |
|---|---|---|---|
| Market/odds | 5 | `odds` table | live if rows > 0 |
| Park factors | 6 | static code | always live |
| Weather | 4 | `games.weather_*` | live |
| Pitcher season | 24 | `pitcher_season_stats` | live if rows > 0 |
| Team batting | 14 | `team_batting_stats` | live if rows > 0 |
| Bullpen | 10 | `bullpen_team_stats` | live if rows > 0 |
| Umpire | 3 | `umpire_assignments` | live if today's ump assigned |
| Platoon/lineup | 3 | `lineup_entries` | live if lineups confirmed |
| News signals | 6 | `news_signals` | live if extracted |
| Travel/TZ | 2 | static + teams | always live |
| Team records | 12 | historical games | always live |
| H2H | 1 | historical games | always live |
| EWMA runs | 2 | historical games | always live |
| SP handedness | 4 | `players.throws` | live |
| **Total** | **96** (some overlap) | | |

Note: worker reports the active-model declared feature count (post zero-variance drop — see `drop_zero_variance_features` in `worker/models/pipelines/train_b2_delta.py`); exact superset map lives in `worker/app/features.py`.

## Output format

```
Feature gap audit — {timestamp}

Worker health:
  Live feature count: N/<declared> ({pct}%)
  Models loaded: {list}

By category:
┌────────────────────┬───────────┬─────────────────┐
│ Category           │ Status    │ Notes           │
├────────────────────┼───────────┼─────────────────┤
│ Market/odds        │ ✅ live   │ 96 odds rows    │
│ Pitcher season     │ ⚠️ partial│ 14/30 (rookies) │
│ Bullpen            │ ✅ live   │ 30 teams        │
│ Umpire             │ ❌ empty  │ not assigned    │
│ ...                │           │                 │
└────────────────────┴───────────┴─────────────────┘

Top gaps by ROI impact:
  1. Umpire data — stats-sync may need manual trigger if T-90min hasn't hit yet
  2. News signals — pg_cron bluesky-poll should be firing every 5 min; check cron.job_run_details
  3. Statcast (barrel, swstr, avg_ev) — depends on Savant scrape; brittle
```

## Constraints

- Don't propose fixes — just audit. Fix decisions are Kyle's call.
- If ALL categories show 0 rows, suggest running `/daily-digest` first — may be before 10 AM ET cron has fired.
