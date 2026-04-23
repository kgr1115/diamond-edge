# Diamond Edge — Postgres Schema Spec v1

**Status:** Draft for implementation
**Date:** 2026-04-22
**Author:** mlb-architect
**Implements:** Backend agent writes migrations from this spec (`supabase/migrations/`)

---

## Design Principles

- Every user-facing table has RLS. No exceptions.
- `id` columns are `uuid` with `gen_random_uuid()` default unless otherwise noted.
- All timestamps are `timestamptz` (UTC). No `timestamp without time zone`.
- Soft-delete (`deleted_at`) on user-generated data (bankroll entries). Hard-delete elsewhere.
- Sportsbook identity is a foreign key to a `sportsbooks` lookup table — adding a 3rd book is an INSERT, not a schema change.
- Subscription tier is a typed enum. Adding a tier is an ALTER TYPE — flag to orchestrator when that happens.
- `picks` and `odds` are append-only for auditability. Updates only allowed on `pick_outcomes`.

---

## Enums

```sql
CREATE TYPE subscription_tier AS ENUM ('free', 'pro', 'elite');
CREATE TYPE game_status AS ENUM ('scheduled', 'live', 'final', 'postponed', 'cancelled');
CREATE TYPE market_type AS ENUM ('moneyline', 'run_line', 'total', 'prop', 'parlay', 'future');
CREATE TYPE pick_result AS ENUM ('win', 'loss', 'push', 'void', 'pending');
CREATE TYPE bet_outcome AS ENUM ('win', 'loss', 'push', 'void');
```

---

## Tables

### `profiles`
Extends Supabase Auth `auth.users`. One row per authenticated user.

```sql
CREATE TABLE profiles (
  id                  uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email               text NOT NULL,
  subscription_tier   subscription_tier NOT NULL DEFAULT 'free',
  age_verified        boolean NOT NULL DEFAULT false,
  age_verified_at     timestamptz,
  date_of_birth       date,              -- stored for age verification audit; nullable until verified
  geo_state           char(2),           -- ISO 3166-2 US state code, e.g. 'NY'. NULL = not determined
  geo_blocked         boolean NOT NULL DEFAULT false,
  stripe_customer_id  text UNIQUE,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_profiles_stripe_customer_id ON profiles(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
CREATE INDEX idx_profiles_subscription_tier ON profiles(subscription_tier);

-- RLS
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
-- Users can read and update only their own profile
CREATE POLICY "profiles_select_own" ON profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "profiles_update_own" ON profiles FOR UPDATE USING (auth.uid() = id);
-- Insert is handled by the auth trigger (service role)
-- Service role bypass via supabase service_role key for backend jobs
```

---

### `sportsbooks`
Lookup table. DK + FD in v1. Adding a book = one INSERT.

```sql
CREATE TABLE sportsbooks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL UNIQUE,   -- 'draftkings', 'fanduel' — matches The Odds API book key
  name        text NOT NULL,          -- 'DraftKings', 'FanDuel'
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Seed data (backend agent inserts in migration)
-- INSERT INTO sportsbooks (key, name) VALUES ('draftkings', 'DraftKings'), ('fanduel', 'FanDuel');

-- RLS
ALTER TABLE sportsbooks ENABLE ROW LEVEL SECURITY;
-- Public read; no user writes
CREATE POLICY "sportsbooks_select_public" ON sportsbooks FOR SELECT USING (true);
```

---

### `teams`
MLB teams. Static reference data, refreshed at season start.

```sql
CREATE TABLE teams (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mlb_team_id     integer NOT NULL UNIQUE,  -- MLB Stats API team ID
  name            text NOT NULL,
  abbreviation    char(3) NOT NULL,
  city            text NOT NULL,
  division        text NOT NULL,   -- 'AL East', 'NL West', etc.
  league          char(2) NOT NULL CHECK (league IN ('AL', 'NL')),
  venue_name      text,
  venue_city      text,
  venue_state     char(2),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_teams_mlb_team_id ON teams(mlb_team_id);
CREATE INDEX idx_teams_abbreviation ON teams(abbreviation);

-- RLS
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
CREATE POLICY "teams_select_public" ON teams FOR SELECT USING (true);
```

---

### `players`
MLB players. Refreshed from MLB Stats API rosters.

