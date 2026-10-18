# 13 - Performance (personal & team)

Verified against checkout `852e0493`. Unverifiable claims are labelled "(unverified, from memory)". Source of truth for rules:
`docs/Module Docs/PERFORMANCE_MODULE.md` (consolidated 2026-08-05); this file re-verifies it against code.

## 1. Purpose & users

Performance turns task activity, EOD (end-of-day) write-ups and system opens into a daily 0-100 score per employee, a personal report, and a management
dataset (Team Performance: rankings, attention briefing, EOD discipline, adoption). It is not payroll-ready and not an incentive system.

| Capability (engine action on module `performance`) | What it opens |
|---|---|
| `view` (label "Personal Performance") | module entry; own score, own month, own daily history, own EOD form + self-rating; writing an EOD |
| `view_team` ("Team Performance", PROTECTED) | `/performance/team`, `/api/performance-metrics/team`, `/api/eod-logs/team`, reading others' EOD |
| `view_all` ("View All Employees", PROTECTED) | every eligible employee instead of the caller's own department |
| Admin | all three by role (`derivePerformanceCapabilities` returns all true for `role==='admin'`) |

Chain: `view_all -> view_team -> view`. A manager is NOT automatically granted anything: `20261110000000` deleted the manager role seed; named people hold overrides.

## 2. Status at commit 852e0493

Shipped: personal page, team page (period presets, previous-period comparison, rankings, attention, EOD, adoption), eligibility flag, app-open recording, IST-aware calendar, paged
reads, Personal/Team capability split. Not shipped (planned): immutable daily snapshots with `formula_version` (recommended next task), six-component redesign, role profiles,
incentive linkage, approved-leave exclusion, per-employee weekly off. `performance_app_opens` appears as "dropped" in the generated inventory only because its migration contains a
`DROP POLICY IF EXISTS` line (false positive); the table is live.

## 3. Pages and API routes

Pages: `/performance` (personal; offers Team View when the SUBJECT has `view_team`), `/performance/team` (own layout gate on top of `ModuleGuard`). Launcher card ALWAYS goes to `/performance`
(personal and team are not alternatives).
API routes:
| Route | Method | Notes |
|---|---|---|
| `/api/performance-metrics` | GET | single-user metrics; `userId` (default caller), `date`, `from`/`to`, `period` (`today|daily|weekly|monthly`); invalid date/period 400; scope via `canReadPerformanceOf` |
| `/api/performance-metrics/team` | GET | one management dataset: `period=today|this_week|last_week|this_month|last_month|custom` (+`from`,`to`); `MAX_RANGE_DAYS = 366` |
| `/api/daily-log` | GET/POST | the EOD (module 11 lists it) - authorization is Performance's |
| `/api/eod-logs/team` | GET | EOD register, `from`/`to`; Team Performance |
| `/api/performance/app-open` | POST | first Task Management open of an IST business day |
| `/api/performance-audit` | POST | coaching text from a `PerformanceData` snapshot: Claude Haiku (`claude-haiku-4-5-20251001`) if `ANTHROPIC_API_KEY` set, otherwise a rule-based engine |
| `/api/performance` | GET/POST | **ORPHAN**: reads/writes table `daily_performance_logs`, which no migration creates (the migration that did was deleted unapplied) and no page calls |

## 4. Database

- `daily_work_logs` (`20260606`): id, user_id (FK users ON DELETE CASCADE), log_date date default current_date, summary (required), highlights, blockers, self_score 1-5, created/updated_at;
  UNIQUE `(user_id, log_date)`; RLS own rows ALL + `admin_manager_read` SELECT for role admin|manager (legacy role-based read policy; the API is the engine-governed path). Intentionally NOT gated by
  `module_entry_open` (every employee writes an EOD).
- `performance_app_opens` (`20260720000000`): user_id, business_date, first_opened_at; unique `(user_id, business_date)`; written `ON CONFLICT DO NOTHING` (`ignoreDuplicates`). Also intentionally ungated.
  Needed because no login/session analytics table exists and `task_activity_log.action` is the enum `activity_action` (18 task-mutation values, task_id NOT NULL).
- `users` columns: `performance_tracking_enabled boolean NOT NULL DEFAULT true`, `performance_tracking_note` (private column, `20260719000000`), `exit_date` (`20260718000000`, nullable, check constraint),
  `joining_date`, `deleted_at`, `office_timing`. Rejected: reusing `payroll_active` ("pays this person" must not be changed by a reporting decision).
