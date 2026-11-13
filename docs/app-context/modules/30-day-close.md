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
| `GET /api/day-close/team?date=` | Admin or reviewer | Team Today. Also returns `lockedLeave`: pending leave requests locked by work pending (a failed read leaves it empty) |
| `POST /api/day-close/strikes/[id]` | Reviewer only | Uphold or waive a strike |
| `GET/POST /api/day-close/members` | Admin or reviewer | Who takes part |
| `GET /api/day-close/evaluate` | Vercel cron 23:15 IST, `CRON_SECRET` | Writes the night's strikes |

**Screens**
- `src/components/dayClose/DayCard.tsx`: first on `/dashboard` (hidden under View As).
- `/tasks/team-today`: `TeamTodayScreen`. The sidebar entry is shown to admins, not while previewing.
  - **Redesigned 2026-11-13 ("attention first", the owner's pick from two previews).** Three tabs:

    | Tab | Shows |
    |---|---|
    | Today | **Needs your decision** (open strikes with Uphold / Waive…, which asks for a reason; locked leave, linking to Attendance requests), **The day so far** (planned, closed, tasks done; the office-day time bar 10:00 to 6:30), then **Everyone, worst first**: one table grouped Needs attention / On track / Away, each row opening to that person's tasks, carry-over reasons and end-of-day note |
    | People & targets | Who takes part (open by default) and the Scoreboard targets |
    | Ratings | The owner's monthly ratings (the reviewer only) |

  - The grouping and chips come from `src/lib/dayClose/teamView.ts` (pure):
    - a missing plan is grey "Plan due 10:30 am" until it is due (later for a late arrival), then red;
    - "Not closed" only after 6:30 pm;
    - "No punch" only for people linked to the machine, once their plan is due.
  - Styles are in `teamToday.module.css`. `dayClose.module.css` still serves the Today card.
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
| `src/lib/dayClose/teamView.test.ts` | 13 tests on Team Today's chips and groups: never red before the plan is due, late arrivals, late plans, day off, leave, closing, punches, overdue, strikes, order |
| `src/lib/dayClose/leaveLock.test.ts` | The real attendance-request handlers and the nightly check, over MemorySupabase |
| `supabase/tests/day_close_pglite.mjs` | 13 checks on `20270622000000` |
| `supabase/tests/day_close_in_tasks_pglite.mjs` | 10 checks on `20270624000000`: the drop guard, carry-overs, and proof in every case, including the attachment written after the status in one transaction |

## 8. Recheck before changing

- `grep -rn "dayClose\|day-close\|day_close" src supabase/migrations`.
- The latest `change_task_status` and `transition_task_review` definitions: a new completion path must still pass through `tasks` under the user's session for the proof check to apply.

## 9. The team switch (`20270704000000_day_close_team_switch.sql`, 2026-11-13)

**Applied 2026-11-13** by the owner after PR #746 merged (`22d9f77`). An `information_schema` check confirmed `team_live` is present. The team stays **paused** until the owner switches it on in Control Center.

**Owner, 2026-11-13:** the team had not been introduced to Day Close or the Scoreboard but was already seeing the red "Your plan was due" strip and the Scoreboard card. Hide them, and stop the rules behind them, until he introduces them.

- **The switch.** `day_close_settings.team_live` (boolean, NOT NULL, default **false**) and `live_since` (timestamptz, set when it is turned ON). The existing row becomes **paused** the moment the migration applies. Written only by `changeMembers` action `set_live { live: boolean }` (`POST /api/day-close/members`), an **administrator's** alone (the reviewer seat is not enough). Read from `GET /api/day-close/members` (`live`, `live_since`). Screen: Control Center > Day Close & Scoreboard (`/admin/control-center/day-close`, `DayCloseLiveSetting.tsx`); switching ON asks for a second click and says what starts.
- **Paused means.** Hidden: the Modules strip (`/api/day-close/prompt` answers `none` at once), the red / strike / proof banner on the Today card (`DayCard` shows none unless `live === true`; the task list, "File today's plan" and "Close my day" stay), the Scoreboard card and evening line (`/api/scoreboard/me` answers `paused`), the vote card and the Star Seller card. Stopped: the nightly strikes (`evaluateDay`), the nightly score record (`snapshotDay`), the proof rule (the database trigger reads the switch), and the leave lock (`lockLeaveIfPending`). Not touched: strikes already written, the member list, Team Today, the Monthly Review, the ratings.
- **Fails closed.** `readSettings` treats anything but a stored `true` as paused, and if the switch columns cannot be read (migration not applied yet) it still reads the times and the reviewer and treats the team as paused. So the code can deploy before the migration: everything is hidden and stopped, except that the proof rule (a database trigger) keeps asking for proof until the migration is applied.
- **Counting.** `dayCloseSince` (`rules.ts`): Day Close days count from the LATEST of the day the person was added, the start of the month and the day the switch was last turned on (all as India days), so paused days are neither credit nor blame. While paused nobody is judged on Day Close in any score worked out.
- **Gaps in the record.** While paused no `scoreboard_daily` row is written. After it goes live the missing days can be filled with `GET /api/scoreboard/snapshot?from=&to=` (up to 40 days; task history and punches are exact, Day Close parts only count from the switch-on day).
- **Tests.** `src/lib/dayClose/teamSwitch.test.ts` (15: reads, strip, strikes, leave lock, score / vote / Star Seller cards, the switch, the counting rule), `dayCardTeamSwitch.render.test.tsx`, `leaveLock.test.ts` (fixture now `team_live: true`), `supabase/tests/day_close_team_switch_pglite.mjs` (7 checks: starts paused, proof off while paused, on when live, re-apply keeps the choice, closed to the browser).
- **Trap.** Another open PR (#744) adds a Top 5 switch to the same settings table and the same Scoreboard files; both are independent (different columns), expect a mechanical merge-in for whichever lands second, and the migration ledger lists in `participantAndOrderTotalSecurity.test.ts`.
