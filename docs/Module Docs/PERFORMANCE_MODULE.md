# Performance Module — Rules, Contracts and Open Items

Source of truth for how the Performance and Team Performance screens decide what
counts, what a score means, who is ranked and what is not yet measurable.

Consolidated 2026-08-05 from the working notes kept while the module was built
(2026-07-30 → 2026-08-02). Per-phase narrative, run logs and file-by-file change
tables were **not** carried over — `git log` records those. What is here is the
part that is still true and still needed.

Related: [`PAYROLL_RULES_V1.md`](PAYROLL_RULES_V1.md) (working-day definition),
[`ATTENDANCE_MODULE_PLAN.md`](ATTENDANCE_MODULE_PLAN.md).

---

## 1. Eligible-day rule

A date counts toward an employee's performance average only when **all** hold:

1. On or after the rollout date **2026-06-08** (`PERFORMANCE_ROLLOUT_DATE`).
2. Inside the requested reporting range.
3. Not after today in IST (Asia/Kolkata, fixed UTC+05:30, no DST).
4. Not a weekly off. **BOE runs Monday–Saturday; Sunday is the weekly off, and
   Saturday is a working day.** This is not a local assumption — it matches
   `PAYROLL_RULES_V1.md`, `ATTENDANCE_MODULE_PLAN.md` and
   `buildWorkingDayCalendar` in `lib/payroll/engine.ts`, which excludes
   day-of-week 0 only.
5. Not a company holiday in `payroll_holidays` — the same table the payroll
   engine reads, so both modules agree on what a working day is.
6. Not before `users.joining_date`, where recorded. The joining day counts.
7. Not after the exit boundary, where recorded: `users.exit_date`, falling back
   to the IST date of `users.deleted_at` for a soft-deleted user. The exit day
   counts.
8. If it is today, the end-of-day cutoff (**19:00 IST**,
   `PERFORMANCE_DAY_CUTOFF_HOUR`) has passed.

**A genuine expected working day with no activity still counts as zero.** System
non-use staying visible is the point of the metric.

Two sets are produced deliberately:

| Set | Includes today? | Used for |
| --- | --- | --- |
| `expectedWorkingDates` | yes, all day | the `trend` series — a live provisional score |
| `eligiblePerformanceDates` | only after cutoff | the average |

Both personal and team routes call the same two functions
(`src/lib/performanceCalendar.ts`).

---

## 2. Score model

Four pillars, max 100 points, in `src/lib/performance.ts`:

| Pillar | Range | Composition |
| --- | --- | --- |
| Output | 0 → 50 | High×22 + Medium×15 + Low×8, capped at 50 |
| Momentum | 0 → 20 | status updates ×4 (cap 16) + blocker cleared ×4 (cap 4) |
| Discipline | 0 → 20 | EOD log +12, active today +5, timely acks ×3 (cap 3) |
| Risk | 0 → −40 | overdue ×−5 (cap −25) + stale-blocked ×−8 (cap −16) |

`TOTAL = clamp(Output + Momentum + Discipline + Risk, 0, 100)`.

Risk inputs are reconstructed **per day** (`buildDailyRiskSeries`) rather than
measured once as of now and copied across the window — that copying was what made
historical scores change every time today changed. A regression test asserts the
weights.

### 2a. Overdue responsibility rule

An overdue penalty may apply to an employee only while they still own an
actionable, unfinished obligation. **A task stops accruing overdue
responsibility against the assignee the moment the assignee submits it for
approval** (`pending_approval`), same as `completed`/`cancelled`. Review/
approval delay belongs to the review workflow and must not reduce the
assignee's score. If the creator returns the task, normal task
accountability resumes from that point.

The task is still open operationally while awaiting approval — it keeps
showing as Pending/Approval Pending (`taskStatusLabel`) — it simply cannot
contribute to `overdueCount`, `highPriorityOverdue`, `oldestOverdueDays` or
the Risk deduction while in that state.

