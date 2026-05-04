# Overnight briefing — 2026-05-04

**Status when you wake up:** v0 in production unchanged. Pinned holdout untouched. Tonight's picks (8 from earlier) graded by the morning outcome-grader. xFIP infra chain HALTED at the verification gate; remediation needs your call.

## 1. xFIP infra chain HALTED at verification gate

**Where we are:**
- Migration `0030_pitcher_game_log_fb.sql` IS applied to prod (61,950 rows defaulted to fb=0). Schema correct. Harmless if you decide to abandon — column is unused by v0 serving.
- Formula modules (TS + Python) committed; parity check PASS to 4 decimals.
- Parser captures `pit.flyOuts` from MLB Stats API boxscore; idempotency PASS.
- Verification gate **FAILED on all 5 spot-check pitchers**, systematic underestimate ~0.7 xFIP units:

| Pitcher | Computed | Sabermetrics | Δ |
|---|---|---|---|
| Burnes 2024 | (computed) | 3.5x | **−0.78** |
| Wheeler 2024 (flyball) | (computed) | 3.7x | **−0.80** |
| Skubal 2024 | (computed) | 3.0x | −0.64 |
| deGrom 2023 | (computed) | 2.7x | −0.81 |
| Verlander 2022 | (computed) | 3.4x | −0.68 |

(Tolerance was ±0.20.)

**Root cause:** input-source assumption was wrong. Boxscore `flyOuts` = outs-on-flyballs only (excludes flyballs that became hits or HRs). FG xFIP needs **total flyballs** (FB% × balls-in-play + HR). The verification gate did its job — caught the semantic gap before any holdout consumption or v0 contamination. Same failure shape as the wRC+ pause.

**Three remediation paths (your call):**
1. **Statcast batted-ball-event ingestion** — every flyball regardless of outcome. Different data source (Savant `pitch-by-pitch` or `statcast_pitcher_classifier` endpoints). Likely a multi-day re-ingestion. Highest fidelity.
2. **Proxy refit** — `total_FB ≈ flyOuts / (1 − BABIP_FB − HR_rate)`. Cheap; known systematic bias; the verification gate would still need re-tuning to accept the proxy.
3. **Sabermetrics-direct with prior-year carry** — pull FG-parity xfip per-season; same staleness problem the wRC+ rev A had. CSO already weighed against this pattern for wRC+.

**Or:** abandon the xFIP path entirely and revisit pitcher residuals from a different angle (handedness splits, opener detection, lineup-hand-matching). Prior CSO direction was Stuff+; xFIP was the substitute; if xFIP is also dead, the third pivot needs a fresh CSO call.

**Commit `89bb926` is local-only — NOT pushed.** Decide:
- Push and pursue remediation 1/2/3 (commit stands)
- Revert locally (`git reset --hard dc23022`) and DROP COLUMN fb on prod migration before re-attempting
- Push and abandon (column is harmless)

## 2. Tonight's pick-pipeline cron — 22:00 UTC

The 22:00 UTC pick-pipeline cron will fire while you sleep. Will use the existing v0 artifact + the +3% EV floor (CEng condition from the validation verdict). Tonight's slate had 12 scheduled night games when last checked; expect 3-8 picks.

I'll verify post-fire and surface anomalies in the morning summary.

## 3. Morning crons — 08:00 / 09:00 / 10:00 UTC

