# 30 - Day Close (staff accountability: plan, proof, close, strikes)

> **Apply-state correction (2026-11-13).** The six migrations `20270622000000`, `20270624000000`, `20270625000000`, `20270626000000`, `20270627000000` and `20270628000000` were **not** in production when their PRs merged. Team Today showed "Something went wrong" and the scoreboard tables were missing (`to_regclass` checks all false). After a `backup-all.mjs` backup, the owner applied all six in order through the SQL Editor on 2026-11-13; a check then showed every table and column present. **Lesson:** after "Migration applied", confirm with a `to_regclass` / `information_schema` query before merging.

**History.**
- First built as a separate "My Day" list: PR #713, merged as `2466d96`, migration `20270622000000`. The owner said it was **APPLIED 2026-11-12, before that merge**; this was not re-checked from the cloud session.
- Folded into **Task Management** the same day (owner: "My Day is very similar to Self Tasks… it will create confusion"). This is migration `20270624000000_day_close_in_tasks.sql` (PR #721, merged as `db54a23`; the owner said it was applied before the merge).

The code is the truth; re-verify before relying on this page.

## 1. Purpose & users

The owner's ask (2026-11-12): staff work 2–3 hours of an 8½-hour day, nothing defines the day's work, and nobody is accountable. The aim is accountability without threats:
- everyone knows what today's work is;
- everyone finishes it with proof, or explains it, before going home;
- nobody takes leave with work pending unless the owner allows it.

**There is no second list.** The day's work is the person's own tasks in Task Management. Day Close adds only the rules around them.

| Who | What they do |
|---|---|
| A member (an employee the owner switches on) | Works on the **Task Management dashboard**, "Today" card:<br>- their tasks due today or overdue (Self Tasks included)<br>- **File today's plan** by 10:30<br>- finish tasks as usual, **with proof**<br>- **Close my day**: a reason and new date for anything not finished, and the day's summary, which **is the EOD log** |
| The reviewer (`day_close_settings.reviewer_id`, the owner alone) | Decides every strike (Uphold / Waive with a note). Is the only person who may approve leave sent while work was pending |
| Administrators | **Team Today** (`/tasks/team-today`, Task Management sidebar) to read; who takes part |

## 2. Owner decisions (2026-11-12)

| Decision | Value |
|---|---|
| Consequence | **Strikes only**, no money. They feed the planned Scoreboard (Discipline points) |
| Office | 10:00–18:30 IST, **Monday to Saturday** |
| Plan due | **10:30**, or 30 minutes after a late first punch |
| Closing | Opens **18:00**. The day must be closed **before the last punch** on the machine (5 minutes' tolerance) |
| Proof | **Every task a member finishes**: a self task to Completed, or a delegated task to Pending approval. The proof is a file or photo on an update or status change, or a link in an update, posted **by them** on that task. Approving a submitted task needs nothing more |
| EOD | "Close my day" also writes `daily_work_logs` (summary), so staff do one evening action |
| Team Today | Inside Task Management, not Attendance |
| Leave | Full-day or half-day leave sent with work pending (overdue tasks, or an unwaived `day_not_closed` in the last 7 days) is **sent but locked**: only the reviewer approves; anybody may reject |

## 3. Rules (`src/lib/dayClose/rules.ts`, pure)

- **The day's list (`dayTaskList`).**
  - Before filing: open tasks (not completed or cancelled) assigned to the person, due today or before.
  - After filing: the tasks named in `day_plans.planned_task_ids` (whatever happened to them since, except cancelled), plus any open task that became due later that day.
  - **Filing** needs at least one task. If nothing is due, the person adds a Self Task due today.
- **States (`dayTaskState`).**
  - `done` = `pending_approval` or `completed`.
  - `carried` = a reason and a new date were given at closing.
  - Otherwise `open`.
- **Close my day.**
  - Every open task needs a carry-over: a reason of 3+ characters and a date after today, within 60 days.
  - The summary is required and is upserted as that day's EOD.
  - Closing before 18:00 needs an in-page confirm ("leaving early with permission"), and the time shows.
- **Strikes:** the nightly check, 23:15 IST, `/api/day-close/evaluate`.

  | Strike | When |
  |---|---|
  | `no_plan` | Never filed |
  | `plan_late` | Filed after the due time |
  | `day_not_closed` | Never closed |
  | `closed_after_leaving` | Closed more than 5 minutes after the last punch |

  **Never** a strike on a Sunday, a holiday, approved full-day leave, or a day with no punch.

## 4. Database

**`20270622000000` (#713):**

| Object | What it holds |
|---|---|
| `day_close_settings` | Reviewer and times |
| `day_close_members` | Who takes part |
| `day_plans` | Unique per person and day |
| `day_strikes` | Strikes and their decisions |
| `day_close_leave_locks` | One per locked leave request |
| `day_close_closed_guard` | Trigger: a closed day is immutable |
| Bucket `day-proof` | Private. **Now unused** (proof lives on tasks). Empty; can be deleted |

All tables are closed to the browser; the service-role routes take the actor from the token.

**`20270624000000` (this change):**
- Drops `day_plan_items`. It refuses to if any row exists.
- Adds `day_plans.planned_task_ids uuid[]`.
- New table `day_close_carryovers`: plan, task, reason, next date. Unique per plan and task, guarded by `day_close_closed_guard`, closed to the browser.
- **Proof trigger** `tasks_day_close_proof`: a deferred constraint trigger, `after update of status`, checked at COMMIT. It is deferred because `change_task_status()` writes the status before the history row that carries the attachment.
  - It applies only when `auth.uid()` is the assignee, the person is an active member, and the task moves into `completed` (not from `pending_approval`) or into `pending_approval`.
  - Proof must be posted by the assignee: a `task_activity_log` row with `attachment_url`, a note containing `http(s)://…`, or a `task_attachments` row hanging off one of their log rows.
  - The creator's brief (task-level attachments, their notes) does not count.
  - The refusal is `DAY_CLOSE_PROOF_REQUIRED` (P0001), shown as written by `statusChange.ts` (a "refused" outcome).

## 5. Routes and screens

| Route | Who | What |
|---|---|---|
| `GET/POST /api/day-close/me` | Member (own day only) | Load; `file_plan`; `close_day { summary, carryovers[] }` |
| `GET /api/day-close/prompt` | Anyone (silent if not a member) | The Modules-page strip |
| `GET /api/day-close/team?date=` | Admin or reviewer | Team Today |
| `POST /api/day-close/strikes/[id]` | Reviewer only | Uphold or waive a strike |
| `GET/POST /api/day-close/members` | Admin or reviewer | Who takes part |
| `GET /api/day-close/evaluate` | Vercel cron 23:15 IST, `CRON_SECRET` | Writes the night's strikes |

**Screens**
- `src/components/dayClose/DayCard.tsx`: first on `/dashboard` (hidden under View As).
- `/tasks/team-today`: `TeamTodayScreen`. The sidebar entry is shown to admins, not while previewing.
- `src/app/modules/DayStrip.tsx`: the strip on `/modules`. It opens Task Management.

**Removed with this change:** `/my-day`, the "My Day" employee nav entry, `/attendance/day-close` and its Attendance tab, `/api/day-close/proof`.

The leave integration in `requestHandlers.ts` and the 🔒 mark on the leave queue are unchanged.

## 6. Traps

1. **Apply `20270624000000` before merging.** Without it the routes read `planned_task_ids` and `day_close_carryovers`, which don't exist yet.
2. The proof trigger **also applies to the quick-complete on My Tasks**: a member must post the proof first. Any other path that completes a member's task under their own session, now or later, is checked too.
3. Proof is per task, not per day. An update with a link posted last week on the same task still counts.
4. The machine is the only clock for "left". No machine ID or no punch means no `closed_after_leaving` and no judged day.
5. Calls and WhatsApp counts on Team Today are what salespeople logged, not phone records.
6. MemorySupabase has no `.not()`. Code exercised by `leaveLock.test.ts` (pending work, the nightly check) must not use it.

## 7. Tests

| Test | Checks |
|---|---|
| `src/lib/dayClose/rules.test.ts` | Times, the judgement, the prompt, the task-based day, carry-overs, the summary, leave rules |
| `src/lib/dayClose/leaveLock.test.ts` | The real attendance-request handlers and the nightly check, over MemorySupabase |
| `supabase/tests/day_close_pglite.mjs` | 13 checks on `20270622000000` |
| `supabase/tests/day_close_in_tasks_pglite.mjs` | 10 checks on `20270624000000`: the drop guard, carry-overs, and proof in every case, including the attachment written after the status in one transaction |

## 8. Recheck before changing

- `grep -rn "dayClose\|day-close\|day_close" src supabase/migrations`.
- The latest `change_task_status` and `transition_task_review` definitions: a new completion path must still pass through `tasks` under the user's session for the proof check to apply.
