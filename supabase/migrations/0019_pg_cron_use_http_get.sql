-- Migration 0019 — switch pg_cron jobs that target Next.js routes from
-- net.http_post → net.http_get.
--
-- Background:
--   Next.js Route Handlers only export the methods they declare. All cron
--   handlers under apps/web/app/api/cron/* export GET. pg_cron jobs registered
--   in 0009 / 0015 / 0017 / 0018 used net.http_post, which Next.js answered
--   with 405 Method Not Allowed — the handlers never ran. Symptom: graded picks
--   stopped accumulating, CLV stopped computing, stats-sync went silent, etc.
--
--   This migration re-registers every affected pg_cron schedule with
--   net.http_get. cron.schedule(jobname, ...) is idempotent: re-calling with
--   the same jobname replaces the prior entry, so no cron.unschedule() is
--   needed.
--
-- Unaffected: news-extraction-sweep (Job 2 in 0009) calls a Supabase Edge
--   Function, which accepts POST natively. That schedule remains as-is.
--
-- =====================================================================
-- COMPANION MANUAL STEP — RUN IN SUPABASE SQL EDITOR BEFORE THIS MIGRATION
-- =====================================================================
--   Vercel auto-redirects diamond-edge.co (apex) → www.diamond-edge.co (307).
--   pg_net does not follow redirects, so app.vercel_url MUST point at the
--   www subdomain. Run once per environment:
--
--     ALTER DATABASE postgres SET app.vercel_url = 'https://www.diamond-edge.co';
--
--   For staging/preview environments, substitute the appropriate URL.
--   Verify with:
--     SHOW app.vercel_url;
--
-- After both this migration and the GUC update are in place, the cron handlers
-- will receive correctly-formed GET requests.
-- =====================================================================

-- Idempotent extension declarations — safe to re-run.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ---------------------------------------------------------------------------
-- Job: news-poll  (renamed from bluesky-poll in 0017)
-- Was: net.http_post in 0017 — switching to net.http_get.
-- ---------------------------------------------------------------------------
SELECT cron.schedule(
  'news-poll',
  '*/5 * * * *',
  $$
  SELECT net.http_get(
    url     := current_setting('app.vercel_url') || '/api/cron/news-poll',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.cron_secret')
    )
  )
  $$
);

-- ---------------------------------------------------------------------------
-- Job: outcome-grader
-- Daily at 08:00 UTC. Grades all pending picks for games that finalized
-- ≥6 hours ago.
-- ---------------------------------------------------------------------------
SELECT cron.schedule(
  'outcome-grader',
  '0 8 * * *',
  $$
  SELECT net.http_get(
    url     := current_setting('app.vercel_url') || '/api/cron/outcome-grader',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.cron_secret')
    )
  )
  $$
);

-- ---------------------------------------------------------------------------
-- Job: odds-refresh-daytime  (originally registered in 0015)
-- Top + bottom of the hour, 12:00–23:59 UTC (8 AM – 7:59 PM ET).
-- ---------------------------------------------------------------------------
SELECT cron.schedule(
  'odds-refresh-daytime',
  '0,30 12-23 * * *',
  $$
  SELECT net.http_get(
    url     := current_setting('app.vercel_url') || '/api/cron/odds-refresh',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.cron_secret')
    )
  )
  $$
);

-- ---------------------------------------------------------------------------
-- Job: odds-refresh-evening  (originally registered in 0015)
-- Top + bottom of the hour, 00:00–03:59 UTC (8 PM – 11:59 PM ET).
-- ---------------------------------------------------------------------------
SELECT cron.schedule(
  'odds-refresh-evening',
  '0,30 0-3 * * *',
  $$
  SELECT net.http_get(
    url     := current_setting('app.vercel_url') || '/api/cron/odds-refresh',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.cron_secret')
    )
  )
  $$
);

-- ---------------------------------------------------------------------------
-- Job: stats-sync  (originally registered in 0015)
-- Daily at 14:30 UTC — pre-pipeline ingestion of pitcher / team-batting /
-- bullpen stats.
-- ---------------------------------------------------------------------------
SELECT cron.schedule(
  'stats-sync',
  '30 14 * * *',
  $$
  SELECT net.http_get(
    url     := current_setting('app.vercel_url') || '/api/cron/stats-sync',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.cron_secret')
    )
  )
  $$
);

-- ---------------------------------------------------------------------------
-- Job: clv-compute  (originally registered in 0015)
-- Daily at 09:00 UTC — Closing Line Value vs market_priors.
-- ---------------------------------------------------------------------------
SELECT cron.schedule(
  'clv-compute',
  '0 9 * * *',
  $$
  SELECT net.http_get(
    url     := current_setting('app.vercel_url') || '/api/cron/clv-compute',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.cron_secret')
    )
  )
  $$
);

-- ---------------------------------------------------------------------------
-- Job: lineup-sync-15min  (originally registered in 0018)
-- Every 15 minutes from 15:00–23:59 UTC — confirmed-lineup polling.
-- Note the ?stage=lineup query string is preserved through net.http_get.
-- ---------------------------------------------------------------------------
SELECT cron.schedule(
  'lineup-sync-15min',
  '*/15 15-23 * * *',
  $$
  SELECT net.http_get(
    url     := current_setting('app.vercel_url') || '/api/cron/stats-sync?stage=lineup',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.cron_secret')
    )
  )
  $$
);

-- ---------------------------------------------------------------------------
-- Verification — run these manually after applying:
--
--   SELECT jobname, schedule, command FROM cron.job
--    WHERE jobname IN (
--      'news-poll', 'outcome-grader', 'odds-refresh-daytime',
--      'odds-refresh-evening', 'stats-sync', 'clv-compute',
--      'lineup-sync-15min'
--    );
--
-- Expected: each row's `command` contains 'net.http_get'. If any still says
-- net.http_post, this migration did not apply cleanly; investigate.
-- ---------------------------------------------------------------------------
