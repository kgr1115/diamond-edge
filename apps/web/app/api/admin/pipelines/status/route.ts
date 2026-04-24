/**
 * Admin API: GET /api/admin/pipelines/status
 *
 * Returns the per-job latest-run snapshot for the admin page at
 * /admin/pipelines. Non-admin callers get 404 (not 403) — operational
 * internals should not leak existence.
 *
 * Response shape:
 *   {
 *     generatedAt: ISO string,
 *     jobs: Array<{
 *       job_name: string,
 *       last_run: { started_at, finished_at, status, duration_ms, error_msg } | null,
 *       total_runs_24h: number,
 *       failures_24h: number,
 *     }>,
 *     pg_cron_jobs_without_telemetry: string[]  // jobname's in cron.job with no cron_runs row
 *   }
 */
import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/ops/admin-gate';
import { createServiceRoleClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LOOKBACK_HOURS = 24;
const ERROR_MSG_UI_MAX = 200;

interface CronRunRow {
  job_name: string;
  started_at: string;
  finished_at: string | null;
  status: 'running' | 'success' | 'failure';
  duration_ms: number | null;
  error_msg: string | null;
}

export async function GET(): Promise<NextResponse> {
  const admin = await requireAdmin();
  if (!admin) {
    return new NextResponse(null, { status: 404 });
  }

  const supabase = createServiceRoleClient();
  const sinceIso = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();

  const { data: runs, error } = await supabase
    .from('cron_runs')
    .select('job_name, started_at, finished_at, status, duration_ms, error_msg')
    .gte('started_at', sinceIso)
    .order('started_at', { ascending: false })
    .limit(1000);

  if (error) {
    console.error(JSON.stringify({
      level: 'error',
      event: 'admin_pipelines_status_query_failed',
      error: error.message,
    }));
    return NextResponse.json(
      { error: { code: 'DB_ERROR', message: 'Failed to load cron runs.' } },
      { status: 500 },
    );
  }

  const rows = (runs ?? []) as CronRunRow[];

  // Group by job_name; track latest run + counts.
  const perJob = new Map<string, {
    last_run: CronRunRow;
    total: number;
    failures: number;
  }>();

  for (const row of rows) {
    const existing = perJob.get(row.job_name);
    if (!existing) {
      perJob.set(row.job_name, {
        last_run: row,
        total: 1,
        failures: row.status === 'failure' ? 1 : 0,
      });
    } else {
      existing.total += 1;
      if (row.status === 'failure') existing.failures += 1;
    }
  }

  const jobs = Array.from(perJob.entries())
    .map(([job_name, agg]) => ({
      job_name,
      last_run: {
        started_at: agg.last_run.started_at,
        finished_at: agg.last_run.finished_at,
        status: agg.last_run.status,
        duration_ms: agg.last_run.duration_ms,
        error_msg: truncateForUi(agg.last_run.error_msg),
      },
      total_runs_24h: agg.total,
      failures_24h: agg.failures,
    }))
    .sort((a, b) => a.job_name.localeCompare(b.job_name));

  // Find pg_cron jobs that have never written to cron_runs.
  // cron.job lives in the pg_cron schema; not in the typed Database — escape hatch.
  // Failure here is non-fatal — the page still works without this list.
  let pgCronJobsWithoutTelemetry: string[] = [];
  try {
    const supabaseAny = supabase as unknown as {
      schema: (name: string) => { from: (table: string) => { select: (cols: string) => Promise<{ data: Array<{ jobname: string }> | null; error: { message: string } | null }> } };
    };
    const { data: pgCronJobs, error: pgError } = await supabaseAny
      .schema('cron')
      .from('job')
      .select('jobname');
    if (!pgError && pgCronJobs) {
      const jobsWithTelemetry = new Set(jobs.map((j) => j.job_name));
      pgCronJobsWithoutTelemetry = pgCronJobs
        .map((j) => j.jobname)
        .filter((name) => !jobsWithTelemetry.has(name))
        .sort();
    }
  } catch (err) {
    console.warn(JSON.stringify({
      level: 'warn',
      event: 'admin_pipelines_pg_cron_query_failed',
      error: err instanceof Error ? err.message : String(err),
    }));
  }

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    jobs,
    pg_cron_jobs_without_telemetry: pgCronJobsWithoutTelemetry,
  });
}

function truncateForUi(msg: string | null): string | null {
  if (msg == null) return null;
  if (msg.length <= ERROR_MSG_UI_MAX) return msg;
  return msg.slice(0, ERROR_MSG_UI_MAX - 3) + '...';
}
