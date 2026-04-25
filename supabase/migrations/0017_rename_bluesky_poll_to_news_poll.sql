-- Diamond Edge — rename pg_cron job 'bluesky-poll' to 'news-poll'
-- Run order: 17 (depends on 0009 having registered the original 'bluesky-poll' job).
--
-- Why:
-- The pg_cron job in 0009 was named 'bluesky-poll' from when the route was
-- Bluesky-only. The route was generalized to a multi-source poller (RSS +
-- Bluesky) and now lives at /api/cron/news-poll. The cron_runs telemetry
-- writes 'news-poll' (apps/web/app/api/cron/news-poll/route.ts), and the
-- admin/pipelines dashboard cadence map keys on the job_name. Without this
-- rename, the dashboard reports 'bluesky-poll' as forever-stale (no telemetry)
-- and lists 'news-poll' under pg_cron-jobs-without-telemetry.
--
-- This is a name-only change. Schedule, body, target URL, auth header, and
-- semantics are unchanged.
--
-- Re-runnable: the unschedule is guarded against "job not found" so this
-- migration is safe to apply repeatedly. The schedule call replaces any
-- existing 'news-poll' job in place (cron.schedule is upsert-by-name).
--
-- Atomicity: unschedule + reschedule run in a single transaction, so there
-- is no window where neither name is scheduled.
--
-- Rollback (apply manually if regression):
--   BEGIN;
--   SELECT cron.unschedule('news-poll');
--   SELECT cron.schedule('bluesky-poll', '*/5 * * * *', $$ ...0009 body... $$);
--   COMMIT;

BEGIN;

DO $$
BEGIN
  PERFORM cron.unschedule('bluesky-poll');
EXCEPTION
  WHEN OTHERS THEN
    -- 'job not found' (already renamed, or migration applied previously) is fine.
    RAISE NOTICE 'cron.unschedule(bluesky-poll) skipped: %', SQLERRM;
END
$$;

SELECT cron.schedule(
  'news-poll',
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

COMMIT;

-- ---------------------------------------------------------------------------
-- Post-apply verification (run manually in SQL editor after `supabase db push`):
--
--   SELECT jobname, schedule, active
--   FROM cron.job
--   WHERE jobname IN ('bluesky-poll', 'news-poll')
--   ORDER BY jobname;
--
-- Expect a single row: jobname='news-poll', schedule='*/5 * * * *', active=true.
-- 'bluesky-poll' should be absent.
-- ---------------------------------------------------------------------------
