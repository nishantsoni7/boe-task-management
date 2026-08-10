# File Structure Plan

Last verified: **2026-08-11**

A direction, not a migration order to execute now. **No mass relocation is
proposed for this phase**, and none was performed.

---

## Where things are (measured 2026-08-11)

```text
src/
  app/          92 pages, 9 layouts, 98 API route handlers   ← Next.js App Router
  components/   57 shared components
  lib/          211 modules  ← the problem area
  hooks/        21 files
  contexts/
scripts/        4 utility scripts
supabase/
  migrations/   159 SQL files
docs/
```

## The actual problem

`src/lib` is a shared drawer, not a shared library. It holds genuinely shared
infrastructure (`supabase/`, `notifications.ts`, `istDate.ts`, `ui.ts`) **next
to** module-specific domain logic that nothing else imports:

| File | Lines | Really belongs to |
| --- | --- | --- |
| `lib/teamPerformance.ts` | 1,774 | Performance |
| `lib/objections.ts` + 3 test files | — | Attendance & Payroll issues |
| `lib/orderRequestAttachments*.ts` | 5 files | Orders |
| `lib/performance*.ts` | 9 files | Performance |
| `lib/sampleNotificationDeletes.ts` | — | Samples |

Meanwhile some genuinely shared things live inside one module's folder.

This is R-14. It is a **clarity** cost, not a correctness one — nothing is
broken, ownership is just unclear.

## Direction (adapted to this repository)

```text
src/
  app/         routes and layouts ONLY — never moved out of the App Router
  features/    attendance/ payroll/ tasks/ performance/ samples/
               assets/ meetings/ orders/ finance/ members/
  shared/      ui/ auth/ notifications/ validation/ utilities/
  server/      database/ authorization/ observability/
```

`src/lib/<module>/` subfolders (`lib/payroll`, `lib/assets`, `lib/meetings`,
`lib/attendance`, `lib/permissions`, `lib/security`) **already follow this
shape**. The realistic path is to finish that pattern where it exists rather than
introduce a new top-level tree.

## Candidate moves

| Current | Target | Reason | Imports affected | Tests required | Risk | Now? |
| --- | --- | --- | --- | --- | --- | --- |
| `lib/performance*.ts` (9), `lib/teamPerformance*.ts` (3) | `lib/performance/` | Only Performance imports them | ~25 | Existing 6 test files must pass unchanged | Low | **No** — do it when Performance is next worked on |
| `lib/objections*.ts` (4) | `lib/attendance-payroll/` or `lib/objections/` | Owned by one module | ~15 | 3 existing test files | Low | **No** |
| `lib/orderRequestAttachment*.ts` (5) | `lib/orders/` | `lib/orders/` already exists | ~10 | 4 existing test files | Low | **No** |
| `lib/sampleNotificationDeletes.ts` | `lib/samples/` | New folder for an existing module | ~3 | 1 test file | Low | **No** |
| Route files | anywhere | — | — | — | — | **Never.** They must stay in the App Router |

## Why nothing is moved now

1. Every move is a rename with no behavioural benefit, and this branch already
   carries two feature commits under review.
2. The audit found **higher-value** work first: the authorization duplication
   (R-2) and the untested UI surface (R-4). Moving files fixes neither.
3. Renames make the diff of a genuinely risky change harder to review. Mixing
   them in is exactly what the task instructions forbid.

## Entry condition for doing it

Move a module's files **only** when that module is already being changed for a
product reason, in a **separate commit** from the product change, with its tests
passing before and after and no other edit in the diff.
