# Diamond Edge — API Contracts v1

**Status:** Draft for implementation
**Date:** 2026-04-22
**Author:** mlb-architect
**Implements:** Next.js API routes in `apps/web/app/api/`

---

## Conventions

### Error Envelope (all error responses)
```typescript
{
  error: {
    code: string;        // machine-readable: 'UNAUTHORIZED', 'NOT_FOUND', 'RATE_LIMITED', etc.
    message: string;     // human-readable
    details?: unknown;   // optional structured detail
  }
}
```

### Auth
- Routes marked **Auth: required** expect a Supabase session JWT in the `Authorization: Bearer <token>` header.
- Routes marked **Auth: optional** serve degraded content to unauthenticated users (free-tier picks only).
- Service-role-only routes (cron, webhooks) are authenticated by a `CRON_SECRET` or Stripe signature — not user JWTs.

### Tier Gating
API routes enforce tier gating in application code. The `picks` RLS policy controls row visibility; column masking (hiding EV, model probability, rationale for lower tiers) is in the route handler.

| Field | Free | Pro | Elite |
|---|---|---|---|
| Pick side + confidence tier | yes | yes | yes |
| Best line + book | no | yes | yes |
| Model probability | no | yes | yes |
| Expected value | no | no | yes |
| Full AI rationale | no | yes (Haiku) | yes (Sonnet) |
| SHAP attribution | no | no | yes |

### Caching
Redis key patterns and TTLs are specified per route. See `docs/schema/caching-strategy.md` for full cache policy.

---

## Routes

---

### `GET /api/picks/today`

Today's pick slate. Tier-gated.

**Auth:** Optional (anon gets free-tier picks only)

**Query params:**
```
market?: 'moneyline' | 'run_line' | 'total' | 'prop' | 'parlay' | 'future'
min_confidence?: 1 | 2 | 3 | 4 | 5
date?: string  // ISO 8601, defaults to today in ET
```

**Response 200:**
```typescript
{
  date: string;           // 'YYYY-MM-DD'
  picks: Array<{
    id: string;           // uuid
    game: {
      id: string;
      home_team: { id: string; name: string; abbreviation: string };
      away_team: { id: string; name: string; abbreviation: string };
      game_time_utc: string;
      status: 'scheduled' | 'live' | 'final' | 'postponed';
    };
    market: string;
    pick_side: string;
    confidence_tier: number;        // 1–5, always visible
    required_tier: string;
    // Tier-gated — omitted if caller not entitled:
    best_line_price?: number;       // pro+
    best_line_book?: string;        // pro+
    model_probability?: number;     // pro+
    expected_value?: number;        // elite only
    rationale_preview?: string;     // pro+: first 2 sentences
    result: 'pending' | 'win' | 'loss' | 'push' | 'void';
  }>;
  total: number;
  user_tier: 'anon' | 'free' | 'pro' | 'elite';
}
```

**Cache:** Redis key `picks:today:{date}:{tier}`, TTL 15 min. Invalidated when pick pipeline writes new picks.

---

### `GET /api/picks/[id]`

Full pick detail. Tier-gated.

**Auth:** Optional

**Path params:** `id` — pick uuid

**Response 200:**
```typescript
{
  pick: {
    id: string;
    game: {
      id: string;
      home_team: { id: string; name: string; abbreviation: string; };
      away_team: { id: string; name: string; abbreviation: string; };
      game_time_utc: string;
      status: string;
      probable_home_pitcher: { id: string; full_name: string } | null;
      probable_away_pitcher: { id: string; full_name: string } | null;
      weather: { condition: string; temp_f: number; wind_mph: number; wind_dir: string } | null;
    };
    market: string;
    pick_side: string;
    confidence_tier: number;
    required_tier: string;
    result: string;
    generated_at: string;
    // Tier-gated:
    best_line_price?: number;
    best_line_book?: string;
    model_probability?: number;
    expected_value?: number;
    rationale?: string;          // pro+: full rationale text
    shap_attributions?: Array<{  // elite only
      feature: string;
      value: number;
      direction: 'positive' | 'negative';
    }>;
  };
}
```

**Cache:** Redis key `pick:{id}:{tier}`, TTL 30 min.

---

### `GET /api/games/[id]`

Game detail with current odds from all active books.

**Auth:** Optional

**Path params:** `id` — game uuid

