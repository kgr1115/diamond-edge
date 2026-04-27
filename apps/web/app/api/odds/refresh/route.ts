import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { runOddsPoll } from '@/lib/ingestion/odds/poll';
import { runOutcomeGrader } from '@/lib/outcome-grader/lib';
import { cacheInvalidate, CacheKeys } from '@/lib/redis/cache';
import { createServiceRoleClient } from '@/lib/supabase/server';
import type { Database } from '@/lib/types/database';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

/**
 * POST /api/odds/refresh
 *
 * User-triggered odds refresh. Gated to Elite tier to prevent free-tier spam
 * against the paid Odds API budget. The 10am ET cron handles routine refreshes;
 * this endpoint is for ad-hoc "pull fresh odds right now" before placing a bet.
 *
 * Rate limiting is handled implicitly by the Odds API's per-minute ceiling and
 * by the request-remaining budget in the response.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const cookieStore = await cookies();
  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll() { /* no-op in route handler */ },
      },
    }
  );

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Sign in required.' } },
      { status: 401 }
    );
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('subscription_tier')
    .eq('id', user.id)
    .single();

  if (profile?.subscription_tier !== 'elite') {
    return NextResponse.json(
      { error: { code: 'FORBIDDEN', message: 'Elite tier required for manual odds refresh.' } },
      { status: 403 }
    );
  }

  const startMs = Date.now();
  console.info(JSON.stringify({ level: 'info', event: 'manual_odds_refresh_start', user_id: user.id }));

  const result = await runOddsPoll();

  if (result.rowsInserted > 0) {
    const today = new Date().toISOString().slice(0, 10);
    for (const tier of ['anon', 'free', 'pro', 'elite']) {
      await cacheInvalidate(CacheKeys.picksToday(today, tier));
    }
    const serviceClient = createServiceRoleClient();
    const { data: games } = await serviceClient
      .from('games')
      .select('id')
      .eq('game_date', today)
      .in('status', ['scheduled', 'live']);
    if (games?.length) {
      const oddsKeys = games.map(g => CacheKeys.oddsGame(g.id));
      await cacheInvalidate(...oddsKeys);
    }
  }

  // Drain any pending pick grading in the same call. runOutcomeGrader is
  // idempotent (only acts on picks for games finalized ≥6h ago that don't
  // already have an outcome), so calling it here every time the user hits
  // refresh costs ~1 DB query when there's nothing pending. The grader has
  // its own try/catch and surfaces errors via the response — we don't want
  // grading failure to mask a successful odds poll, so we never throw.
  let gradedCount = 0;
  let gradeErrors: string[] = [];
  try {
    const graderRes = await runOutcomeGrader();
    const graderJson = (await graderRes.json()) as {
      graded?: number;
      errors?: string[];
    };
    gradedCount = graderJson.graded ?? 0;
    gradeErrors = graderJson.errors ?? [];
  } catch (err) {
    gradeErrors = [err instanceof Error ? err.message : String(err)];
  }

  const durationMs = Date.now() - startMs;
  console.info(JSON.stringify({
    level: result.errors.length > 0 || gradeErrors.length > 0 ? 'warn' : 'info',
    event: 'manual_odds_refresh_complete',
    durationMs,
    ...result,
    gradedCount,
    gradeErrors,
  }));

  return NextResponse.json({
    ok: result.errors.length === 0 && gradeErrors.length === 0,
    rowsInserted: result.rowsInserted,
    gradedCount,
    durationMs,
    errors: [...result.errors, ...gradeErrors],
  });
}
