# ADR-0004: Attendance & Payroll combined at the UI level, separate internally

- **Status:** accepted
- **Date:** 2026-08-10
- **Affects:** Attendance, Payroll
- **Supersedes / Superseded by:** none

## Context

Attendance and Payroll were presented as two modules: two launcher cards, two
near-identical shell components, two hand-copied sidebar arrays, two brand
labels and two sidebar doors onto one shared issue feed.

Attendance is where payroll's input comes from — the punches are what every
salary figure is computed against — so a person doing one month's work had to
return to `/modules` to cross between halves of a single job.

The duplication caused real defects: `/attendance/monthly-review` was reachable
from **neither** sidebar, and an employee opening the payroll calculation guide
was shown the **admin** payroll link list, every entry of which the guard
bounced.

## Decision

Present Attendance and Payroll as **one module** in the interface — one launcher
card, one shell, one navigation definition — while keeping them **two separate
domains** in the code: separate tables, calculations, guards, audit trails and
URL trees.

Launcher visibility is the **union** of the two `app_modules` rows, so nobody
loses access they had.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| Leave them separate | The duplication was actively producing defects |
| Merge the route trees too | Would break every existing URL, bookmark and notification deep link for no user benefit |
| Merge the `app_modules` rows | Needs a migration and removes an admin's ability to configure them independently |
| Intersect visibility instead of union | Silently revokes access some employees have today |

## Consequences

- One place to add a link; the two sidebars cannot drift apart again.
- Both URL trees keep working, including `/payroll/notifications`, which is now
  a second address for one page rather than a second door.
- **Cost:** the module owns two route trees, which contradicts the naive reading
  of the global navigation standard. That standard was amended to say a module
  may own several trees but must have **one** navigation definition.
- **Cost:** `resolveManagementAccess` must keep treating the two `app_modules`
  keys as self-service modules; merging them later would need care.

## Migration / rollback

No migration; UI only. Reversible by restoring the two shell components — but
the duplication would return with them.
