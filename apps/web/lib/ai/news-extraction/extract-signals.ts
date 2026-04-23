/**
 * Main function for the Phase 3 news signal extraction pipeline.
 *
 * Input:  Array of news_events rows filtered to a game window (T-90min to T+0).
 * Output: Array of news_signals rows ready to insert into Supabase.
 *
 * This module is a pure function — it does NOT write to the database.
 * The Supabase Edge Function (Phase 5) owns the upsert step.
 *
 * Model: claude-haiku-4-5. Temperature: 0. Output: JSON array via text response.
 * Prompt caching: system prompt is marked ephemeral — cache hit expected on all
 * calls after the first in a session.
 *
 * Cost: ~$0.45/mo at 15 games/day with prompt caching (validated in ADR-002).
 */
import 'server-only';

import Anthropic from '@anthropic-ai/sdk';
import { NEWS_EXTRACTION_SYSTEM_PROMPT } from './system-prompt';
import { buildNewsExtractionUserPrompt } from './user-prompt';
import type { NewsItem, NewsExtractionGameContext } from './user-prompt';
import { resolvePlayer } from './player-resolver';
import type { RosterEntry } from './player-resolver';
import type {
  NewsSignalInsert,
  RawExtractedSignal,
  SignalType,
  ExtractionResult,
  ExtractionUsage,
  LateScratchPayload,
  LineupChangePayload,
  InjuryUpdatePayload,
  WeatherNotePayload,
  OpenerAnnouncementPayload,
  OtherPayload,
  SignalPayload,
} from './types';

// ---------------------------------------------------------------------------
// Haiku pricing (2026-04-22) — used for cost tracking per call
// ---------------------------------------------------------------------------

const HAIKU_PRICING = {
  input: 0.80,       // $0.80/M input tokens
  output: 4.00,      // $4.00/M output tokens
  cacheRead: 0.08,   // $0.08/M cached input tokens
  cacheWrite: 1.00,  // $1.00/M cache-written tokens
} as const;

// Maximum news items per extraction call. Batches above this threshold are
// split — Haiku context window is large but we keep prompts lean.
const MAX_ITEMS_PER_CALL = 40;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ExtractSignalsInput {
  game_id: string;
  news_events: Array<{
    id: string;                 // UUID — news_events.id
    body: string;
    published_at: string;       // ISO 8601 UTC
    source: string;
    author: string | null;
  }>;
  game_context: NewsExtractionGameContext;
}

/**
 * Extract structured signals from raw news events for a single game window.
 *
 * Returns an ExtractionResult containing:
 *   - signals: news_signals rows ready for upsert (game_id populated)
 *   - usage: token counts + USD cost for monitoring
 *   - extracted_at: ISO 8601 UTC timestamp of this extraction run
 *
 * Throws if the Claude API returns a non-parseable response after one retry.
 * The caller (Edge Function) should catch and log, then continue to other games.
 */
