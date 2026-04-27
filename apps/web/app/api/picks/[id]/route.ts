import { NextRequest, NextResponse } from 'next/server';
import { createClient, createServiceRoleClient } from '@/lib/supabase/server';
import { paidTiersEnabled } from '@/lib/feature-flags';
import { normalizeShapAttributions } from '@/lib/picks/load-slate';
import type { SubscriptionTier, MarketType, PickResult } from '@/lib/types/database';

export const dynamic = 'force-dynamic';

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
  result: PickResult;
  generated_at: string;
  best_line_price: number | null;
  best_line_book_id: string | null;
  model_probability: number | null;
  expected_value: number | null;
  rationale_id: string | null;
  feature_attributions: Array<{
    feature_name: string;
    feature_value: number | string;
    shap_value: number;
    direction: 'positive' | 'negative';
    label: string;
  }> | null;
  game_id: string;
  games: {
    id: string;
    game_time_utc: string | null;
    status: string;
    home_team_id: string;
    away_team_id: string;
    weather_condition: string | null;
    weather_temp_f: number | null;
    weather_wind_mph: number | null;
    weather_wind_dir: string | null;
    probable_home_pitcher_id: string | null;
    probable_away_pitcher_id: string | null;
    home_team: { id: string; name: string; abbreviation: string } | null;
    away_team: { id: string; name: string; abbreviation: string } | null;
  } | null;
  sportsbooks: { id: string; name: string } | null;
  rationale_cache: { rationale_text: string } | null;
}

interface BookLine {
  price: number | null;
  book: string;
}

export interface PickDetailApiResponse {
  pick: {
    id: string;
    game: {
      id: string;
      home_team: { id: string; name: string; abbreviation: string };
      away_team: { id: string; name: string; abbreviation: string };
      game_time_utc: string;
      status: string;
      probable_home_pitcher: { id: string; full_name: string } | null;
      probable_away_pitcher: { id: string; full_name: string } | null;
      weather: { condition: string; temp_f: number; wind_mph: number; wind_dir: string } | null;
    };
    market: string;
    pick_side: string;
    confidence_tier: number;
    required_tier: string;
    result: string;
    generated_at: string;
    best_line_price?: number;
    best_line_book?: string;
    dk_line?: BookLine;
    fd_line?: BookLine;
    model_probability?: number;
    expected_value?: number;
    rationale?: string;
    shap_attributions?: Array<{
      feature: string;
      value: number;
      direction: 'positive' | 'negative';
    }>;
    outcome?: {
      result: 'win' | 'loss' | 'push' | 'void';
      home_score: number;
      away_score: number;
      graded_at: string;
    };
  };
}

type UserTier = 'anon' | 'free' | 'pro' | 'elite';

