```yaml
proposal_id: moneyline-v0-2026-04-30-rev3-backfill-option
verdict: approve-with-conditions
lens: COO
reasoning: >
  Option B. Through the cost / data-rate / reliability lens, B is the right
  pick and the credit math is not close. 35K credits is 0.7% of one month's
  5M tier, $0 incremental dollars on the pre-paid subscription, well under
  the 100K ceiling from `backfill_credit_guard`. C's 5K-credit savings buy
  nothing — the subscription is flat-rate and we have ~4.94M credits sitting
  unused. The deciding factor is the latent ingestion bug in
  `scripts/backfill-historical-odds/run.ts`: it stores `snapshotted_at` as
  API call wall-clock instead of actual snap time, which silently corrupts
  T-60 reconstruction for night games. Option A leaves that bug in place
  with a docstring workaround; the next person to re-pull (retrain in 6
  months, expand to 2025, add a market) re-hits the same 37% coverage cliff
  and either eats it or rediscovers the workaround. That is exactly the
  silent-failure pattern this lens rejects. Option B fixes the script,
  validates the fix on real returned timestamps, and leaves the codebase
  with a re-pullable backfill path. The 12h wall-time delta vs A is real
  but there is no live-pick clock pressure — no SLA breach, no user-facing
  surface waiting. Cron health stays unchanged; this is a one-shot historical
  pull, not a recurring job. Option C trades sample size for cleanliness
  with no operational benefit.
conditions:
  - script_fix_committed: The snapshot-timestamp fix in `scripts/backfill-historical-odds/run.ts` ships as a separate commit before the re-pull executes, with a regression test or fixture that asserts `snapshotted_at` reflects the snap-param target (not call wall-clock). Future re-pulls inherit the fix.
  - credit_reconciliation_extended: Per `backfill_credit_guard`, metrics.json AND the commit message record pre-pull balance, estimated 35K, actual credits used, balance after. Add a per-month chunk ledger (Aug-2022, Sep-2022, ..., Dec-2024) so a mid-pull halt at the 100K ceiling can resume from the right month.
  - hard_halt_at_100k: If the rolling pull burn projects past 100K credits before completion, halt and surface a delta-vs-estimate question to me — do not silently keep pulling. The 100K ceiling is the operational guard, not a soft target.
  - snap_param_validation: Before the full 2022-09 → 2024 pull, run a one-day probe (e.g., 2024-07-15) and verify the API returns snaps within ±15min of the requested T-75min target. If coverage at that target is materially worse than the current bug-stamped data, escalate before committing the full credit spend. The audit's note that "the API itself only stores snaps at certain intervals" is a real risk; pay 200 credits to test it before paying 35K.
  - batter_backfill_in_parallel: Run `scripts/backfill-db/08-batter-game-log.mjs` (6h, free) in parallel with the odds re-pull. Both are I/O-bound; no contention. Wall-time stays ~24h, not 30h.
  - reuse_existing_cron_telemetry: The re-pull runs as an ad-hoc script, not a cron, so the `cron_health` condition does not apply. But the script must emit progress logs to stdout that survive a 12h run — explicit "month X complete, Y credits used, Z balance" lines so a tail can show whether it stalled. No silent multi-hour gaps.
escalation_target: n/a
```

## Per-decision calls

1. **Option B over A.** Cost is a non-factor (35K of 5M = 0.7%, $0 incremental). The reliability case decides it: A leaves a known-bad ingestion script in place; B retires the bug and produces a re-pullable historical path. This lens does not approve known silent-failure patterns to save 12h of wall-time on a one-shot.
2. **Option B over C.** C saves 25K credits (0.5% of monthly tier) and 14h of wall-time, but trades sample size for no operational gain. The script bug exists in C too, just narrower in scope; C also fixes nothing for future re-pulls beyond 2024. C is a worse version of B.
3. **Snap-param probe before full pull.** The audit explicitly flagged uncertainty about whether the API returns snaps near T-75min. A 200-credit probe on one game-date catches "API only stores snaps at 03:00 UTC anyway, your fix changes nothing" before we spend the full 35K. Cheap insurance.
4. **Hard halt at 100K is the same condition as rev3.** The 100K ceiling carries from `backfill_credit_guard`. B's 35K target is well under it. The condition exists for the case where a 2× overrun (~70K) compounds with an unforeseen retry storm — still inside the ceiling, but the hard halt is the operational guard.
5. **Cron-health condition unchanged.** This is a one-shot historical script, not a cron. The monthly recalibration cron from `cron_health` is independent and stays as-specified.
6. **Sub-budget table unchanged.** Recurring spend is unaffected — Odds API stays at $119/mo target, the 35K credits are inside the existing subscription. No table edit needed for this verdict.