```sql
CREATE TABLE players (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mlb_player_id   integer NOT NULL UNIQUE,  -- MLB Stats API player ID
  full_name       text NOT NULL,
  position        text,            -- 'SP', 'RP', 'C', '1B', etc.
  bats            char(1) CHECK (bats IN ('L', 'R', 'S')),
  throws          char(1) CHECK (throws IN ('L', 'R')),
  team_id         uuid REFERENCES teams(id),
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_players_mlb_player_id ON players(mlb_player_id);
CREATE INDEX idx_players_team_id ON players(team_id);

-- RLS
ALTER TABLE players ENABLE ROW LEVEL SECURITY;
CREATE POLICY "players_select_public" ON players FOR SELECT USING (true);
```

---

### `games`
One row per MLB game. Upserted by the ingestion job from MLB Stats API.

```sql
CREATE TABLE games (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mlb_game_id         integer NOT NULL UNIQUE,
  game_date           date NOT NULL,
  game_time_utc       timestamptz,
  status              game_status NOT NULL DEFAULT 'scheduled',
  home_team_id        uuid NOT NULL REFERENCES teams(id),
  away_team_id        uuid NOT NULL REFERENCES teams(id),
  home_score          smallint,
  away_score          smallint,
  inning              smallint,
  venue_name          text,
  venue_state         char(2),
  weather_condition   text,         -- 'clear', 'cloudy', 'rain', etc.
  weather_temp_f      smallint,
  weather_wind_mph    smallint,
  weather_wind_dir    text,
  probable_home_pitcher_id  uuid REFERENCES players(id),
  probable_away_pitcher_id  uuid REFERENCES players(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_games_game_date ON games(game_date);
CREATE INDEX idx_games_mlb_game_id ON games(mlb_game_id);
CREATE INDEX idx_games_status ON games(status);
CREATE INDEX idx_games_home_team_id ON games(home_team_id);
CREATE INDEX idx_games_away_team_id ON games(away_team_id);

-- RLS
ALTER TABLE games ENABLE ROW LEVEL SECURITY;
CREATE POLICY "games_select_public" ON games FOR SELECT USING (true);
```

---

### `odds`
Append-only snapshots of sportsbook odds. One row per game + market + book + snapshot time.

```sql
CREATE TABLE odds (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id         uuid NOT NULL REFERENCES games(id),
  sportsbook_id   uuid NOT NULL REFERENCES sportsbooks(id),
  market          market_type NOT NULL,
  -- For moneyline / run line: home_price and away_price in American odds (e.g., -110, +105)
  home_price      integer,
  away_price      integer,
  -- For totals: line (e.g., 8.5) and over/under prices
  total_line      numeric(4,1),
  over_price      integer,
  under_price     integer,
  -- For props: description + price
  prop_description text,
  prop_line        numeric(6,2),
  prop_over_price  integer,
  prop_under_price integer,
  -- Run line spread (almost always ±1.5 in MLB)
  run_line_spread  numeric(3,1),
  -- Snapshot metadata
  snapshotted_at  timestamptz NOT NULL DEFAULT now(),
  -- Allow querying latest odds per game+book+market efficiently
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_odds_game_id ON odds(game_id);
CREATE INDEX idx_odds_game_book_market ON odds(game_id, sportsbook_id, market, snapshotted_at DESC);
CREATE INDEX idx_odds_snapshotted_at ON odds(snapshotted_at DESC);

-- RLS
ALTER TABLE odds ENABLE ROW LEVEL SECURITY;
CREATE POLICY "odds_select_public" ON odds FOR SELECT USING (true);
-- No user writes; service role only via ingestion job
```

---

### `picks`
One row per generated pick. Append-only. Tier gates which fields are returned by the API.

