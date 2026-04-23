-- Diamond Edge — Lookup Tables
-- Run order: 2 (depends on: enums)

-- ============================================================
-- sportsbooks
-- Lookup table for betting books. Adding a book = one INSERT.
-- ============================================================

CREATE TABLE sportsbooks (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  key        text        NOT NULL UNIQUE,   -- matches The Odds API book key: 'draftkings', 'fanduel'
  name       text        NOT NULL,          -- display name: 'DraftKings', 'FanDuel'
  active     boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE sportsbooks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sportsbooks_select_public" ON sportsbooks FOR SELECT USING (true);

-- Seed: v1 books
INSERT INTO sportsbooks (key, name) VALUES
  ('draftkings', 'DraftKings'),
  ('fanduel',    'FanDuel');

-- ============================================================
-- geo_blocked_states
-- States where Diamond Edge is NOT available (DK or FD not
-- fully operational). Edge Middleware uses GEO_ALLOW_STATES env
-- var for speed; this table is the compliance record.
-- ============================================================

CREATE TABLE geo_blocked_states (
  state_code char(2)     PRIMARY KEY,  -- ISO 3166-2 two-letter US state/territory code
  reason     text,                      -- 'DK or FD not operational'
  blocked_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE geo_blocked_states ENABLE ROW LEVEL SECURITY;
CREATE POLICY "geo_blocked_states_select_public" ON geo_blocked_states FOR SELECT USING (true);

-- Seed: all US states/territories NOT in the ALLOW list.
-- ALLOW list: AZ,AR,CO,CT,DC,IL,IN,IA,KS,KY,LA,MD,MA,MI,MO,NJ,NY,NC,OH,PA,TN,VT,VA,WV,WY
-- Blocked = all 50 states + DC minus the 25 ALLOW entries (26 blocked).
INSERT INTO geo_blocked_states (state_code, reason) VALUES
  ('AL', 'DK or FD not fully operational'),
  ('AK', 'DK or FD not fully operational'),
  ('CA', 'DK or FD not fully operational'),
  ('DE', 'DK or FD not fully operational'),
  ('FL', 'DK or FD not fully operational'),
  ('GA', 'DK or FD not fully operational'),
  ('HI', 'DK or FD not fully operational'),
  ('ID', 'DK or FD not fully operational'),
  ('ME', 'DK or FD not fully operational'),
  ('MN', 'DK or FD not fully operational'),
  ('MS', 'DK or FD not fully operational'),
  ('MT', 'DK or FD not fully operational'),
  ('NE', 'DK or FD not fully operational'),
  ('NV', 'DK or FD not fully operational'),
  ('NH', 'DK or FD not fully operational'),
  ('NM', 'DK or FD not fully operational'),
  ('ND', 'DK or FD not fully operational'),
  ('OK', 'DK or FD not fully operational'),
  ('OR', 'DK or FD not fully operational'),
  ('RI', 'DK or FD not fully operational'),
  ('SC', 'DK or FD not fully operational'),
  ('SD', 'DK or FD not fully operational'),
  ('TX', 'DK or FD not fully operational'),
  ('UT', 'DK or FD not fully operational'),
  ('WA', 'DK or FD not fully operational'),
  ('WI', 'DK or FD not fully operational');
