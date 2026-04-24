/**
 * Cron-run telemetry helper. Records per-invocation lifecycle rows in
 * `cron_runs` so the admin page at /admin/pipelines can answer
 * "did every cron fire successfully in the last 24h?".
 *
 * Discipline (per scope-gate):
 *   - Telemetry failure MUST NOT block the primary cron. All writes are
 *     wrapped in try/catch and log-and-continue.
 *   - `error_msg` is truncated to 500 chars at the boundary to avoid leaking
 *     stacktrace payloads and to satisfy the DB CHECK constraint.
 *   - RLS on `cron_runs` has zero policies — writes only succeed via the
 *     service-role client. Callers MUST pass one in.
 */
import { createServiceRoleClient } from '@/lib/supabase/server';

const ERROR_MSG_MAX = 500;

export interface CronRunHandle {
  id: string;
  jobName: string;
  startedAtMs: number;
}

/**
 * Truncate an error message to the DB CHECK limit. Exposed for tests; callers
 * should usually pass raw error strings and let `finishCronRun` handle it.
 */
export function truncateErrorMsg(msg: string | null | undefined): string | null {
  if (msg == null) return null;
  if (msg.length <= ERROR_MSG_MAX) return msg;
  return msg.slice(0, ERROR_MSG_MAX - 3) + '...';
}

/**
 * Record cron-run start. Returns a handle to pass to `finishCronRun`.
 * On DB failure returns a synthetic handle so the caller can still complete —
 * the subsequent `finishCronRun` will also no-op on DB failure.
 */
export async function startCronRun(jobName: string): Promise<CronRunHandle> {
  const startedAtMs = Date.now();
  const startedAtIso = new Date(startedAtMs).toISOString();

  try {
    const supabase = createServiceRoleClient();
    const { data, error } = await supabase
      .from('cron_runs')
      .insert({ job_name: jobName, started_at: startedAtIso, status: 'running' })
      .select('id')
      .single();

    if (error || !data) {
      console.warn(JSON.stringify({
        level: 'warn',
        event: 'cron_run_log_insert_failed',
        job_name: jobName,
        error: error?.message ?? 'no row returned',
      }));
      return { id: '', jobName, startedAtMs };
    }

    return { id: data.id, jobName, startedAtMs };
  } catch (err) {
    console.warn(JSON.stringify({
      level: 'warn',
      event: 'cron_run_log_insert_threw',
      job_name: jobName,
      error: err instanceof Error ? err.message : String(err),
    }));
    return { id: '', jobName, startedAtMs };
  }
}

/**
 * Record cron-run completion. Safe to call even if `startCronRun` failed —
 * an empty handle id short-circuits with a no-op.
 */
export async function finishCronRun(
  handle: CronRunHandle,
  result: { status: 'success' | 'failure'; errorMsg?: string | null },
): Promise<void> {
  if (!handle.id) return;

  const durationMs = Date.now() - handle.startedAtMs;
  const finishedAtIso = new Date().toISOString();

  try {
    const supabase = createServiceRoleClient();
    const { error } = await supabase
      .from('cron_runs')
      .update({
        finished_at: finishedAtIso,
        status: result.status,
        duration_ms: durationMs,
        error_msg: truncateErrorMsg(result.errorMsg),
      })
      .eq('id', handle.id);

    if (error) {
      console.warn(JSON.stringify({
        level: 'warn',
        event: 'cron_run_log_update_failed',
        job_name: handle.jobName,
        run_id: handle.id,
        error: error.message,
      }));
    }
  } catch (err) {
    console.warn(JSON.stringify({
      level: 'warn',
      event: 'cron_run_log_update_threw',
      job_name: handle.jobName,
      run_id: handle.id,
      error: err instanceof Error ? err.message : String(err),
    }));
  }
}
