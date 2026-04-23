---
name: Operating Mode — Personal Use (SaaS-ready)
description: 2026-04-22 pivot — Diamond Edge is a personal tool for Kyle; commercial scaffolding preserved but dormant
type: project
---

**Decision date:** 2026-04-22 (session 4, mid-Phase 3)

**Decision:** v1 ships as a **personal-use tool for Kyle only**. Commercial SaaS code (Stripe, tiers, paywall, RG copy surfaces, age gate, geo-block, compliance tests) is **preserved in the repo but dormant**. Flip to commercial later without a rewrite is explicitly supported.

### What this changes

| Area | v1 behavior |
|---|---|
| Users | Single user (Kyle). Set `profiles.tier = 'elite'` manually after signup. |
| Stripe | Routes exist but never hit. No LLC or live Stripe account required. |
| Tier gating | Code still enforces; Kyle's Elite tier sees everything. |
| Age gate + geo-block | Code still runs; Kyle is 21+ in an allowed state so it's invisible to him. |
| USPTO trademark clearance | Not needed. Not blocking launch. |
| LLC formation | Not needed for personal use. |
| Attorney review | Not needed. |
| Launch date | No external launch. Deploy when feature-ready for Kyle. |

### What doesn't change

- Core product: ingestion → model → rationale → slate → pick detail → bankroll
- All Phase 0–2 code + TASK-011 QA stays in the repo
- Data sources, stack, LLM routing — all locked decisions still apply

### Cost envelope shift

| Service | Was (SaaS v1) | Now (personal) |
|---|---|---|
| Vercel | Pro $20/mo (for 60s functions) | **Hobby $0** (10s function limit; pipeline stays on Supabase Edge + Fly.io anyway) |
| Supabase | Pro $25/mo | **Free $0** (500 MB DB, 50K MAU — plenty for 1 user) |
| Upstash Redis | ~$5/mo | **~$0** (free-tier free allowances) |
| Fly.io worker | ~$2–5/mo | Unchanged (~$2–5/mo) |
| The Odds API | $79/mo entry tier | Choice: free tier 500 req/mo (once-daily poll) **OR** entry $79/mo for more polling flexibility |
| Anthropic LLM | ~$1/mo | Unchanged (~$1/mo) |
| **Total** | **~$130/mo** | **~$3–85/mo** |

### How this guides future decisions

- **Any "pre-launch blocker" flagged in launch-checklist.md is SKIPPED** for personal use (trademark, LLC, attorney review). Revisit if flipping commercial.
- **Free-tier limits are the new budget envelope.** Don't propose anything that exceeds free-tier quotas.
- **Don't delete dormant SaaS code.** The whole point of this mode is optionality — ripping out Stripe/tiers/paywall forecloses the commercial flip.
- **Deploy targets:** Vercel Hobby, Supabase Free project (region closest to Kyle), Fly.io worker (scale-to-zero), Upstash pay-as-you-go.

### What Kyle still has to provide

Cannot be automated — requires Kyle's real-world action:
- Create Vercel account + link git repo
- Create Supabase project
- Create Upstash Redis account
- Create Fly.io account
- Create The Odds API account (free or entry tier)
- Create Anthropic API key
- Share all API keys / URLs for secrets manifest

### Immediate implications for Phase 3

- **TASK-012 downgrades to free-tier provisioning.** Budget gate effectively removed; still needs Kyle to create accounts.
- **ML model training is still needed** — without it, the pipeline writes zero picks. This is the highest-value unblocker left.
- **Historical odds data for backtest** is a real problem. The Odds API free tier does not provide history. Alternatives: scrape public archives, use a different source, or ship v1 without a backtested model and iterate live.
