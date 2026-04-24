/**
 * Admin page: /admin/pipelines — cron-surface status dashboard.
 *
 * Gate: requireAdmin() — non-admins see a Next.js 404 (not 403). This is the
 * scope-gate non-negotiable: operational internals must not leak existence.
 *
 * The initial render is server-streamed so the page is responsive even if
 * the API is slow. The CronRunsTable client component then auto-refreshes
 * every 60 seconds via /api/admin/pipelines/status.
 */
import { notFound } from 'next/navigation';
import { requireAdmin } from '@/lib/ops/admin-gate';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { CronRunsTable, type JobRow, type StatusPayload } from './CronRunsTable';

export const dynamic = 'force-dynamic';

const LOOKBACK_HOURS = 24;
const ERROR_MSG_UI_MAX = 200;

// Expected cadences (minutes between runs). Used for the "stale" (amber)
// highlight: a job is stale if its last run was > 2× expected cadence ago.
// null = no meaningful cadence (e.g., one-shot / manual); never mark stale.
const EXPECTED_CADENCE_MIN: Record<string, number | null> = {
  'bluesky-poll': 5,
  'news-extraction-sweep': 15,
  'outcome-grader': 24 * 60,
  'odds-refresh-daytime': 30,
  'odds-refresh-evening': 30,
  'stats-sync': 24 * 60,
  'clv-compute': 24 * 60,
  'schedule-sync': 24 * 60,
  'pick-pipeline': 24 * 60,
};

interface CronRunRow {
  job_name: string;
  started_at: string;
  finished_at: string | null;
  status: 'running' | 'success' | 'failure';
  duration_ms: number | null;
  error_msg: string | null;
}

async function loadInitialStatus(): Promise<StatusPayload> {
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
      event: 'admin_pipelines_initial_load_failed',
      error: error.message,
    }));
    return { generatedAt: new Date().toISOString(), jobs: [], pg_cron_jobs_without_telemetry: [] };
  }

  const rows = (runs ?? []) as CronRunRow[];

  const perJob = new Map<string, { last: CronRunRow; total: number; failures: number }>();
  for (const row of rows) {
    const existing = perJob.get(row.job_name);
    if (!existing) {
      perJob.set(row.job_name, {
        last: row,
        total: 1,
        failures: row.status === 'failure' ? 1 : 0,
      });
    } else {
      existing.total += 1;
      if (row.status === 'failure') existing.failures += 1;
    }
  }

  const jobs: JobRow[] = Array.from(perJob.entries())
    .map(([job_name, agg]) => ({
      job_name,
      last_run: {
        started_at: agg.last.started_at,
        finished_at: agg.last.finished_at,
        status: agg.last.status,
        duration_ms: agg.last.duration_ms,
        error_msg: truncateForUi(agg.last.error_msg),
      },
      total_runs_24h: agg.total,
      failures_24h: agg.failures,
      expected_cadence_min: EXPECTED_CADENCE_MIN[job_name] ?? null,
    }))
    .sort((a, b) => a.job_name.localeCompare(b.job_name));

  let pgCronJobsWithoutTelemetry: string[] = [];
  try {
    const supabaseAny = supabase as unknown as {
      schema: (name: string) => { from: (table: string) => { select: (cols: string) => Promise<{ data: Array<{ jobname: string }> | null }> } };
    };
    const { data: pgCronJobs } = await supabaseAny
      .schema('cron')
      .from('job')
      .select('jobname');
    if (pgCronJobs) {
      const withTelemetry = new Set(jobs.map((j) => j.job_name));
      pgCronJobsWithoutTelemetry = pgCronJobs
        .map((j) => j.jobname)
        .filter((name) => !withTelemetry.has(name))
        .sort();
    }
  } catch {
    // Non-fatal — page renders without this list if the cron schema isn't queryable.
  }

  return {
    generatedAt: new Date().toISOString(),
    jobs,
    pg_cron_jobs_without_telemetry: pgCronJobsWithoutTelemetry,
  };
}

function truncateForUi(msg: string | null): string | null {
  if (msg == null) return null;
  if (msg.length <= ERROR_MSG_UI_MAX) return msg;
  return msg.slice(0, ERROR_MSG_UI_MAX - 3) + '...';
}

export default async function AdminPipelinesPage() {
  const admin = await requireAdmin();
  if (!admin) {
    notFound();
  }

  const initial = await loadInitialStatus();

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold text-white mb-2">Pipeline Status</h1>
      <p className="text-sm text-gray-400 mb-6">
        Last-24h cron telemetry. Auto-refresh every 60s.
      </p>
      <CronRunsTable initial={initial} />
    </div>
  );
}