function entitlementLevel(tier: UserTier): number {
  return { anon: 0, free: 0, pro: 1, elite: 2 }[tier];
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  // Validate UUID format
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: 'Pick not found.' } },
      { status: 404 }
    );
  }

  // 1. Resolve caller tier. Portfolio mode: every viewer is elite-equivalent so
  // rationale, EV, SHAP, and line-shopping fields render unmasked. Skip the
  // Supabase auth round-trip entirely.
  let userTier: UserTier = 'anon';
  if (!paidTiersEnabled()) {
    userTier = 'elite';
  } else {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (user) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('subscription_tier, geo_blocked')
        .eq('id', user.id)
        .single();

      if (profile?.geo_blocked) {
        return NextResponse.json(
          { error: { code: 'GEO_RESTRICTED', message: 'This service is not available in your location.' } },
          { status: 403 }
        );
      }

      userTier = (profile?.subscription_tier as UserTier) ?? 'free';
    }
  }

  const level = entitlementLevel(userTier);

  // 2. Fetch the pick
  const serviceClient = createServiceRoleClient();

  const { data: rawPick, error: pickError } = await serviceClient
    .from('picks')
    .select(`
      id,
      pick_date,
      game_id,
      market,
      pick_side,
      confidence_tier,
      required_tier,
      result,
      generated_at,
      best_line_price,
      best_line_book_id,
      model_probability,
      expected_value,
      rationale_id,
      feature_attributions,
      games!inner (
        id,
        game_time_utc,
        status,
        home_team_id,
        away_team_id,
        weather_condition,
        weather_temp_f,
        weather_wind_mph,
        weather_wind_dir,
        probable_home_pitcher_id,
        probable_away_pitcher_id,
        home_team:home_team_id ( id, name, abbreviation ),
        away_team:away_team_id ( id, name, abbreviation )
      ),
      sportsbooks:best_line_book_id ( id, name ),
      rationale_cache:rationale_id ( rationale_text )
    `)
    .eq('id', id)
    .single();

  if (pickError || !rawPick) {
    if (pickError?.code === 'PGRST116') {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Pick not found.' } },
        { status: 404 }
      );
    }
    console.error({ event: 'pick_detail_db_error', id, error: pickError });
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to load pick.' } },
      { status: 500 }
    );
  }

  const pick = rawPick as unknown as PickRow;

  // 3. Fetch probable pitchers by ID if present
  const pitcherIds = [
    pick.games?.probable_home_pitcher_id,
    pick.games?.probable_away_pitcher_id,
  ].filter(Boolean) as string[];

  const pitcherMap = new Map<string, { id: string; full_name: string }>();
  if (pitcherIds.length > 0) {
    const { data: pitchers } = await serviceClient
      .from('players')
      .select('id, full_name')
      .in('id', pitcherIds);
    if (pitchers) {
      for (const p of pitchers) {
        pitcherMap.set(p.id, p);
      }
    }
  }

  // 4. Fetch DK + FD lines for this game/market (for line shopping — required on every pick)
  let dkLine: BookLine | undefined;
  let fdLine: BookLine | undefined;

  if (level >= 1 && pick.games?.id) {
    const { data: oddsRows } = await serviceClient
      .from('odds')
      .select(`
        market,
        home_price,
        away_price,
        over_price,
        under_price,
        prop_over_price,
        prop_under_price,
        run_line_spread,
        sportsbooks!inner ( id, key, name )
      `)
      .eq('game_id', pick.games.id)
      .eq('market', pick.market)
      .in('sportsbooks.key', ['draftkings', 'fanduel'])
      .order('snapshotted_at', { ascending: false })
      .limit(10);

    if (oddsRows) {
      // Take the most recent snapshot per book
      const seenBooks = new Set<string>();
      for (const row of oddsRows as unknown as Array<{
        market: MarketType;
        home_price: number | null;
        away_price: number | null;
        over_price: number | null;
        under_price: number | null;
        prop_over_price: number | null;
        prop_under_price: number | null;
        run_line_spread: number | null;
        sportsbooks: { id: string; key: string; name: string };
      }>) {
        const bookKey = row.sportsbooks?.key;
        if (!bookKey || seenBooks.has(bookKey)) continue;
        seenBooks.add(bookKey);

        // Determine the relevant price for this pick_side + market
        const price = resolvePriceForSide(pick.pick_side, pick.market, row);
        const bookLine: BookLine = { price, book: row.sportsbooks.name };

        if (bookKey === 'draftkings') dkLine = bookLine;
        if (bookKey === 'fanduel') fdLine = bookLine;
      }
    }
  }

  // 5. Fetch graded outcome if pick is no longer pending. pick_outcomes has
  // RLS public-SELECT (migration 0005:73), so we read from it via the same
  // service client. PnL is computed client-side via computePnL — pick_outcomes
  // intentionally does NOT store pnl_units.
  let outcomeRow:
    | { result: 'win' | 'loss' | 'push' | 'void'; home_score: number; away_score: number; graded_at: string }
    | null = null;

  if (pick.result !== 'pending') {
    const { data: outcomeData } = await serviceClient
      .from('pick_outcomes')
      .select('result, home_score, away_score, graded_at')
      .eq('pick_id', pick.id)
      .maybeSingle();
    if (outcomeData) {
      outcomeRow = outcomeData as unknown as typeof outcomeRow;
    }
  }

  // 6. Build response — apply tier masking
  const game = pick.games;
  const homePitcherId = game?.probable_home_pitcher_id;
  const awayPitcherId = game?.probable_away_pitcher_id;

  const weather =
    game?.weather_condition != null &&
    game?.weather_temp_f != null &&
    game?.weather_wind_mph != null &&
    game?.weather_wind_dir != null
      ? {
          condition: game.weather_condition,
          temp_f: game.weather_temp_f,
          wind_mph: game.weather_wind_mph,
          wind_dir: game.weather_wind_dir,
        }
      : null;

  const response: PickDetailApiResponse = {
    pick: {
      id: pick.id,
      game: {
        id: game?.id ?? '',
        home_team: game?.home_team ?? { id: '', name: 'TBD', abbreviation: 'TBD' },
        away_team: game?.away_team ?? { id: '', name: 'TBD', abbreviation: 'TBD' },
        game_time_utc: game?.game_time_utc ?? new Date().toISOString(),
        status: game?.status ?? 'scheduled',
        probable_home_pitcher: homePitcherId ? (pitcherMap.get(homePitcherId) ?? null) : null,
        probable_away_pitcher: awayPitcherId ? (pitcherMap.get(awayPitcherId) ?? null) : null,
        weather,
      },
      market: pick.market,
      pick_side: pick.pick_side,
      confidence_tier: pick.confidence_tier,
      required_tier: pick.required_tier,
      result: pick.result,
      generated_at: pick.generated_at,
    },
  };

  // Pro+ fields
  if (level >= 1) {
    if (pick.best_line_price != null) response.pick.best_line_price = pick.best_line_price;
    if (pick.sportsbooks?.name) response.pick.best_line_book = pick.sportsbooks.name;
    if (pick.model_probability != null) response.pick.model_probability = pick.model_probability;
    if (pick.rationale_cache?.rationale_text) {
      response.pick.rationale = pick.rationale_cache.rationale_text;
    }
    if (dkLine) response.pick.dk_line = dkLine;
    if (fdLine) response.pick.fd_line = fdLine;
  }

  // Elite-only fields
  if (level >= 2) {
    if (pick.expected_value != null) response.pick.expected_value = pick.expected_value;
    const shap = normalizeShapAttributions(pick.feature_attributions);
    if (shap) response.pick.shap_attributions = shap;
  }

  // Graded outcome — visible to all tiers (including anon) since pick_outcomes
  // is public-SELECT and the result is already exposed via pick.result.
  if (outcomeRow) {
    response.pick.outcome = outcomeRow;
  }

  return NextResponse.json(response, {
    status: 200,
    headers: {
      // Short TTL — odds move. 60s is fine for a detail page.
      'Cache-Control': 'private, max-age=10',
    },
  });
}

