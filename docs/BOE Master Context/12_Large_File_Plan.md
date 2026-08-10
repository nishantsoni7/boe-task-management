# Large File Decomposition Plan

Last verified: **2026-08-11**

Line counts measured on 2026-08-11. **Nothing was decomposed in this phase** —
this is the sequenced plan (R-3).

A file is a candidate when it **combines responsibilities**, hides permission or
calculation logic, causes repeated merge conflicts, or cannot be tested. Not
merely because it is long. Splitting a coherent 1,300-line file into four
incoherent ones is a loss.

---

## Candidates, scored

| File | Lines | Responsibilities | Permission branches | Tests | Risk | Priority |
| --- | --- | --- | --- | --- | --- | --- |
| `src/app/finance/page.tsx` | 2,679 | list + filters + create + approve + destinations + modals | several | none | **High** — money | **1** |
| `src/app/tasks/[id]/page.tsx` | 2,621 | detail + activity + attachments + status + comments + edit | several | none | **High** — core daily workflow | **2** |
| `src/app/orders/requests/page.tsx` | 2,061 | list + filters + create + edit + attachments | `admin OR assigned_to` | partial (`components/shared.test.ts`) | Medium | 3 |
| `src/app/orders/requests/[id]/page.tsx` | 1,983 | detail + panels + actions | several | partial | Medium | 4 |
| `src/app/assets-access/[id]/page.tsx` | 1,821 | 5 detail sections + custody + requests | permission engine | `lib/assets/*` covers logic | Medium | 5 |
| `src/app/performance/team/page.tsx` | 1,817 | team view + scoring display + filters | manager/admin | `teamPerformance.test.ts` covers logic | Medium | 6 |
| `src/lib/teamPerformance.ts` | 1,774 | queries + scoring + aggregation | — | yes | Low — tested, single domain | 7 |
| `src/app/tasks/my/page.tsx` | 1,730 | list + tabs + filters + bulk | own-scoping | `listState.test.ts` partial | Medium | 8 |
| `src/app/admin/control-center/page.tsx` | 1,583 | modules + departments + members + order numbering | admin | none | Medium | 9 |
| `src/app/payroll/results/[periodId]/[employeeId]/PayrollDetailView.tsx` | 1,513 | payslip + tabs + corrections + adjustments | admin | `lib/payroll/*` covers logic | Low — domain well tested | 10 |

**20 files exceed 1,200 lines.** The top two carry the most business risk with
the least test cover, which is why they are first.

---

## Extraction order (per file)

Apply in this order, **one commit per step**, tests green between each:

1. **Constants and types** — zero behaviour, immediately safe
2. **Pure formatting helpers** — `fmt*`, label maps, tone maps; now unit-testable
3. **Stateless UI sections** — presentational components taking props only
4. **Data-fetching hooks** — `useX()` returning query state
5. **Mutation hooks** — writes, with their optimistic/invalidations
6. **Domain services** — pure logic into `src/lib/<module>/`, with tests
7. **Permission policies** — the branch conditions into one named predicate

Steps 1–3 are safe refactors. Steps 4–7 change structure and **require a test
written first**, because they move logic that currently has none.

## Entry conditions

- The module is already being worked on for a product reason, **or** the file has
  caused a conflict or a defect.
- Tests exist for whatever step 4+ moves — write them **before** the move.
- One file per branch. Never combine decomposition with a feature change.

## Exit condition

The file no longer hides a permission branch or a calculation, and every
extracted domain service has a test. **Not** a line-count target.

## First task, ready to pick up

`src/app/finance/page.tsx`, steps 1–3 only: extract status/label constants,
currency and date formatters, and the read-only summary sections. No hook or
permission change. Expected diff: one new `financeConstants.ts`, one new
`financeFormat.ts` with tests, one `FinanceSummary.tsx`, and roughly 400 lines
removed from the page. Risk: low. Verification: `npm run verify` plus a signed-in
pass over `/finance`.
