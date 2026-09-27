# Attendance Requests → Approval → Payroll Review — as built

**Status:** Draft PR #239, branch `feat/attendance-requests`. Migrations
prepared, **not applied** to any Supabase project.
**Last updated:** 2026-09-27 (second pass: review decisions now reach the draft)

Employees used to tell Nishant about late arrivals, early departures, half days,
leave and time away through WhatsApp, calls or email, and those decisions were
hard to find at salary time. This feature puts the request, the decision and
the month's attendance review in BOE — and makes the review's salary decision
reach the payroll draft through the one path that already changes pay.

This document records what the code does. Where it says "not built", it is not.

---

## 1. The flow

1. **Employee** opens **My Attendance** → **Attendance request**, picks a type,
   a reason and submits. The server records the time.
2. **Another admin** (any active `admin` other than the requester) approves or
   rejects it under **Attendance & Payroll → Attendance Requests → Requests**.
   The employee is notified. **Approval records permission only.**
3. At payroll time an admin opens **Payroll review** for the month and records a
   salary treatment per event. For late arrivals, early departures and missing
   punches, saving **applies it to the draft** through the attendance
   correction. Other events are marked **Action required in payroll** with a
   link to the payslip.
4. An event reads **Matches payroll** only when the stored draft agrees with
   the decision. Saving a decision is not enough.
5. The lock confirmation lists unresolved items and draft conflicts, and the
   admin must accept them explicitly. The lock API itself is unchanged.

## 2. Requests (`src/lib/attendance/requests.ts`)

| Type | Fields |
|---|---|
| Late arrival | date, expected arrival (optional), reason |
| Early departure | date, leaving time, reason |
| Time out during shift | date, leaving and return times, personal or company work, reason |
| Half day | date, first or second half, reason |
| Full-day leave | from date, optional to date (blank = one day), reason |

- **Reasons** are one tap each: Company vehicle delay, Company work, Personal,
  Medical, Family emergency, Traffic / transport, Other. A note is required only
  for Other. There are no attachments.
- **Statuses:** Pending → Approved or Rejected. Pending can be Cancelled. A
  decision can be revised, with a reason.
- **Informed on time** means submitted strictly before 10:00 IST (the
  payroll-settings office start) on the request's first date. The database
  sets the submission time.
- **Correction** creates a new row linked to the original, and the original
  becomes *Replaced by a correction* in the same statement. If the date is
  unchanged, the first submission time still counts for "informed on time".
- **Cancel or correct:** a pending request any time; an approved one only
  before its shift starts.
- **Duplicates and overlaps** among live requests are refused:
  - leave overlaps anything;
  - one half day per date;
  - one late arrival and one early departure per date;
  - time-outs on one date only when their times overlap.
- **Self-decision:** an admin cannot decide their own request (§5, case 7).

## 3. Payroll review (`src/lib/attendance/requestReconciliation.ts`)

### What it shows

For each employee and month, every salary-relevant event:

- late arrivals with minutes late;
- informed / uninformed, and the excuse;
- early departures;
- time out, shown with the **requested** times only;
- half days and leave;
- missing punches;
- unexplained absences;
- company exceptions;
- BOE Credits.

It also shows what the **stored draft** charges for each event. Each draft line
is attributed to one event only.

**The monthly review flag** marks the 4th and later uninformed, unexcused late
arrival. It deducts nothing. Excusing an earlier late arrival clears it.

### Salary treatments, and what each one does

| Choice | Late arrival / early departure / missing punch | Absence, half day, leave | Time out |
|---|---|---|---|
| **Paid / waived** | **Changes salary.** Applies the matching waiver through the attendance correction and recalculates the employee. | Recorded. **Action required in payroll** until the payslip's day treatment makes the draft ₹0, unless it already is (e.g. absorbed by paid leave). | "No deduction for time away": recorded. The draft never charges time out, so it already matches. |
| **Unpaid actual time** | **Changes salary** if a correction currently waives the charge (turns the waiver off). Otherwise nothing to do: the engine already charges actual time. | Recorded. Matches unless a correction waives it. | **Not offered.** Actual time away is unavailable; a deduction needs a supported attendance source or an explicit correction on the payslip. |
| **Needs correction** | Informational; the event stays open. | Same | Same |
| Excuse (late arrival only) | Informational: affects only the monthly flag, never pay. | — | — |

