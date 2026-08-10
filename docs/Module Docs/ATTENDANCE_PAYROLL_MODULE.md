# Attendance & Payroll Module

Last verified: **2026-08-11** (commit `a33c14e`)

## Status

**Active** — in daily production use.

The **UI consolidation described below is branch-only** on
`feat/attendance-payroll-module-merge` (`789c771`, `a33c14e`). It is not merged
to `main` and not deployed. The underlying attendance and payroll domains have
been in production for months and are unaffected by it. No migration is required.

## Users

| Who | Uses it for |
| --- | --- |
| **Admin** | Import attendance, review and correct days, manage holidays, generate/lock/unlock payroll, enter adjustments, record settlements, review employee issues, edit payroll settings |
| **Employee** | Their own attendance, their own payslips, raising and tracking issues, and the calculation guide |
| **Manager** | No management access. Treated as an employee here (see ACC-1) |

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

## Routes

| Route | Who | What it is |
| --- | --- | --- |
| `/attendance` | Admin | Module overview |
| `/attendance/employees` | Admin | Employee master / fingerprint mapping |
| `/attendance/upload` | Admin | Monthly machine-export import |
| `/attendance/records` | Admin | Imported attendance records |
| `/attendance/monthly-review` | Admin | Monthly Attendance Review (+ `/[userId]`) |
| `/attendance/holidays` | Admin | Holiday management |
| `/attendance/correction-log` | Admin | Correction audit trail |
| `/attendance/notifications` | Admin | Issue feed (canonical address) |
| `/payroll` | Admin | Payroll runs |
| `/payroll/monthly-review` | Admin | Payroll Monthly Preview (+ `/[userId]`) |
| `/payroll/results/[periodId]` | Admin | One run's results |
| `/payroll/results/[periodId]/[employeeId]` | Admin | One payslip |
| `/payroll/results/[periodId]/salary-report` | Admin | Salary processing report |
| `/payroll/settings` | Admin | Central payroll settings |
| `/payroll/notifications` | Admin | Same feed; kept for existing links |
| `/payroll/how-it-works` | **Everyone** | Calculation guide — holds no employee data |
| `/my-attendance` | Employee | Own attendance |
| `/my-payroll` (+ `/[periodId]`) | Employee | Own payslips |
| `/my-issues` (+ `/notifications`) | Employee | Own issues and their feed |

## APIs

| Route handler | Who | Enforcement |
| --- | --- | --- |
| `/api/attendance/import`, `/preview` | Admin | `ALLOWED_ROLES` in each route (service role) |
| `/api/attendance/records`, `/monthly-summary`, `/employee-records` | Admin | In-route role check + RLS |
| `/api/attendance/employee-monthly-detail` | Employee (own) | Employee derived from bearer token |
| `/api/payroll/periods`, `/generate`, `/lock`, `/unlock`, `/delete` | Admin | `requireAdmin` (`src/lib/security/attendancePayrollApiAuth.ts`) |
| `/api/payroll/adjustments`, `/settlement`, `/attendance-correction` | Admin | In-route admin check |
| `/api/payroll/salary-report` | Admin | In-route admin check (`salaryReportAuth.test.ts`) |
| `/api/payroll/settings` | Admin | `requireAdmin`; `payroll_settings` RLS is admin-only |
| `/api/payroll/my-result` | Employee (own) | **Employee id is the caller's; no parameter to tamper with** |
| `/api/payroll/ask` | Any signed-in | Grounded in rule constants; holds no employee data |

## Tables

| Table | Owns | RLS | Migration |
| --- | --- | --- | --- |
| `attendance_records` | Raw imported punches (overwritten by import) | Isolated | `20260609` |
| `attendance_day_corrections` | Date-level corrections, all versions kept | Isolated | `20260807000000` |
| `payroll_periods` | A month, its status and its `settings_snapshot` | Isolated | `20260611`, `20260828000000` |
| `payroll_results` | Per-employee figures (**no month/year — those are on the period**) | Isolated | `20260614`, `20260615` |
| `payroll_deduction_lines` | One line per rule per date | Isolated | `20260615` |
| `payroll_pending_adjustments` | Manual additions/recoveries + category | Isolated | `20260829000000` |
| `payroll_settlements` / `payroll_settlement_events` | Payment recorded, carry-forward | Isolated | `20260826000000` |
| `payroll_period_status_events` | Append-only status audit (**0 write policies**) | Append-only | `20260811000000` |
| `payroll_holidays` | Company holidays — **currently empty (R-12)** | Isolated | `20260613` |
| `payroll_settings` | Versioned, append-only settings | **Admin read only** | `20260828000000` |

Row isolation for the payroll tables: `20260812000000_attendance_payroll_isolation.sql`.

## Permissions