export async function extractSignals(
  input: ExtractSignalsInput,
  client?: Anthropic,
): Promise<ExtractionResult> {
  const anthropic = client ?? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const { game_id, news_events, game_context } = input;

  if (news_events.length === 0) {
    return emptyResult(game_id);
  }

  // Build roster lookup for player-resolver
  const roster: RosterEntry[] = [
    ...game_context.home_players.map((p) => ({
      player_id: p.player_id,
      name: p.name,
      war: p.war,
    })),
    ...game_context.away_players.map((p) => ({
      player_id: p.player_id,
      name: p.name,
      war: p.war,
    })),
  ];

  // Split into batches if needed — rare in practice
  const batches = chunkArray(news_events, MAX_ITEMS_PER_CALL);

  const allSignals: NewsSignalInsert[] = [];
  const combinedUsage: ExtractionUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cost_usd: 0,
  };

  for (const batch of batches) {
    const newsItems: NewsItem[] = batch.map((e) => ({
      body: e.body,
      published_at: e.published_at,
      source: e.source,
      author: e.author,
    }));

    const userPrompt = buildNewsExtractionUserPrompt(newsItems, game_context);

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      temperature: 0,
      system: [
        {
          type: 'text',
          text: NEWS_EXTRACTION_SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: userPrompt,
        },
      ],
    });

    const responseText = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b: Anthropic.TextBlock) => b.text)
      .join('');

    const rawSignals = parseClaudeResponse(responseText);

    // Map each news event's id to a signal (signals reference the news_event_id
    // of the batch item that produced them — we attribute them to the first item
    // in this batch since the batch is sent as a unit; the Edge Function can
    // re-link by matching source_excerpt if needed)
    const firstEventId = batch[0].id;
    for (const raw of rawSignals) {
      const signal = normalizeSignal(raw, firstEventId, game_id, roster);
      if (signal !== null) allSignals.push(signal);
    }

    // Accumulate usage
    const usage = response.usage;
    combinedUsage.input_tokens += usage.input_tokens;
    combinedUsage.output_tokens += usage.output_tokens;
    combinedUsage.cache_read_input_tokens += usage.cache_read_input_tokens ?? 0;
    combinedUsage.cache_creation_input_tokens += usage.cache_creation_input_tokens ?? 0;
  }

  combinedUsage.cost_usd = computeCost(combinedUsage);

  // Structured log for cost monitoring
  console.info(JSON.stringify({
    event: 'news_extraction_complete',
    game_id,
    news_events_processed: news_events.length,
    signals_extracted: allSignals.length,
    tokens_input: combinedUsage.input_tokens,
    tokens_output: combinedUsage.output_tokens,
    tokens_cache_read: combinedUsage.cache_read_input_tokens,
    tokens_cache_write: combinedUsage.cache_creation_input_tokens,
    cost_usd: combinedUsage.cost_usd,
  }));

  return {
    game_id,
    signals: allSignals,
    usage: combinedUsage,
    extracted_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Internal: parse Claude's text response into raw signal objects
// ---------------------------------------------------------------------------

function parseClaudeResponse(text: string): RawExtractedSignal[] {
  const trimmed = text.trim();
  if (!trimmed || trimmed === '[]') return [];

  // Strip markdown fences if Claude added them despite instructions
  const stripped = trimmed.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    // One retry with a more aggressive strip
    const lastArrayAttempt = stripped.slice(stripped.indexOf('['), stripped.lastIndexOf(']') + 1);
    try {
      parsed = JSON.parse(lastArrayAttempt);
    } catch {
      console.error(JSON.stringify({
        event: 'news_extraction_parse_error',
        raw_response_preview: text.slice(0, 200),
      }));
      throw new Error(`Claude returned non-parseable JSON: ${text.slice(0, 100)}`);
    }
  }

  if (!Array.isArray(parsed)) return [];

  return parsed.filter(
    (item): item is RawExtractedSignal =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as Record<string, unknown>).signal_type === 'string',
  );
}

// ---------------------------------------------------------------------------
// Internal: normalize a raw Claude signal into a NewsSignalInsert row
// ---------------------------------------------------------------------------

const VALID_SIGNAL_TYPES = new Set<SignalType>([
  'late_scratch',
  'lineup_change',
  'injury_update',
  'weather_note',
  'opener_announcement',
  'other',
]);

