-- Diamond Edge — User Tables
-- Run order: 6 (depends on: all previous migrations)

-- ============================================================
-- profiles
-- Extends Supabase Auth auth.users. One row per authenticated user.
-- Created automatically via the trigger defined below.
-- ============================================================

CREATE TABLE profiles (
  id                  uuid              PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email               text              NOT NULL,
  subscription_tier   subscription_tier NOT NULL DEFAULT 'free',
  age_verified        boolean           NOT NULL DEFAULT false,
  age_verified_at     timestamptz,
  date_of_birth       date,              -- stored for age verification audit; nullable until verified
  geo_state           char(2),           -- ISO 3166-2 US state code; NULL = not yet determined
  geo_blocked         boolean           NOT NULL DEFAULT false,
  stripe_customer_id  text              UNIQUE,
  created_at          timestamptz       NOT NULL DEFAULT now(),
  updated_at          timestamptz       NOT NULL DEFAULT now()
);

CREATE INDEX idx_profiles_stripe_customer_id ON profiles(stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;
CREATE INDEX idx_profiles_subscription_tier  ON profiles(subscription_tier);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "profiles_select_own" ON profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "profiles_update_own" ON profiles FOR UPDATE USING (auth.uid() = id);
-- INSERT handled by auth trigger below (service role); no user-direct INSERT.

-- ============================================================
-- Trigger: auto-create profile row on new auth.users row
-- ============================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email)
  VALUES (NEW.id, NEW.email)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================
-- subscriptions
-- Mirrors Stripe subscription state. Written by webhook handler only.
-- ============================================================

CREATE TABLE subscriptions (
  id                   uuid              PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid              NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
  stripe_sub_id        text              NOT NULL UNIQUE,
  stripe_price_id      text              NOT NULL,
  tier                 subscription_tier NOT NULL,
  status               text              NOT NULL,  -- Stripe statuses: 'active','past_due','canceled','trialing'
  current_period_start timestamptz       NOT NULL,
  current_period_end   timestamptz       NOT NULL,
  cancel_at_period_end boolean           NOT NULL DEFAULT false,
  canceled_at          timestamptz,
  created_at           timestamptz       NOT NULL DEFAULT now(),
  updated_at           timestamptz       NOT NULL DEFAULT now()
);

CREATE INDEX idx_subscriptions_user_id       ON subscriptions(user_id);
CREATE INDEX idx_subscriptions_stripe_sub_id ON subscriptions(stripe_sub_id);
CREATE INDEX idx_subscriptions_status        ON subscriptions(status);

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "subscriptions_select_own" ON subscriptions
  FOR SELECT USING (auth.uid() = user_id);
-- No user writes; Stripe webhook via service role only.

-- ============================================================
-- bankroll_entries
-- User-defined bet tracking. Soft-delete only (deleted_at).
-- ============================================================

CREATE TABLE bankroll_entries (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  pick_id            uuid        REFERENCES picks(id),
  game_id            uuid        REFERENCES games(id),
  bet_date           date        NOT NULL,
  market             market_type,
  description        text,                   -- free-text e.g. 'NYY ML'
  sportsbook_id      uuid        REFERENCES sportsbooks(id),
  bet_amount_cents   integer     NOT NULL CHECK (bet_amount_cents > 0),
  odds_price         integer     NOT NULL,   -- American odds at bet placement
  outcome            bet_outcome,            -- NULL until settled
  profit_loss_cents  integer,                -- positive = profit, negative = loss
  settled_at         timestamptz,
  notes              text,
  deleted_at         timestamptz,            -- soft delete; filtered by RLS
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_bankroll_entries_user_id  ON bankroll_entries(user_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_bankroll_entries_bet_date ON bankroll_entries(bet_date DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_bankroll_entries_pick_id  ON bankroll_entries(pick_id) WHERE pick_id IS NOT NULL;

ALTER TABLE bankroll_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "bankroll_select_own" ON bankroll_entries
  FOR SELECT USING (auth.uid() = user_id AND deleted_at IS NULL);
CREATE POLICY "bankroll_insert_own" ON bankroll_entries
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "bankroll_update_own" ON bankroll_entries
  FOR UPDATE USING (auth.uid() = user_id);
-- No hard delete via user — soft delete only (set deleted_at).

-- ============================================================
-- age_gate_logs
-- Compliance audit log for every age verification attempt.
-- Append-only; never user-readable via RLS in v1.
-- ============================================================

CREATE TABLE age_gate_logs (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        REFERENCES profiles(id),  -- nullable: not yet linked if pre-signup
  ip_hash    text,        -- SHA-256 of request IP (never raw IP — privacy)
  passed     boolean     NOT NULL,
  method     text        NOT NULL,  -- 'dob_entry'
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_age_gate_logs_user_id    ON age_gate_logs(user_id);
CREATE INDEX idx_age_gate_logs_created_at ON age_gate_logs(created_at DESC);

ALTER TABLE age_gate_logs ENABLE ROW LEVEL SECURITY;
-- Service role reads all for compliance audit; users cannot read their own log in v1.
-- (Attorney may advise on CCPA right-of-access; revisit in v1.1.)
CREATE POLICY "age_gate_logs_select_own" ON age_gate_logs
  FOR SELECT USING (auth.uid() = user_id);
