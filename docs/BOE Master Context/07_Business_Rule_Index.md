# Business Rule Index

Last verified: **2026-08-11** (commit `a33c14e`).

Rules where a disagreement could affect **salary, access, accountability, audit
history or ownership**. Not every branch in the codebase — only the ones worth
arguing about.

Narrative rules live in [05_Business_Rules.md](05_Business_Rules.md); this file
is the traceable index: rule → authority → implementation → test.

**ID format:** `<AREA>-<n>` — PAY (payroll), ATT (attendance), ISS (issues),
ACC (access/authorization), TSK (tasks), AST (assets), ORD (orders).

---

## Payroll

| ID | Rule | Authority | Implementation | Test | Verified |
| --- | --- | --- | --- | --- | --- |
| PAY-1 | A day's pay is monthly salary ÷ **26** (working days in a six-day week month), not ÷ 30 | Code is authority; `PAYROLL_RULES_V1.md` says 30 and is **superseded** | `src/lib/payroll/rules.ts` `PER_DAY_DIVISOR` | `rulesSource.test.ts` | 2026-08-11 |
| PAY-2 | An hour's pay is a day's pay ÷ **8.5** paid hours | Code | `rules.ts` `PER_HOUR_DIVISOR` | `rulesSource.test.ts` | 2026-08-11 |
| PAY-3 | Every monetary **line** is rounded to a whole rupee; every total is the **sum of rounded lines**, never a rounded sum | Approved 2026-08-10 | `src/lib/payroll/money.ts`, `engine.ts` `computeTotalDeductions` | `money.test.ts`, `engine.rounding.test.ts` | 2026-08-11 |
| PAY-4 | Rounding is half-up **away from zero** (a ₹10.50 recovery is ₹11) | Approved | `money.ts` `roundRupees` | `money.test.ts` | 2026-08-11 |
| PAY-5 | Lateness is measured from office start, the first **15 minutes are free**, then rounds **up** to the next 30 minutes at 0.5 h per block | Code | `engine.ts` `roundDeductionHours` | `engine.*.test.ts` | 2026-08-11 |
| PAY-6 | A missing punch-in or punch-out costs a flat **2 hours**; the day still counts as **present** | Code | `rules.ts` `MISSING_PUNCH_HOURS`, `engine.ts` | `engine.missingPunch.test.ts` | 2026-08-11 |
| PAY-7 | Paid leave is earned by attendance in the **same month**: 16+ days present → 1 day, 11–15 → ½, below → none. It does not carry forward | Approved | `rules.ts` `PAID_LEAVE_TIERS` | `paidLeaveBands.test.ts` | 2026-08-11 |
| PAY-8 | The allowance settles the **earliest** eligible item of the month, not the largest; the covered line stays visible at ₹0 | Approved (direction corrected 2026-08) | `engine.ts` `buildFinalDeductionLines` | `engine.companyPaidLeave.test.ts` | 2026-08-11 |
| PAY-9 | Leave absorption is **exclusive**: one absent day, **or** 2 half days, **or** one half day at ½ allowance, **or** up to 8.5 h of hourly charges — never two of these | Code | `engine.ts` `applyLeaveAbsorption` | `engine.companyPaidLeave.test.ts` | 2026-08-11 |
| PAY-10 | `salary_after_attendance` = gross − deductions, **floored at ₹0** when `days_present` is 0 | Approved | `src/lib/payroll/settlement.ts` | `settlement.test.ts` | 2026-08-11 |
| PAY-11 | `salary_payable` = after-attendance + carry-forward + other adjustments, and **may be negative** (a recovery can exceed the month's pay) | Approved | `settlement.ts` | `settlement.test.ts` | 2026-08-11 |
| PAY-12 | An **unrecorded payment is not ₹0**: no closing balance exists and nothing carries forward | Approved | `settlement.ts` `computeSettlement`, `proposedCarryForwardFrom` | `settlement.test.ts` | 2026-08-11 |
| PAY-13 | Settlement builds from stored **primitives**, never from `net_salary`, which already includes adjustments — otherwise every adjustment double-counts | Code (defect fix) | `settlement.ts` header | `settlement.test.ts` | 2026-08-11 |
| PAY-14 | `pending_adjustment_total` is a **generation-time snapshot**, never a live total | Code | `engine.ts` `sumPendingAdjustments` | `adjustments.test.ts` | 2026-08-11 |
| PAY-15 | Payroll is **recalculated from attendance every time**, never accumulated; regenerating cannot double-charge | Approved | `engine.ts` | `staleRecalculation.test.ts` | 2026-08-11 |
| PAY-16 | A generated period uses the settings **pinned to it**; a legacy period without a snapshot resolves to LEGACY constants, never today's settings | Approved | `settingsStore.ts` `settingsForPeriod` | `settingsSnapshot.test.ts` | 2026-08-11 |
| PAY-17 | Locking freezes a month; only an admin may unlock, and `locked_at`/`locked_by` are never cleared | Approved | `lockGuard.ts`, `unlockRules.ts` | `unlockRules.test.ts` | 2026-08-11 |
| PAY-18 | Payroll deletion is admin-only and goes through `delete_payroll_period` | Approved | migration `20260830000000` | `api/payroll/delete/route.test.ts` | 2026-08-11 |
| PAY-19 | Overtime, tax/PF and bonuses are **not calculated**; anything owed arrives as an adjustment with a reason | Approved | `rules.ts` `NOT_CALCULATED` | `rulesSource.test.ts` | 2026-08-11 |

## Attendance

| ID | Rule | Authority | Implementation | Test | Verified |
| --- | --- | --- | --- | --- | --- |
| ATT-1 | A working day is every calendar day except the weekly off (Sunday), company holidays, and dates before joining | Approved | `engine.ts` `buildWorkingDayCalendar` | `monthCalendar.test.ts` | 2026-08-11 |
| ATT-2 | Full present = in within grace **and** out at/after close, **or** ≥ 7.5 effective hours | Code | `classification.ts` | `partialLunchOverlap.test.ts` | 2026-08-11 |
| ATT-3 | **Half day = 2–5 effective hours** — one band down to the presence floor | Code (band merged; see mismatch M-1) | `classification.ts` | `guide.test.tsx` asserts against the classifier | 2026-08-11 |
| ATT-4 | Below 2 effective hours, or no punches, is an **absence** | Code | `classification.ts` | `guide.test.tsx` | 2026-08-11 |
| ATT-5 | Lunch is the **actual overlap** with the lunch window, not a flat hour on any day that touches it | Code (defect fix) | `workedDuration.ts` | `partialLunchOverlap.test.ts` | 2026-08-11 |
| ATT-6 | A payable day is **1 / ½ / 0** by classification | Code | `resultTabs.ts` `payableDayValue` | `resultTabs.test.ts` | 2026-08-11 |
| ATT-7 | The **machine record is never overwritten**. A correction is a new version; every version is kept and payroll uses the current one | Approved | `corrections.ts`, migration `20260807000000` | `corrections.test.ts` | 2026-08-11 |
| ATT-8 | Deduction waivers only carry meaning under `day_treatment = 'auto'` | Code | `corrections.ts` `waivedDeductionTypes` | `corrections.test.ts` | 2026-08-11 |
| ATT-9 | A lone unmarked punch's direction is **inferred**, never `confirmed`; legacy NULL provenance reads as inferred | Approved | `punchDirection.ts` | `punchProvenance.test.ts` | 2026-08-11 |
| ATT-10 | A late-arrival charge is added to a missing-punch day **only** when the file states the punch was the arrival, or an admin confirmed it | Approved | `engine.ts` | `engine.missingPunch.test.ts` | 2026-08-11 |
| ATT-11 | Current-month coverage is classified only up to the company-wide max attendance date, capped at today IST | Approved | `monthAvailability.ts` | `monthAvailability.test.ts` | 2026-08-11 |

## Issues, access and other modules

| ID | Rule | Authority | Implementation | Test | Verified |
| --- | --- | --- | --- | --- | --- |
| ISS-1 | Exactly **one open issue** per subject; a new one is blocked only while the previous is still pending | Approved, migration `20260823000000` | `objections.ts` `canRaiseIssue` | `objectionWorkflow.test.ts` | 2026-08-11 |
| ISS-2 | A re-raise creates a **new row** and never touches the old one; the chain stays visible | Approved | `objections.ts` `buildIssueHistory` | `objections.test.ts` | 2026-08-11 |
| ISS-3 | Raising an issue **changes no salary figure by itself** | Approved | `objections.ts`; no engine call | `objectionWorkflow.test.ts` | 2026-08-11 |
| ISS-4 | `attendance_payroll` notifications are admin-only **by category**, and rows stay pinned to `user_id = caller` | Approved | `notificationAccess.ts` | `attendancePayrollNotifications.test.ts` | 2026-08-11 |
| ACC-1 | Attendance and Payroll **management** is admin-only; no visibility mode can widen it | **Product owner, explicitly** | `moduleAccess.ts` `resolveManagementAccess` | `moduleAccess.test.ts` | 2026-08-11 |
| ACC-2 | `custom` visibility names the employees who get their **own** record — it is not a grant of management access | **Product owner, explicitly** (an earlier build got this wrong) | `moduleAccess.ts` | `moduleAccess.test.ts` | 2026-08-11 |
| ACC-3 | `hidden` closes a module for everyone, admins included | Code | `moduleAccess.ts` | `moduleAccess.test.ts` | 2026-08-11 |
| ACC-4 | Salary and payroll-note columns on `users` are **column-granted**; `select('*')` is an error | Approved, migration `20260813000000` | `users/safeColumns.ts` | `noStarSelect.test.ts` | 2026-08-11 |
| AST-1 | Asset module `view` grants module entry and own records only; inventory needs explicit grants | Approved | `permissions/assetsAccess.ts` | `assetsAccess.test.ts` | 2026-08-11 |
| AST-2 | Approving a **removal** is admin-only; a grantable `delete` does not authorize permanent purge | Approved | `assetsAccess.ts`, migration `20260803000000` | `assetsAccess.test.ts` | 2026-08-11 |
| ORD-1 | Order request edit is `admin OR assigned_to` — **not** `created_by` | Approved | order RPCs | `orders` tests | 2026-08-11 |
| ORD-2 | Finalized finance/order records cannot be deleted | Approved, migrations `20260705`/`20260706` | policies + triggers | — | 2026-08-11 |
| TSK-1 | Task list filters, tab and page live in the **URL**, so a view is shareable | Approved | `listState.ts` | `listState.test.ts` | 2026-08-11 |

---

## Mismatch register

Conflicts between written intent and implemented behaviour. **Do not resolve one
of these by changing a calculation.** Each needs an owner decision.

| ID | Conflict | Evidence | Status |
| --- | --- | --- | --- |
| **M-1** | `PAYROLL_RULES_V1.md` §"Salary Formula" says monthly salary ÷ **30**; the engine has always divided by **26**, and every generated payroll in the database was produced that way | `rules.ts` `PER_DAY_DIVISOR` comment; all stored results | **Resolved in favour of code.** `PAYROLL_RULES_V1.md` is superseded by `src/lib/payroll/rules.ts`. Recorded, not re-litigated. |
| **M-2** | The payroll guide described Half Day as "3.75–5 hours" and listed a "Short Present" band, months after `classification.ts` merged them | Corrected in `a33c14e`; `guide.test.tsx` now asserts against the classifier | **Resolved — copy corrected, engine untouched.** See [ADR-0005](../adr/0005-guide-content-derives-from-engine-constants.md) |
| **M-3** | `threshold_half_day_hours` is stored, validated and **editable in the admin UI**, but read by no calculation since M-2's band merge | Zero `settings.threshold_half_day_hours` reads in `src/`; UI spec at `settings.ts:330` | **Open — treated non-behaviourally.** Marked inactive in the UI 2026-08-11. Whether to restore the band or retire the field is an owner decision. Tracked as R-5. |
| **M-4** | `05_Business_Rules.md` and `PAYROLL_ATTENDANCE_RULES.md` predate the settings-snapshot model and describe thresholds as fixed constants | Those files vs `settingsStore.ts` | **Open** — narrative rule docs need a pass; no behavioural conflict. |
| **M-5** | **Task escalation thresholds.** `docs/Reference/MASTER_PRODUCT_VISION.md` states the approved rule as *no update for 24h = Caution Zone, 48h = Danger Zone, 72h = escalation to senior*. The dashboard implements an **admin-only** list at **>5 days** (`blocked`, `waiting`) and **>7 days** (`working`, `pending`, `started`), with **no named zones and no escalation to a senior** | `src/app/dashboard/page.tsx:220-241` (`adminEscalations`). No escalation module in `src/lib`; **no test asserts these thresholds**. A legacy `escalation` notification type exists but is excluded from every feed (`attendancePayrollNotifications.test.ts:158`) | **Open — needs an owner decision.** The implemented thresholds are 2–3× looser than the written rule, and the escalation is a passive admin view rather than a notification to a senior. Do not resolve by editing the thresholds: the document that the reference set names as the "operational logic authority" for escalation (`BOE_Phase_1_Process_Consultant_Review.html`) is **absent from the repository**, so the vision record is the only surviving written statement of the rule and the owner must confirm which is intended |
