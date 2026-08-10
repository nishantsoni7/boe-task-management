# Attendance & Payroll — how a punch becomes money

**Status:** Current reference. Supersedes `PAYROLL_RULES_V1.md`, which is the
original business brief and has drifted from the engine.
**Last updated:** 2026-08-10

> The code remains authoritative. `src/lib/payroll/rules.ts` and
> `src/lib/payroll/settings.ts` hold the numbers the engine calculates with, and
> the "How Attendance & Payroll Is Calculated" section on Payroll Result Detail
> is generated from them, so what an employee reads and what the engine charges
> cannot drift. This document explains the rules and the reasoning; where it
> disagrees with the code, the code is right and this file is stale.

---

## 1. Reading a day's punches

### 1.1 The two export formats

The fingerprint machine exports in two shapes, and they differ in one way that
matters for money:

| | How a day is written | What the file states |
|---|---|---|
| **Format A** | Arrivals and departures on separate rows | The direction. The parser reads it. |
| **Format B** | Every punch of a day in one cell, newline separated | Only the times. With two or more punches the first and last are the pair; with exactly one, nothing says which door it was. |

Both formats are parsed by one module, `src/lib/attendance/punchParser.ts`. The
attendance **import** and **preview** routes both call it, so the two cannot
disagree about what a file says.

### 1.2 Single punches, and why the direction is recorded

A day with exactly one punch is a **missing punch**, not an absence. To charge it
the engine has to know whether the punch present is the arrival or the departure
— "Missing Punch In" and "Missing Punch Out" are different statements, and only
one of them can carry a late-arrival deduction.

Each day therefore carries a **direction provenance**, stored on
`attendance_records.punch_direction_source`:

| Value | Meaning |
|---|---|
| `confirmed` | The source stated the direction — Format A's separate IN/OUT rows, or an admin correction — or both punches are present so nothing had to be decided. |
| `inferred` | A single unmarked Format B punch, classified by the time-of-day divider. Treat any time-based conclusion drawn from it as provisional. |
| `NULL` | A record imported before this column existed. The application resolves it as `inferred`. |

**`NULL` resolves to `inferred`, never to `confirmed`.** Every row written before
this column came from a parser that filed a lone punch as an arrival whatever the
clock said, so its direction is exactly as trustworthy as a guess. The cost is a
narrow under-charge on genuine Format A late arrivals in historical data, which
is the correct direction to be wrong in.

### 1.3 The single-punch divider

A lone Format B punch is read as an **arrival** before the divider and a
**departure** at or after it. The default is **14:00 IST**, and exactly 14:00 is a
departure — the boundary belongs to the afternoon.

The divider is a **business decision, not a derived one**. It is deliberately not
the midpoint between the scheduled in and out times and must not quietly become
one. It is now the `single_punch_divider_minutes` payroll setting.

### 1.4 The defect this fixed

Before this work:

* Format A dropped OUT-only days entirely, so payroll charged a **full-day
  absence** for a day the employee was present.
* Format B filed every lone punch as `check_in_at`. A departure punched at 18:36
  became an **arrival at 18:36**: a 2-hour missing-punch charge plus roughly nine
  hours of "lateness" — about ₹896 on a ₹26,000 salary, more than the day was
  worth. One forgotten punch cost more than a day's pay.

---

## 2. What a day costs

### 2.1 Missing punch

One punch present and the other missing costs a flat **2 hours** by default
(`missing_punch_hours`). The day still counts as **present**. Both punches
missing is an absence, not a missing punch.

### 2.2 The deduction stacking rule

> A late-arrival deduction stacks on a missing punch-out **only when the
> direction is `confirmed`.**

Charging lateness on a direction the parser guessed from the clock means charging
an employee on the strength of a guess. A lone *morning* punch is still only a
guess at being an arrival, so it carries no lateness either.

A missing punch-**in** never reaches the late-arrival branch at all: there is no
arrival time to measure, whatever its provenance.

An admin correction is **always `confirmed`** — the correction form has separate
punch fields, so a blank one is a statement rather than a gap. That is the escape
hatch which makes the cautious default safe: where a genuine late arrival was
under-charged, an admin can restore the full treatment for that day.

