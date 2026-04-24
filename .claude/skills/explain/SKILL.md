---
name: explain
description: "Game-level, multi-market model breakdown PRE-GAME. Plain-English writeup of why the model likes / dislikes a MLB game — all features, both sides, all three markets (ML / RL / totals). Goes deeper than the LLM rationale. Distinct from /investigate-pick (ONE pick by UUID, post-generation) and /pick-debug (systematic issues). Invoked as /explain <game_id>."
---

# Explain

Narrative breakdown of how the model sees a game — not just the pick, but ALL three market signals + feature contributions + what the prior says + what we'd bet differently. More comprehensive than the Haiku-generated per-pick rationale.

## Instructions

Kyle invokes with a `game_id` (full UUID or prefix) OR a team abbreviation that can uniquely match a game today.

### Step 1 — Resolve the game

If Kyle passes a UUID prefix, match via `LIKE`. If a team abbr like "NYY" or matchup like "NYY@BOS", match on today's games first.

### Step 2 — Pull everything for the game

Write a one-off node script that joins: `games`, `teams`, `players` (probable pitchers), `odds` (all 3 snapshots), `news_signals`, `market_priors`, + calls the Fly worker's `/predict` endpoint for a fresh prediction.

### Step 3 — Call /predict manually

Get the full feature vector + SHAP for all three markets in one call.

```bash
source /c/Projects/Baseball_Edge/.env
curl -s -X POST https://diamond-edge-worker.fly.dev/predict \
  -H "Authorization: Bearer $WORKER_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"game_id\": \"<uuid>\", \"markets\": [\"moneyline\", \"run_line\", \"total\"]}"
```

### Step 4 — Write the narrative

Structure:

```
## <Away team> @ <Home team> — <date> <time ET>
<venue>, weather: <condition, temp, wind>

### Starting pitchers
<Home SP>: <season stats: ERA, FIP, K/9, BB/9, HR/9>
<Away SP>: <same>
Advantage: <which pitcher the data prefers, and why>

### Market's view (no-vig)
Moneyline: home <prior%> / away <prior%>
Run line:  home <prior%>
Total:     over <prior%>

### Model's view
Moneyline: home <final%> (delta <delta>), EV <ev%>
  Top features: <top-3 SHAP with plain-English expansion>
Run line: <same>
Total: <same>

### Late-breaking news (from news_signals, T-6h window)
<list any late scratches, lineup changes, injury updates, weather notes>

### Bottom line
Our pick: <market> <side> at <price> for <EV>% EV (Tier <tier>, <visibility>).

Why: <2-3 sentences of actual analysis synthesizing the above>

Fade case: <1-2 sentences on what could go wrong — honest counterargument>
```

### Step 5 — Cite the features verbatim

Use the feature names from SHAP but expand the abbreviations inline (same rules as the rationale prompt: ERA → earned-run average, FIP → fielding-independent pitching, etc.).

## Output format

The narrative from Step 4. Target 200–350 words total.

## Constraints

- Don't invent features. Only cite what `/predict` returns.
- If the game has no odds, stop and say "odds not populated yet — run /daily-digest or wait for the 10 AM ET schedule-sync cron"
- If all three markets have near-zero EV, lead with "no edge found here — the market's priced this efficiently"
- Tone: sharp bettor talking to themselves, not ESPN pregame analyst