Single source of truth: `accruesAssigneeOverdue()` in
`src/lib/tasks/reviewTransitions.ts`, used by the per-day historical
reconstruction (`buildDailyRiskSeries`), Team Performance's current-portfolio
overdue count (`attributableOverdueTasks` in `src/lib/teamPerformance.ts`),
and the My Tasks / dashboard / manager overdue views (`isOverdue` in
`src/lib/ui.ts` and the local predicate in `src/app/tasks/my/page.tsx`) — so
"what My Tasks shows as overdue" and "what Performance scores as overdue"
cannot independently drift out of agreement.

---

## 2a. What Team Performance reports, and what it deliberately does not

**Reported:** period score and previous-period score; score change; eligible
working days; meaningful active days; EOD-only days; tasks completed; on-time and
late completions; on-time completion rate; tasks created (self vs delegated); open
tasks; overdue count; high-priority overdue; oldest overdue in days; stale blocked;
waiting; blocked; acknowledgement on-time rate; EOD submitted / on-time / late /
missed / streak; status updates.

**Operational status** is one of Strong, Performing Well, Improving, Stable,
Inconsistent, Low Activity, Declining, Critical Attention, Insufficient Data — each
with a plain-language reason ("Active on only 9 of 22 eligible working days").
There is deliberately no "Average" label.

**Omitted, and why** — kept so these are not re-proposed without the blocker being
solved first:

| Metric | Why it is not here |
| --- | --- |
| Commitment / planned-vs-done | Nothing records what was *planned* for a day. Would have to be invented. |
| Approved full-day leave | No leave table; `attendance_records.status` cannot express it. |
| Update *quality* | Only update counts exist. Judging text needs a rubric or AI. |
| Role-based creation targets | Task creation is a signal and a ranking only, never "more is better". |
| Login / presence | No login-event table, and login is a poor proxy for work. Meaningful activity is used instead. |
| Manager quality rating | No table, no UI. Later phase. |
| Department expectations | No configuration exists to compare against. |

### Endpoint contract

`GET /api/performance-metrics/team` — admin/manager only, enforced server-side by
`canViewTeamPerformance`. Params: `period=today|this_week|last_week|this_month|
last_month|custom` (default `this_month`) plus `from`/`to` for custom; an invalid,
reversed or oversized range returns 400 via `parseDateRangeParams`, never a 500.

**Query count is fixed at 8 regardless of team size** — caller profile, users, then
six parallel bulk reads, with both periods fetched in one contiguous span so the
previous-period comparison costs no extra round trips. A test guards the query
shape against N+1 regression.

**The client receives computed metrics only and never recomputes a score**, so the
cards, table, rankings and drawer cannot disagree with each other.

---

## 3. Ranking

### Order

`compareOverall(a, b)` in `src/lib/teamPerformance.ts` is the single comparator
behind the Best Performer card, the Overall ranking, the `official_rank` table
sort, the Rank column and the drawer:

1. Period score, highest first
2. Meaningful active-day rate, highest first
3. On-time completion rate, highest first — *only when measurable for both*
4. EOD punctuality rate, highest first — *only when measurable for both*
5. Weighted overdue severity, lowest first
6. Employee name A–Z — stable final tie-break

Weighted overdue severity = `high-priority overdue ×3 + other overdue ×1 +
oldest-overdue-days ×0.5`. Age is halved so one very old task cannot swamp a
genuinely larger backlog. It is a tie-breaker only and never touches the score.

`pickWeakestPerformer()` is **last place in this same ordering**, not a separate
rule, so the person named weakest is always the person at the bottom of the table.

**Raw task count is never a tie-breaker**, at any position — otherwise typing more
tasks would raise your rank.

### Missing values abstain

A step decides only when **both** employees have that measurement; otherwise it is
skipped and the next step is tried (`descIfBothKnown`). Two alternatives were
implemented and rejected:

