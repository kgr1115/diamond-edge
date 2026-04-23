-- Diamond Edge — pg_cron job registrations
-- Run order: 9 (no schema dependency; requires pg_cron and pg_net extensions)
--
-- Registers three cron jobs:
--   bluesky-poll          every 5 min, 06:00–04:00 UTC game-day window
--   news-extraction-sweep every 15 min, 06:00–04:00 UTC game-day window
--   outcome-grader        daily at 08:00 UTC (3 AM ET)
--
-- Vercel Hobby cron jobs (schedule-sync at 14:00 UTC, pick-pipeline at 16:00 UTC)
-- remain unchanged. These pg_cron jobs are purely additive.
--
-- BLOCKER NOTE: pg_cron requires the pg_cron extension to be enabled in the
-- Supabase dashboard (Database → Extensions → pg_cron). On Pro plans this is
-- available; on Free tier it must be enabled manually. pg_net is also required
-- for net.http_post(). Both must be enabled before this migration is applied.
-- DevOps agent should confirm extension availability before running.
--
-- The SUPABASE_ANON_KEY placeholder below must be replaced with the real
-- CRON_SECRET value (or a dedicated internal key) before applying in production.
-- Recommendation: use a Postgres-level secret or Vault entry rather than
-- hardcoding. Replace <CRON_SECRET> with the actual value in the Supabase
-- SQL editor or via a pre-migration script.

-- Enable required extensions (idempotent; safe to re-run)
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ---------------------------------------------------------------------------
-- Job 1: bluesky-poll
-- Polls Bluesky beat-writer accounts every 5 minutes during the game-day
-- window (06:00–04:00 UTC). Calls the Vercel API route which handles
-- Bluesky-specific ingestion. The route validates CRON_SECRET on the
-- Authorization header.
--
-- Game-day window expressed as two jobs:
--   a) 06:00–23:55 UTC  => */5 6-23 * * *
--   b) 00:00–04:00 UTC  => */5 0-4  * * *
-- Combined into a single every-5-min job; the route self-gates if no games.
-- ---------------------------------------------------------------------------

SELECT cron.schedule(
  'bluesky-poll',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url     := current_setting('app.vercel_url') || '/api/cron/news-poll',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || current_setting('app.cron_secret')
    ),
    body    := '{}'::jsonb
  )
  $$
);

-- ---------------------------------------------------------------------------
-- Job 2: news-extraction-sweep
-- Every 15 minutes during game-day window. Invokes the late-news-pipeline
-- Supabase Edge Function, which queries unprocessed news_events, calls
-- /rationale-news on the Fly.io worker, and upserts news_signals.
-- ---------------------------------------------------------------------------

SELECT cron.schedule(
  'news-extraction-sweep',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url     := current_setting('app.supabase_url') || '/functions/v1/late-news-pipeline',
    headers := jsonb_build_object(
      'Content-Type',   'application/json',
      'Authorization',  'Bearer ' || current_setting('app.supabase_anon_key')
    ),
    body    := '{}'::jsonb
  )
  $$
);

-- ---------------------------------------------------------------------------
-- Job 3: outcome-grader
-- Daily at 08:00 UTC (3 AM ET / 4 AM ET depending on DST).
-- Grades picks from the previous day's completed games.
-- Calls the Vercel route which does the full grading logic.
-- ---------------------------------------------------------------------------

SELECT cron.schedule(
  'outcome-grader',
  '0 8 * * *',
  $$
  SELECT net.http_post(
    url     := current_setting('app.vercel_url') || '/api/cron/outcome-grader',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || current_setting('app.cron_secret')
    ),
    body    := '{}'::jsonb
  )
  $$
);

-- ---------------------------------------------------------------------------
-- App-level settings: SET these in the Supabase SQL editor before running,
-- or use Supabase Vault to bind them at startup via a role-level GUC.
-- These are NOT hardcoded here to avoid leaking secrets into migration history.
-- Example (run separately in SQL editor before applying migration):
--
--   ALTER DATABASE postgres SET app.vercel_url      = 'https://diamondedge.ai';
--   ALTER DATABASE postgres SET app.supabase_url    = 'https://<project>.supabase.co';
--   ALTER DATABASE postgres SET app.cron_secret     = '<your-cron-secret>';
--   ALTER DATABASE postgres SET app.supabase_anon_key = '<your-anon-key>';
-- ---------------------------------------------------------------------------
