# 30 - Day Close (staff accountability: plan, proof, close, strikes)

Built 2026-11-12 on branch `claude/boe1-employee-monitoring-t5ypei`. Migration `20270622000000_day_close.sql` is **NOT applied** yet: it must be applied before the merge, or every Day Close screen returns 500. The code is the truth; re-verify before relying on this page.

## 1. Purpose & users

The owner's ask (2026-11-12): staff work 2–3 hours of an 8½-hour day, nothing defines the day's work, and nobody is accountable. The aim is accountability without threats. Everyone knows what today's work is, closes it with proof before going home, and cannot take leave with work pending unless the owner allows it.

| Who | What they do |
|---|---|
| A member (any employee the owner switches on) | `/my-day`. Files the day's plan by 10:30, closes each item as Done (proof) or Not done (reason + new date), and closes the day before punching out |
| The reviewer (`day_close_settings.reviewer_id`, the owner alone) | Decides every strike (Uphold / Waive with a note). Is the only person who may approve leave sent while work was pending |
| Administrators | `/attendance/day-close` (Team Today) to read, plus who takes part |

Named in the ask: Dhruv (business development), Rakesh (social media), the SEO person, the sales team, and Jasvi. The owner said "all of team".

## 2. Status

Built and tested on the branch; not merged; migration not applied. Phase 1 of the plan agreed in the session:
- **Phase 2 (not built):** a content calendar for social media and a monthly scorecard.
- **Phase 3 (not built):** call-log sync from the company Android phones, and the WhatsApp Business app "coexistence" with the Cloud API, so every message on the company number reaches BOE.

## 3. Owner decisions (2026-11-12)