```sql
CREATE TABLE picks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id             uuid NOT NULL REFERENCES games(id),
  pick_date           date NOT NULL,
  market              market_type NOT NULL,
  -- The pick itself
  pick_side           text NOT NULL,   -- 'home', 'away', 'over', 'under', or prop description
  -- Model outputs
  model_probability   numeric(5,4) NOT NULL,   -- 0.0000–1.0000
  implied_probability numeric(5,4),            -- derived from the best available line
  expected_value      numeric(6,4),            -- (model_prob * payout) - (1 - model_prob)
  confidence_tier     smallint NOT NULL CHECK (confidence_tier BETWEEN 1 AND 5),  -- 1=low, 5=high
  -- Best line at time of pick generation
  best_line_price     integer,        -- American odds
  best_line_book_id   uuid REFERENCES sportsbooks(id),
  -- LLM rationale
  rationale_id        uuid REFERENCES rationale_cache(id),
  -- Required tier to see full pick detail
  required_tier       subscription_tier NOT NULL DEFAULT 'free',
  -- Lifecycle
  result              pick_result NOT NULL DEFAULT 'pending',
  generated_at        timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_picks_pick_date ON picks(pick_date DESC);
CREATE INDEX idx_picks_game_id ON picks(game_id);
CREATE INDEX idx_picks_market ON picks(market);
CREATE INDEX idx_picks_confidence_tier ON picks(confidence_tier DESC);
CREATE INDEX idx_picks_result ON picks(result);

-- RLS
ALTER TABLE picks ENABLE ROW LEVEL SECURITY;
-- All authenticated users can read picks (tier-gating is enforced at the API layer, not RLS)
CREATE POLICY "picks_select_authenticated" ON picks FOR SELECT TO authenticated USING (true);
-- Anon users can see picks with required_tier = 'free' only
CREATE POLICY "picks_select_anon_free" ON picks FOR SELECT TO anon USING (required_tier = 'free');
-- No user writes; service role only
```

**Note:** Tier-gating (hiding EV, model probability, rationale for non-entitled tiers) is enforced in the API route handler, not via RLS. RLS controls row visibility; column masking is handled in application code.

---

### `rationale_cache`
Stores LLM-generated rationale text. Referenced by `picks`. Cached to avoid regenerating.

```sql
CREATE TABLE rationale_cache (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pick_id         uuid,    -- set after pick is created; nullable to allow pre-generation
  model_used      text NOT NULL,   -- 'claude-haiku-4-5', 'claude-sonnet-4-6'
  prompt_hash     text NOT NULL,   -- SHA-256 of the prompt, for dedup
  rationale_text  text NOT NULL,
  tokens_used     integer,
  cost_usd        numeric(8,6),
  generated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE(prompt_hash)
);

CREATE INDEX idx_rationale_cache_pick_id ON rationale_cache(pick_id);
CREATE INDEX idx_rationale_cache_prompt_hash ON rationale_cache(prompt_hash);

-- RLS
ALTER TABLE rationale_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "rationale_select_authenticated" ON rationale_cache FOR SELECT TO authenticated USING (true);
-- No user writes
```

---

### `pick_outcomes`
Populated by the outcome-grader job after games complete. One row per pick.

```sql
CREATE TABLE pick_outcomes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pick_id         uuid NOT NULL UNIQUE REFERENCES picks(id),
  game_id         uuid NOT NULL REFERENCES games(id),
  result          pick_result NOT NULL,
  home_score      smallint NOT NULL,
  away_score      smallint NOT NULL,
  graded_at       timestamptz NOT NULL DEFAULT now(),
  notes           text   -- e.g., 'postponed', 'push due to line movement'
);

CREATE INDEX idx_pick_outcomes_pick_id ON pick_outcomes(pick_id);
CREATE INDEX idx_pick_outcomes_game_id ON pick_outcomes(game_id);
CREATE INDEX idx_pick_outcomes_result ON pick_outcomes(result);
CREATE INDEX idx_pick_outcomes_graded_at ON pick_outcomes(graded_at DESC);

-- RLS
ALTER TABLE pick_outcomes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pick_outcomes_select_public" ON pick_outcomes FOR SELECT USING (true);
```

---

### `subscriptions`
Mirrors Stripe subscription state. Updated by Stripe webhook.

```sql
CREATE TABLE subscriptions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
  stripe_sub_id       text NOT NULL UNIQUE,
  stripe_price_id     text NOT NULL,
  tier                subscription_tier NOT NULL,
  status              text NOT NULL,   -- Stripe statuses: 'active', 'past_due', 'canceled', 'trialing'
  current_period_start timestamptz NOT NULL,
  current_period_end  timestamptz NOT NULL,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  canceled_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX idx_subscriptions_stripe_sub_id ON subscriptions(stripe_sub_id);
CREATE INDEX idx_subscriptions_status ON subscriptions(status);

-- RLS
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "subscriptions_select_own" ON subscriptions FOR SELECT USING (auth.uid() = user_id);
-- No user writes; Stripe webhook via service role only
```

---

### `bankroll_entries`
User-defined bet tracking. Soft-delete.

