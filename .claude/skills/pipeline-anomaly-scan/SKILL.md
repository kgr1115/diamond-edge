---
name: pipeline-anomaly-scan
description: Diagnostic skill that scans pick-pipeline health for tier collapse, volume drop, cron staleness, and pre-lineup risk against `cron_runs`/`picks`/`games`/`odds` (using `ODDS_STALE_MIN/AMBER/RED` from `apps/web/lib/picks/load-slate.ts`). Returns PASS/WARN/FAIL plus INSUFFICIENT-EVIDENCE on cold-start; used as a gate inside `pick-test` and ad-hoc by `pick-research`; delegates odds-snapshot freshness to `mlb-data-engineer`.
argument-hint: [scope — all (default) | --category tier|volume|staleness|prelineup | --slate <date> to scan a specific slate]
---

Scope: `$ARGUMENTS` (default: full scan, today's slate)

---

## Inputs

- `cron_runs` table (`supabase/migrations/0016_cron_runs.sql`) — most-recent row per `job_name`, plus the rolling 7-day history per job for cadence sanity-checks.
- The cron schedule contract in `apps/web/vercel.json` — authoritative source of expected cadence per job.
- `picks` table — today's slate plus the trailing 7 days (for the volume baseline) and the per-pick `confidence_tier`, `generated_at`, `pick_date`.
- `games` table — `game_date` and `game_time_utc` for today's slate (for the no-games-day check + the pre-lineup-risk window).
- `odds` table latest `snapshotted_at` per game (delegated to `mlb-data-engineer` — see odds-staleness section).
- Freshness constants from `apps/web/lib/picks/load-slate.ts`:
  - `ODDS_STALE_MIN = 90` (default stale threshold, minutes)
  - `ODDS_AMBER_MIN = 60` (early-warning threshold)
  - `ODDS_RED_MIN = 180` (escalate-now threshold)

## Anomaly categories

### 1. Tier collapse

**Query:** `SELECT confidence_tier, COUNT(*) FROM picks WHERE pick_date = <today> AND visibility = 'live' GROUP BY confidence_tier`.

**Detect:**
- **Hard collapse** (FAIL): every live pick lands in tiers 1–2 (or every pick lands in a single tier) when the trailing 7-day distribution spans tiers 3–5. Signals threshold or calibrator failure.
- **Empty expected tier** (WARN): a tier that has had ≥1 pick on each of the last 7 game-days is empty today.
- Distribution intact (PASS): live picks span the same tier range as the rolling 7-day distribution.

Skip the check entirely (return PASS-with-note) when today is a no-games day per the schedule check in §2.

### 2. Volume drop

**Query:** `SELECT pick_date, COUNT(*) FROM picks WHERE pick_date BETWEEN <today-7> AND <today> AND visibility = 'live' GROUP BY pick_date`. Plus the schedule check: `SELECT COUNT(*) FROM games WHERE game_date = <today>`.

**Detect:**
- **No games today** (WARN-with-note `no_games_today`): `games` count for `<today>` is 0. Volume of 0 picks is correct, not an anomaly. WARN with note `no_games_today` for operator awareness — informational only, does not block downstream gates (consistent with WARN's general non-blocking semantics).
- **Volume drop** (WARN, configurable threshold; default 50%): today's live pick count < 50% of the trailing 7-day average (excluding no-games days from the baseline). Threshold accepts an override via `--volume-threshold <fraction>`.
- **Zero picks on a games-day with cron success** (FAIL): today's live pick count is 0 AND `games` count > 0 AND the most recent `pick-pipeline` cron row has `status = 'success'`. The pipeline reported success but emitted nothing — hard failure.

### 3. Staleness

**Query:** `SELECT job_name, MAX(started_at) FROM cron_runs GROUP BY job_name`. Cross-reference each result against the `vercel.json` cron schedule.

**Detect:** for each cron job in `vercel.json`:
- Compute expected cadence from the cron expression (e.g., `0 16 * * *` → daily). Compute time since the last `started_at`.
- **PASS**: last run within 2× expected cadence of now.
- **WARN**: last run between 2× and 3× expected cadence of now (one missed cycle past the grace window).
- **FAIL**: last run > 3× expected cadence of now (multiple consecutive missed cycles), OR the most recent row has `status = 'failure'` AND no successful row exists within 2× the expected cadence window, OR the most recent row has `status = 'running'` with `started_at` > 2× the route's `maxDuration` (a stuck job).

**Odds-snapshot freshness** is a related but separate check. Delegate to `mlb-data-engineer` for the per-game odds-snapshot sweep:
- For each game on today's slate, compute `(now − latest snapshotted_at)` in minutes.
- Apply the constants from `apps/web/lib/picks/load-slate.ts`:
  - age < `ODDS_AMBER_MIN` (60) → fresh
  - `ODDS_AMBER_MIN` ≤ age < `ODDS_STALE_MIN` (90) → amber (note in report, no verdict change)
  - `ODDS_STALE_MIN` ≤ age < `ODDS_RED_MIN` (180) → WARN
  - age ≥ `ODDS_RED_MIN` (180) → FAIL
- Aggregate the per-game results: any single game in WARN or FAIL escalates the odds-staleness sub-category accordingly.

### 4. Pre-lineup risk

**Query:** `SELECT id, generated_at, games.game_time_utc FROM picks JOIN games ON picks.game_id = games.id WHERE picks.pick_date = <today> AND picks.visibility = 'live'`.

**Detect:** for each pick where `pick_date` matches `game_date` (same-day pick):
- Compute `lead_time_h = (game_time_utc − generated_at) / 3600`.
- `lead_time_h ≤ 2` (PASS): pick generated within 2h of first pitch — lineups should be posted.
- `2 < lead_time_h < 4` (note only): borderline; flag in report but no WARN.
- `lead_time_h ≥ 4` (WARN): pick generated 4h or more before first pitch on the same day — likely ran before lineups posted.
- `lead_time_h > 8` (FAIL) on a same-day pick: pipeline almost certainly used pre-lineup odds; signals a cron-schedule misconfiguration.

Multi-day-ahead picks (D-1, D-2, D-3 lead-time observations from the multi-day pipeline) are explicitly excluded — they are by-design pre-lineup. The check applies only when `pick_date` equals `game_date` in the local ET calendar.

## Verdict aggregation

Per category: PASS, WARN, or FAIL.

Overall verdict:
- **FAIL** if any category is FAIL.
- **WARN** if any category is WARN and none is FAIL.
- **PASS** if all categories are PASS.
- **INSUFFICIENT-EVIDENCE** if `cron_runs` has zero rows (cold-start) OR today's `picks` and `games` are both empty AND the schedule has no entries for today (no slate to scan).

WARN does NOT block `pick-test`. FAIL does. INSUFFICIENT-EVIDENCE does not block on cold-start — it returns the explicit "no telemetry yet" message and `pick-test` proceeds without this gate (per the future-gates rule in `pick-test`).

## Output

Write `docs/audits/pipeline-anomaly-<timestamp>.md` with:
- Per-category verdict table (category, verdict, key numbers).
- Tier-distribution table (today vs trailing 7-day mean per tier).
- Volume table (today vs each of trailing 7 days; mark no-games days).
- Cron staleness table (`job_name`, expected cadence, last `started_at`, age, status).
- Odds-snapshot age distribution (game count per amber/stale/red bucket).
- Pre-lineup risk table (pick id, market, lead_time_h, verdict) for any pick exceeding the 2h note threshold.
- Overall verdict (PASS / WARN / FAIL / INSUFFICIENT-EVIDENCE).
- One-line recommendation if WARN or FAIL (which subsystem to investigate).

## Anti-patterns

- Calling zero picks on a no-games day a volume drop. Always check the schedule first.
- Hardcoding the cron cadence in this skill. The expected cadence is read from `apps/web/vercel.json`.
- Hardcoding the odds-staleness thresholds. They live in `apps/web/lib/picks/load-slate.ts` (`ODDS_STALE_MIN/AMBER/RED`); this skill imports the values, not duplicates them.
- Treating a single missed cron cycle as FAIL. WARN exists for the 2×–3× cadence window; FAIL is for > 3× cadence (multiple consecutive misses) or a stuck/failed job.
- Treating a multi-day-ahead pick (D-1, D-2, D-3) as pre-lineup risk. The check applies only to same-day picks.
- Returning PASS when `cron_runs` is empty. That is INSUFFICIENT-EVIDENCE — the gate cannot say PASS without telemetry.
- Auto-WARN-ing on a single amber odds snapshot. Amber is a note, not a verdict change.

## Return

≤150 words: per-category verdict table (category, verdict, key number) + overall verdict + one-line recommendation if WARN or FAIL.
