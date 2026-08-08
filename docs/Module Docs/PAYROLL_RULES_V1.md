# Monthly Payroll Calculation — Rules V1

**Version:** 1.1  
**Date:** 2026-06-07  
**Status:** Business brief — superseded by the code where the two differ

---

> ## ⚠ This document is no longer the source of truth
>
> It is the brief the engine was built from. The engine has since moved, and this
> document has not. **`src/lib/payroll/rules.ts` is now authoritative** — it holds
> the constants `src/lib/payroll/engine.ts` calculates with, and the
> "How Attendance & Payroll Is Calculated" section on Payroll Result Detail is
> generated from it, so what an employee reads and what the engine charges cannot
> drift apart.
>
> Known divergences, verified against the code and the generated payrolls in the
> database on 2026-08-08:
>
> | Rule | This document | The engine |
> |---|---|---|
> | Per-day salary | Monthly ÷ **30** | Monthly ÷ **26** (`PER_DAY_DIVISOR`) |
> | Present / half-day bands | "exactly 4 hours = half day" | Effective-hour bands: ≥7.5 full, ≥5 present-with-shortfall, ≥3.75 half day, ≥2 short present, below that absent |
> | Paid leave | "1 per month" | Earned by attendance: ≥16 days present → 1, 11–15 → 0.5, ≤10 → 0 |
> | Office-timing override | not described | In by 10:15 **and** out by 18:30 is a full day regardless of hours |
> | Short-hours deduction | "hourly deductions applied for any shortfall below 8.5 hours" | Not implemented as a standalone line; a short day is settled by its classification or by a late/early line |
>
> Every payroll figure in the database was produced by the engine, not by this
> table. Do not "fix" the code to match the document without a business decision
> to change the rule and a plan for the months already generated.

---

## Purpose

This document defines the rules and logic for calculating monthly employee payroll based on attendance records. It was the single source of truth for the Phase 1 payroll module. Read it for intent; read `src/lib/payroll/rules.ts` for what actually happens.

---

## Phase 1 Scope

- Monthly salary calculation per employee
- Deductions for absent days (beyond paid leave)
- Deductions for late arrivals (rounded up in 30-minute blocks)
- Deductions for missing punch-in or punch-out
- Deductions for early checkout
- Present / half-day / absent classification by hours worked
- Half-day handling and adjustment against paid leave
- Company holiday management (stored month-wise)
- Paid leave adjustment against late/short-hour deductions
- Old pending adjustments from previous months (manual, editable, splittable)

---

## What Is Not Included in Phase 1

- Overtime pay
- Advance salary adjustments
- Tax (TDS) calculations
- Bonuses or incentives
- Automatic approval workflows for exceptions
- Integration with accounting or banking systems
- Leave encashment
- In-app holiday calendar (future module)
- Formal recording of company-work exemptions (future module)

---

## Office Timings

| Setting | Time |
|---|---|
| Official start time | 10:00 AM |
| Grace period end | 10:15 AM |
| Late deduction starts | 10:16 AM |
| Lunch break | 1:00 PM – 2:00 PM |
| Official checkout time | 6:30 PM |
| Daily paid working hours | 8.5 hours |

---

## Salary Formula

| Component | Formula |
|---|---|
| Per day salary | Monthly salary ÷ 30 |
| Per hour deduction | Per day salary ÷ 8.5 |
| Division base | Always 30 days, regardless of actual calendar days in the month |

> The 30-day divisor is fixed — it does not change for months with 28, 29, or 31 days.

---

## Present / Half-Day / Absent Logic

| Hours Worked | Treatment |
|---|---|
| Less than 2 hours | Absent |
| 2 to less than 4 hours | Present — paid for actual hours worked only |
| Exactly 4 hours | Half Day |
| More than 4 hours | Present — hourly deductions applied for any shortfall below 8.5 hours |

