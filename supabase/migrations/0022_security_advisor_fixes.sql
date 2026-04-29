-- Address Supabase security advisor findings (2026-04-29).
--
-- CRITICAL (rls_disabled_in_public):
--   _diamond_edge_migrations and calibration_history are exposed to PostgREST
--   without RLS. Both are written exclusively by service-role / superuser
--   connections (migration runner + Vercel cron), which bypass RLS — so enabling
--   RLS with no policies locks anon/authenticated out of these internal tables
--   without breaking any code path.
--
-- WARN (function_search_path_mutable):
--   set_updated_at had a mutable search_path; pin it to empty so the function
--   resolves identifiers via fully-qualified names only.
--
-- WARN ({anon,authenticated}_security_definer_function_executable):
--   handle_new_user is the auth.users trigger function and is not meant to be
--   callable via /rest/v1/rpc. Revoke EXECUTE from anon + authenticated.
--
-- Out of scope (deferred — separate migrations):
--   - pg_net extension lives in public schema (risk: pg_cron jobs reference net.*)
--   - auth_leaked_password_protection toggle (Supabase dashboard, not SQL)

ALTER TABLE public._diamond_edge_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calibration_history ENABLE ROW LEVEL SECURITY;

ALTER FUNCTION public.set_updated_at() SET search_path = '';

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM anon, authenticated;