### 2.3 Known limitation

A **confirmed** Format A 19:00 arrival with a missing punch-out still costs about
11 hours, which exceeds a full day. That figure is stated by the file rather than
guessed, so it is not the defect above — but a per-day cap remains a reasonable
future setting.

---

## 3. Central Payroll Settings

Every shared parameter the engine turns on is an admin-editable setting rather
than a compiled constant: the salary divisor and paid hours, the office clock and
grace period, lunch, the presence thresholds, the deduction rounding block, the
single-punch divider, missing-punch hours, the half-day fraction and the
paid-leave bands.

* **Where:** Payroll → Payroll Settings (`/payroll/settings`).
* **Storage:** `public.payroll_settings`, **append-only**. The newest row is
  active and every earlier row is the audit trail of what changed and who changed
  it, so there is no version-management UI to maintain and no separate audit
  table to keep in step. A trigger refuses `UPDATE` and `DELETE`.
* **Validation:** ranges, step grids, time formats and cross-field rules in the
  API (`parsePayrollSettings`), plus a database `CHECK` covering the values that
  would break the calculation outright.

### 3.1 The snapshot, and when it is taken

Each payroll period keeps the exact settings it was calculated with, in
`payroll_periods.settings_snapshot`.

**Generation pins the settings before the first employee is calculated.** Writing
the snapshot afterwards would leave a window in which a concurrent settings save
changed the rules midway through a run, and the period would then claim a
snapshot that applied to only some of its employees.

The choice is made in one place, `settingsForPeriod` in
`src/lib/payroll/settingsStore.ts`:

| Period | Settings used |
|---|---|
| Has a snapshot | Its snapshot, always — generated or locked |
| Draft, no snapshot | The active settings |
| **Generated, no snapshot** | The documented **legacy constants** — never today's settings |

That last row is the one worth stating aloud. Falling back to the active settings
for a legacy period looks reasonable and would silently rewrite the explanation of
every payslip generated before this feature existed.

### 3.2 Regeneration versus recalculation

* An **ordinary regeneration** — every one triggered by an attendance correction
  — **keeps** the existing snapshot. The month is recomputed from corrected
  attendance under the rules it was always run with; a correction must not
  smuggle in a settings change.
* An **intentional recalculation** replaces the snapshot with the then-active
  settings immediately before recalculating. The explicit request is
  `recalculate_with_current_settings: true` on `POST /api/payroll/generate`.

Nothing automatically unlocks, recalculates, backfills or modifies existing
payroll.

### 3.3 Monthly Review

Monthly Review previews an **ungenerated** month under the current settings, and
a **generated** month under that period's snapshot. It reports which in
`settings_source`. Previewing a generated month under today's rules would show
one set of figures on screen and another on the stored payslips.

---

## 4. Whole-rupee money

BOE pays in whole rupees, and payroll now calculates in them.

1. Rates, hours, minutes, day fractions and leave allowances stay **precise**.
2. Each final monetary **line** is rounded to the nearest rupee as it is built.
3. Every total is the **sum of those rounded lines**.
4. Gross, total deductions, adjustments and net payable are derived from the
   rounded figures and stored that way.
5. Details, reports and exports read the same stored figures.

**The order is the rule.** `round(a) + round(b)` is not `round(a + b)`. Three
1-hour late lines at ₹117.647 are ₹118 each and ₹354 together; rounding the sum
instead gives ₹353. Only the first produces a payslip whose printed lines add up
to its printed total.

Rounding is **half-up away from zero**: ₹10.50 → ₹11, and a recovery of ₹10.50 →
₹11 as well. JavaScript's `Math.round(-10.5)` is `-10`, which would make a
deduction and a recovery of the same size round to different magnitudes.

One helper, `src/lib/payroll/money.ts` (`roundRupees`, `sumRupees`,
`formatRupees`). `sumRupees` refuses input that is not already whole, so paise
cannot re-enter one layer up.

