import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { cacheGet, cacheSet, CacheKeys, CacheTTL } from '@/lib/redis/cache';
import type { SubscriptionTier, MarketType } from '@/lib/types/database';

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
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PickRow {
  id: string;
  pick_date: string;
  market: MarketType;
  pick_side: string;
  confidence_tier: number;
  required_tier: SubscriptionTier;
  result: string;
  best_line_price: number | null;
  best_line_book_id: string | null;
  model_probability: number | null;
  expected_value: number | null;
  rationale_id: string | null;
  games: {
    id: string;
    game_time_utc: string | null;
    status: string;
    home_team: { id: string; name: string; abbreviation: string } | null;
    away_team: { id: string; name: string; abbreviation: string } | null;
  } | null;
  sportsbooks: { name: string } | null;
  rationale_cache: { rationale_text: string } | null;
}

interface PickResponse {
  id: string;
  game: {
    id: string;
    home_team: { id: string; name: string; abbreviation: string };
    away_team: { id: string; name: string; abbreviation: string };
    game_time_utc: string | null;
    status: string;
  };
  market: string;
  pick_side: string;
  confidence_tier: number;
  required_tier: string;
  result: string;
  best_line_price?: number;
  best_line_book?: string;
  model_probability?: number;
  expected_value?: number;
  rationale_preview?: string;
}

// ---------------------------------------------------------------------------
// Tier entitlements — per api-contracts-v1.md tier table
// ---------------------------------------------------------------------------

type UserTier = 'anon' | 'free' | 'pro' | 'elite';

function entitlementLevel(tier: UserTier): number {
  return { anon: 0, free: 0, pro: 1, elite: 2 }[tier];
}

/** Extract the first two sentences from a rationale text blob. */
function rationalePreview(text: string): string {
  const sentences = text.match(/[^.!?]+[.!?]+/g) ?? [];
  return sentences.slice(0, 2).join(' ').trim();
}

/** Apply column masking based on caller's tier. Returns a clean, serializable object. */
function maskPick(row: PickRow, tier: UserTier, bookName: string | null): PickResponse {
  const level = entitlementLevel(tier);

  const base: PickResponse = {
    id: row.id,
    game: {
      id: row.games?.id ?? '',
      home_team: row.games?.home_team ?? { id: '', name: '', abbreviation: '' },
      away_team: row.games?.away_team ?? { id: '', name: '', abbreviation: '' },
      game_time_utc: row.games?.game_time_utc ?? null,
      status: row.games?.status ?? 'scheduled',
    },
    market: row.market,
    pick_side: row.pick_side,
    confidence_tier: row.confidence_tier,
    required_tier: row.required_tier,
    result: row.result,
  };

  // Pro+ fields (level >= 1)
  if (level >= 1) {
    if (row.best_line_price !== null) base.best_line_price = row.best_line_price;
    if (bookName) base.best_line_book = bookName;
    if (row.model_probability !== null) base.model_probability = row.model_probability;
    if (row.rationale_cache?.rationale_text) {
      base.rationale_preview = rationalePreview(row.rationale_cache.rationale_text);
    }
  }

  // Elite-only fields (level >= 2)
  if (level >= 2) {
    if (row.expected_value !== null) base.expected_value = row.expected_value;
  }

  return base;
}

// ---------------------------------------------------------------------------
// ET date helper — default date is "today in Eastern Time"
// ---------------------------------------------------------------------------