| Approach | Why it is wrong |
| --- | --- |
| Treat a missing rate as 0% | "Completed no tasks with a due date" and "missed every deadline" become the same claim. Only one is a criticism. |
| Sort missing last | Having no dated tasks then ranks below missing every deadline — straightforwardly false. |

An absent measurement is not evidence against anyone, so it is used as evidence in
neither direction.

### Minimum data

`MIN_SCORED_DAYS_FOR_RANKING = 3` — one constant, one predicate, every consumer.
(`THRESHOLDS.minDaysForVerdict` is an alias of it; they were previously separate
constants that happened to agree, one edit away from a page labelling someone
"Insufficient Data" in the table while naming them Best Performer above it.)

An employee is ranked only when tracking is enabled, `eligibleDays > 0`,
`score !== null` and `scoredDays >= 3`. Below that they are **still shown with
their real figures**, labelled `Insufficient Data` with a reason, and cannot become
Best/Weakest/Most Improved/Most Declined or enter any top or bottom five —
`buildRanking` builds from the rankable pool, so they are absent by construction
rather than filtered afterwards. `unrankedCount` makes the omission visible.

The team average uses the rankable pool too; it previously averaged anyone with a
score, so a single scored day could move the headline number.

The rule is stated verbatim on screen via `MIN_DATA_RULE_TEXT`, so the words and
the constant cannot drift.

---

## 4. Attention severity

One calculation, four consumers: the Needs Immediate Attention card, the owner
briefing, the default table sort and the drawer's concerns list. Before this there
were three orderings, so the card could name one person while the table put
someone else on top.

`attentionFindings(m)` returns every finding, worst first:

| Rank | Category | Trigger |
| --- | --- | --- |
| 1 | `high_priority_overdue` | any high-priority task past due |
| 2 | `long_overdue` | oldest overdue ≥ 7 days |
| 3 | `very_low_activity` | active-day rate < 60% over ≥ 3 eligible days |
| 4 | `repeated_missed_eod` | ≥ 2 EODs missed **and** EOD punctuality < 80%, or ≥ 4 misses regardless of rate |
| 5 | `sharp_decline` | score down ≥ 8 pts vs a comparable previous period |
| 6 | `low_on_time` | < 60% on-time across ≥ 3 dated tasks |
| 7 | `stale_blocked` | ≥ 2 blocked tasks with no update for > 2 days |
| 8 | `low_score` | period score < 40, once there is enough data |

Ranks 9–12 are supplementary and sit below all eight: `overdue_backlog`,
`late_eod`, `eod_without_activity`, `no_status_updates`.

Rank 4 is rate-aware for a reason: a bare `eodMissed >= 2` made two misses in a
month at 92% punctuality read as a discipline problem. Two out of five is; two out
of twenty-six is not.

Between employees: worst category, then larger instance within it, then lower score
(nulls last — "no data" is not "worst"), then name. `recommendedAction` reads the
worst **shared** finding, so the drawer's recommendation is always the action
attached to the finding the briefing is showing. Every finding carries a hard
number; a test fails any whose evidence contains no digit.

**The `inconsistent` classification is checked last** among mid-range outcomes, and
its spread is computed over **active** scored days only. Measuring spread across
idle days meant anyone with one idle day and one good day had a spread equal to
their best day — it labelled most of the team "Inconsistent", including the top
performer, and masked "Strong" / "Improving" / "Declining".

---

## 5. Exclusion model

Employees are excluded from performance tracking **by primary key**, in migration
`20260719000000`, never by name — renaming an account cannot change who is
measured. Each `UPDATE` is guarded by `AND performance_tracking_enabled` so a later
manual re-enable survives a replay, and is a no-op when the id is absent.

Two categories are excluded:

- **Administrative / owner accounts.** Activity is administrative, not measurable
  delivery.