**Response 200:**
```typescript
{
  game: {
    id: string;
    mlb_game_id: number;
    game_date: string;
    game_time_utc: string;
    status: string;
    home_team: { id: string; name: string; abbreviation: string; };
    away_team: { id: string; name: string; abbreviation: string; };
    home_score: number | null;
    away_score: number | null;
    inning: number | null;
    venue_name: string | null;
    weather: { condition: string; temp_f: number; wind_mph: number; wind_dir: string } | null;
    probable_home_pitcher: { id: string; full_name: string; } | null;
    probable_away_pitcher: { id: string; full_name: string; } | null;
    odds: Array<{           // latest snapshot per book per market
      sportsbook: string;   // 'DraftKings', 'FanDuel'
      market: string;
      home_price: number | null;
      away_price: number | null;
      total_line: number | null;
      over_price: number | null;
      under_price: number | null;
      run_line_spread: number | null;
      snapshotted_at: string;
    }>;
    picks: Array<{          // picks for this game (tier-gated same as /picks/today)
      id: string;
      market: string;
      pick_side: string;
      confidence_tier: number;
    }>;
  };
}
```

**Cache:** Redis key `game:{id}`, TTL 5 min (odds change; shorter TTL acceptable since odds have own cache).

---

### `GET /api/odds/[game_id]`

Current best odds across all active books for a game, all markets. Line-shopping view.

**Auth:** Optional

**Path params:** `game_id` — game uuid

**Response 200:**
```typescript
{
  game_id: string;
  markets: Array<{
    market: string;
    lines: Array<{
      sportsbook: string;
      home_price: number | null;
      away_price: number | null;
      total_line: number | null;
      over_price: number | null;
      under_price: number | null;
      run_line_spread: number | null;
      snapshotted_at: string;
    }>;
    best_home_price: number | null;    // best available moneyline for home team
    best_away_price: number | null;
    best_over_price: number | null;
    best_under_price: number | null;
  }>;
  last_updated: string;
}
```

**Cache:** Redis key `odds:game:{game_id}`, TTL 10 min.

---

### `GET /api/stats/team/[id]`

Team stats for the current season. ML agent defines which stats to include.

**Auth:** Optional

**Path params:** `id` — team uuid

**Query params:**
```
season?: number  // default: current season
split?: 'home' | 'away' | 'overall'  // default: 'overall'
```

**Response 200:**
```typescript
{
  team: { id: string; name: string; abbreviation: string; };
  season: number;
  split: string;
  stats: {
    wins: number;
    losses: number;
    win_pct: number;
    runs_per_game: number;
    runs_allowed_per_game: number;
    team_era: number;
    team_whip: number;
    team_ops: number;
    team_batting_avg: number;
    last_10: string;     // e.g., '7-3'
    run_line_record: string;  // e.g., '42-38'
    over_under_record: string;
  };
  last_updated: string;
}
```

**Cache:** Redis key `stats:team:{id}:{season}:{split}`, TTL 3 hours.

---

### `GET /api/stats/player/[id]`

Player stats (batting or pitching based on position).

**Auth:** Optional

**Path params:** `id` — player uuid

**Query params:**
```
season?: number
split?: 'home' | 'away' | 'vs_left' | 'vs_right' | 'overall'
```

**Response 200:**
```typescript
{
  player: {
    id: string;
    full_name: string;
    position: string;
    team: { id: string; name: string; abbreviation: string };
  };
  season: number;
  split: string;
  // Batting stats (position players + DH)
  batting?: {
    games: number;
    avg: number;
    obp: number;
    slg: number;
    ops: number;
    home_runs: number;
    rbi: number;
    strikeout_rate: number;
    walk_rate: number;
    wrc_plus: number;
    babip: number;
  };
  // Pitching stats (SP + RP)
  pitching?: {
    games: number;
    games_started: number;
    innings_pitched: number;
    era: number;
    whip: number;
    fip: number;
    k_per_9: number;
    bb_per_9: number;
    hr_per_9: number;
    left_on_base_pct: number;
    xfip: number;   // if available from Statcast
  };
  last_updated: string;
}
```

**Cache:** Redis key `stats:player:{id}:{season}:{split}`, TTL 3 hours.

---

### `GET /api/bankroll`

Authenticated user's bankroll history and ROI summary.

**Auth:** Required

**Query params:**
```
from?: string   // ISO date, default: 30 days ago
to?: string     // ISO date, default: today
```

**Response 200:**
```typescript
{
  summary: {
    total_wagered_cents: number;
    total_profit_loss_cents: number;
    roi_pct: number;
    win_count: number;
    loss_count: number;
    push_count: number;
    void_count: number;
    pending_count: number;
    win_rate: number;
  };
  entries: Array<{
    id: string;
    bet_date: string;
    description: string;
    market: string | null;
    sportsbook: string | null;
    bet_amount_cents: number;
    odds_price: number;
    outcome: string | null;
    profit_loss_cents: number | null;
    settled_at: string | null;
    pick_id: string | null;   // if linked to a Diamond Edge pick
    notes: string | null;
  }>;
}
```

**Cache:** No caching (user-specific, fast Postgres query with RLS).

---

### `POST /api/bankroll/entry`

Log a bet in the user's bankroll tracker.

**Auth:** Required

