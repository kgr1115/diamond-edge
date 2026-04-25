# Diamond Edge

**An MLB pick recommendation system: gradient-boosted models on real Statcast + odds data, an LLM rationale layer that's grounded on SHAP attributions (not free-form), a calibrated probability output, two parallel Claude agent pipelines that scaffold the dev loop, and an honest ledger of what's been shipped vs. what's still aspirational. Free, informational, no bets placed, no funds held.**

I built this in roughly three weeks as a portfolio piece while job-searching for Solutions Engineer / Implementation / AI-engineering roles. The product surface is a paid SaaS pretending — full subscription scaffolding, tier gates, Stripe checkout — but the version of the repo featured here drops the paid-tier UI and runs as a free informational tool. The paid-tier work is preserved at tag [`v0.1-paid-tiers`](https://github.com/kgr1115/diamond-edge/releases/tag/v0.1-paid-tiers) (also browse the [`feat/paid-tiers`](https://github.com/kgr1115/diamond-edge/tree/feat/paid-tiers) branch) and discussed below; portfolio viewers can browse it without it being live in production.

> **Transparent about the process:** I built this codebase _with_ Claude Code (Sonnet 4.6 + Opus 4.7 across the cycle). Every architectural call — the model architecture, the calibration pipeline, the snapshot-pinning fix, the agent scaffolding, the line-locked compliance treatment, the choice to ground the LLM on SHAP attributions instead of letting it free-form — is mine. The implementation was AI-assisted at every step. This README is honest about what that collaboration looks like because the whole point of the repo is to demonstrate what I can build when I use AI well.

> **Built by [Kyle Rauch](https://github.com/kgr1115)** · Cincinnati, OH · [kyle.g.rauch@gmail.com](mailto:kyle.g.rauch@gmail.com) · [LinkedIn](https://www.linkedin.com/in/kyle-rauch-b2984a75/)
> Currently looking for Customer Success Manager / Implementation Specialist / Solutions Engineer / AI Trainer roles at AI-forward SaaS companies. Available immediately.

---

## What it does

Open the slate for today and you see:

1. **Pick recommendations across three markets** — moneyline, run line, and totals — for every MLB game with playable odds. Each card shows the model's recommended side, a confidence tier (Low / Moderate / High / Strong), the expected value, and the line + price the recommendation was made against.
2. **An AI-authored rationale** for each pick — 3–5 sentences (Pro tier) or paragraph-length (Elite tier) — grounded entirely on the model's top SHAP attributions plus pre-game context. No free-form storytelling; no fabricated stats. Architecture-keyword leakage ("SHAP," "LightGBM," "gradient boost") is scrubbed both in the prompt and post-response.
3. **Game-state awareness** — pick cards for in-progress / final / postponed / cancelled games render with an unmistakable "GAME IN PROGRESS — line locked" banner, dashed border, strikethrough price, and `cursor-not-allowed`. The line shown is the line at pick-creation time, not the latest live alternate (snapshot-pinning is the load path's invariant).
4. **A graded outcome panel** — once a game finalizes, the pick detail page renders the final score, result chip (WIN / LOSS / PUSH / VOID), PnL in units, and graded date. The pre-game blocks (model probability, EV, rationale) are preserved but visually de-emphasized so subscribers can compare what the model thought to what actually happened.
5. **An admin pipelines dashboard** at `/admin/pipelines` (auth-gated; 404 to non-admins) — per-cron telemetry, last-run / status / duration / truncated-error per scheduled job, and a "this migration hasn't been applied yet" clean-degrade banner so the page never crashes when something upstream isn't ready.

What it deliberately does not do:

- **Place bets.** No sportsbook API integration, no checkout flow that places a wager. Picks are informational only.
- **Hold funds.** No deposit/withdraw, no escrow.
- **Promise wins.** Rationale wording is calibrated against a "factual market state" framing — no "guaranteed," no "beat the books," no "expert handicapper" copy. (Compliance audit confirmed this in [`docs/audits/compliance-copy-audit-2026-04-24.md`](./docs/audits/compliance-copy-audit-2026-04-24.md).)

---

## Why it's a useful portfolio piece

Plenty of "ChatGPT picks the games" demos stop at "look, an LLM produced a confident-sounding paragraph." The interesting problems only start after that:

| Problem | How this project solves it |
|---|---|
| **LLMs hallucinate, especially around numbers** — the rationale layer has to cite a stat, but a stat that isn't actually in the model's evidence is worse than no stat. | Rationales are constrained to cite only `feature_attributions[].label` (top-k SHAP) and `game_context.*` (pre-game facts: pitcher, weather, park, lineup). The grounding is enforced in the system prompt AND scrubbed post-response; an architecture-keyword regex strips any leak. The `/rationale-eval` skill audits factuality, RG-disclaimer presence, banned-keyword absence, and tier-appropriate depth on every recent LIVE pick. See [`worker/app/rationale.py`](./worker/app/rationale.py) (498 lines, single-source-of-truth for the rationale contract). |
| **Models go stale silently** — last week's accuracy doesn't tell you whether today's picks are calibrated. | Two diagnostics run on every retrain: `/backtest` reports honest 2024-holdout metrics (ROI / CLV / ECE / log-loss); `/calibration-check` audits per-tier reliability on live graded picks. The retrain pipeline refuses auto-promote if `lgbm_best_iteration <= 1` (the "passthrough" trap), `nonzero_delta_rate_02 < 0.1` (variance-collapse), or `delta_std < 0.005`. Caught a real bug with this: the moneyline B2 model had silently shipped as a market passthrough with CLV −1.045%; the variance-collapse guardrail now fails-closed on that shape. |
| **Probability outputs from boosted-tree models are systematically off** — calibrated prob ≠ raw prob, especially in low-data regimes. | Isotonic calibrator fit on a held-out slice (H2-2023) wraps the model output. Reduced max calibration deviation from 14.3% (run line) → 5.6%. ECE from 0.065 → 0.0004. Persisted as `calibrator.pkl` next to the model artifact; loaded transparently by the worker; documented in [`worker/models/calibration-spec.md`](./worker/models/calibration-spec.md). |
| **Lines move; the line a pick was made against ≠ the line right now** — naively pulling the latest odds row is wrong. | Every pick stores `best_line_price` + `best_line_book_id` + `generated_at` from pick-creation time. The slate loader pins each pick's displayed `total_line` / `run_line_spread` to the snapshot at-or-before the pick's `generated_at` from the same book, falling back to any-book pre-pick, then any-time as a last resort. Same fix shape applied to the outcome grader (after a real bug where in-game alternate lines were grading 24-hour-old picks). |
| **Cron-handler bugs hide forever if the upstream data never reaches them** | The admin pipelines dashboard surfaces per-job telemetry from a `cron_runs` table. Tonight, three latent bugs surfaced as a cascade once the data flow finally connected — all caught + fixed in the same session. The dashboard now distinguishes "no failures recorded" from "migration not yet applied" so silent failures stop being silent. |
| **AI-built code drifts** — without a structured loop, every session reopens the same questions and revisits the same files. | The `.claude/` directory has two parallel pipelines: a system-improvement one (researcher → scope-gate → implementer → tester → publisher → debugger) and a pick-improvement one (same shape, scoped to model/feature/calibration/rationale work). Each pipeline has its own scope-gate enforcing locked invariants; researchers don't have to re-derive constraints every cycle. Adopted from [`ai-pipeline-scaffold`](https://github.com/kgr1115/ai-pipeline-scaffold) and tuned to this product's specifics. |

---

## Live numbers

The B2 classifier (current promoted moneyline model) on 2024 holdout:

| Metric | Value |
|---|---|
| ROI @ EV ≥ 8% | 22.97% (n=761) |
| CLV % | −0.335% |
| ECE (calibrated) | 0.0181 |
| max calibration deviation | 0.0606 (still above the 5% spec target — Platt fallback queued for the next cycle) |
| `lgbm_best_iteration` | 80 |
| `nonzero_delta_rate_02` | 0.669 |
| Features (post zero-variance drop) | 74 of 96 declared |

Run line and totals B2 models (regressor architecture, isotonic-calibrated):

| Market | ROI @ EV ≥ 8% | CLV % | ECE cal. | max dev cal. |
|---|---|---|---|---|
| run line | 45.75% | −0.22% | 0.0004 | 0.0564 |
| totals | 34.21% | +0.03% | 0.0228 | 0.0787 |

Grading is now flowing: 35 graded picks across the first two days the grader was wired correctly, with PnL tracked per pick. CLV computation is queued (the pipeline doesn't yet persist `market_novig_prior` on every pick row; that's the next pick-pipeline cycle).

---

## Stack

| Layer | Tech |
|---|---|
| Frontend + API | Next.js 15 (App Router) + TypeScript, hosted on Vercel |
| Styling | Tailwind CSS + shadcn/ui |
| Database + Auth | Supabase (Postgres, RLS, Supabase Auth) |
| Cache | Upstash Redis |
| Background jobs | Vercel Cron (2 jobs) + Supabase `pg_cron` (5+ jobs) + Supabase Edge Functions for the pick pipeline; ML/LLM overflow on Fly.io |
| ML worker | Python 3.11 + FastAPI + LightGBM + scikit-learn (isotonic calibration), deployed to Fly.io |
| Billing (paid-tier branch only) | Stripe (subscriptions + webhooks) |
| Odds data | The Odds API (cached 5 min pre-game / 30s live, $59/mo 100k credit tier) |
| MLB stats | MLB Stats API + Baseball Savant (Statcast) |
| LLM | Anthropic Claude (Haiku 4.5 default for Pro rationale; Sonnet 4.6 for Elite) |

Cost envelope target: **<$300/mo** total infra + data at <500 concurrent users. Anthropic budget for the rationale layer projects at $3–8/mo at current LIVE volume given prompt caching. The Odds API is hard-capped at $100/mo via aggressive Upstash caching.

---

## Architecture

```
                        ┌──────────────────────────────────────────┐
                        │  USER (browser) → /picks/today (Next.js) │
                        └──────────────────────────────────────────┘
                                            │  (60s server-component cache)
                                            ▼
                       ┌──────────────────────────────────────────────┐
                       │  load-slate.ts  (snapshot-pinned line lookup)│
                       │  Redis read-through (de:picks:today:{date})  │
                       └──────────────────────────────────────────────┘
                                            ▲
                                            │ written by:
                                            │
  ┌─────────────────────────────────────────────────────────────────────────┐
  │  pick-pipeline (Supabase Edge Function, runs daily 16:00 UTC)            │
  │  for each game today:                                                    │
  │    1. fetch features from games + odds + stats tables                    │
  │    2. POST worker /predict   ──► Fly.io (LightGBM + isotonic calibrator) │
  │    3. EV filter ≥ 4%, tier filter ≥ 3                                    │
  │    4. POST worker /rationale ──► Fly.io (Anthropic Haiku/Sonnet)         │
  │    5. write picks rows + invalidate Redis                                │
  └─────────────────────────────────────────────────────────────────────────┘
                                            ▲
                                            │ feeds:
                                            │
  ┌─────────────────────────────────────────────────────────────────────────┐
  │  Ingestion crons (pg_cron + Vercel Cron)                                 │
  │  schedule-sync (14:00 UTC) — MLB Stats: today + tomorrow games           │
  │  odds-refresh-daytime (every 30 min, 12-23 UTC)                          │
  │  stats-sync (14:30 UTC) — pitcher/team/bullpen stats for today           │
  │  news-poll (every 5 min) — RSS → news_signals                            │
  │  outcome-grader (08:00 UTC) — syncBoxScores → flip games to 'final'      │
  │                                                grade pending picks       │
  │  clv-compute (09:00 UTC) — closing-line CLV per graded pick              │
  └─────────────────────────────────────────────────────────────────────────┘
                                            │
                                            ▼
                         ┌──────────────────────────────────────┐
                         │  Supabase Postgres (RLS-gated)       │
                         │   games / odds / picks /             │
                         │   pick_outcomes / pick_clv /         │
                         │   rationale_cache / cron_runs        │
                         └──────────────────────────────────────┘
```

Two improvement loops sit alongside, in `.claude/`:

```
  System loop:                       Pick-quality loop:

  /research-improvement              /pick-research
        │                                  │
        ▼                                  ▼
   scope-gate                       pick-scope-gate
   (locked stack +                  (locked EV/tier floors,
    budget + compliance)             sample-size minima,
        │                            calibration invariants,
        ▼                            ROI non-degradation)
   implementer                            │
   (delegates to mlb-*                    ▼
    domain specialists)              pick-implementer
        │                            (delegates to
        ▼                             mlb-ml-engineer,
   tester                             mlb-ai-reasoning)
   (static + dynamic                      │
    + edge cases)                         ▼
        │                            pick-tester
        ▼                            (backtest + calibration
   publisher                          + rationale-eval gates)
   (commit + push;                        │
    secret/personal                       ▼
    data guard)                      pick-publisher
                                     (commit + push;
                                      model artifact
                                      size guard)
```

Both loops have a **debugger stage** that fires on tester FAIL — it's the same shape as the rest of the pipeline but its job is to localize a regression and either apply a trivially-safe fix or escalate. Two real debugger investigations this week caught (a) the picks-not-showing-up bug (`required_tier='free'` filter killed the slate for anonymous viewers; the pipeline never emits free-tier picks by design) and (b) the picks-not-grading bug (`syncBoxScores` was defined but never invoked from `runOutcomeGrader`).

---

## Design decisions

The design choices below are the ones that took the most thought and would also matter most to a hiring reviewer. Each links to the file or commit where it lives.

**Why a delta model (B2), not an absolute-probability model.**
The market line is a strong prior — better than most models could be on its own. So instead of training the model to predict win probability from scratch, B2 predicts a *delta* from the no-vig market prior. The serving contract is `final_prob = market_prior + clip(model_delta, ±0.15)`. Constrains the model from making implausible predictions and gives a direct way to measure "did the model add anything beyond the market" via `nonzero_delta_rate` and `delta_std`. A B2 model that keeps emitting near-zero deltas (regression coefficients all collapsing to zero) means the model has learned "always trust the market" — which is exactly the trap that caught the original moneyline ship. See [`worker/models/pipelines/train_b2_delta.py`](./worker/models/pipelines/train_b2_delta.py).

**Why the moneyline market got rebuilt as a classifier-on-outcome.**
The original B2 regressor for moneyline kept early-stopping at iteration 1 — the delta target was too sparse a signal. Switched moneyline to a binary `LGBMClassifier` on the absolute `home_win` outcome; derive the delta at both training time and serving time as `predict_proba(home_win) − market_prior_morning`. The serving contract is preserved; only the training target changed. Run line and totals kept the regressor (it's healthy on those markets — best_iteration in the 30s–80s, nonzero_delta_rate_02 ~0.55–0.88). See commit [`5ccd010`](https://github.com/kgr1115/diamond-edge/commit/5ccd010).

**Why isotonic calibration, not Platt.**
Isotonic is non-parametric; it works on any probability distribution shape without assuming sigmoidal shift. On the run line market the calibrator reduced ECE from 0.065 to 0.0004 — a 99.4% reduction. Trade-off: isotonic can overfit on small calibration windows (the totals market has sparser tail bins and the calibrator was aggressive enough to flag for a Platt fallback in the next cycle). The fallback decision is documented in the scope-gate review for proposal #5. See [`worker/models/calibration-spec.md`](./worker/models/calibration-spec.md).

**Why the rationale is grounded on SHAP attributions, not free-form.**
Subscribers don't trust paragraph-of-prose pick justifications by default — and they're right not to. So the rationale generator only gets the model's top-k SHAP features (with their direction + magnitude) plus pre-game game context (pitcher, weather, venue, lineup). The system prompt says "cite only these facts; do not introduce stats not present." A post-response architecture-keyword scrub strips any "SHAP" / "LightGBM" / "gradient" leak. The RG hedge ("Bet responsibly. No outcome guaranteed. Past performance does not predict future results.") is appended programmatically, not relying on the prompt to include it. See [`worker/app/rationale.py`](./worker/app/rationale.py) lines 1–44 for the design invariants.

**Why two improvement pipelines, not one.**
A "fix the codebase" cycle and an "improve pick quality" cycle have different scope-gates: the first cares about the locked tech stack and budget; the second cares about EV/tier floors, sample-size minima, calibration invariants, and ROI non-degradation. Mixing them means the scope-gate has to context-switch every proposal. Splitting them lets each scope-gate carry a tighter rule set. The `mlb-picks-orchestrator` agent dispatches to whichever pipeline matches the request shape; routing rules are at [`.claude/agents/mlb-picks-orchestrator.md`](./.claude/agents/mlb-picks-orchestrator.md).

**Why pin the displayed line to the pick's snapshot, not the latest odds row.**
The price + line + book displayed on a pick card must form a coherent triple. Naively reading "the most recent odds row for this game+market" produces a price from one snapshot next to a line from another, especially if live in-game alternate lines get captured. Caught this as a real bug ("RL spread −4.5 next to a pre-game DK +151 price"; root cause + fix in commit [`f38ae7c`](https://github.com/kgr1115/diamond-edge/commit/f38ae7c)). Fix: every pick stores `best_line_book_id` + `generated_at`; the loader pins each pick's line to the snapshot at-or-before that timestamp from the same book.

**Why the line-locked treatment uses descriptive copy ("line locked"), not directive copy ("DO NOT BET").**
Compliance: directive copy could be construed as advice to act (or not act) on a wager. Descriptive copy ("GAME IN PROGRESS — line locked," "GAME FINAL — line closed") describes the market state, which is observable fact. Same banner protects the user from misreading the line as bettable, without putting Diamond Edge in the position of advising on action. See [`apps/web/lib/picks/urgency.ts`](./apps/web/lib/picks/urgency.ts) and the compliance audit in [`docs/audits/compliance-copy-audit-2026-04-24.md`](./docs/audits/compliance-copy-audit-2026-04-24.md).

**Why explicit promote, no auto-flip, after retrain.**
The original moneyline B2 model that shipped as a passthrough auto-promoted itself because `prior_model_metrics` was null on first train (no prior to regress against). The retrain job now writes the new artifact to a `pending/` location; an operator must invoke `worker/models/retrain/promote.py --market <m> --timestamp <ts>` to flip `current_version.json`. The promote script refuses on `lgbm_best_iteration <= 1` or any `variance_collapsed` flag set by the retrain. See [`worker/models/retrain/promote.py`](./worker/models/retrain/promote.py) and the 31 unit tests in [`test_promote_gate.py`](./worker/models/retrain/test_promote_gate.py).

**Why the cron handler telemetry is a dedicated table, not a log scrape.**
`pg_cron.cron.job_run_details` records when jobs fired but not the per-job semantic outcome ("did the handler actually do useful work?"). The `cron_runs` table is written by each handler's `startCronRun` / `finishCronRun` wrapper and surfaces (status, duration, error_msg, optional metadata). The `/admin/pipelines` page reads from this table; clean-degrades when the migration hasn't been applied yet. Bridges the silent-failure gap that hid three latent grader/clv-compute bugs until tonight.

**Why the paid-tier UI got dropped from the portfolio cut.**
Two reasons: (1) the legal posture is meaningfully simpler for a free informational service vs. a paid tout (NV §463.0152 and similar state regulations), and (2) the paid-tier code is the least *interesting* part of the architecture for a hiring reviewer. The Stripe webhook handler is a Stripe webhook handler. The model architecture, the agent scaffolding, the calibration, the snapshot-pinning — those are the bits that demonstrate engineering judgment. The paid-tier code is preserved at tag [`v0.1-paid-tiers`](https://github.com/kgr1115/diamond-edge/releases/tag/v0.1-paid-tiers) (also browse the [`feat/paid-tiers`](https://github.com/kgr1115/diamond-edge/tree/feat/paid-tiers) branch) and can be browsed by anyone interested in how the subscription / tier-gate / Stripe flow was wired.

---

## Repo layout

```
apps/web/              Next.js 15 app — pages, API routes, Supabase client, UI
worker/                Python ML worker (Fly.io) — moneyline / run_line / totals models
  models/              per-market feature specs, training pipelines, retrain reports,
                       artifacts (gitignored .pkl + tracked metrics.json)
  app/                 FastAPI surface — /predict, /rationale (real Anthropic),
                       /rationale-news, /health
supabase/              Schema migrations, pg_cron schedules, Edge Functions
  functions/pick-pipeline/  the daily pick-generation orchestrator
  migrations/          numbered SQL files; CI validates filename + SQL syntax
docs/                  Briefs, ADRs, schema, API contracts, compliance, runbooks,
                       audit reports, improvement-pipeline research output
scripts/               One-off utilities (historical odds backfill, migration helpers,
                       pick-state inspection scripts)
tests/                 Integration + E2E (Playwright) + fixtures
.claude/               Agent profiles, skills, and agent memory (the dev-loop
                       scaffolding; not part of the shipped product)
```

Key entry points to read first if you're reviewing this repo:

- Pick pipeline orchestrator: [`supabase/functions/pick-pipeline/index.ts`](./supabase/functions/pick-pipeline/index.ts)
- ML inference + rationale: [`worker/app/main.py`](./worker/app/main.py) and [`worker/app/rationale.py`](./worker/app/rationale.py)
- Slate loader (snapshot-pinning is here): [`apps/web/lib/picks/load-slate.ts`](./apps/web/lib/picks/load-slate.ts)
- Outcome grader: [`apps/web/lib/outcome-grader/lib.ts`](./apps/web/lib/outcome-grader/lib.ts)
- Retrain + promote: [`worker/models/retrain/monthly.py`](./worker/models/retrain/monthly.py) and [`promote.py`](./worker/models/retrain/promote.py)
- Agent pipelines: [`.claude/agents/mlb-picks-orchestrator.md`](./.claude/agents/mlb-picks-orchestrator.md)

---

## Getting started

This is the portfolio cut: free, no auth, no Stripe, no tier gates. Anyone can clone + run.

Prereqs: Node.js 20+, Python 3.11+, Supabase CLI, a `.env` populated from `.env.example`. You'll need API keys for The Odds API, Anthropic, and Upstash Redis (all have free tiers usable for local development). MLB Stats API and Baseball Savant are free + public.

```bash
# Clone
git clone https://github.com/kgr1115/diamond-edge.git
cd diamond-edge

# Web app (Next.js)
cd apps/web
npm install
npm run dev          # http://localhost:3000

# Type + lint
npm run type-check
npm run lint

# ML worker (separate terminal)
cd ../../worker
pip install -e .     # or: uv sync
uvicorn app.main:app --reload  # http://localhost:8000
```

The Supabase migrations live in `supabase/migrations/`. To apply them to a local Supabase project:

```bash
supabase start
supabase db reset    # applies all migrations from scratch
```

The pick-pipeline Edge Function can be invoked locally with `supabase functions serve pick-pipeline` and a fixture payload. The worker's `/predict` and `/rationale` endpoints can be smoke-tested with `curl` against `http://localhost:8000`.

**Live deployment:** [https://www.diamond-edge.co](https://www.diamond-edge.co). The portfolio cut omits the auth + checkout flow; viewers see the slate + pick details directly. Worker `/health` is at [https://diamond-edge-worker.fly.dev/health](https://diamond-edge-worker.fly.dev/health) if you want to verify the ML side is up.

---

## Compliance posture

This is an informational service, not a gambling facilitator. It does not accept bets, hold funds, or place wagers on a user's behalf. The product surface is pick recommendations grounded on publicly-available statistical data.

What's in the portfolio cut:

- **Responsible-gambling footer disclaimer** on every pick surface. Wording in [`docs/compliance/copy/responsible-gambling.md`](./docs/compliance/copy/responsible-gambling.md). Programmatically appended to every LLM-generated rationale (not relying on the prompt).
- **No bet placement; no fund custody; no advice copy** ("DO NOT BET" / "BET NOW" / "guaranteed wins" — none of these appear, by design).
- **Sportsbook neutrality** — picks reference DraftKings and FanDuel lines because those are the available data feeds, but the product is not affiliated with either, does not earn referral commissions, and does not recommend that the user bet via either.

What was in the paid-tier version (preserved at tag [`v0.1-paid-tiers`](https://github.com/kgr1115/diamond-edge/releases/tag/v0.1-paid-tiers) (also browse the [`feat/paid-tiers`](https://github.com/kgr1115/diamond-edge/tree/feat/paid-tiers) branch)):

- 21+ age gate, geo-block to states where DK + FanDuel are both legal + operational, Stripe-gated subscription tiers, RG copy required on every page.

The 21+ gate and geo-block were reasonable defaults for a paid service operating in a regulated-adjacent space. They're not strictly required for a free informational service, so the portfolio cut drops them. The work to wire them up is preserved on the tag for anyone curious about how that scope was handled.

> **Not legal advice.** I'm a software engineer building a portfolio piece. Before monetizing this in any form, I'd consult an actual gambling/regulatory attorney about the specific jurisdiction's rules.

---

## Live ledger of what's shipped vs. what's queued

Tonight (2026-04-24 → 25) shipped 30+ commits across two cycles of the system + pick-quality improvement pipelines. Highlights:

- Two-pipeline agent scaffolding adopted from [`ai-pipeline-scaffold`](https://github.com/kgr1115/ai-pipeline-scaffold), tuned for this project's locked stack and pick-quality invariants
- Moneyline B2 model rebuilt as a classifier-on-outcome (CLV from −1.045% to −0.335%; `lgbm_best_iteration` from 1 to 80; `nonzero_delta_rate_02` from 0.0 to 0.669)
- Isotonic calibrators on moneyline + run line; totals queued for Platt fallback
- Real Anthropic-call rationale (replaced a hardcoded stub)
- Snapshot-pinning fix on slate display + outcome grader (line/spread now matches pick-time book + time)
- Line-locked card treatment for in-progress / final games
- Outcome grader + clv-compute backfill: 35 picks across 2026-04-23/24 finally graded (the grader had been silently returning 0 for weeks because `syncBoxScores` was never invoked)
- Admin `/admin/pipelines` dashboard with cron telemetry + clean-degrade
- 16 follow-ups queued for the next cycle (RLS audit findings, Stripe webhook hardening, pipeline writes for `market_novig_prior` so CLV can compute, etc.)

The full ledger is browsable in `git log` and the `docs/improvement-pipeline/` directory has the per-cycle research + scope-gate verdict files.

---

## Further reading

- Agent + project policy (the standing brief every agent reads): [`CLAUDE.md`](./CLAUDE.md)
- Task briefs (per-feature specs, originally written for the build): [`docs/briefs/`](./docs/briefs/)
- Architecture decisions (one ADR per material call): [`docs/adr/`](./docs/adr/)
- Data schema + tier gating: [`docs/schema/`](./docs/schema/)
- API contracts: [`docs/api/`](./docs/api/)
- Runbooks (odds lag, pipeline failure, cost spike, domain migration): [`docs/runbooks/`](./docs/runbooks/)
- Audit reports (RLS, Stripe webhooks, compliance copy): [`docs/audits/`](./docs/audits/)
- Improvement-pipeline research + scope-gate verdicts: [`docs/improvement-pipeline/`](./docs/improvement-pipeline/)
- Infra + secrets manifest (env var ownership, no values committed): [`docs/infra/`](./docs/infra/)

---

## License

No license granted. All rights reserved. This repository is source-available for review as a portfolio piece; nothing here is offered under an open-source license. If you want to use any portion of it, reach out and we'll talk.
