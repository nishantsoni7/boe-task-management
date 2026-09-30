# Attendance Requests → Approval → Payroll Review — as built

**Status:** Draft PR #239, branch `feat/attendance-requests`. Migrations
prepared, **not applied** to any Supabase project.
**Last updated:** 2026-09-27 (third pass: charge explanation, server-checked lock acknowledgement, release checks)

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
   rejects it under **Attendance & Payroll → Attendance → Requests**.
   The employee is notified. **Approval records permission only.**
3. At payroll time an admin opens **Attendance → Monthly Review → Salary decisions** for the month and records a
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
  sets the submission time. **A request submitted on time stays "informed"
  even if it is later rejected**; see §9.
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

### How each charge is stated

Late arrivals and early departures show one line, for example:

> 40 minutes late · payroll rule charges 1 hour · ₹118 proposed in the draft

- **Minutes:** measured from the scheduled start or end.
- **Hours:** from the engine's own `roundDeductionHours`, with the period's
  settings. It is exported, not changed. Up to 15 minutes costs nothing;
  beyond that, the time is rounded **up** to the next 30 minutes at ½ hour per
  block, so 16–30 → ½ h, 31–60 → 1 h, 61–90 → 1½ h.
- **Rupees:** always the stored draft line; never recalculated here.

If the draft charges different hours (a day the engine classifies another
way), both are shown. A waived event says "waived by attendance correction —
₹0"; an absorbed one says "absorbed by automatic paid leave". The same rule
sentence appears in the decision modal, built from the period's settings. The
rule itself was already stated in *How Payroll Works*
(`src/app/payroll/how-it-works/guideContent.ts`) and in `PAYROLL_RULES_V1.md`
(Late Coming Rules). This PR does not change it.

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

### Locking (server-checked, recorded)

`POST /api/payroll/lock` now goes through `lockPayrollPeriod`
(`src/lib/payroll/lockPeriod.ts`):

- **Nothing open** (no unresolved items and no draft conflicts): the lock is the
  same single update and status event as before.
- **Open items:** the lock is refused with `409 attendance_unresolved`, returning
  the counts, the employees affected and a **server-computed fingerprint**. The
  fingerprint is a sha-256 over each open event's employee, date, event and
  status. A lock with open items needs
  `attendance_acknowledgement: { fingerprint, reason }`:
  - If anything changed since (a decision saved, a punch corrected, a new
    event), the fingerprint no longer matches, and the request gets
    `409 attendance_ack_stale` with the fresh state.
  - Otherwise, **one SECURITY DEFINER function**
    (`lock_payroll_period_with_attendance_ack`, service role only) locks the
    period **and** writes `payroll_lock_attendance_acknowledgements` in one
    transaction. The row records the actor, time, counts, fingerprint,
    per-employee counts (no names, no amounts) and reason. It is append-only;
    only admins can read it.
- **Review unreadable** (a database or application read error, or missing
  migrations): **`503 attendance_review_unavailable`, `retryable: true`**.
  Nothing is locked and nothing is recorded. No acknowledgement or reason can
  stand in for a review nobody could see; the admin retries once the read
  works. The database enforces this too: an acknowledgement row must carry a
  fingerprint, so an unread review cannot be recorded as acknowledged.
- **Month not ended**: `422 payroll_month_in_progress` (see §3b).
- **Both Lock buttons** follow the server's answer. They show the open items,
  ask for a reason (a blank reason cancels), resend with the server's
  fingerprint, and show the new state if it went stale. A direct API call can
  no longer skip any of this.
- Once locked, the review and the correction service refuse every write for
  that month.

### 3b. A payroll month is written only after it has ended

**The defect (real, not a fixture artefact).** The engine
(`buildWorkingDayCalendar`) has no notion of today. Every non-Sunday,
non-holiday date in the month is a working day, and a working day with no punch
is an **absence**. Nothing in generation, correction or lock checked whether the
month had ended.
- On 27 Sep 2026 the real `/api/payroll/generate` charged **28, 29 and 30 Sep
  as full-day absences** (₹1,000 each), and that draft was then locked.
- Reproduced with the real engine on a fixed date in
  `src/lib/payroll/periodCompletion.test.ts`.
