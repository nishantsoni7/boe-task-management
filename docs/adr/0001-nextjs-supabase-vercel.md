# ADR-0001: Next.js App Router + Supabase + Vercel

- **Status:** accepted (**Reconstructed** — inferred from the repository; no original decision record or exact date survives)
- **Date:** ~2026-05 (approximate; first commits)
- **Affects:** All
- **Supersedes / Superseded by:** none

## Context

BOE needed an internal operating system built and iterated by a very small team,
with authentication, a relational database, row-level security and hosting, and
without a dedicated infrastructure owner.

Evidence in the repository: `next` 16.2.6 with the App Router (`src/app`),
`@supabase/supabase-js` and `@supabase/ssr`, 159 SQL migrations under
`supabase/migrations`, and Vercel as the deployment target.

## Decision

Build one Next.js App Router application, using Supabase for Postgres, Auth and
row-level security, deployed on Vercel.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| Separate API service + SPA | Two deployables, two auth integrations, no team to run them |
| Firebase / document store | Payroll and attendance are relational and need SQL joins and constraints |
| Self-hosted Postgres | Requires an operator BOE does not have |

## Consequences

- Auth, RLS and the database arrive together; RLS can be a real security
  boundary rather than an application convention.
- Server-side authorization is expressed in route handlers and SQL policies, not
  in a separate service.
- **Cost:** 78 of 98 API routes use the service role and therefore bypass RLS —
  in those the handler is the only boundary. See R-2 in the risk register.
- **Cost:** vendor coupling. Replacing Supabase would mean rewriting auth,
  policies and 159 migrations.

## Migration / rollback

Not practically reversible. Any move would be a rewrite, not a migration.
