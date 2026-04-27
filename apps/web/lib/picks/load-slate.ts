import { createServiceRoleClient } from '@/lib/supabase/server';
import { cacheGet, cacheSet, CacheKeys, CacheTTL } from '@/lib/redis/cache';
import { paidTiersEnabled } from '@/lib/feature-flags';
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
  generated_at: string | null;
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
  /** True when THIS pick's pinned odds snapshot is older than ODDS_STALE_MIN.
   *  Per-pick narrowing of the slate-level meta.odds_stale flag — only the
   *  pick whose own book/snapshot is stale gets the warning, not every card. */
  odds_stale?: boolean;
  /** ISO timestamp of the pinned odds snapshot this pick was priced against.
   *  Lets the card render "Odds updated 12m ago" without re-querying. */
  odds_snapshot_at?: string;
}

export interface PicksMeta {
  pipeline_ran: boolean;
  games_analyzed: number;
  below_threshold: number;
  ev_threshold: number;
  confidence_threshold: number;
  /** ISO timestamp of the most recent row in `odds`. Null if none found. */
  last_odds_snapshot_at: string | null;
  /** True when snapshot age exceeds ODDS_STALE_MIN. */
  odds_stale: boolean;
}

// Freshness thresholds (minutes). Single source of truth — do not duplicate
// in UI components. Odds-poll runs daily at 10:00 ET via schedule-sync, so a
// 90-minute staleness window gives one full cron cycle of tolerance during
// game-day hours. Amber is early warning, red is escalate-now.
export const ODDS_STALE_MIN = 90;
export const ODDS_AMBER_MIN = 60;
export const ODDS_RED_MIN = 180;

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

