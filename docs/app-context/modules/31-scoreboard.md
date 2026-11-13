# 31 - BOE Scoreboard (one monthly score, seen twice a day)

Built 2026-11-12 on branch `claude/boe1-employee-monitoring-t5ypei`. Migration `20270625000000_scoreboard.sql` was **APPLIED 2026-11-12 by the owner, before the merge** (PR #724; owner's word, not re-checked from the cloud session).

The plan (with the owner's decisions) is the artifact "BOE Scoreboard: one score, seen daily, rewarded monthly". The code is the truth.

## 1. Purpose & users

The owner's ask (2026-11-12): the Performance module "is of no use… except numbers". He wants people to see their progress and their drops every day, with recognition for the best and a private discussion with the lowest each month. It should cover sales and non-sales staff, and attendance, punctuality, discipline, loyalty and teamwork.

**There is no separate module.** The score shows twice a day, where people already are:
- **Morning:** the Scoreboard card on `/modules`, under the punch and Day strips, and at the top of the Task Management dashboard.
- **Evening:** the line under "Day closed" on the Today card.

| Who | What they see / do |
|---|---|
| A scored person: active, `performance_tracking_enabled`, not an administrator | Their score out of 100, band, change since yesterday, the month's line, where the points come from, the one fastest way up, and the **top 5 (names only; nobody sees a rank)** |
| Administrators | Everything above, and **Scoreboard targets** on Team Today (`/tasks/team-today`): track and targets per person, per month |

## 2. Owner decisions (2026-11-12)

- **Weights:**

  | Part | Points |
  |---|---|
  | Results | 40 |
  | Attendance | 20 |
  | Discipline | 20 |
  | Team vote | 10 |
  | Owner rating | 5 |
  | Loyalty | 5 |

- Top 5 only.
- Targets are set by the owner on the 1st.
- The Star Seller's Super Priority: 1 of their own orders in Factory Focus until dispatched.
- Prizes: Shield, Wall of Fame, Saturday early leave, annual dinner.
- **November is the trial month, December is live.**

## 3. The score (`src/lib/scoreboard/score.ts`, pure)

**Points earned out of points possible, month-to-date.** A part with nothing to judge yet is left out of both, so the 5th and the 25th mean the same. Examples: no task due, no target set, not switched on for Day Close, no vote yet.

| Part | Max | Rule |
|---|---|---|
| tasks_on_time (general) | 30 | Tasks due this month: handed in (first `status_changed` to pending_approval or completed) by the end of the due date (IST). Weighted high 3, medium 2, low 1. A task due today counts only once handed in, or once the day is over |
| role_target (general) | 10 | Actual ÷ (target × share of working days gone). Counts tasks handed in this month (`tasks_done`) or vendor site visits (`vendor_visits`) |
| sales_value (sales) | 25 | Approved PIs (`order_submissions.status = approved`, `approved_at` this month, by `salesperson_id`), `total_before_gst`, ÷ the paced target |
| lead_work (sales) | 15 | Leads allotted this month (`sales_leads.assigned_at`) whose `first_attempt_at` is the same IST day. If given after 17:30, the next working day |
| present | 10 | Days with a machine punch ÷ working days. Approved full-day leave days and holidays leave the count; today counts once punched |
| punctual | 10 | First punch by the payroll grace end (`grace_end_minutes`) ÷ present days |
| plan_on_time | 7.5 | Day Close days since switched on, minus `no_plan`/`plan_late` strikes not waived |
| closed_before_leaving | 7.5 | The same, for `day_not_closed`/`closed_after_leaving` |
| informed_leave | 5 | Requests this month asked before the shift (`informed_before_shift`); full marks with no request |
| team_vote | 10 | 8 × min(1, votes received ÷ 3) + 2 for casting your own three. Counted only in the month's final record: its last day, once over |
| owner_rating | 5 | The owner's 1–5 is worth its number of points, counted from when it is given. Its reason is shown to the person |
| loyalty | 5 | Completed years since `joining_date`, up to 5 |

- **Track:** from `scoreboard_targets.track`, defaulting to general. Sales staff need their track set on the 1st, otherwise they are scored on tasks.
- **Score:** none below 20 points possible.
- **Bands:**

  | Band | Score |
  |---|---|
  | Star | 85+ |
  | Strong | 70+ |
  | Steady | 55+ |
  | Watch | 40+ |
  | Red zone | below 40 |

- **Fastest tip:** the part losing the most points.

## 4. Database (`20270625000000`)

| Table | What it holds |
|---|---|
| `scoreboard_targets` | Primary key (month, employee): track, sales_target (₹), role_target + role_kind + role_label |
| `scoreboard_daily` | Primary key (employee, score_date): month, track, score, earned, possible, parts jsonb. The trigger `scoreboard_daily_no_change` refuses UPDATE and DELETE: **a day is written once and never changes** |

Both tables are closed to the browser.

**Rollback:** in the migration header.

## 5. Routes

| Route | Who | What |
|---|---|---|
| `GET /api/scoreboard/me` | Any signed-in person | Their live score (`scoreEveryone(today, dayComplete=false)`), the change against their last `scoreboard_daily` row, the trend, the top 5 and Most Improved. Most Improved is the biggest rise since the month's first record, after at least 3 recorded days |
| `GET/POST /api/scoreboard/targets` | Admin | The month's tracks and targets |
| `GET /api/scoreboard/snapshot` | Vercel cron `0 18 * * *` (23:30 IST, after Day Close's 23:15), `CRON_SECRET` | Writes the day. `?date=` for one day; `?from=&to=` for up to 40 days (filling November once). Skips days already written |

`scoreEveryone` reads the whole team in a fixed number of batched reads. Punches, tasks and task history are paged through `fetchAllRows`. Sales, leads and vendor visits that fail to read leave their part out, never scored as zero.

## 6. Traps

1. Apply `20270625000000` before merging. Without it, `/api/scoreboard/me` returns 500 and the card draws nothing; the rest of the page is unaffected.
2. **Backfill uses today's targets and today's view of past records.** Task history and punches are exact. Strikes exist only from when Day Close was switched on. Run the November backfill **after** setting November's targets.
3. A sales person without `track = sales` for the month is scored on tasks.
4. The vote counts only in the month's final record. Before that, the score is out of the parts that count; a rating counts as soon as it is given.
5. Not yet built from the plan:
   - the monthly review screen (freeze, awards, 1:1 goals);
   - the Star Seller's Factory Focus slot;
   - retiring the old Performance pages and launcher card (a data change, the owner's call).

## 7. Tests

| Test | Checks |
|---|---|
| `src/lib/scoreboard/score.test.ts` | 14 tests on real-looking November weeks: every part, pacing, leave fairness, the day in progress, bands, tips |
| `supabase/tests/scoreboard_pglite.mjs` | 4 checks: closed tables, target rules, the frozen day, safe re-run |
| The server's assembly (`scoreEveryone`) | **Not exercised by a test.** Its PostgREST filters (`or` with `in`) are beyond MemorySupabase. Check it against real rows once live |

## 8. The team vote and the owner's rating (`20270626000000`, slice 2)

**When.**
- The vote is open for the **last 3 days of the month**: 28–30 November.
- Ratings open from the **25th**.
- Both close at **23:00 IST on the last day**, before the 23:30 final record. Pure rules: `src/lib/scoreboard/vote.ts`.

**The vote.**
- Each scored person gives 3 votes to 3 different colleagues, with an optional line on how they helped.
- Never yourself; cast once.
- The `VoteCard` on `/modules` and the Task dashboard shows only while the vote is open.
- **Secret:** no route returns who voted for whom. A voter sees only their own; the owner sees totals and the anonymous lines, only after the vote closes.

**The rating.**
- The owner (`day_close_settings.reviewer_id`) gives 1–5 and one line of reason for each person.
- It can be changed until the close.
- `RatingsEditor` on Team Today, shown to the reviewer only.

**Tables** (both closed to the browser):

| Table | What it holds |
|---|---|
| `scoreboard_votes` | Primary key (month, voter, nominee). Not self. A trigger allows at most 3 per voter per month, and no UPDATE or DELETE |
| `scoreboard_ratings` | Primary key (month, employee). Rating 1–5, reason 3–300 characters |

**Routes.**
- `GET/POST /api/scoreboard/vote`
- `GET/POST /api/scoreboard/ratings`: reviewer only.

**Tests.**
- `vote.test.ts`: windows, including midnight on the 1st, and validation.
- `score.test.ts`: the vote and rating parts.
- `scoreboard_vote_rating_pglite.mjs`: 5 checks.