There is **no "Use paid leave"** choice. Payroll allocates earned paid leave
automatically to the month's earliest eligible item and cannot be told which
day to use. When the draft shows ₹0 because of that rule, the event says so
("absorbed by the month's automatic paid leave … not a manual choice"). When
BOE Credits covered it, the event says that instead.

### How a decision reaches the draft (`planReviewApplication` + `saveReview`)

1. The server re-derives the event from live data. The browser sends only its key.
2. The correction is built from the day's **current** state: an existing
   correction's punches, day treatment and other waivers are carried over, and
   only the one waiver for this event changes. With no correction, the raw
   punches are copied as they are, and **only** when both punches exist or the
   direction was confirmed. Confirming a guessed lone punch could create a new
   late charge, so that case goes to the payslip instead.
3. It is applied by `applyAttendanceCorrection`
   (`src/lib/payroll/attendanceCorrectionService.ts`). That is the same code
   `POST /api/payroll/attendance-correction` runs:
   - it refuses a locked period;
   - it records the before/after audit;
   - it supersedes the previous correction (history kept);
   - it reconciles BOE Credits coverage;
   - it regenerates the employee.
4. Only after that succeeds is the decision stored, with the correction id and a
   fingerprint of the attendance as it now stands. If step 3 fails, **no
   decision is recorded**.
5. Saving the same decision again writes nothing, so there is no second waiver.
   A full regeneration reads the current correction, so the waiver survives and
   is applied once.

### Staleness

A decision records what the event looked like:
- the punches;
- this event's own waiver and the day treatment;
- the requests;
- the schedule settings.

If any of these change, the event shows **Review again** and says why (for
example "The punches changed.", "The payroll schedule settings changed."). A
waiver on the same day's *other* event does not make it stale.

### Statuses

Upcoming · Needs decision · Review again · Needs correction · Waiting for draft ·
**Action required in payroll** · **Matches payroll**.

Each employee shows **N unresolved** and **M disagree with draft**. The month
header totals both.

### Locking

`/api/payroll/lock` has never checked attendance corrections, objections or
anything else, and that is unchanged here. Changing it would alter lock
behaviour for existing periods and users. Instead, both lock buttons (Payroll
Runs and Payroll Results) fetch the month's summary and put it at the top of the
existing confirmation:

> ATTENDANCE REVIEW NOT FINISHED — 3 unresolved salary items, of which 1
> disagree with this draft: … Press OK only if you accept locking with these open.

If the check itself fails, the confirmation says it could not be checked. The
acknowledgement is **not recorded server-side**; the period's lock event is.
Once locked, the review and the correction service both refuse writes for that
month, and changes follow the existing Unlock or adjustment path.

**Unresolved items can therefore still pass through a lock**, with the admin
told and required to accept.

## 4. Behaviour change in the existing correction route

`POST /api/payroll/attendance-correction` used to recalculate a corrected
employee with **DEFAULT** settings: it passed `undefined` where full generation
passes the period's pinned snapshot. It now uses `settingsForPeriod`, the same
rule generation uses.

- **When settings equal the defaults**, the figures are identical.
- **When a period was generated under different settings**, a correction now
  produces the figure that period's own generation would produce, instead of
  one the next regeneration would move.

This needs review before release; see §7.

## 5. Checked cases (tests in `src/lib/attendance/requestHandlers.test.ts`)

1. **Informed 10:40, approved.** The draft still deducts ₹118 (1 h at
   ₹26,000 / 26 / 8.5) until a salary treatment is saved. Paid / waived gives
   the draft ₹0 for the day and net +₹118, with one correction (waiver on,
   punches unchanged). Saving it again writes nothing. Regeneration keeps it.
   Unpaid restores ₹118 through a second correction version, and the first is
   kept as history.
2. **Company vehicle reported 10:30 IST.** The request is uninformed and a
   company exception. Excuse + Paid / waived gives the draft ₹0, the event reads
   Matches payroll, and it no longer counts toward the flag.
