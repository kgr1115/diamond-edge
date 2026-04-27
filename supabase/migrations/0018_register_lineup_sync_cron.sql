-- Diamond Edge — pg_cron job registration: lineup-sync-15min
-- Run order: 18 (no schema dependency; requires pg_cron and pg_net extensions
-- already enabled by migrations 0009 and 0015).
--
-- Registers the lineup-sync tight loop that fires every 15 minutes between
-- 15:00 and 23:59 UTC (11:00-19:59 ET / 10:00-18:59 EST). Calls the
-- /api/cron/stats-sync route with ?stage=lineup which short-circuits the
-- full stats refresh and only resyncs lineup entries for today's slate.
--
-- Window rationale:
--   - First-pitch slate ramps in at ~15:00 UTC (11:00 ET) on weekdays and
--     covers all afternoon + evening start times through ~23:30 UTC closes.
--   - Lineups are routinely posted T-2h to T-30m before first pitch and
--     change frequently up to puck drop; a 15-min cadence catches the bulk
--     of those edits without burning Vercel cron credits.
--   - Matches the recipe in apps/web/app/api/cron/stats-sync/route.ts block
--     comment.
--
-- BLOCKER NOTE: this migration assumes the GUCs set in 0009 are already
-- present on the target database:
--   app.vercel_url
--   app.cron_secret
-- If either is missing, net.http_post() silently no-ops and the job will
-- appear to run but never reach the Vercel route. DevOps must confirm
-- `SHOW app.vercel_url;` and `SHOW app.cron_secret;` return non-empty values
-- before applying this migration.
--
-- The Next.js route handler validates the CRON_SECRET on the Authorization
-- header; pg_cron as a scheduler is not trusted for auth.

-- Extensions already enabled by migrations 0009/0015 (idempotent re-declaration safe)
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ---------------------------------------------------------------------------
-- Job: lineup-sync-15min
-- Every 15 min during the 15:00-23:59 UTC active window. Calls stats-sync
-- with ?stage=lineup so only the lineup-entries stage runs (cheap, idempotent).
-- ---------------------------------------------------------------------------

SELECT cron.schedule(
  'lineup-sync-15min',
  '*/15 15-23 * * *',
  $$
  SELECT net.http_post(
    url     := current_setting('app.vercel_url') || '/api/cron/stats-sync?stage=lineup',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || current_setting('app.cron_secret')
    ),
    body    := '{}'::jsonb
  )
  $$
);

-- ---------------------------------------------------------------------------
-- Post-apply verification (run manually in SQL editor after migration):
--
--   SELECT jobname, schedule, active
--   FROM cron.job
--   WHERE jobname = 'lineup-sync-15min';
--
-- Expect 1 row, active = true. After the first scheduled fire,
-- `SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 5`
-- should show succeeded runs.
-- ---------------------------------------------------------------------------
