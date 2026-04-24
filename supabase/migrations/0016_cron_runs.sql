-- Diamond Edge — cron_runs telemetry table (cycle 2, Proposal 3)
-- Run order: 16 (depends on: 0009 and 0015 having registered pg_cron jobs;
-- no schema dependency on those migrations, only a logical ordering).
--
-- Purpose: per-invocation telemetry for the cron surface (8 scheduled jobs
-- after 0015 landed). The admin page at /admin/pipelines joins against this
-- to answer "did every cron fire successfully in the last 24h?".
--
-- Writers: cron route handlers in apps/web/app/api/cron/** via the helper
-- in apps/web/lib/ops/cron-run-log.ts. Each handler records a 'running' row
-- on entry and updates it to 'success' or 'failure' on exit. Inserts are
-- wrapped in try/catch — telemetry failure MUST NOT block the primary cron.
--
-- Readers: the admin page at /admin/pipelines, accessed via service-role
-- client from a server component gated by ADMIN_USER_IDS. The public RLS
-- policy surface is intentionally empty — this table is operator-only.
--
-- Retention: intentionally unbounded in v1 (< 40k rows/yr at 8 jobs × typical
-- cadence per scope-gate's cost ceiling). Add a retention job later if needed.
--
-- RLS posture per scope-gate: enabled with ZERO public policies. Neither anon
-- nor authenticated sees rows. Service-role bypasses RLS by design and is the
-- only writer/reader.

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

CREATE TABLE cron_runs (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name     text        NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  status       text        NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running', 'success', 'failure')),
  duration_ms  integer,
  error_msg    text        CHECK (error_msg IS NULL OR length(error_msg) <= 500)
);

-- "Latest run per job" and "runs in last 24h for job" both use this index.
CREATE INDEX idx_cron_runs_job_name_started_at
  ON cron_runs(job_name, started_at DESC);

-- Fast "anything in-flight longer than threshold?" query for the admin page.
CREATE INDEX idx_cron_runs_running
  ON cron_runs(started_at DESC)
  WHERE status = 'running';

-- ---------------------------------------------------------------------------
-- RLS — enabled with NO policies so anon + authenticated get zero rows.
-- Service role bypasses RLS; that is the only writer/reader surface.
-- ---------------------------------------------------------------------------

ALTER TABLE cron_runs ENABLE ROW LEVEL SECURITY;

-- Intentionally NO policies. This table is operator-internal.
-- Do NOT grant SELECT to anon or authenticated.

-- Belt-and-suspenders: revoke any default grants Supabase may have applied.
REVOKE ALL ON cron_runs FROM anon;
REVOKE ALL ON cron_runs FROM authenticated;

-- ---------------------------------------------------------------------------
-- Post-apply verification (run manually in SQL editor after migration):
--
--   -- 1. Table exists + RLS is on.
--   SELECT relname, relrowsecurity
--   FROM pg_class
--   WHERE relname = 'cron_runs';
--   -- Expect: relrowsecurity = true.
--
--   -- 2. No RLS policies.
--   SELECT polname FROM pg_policy
--   WHERE polrelid = 'cron_runs'::regclass;
--   -- Expect: zero rows.
--
--   -- 3. Anon + authenticated cannot read. Use the anon key client:
--   --    SELECT * FROM cron_runs LIMIT 1;
--   --    Expect: zero rows returned (RLS denies).
-- ---------------------------------------------------------------------------
