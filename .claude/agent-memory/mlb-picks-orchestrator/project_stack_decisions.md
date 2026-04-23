---
name: Locked Tech Stack Summary
description: Full stack, infra providers, and key tooling locked for Diamond Edge v1
type: project
---

Locked as of: 2026-04-22

## Frontend
- Framework: Next.js 15, App Router, TypeScript
- Styling: Tailwind CSS + shadcn/ui
- Hosting: Vercel

## Backend
- API layer: Next.js API routes (Vercel)
- Database: Supabase Postgres
- Auth: Supabase Auth (email + OAuth, RLS)
- File/blob storage: Supabase Storage
- Cache: Upstash Redis
- Background jobs: Vercel Cron (light) + Supabase Edge Functions (heavier, >10s)
- Overflow worker: Fly.io (if LLM/ML inference exceeds Edge Function limits)

## Data
- Odds: The Odds API (entry tier, ~$79/mo, cached pulls)
- MLB stats: MLB Stats API (free, public)
- Statcast: Baseball Savant (free, scrape-friendly)
- Weather: TBD (low-cost or free API)
- Sportsbooks covered: DraftKings + FanDuel (v1)

## AI/ML
- LLM: Anthropic Claude
  - Haiku 4.5: free/default tier picks
  - Sonnet 4.6: premium tier picks
- Statistical model: TBD by ML agent (likely Python-based, runs on Fly.io or Edge Function)

## Billing
- Stripe (subscriptions, webhooks)

## Monitoring/Observability
- TBD by DevOps agent (likely Vercel Analytics + Sentry + Supabase built-ins)

## Brand
- Name: Diamond Edge
- Primary domain: diamondedge.ai
- Backup domain: diamondedgepicks.com