**Example:**  
Punch-in 10:00 AM, punch-out 12:00 PM = 2 hours worked → **Present**, paid for 2 hours only (not a full day or half-day salary).  
Punch-in 10:00 AM, punch-out 5:00 PM = 6.5 hours worked (excluding lunch) → **Present**, with 2 hours deducted for the 2-hour shortfall from 8.5 hours.

---

## Leave Rules

1. Every employee receives **1 paid leave per month**.
2. **Government holidays and festival leaves** are stored month-wise by the company. They do not count as employee leave and have no deduction.
3. **Sundays and weekly offs** are company holidays. They are never counted as employee absence.
4. Any **full-day absence beyond the 1 paid leave** is deducted at the per-day-salary rate.
5. **Two half-days** can be combined and adjusted as **1 paid leave**, but only if the employee has not already used their paid leave for the month.
6. Half-days not covered by paid leave are deducted at **0.5 × per-day salary**.
7. **Which leave is the paid one: the FIRST eligible leave of the payroll month, chronologically.**

### Which leave the company pays for

The monthly allowance is spent on the **earliest** item of the month it can
cover. That item is charged **₹0** and stays visible on the Deductions tab,
marked *Paid Leave · Company Paid*, so the month still adds up.

> Leave on **3 August**, **12 August** and **24 August** →
> **3 August is the company-paid leave**. The 12th and the 24th are ordinary
> leave and are deducted at the rates above.

"Earliest" means the **attendance date**, never the order the record was
imported or the time it was created or corrected. Payroll is recalculated from
attendance on every run, so re-importing a month, correcting a date inside it,
or regenerating the period all produce the same answer; and if an *earlier*
eligible day later appears (an admin restates the 1st as absent, say), the
allowance moves to it, because the rule is a property of the month rather than
a flag written on a row.

The order in which the allowance is *applied* is unchanged: one absent day,
then two half days, then one half day against a half-day allowance, then up to
8.5 h of late / early / missing-punch deductions.

Implemented in `assembleResult()` in `src/lib/payroll/engine.ts`; asserted in
`src/lib/payroll/engine.companyPaidLeave.test.ts`.

---

## Late Coming Rules

| Punch-In Time | Late Duration | Deduction |
|---|---|---|
| Up to 10:15 AM | — | No deduction (grace period) |
| 10:16 AM – 10:30 AM | up to 15 min late | 0.5 hour |
| 10:31 AM – 11:00 AM | 16–45 min late | 1.0 hour |
| 11:01 AM – 11:30 AM | 46–75 min late | 1.5 hours |
| 11:31 AM – 12:00 PM | 76–105 min late | 2.0 hours |
| (pattern continues) | +30 min per block | +0.5 hour |

**Rules:**
- Grace time ends at **10:15 AM**. Late deduction starts from **10:16 AM**.
- Late deduction is always **rounded up** to the next 30-minute block.
- Deduction amount = late blocks × per-hour deduction rate.

**Example:**  
Punch-in at 10:45 AM = 30 minutes late after grace → rounds up to the next block → **1 hour deduction**.

---

## Paid Leave Adjustment for Late / Short Hours

- If the employee has an **unused paid leave** for the month, and total late/short-hour deductions for the month do not exceed **8.5 hours**, those deductions may be absorbed by the unused paid leave instead of cutting salary.
- If the paid leave is already used, this adjustment is **not available**.
- This adjustment is applied at the end of monthly payroll processing, not per-day.

---

## Half-Day Timings

| Half | Timing |
|---|---|
| First half | 10:00 AM – 2:00 PM |
| Second half | 2:00 PM – 6:30 PM |

- **Lunch break** (1:00 PM – 2:00 PM) is not counted as working time.
- Second-half attendance is accepted **only by exception** (e.g., employee came in the afternoon with prior approval).

---

## Missing Punch Rules

| Situation | Deduction |
|---|---|
| Punch-in missing, punch-out present | 2 hours salary deduction |
| Punch-out missing, punch-in present | 2 hours salary deduction |
| Both punch-in and punch-out missing | Full day deduction (same as absent) |