**History is not restated.** A month generated before this rule keeps its stored
figures, paise and all — its stored deduction lines are fractional too, so
rounding the total would stop it matching the column above it. The new rule
applies to new generation and to an intentional recalculation after unlocking.

---

## 5. Adjustment categories

`adjustment_type` says which way an adjustment points; `adjustment_category` says
what it is.

**Additions:** previous salary pending · incentive · bonus · reimbursement ·
other addition
**Deductions:** advance recovery · other deduction

* The database `CHECK` pairs category with direction, so an incentive cannot be
  stored as a deduction. The API refuses the same pairing first.
* **Legacy rows keep a `NULL` category.** No backfill guesses one: reading
  "Bonus for Diwali" and stamping it `bonus` would be inventing a fact the admin
  never stated. `NULL` is reported under the matching **Other** line — a
  presentation of an unknown, not a rewrite. An admin can categorise a row by
  editing it.
* The engine **never reads the category**. It is a reporting label, so adding one
  to an old row cannot change that month's pay.

---

## 6. Salary-processing report

Payroll Results → **Salary Processing Report**
(`/payroll/results/[periodId]/salary-report`).

Select all or individual employees, see the selected count, Preview, Copy, or
open WhatsApp with prepared text. Totals cover the **selected employees only**.
All amounts are whole rupees in Indian digit grouping.

Every figure comes from **stored** `payroll_results` and adjustments. The page
never calculates a salary; it groups and formats what generation already wrote.

**Not on the report, deliberately:** punches, objections, comments, correction
remarks, internal notes, settings, and the adjustment's free-text `description`
— admins write private context there, and this text is written to be pasted into
WhatsApp. The category is what the report states.

### 6.1 WhatsApp length

Message length is measured on the **percent-encoded** string (a ₹ or a newline
costs three characters once encoded) against `WHATSAPP_URL_TEXT_LIMIT`, a
conservative **1,800**. Over the limit the report is **refused**: no URL is
produced and nothing is truncated. Preview and Copy keep working on the full
text, and there is no automatic splitting into several messages.

Silent truncation is the specific failure this guards against — a report that
loses its last three employees still looks complete to whoever receives it.

The `wa.me` link names no recipient, so the system never chooses who receives a
payroll report.

---

## 7. Permissions

| Surface | Who |
|---|---|
| `/payroll/*` including Settings and the processing report | **Admin only** (`PayrollGuard` → `resolveManagementAccess`). No Control Center visibility mode widens it. |
| `/payroll/how-it-works` | Any signed-in member. It holds no employee data — every figure comes from the rule constants. |
| `/my-payroll` | The employee's own payslip only. |
| `public.payroll_settings` | Admin read and insert. **No employee policy exists at all**, and there is no `UPDATE` or `DELETE` policy for anybody. |
| `GET /api/payroll/salary-report` | Admin only, and it takes **no `employee_id` input** — the only parameter is `period_id`, so there is nothing for a non-admin to aim at. |

Attendance and payroll API routes run on the service role, which bypasses RLS, so
the route itself is the boundary. The caller's identity always comes from the
bearer token, never from a body or query parameter.

---

## 8. Safe deployment order

> **Migrations must reach an environment before the application code that reads
> them.**

PostgREST answers an unknown column or table with an error (`42703` / `42P01`),
not a null — so app-first does not degrade, it breaks payroll generation,
Monthly Review, attendance import and attendance preview outright.

Because merging to `main` deploys, apply these to production **before** the merge:

| Migration | Adds |
|---|---|
| `20260827000000_attendance_punch_direction_source.sql` | `attendance_records.punch_direction_source` |
| `20260828000000_payroll_settings.sql` | `payroll_settings`, `payroll_periods.settings_snapshot` |
| `20260829000000_payroll_adjustment_categories.sql` | `payroll_pending_adjustments.adjustment_category` |

All three are purely additive: nullable columns with no defaults (so no table
rewrite), guarded statements (so re-running is safe), **no backfill**, and no
change to any existing RLS policy or grant. Each carries its own rollback in its
header comment.

Old application code with these migrations applied is safe — nothing selects the
new columns, and `NULL` satisfies every constraint.
