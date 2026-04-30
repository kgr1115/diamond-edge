-- Cron unschedule for analysis crons removed in branch wipe-analysis-2026-04-30.
-- Run against prod via Supabase Dashboard SQL editor or MCP.
-- Safe — does NOT touch ingestion crons (news-poll, odds-refresh-daytime,
-- odds-refresh-evening, stats-sync, lineup-sync-15min, news-extraction-sweep).
--
-- Verify what's currently scheduled before running:
--   SELECT jobname, schedule, command FROM cron.job ORDER BY jobname;
--
-- Then run this script:

DO $$
BEGIN
  -- Analysis crons (POST/GET to wiped endpoints)
  PERFORM cron.unschedule('outcome-grader');
  PERFORM cron.unschedule('clv-compute');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Some unschedule calls failed (likely jobs not present): %', SQLERRM;
END $$;

-- Verify after:
--   SELECT jobname FROM cron.job ORDER BY jobname;
--
-- Expected remaining: news-poll, news-extraction-sweep, odds-refresh-daytime,
-- odds-refresh-evening, stats-sync, lineup-sync-15min.
