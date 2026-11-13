# 31 - BOE Scoreboard (one monthly score, seen twice a day)

> **Apply-state correction (2026-11-13).** The six migrations `20270622000000`, `20270624000000`, `20270625000000`, `20270626000000`, `20270627000000` and `20270628000000` were **not** in production when their PRs merged. Team Today showed "Something went wrong" and the scoreboard tables were missing (`to_regclass` checks all false). After a `backup-all.mjs` backup, the owner applied all six in order through the SQL Editor on 2026-11-13; a check then showed every table and column present. **Lesson:** after "Migration applied", confirm with a `to_regclass` / `information_schema` query before merging.

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

## 9. The monthly review and awards (`20270627000000`, slice 3)

**Screen.** `/tasks/monthly-review`, an admin sidebar entry. `MonthlyReviewScreen` is for the owner alone; `/api/scoreboard/review` checks the reviewer seat.

**Redesigned 2026-11-13 as guided steps** (the owner's pick from two previews, with Option B's score bars and message preview). One step on screen at a time, and a step bar saying what is done:

| Step | Shows |
|---|---|
| 1. Standings | Score bars coloured by band, the change on last month, votes and sales |
| 2. Awards | One card per award: the suggestion, a winner picker, an optional line, then **Confirm** |
| 3. Freeze & announce | The WhatsApp message previewed live from the picks (`announcement()` in the browser). **Freeze is disabled until every award is confirmed** and still needs a second press. Copy is enabled once frozen |
| 4. Private reviews | One card per flagged person |

- A month that has ended opens on step 2; a frozen one opens on step 3.
- "Confirmed" lives only in the browser: a reload starts from the suggestions again.
- Styles are in `monthlyReview.module.css`.

**What it shows.**
- **Final standings:** each person's last `scoreboard_daily` row of the month (the frozen record), with the change on last month, votes and sales.
- **Suggested awards** (`suggestAwards`, `src/lib/scoreboard/review.ts`). Nobody with under 10 counted working days can win; ties go alphabetically.

  | Award | Rule |
  |---|---|
  | Star Performer | Highest score |
  | Star Seller | Highest approved PIs before GST in the month |
  | Most Improved | Biggest rise on last month's final, ending 55 or more |
  | Team Player | Most votes |
  | Never Late | Present and punctual both full |

  The owner confirms or changes each pick and may add a line.
- **Freeze and announce:** the month must have ended. Awards are written, then `scoreboard_months`. The WhatsApp message comes from `announcement()`, winners only.
- **Private reviews** (`reviewFlags`): the lowest scorer and anybody below 40. The step follows the Red streak over the last 3 months.

  | Red months in a row | Step |
  |---|---|
  | 1 | Private 1:1 and goals |
  | 2 | Written warning |
  | 3 | Role and salary review |

  The owner saves 1–3 goals, a check-in date, whether a warning was given, and a private note. **A low score is never announced.**
- **Everybody's card** (`monthMessages`) shows last month's champions once frozen, and the person's own goals from last month's review.

**Tables** (all closed to the browser):

| Table | Rule |
|---|---|
| `scoreboard_months` | Written once; never changed |
| `scoreboard_awards` | One winner per award except Never Late; nothing added or changed once the month is frozen |
| `scoreboard_reviews` | 1–3 goals; the check-in falls after the month |

**Tests.**
- `review.test.ts`: 9 tests.
- `scoreboard_monthly_review_pglite.mjs`: 5 checks.

**Performance retired** (2026-11-13): the card is gone and the pages redirect. See dossier 13.

## 10. The Star Seller's Super Priority (`20270628000000`, slice 4)

**What it is.** Last month's **announced** Star Seller puts **one of their own open Orders** into Factory Focus, once per award. It stays there until dispatched, or until the owner removes it with a reason.

**Screen.** `StarSellerCard` on `/modules` and the Task dashboard:
- For everybody: the winner and their pick (Order number, their line). Never the client or the value: that is the Factory Focus rule for people who cannot open the Order.
- For the Star Seller, before they pick: a list of their own open Orders and the pick.

**Database.**
- `order_factory_focus_selections` gains `kind` ('owner' | 'star_seller') and `award_month`. A unique index allows one Star Seller pick per award month.
- `scoreboard_star_seller(month)` names the Star Seller of a **frozen** month.
- `order_factory_focus_guard` is restated (its last definition was `20270221000000`) with one added branch. The Star Seller branch requires the announced Star Seller, their own open Order, and the person making the pick to be that seller.
- The owner's 2-a-month limit now counts only `kind = 'owner'`. The owner's own rules are otherwise word for word.
- `kind` and `award_month` can never be rewritten.

**Who writes it.** `/api/scoreboard/star-seller`, on the service role with the actor from the token. The guard checks again whatever the writer.

**Orders module impact.** The pick appears in the existing Factory Focus list on the Orders dashboard, through `orders_dashboard_summary`, which was not changed. It is not labelled "Star Seller" there; the Scoreboard cards carry the name.

**Tests.** `star_seller_focus_pglite.mjs`, 6 checks:
- who may pick;
- one pick per award;
- the owner's limit is unchanged and does not count the Star Seller's pick;
- an ordinary pick is still the owner's alone;
- no rewriting, and removal is owner-only;
- the migration is safe to run again.

The Factory Focus table and its original guard are built from `20270221000000` itself.
