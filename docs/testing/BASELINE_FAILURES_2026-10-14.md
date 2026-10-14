# Baseline unit-test failures (2026-10-14)

The unit suite has 18 failing tests on **origin/main itself**, before any rebrand change. The rebrand
branch (`feat/boe-rebrand`) fails exactly the same 18 and **adds none**.

## How the two runs were made (comparable environments)

| | Baseline | Branch |
| --- | --- | --- |
| Tree | clean worktree of `origin/main` | `feat/boe-rebrand` |
| Node | v24.12.0 | v24.12.0 |
| Command | the repo's `npm test` runner (`tsx --test`, all `*.test.ts(x)`) | same |
| `.env.local` | moved aside (so live-database suites do not run against a mock) | moved aside |
| Result | 17 343 tests, 17 324 pass, **18 fail** (10 named tests + 8 suite files that fail to load) | same 18 failing names; the failing-name lists of the two logs are identical |

## The 18 failing tests

| Suite file | Failing test | Cause |
| --- | --- | --- |
| `src/app/api/notifications/routeBehaviour.test.ts` | the list shows visible rows only, newest first, and never leaks the task join | assertion: a "visible-read" row is missing from the feed |
| ″ | hidden rows are removed before paging: no empty page, no false "older" | same family (notification feed) |
| ″ | bulk scope › Delete all removes the visible rows and keeps hidden history | same family |
| ″ | bulk scope › Delete all for one task stays inside that task | same family |
| ″ | bulk scope › a large inbox is mutated in concurrent chunks, within the bound | same family |
| ″ | bulk scope › Delete all failing part-way reports exact counts, keeps hidden rows, and a retry finishes | same family |
| ″ | View As › naming yourself is an ordinary read | same family |
| ″ | View As › an administrator previews an eligible employee's feed, filtered the same way | same family |
| `src/app/orders/drafts/[submissionId]/piDetail.render.test.tsx` | the layout is CSS, at real breakpoints › every column of this page is minmax(0, …) | asserts a `1fr 1fr` grid cannot overflow; unrelated to colour |
| `src/lib/notificationSystemActivity.test.ts` | the read side excludes system types too › no repo migration installs a trigger, webhook or job that sends one | migration-inventory deep-equal against the migrations folder |

Eight further suite files fail to load, each a single "test failed" with no inner tests (counted among the 18):

- `src/app/api/payroll/delete/route.test.ts`
- `src/app/api/payroll/periods/route.test.ts`
- `src/app/api/payroll/settlementAuth.test.ts`
- `src/app/api/payroll/unlock/route.test.ts`
- `src/lib/security/attendancePayrollApiIsolation.test.ts`
- `src/lib/security/attendancePayrollIsolation.test.ts`
- `src/lib/security/objectionIsolation.test.ts`
- `src/lib/security/usersPrivateColumns.test.ts`

None of these files is touched by the rebrand, and none reads a colour, font or radius.
