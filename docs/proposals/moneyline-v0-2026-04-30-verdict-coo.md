```yaml
proposal_id: moneyline-v0-2026-04-30
verdict: approve-with-conditions
lens: COO
reasoning: >
  Through the cost / data-rate / infra-reliability lens, all three decisions
  pass with conditions. Logistic-first is the cheapest-to-operate option in
  the locked stack: <30s training, <5ms serve, <100KB artifact all sit
  comfortably below the Vercel Fluid Compute 300s ceiling and inside the
  $30/$60 sub-budget — no Fly.io reintroduction required, no new line item.
  LightGBM fallback is also fits Vercel CPU; the only watch-item is the
  single-row predict path staying under the 2s cold-start target, which the
  proposal already addresses via lazy-load + warm-container reuse. On the
  training window: the data-backfill cost is one-time and falls on
  MLB Stats API (free, courtesy-rate) and Baseball Savant (scrape, polite
  rate); The Odds API historical-odds extension to 2021 is the only paid
  surface and a one-shot pull, not a recurring spend, so it's a Supabase
  storage question — small at ≈9.7K rows × per-book per-market, well inside
  $25/$50. On the fallback product: a market-prior-only product runs the
  SAME ingestion + cron + UI infra a model artifact does, so there is no
  operational savings — the cost case for "ship the prior" is zero. Combined
  with CSO's positioning veto, the answer on dual-gate failure is escalate,
  not relabel.
conditions:
  - decision_1_approach: Approve logistic primary + LightGBM fallback on Vercel Fluid Compute. Both must include a documented per-game serve-latency budget (≤2s incl. cold start, ≤200ms warm) and a Vercel function-duration alert if p95 exceeds. No worker reintroduction; if either approach needs >300s training or background scheduling, that's a separate `kind: infra` proposal.
  - decision_2_window: Default to 2022–2024 (≈7K games) per CSO. The 2021 extension is conditional on the mlb-data-engineer coverage report AND a one-time Odds API historical-pull cost estimate filed before the pull executes. Backfilled odds rows must land in the existing `odds_history` table — no new schema, no new storage tier.
  - decision_3_fallback: No "consensus-as-product" ship. Operationally identical infra cost makes this a strategy call, not a cost optimization; concur with CSO — escalate to user on dual-gate failure.
  - cron_health: Monthly recalibration cron (per risk #4 in the proposal) must register with the existing cron telemetry surface and obey idempotency on retry. No silent-fail tolerance.
escalation_target: n/a
```

## Per-decision calls

1. **Approach.** Both logistic and LightGBM fit Vercel Fluid Compute comfortably inside the $30/$60 sub-budget with zero new infra; serve-latency budget and p95 alert are the only conditions.
2. **Training window.** 2022–2024 default; 2021 extension is gated on a one-time Odds API historical-pull cost estimate filed pre-pull, since that's the only paid surface and the cap is hard at $100/mo.
3. **Fallback product.** Reject on operational grounds for redundancy with CSO — a market-prior-only product runs identical ingestion + cron + UI infra, so there is no cost case to ship it; on dual-gate failure, escalate.
