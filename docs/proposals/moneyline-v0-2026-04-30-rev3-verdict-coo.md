```yaml
proposal_id: moneyline-v0-2026-04-30-rev3
verdict: approve-with-conditions
lens: COO
reasoning: >
  Through the cost / data-rate / infra-reliability lens, rev3 is a strict
  improvement on rev2's reliability surface. The $59 → $119 tier upgrade is
  $60/mo more recurring, but credit headroom goes from ~3× to ~50× at our
  scale — the cost-vs-capability tradeoff is a clear win and Kyle has
  pre-authorized the line item, so total infra spend stays inside the $300
  envelope. The 45K-credit historical pull is ≈1% of one month's tier on a
  pre-paid subscription, $0 incremental dollars; the 100K credit ceiling
  with month-chunking from rev1 carries forward as the operational guard
  with post-pull reconciliation in metrics.json. Train source = serve source
  = CLV-grading source = DK+FD via The Odds API eliminates the third-party
  reliability class rev2 carried (no Pinnacle archive, no Kaggle fallback,
  no version-pin obligation). Rationale archive zeros out Anthropic spend
  pending reactivation; rev3 has no LLM call path. Infra topology unchanged
  — Vercel Fluid Compute, Supabase, Upstash; no new vendor, no worker
  reintroduction. v0 cron cadence unchanged (pre-game only, 30-min cron at
  ~99% credit headroom); close-window tightening flagged for future per
  Kyle's narrow-scope directive, NOT auto-fired.
conditions:
  - tier_upgrade_recorded: Update CLAUDE.md sub-budgets table — Odds API
    target $119/mo, hard cap $130/mo (reflects the $119 line + buffer for
    tier overage). Commit the table edit with the conversation cited per
    standing rule. Cumulative recurring infra spend remains inside the
    $300/mo envelope (Odds $119 + Vercel $20 + Supabase $25 + Upstash $10
    + misc $15 = $189, leaving ~$111 headroom; Anthropic and Fly.io are
    archived/zero, so no breach risk this cycle).
  - anthropic_subbudget: Mark the Anthropic row "ARCHIVED — reactivates
    when rationale reopens" rather than deleting it. Spec stays
    documented for fast un-archive. No alert thresholds active while
    archived.
  - backfill_credit_guard: 100K-credit ceiling with month-by-month
    chunking carried from rev1 (rev2 voided this; rev3 restores). Pre-pull
    credit balance check + post-pull reconciliation (estimated 45K, actual
    X, balance after) persisted in metrics.json AND in the commit message.
    Hard halt if mid-pull credit burn projects past 100K.
  - cron_health: Monthly recalibration cron condition carries forward
    unchanged — telemetry registration, retry idempotency, no silent fail.
    Train-vs-serve residual metric (CSO rev2 condition_4) is VOIDED, no
    longer tracked. Live polling cadence unchanged at 30-min for v0.
  - voided_conditions_confirmed: rev1 decision_2 (pre-pull cost estimate)
    stays VOIDED — Kyle pre-approved the pull at the project level, the
    estimate question is closed. rev2 Pinnacle/fallback/version-pin
    conditions stay VOIDED. CSO rev2 condition_4 (train-vs-serve residual)
    stays VOIDED.
  - close_window_followup: NOT auto-fired. Logged here as a future
    `kind: infra` candidate — every-1-min cadence in the last 15min
    pre-first-pitch is now affordable on the new tier (~7K credits/day at
    15 games × 15min × 2 books). Kyle's narrow-scope directive holds
    until he reopens.
escalation_target: n/a
```

## Per-decision calls

1. **Odds API tier upgrade $59 → $119 confirmed.** Net $60/mo recurring increase with 50× credit headroom; total infra still inside $300 envelope. Update CLAUDE.md sub-budgets table.
2. **Historical pull confirmed.** ~45K credits = ~1% of monthly tier, $0 incremental dollars; 100K-credit ceiling + month-chunking + metrics.json reconciliation are the operational guards.
3. **Anthropic sub-budget archived, not deleted.** Mark the row "ARCHIVED — reactivates when rationale reopens"; spec stays documented for fast un-archive when Kyle decides.
4. **Live polling cadence unchanged for v0.** 30-min cron at ~99% credit headroom; close-window tightening flagged as a future `kind: infra` proposal candidate, not auto-fired per Kyle's narrow-scope directive.
5. **rev2 conditions stay voided.** decision_2 (Odds API pre-pull cost estimate) was voided in rev2 because there was no pull; rev3 has a pull but Kyle pre-approved at the project level, so the condition stays voided — the operational guard now lives in `backfill_credit_guard` above (100K ceiling + reconciliation), which is a different obligation.