function normalizeSignal(
  raw: RawExtractedSignal,
  news_event_id: string,
  game_id: string,
  roster: RosterEntry[],
): NewsSignalInsert | null {
  const signalType = raw.signal_type as SignalType;
  if (!VALID_SIGNAL_TYPES.has(signalType)) return null;

  const r = raw as Record<string, unknown>;

  // Build the typed payload and resolve player_id where applicable
  let payload: SignalPayload;
  let player_id: string | null = null;

  switch (signalType) {
    case 'late_scratch': {
      const name = safeString(r.player_name) ?? '';
      const resolved = name ? resolvePlayer(name, roster) : null;
      player_id = resolved?.player_id ?? null;
      const p: LateScratchPayload = {
        player_name: name,
        player_id,
        team: safeString(r.team) ?? '',
        position: safeString(r.position) ?? null,
        war_proxy: resolved?.war ?? safeNumber(r.war_proxy) ?? null,
        reason: sanitizeReason(r.reason),
        confidence: safeNumber(r.confidence) ?? 0.5,
        source_excerpt: safeString(r.source_excerpt) ?? '',
      };
      payload = p;
      break;
    }
    case 'lineup_change': {
      const nameIn = safeString(r.player_in) ?? null;
      const nameOut = safeString(r.player_out) ?? null;
      const resolvedIn = nameIn ? resolvePlayer(nameIn, roster) : null;
      const resolvedOut = nameOut ? resolvePlayer(nameOut, roster) : null;
      player_id = resolvedIn?.player_id ?? resolvedOut?.player_id ?? null;
      const orderChange = r.order_change as { from?: unknown; to?: unknown } | null;
      const p: LineupChangePayload = {
        player_in: nameIn,
        player_out: nameOut,
        position: safeString(r.position) ?? null,
        order_change: {
          from: safeNumber(orderChange?.from) ?? null,
          to: safeNumber(orderChange?.to) ?? null,
        },
        team: safeString(r.team) ?? '',
        confidence: safeNumber(r.confidence) ?? 0.5,
        source_excerpt: safeString(r.source_excerpt) ?? '',
      };
      payload = p;
      break;
    }
    case 'injury_update': {
      const name = safeString(r.player_name) ?? '';
      const resolved = name ? resolvePlayer(name, roster) : null;
      player_id = resolved?.player_id ?? null;
      const p: InjuryUpdatePayload = {
        player_name: name,
        player_id,
        severity: sanitizeSeverity(r.severity),
        body_part: safeString(r.body_part) ?? null,
        expected_return_days: safeNumber(r.expected_return_days) ?? null,
        confidence: safeNumber(r.confidence) ?? 0.5,
        source_excerpt: safeString(r.source_excerpt) ?? '',
      };
      payload = p;
      break;
    }
    case 'weather_note': {
      const p: WeatherNotePayload = {
        venue: safeString(r.venue) ?? '',
        condition: sanitizeWeatherCondition(r.condition),
        delay_probability: safeNumber(r.delay_probability) ?? null,
        confidence: safeNumber(r.confidence) ?? 0.5,
        source_excerpt: safeString(r.source_excerpt) ?? '',
      };
      payload = p;
      break;
    }
    case 'opener_announcement': {
      const p: OpenerAnnouncementPayload = {
        team: safeString(r.team) ?? '',
        expected_starter: safeString(r.expected_starter) ?? null,
        expected_innings: safeNumber(r.expected_innings) ?? null,
        confidence: safeNumber(r.confidence) ?? 0.5,
        source_excerpt: safeString(r.source_excerpt) ?? '',
      };
      payload = p;
      break;
    }
    case 'other': {
      const p: OtherPayload = {
        headline: safeString(r.headline) ?? '',
        source_excerpt: safeString(r.source_excerpt) ?? '',
      };
      payload = p;
      break;
    }
    default:
      return null;
  }

  const confidence = safeNumber((payload as Record<string, unknown>).confidence) ?? 0.5;

  return {
    news_event_id,
    game_id,
    signal_type: signalType,
    player_id,
    payload,
    confidence: Math.max(0, Math.min(1, confidence)),
  };
}

// ---------------------------------------------------------------------------
// Internal: input sanitizers — reject values that don't fit the schema
// ---------------------------------------------------------------------------

function safeString(v: unknown): string | null {
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  return null;
}

function safeNumber(v: unknown): number | null {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    if (isFinite(n)) return n;
  }
  return null;
}

function sanitizeReason(v: unknown): LateScratchPayload['reason'] {
  const allowed: LateScratchPayload['reason'][] = ['injury', 'rest', 'personal', 'unknown'];
  return allowed.includes(v as LateScratchPayload['reason'])
    ? (v as LateScratchPayload['reason'])
    : 'unknown';
}

function sanitizeSeverity(v: unknown): InjuryUpdatePayload['severity'] {
  const allowed: InjuryUpdatePayload['severity'][] = [
    'day_to_day', 'questionable', 'il_10', 'il_15', 'il_60',
  ];
  return allowed.includes(v as InjuryUpdatePayload['severity'])
    ? (v as InjuryUpdatePayload['severity'])
    : 'day_to_day';
}

function sanitizeWeatherCondition(v: unknown): WeatherNotePayload['condition'] {
  const allowed: WeatherNotePayload['condition'][] = [
    'rain', 'wind', 'cold', 'heat', 'roof_open', 'roof_closed',
  ];
  return allowed.includes(v as WeatherNotePayload['condition'])
    ? (v as WeatherNotePayload['condition'])
    : 'rain';
}

// ---------------------------------------------------------------------------
// Internal: cost computation
// ---------------------------------------------------------------------------

function computeCost(usage: ExtractionUsage): number {
  return (
    (usage.input_tokens / 1_000_000) * HAIKU_PRICING.input +
    (usage.output_tokens / 1_000_000) * HAIKU_PRICING.output +
    (usage.cache_read_input_tokens / 1_000_000) * HAIKU_PRICING.cacheRead +
    (usage.cache_creation_input_tokens / 1_000_000) * HAIKU_PRICING.cacheWrite
  );
}

// ---------------------------------------------------------------------------
// Internal: utility
// ---------------------------------------------------------------------------

function emptyResult(game_id: string): ExtractionResult {
  return {
    game_id,
    signals: [],
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      cost_usd: 0,
    },
    extracted_at: new Date().toISOString(),
  };
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
