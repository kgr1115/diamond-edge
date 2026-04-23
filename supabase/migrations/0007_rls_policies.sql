-- Diamond Edge — RLS Policy Audit / Supplemental Policies
-- Run order: 7 (depends on: all tables created in 0002–0006)
--
-- All primary RLS policies are co-located with their table CREATE statements
-- (0002–0006). This file adds:
--   1. A summary comment block for auditors.
--   2. Any cross-table or supplemental policies that couldn't be expressed
--      inline (e.g., policies that reference another table's column).
--   3. Explicit GRANT statements ensuring the anon and authenticated roles
--      have the minimum permissions needed.

-- ============================================================
-- RLS POLICY SUMMARY (for compliance audit trail)
-- ============================================================
--
-- Table                  | Who can SELECT             | Who can INSERT/UPDATE/DELETE
-- -----------------------|----------------------------|-----------------------------
-- sportsbooks            | public (anon + authed)     | service role only
-- geo_blocked_states     | public                     | service role only
-- teams                  | public                     | service role only
-- players                | public                     | service role only
-- games                  | public                     | service role only
-- odds                   | public                     | service role only (ingestion)
-- rationale_cache        | authenticated only         | service role only
-- picks                  | authenticated: all rows    | service role only (pipeline)
--                        | anon: required_tier='free' |
-- pick_outcomes          | public                     | service role only (grader)
-- profiles               | own row only               | trigger (insert), own row (update)
-- subscriptions          | own row only               | service role only (webhook)
-- bankroll_entries       | own rows (deleted_at=NULL) | own (insert+update); no hard delete
-- age_gate_logs          | own rows only              | service role only
--
-- SECURITY PRINCIPLE: RLS is the boundary. App-level checks are defense-in-depth.
-- Service-role key is server-only; never included in client bundles.

-- ============================================================
-- Ensure anon role can query public tables
-- (Supabase grants these by default but we make them explicit)
-- ============================================================

GRANT SELECT ON sportsbooks          TO anon;
GRANT SELECT ON geo_blocked_states   TO anon;
GRANT SELECT ON teams                TO anon;
GRANT SELECT ON players              TO anon;
GRANT SELECT ON games                TO anon;
GRANT SELECT ON odds                 TO anon;
GRANT SELECT ON picks                TO anon;
GRANT SELECT ON pick_outcomes        TO anon;

-- ============================================================
-- Ensure authenticated role has minimum required permissions
-- ============================================================

GRANT SELECT ON sportsbooks          TO authenticated;
GRANT SELECT ON geo_blocked_states   TO authenticated;
GRANT SELECT ON teams                TO authenticated;
GRANT SELECT ON players              TO authenticated;
GRANT SELECT ON games                TO authenticated;
GRANT SELECT ON odds                 TO authenticated;
GRANT SELECT ON picks                TO authenticated;
GRANT SELECT ON pick_outcomes        TO authenticated;
GRANT SELECT ON rationale_cache      TO authenticated;
GRANT SELECT, UPDATE ON profiles     TO authenticated;
GRANT SELECT ON subscriptions        TO authenticated;
GRANT SELECT, INSERT, UPDATE ON bankroll_entries TO authenticated;
GRANT SELECT ON age_gate_logs        TO authenticated;

-- ============================================================
-- updated_at auto-update triggers
-- Keep updated_at accurate without relying on callers.
-- ============================================================

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_profiles_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_subscriptions_updated_at
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_bankroll_entries_updated_at
  BEFORE UPDATE ON bankroll_entries
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_teams_updated_at
  BEFORE UPDATE ON teams
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_players_updated_at
  BEFORE UPDATE ON players
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_games_updated_at
  BEFORE UPDATE ON games
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
