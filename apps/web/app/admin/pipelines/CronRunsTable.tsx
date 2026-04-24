'use client';

import { useCallback, useEffect, useState } from 'react';

export interface JobRow {
  job_name: string;
  last_run: {
    started_at: string;
    finished_at: string | null;
    status: 'running' | 'success' | 'failure';
    duration_ms: number | null;
    error_msg: string | null;
  };
  total_runs_24h: number;
  failures_24h: number;
  expected_cadence_min: number | null;
}

export interface StatusPayload {
  generatedAt: string;
  jobs: JobRow[];
  pg_cron_jobs_without_telemetry: string[];
}

const REFRESH_MS = 60_000;

export function CronRunsTable({ initial }: { initial: StatusPayload }) {
  const [data, setData] = useState<StatusPayload>(initial);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setFetchError(null);
    try {
      const res = await fetch('/api/admin/pipelines/status', { cache: 'no-store' });
      if (!res.ok) {
        setFetchError(`Status fetch failed: ${res.status}`);
        return;
      }
      const payload = (await res.json()) as StatusPayload;
      setData(payload);
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const id = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const nowMs = Date.now();

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 text-xs text-gray-400">
        <span>Generated: {formatTime(data.generatedAt)}</span>
        <button
          onClick={refresh}
          disabled={refreshing}
          className="px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 disabled:opacity-50"
        >
          {refreshing ? 'Refreshing…' : 'Refresh now'}
        </button>
        {fetchError && <span className="text-red-400">{fetchError}</span>}
      </div>

      {data.jobs.length === 0 ? (
        <div className="rounded border border-gray-800 bg-gray-900/40 px-4 py-8 text-center text-sm text-gray-400">
          No cron telemetry recorded in the last 24 hours.
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-gray-800">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-900/60 text-xs uppercase text-gray-400">
              <tr>
                <th className="px-3 py-2 text-left">Job</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-left">Last run</th>
                <th className="px-3 py-2 text-left">Duration</th>
                <th className="px-3 py-2 text-right">Runs/24h</th>
                <th className="px-3 py-2 text-right">Failures/24h</th>
                <th className="px-3 py-2 text-left">Last error</th>
              </tr>
            </thead>
            <tbody>
              {data.jobs.map((job) => {
                const tone = rowTone(job, nowMs);
                return (
                  <tr key={job.job_name} className="border-t border-gray-800">
                    <td className="px-3 py-2 font-mono text-gray-200">{job.job_name}</td>
                    <td className={`px-3 py-2 font-semibold ${tone.text}`}>
                      <span className={`inline-block w-2 h-2 rounded-full ${tone.dot} mr-2`} />
                      {tone.label}
                    </td>
                    <td className="px-3 py-2 text-gray-300">{formatTime(job.last_run.started_at)}</td>
                    <td className="px-3 py-2 text-gray-300">{formatDuration(job.last_run.duration_ms)}</td>
                    <td className="px-3 py-2 text-right text-gray-300">{job.total_runs_24h}</td>
                    <td className={`px-3 py-2 text-right ${job.failures_24h > 0 ? 'text-red-400' : 'text-gray-300'}`}>
                      {job.failures_24h}
                    </td>
                    <td className="px-3 py-2 text-gray-400 max-w-sm">
                      <span className="block truncate" title={job.last_run.error_msg ?? ''}>
                        {job.last_run.error_msg ?? '—'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div>
        <h2 className="text-sm font-semibold text-gray-300 mb-2">
          pg_cron jobs without telemetry
        </h2>
        {data.pg_cron_jobs_without_telemetry.length === 0 ? (
          <p className="text-xs text-gray-500">
            All registered pg_cron jobs have written at least one row in the last 24h.
          </p>
        ) : (
          <ul className="text-xs text-gray-400 list-disc pl-5 space-y-1">
            {data.pg_cron_jobs_without_telemetry.map((name) => (
              <li key={name} className="font-mono">{name}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function rowTone(job: JobRow, nowMs: number): { label: string; text: string; dot: string } {
  if (job.last_run.status === 'failure') {
    return { label: 'FAILURE', text: 'text-red-400', dot: 'bg-red-500' };
  }
  if (job.last_run.status === 'running') {
    return { label: 'RUNNING', text: 'text-blue-400', dot: 'bg-blue-500' };
  }

  // success: check staleness.
  if (job.expected_cadence_min) {
    const lastMs = new Date(job.last_run.started_at).getTime();
    const ageMin = (nowMs - lastMs) / 60_000;
    if (ageMin > 2 * job.expected_cadence_min) {
      return { label: 'STALE', text: 'text-amber-400', dot: 'bg-amber-500' };
    }
  }

  return { label: 'OK', text: 'text-emerald-400', dot: 'bg-emerald-500' };
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}