```sql
CREATE TABLE bankroll_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  pick_id         uuid REFERENCES picks(id),   -- optional: link to a Diamond Edge pick
  game_id         uuid REFERENCES games(id),   -- optional
  bet_date        date NOT NULL,
  market          market_type,
  description     text,            -- free-text: 'NYY ML', 'Over 8.5 BOS/NYY'
  sportsbook_id   uuid REFERENCES sportsbooks(id),
  bet_amount_cents integer NOT NULL CHECK (bet_amount_cents > 0),
  odds_price      integer NOT NULL,  -- American odds at bet placement
  outcome         bet_outcome,       -- NULL until settled
  profit_loss_cents integer,         -- positive = profit, negative = loss
  settled_at      timestamptz,
  notes           text,
  deleted_at      timestamptz,       -- soft delete
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_bankroll_entries_user_id ON bankroll_entries(user_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_bankroll_entries_bet_date ON bankroll_entries(bet_date DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_bankroll_entries_pick_id ON bankroll_entries(pick_id) WHERE pick_id IS NOT NULL;

-- RLS
ALTER TABLE bankroll_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "bankroll_select_own" ON bankroll_entries FOR SELECT USING (auth.uid() = user_id AND deleted_at IS NULL);
CREATE POLICY "bankroll_insert_own" ON bankroll_entries FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "bankroll_update_own" ON bankroll_entries FOR UPDATE USING (auth.uid() = user_id);
-- No hard delete via RLS; soft delete only
```

---

### `geo_blocked_states`
Static list of blocked state codes. DB-driven so it can be updated without a deploy.

```sql
CREATE TABLE geo_blocked_states (
  state_code  char(2) PRIMARY KEY,   -- 'CA', 'TX', etc.
  reason      text,                   -- 'DK or FD not operational'
  blocked_at  timestamptz NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE geo_blocked_states ENABLE ROW LEVEL SECURITY;
CREATE POLICY "geo_blocked_states_select_public" ON geo_blocked_states FOR SELECT USING (true);
-- Inserts/updates via service role only (compliance agent updates the list)
```

---

### `age_gate_logs`
Audit log for age verification attempts. Append-only.

```sql
CREATE TABLE age_gate_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES profiles(id),
  ip_hash     text,      -- SHA-256 of IP address, not raw IP
  passed      boolean NOT NULL,
  method      text NOT NULL,   -- 'dob_entry', 'checkbox'
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_age_gate_logs_user_id ON age_gate_logs(user_id);
CREATE INDEX idx_age_gate_logs_created_at ON age_gate_logs(created_at DESC);

-- RLS
ALTER TABLE age_gate_logs ENABLE ROW LEVEL SECURITY;
-- Users can see their own logs; service role can see all (for compliance audit)
CREATE POLICY "age_gate_logs_select_own" ON age_gate_logs FOR SELECT USING (auth.uid() = user_id);
```

---

## Foreign Key Summary

```
auth.users (Supabase)
  └── profiles (id)
        └── subscriptions (user_id)
        └── bankroll_entries (user_id)
        └── age_gate_logs (user_id)

teams
  └── games (home_team_id, away_team_id)
  └── players (team_id)

players
  └── games (probable_home_pitcher_id, probable_away_pitcher_id)

games
  └── odds (game_id)
  └── picks (game_id)
  └── pick_outcomes (game_id)
  └── bankroll_entries (game_id)

sportsbooks
  └── odds (sportsbook_id)
  └── picks (best_line_book_id)
  └── bankroll_entries (sportsbook_id)

picks
  └── pick_outcomes (pick_id) — 1:1
  └── rationale_cache (pick_id)
  └── bankroll_entries (pick_id)
```

---

## Open Questions for Orchestrator

1. **Subscription tier names and count:** Schema uses `('free', 'pro', 'elite')`. User has not confirmed tier names or count. Backend agent can add a tier with `ALTER TYPE subscription_tier ADD VALUE 'new_tier'` — non-destructive. Need user confirmation on tier names before Stripe products are created.
2. **Date of birth storage:** `date_of_birth date` is stored for audit. Attorney review should confirm whether storing full DOB vs. an age flag only is preferred for liability reasons. Compliance agent should address this in the age-gate spec.
3. **Prop picks schema:** `prop_description` and `prop_line` fields on `odds` handle simple props. Complex prop markets (player HR, strikeouts, etc.) may need a `player_props` table. ML agent should confirm scope before backend writes migrations.
4. **Parlay picks:** A parlay is a combination of picks. The current `picks` table handles single-game picks. Parlays need either a `parlay_legs` junction table or a JSONB `legs` column on `picks`. Recommend deferring parlay picks to v1.1 unless ML agent confirms parlay EV is in scope for v1.
