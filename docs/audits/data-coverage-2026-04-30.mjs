/**
 * Data-coverage audit — 2026-04-30
 *
 * Read-only queries against Supabase to inventory what's actually in:
 *   - games
 *   - odds (moneyline closing snapshots, DK + FD)
 *   - pitcher_game_log
 *   - batter_game_log
 * and compute the joint "training-row eligibility" rate.
 *
 * Run from the research worktree, but loads the pipeline-owner .env
 * since this worktree has no DB credentials of its own.
 *   node docs/audits/data-coverage-2026-04-30.mjs
 *
 * No writes. No paid API calls.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
// pg is resolved from the pipeline-owner worktree's node_modules
// (research worktree intentionally has no installed deps).
const require = createRequire('C:/AI/Public/diamond-edge/scripts/backfill-db/package.json');
const pg = require('pg');

const PIPELINE_ENV = 'C:/AI/Public/diamond-edge/.env';
for (const line of readFileSync(PIPELINE_ENV, 'utf-8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('=');
  if (eq === -1) continue;
  const k = t.slice(0, eq).trim();
  const v = t.slice(eq + 1).trim();
  if (k && !(k in process.env)) process.env[k] = v;
}

const db = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});

function header(title) {
  console.log(`\n=== ${title} ===`);
}

async function rows(sql, params = []) {
  const r = await db.query(sql, params);
  return r.rows;
}

async function main() {
  await db.connect();

  // ----- games -----
  header('games — totals');
  console.table(await rows(`
    SELECT EXTRACT(YEAR FROM game_date)::int AS season,
           status,
           COUNT(*) AS n
    FROM games
    GROUP BY 1, 2
    ORDER BY 1, 2
  `));

  header('games — overall date range');
  console.table(await rows(`
    SELECT MIN(game_date) AS earliest,
           MAX(game_date) AS latest,
           COUNT(*) AS total_games,
           COUNT(*) FILTER (WHERE status = 'final') AS final_games
    FROM games
  `));

  header('games — divisional_flag distribution by season (2022-2024 finals only)');
  console.table(await rows(`
    SELECT EXTRACT(YEAR FROM game_date)::int AS season,
           divisional_flag,
           COUNT(*) AS n
    FROM games
    WHERE EXTRACT(YEAR FROM game_date) BETWEEN 2022 AND 2024
      AND status = 'final'
    GROUP BY 1, 2
    ORDER BY 1, 2
  `));

  // ----- odds -----
  header('odds — overall row counts by market and source');
  console.table(await rows(`
    SELECT market, source, closing_snapshot, COUNT(*) AS n
    FROM odds
    GROUP BY 1, 2, 3
    ORDER BY 1, 2, 3
  `));

  header('odds — moneyline closing coverage by season + sportsbook');
  console.table(await rows(`
    SELECT EXTRACT(YEAR FROM g.game_date)::int AS season,
           sb.key AS book,
           COUNT(DISTINCT o.game_id) AS games_with_closing_ml
    FROM odds o
    JOIN games g       ON g.id = o.game_id
    JOIN sportsbooks sb ON sb.id = o.sportsbook_id
    WHERE o.market = 'moneyline'
      AND o.closing_snapshot = true
      AND EXTRACT(YEAR FROM g.game_date) BETWEEN 2022 AND 2024
    GROUP BY 1, 2
    ORDER BY 1, 2
  `));

  header('odds — moneyline closing rows per (game, book) — sanity (should be 1.0 mean)');
  console.table(await rows(`
    SELECT EXTRACT(YEAR FROM g.game_date)::int AS season,
           sb.key AS book,
           ROUND(AVG(per_game), 2) AS avg_rows_per_game,
           MAX(per_game) AS max_rows_per_game,
           SUM(CASE WHEN per_game > 1 THEN 1 ELSE 0 END) AS games_with_dupes
    FROM (
      SELECT o.game_id, o.sportsbook_id, COUNT(*) AS per_game
      FROM odds o
      WHERE o.market = 'moneyline' AND o.closing_snapshot = true
      GROUP BY 1, 2
    ) t
    JOIN games g       ON g.id = t.game_id
    JOIN sportsbooks sb ON sb.id = t.sportsbook_id
    WHERE EXTRACT(YEAR FROM g.game_date) BETWEEN 2022 AND 2024
    GROUP BY 1, 2
    ORDER BY 1, 2
  `));

  header('odds — moneyline closing price NULL / 0 sanity');
  console.table(await rows(`
    SELECT EXTRACT(YEAR FROM g.game_date)::int AS season,
           sb.key AS book,
           SUM(CASE WHEN o.home_price IS NULL THEN 1 ELSE 0 END) AS null_home_price,
           SUM(CASE WHEN o.away_price IS NULL THEN 1 ELSE 0 END) AS null_away_price,
           SUM(CASE WHEN o.home_price = 0 OR o.away_price = 0 THEN 1 ELSE 0 END) AS zero_price
    FROM odds o
    JOIN games g       ON g.id = o.game_id
    JOIN sportsbooks sb ON sb.id = o.sportsbook_id
    WHERE o.market = 'moneyline' AND o.closing_snapshot = true
      AND EXTRACT(YEAR FROM g.game_date) BETWEEN 2022 AND 2024
    GROUP BY 1, 2
    ORDER BY 1, 2
  `));

  // ----- pitcher_game_log -----
  header('pitcher_game_log — coverage by season');
  console.table(await rows(`
    SELECT EXTRACT(YEAR FROM g.game_date)::int AS season,
           COUNT(DISTINCT g.id) AS final_games,
           COUNT(DISTINCT pgl.game_id) AS games_with_any_pitcher,
           ROUND(100.0 * COUNT(DISTINCT pgl.game_id) / NULLIF(COUNT(DISTINCT g.id), 0), 1) AS pct_any
    FROM games g
    LEFT JOIN pitcher_game_log pgl ON pgl.game_id = g.id
    WHERE EXTRACT(YEAR FROM g.game_date) BETWEEN 2022 AND 2024
      AND g.status = 'final'
    GROUP BY 1
    ORDER BY 1
  `));

  header('pitcher_game_log — both-side coverage (home + away each have ≥1 pitcher row)');
  console.table(await rows(`
    WITH games_2224 AS (
      SELECT id, EXTRACT(YEAR FROM game_date)::int AS season
      FROM games
      WHERE EXTRACT(YEAR FROM game_date) BETWEEN 2022 AND 2024
        AND status = 'final'
    ),
    side_counts AS (
      SELECT g.id AS game_id, g.season,
             COUNT(DISTINCT pgl.team_id) AS distinct_teams_with_pitchers
      FROM games_2224 g
      LEFT JOIN pitcher_game_log pgl ON pgl.game_id = g.id
      GROUP BY 1, 2
    )
    SELECT season,
           COUNT(*) AS final_games,
           SUM(CASE WHEN distinct_teams_with_pitchers >= 2 THEN 1 ELSE 0 END) AS both_sides,
           ROUND(100.0 * SUM(CASE WHEN distinct_teams_with_pitchers >= 2 THEN 1 ELSE 0 END) / COUNT(*), 1) AS pct_both
    FROM side_counts
    GROUP BY 1
    ORDER BY 1
  `));

  header('pitcher_game_log — starter coverage (≥1 is_starter=true row per side)');
  console.table(await rows(`
    WITH games_2224 AS (
      SELECT id, home_team_id, away_team_id, EXTRACT(YEAR FROM game_date)::int AS season
      FROM games
      WHERE EXTRACT(YEAR FROM game_date) BETWEEN 2022 AND 2024
        AND status = 'final'
    ),
    starter_flags AS (
      SELECT g.id AS game_id, g.season,
             SUM(CASE WHEN pgl.is_starter AND pgl.team_id = g.home_team_id THEN 1 ELSE 0 END) AS home_starters,
             SUM(CASE WHEN pgl.is_starter AND pgl.team_id = g.away_team_id THEN 1 ELSE 0 END) AS away_starters
      FROM games_2224 g
      LEFT JOIN pitcher_game_log pgl ON pgl.game_id = g.id
      GROUP BY 1, 2
    )
    SELECT season,
           COUNT(*) AS final_games,
           SUM(CASE WHEN home_starters >= 1 AND away_starters >= 1 THEN 1 ELSE 0 END) AS both_starters,
           ROUND(100.0 * SUM(CASE WHEN home_starters >= 1 AND away_starters >= 1 THEN 1 ELSE 0 END) / COUNT(*), 1) AS pct_both_starters,
           SUM(CASE WHEN home_starters > 1 OR away_starters > 1 THEN 1 ELSE 0 END) AS games_with_multistarter
    FROM starter_flags
    GROUP BY 1
    ORDER BY 1
  `));

  header('pitcher_game_log — total rows + IP / K aggregate sanity');
  console.table(await rows(`
    SELECT EXTRACT(YEAR FROM game_date)::int AS season,
           COUNT(*) AS n_rows,
           COUNT(DISTINCT pitcher_id) AS distinct_pitchers,
           SUM(CASE WHEN is_starter THEN 1 ELSE 0 END) AS starter_rows,
           SUM(CASE WHEN NOT is_starter THEN 1 ELSE 0 END) AS reliever_rows,
           ROUND(AVG(ip)::numeric, 2) AS avg_ip,
           ROUND(AVG(k)::numeric, 2) AS avg_k
    FROM pitcher_game_log
    WHERE EXTRACT(YEAR FROM game_date) BETWEEN 2022 AND 2024
    GROUP BY 1
    ORDER BY 1
  `));

  // ----- batter_game_log -----
  header('batter_game_log — coverage by season');
  console.table(await rows(`
    SELECT EXTRACT(YEAR FROM g.game_date)::int AS season,
           COUNT(DISTINCT g.id) AS final_games,
           COUNT(DISTINCT bgl.game_id) AS games_with_any_batter,
           ROUND(100.0 * COUNT(DISTINCT bgl.game_id) / NULLIF(COUNT(DISTINCT g.id), 0), 1) AS pct_any
    FROM games g
    LEFT JOIN batter_game_log bgl ON bgl.game_id = g.id
    WHERE EXTRACT(YEAR FROM g.game_date) BETWEEN 2022 AND 2024
      AND g.status = 'final'
    GROUP BY 1
    ORDER BY 1
  `));

  header('batter_game_log — usable lineup coverage (≥9 rows on each side)');
  console.table(await rows(`
    WITH games_2224 AS (
      SELECT id, home_team_id, away_team_id, EXTRACT(YEAR FROM game_date)::int AS season
      FROM games
      WHERE EXTRACT(YEAR FROM game_date) BETWEEN 2022 AND 2024
        AND status = 'final'
    ),
    side_pa AS (
      SELECT g.id AS game_id, g.season,
             COUNT(*) FILTER (WHERE bgl.team_id = g.home_team_id) AS home_rows,
             COUNT(*) FILTER (WHERE bgl.team_id = g.away_team_id) AS away_rows
      FROM games_2224 g
      LEFT JOIN batter_game_log bgl ON bgl.game_id = g.id
      GROUP BY 1, 2
    )
    SELECT season,
           COUNT(*) AS final_games,
           SUM(CASE WHEN home_rows >= 9 AND away_rows >= 9 THEN 1 ELSE 0 END) AS full_lineups,
           ROUND(100.0 * SUM(CASE WHEN home_rows >= 9 AND away_rows >= 9 THEN 1 ELSE 0 END) / COUNT(*), 1) AS pct_full_lineups
    FROM side_pa
    GROUP BY 1
    ORDER BY 1
  `));

  header('batter_game_log — wrc_plus NULL rate by season');
  console.table(await rows(`
    SELECT EXTRACT(YEAR FROM game_date)::int AS season,
           wrc_plus_source,
           COUNT(*) AS n_rows,
           SUM(CASE WHEN wrc_plus IS NULL THEN 1 ELSE 0 END) AS null_wrc_plus,
           ROUND(100.0 * SUM(CASE WHEN wrc_plus IS NULL THEN 1 ELSE 0 END) / COUNT(*), 1) AS pct_null,
           ROUND(AVG(wrc_plus)::numeric, 1) AS avg_wrc_plus_nonnull
    FROM batter_game_log
    WHERE EXTRACT(YEAR FROM game_date) BETWEEN 2022 AND 2024
    GROUP BY 1, 2
    ORDER BY 1, 2
  `));

  // ----- joint training-row eligibility -----
  header('JOINT — training-row eligibility (all features available, by season)');
  console.table(await rows(`
    WITH games_2224 AS (
      SELECT id, home_team_id, away_team_id, EXTRACT(YEAR FROM game_date)::int AS season
      FROM games
      WHERE EXTRACT(YEAR FROM game_date) BETWEEN 2022 AND 2024
        AND status = 'final'
    ),
    pgl_flags AS (
      SELECT g.id AS game_id,
             SUM(CASE WHEN pgl.is_starter AND pgl.team_id = g.home_team_id THEN 1 ELSE 0 END) AS home_starter_present,
             SUM(CASE WHEN pgl.is_starter AND pgl.team_id = g.away_team_id THEN 1 ELSE 0 END) AS away_starter_present
      FROM games_2224 g
      LEFT JOIN pitcher_game_log pgl ON pgl.game_id = g.id
      GROUP BY 1
    ),
    bgl_flags AS (
      SELECT g.id AS game_id,
             COUNT(*) FILTER (WHERE bgl.team_id = g.home_team_id) AS home_b_rows,
             COUNT(*) FILTER (WHERE bgl.team_id = g.away_team_id) AS away_b_rows
      FROM games_2224 g
      LEFT JOIN batter_game_log bgl ON bgl.game_id = g.id
      GROUP BY 1
    ),
    odds_flags AS (
      SELECT o.game_id,
             SUM(CASE WHEN sb.key = 'draftkings' THEN 1 ELSE 0 END) AS dk_closing,
             SUM(CASE WHEN sb.key = 'fanduel' THEN 1 ELSE 0 END) AS fd_closing
      FROM odds o
      JOIN sportsbooks sb ON sb.id = o.sportsbook_id
      WHERE o.market = 'moneyline' AND o.closing_snapshot = true
      GROUP BY 1
    )
    SELECT g.season,
           COUNT(*) AS final_games,
           SUM(CASE WHEN COALESCE(of.dk_closing,0) >= 1 THEN 1 ELSE 0 END) AS has_dk_close,
           SUM(CASE WHEN COALESCE(of.fd_closing,0) >= 1 THEN 1 ELSE 0 END) AS has_fd_close,
           SUM(CASE WHEN COALESCE(pf.home_starter_present,0) >= 1 AND COALESCE(pf.away_starter_present,0) >= 1 THEN 1 ELSE 0 END) AS both_starters,
           SUM(CASE WHEN COALESCE(bf.home_b_rows,0) >= 9 AND COALESCE(bf.away_b_rows,0) >= 9 THEN 1 ELSE 0 END) AS full_lineups,
           SUM(CASE WHEN COALESCE(of.dk_closing,0) >= 1
                     AND COALESCE(of.fd_closing,0) >= 1
                     AND COALESCE(pf.home_starter_present,0) >= 1
                     AND COALESCE(pf.away_starter_present,0) >= 1
                     AND COALESCE(bf.home_b_rows,0) >= 9
                     AND COALESCE(bf.away_b_rows,0) >= 9
                THEN 1 ELSE 0 END) AS all_features_present,
           ROUND(100.0 * SUM(CASE WHEN COALESCE(of.dk_closing,0) >= 1
                     AND COALESCE(of.fd_closing,0) >= 1
                     AND COALESCE(pf.home_starter_present,0) >= 1
                     AND COALESCE(pf.away_starter_present,0) >= 1
                     AND COALESCE(bf.home_b_rows,0) >= 9
                     AND COALESCE(bf.away_b_rows,0) >= 9
                THEN 1 ELSE 0 END) / COUNT(*), 1) AS pct_eligible
    FROM games_2224 g
    LEFT JOIN pgl_flags  pf ON pf.game_id = g.id
    LEFT JOIN bgl_flags  bf ON bf.game_id = g.id
    LEFT JOIN odds_flags of ON of.game_id = g.id
    GROUP BY 1
    ORDER BY 1
  `));

  header('JOINT — drop reasons (which feature is the bottleneck per season)');
  console.table(await rows(`
    WITH games_2224 AS (
      SELECT id, home_team_id, away_team_id, EXTRACT(YEAR FROM game_date)::int AS season
      FROM games
      WHERE EXTRACT(YEAR FROM game_date) BETWEEN 2022 AND 2024
        AND status = 'final'
    ),
    pgl_flags AS (
      SELECT g.id AS game_id,
             SUM(CASE WHEN pgl.is_starter AND pgl.team_id = g.home_team_id THEN 1 ELSE 0 END) AS home_starter_present,
             SUM(CASE WHEN pgl.is_starter AND pgl.team_id = g.away_team_id THEN 1 ELSE 0 END) AS away_starter_present
      FROM games_2224 g LEFT JOIN pitcher_game_log pgl ON pgl.game_id = g.id GROUP BY 1
    ),
    bgl_flags AS (
      SELECT g.id AS game_id,
             COUNT(*) FILTER (WHERE bgl.team_id = g.home_team_id) AS home_b_rows,
             COUNT(*) FILTER (WHERE bgl.team_id = g.away_team_id) AS away_b_rows
      FROM games_2224 g LEFT JOIN batter_game_log bgl ON bgl.game_id = g.id GROUP BY 1
    ),
    odds_flags AS (
      SELECT o.game_id,
             SUM(CASE WHEN sb.key = 'draftkings' THEN 1 ELSE 0 END) AS dk_closing,
             SUM(CASE WHEN sb.key = 'fanduel' THEN 1 ELSE 0 END) AS fd_closing
      FROM odds o JOIN sportsbooks sb ON sb.id = o.sportsbook_id
      WHERE o.market = 'moneyline' AND o.closing_snapshot = true
      GROUP BY 1
    )
    SELECT g.season,
           SUM(CASE WHEN COALESCE(of.dk_closing,0)=0 THEN 1 ELSE 0 END) AS missing_dk_close,
           SUM(CASE WHEN COALESCE(of.fd_closing,0)=0 THEN 1 ELSE 0 END) AS missing_fd_close,
           SUM(CASE WHEN COALESCE(pf.home_starter_present,0)=0 THEN 1 ELSE 0 END) AS missing_home_starter,
           SUM(CASE WHEN COALESCE(pf.away_starter_present,0)=0 THEN 1 ELSE 0 END) AS missing_away_starter,
           SUM(CASE WHEN COALESCE(bf.home_b_rows,0) < 9 THEN 1 ELSE 0 END) AS missing_home_lineup,
           SUM(CASE WHEN COALESCE(bf.away_b_rows,0) < 9 THEN 1 ELSE 0 END) AS missing_away_lineup
    FROM games_2224 g
    LEFT JOIN pgl_flags  pf ON pf.game_id = g.id
    LEFT JOIN bgl_flags  bf ON bf.game_id = g.id
    LEFT JOIN odds_flags of ON of.game_id = g.id
    GROUP BY 1 ORDER BY 1
  `));

  // ----- 2025 / 2026 sanity (current season) -----
  header('2025/2026 — what do we have so far?');
  console.table(await rows(`
    SELECT EXTRACT(YEAR FROM game_date)::int AS season,
           status,
           COUNT(*) AS n
    FROM games
    WHERE EXTRACT(YEAR FROM game_date) >= 2025
    GROUP BY 1, 2
    ORDER BY 1, 2
  `));

  header('2025/2026 — moneyline closing odds');
  console.table(await rows(`
    SELECT EXTRACT(YEAR FROM g.game_date)::int AS season,
           sb.key AS book,
           COUNT(DISTINCT o.game_id) AS games_with_closing_ml
    FROM odds o
    JOIN games g       ON g.id = o.game_id
    JOIN sportsbooks sb ON sb.id = o.sportsbook_id
    WHERE o.market = 'moneyline'
      AND o.closing_snapshot = true
      AND EXTRACT(YEAR FROM g.game_date) >= 2025
    GROUP BY 1, 2
    ORDER BY 1, 2
  `));

  await db.end();
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
