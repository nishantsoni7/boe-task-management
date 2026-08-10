# ADR-0006: Server authorization is independent of navigation visibility

- **Status:** accepted
- **Date:** 2026-08-11 (recording a rule already enforced in code)
- **Affects:** All
- **Supersedes / Superseded by:** none

## Context

The platform has two separate controls that are easy to confuse:

1. **Module visibility** (`app_modules`: live / admin_only / department_only /
   custom / hidden) — decides whether a launcher card appears.
2. **Route and API authorization** — decides whether a request is served.

An earlier build treated `custom` visibility as a grant of **management**
access, which meant a named member could read the whole company's salaries. The
product owner rejected that reading explicitly.

Measured 2026-08-11: client route gating is inconsistent — some families have a
layout guard, some gate inside the page, several rely on the API alone. 78 of 98
API routes use the service role and therefore bypass RLS entirely.

## Decision

**Navigation visibility is never authorization.** Hiding a link is a usability
decision. Every protected operation is refused by the server — a route guard, a
route-handler check, or an RLS policy — independently of what the navigation
shows.

For Attendance and Payroll specifically, `resolveManagementAccess` returns
`admin` regardless of visibility mode, and `custom` grants an employee their
**own** record only.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| Let `app_modules` drive authorization | A launcher toggle could then disclose the payroll of people the viewer does not manage |
| Rely on client guards | Trivially bypassed; also produced the false belief that a missing guard is a hole |
| Rely on RLS alone | 78 routes use the service role and bypass it |

## Consequences

- A missing client guard is not automatically a vulnerability, and a present one
  is not automatically safety. The server is the answer both times.
- Every new service-role route **must** carry its own check — which is exactly
  the gap R-2 records, with 71 routes hand-rolling it in 9 different shapes.
- Documentation must state enforcement location per route family, which is what
  `08_Authorization_Matrix.md` does.

## Migration / rollback

Not reversible; it is a security posture. The follow-up work is R-2: converge
the 71 hand-rolled checks onto one shared helper.