Admin-only management, employee-only self-service. The full matrix, including
enforcement file per route family, is in
[../BOE Master Context/08_Authorization_Matrix.md](../BOE%20Master%20Context/08_Authorization_Matrix.md).
The governing rules are ACC-1, ACC-2 and ACC-3 in the business-rule index.

## Main workflows

1. **Import** — admin uploads the monthly machine export; unmatched codes are
   mapped to employees by hand.
2. **Review and correct** — admin restates a date or waives a charge, always with
   a written reason. The machine record is never overwritten (ATT-7).
3. **Generate** — payroll is computed from reviewed attendance, with the active
   settings pinned to the period (PAY-16).
4. **Settle** — admin records what was paid; the closing balance carries forward
   (PAY-12).
5. **Lock** — the month is frozen; only an admin can unlock (PAY-17).
6. **Issue loop** — employee raises, admin decides, employee is notified and may
   re-raise once answered (ISS-1, ISS-2).

## Business rules

PAY-1 … PAY-19, ATT-1 … ATT-11, ISS-1 … ISS-4, ACC-1 … ACC-4 in
[../BOE Master Context/07_Business_Rule_Index.md](../BOE%20Master%20Context/07_Business_Rule_Index.md).
Open mismatches affecting this module: **M-3** (`threshold_half_day_hours`) and
**M-4** (narrative rule docs predate the settings model).

## Notifications

One category, `attendance_payroll`, admin-only by category
(`notificationAccess.ts`). Types: `attendance_issue_raised`,
`payroll_issue_raised`, `attendance_issue_reviewed`, `payroll_issue_reviewed`.
Deep links: attendance → `/attendance/correction-log`; payroll →
`/payroll?issue=<id>`; employee outcomes → `/my-issues?issue=<id>`.
**`notifications.type` is a Postgres enum — apply its migration before the code.**

## Audit history

Attendance corrections keep every version. `payroll_period_status_events` is
append-only with no write policies. Settings are append-only with `created_by`
and `created_at` as the audit trail. Adjustments carry a written reason and the
admin who entered them. `locked_at`/`locked_by` are never cleared.

## Dependencies

- **`users`** — identity, salary and joining date. Salary columns are
  column-granted (ACC-4).
- **`app_modules`** — two rows, `attendance` and `payroll`.
- **`notifications`** — shared table, category-gated.
- **Attendance → Payroll** is the one hard cross-domain dependency: payroll reads
  reviewed attendance. Payroll never writes attendance.

## Main files

| File | Role |
| --- | --- |
| `src/lib/attendance/classification.ts` | Day classification — the band authority |
| `src/lib/attendance/corrections.ts` | Correction and waiver rules |
| `src/lib/payroll/engine.ts` | The calculation |
| `src/lib/payroll/settlement.ts` | Payable, paid, carry-forward |
| `src/lib/payroll/rules.ts` | Constants + the rule catalogue |
| `src/lib/payroll/settings.ts` / `settingsStore.ts` | Settings, validation, per-period pinning |
| `src/lib/moduleAccess.ts` | `resolveManagementAccess` |
| `src/components/layout/AttendancePayrollLayout.tsx` | The one shell |
| `src/components/layout/attendancePayrollNav.tsx` | The one navigation definition |

## Tests

| File | Covers |
| --- | --- |
| `src/lib/payroll/*.test.ts` (26 files) | Engine, rounding, leave, settlement, settings, snapshots |
| `src/lib/attendance/*.test.ts` (7 files) | Classification, corrections, punch parsing, provenance |
| `src/lib/security/attendancePayroll*.test.ts` | Row, API and self-service isolation |
| `src/components/layout/attendancePayrollNav.test.tsx` | One card, one shell, one nav, active state |
| `src/app/payroll/how-it-works/guide.test.tsx` | Guide content against the engine |
| `src/app/payroll/payrollGuideAccess.test.ts` | Guide reachability and data-free-ness |

## Known limitations

- **R-12** `payroll_holidays` is empty in production — holidays are charged as
  absences unless corrected by hand. Highest-severity open item for this module.
- **R-5 / M-3** `threshold_half_day_hours` is editable but unused; marked
  inactive in the UI 2026-08-11.
- **R-1** Self-service routes have no module guard (own data only).
- `PAYROLL_RULES_V1.md` is superseded by `src/lib/payroll/rules.ts` (M-1).
- The adjustments API has **no lock check**.
- `engine.validate.ts` scenario S18 fails on `main` already — pre-existing.

## Planned next work

1. Populate `payroll_holidays` and add an empty-state warning (R-12).
2. Decide `threshold_half_day_hours` — restore the band or retire the field (R-5).
3. Decide self-service route gating (R-1).
4. Add a lock check to the adjustments API.

## Owner

`unassigned` — no ownership registry exists in this repository.

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