- Production today has only July and August periods (both ended), but a normal
  admin could have created and generated September on any day in September.

**The rule** (`src/lib/payroll/periodCompletion.ts`): a month can be
**generated, recalculated through an attendance correction, or locked** only once
it has ended in IST, i.e. from 00:00 IST on the 1st of the next month.
- **Generate** refuses with `422 payroll_month_in_progress` before any engine
  run or settings pin. The message says why and from when it opens, e.g.
  "September 2026 has not ended yet … from 1 Oct (IST)".
- **The correction service** refuses before recalculating. A review waiver
  decision mid-month is therefore not saved; an excuse, which has no pay
  effect, still is.
- **Lock** refuses before the attendance check.
- **Payroll Runs** shows "Month in progress — payroll can be generated and
  locked from 1 Oct (IST)" on that row.
- **Payroll Monthly Preview** (read-only) shows the current month only up to
  yesterday. A new engine option, `calendarThrough`, leaves later dates out of
  the calendar entirely, so they are never worked, absent or charged. The page
  says so.

**Unchanged:** a month that has ended calculates exactly as before; the option
is off in every write path, and a test asserts identical results. **No bypass:**
BOE has no final-settlement or early-close path in payroll (`users.exit_date`
is not read by the engine), so none is invented. See §9.

**Behaviour change to note:** before this, any generated month could be locked
with one click. Now, a month with any unresolved attendance item needs the
acknowledgement step. The rule is working as intended, but most months will
show open items until the review is used.

## 4. The correction route's settings

`POST /api/payroll/attendance-correction` used to recalculate a corrected
employee with **DEFAULT** settings. It passed `undefined`, whereas full
generation uses the period's pinned snapshot. It now uses `settingsForPeriod`,
the same rule generation uses. A test proves the correction's figure equals a
full regeneration of the period, even under a non-default snapshot.

**Production check (2026-09-27, read-only, SELECT only)** via
`npx supabase db query --linked`. This path may create a temporary login role;
it is the repo's accepted precheck path. The zero-write psql path needs
`PROD_DB_URL`, which was not available. Findings:
- 2 payroll periods, both `generated` (unlocked), both with a saved snapshot.
- **No settings key differs from the code defaults** in either snapshot, and the
  active settings row equals the defaults too.
- Correcting a day in either period therefore gives **the same draft under the
  old and new behaviour**.

No values, amounts or employee data were read out. Recheck before release if
settings change.

## 5. Checked cases

Route-level tests in `src/lib/attendance/requestHandlers.test.ts` run the real
handlers, correction service, lock logic and payroll engine against an in-memory
database:

1. **Informed 10:40, approved.** The draft still deducts ₹118 (1 h) until a
   salary treatment is saved. The review states "40 minutes late · payroll rule
   charges 1 hour · ₹118 proposed in the draft", and those hours and rupees
   equal the engine's stored line. Paid / waived gives ₹0 through one
   correction. Saving again writes nothing. Regeneration keeps it. Unpaid
   restores ₹118 as a new version.
2. **Company vehicle reported late.** Excuse + Paid / waived gives ₹0, the
   event matches payroll, and it is not counted toward the flag.
3. **Four or more uninformed lates.** Only the 4th and later are flagged.
   Excusing earlier ones clears the flag. Pay is unchanged.
4. **Time out 14:00–15:30, no mid-day punches.** Nothing is measured or
   charged, and Unpaid is refused.
5. **Automatic paid leave** is described as the engine's rule, not a choice.
6. **Locked month.** Review and correction writes are refused.
7. **Self-decision** is refused. With a single admin, the limitation is named.

Lock cases:
- nothing open → the simple lock;
- a direct call without an acknowledgement → 409, nothing locked;
- an acknowledgement → locked and recorded;
- the state changes in between → stale refusal, then a fresh acknowledgement works;
- a blank reason → 400;
- the review is unreadable → 503 retryable; nothing locks, even with a valid
  fingerprint and reason, and it works again once the read succeeds;
- a month that has not ended → 422, even with nothing open;
- a waiver decision mid-month → 422, nothing written; an excuse is still
  recorded.

## 6. Data, access and notifications

Migration `20270215000000_attendance_requests.sql`:

| Object | Purpose |
|---|---|
| `attendance_requests` | Request and decision. Content is immutable; transitions are enforced. |
| `attendance_request_events` | Append-only audit, written by trigger. |
| `attendance_day_reviews` | Excuse and salary treatment per event, versioned, with `applied_correction_id`. No `use_paid_leave`. |
| `payroll_lock_attendance_acknowledgements` | Durable record of every lock made past open items (or a failed check). Append-only; admin read. Cascades with its period on deletion, like the period's lock history. |
| `lock_payroll_period_with_attendance_ack()` | Locks the period and writes the record in one transaction. Callable by the service role only; checks the actor is an active admin. `search_path = public, pg_temp`. |

- **RLS:** an employee reads their own requests and events; admins read all;
  reviews and acknowledgements are admin-only.
- **Grants:** `authenticated` gets SELECT only; `anon` gets nothing.

Migration `20270215000100_attendance_request_notification_types.sql` adds
`attendance_request_submitted` and `attendance_request_decided`.

### ⚠ Notification enum dependency: apply before deploying code

If the code ships before `20270215000100`, the Attendance & Payroll feed's
filter (`type=in.(…)`, which PostgREST runs as `type = ANY('{…}')`) fails with
**22P02 invalid input value for enum notification_type**:
- the list, unread-count, mark-all-read and delete-all requests all return
  **500** for every user of that feed (`/attendance/notifications`,
  `/payroll/notifications`, `/my-issues/notifications`, and the module bell),
  including existing issue notifications;
- writing these notifications also fails; the failure is logged, and the
  business action still succeeds.

Other feeds are unaffected. Verified on a clone of a full local Supabase schema.

## 7. Release

### Ordering against current main and other branches (rechecked 2026-09-28)

