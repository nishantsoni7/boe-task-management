# 03 - Attendance

Verified against checkout `852e0493` (origin/main, 2026-10-18). "Shipped" means the code is on this checkout. Database apply-state cannot be read from a checkout; where it matters it is labelled "(unverified, from memory)". Part of the combined "Attendance & Payroll" product (see also 04 Minop, 05 Payroll, 06 BOE Credits, 07 Employee Records/Issues).

## 1. Purpose & users

- Attendance is the INPUT of payroll: daily punch pairs per employee per IST date, from the new machine from 2026-11-01 (see 04) and from the old machine's Excel export before that, corrected by admins, reviewed monthly, and consumed by the payroll engine.
- One product to the user ("Attendance & Payroll" launcher card), two code domains: `/attendance/*` + `/api/attendance*` and `/payroll/*` + `/api/payroll*`.
- Roles:
  - **Admin** (`users.role = 'admin'`): everything under `/attendance/*` (management surface, whole company).
  - **Any signed-in active employee**: `/my-attendance` (own record only), send own attendance requests, raise issues (see 07).
  - **Manager role: NO access** (removed 2026-08-03 by `20260812000000`; one manager account exists). Revert would be re-adding `'manager'` to `ALLOWED_ROLES` in import/preview.
  - Control Center "Custom"/department visibility can NEVER widen management access (see section 5).

## 2. Status at commit 852e0493

