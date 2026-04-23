-- Diamond Edge — News Events, News Signals, Market Priors
-- Run order: 8 (depends on: games, players from migrations 0003, 0004)
--
-- Phase 2 of ADR-002: raw news ingestion tables and market prior store.
-- All three tables are service-role-only (no user-facing reads).
-- Schema note: player_id references players(id) which is uuid in this schema,
-- overriding the brief's "int" which was a typo against the actual schema.

-- ============================================================
-- news_events
-- Raw ingested news items from all free sources.
-- Idempotent on (source, source_id) — re-polling the same item
-- is a no-op. LLM extraction reads from here; humans never do.
-- ============================================================

CREATE TABLE news_events (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source        text        NOT NULL
                  CHECK (source IN ('bluesky', 'mlb_rss', 'espn', 'rotoballer', 'mlb_stats_api')),
  source_id     text        NOT NULL,   -- Bluesky post URI, RSS guid, etc.
  author        text,                   -- Bluesky handle; RSS author field; null for API sources
  body          text        NOT NULL,
  url           text,
  published_at  timestamptz NOT NULL,
  fetched_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT news_events_source_source_id_unique UNIQUE (source, source_id)
);

CREATE INDEX idx_news_events_published_at       ON news_events (published_at DESC);
CREATE INDEX idx_news_events_source_published   ON news_events (source, published_at DESC);

ALTER TABLE news_events ENABLE ROW LEVEL SECURITY;

-- Service role can read and write; no user-facing access.
CREATE POLICY "news_events_service_role_only" ON news_events
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ============================================================
-- news_signals
-- Structured LLM extraction output per game. Written by the
-- AI reasoning agent (/rationale-news endpoint on Fly.io worker).
-- Schemaed now so Phase 2 DB writes and Phase 3 reads are atomic.
-- ============================================================

CREATE TABLE news_signals (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  news_event_id  uuid        NOT NULL REFERENCES news_events(id),
  game_id        uuid                 REFERENCES games(id),    -- nullable; resolved by content match
  signal_type    text        NOT NULL
                   CHECK (signal_type IN (
                     'late_scratch',
                     'lineup_change',
                     'injury_update',
                     'weather_note',
                     'opener_announcement',
                     'other'
                   )),
  player_id      uuid                 REFERENCES players(id),  -- nullable; when player is identifiable
  payload        jsonb       NOT NULL DEFAULT '{}',             -- flexible per signal_type
  confidence     real        NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_news_signals_game_id             ON news_signals (game_id);
CREATE INDEX idx_news_signals_signal_type_game_id ON news_signals (signal_type, game_id);
CREATE INDEX idx_news_signals_news_event_id        ON news_signals (news_event_id);

ALTER TABLE news_signals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "news_signals_service_role_only" ON news_signals
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ============================================================
-- market_priors
-- Computed novig blend per game per market at pipeline run time.
-- Required for v5 delta model training data construction and
-- CLV measurement. Raw American odds are stored alongside for
-- training data reconstruction audits.
-- ============================================================

CREATE TABLE market_priors (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id             uuid        NOT NULL REFERENCES games(id),
  market              text        NOT NULL CHECK (market IN ('moneyline', 'run_line', 'totals')),
  snapshot_time       timestamptz NOT NULL,
  book                text        NOT NULL CHECK (book IN ('dk', 'fd', 'blended')),
  novig_home_prob     real,                   -- per-book or blended home novig probability
  novig_total_over_prob real,                 -- per-book or blended over novig probability
  raw_margin          real        NOT NULL,   -- book margin extracted: 1 - (1/home_impl + 1/away_impl)

  -- Raw American odds at snapshot time (audit trail for training data reconstruction)
  raw_home_price      integer,
  raw_away_price      integer,
  raw_over_price      integer,
  raw_under_price     integer,

  CONSTRAINT market_priors_game_market_snapshot_book_unique
    UNIQUE (game_id, market, snapshot_time, book)
);

CREATE INDEX idx_market_priors_game_id_market ON market_priors (game_id, market);

ALTER TABLE market_priors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "market_priors_service_role_only" ON market_priors
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
