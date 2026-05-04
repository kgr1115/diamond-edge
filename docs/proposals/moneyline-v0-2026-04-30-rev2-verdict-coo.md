```yaml
proposal_id: moneyline-v0-2026-04-30-rev2
verdict: approve-with-conditions
lens: COO
reasoning: >
  Through the cost / data-rate / infra-reliability lens, rev2 is a strict
  improvement on rev1's cost surface ($30 one-time → $0) and a strict
  improvement on compute load (4,000 rows vs 9,700). The Odds API sub-budget
  is unchanged at $59/mo recurring; no new paid line item; no new vendor.
  The new operational risk is third-party data-source reliability — a
  community-maintained Pinnacle archive is not under our SLA, and the
  GitHub/Kaggle fallback is one-pull-then-stale by definition. This is a
  reliability concern, not a cost concern, and it is well-bounded: the v0
  artifact only needs the historical archive ONCE for training; production
  serving uses our existing DK/FD live captures. So a source going dark
  post-training does not break production, only retraining. That bounds the
  exposure to the monthly recalibration cron, which already has retry +
  telemetry conditions carried from rev1. Reduced sample has zero infra
  downside — faster training, smaller artifact, lower serve cost. COO
  decision_2 from rev1 (Odds API pre-pull cost estimate) is moot and is
  formally voided. cron_health condition is preserved and now matters more,
  since proxy-residual drift becomes a monthly recurring metric per CSO's
  rev2 condition_4.
conditions:
  - pinnacle_ingestion: Document the archive source URL + retrieval timestamp + SHA256 of the ingest in metrics.json AND in the commit message for reproducibility. Treat ingestion as one-shot historical, NOT a recurring scrape — no production cron pulls Pinnacle. If the archive disappears mid-cycle, fallback dataset is invoked; retrain delays are acceptable, production picks are not affected.
  - fallback_dataset: One-time download is $0 with no recurring cost. Pin the dataset version (commit hash or Kaggle version ID) in metrics.json. Annual re-pull, if needed, is a `kind: data` proposal at that time, not a standing operational obligation.
  - reduced_sample: Approved — no operational downside. Latency budget from rev1 (≤2s cold, ≤200ms warm, p95 alert) carries forward unchanged and is easier to hit at this scale.
  - cron_health: Carry-forward from rev1 reaffirmed. The monthly recalibration cron must register with cron telemetry, retry idempotently, and now also persist the train-vs-serve residual-shade metric per CSO rev2 condition_4. Silent failure is unacceptable on a metric that drives the v0 source-decision.
  - voided_rev1_condition: COO decision_2 (Odds API historical-pull cost estimate pre-pull) is formally voided — no pull occurs.
escalation_target: n/a
```

## Per-decision calls

1. **Pinnacle archive ingestion.** Free, one-shot, low-effort if a maintained dataset exists. Operationally safe because we only need the archive ONCE for training; production CLV grading and live serving use our own DK/FD captures, so a dead archive blocks future retraining (a known, bounded delay) but does not break production.
2. **GitHub/Kaggle fallback.** $0 one-time, zero recurring cost provided we pin the dataset version. Annual re-pull, if it becomes necessary, is a separate `kind: data` proposal — not a standing maintenance burden on the COO surface.
3. **Reduced ≈4,000-game sample.** No operational downside — faster training, smaller artifact, lower cold-start serve latency. The rev1 latency budget carries with margin.
