import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { startCronRun, finishCronRun } from '@/lib/ops/cron-run-log';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Vercel Cron handler: GET /api/cron/calibration-snapshot
 * Scheduled: daily at 09:30 UTC (after outcome-grader at 08:00 UTC and
 * clv-compute at 09:00 UTC).
 *
 * Computes per-(market × tier) calibration aggregates over the trailing
 * 60-day window and upserts into `calibration_history`. Per
 * docs/ml/tier-calibration.md and pick-scope-gate-2026-04-28.md Proposal 8.
 *
 * Security: CRON_SECRET header required.
 *
 * pg_cron registration is hand-managed (see project memory
 * 2026-04-27 cron fix). Add the entry by running this SQL via Supabase MCP
 * after deploy:
 *
 *   SELECT cron.schedule(
 *     'calibration-snapshot',
 *     '30 9 * * *',
 *     $$ SELECT net.http_get(
 *       url := 'https://www.diamond-edge.co/api/cron/calibration-snapshot',
 *       headers := jsonb_build_object('Authorization','Bearer <SECRET>')
 *     ) $$
 *   );
 */

const MARKETS = ['moneyline', 'run_line', 'total'] as const;
const TIERS = [1, 2, 3, 4, 5] as const;

interface PickRow {
  market: string;
  confidence_tier: number;
  model_probability: number | null;
  result: string;
}

function ece(rows: PickRow[]): number {
  // Expected calibration error with 10 equal-width bins.
  if (rows.length === 0) return 0;
  const bins = Array.from({ length: 10 }, () => ({ probSum: 0, winSum: 0, n: 0 }));
  for (const r of rows) {
    if (r.model_probability == null) continue;
    if (r.result !== 'win' && r.result !== 'loss') continue;
    const idx = Math.min(9, Math.max(0, Math.floor(r.model_probability * 10)));
    bins[idx].probSum += r.model_probability;
    bins[idx].winSum += r.result === 'win' ? 1 : 0;
    bins[idx].n += 1;
  }
  const total = bins.reduce((s, b) => s + b.n, 0);
  if (total === 0) return 0;
  let weighted = 0;
  for (const b of bins) {
    if (b.n === 0) continue;
    const meanProb = b.probSum / b.n;
    const meanWin = b.winSum / b.n;
    weighted += (b.n / total) * Math.abs(meanProb - meanWin);
  }
  return weighted;
}

function brier(rows: PickRow[]): number {
  // Mean squared error of probability vs binary outcome.
  let sum = 0, n = 0;
  for (const r of rows) {
    if (r.model_probability == null) continue;
    if (r.result !== 'win' && r.result !== 'loss') continue;
    const y = r.result === 'win' ? 1 : 0;
    sum += (r.model_probability - y) ** 2;
    n += 1;
  }
  return n > 0 ? sum / n : 0;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Unauthorized.' } },
      { status: 401 },
    );
  }

  const runHandle = await startCronRun('calibration-snapshot');
  const startMs = Date.now();
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  try {
    const service = createServiceRoleClient();
    const cutoffISO = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();

    const { data: picksData, error: picksErr } = await service
      .from('picks')
      .select('market, confidence_tier, model_probability, result, generated_at')
      .gte('generated_at', cutoffISO)
      .limit(5000);

    if (picksErr) {
      await finishCronRun(runHandle, { status: 'failure', errorMsg: picksErr.message });
      return NextResponse.json(
        { error: { code: 'DB_ERROR', message: picksErr.message } },
        { status: 500 },
      );
    }

    const rows = (picksData ?? []) as PickRow[];

    interface Snapshot {
      snapshot_date: string;
      market: string;
      confidence_tier: number;
      predicted_win_rate: number | null;
      actual_win_rate: number | null;
      n_picks: number;
      n_graded: number;
      ece: number | null;
      brier_score: number | null;
    }
    const snapshots: Snapshot[] = [];
    for (const market of MARKETS) {
      for (const tier of TIERS) {
        const cellRows = rows.filter(
          (r) => r.market === market && r.confidence_tier === tier,
        );
        const graded = cellRows.filter((r) => r.result === 'win' || r.result === 'loss');
        const wins = graded.filter((r) => r.result === 'win').length;
        const probs = cellRows
          .map((r) => r.model_probability)
          .filter((p): p is number => typeof p === 'number');

        snapshots.push({
          snapshot_date: today,
          market,
          confidence_tier: tier,
          predicted_win_rate: probs.length ? probs.reduce((a, b) => a + b, 0) / probs.length : null,
          actual_win_rate: graded.length ? wins / graded.length : null,
          n_picks: cellRows.length,
          n_graded: graded.length,
          ece: graded.length ? ece(cellRows) : null,
          brier_score: graded.length ? brier(cellRows) : null,
        });
      }
    }

    // calibration_history is added in migration 0020 — until generated types
    // catch up, cast through unknown for the typed-builder shape mismatch.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: upsertErr } = await (service.from('calibration_history') as any)
      .upsert(snapshots, { onConflict: 'snapshot_date,market,confidence_tier' });

    if (upsertErr) {
      await finishCronRun(runHandle, { status: 'failure', errorMsg: upsertErr.message });
      return NextResponse.json(
        { error: { code: 'DB_ERROR', message: upsertErr.message } },
        { status: 500 },
      );
    }

    await finishCronRun(runHandle, { status: 'success', errorMsg: null });
    return NextResponse.json({
      ok: true,
      snapshot_date: today,
      cells_written: snapshots.length,
      duration_ms: Date.now() - startMs,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await finishCronRun(runHandle, { status: 'failure', errorMsg: msg });
    return NextResponse.json(
      { error: { code: 'UNEXPECTED', message: msg } },
      { status: 500 },
    );
  }
}

export const POST = GET;