**Request body:**
```typescript
{
  bet_date: string;           // ISO date
  description?: string;
  market?: string;
  sportsbook_id?: string;     // uuid
  bet_amount_cents: number;   // positive integer
  odds_price: number;         // American odds
  pick_id?: string;           // uuid — optional link to Diamond Edge pick
  game_id?: string;           // uuid
  notes?: string;
}
```

**Response 201:**
```typescript
{
  entry: {
    id: string;
    // ... all entry fields
  };
}
```

**Validation errors → 422** with error envelope listing field-level failures.

---

### `PUT /api/bankroll/entry/[id]`

Settle or update a bankroll entry.

**Auth:** Required

**Path params:** `id` — bankroll entry uuid

**Request body:**
```typescript
{
  outcome?: 'win' | 'loss' | 'push' | 'void';
  profit_loss_cents?: number;
  settled_at?: string;
  notes?: string;
}
```

**Response 200:** Updated entry object (same shape as POST response).

---

### `DELETE /api/bankroll/entry/[id]`

Soft-delete a bankroll entry.

**Auth:** Required

**Response 204:** No body.

---

### `GET /api/history`

Public pick performance history. Paginated.

**Auth:** Optional

**Query params:**
```
market?: string
from?: string    // ISO date
to?: string
page?: number    // default: 1
per_page?: number  // default: 50, max: 100
```

**Response 200:**
```typescript
{
  stats: {
    total_picks: number;
    wins: number;
    losses: number;
    pushes: number;
    win_rate: number;
    roi_pct: number;    // assumes flat $100 bets at best available line
    by_market: Record<string, { picks: number; wins: number; win_rate: number; roi_pct: number }>;
    by_confidence: Record<string, { picks: number; wins: number; win_rate: number }>;
  };
  picks: Array<{
    id: string;
    pick_date: string;
    game: { home_team: string; away_team: string; };
    market: string;
    pick_side: string;
    confidence_tier: number;
    result: string;
    best_line_price: number | null;
  }>;
  pagination: { page: number; per_page: number; total: number; total_pages: number; };
}
```

**Cache:** Redis key `history:{market}:{from}:{to}:{page}`, TTL 60 min. Invalidated when outcomes are graded.

---

### `POST /api/auth/age-verify`

Record user's age gate completion.

**Auth:** Required

**Request body:**
```typescript
{
  date_of_birth: string;   // 'YYYY-MM-DD'
  method: 'dob_entry';
}
```

**Validation:** Server computes age from DOB. Rejects if age < 21. Does not return error detail distinguishing "DOB format invalid" vs "age < 21" — both return the same 403 to prevent inference.

**Response 200:**
```typescript
{
  verified: true;
  age_verified_at: string;
}
```

**Response 403:**
```typescript
{
  error: { code: 'AGE_GATE_FAILED'; message: 'Age verification failed.' }
}
```

---

### `POST /api/webhooks/stripe`

Stripe webhook handler. Stripe signature verified via `stripe.webhooks.constructEvent`.

**Auth:** Stripe-Signature header (not user JWT)

**Handled events:**
- `customer.subscription.created` → upsert `subscriptions`, update `profiles.subscription_tier`
- `customer.subscription.updated` → same
- `customer.subscription.deleted` → mark canceled, downgrade to `free`
- `invoice.payment_failed` → log, do not immediately downgrade (Stripe handles retry)

**Response 200:** `{ received: true }` — always return 200 to Stripe promptly; process async.

---

### Internal / Cron Routes

Not user-facing. Protected by `CRON_SECRET` header verified in middleware.

| Route | Method | Trigger | Purpose |
|---|---|---|---|
| `/api/cron/odds-refresh` | POST | Vercel Cron | Pull latest odds from The Odds API → upsert `odds` |
| `/api/cron/schedule-sync` | POST | Vercel Cron | Sync today+tomorrow schedule from MLB Stats API |
| `/api/cron/pick-pipeline` | POST | Vercel Cron | Trigger pick generation (calls Supabase Edge Function or Fly.io worker) |
| `/api/cron/outcome-grader` | POST | Vercel Cron | Grade completed game outcomes → update `pick_outcomes` and `picks.result` |

---

## Open Questions for Orchestrator

1. **Parlay route:** No `/api/picks/parlay` route is defined. Parlay picks would be a separate pick type; see schema open question #4. Recommend deferring.
2. **Live game odds refresh frequency:** The 10-min TTL on odds assumes pre-game line shopping, not live in-game odds. If live in-game updates are desired, TTL drops to ~1 min and The Odds API request budget must be recalculated. Recommendation: pre-game only for v1.
3. **Player stats source:** Returning `xfip` and `wrc_plus` requires Statcast/FanGraphs data, not just MLB Stats API. ML engineer should confirm which advanced stats are in scope and which routes need them.
