# Attendance Requests → Approval → Payroll Review — as built

**Status:** Branch `feat/attendance-requests`. Migrations prepared, **not applied**.
**Last updated:** 2026-09-27

Employees used to tell Nishant about late arrivals, early departures, half days,
leave and time away through WhatsApp, calls or email, and those decisions were
hard to find at salary time. This feature puts the request, the decision and
the month's attendance review in BOE.

This document records what the code does. Where it says "not built", it is not.

---

## 1. The flow

1. **Employee** opens **My Attendance** → **Attendance request**, picks a type,
   a reason and submits. The server records the time.
2. **Admin** (any active `admin`, not a named person) sees it under
   **Attendance & Payroll → Attendance Requests → Requests** and approves or
   rejects it. The employee is notified.
3. At payroll time the admin opens **Payroll review** for the month. Every
   salary-relevant attendance event is listed per employee, matched with any
   request, alongside what the stored payroll draft charges. The admin records a
   salary treatment for each event.
4. **Pay changes only through the existing attendance correction** on the
   payslip (waive late arrival / early checkout / missing punch, or a day
   treatment). The review records the decision and says when the draft does not
   yet match it.

## 2. Request types

| Type | Fields |
|---|---|
| Late arrival | date, expected arrival (optional), reason |
| Early departure | date, leaving time, reason |
| Time out during shift | date, leaving and return times, personal or company work, reason |
| Half day | date, first or second half, reason |
| Full-day leave | from date, optional to date (blank = one day), reason |

Reasons are a fixed, one-tap list: **Company vehicle delay**, Company work,
Personal reason, Medical, Family emergency, Traffic / transport, **Other** (a
note is required for Other only). Attachments are not asked for.

**Statuses:** Pending → Approved or Rejected. Pending can be Cancelled. The
employee sees each request's decision, reviewer, and time (IST).

### Rules (`src/lib/attendance/requests.ts`)

