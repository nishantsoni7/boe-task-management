# ADR-0005: Employee-facing rule content derives from engine constants

- **Status:** accepted
- **Date:** 2026-08-11
- **Affects:** Payroll, Documentation
- **Supersedes / Superseded by:** none

## Context

`/payroll/how-it-works` explains to employees how their salary is calculated. It
is the page an employee checks their payslip against.

It stated that a Half Day was "3.75-5 effective hours" and listed a "Short
Present" classification — for months after `classification.ts` had merged those
bands, so that a half day is **2-5 hours** and Short Present is no longer
produced at all. The old copy had been written from a business brief; the brief
had drifted from the engine.

A second, older instance of the same failure: `PAYROLL_RULES_V1.md` says salary
divided by 30 while the engine has always divided by 26 (mismatch M-1).

## Decision

Any employee-facing content that states a calculation rule must **import the
constant the engine calculates with**. No threshold, divisor, rate or worked
figure is typed into a page or a content module.

Where a rule is a behaviour rather than a constant — such as which band a set of
hours falls into — the test asserts the described band **against the classifier's
actual output**, not against its constants.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| Write the copy carefully and review it | Already the process that failed, twice |
| Generate the page from the engine entirely | The reasons need human prose; only the numbers should be derived |
| Show live payroll settings instead | `payroll_settings` is admin-read-only under RLS; an employee cannot read it |

## Consequences

- Changing a rule changes the explanation, or breaks the build.
- `guide.test.tsx` drives punch times through the real classifier and asserts no
  retired classification can be produced.
- **Cost:** content modules must import from `src/lib/payroll`, coupling the
  presentation layer to the domain layer — accepted deliberately, because the
  alternative is a page that lies about somebody's pay.
- **Cost:** the guide states the **standard** rules. A generated month uses the
  settings pinned to it, which the page says rather than implies.

## Migration / rollback

Applies to new and edited rule-bearing content. Existing narrative rule
documents (`05_Business_Rules.md`, `PAYROLL_ATTENDANCE_RULES.md`) still predate
the settings model — tracked as mismatch M-4.