- **Permission-test fixture accounts** (the `… (DUMMY)` users). They have no
  `employee_code`, no `joining_date`, no tasks and no EOD history, and exist only
  so the permission engine's department coverage can be verified. Leaving them in
  would have put permanently-zero "employees" into the team average and made each
  one a "Critical Attention / Not using Task Management" finding, burying the real
  ones.

Every exclusion is reversible per employee at **Attendance → Employees → Performance
Reporting**, which is also where the checkbox and Exclusion Reason live. No new
settings module was added.

**Enforcement is server-side and up front:** `partitionByTracking` runs in
`api/performance-metrics/team/route.ts` *before* the bulk queries, and the tracked
ids scope every subsequent read. An excluded account is never fetched, so it cannot
reach a total, average, rate, ranking, briefing item, EOD figure or adoption figure
by any path. There is no later filter to forget and no frontend filter at all.

`performance_tracking_note` is deliberately **not** returned by
`/api/employee-list` (open to any authenticated user) since it records
management's assessment; it is returned only in the admin-gated coverage payload.
The employee modal therefore sends the note only when actually edited, so saving
the toggle cannot blank a reason the admin never saw.

---

## 6. Attendance integration contract

`src/lib/performanceAttendance.ts` defines the shape of the answer without
building the attendance API. `ATTENDANCE_TREATMENT` fixes the interpretation:

| State | Eligible | Neutral | Expectation | Login timing measured | Attendance concern |
| --- | --- | --- | --- | --- | --- |
| `present` | yes | no | full | yes | no |
| `approved_leave` | no | yes | none | no | no |
| `weekly_off` | no | yes | none | no | no |
| `company_holiday` | no | yes | none | no | no |
| `official_duty` | yes | no | full | **no** | no |
| `half_day` | yes | no | half | yes | no |
| `absent` | yes | no | full | no | **yes** |
| `unknown` | yes | no | full | no | no (marked, not assumed) |

- `unknown` is a required member: a provider with no record for a date must say so
  rather than guessing `present` or `absent`.
- **Official duty** stays eligible but its app-open window is not measured —
  penalising someone at a client site would teach people to stop recording offsite
  work.
- **Absent** counts as the working day it was and is flagged as an *attendance*
  concern. No task score is fabricated in either direction.
- `HALF_DAY_SUPPORT = { declared: true, implemented: false }` — the contract carries
  `expectation: 'half'`, but no scoring path scales a day by it, so **a half day
  currently scores as a full day**. Scaling is a score-formula change.

The provider interface is one bulk call for a whole team over a whole range, never
per employee per day — the latter is how the endpoint once reached 120 queries per
request. `NO_ATTENDANCE_PROVIDER` is wired deliberately rather than left as a null
check, so the absence is a visible, testable value.

The calendar seam is `WorkingDayContext.neutralDates`, a **per-employee** set
(unlike company-wide `holidays`, because leave is per-employee) checked inside
`isExpectedWorkingDay`. Empty today, so behaviour is unchanged; a test proves that
supplying one date removes it from the expected set.

---

## 7. Adoption (System Adoption)

**Adoption does not affect the official score, deliberately**, and is labelled
`System Adoption` throughout. The event only exists from the day its migration
landed, so folding it in would retroactively punish everyone for history that was
never recorded; and "opened the app" is a proxy for engagement, not delivery.
Adding it to the score is a formula decision, not a side effect of building the
metric.

No pre-existing source could answer the question — `auth.users.last_sign_in_at` is
overwritten on every sign-in, there is no login-audit, session or analytics table
anywhere in the schema, and `task_activity_log` cannot host a non-task event
(`task_id` is `NOT NULL` with an FK, and `action` is an enum of 18 task mutations).
EOD submission, first task created and first task activity were all rejected as
proxies.

So `performance_app_opens` (migration `20260720000000`) plus
`POST /api/performance/app-open`:

- **User comes from the bearer token, never the request body.** This is how View As
  is handled: the admin is recorded, never the impersonated employee — otherwise a
  manager could repair a subordinate's record by opening their account each morning.
- IST business date from the **server** clock, never the browser's.
- `ON CONFLICT DO NOTHING` — the first open of the day is the one that means
  something.
- Route-gated to `/dashboard`, `/tasks/**`, `/manager`, `/notifications`.
  `/performance*` is excluded on purpose: checking the metric must not satisfy it.
- **Never blocks a page** — every failure path returns 200 with `recorded: false`.

Start-of-day comes from the per-employee `office_timing`; `SHIFT_START_MINUTES`
matches the existing attendance parser so the two modules agree
(General 10:00 · Factory 09:00 · Sales 10:00 · Half Day 10:00). No company-wide
workday-start setting exists, so `PROVISIONAL_WORKDAY_START_MINUTES = 10:00` and
`ADOPTION_GRACE_MINUTES = 30` are documented provisional defaults; any employee
resolved through the fallback is flagged `provisional` on screen.

Days that pre-date recording are excluded from the denominator (`unrecordedDays`),
not counted as missed opens — so `adoptionRate` renders `—` rather than 0%.

---

## 8. Paged reads — a standing rule

**PostgREST silently caps a read at 1000 rows.** Not an error: no error field, no
warning, and a plausible `data.length`. Because no `ORDER BY` is applied unless
asked, the surviving rows were the *oldest* in the window, so the current month was
missing entirely.

This made every score, rate, ranking and trend on Team Performance wrong while the
page stayed internally consistent and the test suite stayed green — team average
read 8/100 against a true 46/100, and 10 of 10 employees showed zero completions
against a true 612 on-time completions.

**Any read that can exceed ~1000 rows must use `fetchAllRows` from
`src/lib/supabasePaging.ts`.** Every paged query carries `.order('id')`, because
`range()` maps to LIMIT/OFFSET and without a total order rows can be skipped or
duplicated across page boundaries. A paged read that hits the 100,000-row guard
returns a 500 naming the table rather than under-reporting — refusing to answer
beats answering wrongly.

`fetchAllRows` returns a discriminated union whose failure branch has no `rows`, so
a partial read is a type error; unwrap via `unwrapPagedRows`.

The wider lesson, worth keeping: **reconciling against source records found a
defect the tests could not see.** Green tests were not evidence the numbers were
right.

### A loader must exit on failure, not on "data arrived"

Team Performance once froze at 90% for every user. Two independent defects were
both required: a migration that had not been applied (the route selected
`users.exit_date` before the column existed, so PostgREST returned 500), and a
loader effect keyed on *"is data still null"* rather than *"is a request still in
flight"*. On failure `data` stayed `null` forever, the success branch was
unreachable, and the `if (showLoader) return <Loader/>` render guard sat above the
error panel — making the error permanently unreachable in the same component.

**The page would have frozen on any API failure**; the missing column was just the
one that happened to occur. Two standing rules come out of it:

- Key a loader on request state, never on data being non-null, and make sure the
  error branch is reachable from wherever the loader returns early.
- **Apply a migration before deploying code that selects the new column.** The same
  ordering trap recurs across this codebase.

---

## 9. Known limitations

1. **The holiday calendar is empty.** `payroll_holidays` held 0 rows for the entire
   tracked period as of 2026-08-02. Every unrecorded festival or government holiday
   is an ordinary expected working day on which nobody worked, so it scores zero
   company-wide and punishes hardest whoever's period contains the most of them —
   part of what the ranking measures is who had fewer unrecorded holidays. The page
   detects this (`holidayCalendarCoverage`, `calendarConfidence`), shows an amber
   banner and downgrades Best Performer and Team Average to `limited confidence`.
   **Populating Attendance → Holidays from 2026-06-08 onward is the single
   highest-value follow-up.** No holiday record was inserted — that is a
   business-data decision.