function todayInET(): string {
  return new Date()
    .toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest): Promise<NextResponse> {
  // 1. Parse query params
  const { searchParams } = request.nextUrl;
  const parsed = QUERY_SCHEMA.safeParse({
    market: searchParams.get('market') ?? undefined,
    min_confidence: searchParams.get('min_confidence') ?? undefined,
    date: searchParams.get('date') ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Invalid query parameters.', details: parsed.error.flatten() } },
      { status: 422 }
    );
  }

  const { market, min_confidence, date: requestedDate } = parsed.data;
  const pickDate = requestedDate ?? todayInET();

  // 2. Resolve caller tier
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  let userTier: UserTier = 'anon';
  if (user) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('subscription_tier, geo_blocked, age_verified')
      .eq('id', user.id)
      .single();

    // Backend defense-in-depth geo check per geo-block-spec.md
    if (profile?.geo_blocked) {
      return NextResponse.json(
        { error: { code: 'GEO_RESTRICTED', message: 'This service is not available in your location.' } },
        { status: 403 }
      );
    }

    userTier = (profile?.subscription_tier as UserTier) ?? 'free';
  } else {
    // Unauthenticated — check IP geo via Vercel edge header set by middleware
    const geoState = request.headers.get('x-geo-state');
    const xGeoBlocked = request.headers.get('x-geo-blocked');
    if (xGeoBlocked === 'true' || !geoState) {
      return NextResponse.json(
        { error: { code: 'GEO_RESTRICTED', message: 'This service is not available in your location.' } },
        { status: 403 }
      );
    }
  }

  // 3. Check Redis cache (skip cache if filter params are present — cache stores full slate)
  const hasFilters = !!market || !!min_confidence;
  let cacheKey: string | null = null;

  if (!hasFilters) {
    cacheKey = CacheKeys.picksToday(pickDate, userTier);
    const cached = await cacheGet<{ date: string; picks: PickResponse[]; total: number; user_tier: UserTier }>(cacheKey);
    if (cached) {
      console.info({ event: 'picks_today_cache_hit', date: pickDate, tier: userTier });
      return NextResponse.json(cached, { status: 200 });
    }
  }

  // 4. Query DB (service role for clean read; RLS already filters on the anon/authenticated session,
  //    but we apply tier masking in code so we need all columns)
  const serviceClient = createServiceRoleClient();

  let query = serviceClient
    .from('picks')
    .select(`
      id,
      pick_date,
      market,
      pick_side,
      confidence_tier,
      required_tier,
      result,
      best_line_price,
      best_line_book_id,
      model_probability,
      expected_value,
      rationale_id,
      games!inner (
        id,
        game_time_utc,
        status,
        home_team:home_team_id ( id, name, abbreviation ),
        away_team:away_team_id ( id, name, abbreviation )
      ),
      sportsbooks:best_line_book_id ( name ),
      rationale_cache:rationale_id ( rationale_text )
    `)
    .eq('pick_date', pickDate)
    .order('confidence_tier', { ascending: false });

  // For anon/free users, only show free-tier picks
  if (userTier === 'anon' || userTier === 'free') {
    query = query.eq('required_tier', 'free');
  }

  if (market) {
    query = query.eq('market', market);
  }

  if (min_confidence) {
    query = query.gte('confidence_tier', min_confidence);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: picksRaw, error: dbError } = await query;
  // Supabase v2's strict join-type inference doesn't resolve aliased FK joins for nested
  // relations when Relationships arrays aren't exhaustive. Cast to the known PickRow shape
  // which matches the select() call above exactly.
  const picks = picksRaw as unknown as PickRow[] | null;

  if (dbError) {
    console.error({ event: 'picks_today_db_error', date: pickDate, error: dbError });
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to load picks.' } },
      { status: 500 }
    );
  }

  // 5. Apply tier masking and shape response
  const maskedPicks: PickResponse[] = (picks ?? []).map((row) => {
    const bookName = row.sportsbooks?.name ?? null;
    return maskPick(row, userTier, bookName);
  });

  const response = {
    date: pickDate,
    picks: maskedPicks,
    total: maskedPicks.length,
    user_tier: userTier,
  };

  // 6. Populate cache (only for unfiltered full-slate requests)
  if (cacheKey) {
    await cacheSet(cacheKey, response, CacheTTL.PICKS_TODAY);
    console.info({ event: 'picks_today_cache_set', date: pickDate, tier: userTier, count: maskedPicks.length });
  }

  console.info({ event: 'picks_today_served', date: pickDate, tier: userTier, count: maskedPicks.length });

  return NextResponse.json(response, { status: 200 });
}
