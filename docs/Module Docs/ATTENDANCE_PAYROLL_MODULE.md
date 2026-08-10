# Attendance & Payroll Module

Last Updated: 11 August 2026

## Purpose

`Attendance & Payroll` is **one module to the user and two domains to the code.**

Attendance is where payroll's input comes from — the punches imported from the
fingerprint machine are what every salary figure is computed against. Presenting
them as two modules meant two launcher cards, two navigation shells, two sets of
branding and two copies of the same link list, so a person doing one month's work
had to return to `/modules` to cross between halves of a single job.

This document describes the **combined user interface**. It does not change, and
must not be read as changing, anything below it.

---

## What is combined, and what is not

### Combined (user interface only)

| Was | Is now |
| --- | --- |
| Two launcher cards, `Attendance` and `Payroll` | One card, `Attendance & Payroll` |
| `AttendanceLayout` + `PayrollLayout` (two near-identical shells) | One shell, `AttendancePayrollLayout` |
| Two hand-copied sidebar arrays | One definition, `attendancePayrollNav.tsx` |
| Two sidebar brands, "Attendance & Salary" and "Payroll" | One, "Attendance & Payroll" |
| Two sidebar doors onto the same issue feed | One, the `IssueNotificationBell` |

### NOT combined (unchanged)

- **Database tables.** Attendance tables and payroll tables are untouched. No
  migration was required or written for this change.
- **Calculations.** Attendance classification, the payroll engine, salary rules,
  paid-leave rules, rounding — none of it is referenced by the shell.
- **Route trees.** `/attendance/*` and `/payroll/*` still exist exactly as they
  did. Every existing URL, bookmark and notification deep link resolves as before.
- **Guards.** `AttendanceGuard` (`src/app/attendance/layout.tsx`) and
  `PayrollGuard` (`src/app/payroll/layout.tsx`) are separate and still resolve
  management access independently.
- **`app_modules` rows.** `attendance` and `payroll` are still two rows with two
  visibility settings, configured independently in Control Center.
- **Workflows.** Import, correction, generation, locking/unlocking, adjustments,
  issues and audit history are all as they were.

---

## The launcher card

One card, `Attendance & Payroll`, defined in `src/app/modules/page.tsx`.

**Visibility is the union of the two `app_modules` rows.** Whoever could open an
Attendance card *or* a Payroll card before sees the combined one. A narrower rule
would silently revoke access somebody already has; `hidden` on both still hides it.

**Destination follows what the person can actually open:**

| Who | Lands on |
| --- | --- |
| Admin | `/payroll` |
| Employee with the module | `/my-attendance` |
| Employee granted Payroll while Attendance is hidden | `/my-payroll` |

The card is not an authorisation. Admin destinations are behind the guards;
self-service destinations are served by APIs that derive the employee from the
bearer token, so there is no employee id to tamper with.

---

## Navigation

One definition in `src/components/layout/attendancePayrollNav.tsx`, rendered by
one shell. The mobile menu is the same `<aside>` with a class toggled, so desktop
and mobile cannot disagree.

### Admin

1. Overview — `/attendance`
2. Employee Master — `/attendance/employees`
3. Attendance Upload — `/attendance/upload`
4. Attendance Records — `/attendance/records`
5. Monthly Attendance Review — `/attendance/monthly-review`
6. Payroll Runs — `/payroll`
7. Payroll Monthly Preview — `/payroll/monthly-review`
8. How Payroll Works — `/payroll/how-it-works`
9. Payroll Settings — `/payroll/settings`
10. Holiday Management — `/attendance/holidays`

Plus the issue feed, via the notification bell → `/attendance/notifications`.

