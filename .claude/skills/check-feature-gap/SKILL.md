---
name: check-feature-gap
description: Diagnostic skill that audits feature-payload coverage for a slate against the served model artifact's expected feature list, computing per-game coverage %, missing/stale features, and ingestion-vs-artifact deltas. Methodology-agnostic — reads the expected feature list from the artifact (delegating to `mlb-feature-eng` for the authoritative spec) and is used as a gate inside `pick-test` and ad-hoc by `pick-research`.
argument-hint: [market — moneyline | run_line | totals | props | all (default) | --slate <date> to audit a specific slate | --verbose for per-game detail]
---

Market scope: `$ARGUMENTS` (default: all live markets, today's slate)

---

## Inputs

- Current production model artifact for each market in scope: `models/<market>/current/`.
- The artifact's expected feature list, read from `models/<market>/current/features.json` (preferred) or `models/<market>/current/architecture.md` (fallback). `mlb-feature-eng` confirms which file is authoritative for the served model and resolves any disagreement.
- The feature payload actually produced by the ingestion + feature-build pipeline for each game in the slate (the same payload that would be passed to the served model at pick time).
- Baseline coverage % from the prior audit (for delta computation), if one exists.

## What "feature coverage" means

For a single game:
- **Expected features** = the set of feature names declared in the artifact's `features.json` / `architecture.md`.
- **Present features** = the subset of expected features that appear in the game's feature payload with a non-null, non-stale value.
- **Stale** = a value whose source-data timestamp is older than the per-feature freshness contract declared by `mlb-feature-eng` (e.g., a rolling-30-day stat that hasn't been refreshed in >7 days). Treat stale as missing.
- **Coverage %** = `|present| / |expected|` for that game.

For a slate:
- **Slate coverage %** = mean of per-game coverage across all games in the slate.
- **Full-coverage rate** = fraction of games with coverage % == 100.
- **Per-feature gap rate** = for each expected feature, fraction of games where it is missing/stale.

## What to compute

For each market in scope:

1. Resolve the expected feature list from the artifact. If neither `features.json` nor `architecture.md` declares features in a parseable form, return INSUFFICIENT-EVIDENCE and route to `mlb-feature-eng` to fix the artifact contract.
2. For each game in the slate, compute coverage %, list missing features, list stale features.
3. Compute slate coverage %, full-coverage rate, per-feature gap rate.
4. Compute the **artifact-vs-ingestion delta**: the symmetric difference between the artifact's expected feature set and the set of feature names the ingestion pipeline is currently emitting. Both directions matter — features the artifact expects but ingestion does not produce (gap), and features ingestion produces but the artifact does not expect (drift / dead weight).
5. Compare slate coverage % vs the baseline coverage % from the prior audit.

## Pass/fail (per CLAUDE.md gates)

- **PASS** when slate coverage % ≥ baseline coverage % AND artifact-vs-ingestion delta is empty (or unchanged from baseline).
- **FAIL** when slate coverage % < baseline coverage % OR a new artifact-vs-ingestion delta has appeared since the baseline.
- **INSUFFICIENT-EVIDENCE** when:
  - No production artifact exists for the market (cold-start; no baseline to compare against). Return a clear "no `models/<market>/current/` — cold-start, gate not applicable" message.
  - The artifact exists but does not declare a parseable expected feature list. Cite the missing file and route to `mlb-feature-eng`.
  - The slate is empty (no games to audit).

A FAIL must name the specific failure mode: per-game coverage drop, per-feature gap-rate spike, or artifact-vs-ingestion delta. Generic "coverage degraded" verdicts are refused.

## Output

Write `docs/audits/feature-gap-<market>-<timestamp>.md` with:
- Slate coverage % + full-coverage rate + delta vs baseline.
- Per-feature gap-rate table (feature, gap %, change vs baseline).
- Artifact-vs-ingestion delta (features expected but not emitted; features emitted but not expected).
- Per-game detail (game ID, coverage %, missing features, stale features) — gated behind `--verbose` for slates with >20 games.
- Verdict (PASS / FAIL / INSUFFICIENT-EVIDENCE).
- One-line recommendation if FAIL (ingestion fix / feature-spec refresh / `mlb-feature-eng` review).

## Anti-patterns

- Hardcoding a feature list in this skill. The expected list lives in the artifact; this skill reads it.
- Treating null and stale as different categories at gate time. Both count as missing for coverage %; the per-feature breakdown can distinguish them for the recommendation.
- Reporting slate coverage % without the per-feature gap-rate table. A 95% slate average can hide one feature missing on every game.
- Skipping the artifact-vs-ingestion delta because slate coverage is high. Drift in either direction is a signal `mlb-feature-eng` needs to see.
- Passing the gate when the artifact has no parseable feature spec. That is an INSUFFICIENT-EVIDENCE, not a PASS.

## Return

≤150 words: per-market verdict table (market, slate coverage %, vs baseline, verdict) + the one-line recommendation if any FAIL or INSUFFICIENT-EVIDENCE.