- `payroll_holidays` (company holidays; the single source; the legacy `attendance_holidays` table is empty and unused).
- Indexes for the metrics queries: `20260679000000` (`idx_tasks_completed_by_user_date`, `idx_tasks_stale_blocked_by_user`, `idx_tasks_active_by_user`, `idx_tasks_overdue_by_user`).
- Migrations that define the module: `20260718000000`, `20260719000000`, `20260720000000`, `20261109000000` (registers `view_team`, `view_all`), `20261110000000` (removes the manager role seed;
  forward-only correction of the already-applied file, which is never edited), `20261112000000` (data migration: sets `performance_tracking_enabled=false` for one named partner by `users.id`; nothing deleted, reversible).
  Apply-state facts from memory: 20260718-20260720 applied 2026-07-30; `20261109` applied 2026-09-06 before merge.
- Every score is computed on request from live rows. Nothing stores a score (no snapshot table).

## 5. Permissions & access

- `resolvePerformanceAccess(client, token)` (`src/lib/permissions/performance.ts`) = `auth.getUser(token)` + `users` row + `getEffectivePermissions(..., 'performance')`; every Performance route goes through it, so a typed URL gets the screen's answer.
- `canReadPerformanceOf(caller, capabilities, target)`: self -> needs `canAccessPersonalPerformance`; other -> needs `view_team`, and unless `view_all` the target must share the caller's normalized `users.team` (a caller with no team sees nobody else).
  Team endpoint scope is applied to the EMPLOYEE MAP; an EOD entry is built only for an author inside it.
- Layers: `src/app/performance/layout.tsx` = `ModuleGuard('performance')`; `src/app/performance/team/layout.tsx` = `derivePerformanceCapabilities(...).canAccessTeamPerformance`, reading the DISPLAY SUBJECT (it imports `useDisplaySubject`;
  its own header comment still says "signed-in user, never the View As target" - the comment is stale, code follows the 2026-09-06 display-subject decision). The API always checks the real caller.
- Participation vs access (do not conflate): `performance_tracking_enabled` decides whether a person is MEASURED (excluded users disappear from rankings, team average, EOD on-time rate, tracked count, but keep their own personal page with
  `EXCLUDED_SELF_NOTICE`); `performance:view/view_team/view_all` decide what a person may OPEN. Only admins see excluded details (`canViewExcludedDetails`). The toggle is set via `/api/update-employee` (admin-only at this commit).
- Under View As the app-open POST records the real actor (admin), never the impersonated employee.

## 6. Business rules

Score model (`src/lib/performance.ts`, `computeBreakdown`), max 100:
| Pillar | Range | Formula |
|---|---|---|
| Output | 0..50 | completedHigh x22 + completedMedium x15 + completedLow x8, cap 50 |
| Momentum | 0..20 | min(16, statusUpdates x4) + min(4, blockerResolutions x4) |
| Discipline | 0..20 | EOD log +12, active today +5, min(3, timelyAcks x3) |
| Risk | 0..-41 as coded | -(min(25, overdueCount x5) + min(16, staleBlockedCount x8)) |
`total = clamp(output + momentum + discipline + risk, 0, 100)`. (Doc text says risk 0 -> -40; the caps in code sum to 41.) `STALE_BLOCKED_DAYS = 2`. Ratings (`scoreRating`): >=75 excellent, >=58 good, >=38 average, >=20 needs_improvement,
else critical. Trend (`analyzeTrend`): needs >= 3 days else `insufficient_data`; volatile if stddev > 20; improving if second-half minus first-half average > 8 and last day up; declining if < -8 and last down;
consistent if stddev < 8 and average >= 50; else stagnant; direction by |halfDelta| > 3; week-over-week over 14+ days.
Overdue responsibility: `accruesAssigneeOverdue(status)` is false for completed, cancelled, `pending_approval` (module 11) - review delay never lowers the assignee's score. Risk inputs are reconstructed PER DAY (`buildDailyRiskSeries`) from task rows and the activity log, including historical due dates from `due_date_changed` old/new values.

