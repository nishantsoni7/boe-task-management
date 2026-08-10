# ADR-0002: Modular monolith, not services

- **Status:** accepted (**Reconstructed** — inferred from repository structure; no original decision record survives)
- **Date:** ~2026-05 (approximate)
- **Affects:** All
- **Supersedes / Superseded by:** none

## Context

The platform spans task management, attendance, payroll, performance, samples,
assets, meetings, orders and finance — 92 pages and 98 API routes as of
2026-08-11. These domains share one identity (`users`), one notification table
and one permission model, and attendance feeds payroll directly.

## Decision

Keep one deployable application with **internal** module boundaries. Modules own
their routes, their tables and their business logic. Cross-module access happens
through shared libraries in `src/lib`, not through network calls.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| Microservices per module | No operations team; attendance→payroll would become a distributed transaction for no benefit |
| One undifferentiated application | Already the failure mode being corrected — module-specific logic scattered in generic folders (R-14) |
| Separate database per module | Employee identity is shared by every module; joins would become application-level |

## Consequences

- A change spanning attendance and payroll is one commit, one deploy, one
  transaction.
- Boundaries are a **convention**, so they erode unless documented and checked —
  which is why the module documentation standard and `docs:check` exist.
- **Cost:** `src/lib` has become a shared drawer (211 files, some module-specific).
  Recorded as R-14 with a staged plan, not a rewrite.

## Migration / rollback

Boundaries can be tightened incrementally (see `11_File_Structure_Plan.md`)
without changing the deployment model.
