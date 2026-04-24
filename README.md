# Diamond Edge

MLB betting picks SaaS. Paid, web-only. Statistically-grounded picks across moneyline, run line, totals, and (planned) props/parlays/futures, with LLM-authored rationale and transparent historical performance.

**Status:** v1 in active development, pre-launch. Trademark clearance for the "Diamond Edge" name at USPTO is pending against "Diamond Edge Technology LLC" and is a launch blocker.

## Who built this

Solo founder + AI agents. Honest split:

- **Kyle Rauch (human)** — product vision and scope, MLB/betting domain expertise, data-source selection, real-data review, final authorization on every merged change, trademark strategy, launch decisions, and sign-off on anything touching compliance or subscriber money.
- **Claude agents (AI)** — code implementation, generated artifacts (models, migrations, ADRs, briefs), test and debug execution, orchestration between specialist sub-agents. Agent profiles and skills live in `.claude/` (not published as product).

No claim is made that the product is "AI-run." The model picks are produced by conventional gradient-boosted tree models trained on MLB data; LLM involvement is limited to rationale prose and developer tooling.

## Product shape (v1)

- Tiered subscriptions (Free / Pro / Elite) via Stripe.
- Sportsbooks covered: DraftKings and FanDuel only. Data model admits more books without schema churn.
- Geography: US states where both DK and FanDuel are fully legal and operational. Geo-block everywhere else.
- 21+ age gate, responsible-gambling disclaimers on every pick surface.
- **Not in v1:** bet placement, fund custody, non-MLB sports, native mobile apps.

## Tech stack

| Layer | Choice |
|---|---|
| Frontend + API | Next.js 15 (App Router) + TypeScript, hosted on Vercel |
| Styling | Tailwind CSS + shadcn/ui |
| Database + Auth | Supabase (Postgres, RLS, Auth) |
| Cache | Upstash Redis |
| Background jobs | Vercel Cron + Supabase `pg_cron` + Supabase Edge Functions; overflow ML/LLM on Fly.io |
| ML worker | Python 3.11 + FastAPI + LightGBM, deployed to Fly.io |
| Billing | Stripe (subscriptions + webhooks) |
| Odds data | The Odds API (cached via Upstash) |
| MLB stats | MLB Stats API + Baseball Savant (Statcast) |
| LLM | Anthropic Claude (Haiku 4.5 default; Sonnet 4.6 on premium picks) |

See [`CLAUDE.md`](./CLAUDE.md) for the authoritative, locked stack + budget + compliance policy. This README is mechanics only — do not rely on it for policy decisions.

## Repo layout

```
apps/web/              Next.js 15 app — pages, API routes, Stripe, Supabase client, UI
worker/                Python ML worker (Fly.io) — moneyline / run_line / totals models
supabase/              Schema migrations, pg_cron schedules, and Edge Functions (pick-pipeline)
docs/                  Briefs, ADRs, schema, API contracts, compliance, runbooks
scripts/               One-off utilities (historical odds backfill, migration helpers)
tests/                 Integration + E2E (Playwright) + fixtures
data/                  Local-only historical data (gitignored)
.claude/               Agent profiles, skills, and agent memory (internal tooling)
```

Key entry points:
- Pick pipeline orchestrator: `supabase/functions/pick-pipeline/`
- ML inference endpoints: `worker/app/main.py`
- Picks UI: `apps/web/app/picks/`
- Subscription + billing: `apps/web/app/api/billing/` and `apps/web/app/api/webhooks/stripe/`

## Getting started

Prereqs: Node.js (see `apps/web/package.json` for version), Python 3.11+, Supabase CLI, a `.env` populated from `.env.example`, and access to the Supabase project + Upstash + The Odds API + Anthropic + Stripe test keys. The authoritative env var list and ownership is in [`docs/infra/secrets-manifest.md`](./docs/infra/secrets-manifest.md). Do not commit secret values.

```bash
# web app (from repo root)
cd apps/web
npm install
npm run dev         # http://localhost:3000

# type + lint
npm run type-check
npm run lint

# ML worker
cd worker
pip install -e .    # or: uv sync
uvicorn app.main:app --reload
```

Integration and E2E tests live at repo root (`tests/`) and are driven by root-level `package.json` scripts (`npm run test:integration`, `npm run test:e2e`).

## Compliance posture

- 21+ age gate before any pick surface is rendered. See `docs/compliance/age-gate-spec.md`.
- State-by-state geo-block. Allowed states are configured via `GEO_ALLOW_STATES`. See `docs/compliance/state-matrix.md` and `docs/compliance/geo-block-spec.md`.
- Responsible-gambling disclaimer on every pick surface. Copy in `docs/compliance/copy/responsible-gambling.md`.
- No bet placement. No fund custody. The product is informational only.
- Pre-launch checklist: `docs/compliance/launch-checklist.md`.

## Further reading

- Agent + project policy: [`CLAUDE.md`](./CLAUDE.md)
- Task briefs: [`docs/briefs/`](./docs/briefs/)
- Architecture decisions: [`docs/adr/`](./docs/adr/)
- Data schema: [`docs/schema/`](./docs/schema/)
- API contracts: [`docs/api/`](./docs/api/)
- Runbooks (odds lag, pipeline failure, cost spike, domain migration): [`docs/runbooks/`](./docs/runbooks/)
- Infra + secrets: [`docs/infra/`](./docs/infra/)

## License

No license granted. All rights reserved. This repository is private source for a pre-launch product; nothing here is offered under an open-source license at this time.