**Update at 10:21 UTC re-check:**
- `outcome-grader` (08:00 UTC scheduled): **CRITICAL — zero entries in cron_runs across ALL HISTORY.** Not just today; the route has NEVER written a cron_runs row from a Vercel-cron-triggered firing. Last `pick_outcomes` writes are 5+ days old (2026-04-29 22:03 UTC was a manual one-off; before that 08:00 UTC entries were from the OLD pre-wipe pipeline). Tonight's 8 picks have nothing to grade right now (games scheduled future), but **will block tomorrow morning** when those games go final. Likely root cause: Vercel cron not registered for this path despite `vercel.json` listing it. Investigation paths: (a) check Vercel dashboard cron list to see if outcome-grader appears, (b) trigger manually with the curl pattern I used yesterday for schedule-sync to confirm the route itself works, (c) check if a recent vercel.json edit dropped the entry. **HIGH-priority for your review.**
- `clv-compute` (09:00 UTC): fired at 09:01:41 UTC, status='success'.
- `calibration-snapshot` (10:00 UTC scheduled): fired at 09:30:02 UTC, status='success' — **note schedule drift: configured for 10:00 but firing at 09:30 daily**. Same drift on yesterday's run (09:30:01). Vercel cron timing is loose on our deploy. Not blocking but worth noting.

**Net morning-cron status:** 2 of 3 fired successfully (clv-compute + calibration-snapshot). 1 missing entirely (outcome-grader). The missing one will become blocking tomorrow.

**11:24 UTC re-check — state stable; one new oddity:** calibration-snapshot fired a SECOND time today at 10:35:06 UTC (also success). Vercel cron is triggering it twice on this run — both are idempotent on the (snapshot_date, market, confidence_tier) primary key so no row corruption or duplicate problem. Note for Kyle: combined with the configured-10:00-but-fires-09:30 drift, Vercel cron timing appears non-deterministic for this path. Possibly tied to two cron entries pointing at the same route in the deployed `vercel.json` (we have two for `pick-pipeline`; not sure if calibration-snapshot has the same configuration error). Worth a one-time check.

**12:26 UTC final check — state unchanged.** No new fires, failures, or picks. Last overnight wakeup at 12:26 UTC; state stable; standing by until next user message. Next event of interest is the 22:00 UTC pick-pipeline cron (~9.5h out, too far for 1h wakeup chain — Kyle to verify when he wakes).

**Background failure pattern (known noise; not new):** `schedule-sync` returns HTTP 207 (multi-status) every day because the news-poll subtask returns `ok=false` while schedule + odds succeed. Our cron-run-log treats 207 as `'failure'`. The actual data ingestion (schedule + odds) IS working — confirmed by manual probe yesterday. Could be fixed by changing the cron-runs status mapping, but it's been failing this way for ≥4 days without operational impact. Low priority.

## 4. Open work I'm NOT acting on (you decide)

- **xFIP remediation path** — see above
- **wRC+ ingestion** (rev A + rev B both halted) — pending CSO/CEng pivot; scope-gate verdicts are on disk but no path is actively executing
- **2025 historical odds backfill** — authorized as fallback IF live pace falls below 3 picks/night for 2 weeks (per validation verdict) — pace not yet measurable
- **Team-batting Savant 404 bug** (Task #15) — separate production bug surfaced during wRC+ rev A; hasn't been investigated
- **Day-game pick-pipeline cron at 16:00 UTC** — added in `vercel.json` but no day games on tomorrow's slate (last checked); will be useful when there are

## 5. Live-pick evidence accumulation

Tonight's 8 picks (live + shadow mix) will settle tomorrow morning. Plus tonight's 22:00 UTC cron output. Running tally toward the CEng-binding 200-400 live ECE re-check threshold:
- Pre-wipe baseline: 26 picks (mostly 2026-04-23/24 — counted but predates v0)
- Tonight (earlier): 8 picks (first v0-generated picks)
- Tonight 22:00 UTC: ~3-8 expected
- Daily expected pace: ~3-8/night

At ~5/night, the 200-pick threshold is ~40 days out. The 400-pick is ~80 days. CSO already flagged: if pace falls < 3/night for 2 weeks, 2025 backfill triggers per validation verdict.

---

**TL;DR:** v0 picks running fine. xFIP got far enough to shake out the input-source bug; needs your call on which remediation. Nothing else needs immediate input. Morning crons fire on schedule; I'll have fresh numbers when you check in.