- Missing punch deductions can be **overridden manually** by a payroll admin in genuine exception cases only.
- Manual override must be a deliberate action — it is not applied automatically.

---

## Early Checkout Rules

- Official checkout time is **6:30 PM**. Leaving before this is not allowed by default.
- **Deduction = actual shortfall from 6:30 PM**, rounded up to the next 30-minute block.
- Early checkout can be **exempted** if the employee was outside for approved company work (see [Exception Rules](#exception-rules)).

**Example:**  
Checkout at 5:50 PM = 40 minutes short → rounds up to 1 hour block → **1 hour deduction**.

---

## Exception Rules

Late arrival or early checkout can be fully exempted from deduction if:
1. The employee was outside the office for company-approved work.
2. Prior permission was obtained.

- Exemptions are currently **manually marked** in the payroll flow — they are not applied automatically.
- A dedicated in-app module to record and approve such exceptions is planned for a future phase.

---

## Holiday Rules

- **Sundays and weekly offs** are company holidays — no deduction, no leave consumed.
- **Festival and government holidays** are stored manually by the company on a month-by-month basis.
- Company holidays never count as employee absence or leave.
- Employees should be able to view the holiday list in the app — this is a **future feature**, not Phase 1.

---

## Old Pending Adjustment Rules

Any extra or short salary from previous months can be adjusted in the current month's payroll:

- If the company paid **₹2,000 less** in a previous month → add ₹2,000 to current month.
- If the company paid **₹2,000 extra** in a previous month → deduct ₹2,000 from current month.

**Rules:**
- Adjustment amount is **editable** by the payroll admin.
- Adjustment can be **split across multiple months** at the admin's discretion.
- Example: a ₹2,000 pending deduction can be applied as ₹1,000 this month and ₹1,000 next month.
- All pending adjustments must be visible in the payroll flow before finalising salary.

---

## Example Calculation

**Employee:** Monthly salary ₹30,000

| Component | Calculation | Value |
|---|---|---|
| Per day salary | 30,000 ÷ 30 | ₹1,000 |
| Per hour deduction | 1,000 ÷ 8.5 | ≈ ₹117.65 |
| Punch-in at 10:45 AM (1 hr deduction) | 1 × ₹117.65 | −₹117.65 |
| 1 full-day absent (paid leave used) | No deduction | ₹0 |
| Missing punch-out on one day | 2 hours × ₹117.65 | −₹235.29 |
| **Total deductions** | | **−₹352.94** |
| **Net salary** | 30,000 − 352.94 | **₹29,647.06** |

---

**Paid leave adjustment scenario:**

- Employee punched in late on 3 days — total late deduction = 2.5 hours = ₹294.12.
- Employee has not used their monthly paid leave.
- 2.5 hours is within the 8.5-hour threshold.
- Result: no salary deduction; paid leave is consumed for the month instead.

---

**Old pending adjustment scenario:**

- In May, employee was underpaid by ₹2,000 due to a manual error.
- In June payroll, admin adds a ₹2,000 positive adjustment for May shortfall.
- Admin chooses to split it: ₹1,000 applied in June, ₹1,000 carried to July.

---

## Open Questions Before Coding

1. **What counts as a full working day for early checkout?**  
   If an employee punches in at 10:00 AM and punches out at 5:00 PM (1.5 hours short), is it a full day minus 1.5 hours, or treated differently?

2. **How should company-approved outside work be recorded in the system?**  
   Currently it is a manual note. Should it be a checkbox in attendance, a separate approval form, or a field in the payroll exception screen?

3. **Does missing-punch deduction apply if the attendance record is manually approved by admin later?**  
   If an admin reviews and approves the record, is the 2-hour deduction automatically waived or must it still be manually overridden?

4. **For split pending adjustments, where is the ₹1,000 carried to July stored?**  
   Does it live as an open adjustment entry that auto-appears in next month's payroll, or must the admin re-enter it?