- **Production:** the newest applied migration is `20270205120000` (#241).
  `main` was merged into this branch; its `20270201000000`, `20270205000000`
  and `20270205120000` touch no payroll, attendance, users or notification
  objects.
- **Renumbered:** this PR's migrations moved from `20270130000000`/`…000100`
  (now below applied history) to **`20270215000000`** and
  **`20270215000100`**, above everything applied and above #248's pending
  `20270210000000`/`20270211000000`.
- **Other open PRs:** #214 (`20270124000000`), #212 (`20270125000000`),
  #213 (`20270126000000`) and #240 (`20270131000000`) are already below
  applied history and must be renumbered by their owners whatever this PR
  does. No number collides.
- **No open PR touches** the lock route, the correction route, the engine or
  the notification code.
  - The overlap is the shared migration-sequence pin tests (one-line merge
    conflicts expected).
  - #223 edits `/api/payroll/periods` (not used here).
  - #132 renames payroll live-DB suites.
  - #212's forward guard requires `SECURITY DEFINER` functions to pin
    `pg_temp` last; the new function does.
- **Old build + new migrations are safe:**
  - old code reads none of the new objects;
  - the lock and period tables are not altered;
  - period deletion still works with an acknowledgement present (verified);
  - the enum values are unused.

### Deployment order

1. Recheck `npx supabase migration list --linked`. Renumber if anything above
   `20270205120000` has been applied (or #248 has shipped a higher number).
2. Apply `20270215000000_attendance_requests.sql`.
3. Apply `20270215000100_attendance_request_notification_types.sql`. **This must
   happen before step 4** (see §6).
4. Merge and deploy the application.
5. Smoke test with two admins and one employee (§8).

New code on an unmigrated database cannot read the review, so every lock fails
with the retryable 503 until the migrations are applied. This is another reason
migrations must go first.

### Rollback

- **Application:** redeploy the previous build. The new objects are unused by
  old code.
- **Schema:** run the drop block in `20270215000000`'s header, after exporting
  `payroll_lock_attendance_acknowledgements` if it has rows. Enum values stay;
  they are harmless.
- **Pay:** review-applied waivers are ordinary attendance corrections. Neither
  rollback undoes them; correct the day again on the payslip if needed.
  Locked months stay locked; use Unlock with a reason.

### Remaining release blockers

1. **Confirm the new lock step with the payroll owner.** Every month with open
   attendance items now needs a recorded acknowledgement to lock.
2. **Coordinate migration numbering** with #212, #213, #214 and #241 (see
   above) at release time.
3. **Deploy migrations before the code** (§6); this is an ordering requirement,
   not a code gap.

## 8. Click-through (done 2026-09-27, isolated local stack)

This ran on a stack started for this worktree only, with the `public` schema
copied from a local dev stack plus configuration rows (no business records, no
production data), both migrations applied, and three local accounts: Admin A,
Admin B and Employee E. September 2026 attendance was seeded for E.

1. **Employee E, phone (375 px):** Attendance request → Late arrival, 28 Sep,
   Company vehicle delay → Submit. The request shows *Pending · submitted 27
   Sep 10:16 · before shift start*.
2. **Admin A, desktop:** the notification arrived. Queue → Approve with a note.
   The database shows approved by Admin A, audit `submitted → approved`,
   notifications to both admins and to E.
3. **Admin B:** Payroll Runs → Generate. The draft has 5 Sep late 1 h ₹118.
   Payroll review shows "40 minutes late · payroll rule charges 1 hour · ₹118
   proposed in the draft". Paid / waived with a reason gives "₹118 to ₹0" and
   **Matches payroll**. The database has one correction (10:40 kept, waiver
   on, ₹118 → ₹0, by Admin B) and no 5 Sep line.
4. **Lock, desktop:** a direct API call without an acknowledgement → 409
   (5 open). The Lock button shows the open items, a reason is given, and the
   month locks. The database has an acknowledgement row with Admin B, 5 open,
   the same fingerprint, the reason, and a status event.
5. **After lock:** a review write → 422. At phone width, the review has no
   Decide actions, shows the "locked" note, and has no horizontal overflow.

Native `confirm` and `prompt` were stubbed in the pane to answer them; their
texts were captured and are shown in the PR. To repeat this on staging, use the
same three roles and records.

## 9. Policy decisions

1. **Informed stays informed.** A request submitted before the scheduled shift
   start remains "informed" even if later rejected. Rejection decides whether
   the reason is accepted and whether time is paid, not whether notice was
   given. The submission time and the informed label are never rewritten. The
   admin can still choose *Unpaid actual time* for that day. (Tested.)
2. The extra half-day deduction after the flag is **not implemented**; it stays
   a review flag pending BOE's payroll/legal adviser.
3. Time out has no measured duration; no mid-day punch assumptions are made.
4. The shift is company-wide; there are no per-employee or overnight shifts.
5. **Existing gap, not changed here:** payroll ignores `users.exit_date`, so an
   employee who leaves mid-month is charged as absent for the working days
   after their exit. A final-settlement rule (generate a leaver before month
   end, counting only days up to the exit date) is a separate payroll decision.

## 10. Not built

- One-step application for absences, half days and leave (these are day
  treatments on the payslip).
- Leave types, balances, per-day paid-leave allocation, and mid-day punch
  collection.
- An admin editing a request's content.
- A notification to the employee when a review decision is saved.

## 11. Tests

| File | Covers |
|---|---|
| `src/lib/attendance/requests.test.ts` | Validation, informed-on-time in IST, overlaps, cancel window, decisions |
| `src/lib/attendance/requestReconciliation.test.ts` | Flag, informed/excused (incl. rejected-but-on-time), draft matching, stale reasons, time out, paid-leave wording, planner, **charge explanation and rounding** |
| `src/lib/attendance/requestHandlers.test.ts` | **Route-level:** authorisation, self-decision, review → correction → draft with the real engine, charge text = stored line, lock acknowledgement (simple, refused, recorded, stale, blank reason), **unreadable review → 503**, **month not ended → 422**, correction = full generation |
| `src/lib/payroll/periodCompletion.test.ts` | **Future dates:** the defect reproduced with the real engine (27 Sep 2026), the month-end rule, every write checks it first, the preview trims, completed months unchanged |
| `src/lib/attendance/lockWarning.test.ts` | The Lock button's conversation with the server |
| `src/components/attendanceRequests/attendanceRequests.render.test.tsx` | The phone form and the correction pre-fill |

SQL behaviour was verified on private clones of a full local Supabase schema,
which were dropped afterwards. It covered triggers, RLS, grants, the lock
function and its refusals, the enum failure, period deletion and rollback.