- **Informed on time** = submitted strictly before the scheduled shift start
  (the payroll settings' office start, 10:00 IST by default) of the request's
  first date. The stored `submitted_at` is set by the database, never the
  browser.
- **Correction** submits a new row pointing at the original. The original
  becomes *Cancelled — Replaced by a correction* in the same statement. If the
  date is unchanged, the correction keeps the first submission's time for
  "informed" (fixing a typo does not make an on-time notice late). Moving to a
  different date is judged afresh.
- **Cancel / correct** a pending request at any time. An approved request can
  only be cancelled or corrected before its shift starts. After that, ask an
  admin.
- **Duplicates and overlaps** among live (pending/approved) requests are refused:
  - leave overlaps anything;
  - one half day per date;
  - one late arrival and one early departure per date (both together are fine);
  - time-outs on one date only when their times overlap.

  A correction never blocks itself.
- **Validation:** times must fall inside the working day. A time out must
  return after it leaves. Leave can be at most 31 days and may cross a month.
  Requests can be filed up to 62 days after the date and 180 days ahead.
- **Admin decision:** approve (note optional), reject (reason required), or
  change an existing decision (reason required). A cancelled request cannot be
  decided. The update only succeeds if the status is still what the admin saw,
  so two reviewers cannot both win.

**Approval records permission only.** It does not decide whether missed time is
paid, and it does not replace the actual punch.

## 3. Payroll review (`src/lib/attendance/requestReconciliation.ts`)

For the chosen month and each employee, the review lists:

| Event | Source |
|---|---|
| Late arrival, minutes late | Effective punch (machine, or current correction) after the grace period. Minutes are measured from the scheduled start, as the engine does. |
| Informed / uninformed | A live late-arrival, first-half or leave request submitted before shift start. A **rejected** request still counts as informed (see §6). |
| Excused | The reviewer's excuse with a reason (for example, an emergency reported late or a company vehicle delay). |
| Early departure, minutes early | Effective punch-out before the scheduled end |
| Time out | The request. **Actual time away is not recorded**, because attendance stores only the first and last punch. |
| Half day / leave | The request, flagged where punches contradict it |
| Missing punch | One punch present. Flagged when a time-out request exists that day. |
| Absent, no request | A working day with no punches and no request, up to the imported coverage |
| Company exception | Reason *Company vehicle* or *Company work*, or a time out marked company work. Never inferred from note text. |
| BOE Credits | Existing attendance redemptions, shown and never applied |

**Monthly review flag.** The 4th and later **uninformed, unexcused** late
arrival in the month is flagged, with its dates. **It deducts nothing.**

**Mismatches flagged for review, never auto-corrected:**
- arriving later than an approved expected time;
- leaving earlier than an approved departure;
- leave approved but punches exist;
- an approved request with no attendance;
- a request still pending or rejected.

The requested time is never used as the actual time.

**Salary treatment per event:** *Paid / waived*, *Use paid leave*, *Unpaid
actual time*, or *Needs correction*. Each needs a reason. The reviewer and time
are recorded, and history is kept (`attendance_day_reviews`, one current row per
event, older rows superseded, not edited).

**No duplicate deductions.** The review computes no money. It shows the
**stored draft's** deduction lines for that date and event, attributing each
line to one event. When a decision and the draft disagree, it says so; for
example, *"Decision is Paid / waived, but the draft still deducts ₹118. Apply a
waiver through the attendance correction to change pay."*

**Re-review after changes.** Each decision stores a fingerprint of the
attendance and request state it was made against. The server computes it, the
browser never sends it. If punches, corrections or the request change later,
the event shows *"Attendance changed since this decision — review again"* and
counts as unresolved.

**Locked months.** Decisions are refused for a locked payroll month. Changes
after lock follow the existing unlock / adjustment path. Lock rules themselves
are unchanged: unresolved events **do not** block locking.

**Performance.** The month loads with a fixed number of bulk reads (settings,
period, holidays, credits, employees, requests, reviews, paged attendance,
corrections, draft results and paged lines), not one read per employee or per
row. The admin queue reads the punches for all listed requests in one query.

## 4. Data and access

Migration `20270130000000_attendance_requests.sql`:

| Table | Purpose |
|---|---|
| `attendance_requests` | The request and its decision. Content is immutable after insert (trigger); state transitions are enforced by trigger. |
| `attendance_request_events` | Append-only audit (submitted, corrected, replaced, cancelled, approved, rejected, decision_revised) with actor and a row snapshot. Written **by trigger in the same statement** as each change, so it cannot be skipped. |
| `attendance_day_reviews` | Excuse and salary treatment per (employee, date, event), versioned. |

- **RLS:** an employee reads their own requests and events. An active admin
  reads all. `attendance_day_reviews` is admin-only.
- **Grants:** `authenticated` has SELECT only. There is no client INSERT, UPDATE
  or DELETE. All writes go through the service-role routes below, which take the
  caller from the bearer token (`resolveCaller` / `requireAdmin`), so no route
  accepts an employee id to act for.
- **Not touched:** `attendance_records`, `attendance_day_corrections`, and every
  payroll table and formula. The payroll engine does not read the new tables.

Migration `20270130000100_attendance_request_notification_types.sql` adds
`attendance_request_submitted` (to every active admin) and
`attendance_request_decided` (to the employee). **Apply it before deploying the
code:** the Attendance & Payroll feed filters `type.in.(…)`, and an unknown enum
value breaks the whole feed (same contract as `20260825000000`). A notification
failure is logged and never fails the submission or decision.

### Routes

| Route | Who |
|---|---|
| `GET /api/attendance-requests` | Own requests (anyone) |
| `GET /api/attendance-requests?scope=queue&status=` | Admin |
| `POST /api/attendance-requests` | Submit or correct own |
| `POST /api/attendance-requests/[id]/cancel` | Own |
| `POST /api/attendance-requests/[id]/decision` | Admin |
| `GET /api/attendance-requests/[id]/history` | Own chain, or admin |
| `GET/POST /api/attendance-requests/reconciliation` | Admin |

### Screens

- `/my-attendance`: the **Attendance request** button and **My requests**
  (Correct / Cancel / History).
- `/attendance/requests`: **Requests** (queue) and **Payroll review** tabs. Admin
  navigation item **Attendance Requests**.

## 5. Deployment order

1. Apply `20270130000000` and `20270130000100` (additive, re-runnable; rollback
   in the header).
2. Deploy the application.

## 6. Open policy questions (not decided in code)

1. **A rejected request that was submitted on time counts as "informed"** for
   the monthly flag. The rejection says the explanation was not accepted, not
   that the employee failed to tell BOE. Confirm.
2. **Use paid leave** is recorded but not enforced per event. The engine applies
   earned paid leave automatically to the earliest eligible item of the month
   (`PAYROLL_ATTENDANCE_RULES.md`), and there are no leave types or balances to
   draw on.
3. **The monthly half-day penalty** after the flag is not implemented. It is a
   review flag only, pending BOE's payroll/legal adviser (Code on Wages
   conditions on deductions).
4. **Time out** has no measured duration. Deciding whether personal time out is
   unpaid needs either a mid-day punch source (Minop break punches) or a manual
   entry.
5. **Scheduled shift** is company-wide. There are no per-employee or overnight
   shifts in BOE today.

## 7. Not built

- Applying a review decision to pay automatically. The reviewer uses the
  existing attendance correction on the payslip.
- Blocking payroll lock while events are unresolved.
- Measuring actual time away for a time out.
- Leave types, balances or entitlements (none exist in BOE).
- Admin editing a request's content (an admin decides; the employee corrects).
- A notification to the employee when a review decision is saved.

## 8. Tests

- `src/lib/attendance/requests.test.ts`: validation, informed-on-time in IST
  (09:59:59 vs 10:00, submission the previous evening, corrections), overlaps and
  duplicates, cancel window, decision rules.
- `src/lib/attendance/requestReconciliation.test.ts`: the monthly flag (only the
  4th, and it deducts nothing), informed and excused exclusions, late submission,
  approved-vs-actual, company vehicle, time out with a missing return punch,
  leave with punches, leave crossing months, coverage, upcoming events, no
  duplicate attribution of draft lines, decisions that disagree with the draft,
  and stale decisions.
- `src/components/attendanceRequests/attendanceRequests.render.test.tsx`: the
  form renders for a phone user (late arrival first, no attachment field), and a
  correction pre-fills from the original.
- `src/lib/attendancePayrollNotifications.test.ts`: extended to the two new
  notification types.
- The migration was applied twice to a disposable Postgres 17 with a stub
  `users`/`auth.uid()`. Triggers, constraints and RLS were exercised there. It
  has **not** been applied to any Supabase project.