Calendar (`src/lib/performanceCalendar.ts`, `src/lib/istDate.ts`): business dates are Asia/Kolkata. `PERFORMANCE_ROLLOUT_DATE = '2026-06-08'` (no earlier data). Eligible day = not a Sunday (`DEFAULT_WEEKLY_OFF_DAYS = {0}`; **Saturday is a working day**),
not a `payroll_holidays` date, on/after `joining_date`, before `exit_date`/`deleted_at`. `PERFORMANCE_DAY_CUTOFF_HOUR = 19`: today is provisional until 19:00 IST. `APPROVED_LEAVE_UNAVAILABLE = true` (no leave table; leave is never inferred from absence).
Period averages run over every eligible date (idle eligible days count as 0) - one definition shared by personal and team (`periodAverageScore`).

Team rules (`src/lib/teamPerformance.ts`, 1795 lines; `THRESHOLDS`): strongScore 70, goodScore 58, weakScore 40, criticalScore 30, movement 8, volatility 25, lowActivityRate 60 (% eligible days active), overdueConcern 3, staleConcern 2, eodMissConcern 2,
eodHealthyRate 80, eodMissAlways 4, lowOnTimeRate 60. **`MIN_SCORED_DAYS_FOR_RANKING = 3`** is the single minimum-data rule (insufficient-data employees are exactly those excluded from every ranking; "Today" period therefore ranks nobody).
`EOD_ONTIME_HOUR = 21` (IST). Tie-breakers (`OVERALL_TIE_BREAKERS`): period score desc; meaningful active-day rate desc; on-time completion rate desc (skipped when either side has no dated tasks); EOD punctuality desc (skipped when either side had none expected);
weighted overdue severity asc (high x3, other x1, oldest-overdue days x0.5); name A-Z. Missing values ABSTAIN, never rank as 0. Score spread is measured over ACTIVE days and checked last among mid-range outcomes. One attention-severity model
(`attentionFindings`/`sortBySeverity`) feeds the card, briefing, default sort and drawer. Adoption (opening the app) is NEVER part of the score. `MEANINGFUL_ACTIONS` define "active". Team average uses the rankable pool only.
Adoption (`performanceAdoption.ts`): shift starts General 10:00, Factory 09:00, Sales 10:00, Half Day 10:00; fallback 10:00 flagged `provisional`; `ADOPTION_GRACE_MINUTES = 30`.
Holiday coverage: when `payroll_holidays` has no rows in the period, an amber banner shows and Best Performer / Team Average downgrade to "limited confidence" (`holidayCalendarCoverage`, `calendarConfidence`).
EOD: unique per user/day; summary required; `self_score` 1-5; date defaults to `istToday()` (UTC dates once filed pre-05:30 IST EODs against the previous day).
Query budget: the team endpoint was fixed at 8 queries per period (14 once paged); `teamPerformanceQueries.test.ts` fails if any query/await appears inside the per-employee loop.

## 7. Key components & lib files

`src/lib/{performance,performanceCalendar,performanceAttendance,performanceEligibility,performanceAdoption,performanceLoadState,teamPerformance,istDate,supabasePaging,perf}.ts`,
`src/lib/permissions/performance.ts`, `src/app/performance/{layout.tsx,page.tsx,team/layout.tsx,team/page.tsx}`, `src/app/api/{performance-metrics,performance-metrics/team,performance,performance/app-open,performance-audit,daily-log,eod-logs/team}/route.ts`,
`src/hooks/useRecordAppOpen.ts` (called from `DashboardLayout`; once per page-load session, only on Task Management pages), `src/components/layout/PerformanceLayout.tsx`, `src/lib/types.ts` (ScoreBreakdown, DayInputs, TrendDay).

## 8. Decisions made & why

- Score reconstructed live, not stored: simplicity first; known weakness (history moves) is the recommended next task.
- Saturday is a working day; Sunday only weekly off (PAYROLL_RULES_V1 and `lib/payroll/engine.ts`).
- Approved leave not inferred from absence (it would let anyone erase a bad day by not showing up).
- A tolerant fallback for a missing migration column was rejected: it would silently put excluded accounts back in rankings; a loud failure is preferred.
- Personal vs Team are separate grantable capabilities; Manager role does not replace Personal Performance; team visibility is granted, never inherited from a role name.
- Excluded population (owner decision 2026-07-30): admin account(s), test fixtures ("(DUMMY)" accounts) and later one partner (`20261112000000`), by UUID, never by name; 11 measured then 10 tracked after one inactive user (counts from memory).
- Adoption is reported separately and never scored.
- "Insufficient Data" is a classification, not a low score.

## 9. Known traps / gotchas / unfixed defects

