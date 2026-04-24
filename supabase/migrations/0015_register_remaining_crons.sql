-- Diamond Edge — pg_cron job registrations (cycle 2)
-- Run order: 15 (no schema dependency; requires pg_cron and pg_net extensions
-- already enabled by migration 0009).
--
-- Registers the three Next.js cron route handlers that exist but were never
-- scheduled. Vercel Hobby tier caps cron jobs at 2 (schedule-sync 14:00 UTC,
-- pick-pipeline 16:00 UTC), so these three land on pg_cron alongside the
-- jobs registered in 0009.
--
--   odds-refresh-daytime   '0,30 12-23 * * *'  08:00-19:30 ET every 30 min
--   odds-refresh-evening   '0,30 0-3 * * *'    20:00-23:30 ET every 30 min
--   stats-sync             '30 14 * * *'       daily, 30 min after schedule-sync
--   clv-compute            '0 9 * * *'         daily, 1 h after outcome-grader
--
-- Ordering rationale:
--   - stats-sync fires AFTER schedule-sync (14:00 UTC) because its handler
--     reads the `games` table filtered by today's game_date — it needs
--     schedule-sync to have populated today's slate first. Matches the
--     recipe in apps/web/app/api/cron/stats-sync/route.ts block comment.
--   - clv-compute fires at 09:00 UTC (1 h after outcome-grader at 08:00 UTC)
--     so grading is fully committed before CLV joins pick_clv against picks
--     whose games are 'final'. >30 min race-window buffer per scope-gate.
--   - odds-refresh runs in two windows to cover the full 08:00-23:30 ET
--     active betting window (matches vercel.json recipe in
--     docs/infra/vercel-setup.md and docs/runbooks/odds-ingestion-lag.md).
--     The handler self-gates outside active hours; the two-window split is
--     purely a cron-syntax convenience.
--
-- BLOCKER NOTE: this migration assumes the GUCs set in 0009 are already
-- present on the target database:
--   app.vercel_url
--   app.cron_secret
-- If either is missing, net.http_post() silently no-ops and the jobs will
-- appear to run but never reach the Vercel routes. DevOps must confirm
-- `SHOW app.vercel_url;` and `SHOW app.cron_secret;` return non-empty values
-- before applying this migration.
--
-- The Next.js route handlers each validate the CRON_SECRET on the
-- Authorization header; pg_cron as a scheduler is not trusted for auth.

-- Extensions already enabled by migration 0009 (idempotent re-declaration safe)
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ---------------------------------------------------------------------------
-- Job 1a: odds-refresh-daytime
-- Refreshes odds every 30 minutes during the 08:00-19:30 ET window
-- (UTC 12:00-23:30). The handler runs The Odds API poll + invalidates
-- Upstash cache keys for today's games. Self-no-ops if no games are
-- scheduled. Required for the "best line" surface on /picks/today to stay
-- fresh.
-- ---------------------------------------------------------------------------

SELECT cron.schedule(
  'odds-refresh-daytime',
  '0,30 12-23 * * *',
  $$
  SELECT net.http_post(
    url     := current_setting('app.vercel_url') || '/api/cron/odds-refresh',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || current_setting('app.cron_secret')
    ),
    body    := '{}'::jsonb
  )
  $$
);

-- ---------------------------------------------------------------------------
-- Job 1b: odds-refresh-evening
-- Second daily window covering 20:00-23:30 ET (UTC 00:00-03:30). Same
-- handler, same semantics; split from Job 1a only because a single cron
-- expression cannot span a UTC midnight crossing.
-- ---------------------------------------------------------------------------

SELECT cron.schedule(
  'odds-refresh-evening',
  '0,30 0-3 * * *',
  $$
  SELECT net.http_post(
    url     := current_setting('app.vercel_url') || '/api/cron/odds-refresh',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || current_setting('app.cron_secret')
    ),
    body    := '{}'::jsonb
  )
  $$
);

-- ---------------------------------------------------------------------------
-- Job 2: stats-sync
-- Daily at 14:30 UTC (30 min after schedule-sync). Syncs pitcher season
-- stats, team batting, bullpen, umpire assignments, and initial lineups
-- for today's slate. Must run AFTER schedule-sync because its handler
-- filters `games` by today's game_date. Per-stage errors are non-fatal;
-- the handler returns 207 on partial success.
-- ---------------------------------------------------------------------------

SELECT cron.schedule(
  'stats-sync',
  '30 14 * * *',
  $$
  SELECT net.http_post(
    url     := current_setting('app.vercel_url') || '/api/cron/stats-sync',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || current_setting('app.cron_secret')
    ),
    body    := '{}'::jsonb
  )
  $$
);

-- ---------------------------------------------------------------------------
-- Job 3: clv-compute
-- Daily at 09:00 UTC (1 h after outcome-grader at 08:00 UTC). Computes
-- Closing Line Value for picks whose game is 'final' and whose pick_clv
-- row does not yet exist. Batch-limited to 200 picks per invocation to
-- stay within the 60s Vercel maxDuration. Picks without a closing
-- market_priors row are inserted with closing_novig_prob = NULL rather
-- than skipped.
-- ---------------------------------------------------------------------------

SELECT cron.schedule(
  'clv-compute',
  '0 9 * * *',
  $$
  SELECT net.http_post(
    url     := current_setting('app.vercel_url') || '/api/cron/clv-compute',
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
--   WHERE jobname IN (
--     'odds-refresh-daytime',
--     'odds-refresh-evening',
--     'stats-sync',
--     'clv-compute'
--   )
--   ORDER BY jobname;
--
-- Expect 4 rows, all active = true. After the first scheduled fire of
-- each, `SELECT * FROM cron.job_run_details ORDER BY start_time DESC`
-- should show succeeded runs.
-- ---------------------------------------------------------------------------