3. **Lates on 5, 6, 7, 8, 9 and 10 Oct, none informed.** The flag lands on the
   8th, 9th and 10th (the 4th and later). Excusing three earlier ones clears it.
   Pay is unchanged, and no correction is written.
4. **Personal time out 14:00–15:30, no mid-day punches.** The event shows
   "actual time away unavailable" with a ₹0 draft. Unpaid is refused. "No
   deduction" writes no correction, and no minutes are invented.
5. **1 Oct absent.** The engine's paid leave absorbs it at ₹0, and the review
   says so. A second absence decided Paid / waived stays **Action required in
   payroll** and is counted in the lock summary.
6. **Locked month.** The review (salary treatment or excuse) and the correction
   service both refuse, and nothing is written.
7. **Admin's own request or attendance** is refused, and the refusal says so.
   With another active admin available, it names them as the route. With no
   other active admin, it names the limitation ("Add a second admin …"); there
   is no bypass. The queue and the review hide the actions on one's own items.

## 6. Data, access and notifications

Migration `20270130000000_attendance_requests.sql`:

| Table | Purpose |
|---|---|
| `attendance_requests` | Request and decision. Content is immutable (trigger); transitions are enforced. |
| `attendance_request_events` | Append-only audit, written by trigger in the same statement as each change. |
| `attendance_day_reviews` | Excuse and salary treatment per (employee, date, event), versioned, with `applied_correction_id`. The check excludes `use_paid_leave`. |

- **RLS:** an employee reads their own requests and events; an active admin
  reads all; reviews are admin-only.
- **Grants:** `authenticated` gets SELECT only, and `anon` gets nothing. Every
  write goes through the service-role routes, whose handlers
  (`src/lib/attendance/requestHandlers.ts`) take the caller from the bearer
  token.

Migration `20270130000100_attendance_request_notification_types.sql` adds
`attendance_request_submitted` and `attendance_request_decided`.

### Verified failure mode if code ships before `20270130000100`

This was run on a clone of a full local Supabase schema with only
`20270130000000` applied:

- **Reading the feed fails.** `ATTENDANCE_PAYROLL_NOTIFICATION_TYPES` names both
  new values, and `GET /api/notifications?category=attendance_payroll` filters
  with `type=in.(…)`, which PostgREST runs as `type = ANY('{…}')`. That fails
  with **22P02 `invalid input value for enum notification_type:
  "attendance_request_submitted"`**. As a result:
  - the list request and the unread-count request both return **500**
    (`src/app/api/notifications/route.ts` returns the error in both paths);
  - mark-all-read and delete-all for the category also fail;
  - this hits every user of the Attendance & Payroll notification feed, meaning
    `/attendance/notifications`, `/payroll/notifications`,
    `/my-issues/notifications` and the bell in the Attendance & Payroll shell,
    including the existing issue notifications.
- **Other categories are unaffected**, because their filters do not name these
  types.
- **Writing a notification fails too** (same 22P02). It is logged, and the
  submission or decision itself still succeeds.

Applying `20270130000100` makes the same query succeed.

## 7. Release

### Deployment order

1. Confirm the production migration history (`npx supabase migration list
   --linked`, read-only) still has nothing numbered above `20270123000000`.
   Renumber these two if it has.
2. Apply `20270130000000_attendance_requests.sql`. It is additive: three tables,
   triggers and policies, re-runnable.
3. Apply `20270130000100_attendance_request_notification_types.sql`. It adds two
   enum values and is idempotent. **This must happen before step 4.**
4. Merge and deploy the application.
5. Smoke test (§8) with two admin accounts.

Old code with the migrations applied is safe: nothing selects the new tables,
and the enum values are unused.

### Rollback

- **Application only:** redeploy the previous build. The tables and enum values
  are harmless to old code.
- **Schema:** run the `drop … if exists` block in the header of
  `20270130000000` (tested on the local clone: it drops cleanly and re-applies
  cleanly). Enum values cannot be dropped in place; leaving them is harmless.
- **Pay effects are not undone by either rollback.** Decisions applied through
  the review are ordinary `attendance_day_corrections` rows (remark "Payroll
  review: …"). To reverse one, correct the day again on the payslip (a new
  version; history is kept), or leave it. Dropping the review tables loses the
  decision history but not the corrections' own audit.

