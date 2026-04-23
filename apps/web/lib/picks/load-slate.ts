import { createServiceRoleClient } from '@/lib/supabase/server';
import { cacheGet, cacheSet, CacheKeys, CacheTTL } from '@/lib/redis/cache';
import type { SubscriptionTier, MarketType } from '@/lib/types/database';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UserTier = 'anon' | 'free' | 'pro' | 'elite';
export type Visibility = 'live' | 'shadow' | 'all';

export interface ShapAttribution {
  feature: string;
  value: number;
  direction: 'positive' | 'negative';
}

export interface OddsSnapshot {
  label: string;
  price: number;
}

interface PickRow {
  id: string;
  pick_date: string;
  market: MarketType;
  pick_side: string;
  confidence_tier: number;
  required_tier: SubscriptionTier;
  result: string;
  visibility: 'live' | 'shadow';
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

export interface PickResponse {
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
  visibility: 'live' | 'shadow';
  result: string;
  best_line_price?: number;
  best_line_book?: string;
  /** Total runs for O/U markets (e.g. 8.5). Publicly visible — no tier gate. */
  total_line?: number;
  /** Run-line spread for RL markets (e.g. -1.5). Signed from the pick_side's perspective. */
  run_line_spread?: number;
  model_probability?: number;
  expected_value?: number;
  rationale_preview?: string;
  shap_attributions?: ShapAttribution[];
  line_snapshots?: OddsSnapshot[];
}

export interface PicksMeta {
  pipeline_ran: boolean;
  games_analyzed: number;
  below_threshold: number;
  ev_threshold: number;
  confidence_threshold: number;
}

export interface PicksSlateResponse {
  date: string;
  picks: PickResponse[];
  total: number;
  user_tier: UserTier;
  meta: PicksMeta;
}

export interface LoadPicksSlateOptions {
  userTier: UserTier;
  pickDate: string;
  market?: MarketType;
  minConfidence?: number;
  visibility?: Visibility;
}

// ---------------------------------------------------------------------------
// Tier entitlements — per api-contracts-v1.md tier table
// ---------------------------------------------------------------------------

function entitlementLevel(tier: UserTier): number {
  return { anon: 0, free: 0, pro: 1, elite: 2 }[tier];
}

function rationalePreview(text: string): string {
  const sentences = text.match(/[^.!?]+[.!?]+/g) ?? [];
  return sentences.slice(0, 2).join(' ').trim();
}

function normalizeShapAttributions(
  raw: PickRow['feature_attributions'],
): ShapAttribution[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  return raw.map((a) => ({
    feature: a.label ?? a.feature_name,
    value: a.shap_value,
    direction: a.direction,
  }));
}

function maskPick(
  row: PickRow,
  tier: UserTier,
  bookName: string | null,
  lineSnapshots: OddsSnapshot[] | undefined,
  lineValues: { total_line: number | null; run_line_spread: number | null } | undefined,
): PickResponse {
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
    visibility: row.visibility,
    result: row.result,
  };

  // Line values (total / run-line spread) are the public line numbers — always
  // attached regardless of tier so the UI can display "OVER 8.5" / "NYY -1.5".
  if (lineValues) {
    if (row.market === 'total' && lineValues.total_line !== null) {
      base.total_line = lineValues.total_line;
    }
    if (row.market === 'run_line' && lineValues.run_line_spread !== null) {
      // odds.run_line_spread is stored from home's perspective; flip for away picks
      // so the displayed value matches the side the user is actually taking.
      base.run_line_spread =
        row.pick_side === 'away'
          ? -lineValues.run_line_spread
          : lineValues.run_line_spread;
    }
  }

  if (level >= 1) {
    if (row.best_line_price !== null) base.best_line_price = row.best_line_price;
    if (bookName) base.best_line_book = bookName;
    if (row.model_probability !== null) base.model_probability = row.model_probability;
    if (row.rationale_cache?.rationale_text) {
      base.rationale_preview = rationalePreview(row.rationale_cache.rationale_text);
    }
    if (lineSnapshots && lineSnapshots.length >= 2) base.line_snapshots = lineSnapshots;
  }

  if (level >= 2) {
    if (row.expected_value !== null) base.expected_value = row.expected_value;
    const shap = normalizeShapAttributions(row.feature_attributions);
    if (shap) base.shap_attributions = shap;
  }

  return base;
}

// ---------------------------------------------------------------------------
// Public helper: today's pick-date in ET
// ---------------------------------------------------------------------------