Two entries carry their page's own title rather than a shared one:
`/attendance/monthly-review` is **Monthly Attendance Review** (the attendance
summary) and `/payroll/monthly-review` is **Payroll Monthly Preview** (the
engine's computed payroll). They are different screens over different data, and
one label named "Monthly Review" for both would be a link that lies about where
it goes.

**Not in the navigation, deliberately:**

- **Issues** — the door onto the issue feed is the bell, which carries the unread
  count. A second plain link would be the duplicate entry point this
  consolidation removes.
- **Salary Report** — `/payroll/results/[periodId]/salary-report` exists only for
  a chosen period. There is no period-free route to link to, and it is reached
  from a payroll run, where the period is known.

### Employee

1. My Attendance — `/my-attendance`
2. My Payroll — `/my-payroll`
3. My Issues — `/my-issues`
4. How Payroll Works — `/payroll/how-it-works`

Plus the bell → `/my-issues/notifications`.

`How Payroll Works` is the **one** `/payroll` route an employee may open:
`PayrollGuard` admits everybody to it and redirects them away from every other
route under `/payroll`. The page renders rule constants and reads no employee
record, which is why that exception is safe.

### Active state

`isAttendancePayrollNavItemActive` decides which item renders as the current
page. Matching is **segment-aware**, so `/attendance/records` does not light up
for a route that merely starts with the same characters. `/attendance` and
`/payroll` match exactly, so a module root does not claim every page beneath it;
`/payroll/results/*` keeps **Payroll Runs** lit, and
`/attendance/correction-log` keeps **Overview** lit, since that is where it is
reached from.

---

## The How Payroll Works guide

`/payroll/how-it-works` — the one page in the module that explains rather than
reports. It is the only `/payroll` route an employee may open, because it holds
no employee data at all.

### Purpose

Teach the calculation path in about two minutes, to somebody with no payroll or
accounting knowledge, and then hold the detail for anybody who wants it.

### Information sequence

A hero (one sentence + the formula strip), then an eight-step **journey** with a
guide rail beside it, then reference sections:

1. Attendance is recorded
2. Attendance is reviewed and corrected
3. Payable days are determined
4. Your salary becomes a daily and hourly rate
5. Attendance deductions are calculated
6. Paid leave absorbs the first thing it can
7. Salary After Attendance is produced
8. Balance and adjustments give Salary Payable

Then: a month worked through · what each day counts as · the rules that affect
pay · if something looks wrong · full rules and glossary.

The rail carries the payslip's figures at a glance, the numbers that decide pay,
the day-mark legend, a "what can change my salary" checklist, role-safe onward
links, and a jump list. On desktop it is a second column (~65/35); below 1080px
it falls into the reading order after the journey it summarises. **Nothing is
sticky** — the shell's page header already is, and a rail taller than the
remaining viewport would stick with its own bottom unreachable.

### Source-of-truth rule

**Every threshold, divisor, rate and worked figure the page shows is imported
from the constants the engine calculates with** — `src/lib/payroll/rules.ts`,
`src/lib/attendance/scheduleRules.ts`, and `payableDayValue` from
`src/lib/payroll/resultTabs.ts`. Prose describing a rule is written in
`guideContent.ts`; the rule itself is never retyped there.

This is not a style preference. The guide shipped for months saying a half day
was "3.75–5 effective hours" after `classification.ts` had merged that band down
to the presence floor, and stating a "Short Present" classification the engine
had stopped producing. `guide.test.tsx` now asserts the described bands against
the **classifier's own behaviour**, so the next such drift breaks a test instead
of misinforming an employee.

Displayed values are the **standard** rules. Payroll parameters are configurable
(`payroll_settings`), but that table is admin-read-only under RLS and the
settings API refuses a non-admin, so the page cannot show live settings to
everybody. A month already generated was calculated with the settings pinned to
it; the page says so rather than implying its numbers describe every month.

### Role-safe links

The educational content is identical for both roles. Only the onward links
differ, and they are never merged:

| Role | Offered |
| --- | --- |
| Employee | `/my-attendance`, `/my-payroll`, `/my-issues` |
| Admin | `/attendance/monthly-review`, `/payroll`, `/payroll/settings` |

An employee is offered no management route. This is a usability split, never the
control — `PayrollGuard`, the route handlers and RLS are what refuse access.

---

## Access model (unchanged)

The split described in `SELF_SERVICE_MODULE_KEYS` (`src/lib/moduleAccess.ts`)
still governs everything:

- **Management** — `/attendance/*` and `/payroll/*`. Every screen reads the whole
  company. **Admins only, always.** No visibility setting can widen this.
- **Self-service** — `/my-attendance`, `/my-payroll`, `/my-issues`. One person's
  own record and only ever their own.

The `app_modules` row governs the **self-service** surface: whether an employee
sees a card at all, and `custom` names the individuals who do. It has never
granted management access and still does not.

Hiding a navigation item is a usability decision, never a control. The guards,
the route handlers and RLS are what refuse access — see
`supabase/migrations/20260812000000_attendance_payroll_isolation.sql`.

---

## Files

| File | Role |
| --- | --- |
| `src/components/layout/attendancePayrollNav.tsx` | The one navigation definition |
| `src/components/layout/AttendancePayrollLayout.tsx` | The one module shell |
| `src/app/modules/page.tsx` | The one launcher card |
| `src/app/payroll/how-it-works/page.tsx` | The guide |
| `src/app/payroll/how-it-works/guideContent.ts` | Its content, derived from the engine's constants |
| `src/app/payroll/how-it-works/GuideVisuals.tsx` | Its illustrations |
| `src/app/attendance/layout.tsx` | `AttendanceGuard` — unchanged |
| `src/app/payroll/layout.tsx` | `PayrollGuard` — unchanged |

### Tests

| File | Covers |
| --- | --- |
| `src/components/layout/attendancePayrollNav.test.tsx` | One card, one shell, one nav; every path is a real route; employee list has no management route; active state |
| `src/app/payroll/how-it-works/guide.test.tsx` | The guide's stated rules against the engine's own behaviour; journey order; role-safe links; layout, accessibility and no-structural-change |
| `src/app/payroll/payrollGuideAccess.test.ts` | The guide is reachable from both lists via the shared constant |
| `src/lib/attendancePayrollNotifications.test.ts` | One issue feed, one bell, one door |
| `src/lib/moduleAccess.test.ts` | The visibility rules the launcher and guards share |
| `src/lib/security/attendancePayroll*.test.ts` | Row and API isolation |

---

## Related

- `PAYROLL_ATTENDANCE_RULES.md` — how attendance feeds the payroll calculation
- `PAYROLL_RULES_V1.md` — salary rules (`src/lib/payroll/rules.ts` supersedes it)
- `ATTENDANCE_PAYROLL_ISSUES.md` — the employee issue workflow
- `ATTENDANCE_MODULE_PLAN.md` — the attendance domain's own plan
- `../BOE Master Context/BOE_GLOBAL_NAVIGATION_STANDARD.md`
