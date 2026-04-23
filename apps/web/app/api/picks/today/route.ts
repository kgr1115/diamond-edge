import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const dynamic = 'force-dynamic';
import { createClient } from '@/lib/supabase/server';
import { loadPicksSlate, todayInET, type UserTier } from '@/lib/picks/load-slate';
import type { MarketType } from '@/lib/types/database';

// ---------------------------------------------------------------------------
// Query param validation
// ---------------------------------------------------------------------------

const QUERY_SCHEMA = z.object({
  market: z
    .enum(['moneyline', 'run_line', 'total', 'prop', 'parlay', 'future'])
    .optional(),
  min_confidence: z.coerce.number().int().min(1).max(5).optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  visibility: z.enum(['live', 'shadow', 'all']).optional(),
});

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = request.nextUrl;
  const parsed = QUERY_SCHEMA.safeParse({
    market: searchParams.get('market') ?? undefined,
    min_confidence: searchParams.get('min_confidence') ?? undefined,
    date: searchParams.get('date') ?? undefined,
    visibility: searchParams.get('visibility') ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Invalid query parameters.', details: parsed.error.flatten() } },
      { status: 422 }
    );
  }

  const { market, min_confidence, date: requestedDate, visibility: visibilityParam } = parsed.data;
  const pickDate = requestedDate ?? todayInET();

  // Resolve caller tier + geo
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  let userTier: UserTier = 'anon';
  if (user) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('subscription_tier, geo_blocked, age_verified')
      .eq('id', user.id)
      .single();

    if (profile?.geo_blocked) {
      return NextResponse.json(
        { error: { code: 'GEO_RESTRICTED', message: 'This service is not available in your location.' } },
        { status: 403 }
      );
    }

    userTier = (profile?.subscription_tier as UserTier) ?? 'free';
  } else {
    const geoState = request.headers.get('x-geo-state');
    const xGeoBlocked = request.headers.get('x-geo-blocked');
    if (xGeoBlocked === 'true' || !geoState) {
      return NextResponse.json(
        { error: { code: 'GEO_RESTRICTED', message: 'This service is not available in your location.' } },
        { status: 403 }
      );
    }
  }

  // Shadow/all visibility requires Pro+ auth — free/anon get 401 so client can show upgrade prompt.
  const requestedVisibility = visibilityParam ?? 'live';
  const wantsNonLive = requestedVisibility === 'shadow' || requestedVisibility === 'all';
  if (wantsNonLive && (!user || userTier === 'free')) {
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Shadow picks require a Pro or Elite subscription.' } },
      { status: 401 }
    );
  }

  try {
    const response = await loadPicksSlate({
      userTier,
      pickDate,
      market: market as MarketType | undefined,
      minConfidence: min_confidence,
      visibility: requestedVisibility,
    });
    return NextResponse.json(response, { status: 200 });
  } catch {
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to load picks.' } },
      { status: 500 }
    );
  }
}