| Capability | Status |
|---|---|
| Fingerprint Excel preview + import (two formats, manual employee mapping) | Shipped |
| Attendance records list, per-employee detail, Employee Master | Shipped |
| Day corrections overlay (`attendance_day_corrections`) | Shipped (UI lives on the payroll result page) |
| Correction log (import diff audit) `/attendance/correction-log` | Shipped |
| Holiday Management incl. half-day holidays | Shipped |
| Monthly Attendance Review + month coverage logic | Shipped |
| Attendance Requests (employee request -> another admin decides) | Shipped in code (#239, #264, #266, #267). Migrations in repo; prod apply-state unverified (see section 4) |
| Monthly "Salary decisions" review (day reviews -> payroll correction) | Shipped in code, same migration |
| Manual check-in / check-out | REMOVED: both routes return HTTP 410 ("use the attendance CSV import") |
| Minop device feed | The attendance source from 2026-11-01 (see 04). Writes `attendance_records` with `source = 'minop'`; the engine reads them like any other row |
| Leave types, balances, per-employee shifts, mid-day punch collection, admin editing of a request | NOT BUILT (stated in ATTENDANCE_REQUESTS.md section 10). `ATTENDANCE_MODULE_PLAN.md` is a "Planning only" document: its leave_requests / salary-concern tables do not exist |

## 3. Pages and API routes

### Pages (admin, behind `AttendanceGuard` in `src/app/attendance/layout.tsx`)
`/attendance` (Overview: the month's attendance score, Doing great, Needs attention, everyone's month as day blocks, a line about today, and links to every page; month in `?year=&month=`), `/attendance/employees` + `/attendance/employees/[id]` (Employee Master), `/attendance/today` (04), `/attendance/upload`, `/attendance/records`, `/attendance/monthly-review` + `/[userId]` (supports `?view=decisions` = Salary decisions), `/attendance/requests` (request queue only), `/attendance/holidays`, `/attendance/correction-log`, `/attendance/notifications`, `/attendance/minop`, `/attendance/minop/incoming` (04).
- `next.config.ts` 307-redirects `/attendance/requests?tab=review` to `/attendance/monthly-review?view=decisions`.
- Admin sidebar = six sections (`src/components/layout/attendancePayrollNav.tsx`): Overview, Employees, Attendance (tabs Today/Records/Upload/Monthly Review/Requests; the sidebar lands on Today), Payroll (tabs Monthly Preview/Payroll Runs/BOE Credits + help How Payroll Works), Issues (Attendance Sync/Incoming Minop data), Settings (Payroll Rules/Holidays).
### Pages (employee)
`/my-attendance` (own month view; auto-refresh every 45 s ONLY when the current IST month is open; Refresh button; Raise Issue per day; own requests panel), `/my-issues`, `/my-issues/notifications`. There is NO `/my-attendance/request` route on this checkout (ATTENDANCE_PAYROLL_MODULE.md still mentions it; the request form is the modal `AttendanceRequestFlow`, opened from Modules quick action, desktop sidebar quick action, and My Attendance).

### API routes (auth in brackets)
| Route | Verbs | Auth |
|---|---|---|
| `/api/attendance/preview` | POST | admin only (inline check, `ALLOWED_ROLES=['admin']`) |
| `/api/attendance/import` | POST | admin only; blocks when the month's payroll is locked |
| `/api/attendance/records` | GET | `requireSelfOrAdmin` |
| `/api/attendance/employee-records` | GET | `requireSelfOrAdmin` (paged read of ALL rows) |
| `/api/attendance/employee-monthly-detail` | GET | `requireSelfOrAdmin` (also returns the month's requests) |
| `/api/attendance/monthly-summary`, `/dashboard`, `/correction-log` | GET | `requireAdmin` |
| `/api/attendance/overview` | GET | `requireAdmin` (optional `year` + `month`; without them, the newest month with enough days to rank) |
| `/api/attendance/holidays` | GET/POST/DELETE | own inline admin check (no edit verb) |
| `/api/attendance/check-in`, `/check-out` | POST | none; static 410 |
| `/api/attendance/minop-deliveries`, `/minop-incoming*` | GET | `requireAdmin` (04) |
| `/api/attendance/machine-day`, `/machine-status` | GET | `requireAdmin` (04) |
| `/api/attendance/machine-alert` | GET | Vercel Cron, `CRON_SECRET` (04) |
| `/api/attendance-requests` | GET/POST | `resolveCaller`; employee own, admin `?scope=queue` |
| `/api/attendance-requests/[id]/decision` | POST | admin, never own request |
| `/api/attendance-requests/[id]/cancel`, `/[id]/history` | POST / GET | owner or admin |
| `/api/attendance-requests/reconciliation` | GET/POST | admin (month review; POST saves a decision) |

Shared helper: `src/lib/security/attendancePayrollApiAuth.ts` (`resolveCaller`, `requireAdmin`, `requireSelfOrAdmin`). Every one of these routes runs on the SERVICE ROLE, so the route is the whole boundary. Responses are flat 401/403 with no detail (must not reveal whether a colleague exists).

## 4. Database

### Tables
| Table | Defined in | Notes |
|---|---|---|
| `attendance_records` | `20260609_create_attendance_records.sql` | `UNIQUE(user_id, attendance_date)`; `check_in_at`/`check_out_at` nullable timestamptz; `status` CHECK relaxed to present/checked_in/absent/half_day in `20260635`; `+punch_direction_source` (`20260827000000`, 'confirmed'/'inferred'/NULL); `+source` (`20261115000000`, NULL or 'minop'). RLS: own-row SELECT; all writes service role. This is the RAW machine layer; the import UPDATES rows in place |
| `attendance_day_corrections` | `20260807000000` (+ `20260808000000` remark whitespace fix, `20260809000000` adjustment repair) | Versioned overlay: partial unique index `(user_id, attendance_date) WHERE is_current`; `day_treatment` auto/full_day/half_day/absent; `waive_late_arrival/early_checkout/missing_punch`; mandatory `remark` (CHECK `btrim<>''` then tightened to reject tabs/newlines); before/after audit snapshot columns; `payroll_period_id` FK; supersede chain. SELECT: admin all, employee own. No write policies |
| `attendance_correction_log` | `20260651_create_attendance_correction_log.sql` | One row per corrected employee-date per IMPORT; written ONLY when punch times actually moved (a provenance-only rewrite is not logged). Read: admin only since `20260812000000` (manager removed) |
| `payroll_holidays` | `20260613_create_payroll_holidays.sql` + `20261105000000_holiday_half_day.sql` | `holiday_date` UNIQUE, `description`; `+holiday_type` ('full_day' default / 'half_day'), `+half_session` ('first_half'/'second_half'); CHECK `payroll_holidays_half_session_matches_type`. SELECT policy `USING (true)` for authenticated |
| `attendance_requests` | `20270215000000_attendance_requests.sql` | 5 types, 4 statuses, shape CHECKs per type, rejection needs note, "other" needs note; `submitted_at`/`shift_start_at`/`informed_before_shift` server-set; `replaces_request_id` unique (replaced once); guard + audit triggers |
| `attendance_request_events` | same | Append-only audit written by trigger |
| `attendance_day_reviews` | same | Versioned (`is_current`) excuse + pay decision per `event_key` (`late_arrival|early_departure|missing_punch|absent|request:<uuid>`); `pay_decision` paid_waived/unpaid_actual/needs_correction; `applied_correction_id`; `attendance_fingerprint`. Admin-only RLS |
| `payroll_lock_attendance_acknowledgements` | same | Append-only record of locks made past open items; admin read |
| Live-uniqueness backstop | `20270222000000_attendance_request_live_uniqueness.sql` | 5 partial unique indexes (pending/approved) per type |

### Key functions / triggers
- `set_updated_at()` trigger on `attendance_records`.
- `attendance_requests_guard()` (transition rules: pending -> approved/rejected/cancelled; approved -> rejected/cancelled; rejected -> approved; cancelled terminal), `attendance_requests_audit()`, `attendance_request_events_guard()`, `attendance_day_reviews_supersede()/_guard()`.
- `lock_payroll_period_with_attendance_ack()` SECURITY DEFINER, service role only, `search_path = public, pg_temp`: locks period + writes the acknowledgement in one transaction.
- Notification enum values: `attendance_request_submitted`, `attendance_request_decided` (`20270215000100`); issue values from `20260824000000`/`20260825000000` (07).

### Storage buckets: none.

### Apply-state / immutability
- Applied to prod (from memory, unverified here): 20260807/08/09 (2026-08-03), 20260812 (2026-08-03, via `db query -f` + `migration repair`), 20260827 (2026-08-10, BEFORE the app merge), 20261105 (2026-09-04).
- `20270215000000`, `20270215000100`, `20270222000000`: the merge commit titles say "migrations not applied" / "unapplied migration" (#239, #267). Prod apply-state: UNVERIFIED. Required order if not yet applied: 20270215000000 -> 20270215000100 -> deploy code. Code deployed first makes every payroll lock answer 503 `attendance_review_unavailable` and the whole notification feed 500 (22P02 enum).
- Applied migrations are immutable; fix forward (e.g. `20260809000000` repaired columns that migration `20260636` had recorded but never created).
- A non-empty `remote` column in `supabase migration list` is NOT proof the DDL ran; probe the actual columns.

## 5. Permissions & access

- No module-permission key: management = `users.role = 'admin'`. `SELF_SERVICE_MODULE_KEYS = {attendance, payroll}` in `src/lib/moduleAccess.ts`; `resolveManagementAccess()` returns `profile.role === 'admin'` for these keys and still honours `app_modules.visibility_type = 'hidden'` (closes it for everyone including admins).
- `app_modules` rows `attendance` and `payroll` stay two rows; their visibility/custom list governs only the SELF-SERVICE surface (does an employee see the card). They never grant management.
- `AttendanceGuard`: non-allowed users are sent to `/my-attendance` (or `/coming-soon` if no profile).
- Employee requests: any signed-in active employee; not a module permission; off while previewing with View As (writes are disabled while previewing, see View As in memory). Since 2026-10-27 the Modules "Attendance request" quick action is also hidden for anyone with `users.payroll_active = false` (switched out of Attendance & Payroll); the route itself is unchanged.
- Admins can also decide pending requests from the Modules launcher's "Pending approvals" card (module 08), which uses the same queue route, review panel and decision route.
- An admin can never decide their own request or review their own attendance (`selfDecisionRefusal`); with a single admin this limitation is by design and named in the error.
- RLS is the second wall: own-row SELECT on records/corrections/requests; admin on logs and reviews; no client write policies anywhere. No client component reads `attendance_*` directly (all via service-role API).
- `users.fingerprint_employee_code` (and `employee_code`, `joining_date`, `office_timing`, `payroll_active`, `employment_type`) are on the public-readable column list; `monthly_salary`, `payroll_notes`, `performance_tracking_note` are column-privilege-protected (`20260813000000`; `src/lib/users/safeColumns.ts`). Never `select('*')` on `users` (42501).

## 6. Business rules (exact)

### Day classification (`src/lib/attendance/classification.ts`, constants `scheduleRules.ts`, settings `payroll/settings.ts`)
- Schedule (IST): in 10:00 (600 min), grace ends 10:15 (615), out 18:30 (1110), full day 8.5 h, lunch window 13:00-14:00 with up to 1 h removed (ACTUAL overlap, not a flat hour), weekly off Sunday.
- No record or both punches null -> `full_absent`. Out <= in -> `full_absent` (corrupt). Exactly one punch -> `missing_punch` (`missing_punch_in` / `missing_punch_out`).
- Effective hours >= 7.5 (or in by 10:15 AND out >= 18:30, "office timing") -> `full_present`; >= 5 -> `present_with_shortfall`; >= 2 -> `half_day`; < 2 -> `full_absent`.
- `threshold_half_day_hours` (3.75) is INERT: since PR #13 the whole band 2-5 h is one half day (non-monotonic cost was the defect). It still exists in settings and in every period snapshot. Owner decision open (see 05).
- Late arrival / early departure deductions apply only to `full_present`/`present_with_shortfall` and not under office-timing. Rounding: minutes beyond schedule, 0-15 free, then round UP to next 30-minute block at 0.5 h per block (`roundDeductionHours(45)` = 1 h). Missing punch = flat 2 h.
- Late arrival stacks on a missing punch-out ONLY when `direction_source = 'confirmed'`.

### Import / punch parsing (`src/lib/attendance/punchParser.ts`, shared by preview + import)
- Format A (separate IN/OUT rows; direction stated -> `confirmed`) and Format B ("List of Logs"-style horizontal layout, all punches of a day in one cell). Multiple punches: first and last are the pair. One unmarked punch: before 14:00 IST = arrival, at/after 14:00 = departure, stored `inferred` (`TEMP_SINGLE_PUNCH_DIVIDER_MINUTES = 14*60`; business decision, not a midpoint). NULL provenance resolves to `inferred`, never `confirmed`.
- Third-party monthly-workbook tolerances: code column header `No.`/`Emp Code`/`Employee Code` (case-insensitive, only when col 1 is `Name`); data rows start at header+1; cells split on `/[\s,;|/]+/`; numeric Excel time cells read from `cell.w`.
- Manual employee mapping (`src/lib/attendance/employeeMapping.ts`, form field `manualMappings` JSON `[{excel_code,user_id}]`) is used by BOTH preview and import. Refused with 400: code not in file, overriding an auto-matched code, unknown user, duplicate code, two codes -> one employee. Picked employee must be live; the fingerprint map is deliberately NOT restricted to live users (departed staff history must import).
- Import writes rows only for days with a punch (`--:--` skipped). Existing-row read is PAGED (PostgREST caps 1000 silently); a failed page REFUSES the import rather than classifying everything as new.
- Import is refused if payroll is locked for the month.
- Excluded members (`payroll_active = false`) still get rows imported (so re-including needs no re-upload) but are hidden from calculation, dashboards and counts (`src/lib/payroll/participation.ts`).

### Month coverage (`src/lib/attendance/monthAvailability.ts`)
- No per-date "processed" marker exists. Coverage = nothing imported -> null; future -> null; historical month -> month end; CURRENT month -> earlier of (latest imported `attendance_date`, today IST). Dates past the cut-off are dropped from responses, never returned as "unknown". In a month the machine supplies the latest date is capped at yesterday (`machineLatestDate`), so today is never classified; the employee route returns it as `today_so_far` instead.

### Attendance score (`src/lib/attendance/attendanceScore.ts`, `attendanceScoreboard.ts`)
- Information only: it changes no pay and nothing stores it, so an old month restates itself when a correction or an approval is made later, or when Payroll Rules change (it reads the active settings, not a period's snapshot). Admins only; employees never see it.
- Every day goes through the payroll engine (`classifyDayForAttendance`, a zero-rate wrapper on `classifySingleDay`), so corrections, waivers, half-day holidays and the 10:15 grace apply as on a payslip. Monthly Review (`monthly-summary`) and the person page (`employee-monthly-detail`) read days the same way, so all three agree.
- Points per day: on time 1; late, left early or one punch missing ¾; half day ½; absent 0. A day loses points once. Score = points ÷ days counted × 100, rounded. Bands: Great 95+, Okay 85-94, Needs attention under 85. All in `DAY_POINTS`, `GREAT_FROM`, `OKAY_FROM`. Owner approved these 2026-10-30.
- Not counted: Sundays, full-day holidays, approved leave, an approved half day that was worked, days before joining or from exit, days past coverage (so today in a machine month). This is the score's rule only: approval still changes no pay (see below).
- An approved late arrival or early departure, and anything waived, loses no points. An approved half day with no attendance at all is still absent; someone who works a full day on approved leave is scored on it.
- Not ranked: under `MIN_COUNTED_DAYS` (5) counted days, and anyone with no Machine ID in a machine month, whose days show as unknown, never absent.
- The page opens on the newest month with 5 counted company days and says so when that is not the current month. The company score is total points ÷ total counted days of ranked people.

### Holidays
- Full-day holiday: date leaves the working-day calendar. Half-day holiday: date STAYS in the calendar; `classifySingleDay` recurses with half-window settings (`halfDayHoliday.ts`, thresholds halved, lunch boundary splits the day); raw punches are CLIPPED to the working half first (`clipAttendanceToWorkingHalf`); a no-show for the working half is capped at `half_day` (never full absence); `raw_check_*` are restored to true punches afterwards. A manual correction outranks the holiday branch. Create + delete only (no edit).

### Attendance requests (`src/lib/attendance/requests.ts`)
- Types: late_arrival, early_departure, time_out, half_day (first_half/second_half), full_day_leave. Reasons: company_vehicle, company_work, personal, medical, family_emergency, traffic, other (note required only for other; note max 500).
- Limits: `MAX_LEAVE_DAYS = 31`, `MAX_DAYS_BACK = 62`, `MAX_DAYS_AHEAD = 180`, duplicate-retry window `RETRY_WINDOW_MS = 10 min` (identical pending request answered with `duplicate: true`, no second row/notification).
- "Informed on time" = submitted strictly before the 10:00 IST shift start of the first date; stays "informed" even if later rejected; a correction keeps `original_submitted_at` when the date is unchanged.
- Cancel/correct: pending any time; approved only before shift start. Overlap rules: leave overlaps anything; one half day/date; one late + one early per date; time-outs only when times overlap.
- Approval records PERMISSION ONLY; it does not mark a day present, remove lateness, grant paid leave or change pay.
- Monthly flag: the 4th and later uninformed, unexcused late arrival is flagged (deducts nothing; extra half-day deduction NOT implemented, pending BOE legal/payroll adviser).
- Salary decisions: `paid_waived` / `unpaid_actual` / `needs_correction` (+ excuse for late arrivals). For late/early/missing-punch, saving applies a waiver through `applyAttendanceCorrection` (same code as `POST /api/payroll/attendance-correction`); decision is stored only after that succeeds. No "use paid leave" choice exists (engine allocates automatically). Time-out has no measured duration and "Unpaid" is not offered for it.
- Lock gate: see 05 section 6 (month-end rule, acknowledgement, fingerprint).

## 7. Key components & lib files
- `src/lib/attendance/`: `classification.ts`, `scheduleRules.ts`, `punchParser.ts`, `punchDirection.ts`, `employeeMapping.ts`, `monthAvailability.ts`, `monthCalendar.ts`, `corrections.ts`, `workedDuration.ts`, `requests.ts`, `requestForm.ts`, `requestHandlers.ts`, `requestsServer.ts`, `requestReconciliation.ts`, `lockWarning.ts`, `attendanceScore.ts` (rules, client-safe), `attendanceScoreboard.ts` (server, runs the engine), `overviewToday.ts`, `testing/memorySupabase.ts`.
- Overview: `src/app/attendance/page.tsx` (month, reads), `OverviewBoard.tsx` (presentation), `overview.module.css`.
- `src/components/attendanceRequests/`: `AttendanceRequestFlow`, `AttendanceRequestModal` (phone-first sheet, 4 tiles -> 5 types), `MyAttendanceRequests`, `MonthRequests`, `RequestQueue`, `RequestReviewDrawer`, `RequestHistoryModal`, `PayrollAttendanceReview`.
- `src/components/layout/attendancePayrollNav.tsx`, `AttendancePayrollLayout.tsx`, `QuickActions.tsx`; `src/components/attendancePayroll/ui.tsx`.
- `src/lib/payroll/participation.ts`, `holidays.ts`, `halfDayHoliday.ts`, `attendanceCorrectionService.ts`, `correctionRules.ts`.
- API: `src/app/api/attendance/*`, `src/app/api/attendance-requests/*`.

## 8. Decisions made and why
- Corrections live in a SEPARATE table because the import UPDATES `attendance_records` in place and would erase them.
- Direction provenance recorded because a lone 18:36 punch used to be filed as an arrival (more than a day's pay for one forgotten punch). Cost of the cautious default: a narrow under-charge on genuine Format A late arrivals in legacy data (safe direction).
- An admin correction is always `confirmed` (blank punch field is a statement).
- Attendance/payroll management is admin-only; manager lost access; Control Center cannot widen it.
- Biometric import keeps writing rows for excluded members (owner decision).
- Requests: approval never changes pay; pay changes only via an explicit salary decision applied as a normal correction.
- Informed-on-time never rewritten after rejection (policy decision 9.1 in ATTENDANCE_REQUESTS.md).
- Half-day holidays reuse the existing classifier through a derived settings object (no new classification value, no new deduction builder).
- Check-in/out removed (Attendance V1.1): attendance comes only from machine import.
- The score asks the payroll engine rather than restating its rules, so a day cannot read one way on the Overview and another on a payslip.

## 9. Known traps / gotchas / unfixed defects
- `/attendance/requests`: the toolbar is `ui.toolbar` from `ui.module.css`. Until 2026-10-31 it read `styles.toolbar`, which `attendanceRequests.module.css` never had, so the status filter and the Scheduled shift label had no row.
- `attendance_records.status` cannot answer "late" or "half day": its CHECK allows only present/checked_in/absent/half_day, and the import and machine write only present/checked_in. Before the Overview score, Late and Half day in Monthly Review were always 0. Read a day through `scoreDay`, never from `status`.
- `attendance_records` is RAW and overwritten by re-import; never store a correction there.
- Forced `day_treatment` does NOT mean zero deduction: only `'full_day'` is free; `'half_day'`/`'absent'` still raise the aggregate day charge unless paid leave or credits absorb it (`engine.ts`, `buildFinalDeductionLines`).
- A correction must supersede the previous version BEFORE inserting the new one (partial unique index would give a misleading 23505).
- `payroll_results` has no `payroll_month`/`payroll_year` (on `payroll_periods`); a 42703 turned into a "Forbidden" once.
- `users.exit_date` is NOT read by the engine: a leaver is charged absent for working days after exit (open policy gap, ATTENDANCE_REQUESTS.md 9.5).
- A payroll month cannot be generated/locked/corrected until it has ended in IST (otherwise future days are charged as absences).
- `employee-monthly-detail` returns `office_timing` for display only; lateness uses company-wide settings, as the payroll engine does (no per-employee shift). `is_late` is true only on a day payroll reads as late, so 10:05 is not late on My Attendance, and `day_kind` carries what payroll read. `effective_status` still comes from the stored status, so My Attendance can say Present on a day payroll reads as a half day.
- The Correction Log has no sidebar entry: the Overview's links block is the only way in.
- Monthly Review counts someone with no Machine ID as absent in a machine month, as payroll does; the Overview leaves them unranked instead. That difference is deliberate: the first is what payroll would charge, the second is a fair comparison.
- Unreviewed legacy: 10 partial-lunch-overlap rows exist company-wide (predicate `in_min<840 AND out_min>780 AND overlap<60`); only one employee's 24 June 2026 row is still uncorrected in payroll (from memory, 2026-08-10; re-run the predicate, do not trust the list). Regenerating May/June is NOT settings-neutral (no `settings_snapshot`; `pinSettingsToPeriod` would stamp today's).
- `docs/testing/payroll-single-punch-historical-audit.sql` exists, read-only, never run (from memory).
- Format A confirmed 19:00 arrival + missing punch-out still costs ~11 h (> 1 day); stated by the file, candidate for a per-day cap.
- Month-level "imported" flags (e.g. `count > 0`) are the wrong signal: "imported" is a property of a DATE, not a month (an earlier version of the coverage code made this mistake).
- Stale text: `ATTENDANCE_REQUESTS.md` header still reads "Draft PR #239 ... not applied" and cites `/my-attendance/request`; `correctionRules.ts` comment says "There is no unlock workflow" (unlock exists, see 05).
- Heredoc/PowerShell can corrupt UTF-8/regex when scripting edits to these files; use the Write/Edit tools.

## 10. Tests that guard it
Run: `npx tsx --test "src/**/*.test.ts" "src/**/*.test.tsx"` (the `.ts`-only glob silently skips `.test.tsx`). Single file: `npx tsx --test <file>`. Live-DB suites SKIP (exit 0) without a configured test DB since #327 (`skipLiveDbSuite`); `REQUIRE_LIVE_DB_TESTS=1` makes that a failure. Never run two suites at once (shared fixtures; sandbox years are exclusive per file).
- `src/lib/attendance/*.test.ts`: `punchParser`, `punchProvenance`, `partialLunchOverlap`, `employeeMapping`, `corrections`, `monthAvailability`, `monthCalendar`, `requests`, `requestForm`, `requestHandlers` (route-level, real engine, in-memory DB), `requestReconciliation`, `requestWorkflow`, `lockWarning`, `attendanceScoreboard` (the score, through the real engine).
- `src/app/attendance/overviewBoard.render.test.tsx` (the Overview rendered, its stylesheet stubbed because the runner cannot load a CSS module; the today line; the links).
- `src/app/api/attendance/attendanceReadBounds.test.ts` (paged reads), `src/components/attendanceRequests/{adminRequests.test.ts,attendanceRequests.render.test.tsx}`, `src/components/layout/attendancePayrollNav.test.tsx`, `src/lib/attendancePayrollNotifications.test.ts`.
- Security (live DB): `src/lib/security/{attendancePayrollIsolation,attendancePayrollApiIsolation,attendancePayrollSelfService}.test.ts` (sandbox years 2021/2997).
- `src/lib/payroll/{halfDayHoliday,halfDayHolidayEngine,periodCompletion}.test.ts`.
- Adding ANY migration breaks ledger-pinning tests unless the named-successor helper (`assertNamedSuccessors`) covers them; since #327 new files at the end are allowed.

## 11. Open items / next planned work
- **Machine-only attendance from 2026-11-01 (owner decision 2026-10-30).** Excel import and preview refuse months from November 2026 (`MACHINE_MONTH_UPLOAD_REFUSED`), because the import updates rows in place and would overwrite machine rows. Details in 04 section 11.
- Confirm prod apply-state of 20270215000000/…100/20270222000000 and the payroll-owner sign-off on the new lock acknowledgement step.
- Policy decisions still open: final-settlement path for leavers; extra half-day deduction after the 4th uninformed late; per-employee shifts.
- Control Center / attendance review roadmap (10-item backlog) in memory `project_control_center_attendance_review_roadmap.md` (unverified, from memory).
- Not built: leave balances, one-step application of absence/half-day/leave decisions, notification to employee when a salary decision is saved.

## 12. Recheck before changing this module
Read first:
1. `src/lib/security/attendancePayrollApiAuth.ts`, `src/lib/moduleAccess.ts` (`resolveManagementAccess`), `src/app/attendance/layout.tsx`.
2. `src/lib/attendance/classification.ts`, `scheduleRules.ts`, `punchParser.ts`, `punchDirection.ts`, `monthAvailability.ts`.
3. `src/app/api/attendance/import/route.ts` + `preview/route.ts` (must stay identical in parsing and mapping).
4. `supabase/migrations/20270215000000_attendance_requests.sql` and `20260807000000_attendance_day_corrections.sql` headers (rollback and FK notes).
5. `src/lib/payroll/engine.ts` `classifySingleDay`, `buildWorkingDayCalendar`, `buildFinalDeductionLines`.
6. `docs/Module Docs/ATTENDANCE_REQUESTS.md`, `PAYROLL_ATTENDANCE_RULES.md`, `ATTENDANCE_PAYROLL_MODULE.md` (treat as maintained prose; code wins).
Queries/commands: `npx supabase migration list --linked` (non-empty `remote` per version, then probe columns); `git cherry -v` before trusting ahead/behind counts; MAX(`attendance_date`) per month for coverage.
Tests to run: all of section 10 (attendance + payroll + security), plus `src/lib/boeCredits/*` and `src/lib/payroll/creditCoverage.test.ts` if corrections change (corrections reconcile credit coverage).