export function normalizeShapAttributions(
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
  oddsStale: boolean,
  oddsSnapshotAt: string | undefined,
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
    odds_stale: oddsStale,
    ...(oddsSnapshotAt ? { odds_snapshot_at: oddsSnapshotAt } : {}),
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
  // Portfolio mode: every viewer is treated as Elite so all fields (price, EV,
  // rationale, SHAP, line snapshots) render unmasked. The maskPick helper itself
  // is preserved verbatim — we just bypass tier downgrades by forcing the input.
  const userTier: UserTier = paidTiersEnabled() ? opts.userTier : 'elite';
  const { pickDate, market, minConfidence } = opts;
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
      generated_at,
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

  // Free/anon viewers see live picks too — `maskPick` below strips tier-gated
  // fields (price, rationale, EV, SHAP, line snapshots) and the PickCard renders
  // an upgrade-to-Pro paywall nudge. Filtering by `required_tier='free'` here
  // produced an empty slate because the pipeline only emits `pro`/`elite` picks
  // by design (per TASK-010-pre), making the paywall UI unreachable.

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

  // Odds rows fetched for ALL tiers so we can surface the line number
  // (O/U total, RL spread) on the pick card. The `line_snapshots` array
  // (3 most recent) stays Pro+ gated further down.
  //
  // Line values must be pinned to the SAME (sportsbook, snapshot) the pick was
  // priced against — otherwise the displayed total/spread can come from a later
  // snapshot (e.g. live in-game alternate lines) while the price comes from
  // pre-game close, producing the displayed-vs-actual mismatch Kyle reported on
  // 2026-04-24 where pre-game total 9.0 picks rendered as "OVER 12.5".
  // Falls back to most-recent-by-(game,market) only if no snapshot at-or-before
  // generated_at can be matched on (game, market, best_line_book_id).
  const entLevel = entitlementLevel(userTier);
  const lineSnapshotsByGameId = new Map<string, OddsSnapshot[]>();
  const lineValuesByPickId = new Map<string, { total_line: number | null; run_line_spread: number | null }>();
  // Per-pick pinned-snapshot timestamp — used to compute per-pick odds_stale
  // below. Populated for ALL pick markets (not just total/run_line) so the
  // moneyline cards also get an accurate per-card freshness signal.
  const pinnedSnapshotAtByPickId = new Map<string, string>();

  if (picks && picks.length > 0) {
    const uniqueGameIds = [...new Set(picks.map((p) => p.games?.id).filter(Boolean))] as string[];

    if (uniqueGameIds.length > 0) {
      const { data: oddsRows } = await serviceClient
        .from('odds')
        .select('game_id, sportsbook_id, market, home_price, away_price, over_price, under_price, total_line, run_line_spread, snapshotted_at')
        .in('game_id', uniqueGameIds)
        .order('snapshotted_at', { ascending: false });

      type OddsRow = {
        game_id: string;
        sportsbook_id: string;
        market: MarketType;
        home_price: number | null;
        away_price: number | null;
        over_price: number | null;
        under_price: number | null;
        total_line: number | null;
        run_line_spread: number | null;
        snapshotted_at: string;
      };

      const oddsRowsTyped = (oddsRows ?? []) as OddsRow[];

      // Index odds by (game_id, market) for the per-pick line-value lookup +
      // by game for the line_snapshots sparkline. Rows are pre-sorted DESC by
      // snapshotted_at so iteration order = newest-first.
      const oddsByGameMarket = new Map<string, OddsRow[]>();
      for (const row of oddsRowsTyped) {
        const key = `${row.game_id}:${row.market}`;
        if (!oddsByGameMarket.has(key)) oddsByGameMarket.set(key, []);
        oddsByGameMarket.get(key)!.push(row);
      }

      // Per-pick snapshot pinning. Match on the pick's best_line_book_id +
      // newest snapshot at-or-before generated_at. If no exact-book match,
      // fall back to most-recent-pre-pick row of any book on that game+market.
      // If even that fails, fall back to the most-recent row period (preserves
      // prior behavior for pre-fix picks lacking a sane generated_at).
      // Runs for every pick market so moneyline picks also pin a snapshot for
      // the per-card staleness signal — line-value extraction below is then
      // gated to total/run_line only.
      for (const pick of picks) {
        const gid = pick.games?.id;
        if (!gid) continue;

        const bucket = oddsByGameMarket.get(`${gid}:${pick.market}`) ?? [];
        if (bucket.length === 0) continue;

        const generatedAtMs = pick.generated_at ? new Date(pick.generated_at).getTime() : NaN;
        // 5-minute slack: pick.generated_at is set when the worker returns,
        // odds row snapshotted_at may be a few seconds later if the same pull
        // wrote both. Guards against off-by-a-few-seconds clock drift.
        const cutoffMs = Number.isFinite(generatedAtMs) ? generatedAtMs + 5 * 60_000 : Infinity;

        const eligibleAtCutoff = (r: OddsRow) =>
          new Date(r.snapshotted_at).getTime() <= cutoffMs;

        const sameBookPrePick = pick.best_line_book_id
          ? bucket.find((r) => r.sportsbook_id === pick.best_line_book_id && eligibleAtCutoff(r))
          : undefined;

        const anyBookPrePick = sameBookPrePick ?? bucket.find(eligibleAtCutoff);

        const matched = anyBookPrePick ?? bucket[0];
        pinnedSnapshotAtByPickId.set(pick.id, matched.snapshotted_at);

        if (pick.market === 'total' || pick.market === 'run_line') {
          lineValuesByPickId.set(pick.id, {
            total_line: matched.total_line,
            run_line_spread: matched.run_line_spread,
          });
        }
      }

      // Pro+ sparkline: 3 most-recent snapshots per game. Note this still mixes
      // books across snapshots — the sparkline shows market-wide trajectory,
      // not a single book. Improving this is tracked separately; not the bug
      // Kyle reported on the cards.
      if (entLevel >= 1) {
        const LABELS = ['Close', 'PM', 'AM'];
        const seenByGame = new Map<string, number>();

        for (const row of oddsRowsTyped) {
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
  const snapshotAgeMs = lastSnapshot ? Date.now() - new Date(lastSnapshot).getTime() : Infinity;
  const snapshotAgeHours = snapshotAgeMs / 3_600_000;
  const pipelineRan = gamesAnalyzed > 0 && snapshotAgeHours < 12;

  // Clock-drift guard: a future snapshot (client clock skew in theory, server
  // clock skew in practice) must not panic the UI — treat as fresh.
  const snapshotAgeMinNonNegative = Math.max(0, snapshotAgeMs / 60_000);
  const oddsStale = lastSnapshot !== undefined && snapshotAgeMinNonNegative >= ODDS_STALE_MIN;

  const meta: PicksMeta = {
    pipeline_ran: pipelineRan,
    games_analyzed: gamesAnalyzed,
    below_threshold: belowThreshold,
    ev_threshold: 0.08,
    confidence_threshold: 5,
    last_odds_snapshot_at: lastSnapshot ?? null,
    odds_stale: oddsStale,
  };

  console.info({
    event: 'picks_today_meta',
    date: pickDate,
    pipeline_ran: pipelineRan,
    games_analyzed: gamesAnalyzed,
    below_threshold: belowThreshold,
    ms: Date.now() - metaStart,
  });

  const nowMs = Date.now();
  const maskedPicks: PickResponse[] = (picks ?? []).map((row) => {
    const bookName = row.sportsbooks?.name ?? null;
    const lineSnapshots = lineSnapshotsByGameId.get(row.games?.id ?? '') ?? undefined;
    const lineValues = lineValuesByPickId.get(row.id);

    // Per-pick staleness: compare THIS pick's pinned snapshot (the row the
    // price was actually taken from) against the same ODDS_STALE_MIN window
    // used for the slate-level meta flag. Same Math.max(0, …) clock-drift
    // guard. Picks with no pinned snapshot (no matching odds row at all)
    // default to false rather than panicking — the absence is already covered
    // by the slate-level signal in the header badge.
    const pinnedAt = pinnedSnapshotAtByPickId.get(row.id);
    const pickAgeMin = pinnedAt
      ? Math.max(0, (nowMs - new Date(pinnedAt).getTime()) / 60_000)
      : 0;
    const pickOddsStale = pinnedAt !== undefined && pickAgeMin >= ODDS_STALE_MIN;

    return maskPick(row, userTier, bookName, lineSnapshots, lineValues, pickOddsStale, pinnedAt);
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
