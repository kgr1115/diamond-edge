-- Diamond Edge — Reference Tables
-- Run order: 3 (depends on: enums, lookup tables)

-- ============================================================
-- teams
-- MLB teams. Static; refreshed at season start via ingestion job.
-- ============================================================

CREATE TABLE teams (
  id           uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  mlb_team_id  integer NOT NULL UNIQUE,  -- MLB Stats API canonical team ID
  name         text    NOT NULL,
  abbreviation char(3) NOT NULL,
  city         text    NOT NULL,
  division     text    NOT NULL,   -- 'AL East', 'NL West', etc.
  league       char(2) NOT NULL CHECK (league IN ('AL', 'NL')),
  venue_name   text,
  venue_city   text,
  venue_state  char(2),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_teams_mlb_team_id  ON teams(mlb_team_id);
CREATE INDEX idx_teams_abbreviation ON teams(abbreviation);

ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
CREATE POLICY "teams_select_public" ON teams FOR SELECT USING (true);

-- ============================================================
-- players
-- MLB players. Refreshed from MLB Stats API rosters.
-- ============================================================

CREATE TABLE players (
  id            uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  mlb_player_id integer NOT NULL UNIQUE,  -- MLB Stats API canonical player ID
  full_name     text    NOT NULL,
  position      text,            -- 'SP', 'RP', 'C', '1B', etc.
  bats          char(1) CHECK (bats IN ('L', 'R', 'S')),
  throws        char(1) CHECK (throws IN ('L', 'R')),
  team_id       uuid    REFERENCES teams(id),
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_players_mlb_player_id ON players(mlb_player_id);
CREATE INDEX idx_players_team_id       ON players(team_id);

ALTER TABLE players ENABLE ROW LEVEL SECURITY;
CREATE POLICY "players_select_public" ON players FOR SELECT USING (true);