| Decision | Value |
|---|---|
| Consequence | **Strikes only**, no money (credits/salary may come later) |
| Office | 10:00–18:30 IST, **Monday to Saturday** (Sunday off) |
| Plan due | **10:30**. A late arrival gets 30 minutes after their first punch (`planDueMinutes`) |
| Closing opens | **18:00**. The day must be closed **before the last punch** on the machine (5 minutes' tolerance) |
| Leave | Full-day and half-day leave sent with work pending is **still sent but locked**: only the reviewer can approve it; anybody may reject it |
| "Work pending" | Overdue tasks (due before today, not submitted / completed / cancelled) **or** a `day_not_closed` strike in the last 7 days that was not waived |
| Who reviews | **The owner only** (the reviewer seat; an administrator takes it once from Team Today) |
| Who takes part | Everyone the owner switches on; "Add everyone" adds every active non-admin |

## 4. Rules (src/lib/dayClose/rules.ts, pure)

- **The plan.** It holds the tasks somebody else assigned that are due today or overdue and not closed: copied in by the server, marked with a lock, and not removable. It also holds the member's own items (title + expected output, at most 15). Filing needs at least one item. Own items can be removed only before filing.
- **Done.**
  - An own item needs an http(s) link or a photo (JPEG under 5 MB, shrunk in the browser, private bucket `day-proof`, path `{employee}/{uuid}.jpg`, checked to be the caller's own).
  - An assigned item is Done only when its task is `pending_approval` or `completed` in Task Management. Day Close never changes a task.
- **Not done.** A reason (3+ characters) and a new date, after today and at most 60 days ahead.
- **Close day.** Allowed only with no open items. Assigned tasks already handed in are marked Done automatically. Closing before 18:00 is allowed after a confirm (leaving early with permission), and the time shows.
- **Strikes** (the nightly check at 23:15 IST, `/api/day-close/evaluate`):

  | Strike | When |
  |---|---|
  | `no_plan` | Never filed |
  | `plan_late` | Filed after the due time |
  | `day_not_closed` | Never closed |
  | `closed_after_leaving` | Closed more than 5 minutes after the last punch |

  **Never** a strike on a Sunday, a `payroll_holidays` date, a day of approved `full_day_leave`, or a day with **no punch** (absence is Attendance's job, and a machine fault must never become a strike). A strike is written once (unique per person, day and kind), and a decided one is never touched.

## 5. Database (`20270622000000_day_close.sql`)

Every table is **closed to the browser**: RLS is on, there are no policies, and all privileges are revoked. All access goes through the service-role API routes, which take the actor from the bearer token.

| Table | What it holds |
|---|---|
| `day_close_settings` | Singleton: `reviewer_id`, `plan_due_minutes` 630, `close_opens_minutes` 1080 |
| `day_close_members` | `employee_id` pk, `active`, who added or removed them |
| `day_plans` | Unique (employee, date). `submitted_at`, `closed_at` (only after filing), `close_note` |
| `day_plan_items` | `source` assigned/own (assigned ⇔ `task_id`). `status` open/done/not_done. CHECKs: done needs proof (own), not done needs reason + date, closed_at ⇔ resolved. Unique (plan, task) |
| `day_strikes` | Unique (employee, date, kind). `status` open/upheld/waived; a decision needs who and when; waiving needs a note |
| `day_close_leave_locks` | One per `attendance_requests.id`: counts, words, released by/at |

The trigger `day_close_closed_guard` makes a closed day immutable (plan and items). A plan is never deleted.

The storage bucket `day-proof` is private, JPEG only, 5 MB, with no `storage.objects` policy; only the service role writes to it and signs links.

**Rollback:** in the migration header. Nothing else references these objects.

## 6. Routes and screens

| Route | Who | What |
|---|---|---|
| `GET/POST /api/day-close/me` | Member (own day only) | Load; `add_item`, `remove_item`, `file_plan`, `close_item`, `close_day` |
| `GET /api/day-close/prompt` | Anyone (silent if not a member) | The Modules-page strip |
| `POST /api/day-close/proof` | Member | Raw JPEG → `{ path }` |
| `GET /api/day-close/team?date=` | Admin or reviewer | Team Today |
| `POST /api/day-close/strikes/[id]` | Reviewer only | `{ decision: upheld \| waived, note }` |
| `GET/POST /api/day-close/members` | Admin or reviewer | `add`, `remove`, `add_everyone`, `become_reviewer` (admin, while empty) |
| `GET /api/day-close/evaluate` | Vercel cron `45 17 * * *` (23:15 IST), `CRON_SECRET` | `?date=` re-runs a past day |

**Screens**
- `/my-day`: employee sidebar "My Day", in the Attendance & Payroll shell.
- `/attendance/day-close`: the admin Attendance section's "Day Close" tab, behind AttendanceGuard.

**Who must act** (§8e of dossier 12)
- **Member:** the Day strip on `/modules` (`src/app/modules/DayStrip.tsx`) shows, and cannot be hidden:
  - amber "File today's plan by 10:30";
  - red after the due time;
  - red "Close your day before you punch out" from 18:00 until the day is closed.

  It leaves when the thing is done. A For you catalogue item was not added: the strip is the always-on placement.
- **Reviewer:** "Strikes to review" at the top of Team Today, and the 🔒 "Work pending" mark on the leave queue (`RequestQueue.tsx`).

**Leave integration:** `src/lib/attendance/requestHandlers.ts`.
- `submitRequest` calls `lockLeaveIfPending` after the insert. The response carries `work_pending`, and the request form alerts the employee.
- `decideRequest` calls `leaveDecisionGate` before an approval: 409 for anyone but the reviewer, 500 if the check fails. After an approval, `releaseLeaveLock`.
- `listRequests` (queue) returns `work_pending` by request id.

Team Today shows, per member:
- the machine's first and last punch;
- the plan's filed time; when the day was closed;
- done / not done / open, with proof links and photos;
- calls and WhatsApp messages **logged** on the Lead Board that day (`sales_lead_activities`, self-reported: not proof of a real call yet);
- overdue tasks; the day's strikes; strikes this month (not waived).

## 7. Traps

1. **Merge only after the migration is applied.** The routes read the new tables. Before that, every Day Close screen, the strip and the leave queue's lock read fail:
   - `leaveLocksFor` returns empty on error;
   - `lockLeaveIfPending` is wrapped;
   - `leaveDecisionGate` fails closed with 500 **only when a lock read throws**. With the table missing, `leaveLocksFor` swallows the error, so approvals still work.
2. **The machine is the only clock for "left".** A member with no Machine ID is never struck for closing after leaving, and a day with no punch is never judged.
3. Calls and WhatsApp counts are what salespeople logged, not phone records. Phase 3 (call-log sync, WhatsApp coexistence) is what makes them proof.
4. `add_everyone` excludes administrators by role. Switch an admin on individually if wanted.
5. Strikes are written at 23:15 IST. Somebody who closes the day at 23:30 still has `day_not_closed`, and the reviewer waives it.
6. MemorySupabase (tests) has no `.not()`. `pendingWorkFor` filters overdue tasks in TypeScript for that reason. Keep it that way, or extend the mock.

## 8. Tests

| Test | Checks |
|---|---|
| `src/lib/dayClose/rules.test.ts` | Times, the judgement, the prompt, item validation, overdue and lock rules |
| `src/lib/dayClose/leaveLock.test.ts` | The real attendance-request handlers + the nightly check over MemorySupabase: lock written, other admin refused, reject allowed, reviewer approves and releases, no lock when not pending / not a member / not leave, the unclosed-day rule, a waived strike ignored, no strike without a punch, two strikes written once |
| `supabase/tests/day_close_pglite.mjs` (13 checks on the real migration) | `node supabase/tests/day_close_pglite.mjs <dir with @electric-sql/pglite>` |
| `src/components/layout/attendancePayrollNav.test.tsx` | Updated for the new tab and nav entry |

## 9. Recheck before changing

- `ls supabase/migrations | grep day_close` and the latest definition of each table.
- `grep -rn "dayClose" src` for every caller, including `requestHandlers.ts` and `RequestQueue.tsx`.
- `vercel.json` still lists `/api/day-close/evaluate`.