export function todayInET(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// ---------------------------------------------------------------------------
// Public loader — shared by /api/picks/today and the page Server Components.
// Caller is responsible for auth/geo/tier gating before invoking.
// ---------------------------------------------------------------------------

export async function loadPicksSlate(opts: LoadPicksSlateOptions): Promise<PicksSlateResponse> {
  const { userTier, pickDate, market, minConfidence } = opts;
  const requestedVisibility = opts.visibility ?? 'live';

  const hasFilters = !!market || !!minConfidence;

  if (!hasFilters && requestedVisibility === 'live') {
    const cacheKey = CacheKeys.picksToday(pickDate, userTier);
    const cached = await cacheGet<PicksSlateResponse>(cacheKey);
    if (cached) {
      console.info({ event: 'picks_today_cache_hit', date: pickDate, tier: userTier });
      return cached;
    }
  }

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
      visibility,
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
        home_team:home_team_id ( id, name, abbreviation ),
        away_team:away_team_id ( id, name, abbreviation )
      ),
      sportsbooks:best_line_book_id ( name ),
      rationale_cache:rationale_id ( rationale_text )
    `)
    .eq('pick_date', pickDate)
    .order('confidence_tier', { ascending: false });

  if (requestedVisibility !== 'all') {
    query = query.eq('visibility', requestedVisibility);
  }

  if (userTier === 'anon' || userTier === 'free') {
    query = query.eq('required_tier', 'free');
  }

  if (market) {
    query = query.eq('market', market);
  }

  if (minConfidence) {
    query = query.gte('confidence_tier', minConfidence);
  }

  const { data: picksRaw, error: dbError } = await query;
  if (dbError) {
    console.error({ event: 'picks_today_db_error', date: pickDate, error: dbError });
    throw new Error('Failed to load picks.');
  }

  // Supabase v2's strict join-type inference doesn't resolve aliased FK joins cleanly;
  // cast to the known PickRow shape which matches the select() exactly.
  const picks = picksRaw as unknown as PickRow[] | null;

  // Latest odds per (game_id, market) — fetched for ALL tiers so we can surface
  // the line number (O/U total, RL spread) on the pick card. The `line_snapshots`
  // array (3 most recent) stays Pro+ gated further down.
  const entLevel = entitlementLevel(userTier);
  const lineSnapshotsByGameId = new Map<string, OddsSnapshot[]>();
  const lineValuesByKey = new Map<string, { total_line: number | null; run_line_spread: number | null }>();

  if (picks && picks.length > 0) {
    const uniqueGameIds = [...new Set(picks.map((p) => p.games?.id).filter(Boolean))] as string[];

    if (uniqueGameIds.length > 0) {
      const { data: oddsRows } = await serviceClient
        .from('odds')
        .select('game_id, market, home_price, away_price, over_price, under_price, total_line, run_line_spread, snapshotted_at')
        .in('game_id', uniqueGameIds)
        .order('snapshotted_at', { ascending: false });

      if (oddsRows) {
        const LABELS = ['Close', 'PM', 'AM'];
        const seenByGame = new Map<string, number>();

        for (const row of oddsRows as Array<{
          game_id: string;
          market: MarketType;
          home_price: number | null;
          away_price: number | null;
          over_price: number | null;
          under_price: number | null;
          total_line: number | null;
          run_line_spread: number | null;
          snapshotted_at: string;
        }>) {
          // Capture the first (= most recent) line value seen per (game, market).
          const key = `${row.game_id}:${row.market}`;
          if (!lineValuesByKey.has(key)) {
            lineValuesByKey.set(key, {
              total_line: row.total_line,
              run_line_spread: row.run_line_spread,
            });
          }

          if (entLevel < 1) continue;

          const count = seenByGame.get(row.game_id) ?? 0;
          if (count >= 3) continue;

          const price = row.home_price ?? row.over_price ?? row.away_price ?? row.under_price;
          if (price === null) continue;

          if (!lineSnapshotsByGameId.has(row.game_id)) {
            lineSnapshotsByGameId.set(row.game_id, []);
          }
          lineSnapshotsByGameId.get(row.game_id)!.push({
            label: LABELS[count] ?? `T-${count}`,
            price,
          });
          seenByGame.set(row.game_id, count + 1);
        }

        for (const [gameId, snapshots] of lineSnapshotsByGameId) {
          lineSnapshotsByGameId.set(gameId, snapshots.reverse());
        }
      }
    }
  }

  // Meta diagnostic
  const metaStart = Date.now();
  const [gamesCountResult, shadowCountResult, oddsRecencyResult] = await Promise.all([
    serviceClient
      .from('games')
      .select('id', { count: 'exact', head: true })
      .eq('game_date', pickDate),
    serviceClient
      .from('picks')
      .select('id', { count: 'exact', head: true })
      .eq('pick_date', pickDate)
      .eq('visibility', 'shadow'),
    serviceClient
      .from('odds')
      .select('snapshotted_at')
      .order('snapshotted_at', { ascending: false })
      .limit(1),
  ]);

  const gamesAnalyzed = gamesCountResult.count ?? 0;
  const belowThreshold = shadowCountResult.count ?? 0;
  const lastSnapshot = (oddsRecencyResult.data ?? [])[0]?.snapshotted_at as string | undefined;
  const snapshotAgeHours = lastSnapshot
    ? (Date.now() - new Date(lastSnapshot).getTime()) / 3_600_000
    : Infinity;
  const pipelineRan = gamesAnalyzed > 0 && snapshotAgeHours < 12;

  const meta: PicksMeta = {
    pipeline_ran: pipelineRan,
    games_analyzed: gamesAnalyzed,
    below_threshold: belowThreshold,
    ev_threshold: 0.08,
    confidence_threshold: 5,
  };

  console.info({
    event: 'picks_today_meta',
    date: pickDate,
    pipeline_ran: pipelineRan,
    games_analyzed: gamesAnalyzed,
    below_threshold: belowThreshold,
    ms: Date.now() - metaStart,
  });

  const maskedPicks: PickResponse[] = (picks ?? []).map((row) => {
    const bookName = row.sportsbooks?.name ?? null;
    const lineSnapshots = lineSnapshotsByGameId.get(row.games?.id ?? '') ?? undefined;
    const lineValues = lineValuesByKey.get(`${row.games?.id ?? ''}:${row.market}`);
    return maskPick(row, userTier, bookName, lineSnapshots, lineValues);
  });

  const response: PicksSlateResponse = {
    date: pickDate,
    picks: maskedPicks,
    total: maskedPicks.length,
    user_tier: userTier,
    meta,
  };

  if (!hasFilters && requestedVisibility === 'live') {
    const cacheKey = CacheKeys.picksToday(pickDate, userTier);
    await cacheSet(cacheKey, response, CacheTTL.PICKS_TODAY);
    console.info({ event: 'picks_today_cache_set', date: pickDate, tier: userTier, count: maskedPicks.length });
  }

  console.info({ event: 'picks_today_served', date: pickDate, tier: userTier, count: maskedPicks.length });

  return response;
}
