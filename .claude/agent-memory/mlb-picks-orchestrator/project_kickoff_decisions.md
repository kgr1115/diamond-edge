---
name: Kickoff Locked Decisions (Q&A 1-8)
description: 8 locked product/stack decisions from project kickoff Q&A, 2026-04-22
type: project
---

Locked as of: 2026-04-22

1. **Odds data:** The Odds API entry tier (~$79/mo). Hard ceiling $100/mo. No OddsJam/Sportradar in v1. Cached/scheduled pulls only — no real-time polling.
   - Why: Budget constraint. $100/mo hard cap for odds data.
   - How to apply: Data engineer designs around polling intervals, aggressive Upstash Redis caching.

2. **Sportsbooks:** DraftKings + FanDuel only for v1. Data model must be extensible for additional books without schema churn.
   - Why: Footprint overlap simplifies compliance targeting. Extensibility is a non-negotiable for v1.1+.

3. **Target states:** Intersection of states where BOTH DK and FD are fully legal and operational. Geo-block everywhere else. Authoritative list produced by Compliance agent.
   - Why: Minimize compliance surface for v1.

4. **Hosting:** Vercel (Next.js + API routes) + Supabase (Postgres + Auth + Storage) + Upstash Redis.
   - Constraint: Vercel function timeout 10s (hobby) / 60s (pro). LLM/ML steps exceeding this offload to Supabase Edge Functions or Fly.io worker.

5. **Auth:** Supabase Auth. Email + OAuth. Row-level security. Clerk is a swap option post-v1 if needed.

6. **Brand:** Diamond Edge.
   - Primary domain: diamondedge.ai (verified available 2026-04-22)
   - Backup: diamondedgepicks.com (verified available 2026-04-22)
   - Pre-launch blocker: USPTO trademark clearance at tmsearch.uspto.gov. "Diamond Edge Technology LLC" has 3 filings — must review before using brand.
   - Yellow flag: diamondedge.io registered 2026-02-08 (privacy-protected). Monitor.

7. **Frontend:** Next.js 15 App Router + TypeScript + Tailwind + shadcn/ui.
   - Why: Server Components for fast initial paint, shadcn for clean default aesthetics, TypeScript for safety.

8. **LLM routing:** Anthropic Claude only (no OpenAI in v1).
   - Default/free tier: Claude Haiku 4.5 (~$1-2/mo at ~15 picks/day)
   - Premium tier: Claude Sonnet 4.6 for marquee picks
   - Why: Cost control + brand alignment with Anthropic ecosystem.
