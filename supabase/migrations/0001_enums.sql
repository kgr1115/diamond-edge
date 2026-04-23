-- Diamond Edge — Enums
-- Run order: 1 (no dependencies)

CREATE TYPE subscription_tier AS ENUM ('free', 'pro', 'elite');
CREATE TYPE game_status       AS ENUM ('scheduled', 'live', 'final', 'postponed', 'cancelled');
CREATE TYPE market_type       AS ENUM ('moneyline', 'run_line', 'total', 'prop', 'parlay', 'future');
CREATE TYPE pick_result       AS ENUM ('win', 'loss', 'push', 'void', 'pending');
CREATE TYPE bet_outcome       AS ENUM ('win', 'loss', 'push', 'void');