### Release blockers

1. **The settings behaviour change** (§4) needs sign-off. Before release, check
   whether any unlocked period's snapshot differs from the defaults, because
   corrections in that period will now produce different figures from before.
2. **UI click-through is unverified.** No safe signed-in environment was
   available. See the manual plan in §8.
3. **Policy:** confirm that a rejected but on-time request counts as "informed"
   (§9).
4. **A second active admin** is needed for any admin's own requests, and must
   exist before rollout if admins will file requests.

## 8. Manual test plan (local stack or staging; never production data)

**Accounts:**
- Admin A ("Nishant", `role = admin`)
- Admin B (`role = admin`)
- Employee E (`role = member`, `payroll_active`, monthly salary ₹26,000)

**Records:** October attendance for E, with 1 Oct absent, a 10:40 arrival on
5 Oct, 10:50 on 6 Oct, 10:35 on 7–10 Oct, and every other day 09:55–18:35.
Generate the October draft.

1. As E, before 10:00 IST on a test day: request a late arrival, reason
   Personal. It shows *before shift start*. As A, check the queue: approve works.
   As E, file one more request, and as A confirm A cannot decide A's own
   request.
2. As B: Payroll review for October, 5 Oct late arrival → **Paid / waived**,
   with a reason. The notice shows ₹118 → ₹0. The event reads **Matches
   payroll**. Open the payslip: the 5 Oct correction is there with remark
   "Payroll review: …", and net is +₹118.
3. 6 Oct: Excuse (company vehicle) + Paid / waived. The event matches and is no
   longer counted.
4. With no other decisions, the header shows the review flag on the 4th and
   later uninformed late arrival. Excuse earlier ones and the flag moves or
   clears. Net pay does not change from excuses.
5. As E: time out 14:00–15:30 on a test day. In the review, the event shows
   "actual time away unavailable", Unpaid is not offered, and "No deduction"
   leaves the draft unchanged.
6. 13 Oct absence → Paid / waived: it shows **Action required in payroll** and a
   payslip link, and stays unresolved.
7. Press **Lock Payroll**: the confirmation lists the unresolved and conflicting
   items. Cancel it. Lock for real, then try a decision: it is refused.

## 9. Open policy questions (not decided in code)

1. Does a rejected request that was submitted on time count as "informed"? Today
   it does.
2. The extra half-day deduction after the flag is not implemented; it is pending
   BOE's payroll/legal adviser (Code on Wages).
3. Time out has no measured duration. A salary effect needs a mid-day punch
   source (e.g. Minop break punches) or a manual correction.
4. The shift is company-wide; there are no per-employee or overnight shifts.

## 10. Not built

- Server-side lock blocking, or recording the acknowledgement.
- One-step application for absences, half days and leave (these are day
  treatments; the payroll admin sets them on the payslip).
- Leave types, balances, per-day paid-leave allocation, and mid-day punch
  collection.
- An admin editing a request's content.
- A notification to the employee when a review decision is saved.

## 11. Tests

| File | Covers |
|---|---|
| `src/lib/attendance/requests.test.ts` | Validation, informed-on-time in IST, overlaps, cancel window, decision rules |
| `src/lib/attendance/requestReconciliation.test.ts` | Flag, informed/excused, draft matching, stale reasons, time out, paid-leave wording, the decision → correction planner |
| `src/lib/attendance/requestHandlers.test.ts` | **Route-level:** authorisation (401 / 403 / own-only / no body-supplied id), self-decision, review → correction → payroll draft with the real engine, failure leaves no decision, lock refusal, pinned settings |
| `src/lib/attendance/lockWarning.test.ts` | Lock confirmation text; the lock API is untouched |
| `src/components/attendanceRequests/attendanceRequests.render.test.tsx` | The phone form and the correction pre-fill |

The route-level tests use `src/lib/attendance/testing/memorySupabase.ts`, an
in-memory stand-in, and never reach the linked project. SQL behaviour (triggers,
RLS, grants, the enum failure, rollback) was verified separately on a private
clone of a full local Supabase schema, which was dropped afterwards.
