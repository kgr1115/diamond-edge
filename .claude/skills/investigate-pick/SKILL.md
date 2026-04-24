---
name: investigate-pick
description: "Deep-dive on ONE pick by UUID — game, odds, SHAP attributions, rationale text, CLV (if graded), outcome, PnL. Pick-level focus; strongest post-game when outcome + CLV are set. Distinct from /explain (multi-market game-level view, pre-game) and /pick-debug (systematic pick-quality issues). Invoked as /investigate-pick <pick_id>."
---

# Investigate Pick

Full diagnostic for a single pick UUID. Useful for post-hoc analysis — "why did the model like this?" or "what happened with that $50 bet?"

## Instructions

The pick ID comes from Kyle's invocation. If it's a short prefix (first 8 chars), match with `LIKE 'prefix%'` in SQL.

### Step 1 — Pull everything

Single join query against the DB. Create a temporary verification script or inline:

```sql
SELECT
  p.id,
  p.market,
  p.pick_side,
  p.confidence_tier,
  p.model_probability,
  p.expected_value,
  p.best_line_price,
  p.visibility,
  p.result,
  p.feature_attributions,  -- jsonb SHAP top-7
  p.user_note,
  p.user_tags,
  p.created_at,
  -- Game
  g.game_date,
  g.game_time_utc,
  g.status AS game_status,
  g.home_score,
  g.away_score,
  g.venue_name,
  ht.abbreviation AS home_abbr,
  at.abbreviation AS away_abbr,
  -- Best-line book
  sb.name AS book_name,
  -- Outcome (if graded)
  o.result AS outcome_result,
  o.pnl_units,
  o.graded_at,
  -- CLV (if computed)
  clv.pick_time_novig_prob,
  clv.closing_novig_prob,
  clv.clv_edge,
  -- Rationale (if generated — Pro/Elite only)
  rc.rationale_text,
  rc.haiku_tokens_used
FROM picks p
JOIN games g ON g.id = p.game_id
LEFT JOIN teams ht ON ht.id = g.home_team_id
LEFT JOIN teams at ON at.id = g.away_team_id
LEFT JOIN sportsbooks sb ON sb.id = p.best_line_book_id
LEFT JOIN pick_outcomes o ON o.pick_id = p.id
LEFT JOIN pick_clv clv ON clv.pick_id = p.id
LEFT JOIN rationale_cache rc ON rc.id = p.rationale_id
WHERE p.id = '<pick_uuid>'
   OR p.id::text LIKE '<prefix>%';
```

### Step 2 — Format as a narrative

Transform the row into a human-readable block:

```
Pick <short-id>: <away> @ <home>, <date> <time ET>
  Market: <market>, Side: <pick_side>
  Best line: <price> @ <book>
  Model: <prob%> (EV +<ev%>), Tier <tier>, Visibility: <visibility>

  Top features (SHAP):
    1. <feature_name>: <value> (+<shap>)
    2. ...
    3. ...

  Rationale (<tokens> tokens):
    <rationale text or "not generated (shadow pick)" or "not available">

  Game outcome: <home_score>-<away_score> ({game_status})
    Result: <W/L/P/V> (+<units>u)

  CLV edge: <clv%> (positive = market moved toward us)

  Kyle's note: <user_note or "—">
  Tags: <user_tags joined or "—">
```

## Output format

The formatted narrative above. Include a 1-line verdict at the bottom based on outcome + CLV:

- If result=W and CLV>0.5%: "Good pick, sharp edge confirmed."
- If result=W and CLV<=0: "Won against the close — lucky, not sharp."
- If result=L and CLV>0.5%: "Lost but line moved with us — variance."
- If result=L and CLV<=0: "No edge, no luck — fine to skip this type next time."
- If result=pending: "Game not graded yet."

## Constraints

- If pick not found, report "pick not found" and suggest `node scripts/run-migrations/get-pick-ids.mjs` to list recent IDs
- Rationale may be null for shadow picks — expected, don't flag as error
- CLV is null until ~30 min after game start — expected for recent picks