1. **PostgREST silently caps responses at 1000 rows** (no error, plausible `data.length`; without ORDER BY the survivors are the oldest). Any read that can exceed ~1000 rows MUST use `fetchAllRows` (`src/lib/supabasePaging.ts`, orders by `id`, retries once on transient messages only).
   Offset paging is not a snapshot (an insert between pages can skip a row). This once made the team page show 0 completions for everyone.
2. Do not `SELECT completed_at` in the team route (PostgREST schema-cache 400, from memory); completion timing comes from `task_activity_log` `to_status='completed'`.
3. The orphan `/api/performance` route refers to a table that no migration creates.
4. `payroll_holidays` was EMPTY for the whole tracked period at last check (2026-08, from memory): every unrecorded holiday scores 0 company-wide. Populating Attendance -> Holidays from 2026-06-08 is the highest-value no-code follow-up.
5. `attendance_records` coverage stopped at 2026-06-30 at last check (from memory), so the attendance half of the adoption comparison cannot be wired.
6. Half days score as full days; leave counts as a working day; reassignment is attributed to the CURRENT assignee; activity is attributed by `actor_id` (a manager blocking someone's task is invisible); events before the window are unavailable;
   deactivation has no timestamp (set `exit_date`); on Sundays the team page's "today's score" shows the last working day; volatility threshold 25 is unvalidated; `eodStreak` counts submissions not punctuality.
7. Risk cap arithmetic: caps are 25 + 16 = 41 but docs say -40; the total clamp at 0 hides the difference only when positives are high.
8. The 4-pillar weights are pinned by a regression test; changing a weight silently rewrites all history because nothing is frozen.
9. Team layout comment contradicts its code about View As (code uses the display subject).
10. `daily_work_logs` still has the legacy role-based `admin_manager_read` policy; EOD read APIs use the engine, but direct table reads follow the policy.
11. Two namings: module key `performance`, UI "Performance Management" on the launcher; Control Center labels `view` as "Personal Performance" through `MODULE_SCOPED_ACTION_LABELS`.
12. Adding the `view_team`/`view_all` actions broke four pinned tests beyond ledgers (`levels`, `protectedVisibility`, `enforcement`, a customer-review card-inserter ledger) - read what each ledger asserts first.
13. Do not give live-DB tests `.env.local`: the only configured project is production; the performance team test paths read real rows (reconcile numbers against raw counts, not only fixtures).

## 10. Tests that guard it

`src/lib/performance*.test.ts` (`performanceCalendar`, `performanceEligibility`, `performanceLoadState`, `performanceModuleShell`, `performanceRisk`), `src/lib/teamPerformance.test.ts`, `teamPerformanceQueries.test.ts`, `istDate.test.ts`,
`src/lib/supabasePaging.test.ts`, `src/lib/permissions/{performance,performanceAccessEnforcement,performanceAccessParallel}.test.ts`, `src/lib/perf.test.ts`. Run `npx tsx --test src/lib/performance*.test.ts src/lib/teamPerformance*.test.ts src/lib/permissions/performance*.test.ts`.
Reconciling the page against raw DB counts is the only check that catches the 1000-row class of defect.

## 11. Open items / next planned work

- Immutable `performance_daily_snapshots` with `formula_version`, written after each day's cutoff + backfill from rollout. Do not start the six-component redesign, role profiles or incentive linkage before it exists.
- Populate the holiday calendar; wire attendance coverage; decide whether `update-employee` should stay admin-only (it is, at this commit).
- Confirm with a real employee login that `/performance/team` is refused (verified so far only through admin View As, unauthenticated probes and unit tests).
- Decide the fate of `/api/performance` (delete) and retire `attendance_holidays`.

## 12. Recheck before changing this module

Read: `docs/Module Docs/PERFORMANCE_MODULE.md`, `src/lib/performance.ts`, `performanceCalendar.ts`, `teamPerformance.ts` (THRESHOLDS, ranking), `src/lib/permissions/performance.ts`, `src/lib/supabasePaging.ts`, the two route files, `20261109000000`, `20261110000000`.
Queries (read-only): `select performance_tracking_enabled,count(*) from users where is_active group by 1;`, `select count(*) from payroll_holidays where holiday_date >= '2026-06-08';`, `select count(*) from daily_work_logs;`,
`select * from role_permissions rp join permission_modules m on m.id=rp.module_id where m.module_key='performance';` (expect only admin rows). Run the test commands in section 10 plus `tsc`/lint; reconcile one tracked employee's numbers against raw `tasks`/`task_activity_log` counts.