// ---------------------------------------------------------------------------
// PATCH — update journal fields (user_note, user_tags) for a pick
// ---------------------------------------------------------------------------

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: 'Pick not found.' } },
      { status: 404 }
    );
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Login required.' } },
      { status: 401 }
    );
  }

  let body: { user_note?: string; user_tags?: string[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'BAD_REQUEST', message: 'Invalid JSON body.' } },
      { status: 400 }
    );
  }

  const { user_note, user_tags } = body;

  if (user_note !== undefined && typeof user_note !== 'string') {
    return NextResponse.json(
      { error: { code: 'BAD_REQUEST', message: 'user_note must be a string.' } },
      { status: 400 }
    );
  }
  if (user_tags !== undefined && (!Array.isArray(user_tags) || user_tags.some((t) => typeof t !== 'string'))) {
    return NextResponse.json(
      { error: { code: 'BAD_REQUEST', message: 'user_tags must be a string array.' } },
      { status: 400 }
    );
  }

  const patch: { user_note?: string | null; user_tags?: string[] } = {};
  if (user_note !== undefined) patch.user_note = user_note.trim() || null;
  if (user_tags !== undefined) patch.user_tags = user_tags.map((t) => t.trim()).filter(Boolean);

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ ok: true });
  }

  const service = createServiceRoleClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (service as any).from('picks').update(patch).eq('id', id);

  if (error) {
    console.error({ event: 'pick_journal_patch_error', id, error });
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to save journal entry.' } },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolvePriceForSide(
  pickSide: string,
  market: MarketType,
  row: {
    home_price: number | null;
    away_price: number | null;
    over_price: number | null;
    under_price: number | null;
    prop_over_price: number | null;
    prop_under_price: number | null;
  }
): number | null {
  const side = pickSide.toLowerCase();

  if (market === 'moneyline' || market === 'run_line') {
    if (side.includes('home')) return row.home_price;
    if (side.includes('away')) return row.away_price;
    return row.home_price ?? row.away_price;
  }

  if (market === 'total') {
    if (side.includes('over')) return row.over_price;
    if (side.includes('under')) return row.under_price;
    return row.over_price ?? row.under_price;
  }

  if (market === 'prop') {
    if (side.includes('over')) return row.prop_over_price;
    if (side.includes('under')) return row.prop_under_price;
    return row.prop_over_price ?? row.prop_under_price;
  }

  return null;
}