2. **Approved leave counts as a working day.** No leave-request or leave-approval
   table exists; `attendance_records.status` is CHECK-constrained to
   `present | checked_in | absent | half_day`, none of which means *approved* leave,
   and `payroll_generation.days_on_leave` is a monthly total that cannot name a
   date. **Leave is never inferred from absence** — inferring it would hand everyone
   a way to delete a bad day by not showing up. The ranking is explicitly not
   described as payroll-ready anywhere.
3. **Scores are reconstructed, not stored.** Every score is recomputed from live
   rows on each request, so editing history changes past scores and a formula change
   silently rewrites all history. **The biggest remaining gap** — see §10.
4. **Half days score as full days** (§6).
5. **Activity is attributed by `actor_id`.** A status change made by someone other
   than the assignee — a manager blocking a task — is invisible to the timeline
   reconstruction. Querying by `task_id` for a whole team needs its own task.
6. **Historical reassignment is not modelled.** Tasks are gathered by *current*
   assignee, so a task reassigned mid-window is attributed wholly to whoever holds
   it now. Nothing in the schema records who held it earlier.
7. **Due-date revisions are only visible inside the fetched window.** A deadline
   changed before the window is not seen; the current value is assumed to have
   applied throughout.
8. **Events before the window are unavailable**, so a task whose last real activity
   fell just before it can look slightly staler than it was.
9. **Deactivation has no timestamp.** An employee who is inactive but never
   soft-deleted and has no `exit_date` gets no boundary — set `exit_date` for these.
10. **Weekly off is company-wide** (Sunday, everyone). No per-employee or
    per-department override exists, but `WorkingDayContext.weeklyOffDays` accepts one
    and is tested, so wiring a config table in later is small.
11. **On a Sunday the team page's "today's score" column shows the last working
    day's score**, since Sunday produces no trend day.
12. **`attendance_records` coverage stopped at 2026-06-30**, so the check-in half of
    the adoption comparison (`ADOPTION_COMPARISON_TARGET`) cannot be wired for the
    current period.
13. **The volatility threshold (25 points) is unvalidated** — a guess, though with
    the ordering fixed it only labels mid-range performers with no clearer story.
14. **Tie-breakers 2–6 are not exercised by production data** — no two employees
    currently share a period score. Covered by unit tests.
15. **`attendance_holidays` is a legacy empty table** referenced by no application
    code. `payroll_holidays` is the single source (written by the admin Holidays
    screen, read by the payroll engine). Worth retiring separately.
16. **`eodStreak` counts submissions rather than punctuality** (pre-existing).

---

## 10. Open items

**Recommended next task: immutable daily performance snapshots with a formula
version.** One table — `performance_daily_snapshots` (user, date, the day's inputs,
the four component scores, total, `formula_version`) — written by a scheduled job
once a day's cutoff has passed, plus a backfill from rollout.

Limitation #3 blocks everything downstream: until a past day's score is frozen, a
manager and an employee can open the same month a week apart and see different
numbers, and any future weight change silently rewrites history. Incentive linkage,
shadow running and longitudinal comparison all depend on history that does not
move. It is also the natural place to record which formula version produced each
score, which is what makes a later pillar-weight redesign safe.

**Do not start the six-component redesign, role profiles or incentive linkage
before snapshots exist.**

Also outstanding:

- **Populate the holiday calendar** (§9.1) — highest value, no code needed.
- **Confirm with a real employee login** that `/performance/team` is refused and the
  employee-config control is unavailable. Both role paths were verified only through
  admin View As, unauthenticated probes and unit tests.
- **Decide whether managers should keep the ability to toggle Performance
  eligibility.** `ALLOWED_ROLES` on the pre-existing `update-employee` endpoint
  admits managers; this was not widened here, but tighten it to admin-only if that
  is not wanted.
