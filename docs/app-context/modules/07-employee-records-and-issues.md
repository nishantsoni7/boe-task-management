# 07 - Employee Records, Objections ("Raise Issue") and My Issues

Verified against checkout `852e0493`. Two related halves of Attendance & Payroll: (A) Employee Master / employee records (the per-employee payroll and attendance configuration) and (B) the employee issue workflow (table `employee_record_objections`, UI vocabulary "Issue"/"Raise Issue"; code vocabulary "objection"). See also 03 (attendance days), 05 (payslips), 06 (credits).

## 1. Purpose & users

- (A) Employee Master: an admin-only screen to maintain the fields attendance and payroll depend on - `employee_code`, `fingerprint_employee_code` (machine code used by the importer), `joining_date`, `monthly_salary`, `office_timing`, `payroll_active` (participation), `employment_type`, `payroll_notes`, plus performance tracking flags - and to open one employee's attendance history.
- (B) An employee reports that their OWN attendance day or payroll result looks wrong. An issue is a REPORT, never a change: nothing in the workflow can move a punch, a classification, a deduction, a salary or an adjustment. If the employee is right, the admin still corrects through the attendance-correction workflow (03/05), which keeps its own audit trail.
- Users: **Employee** (raise, re-raise, read own history, receive outcome notifications); **Admin** (review queue, approve/reject with a note, receive "raised" notifications). Manager role: none.

## 2. Status at commit 852e0493

| Capability | Status |
|---|---|
| Employee Master `/attendance/employees`, `/attendance/employees/[id]` | Shipped |
| Raise issue from `/my-attendance` (a day) and `/my-payroll` (a payslip) | Shipped |
| `/my-issues` list + history, `/my-issues/notifications` | Shipped |
| Admin queue on `/attendance/correction-log`; payroll review on the payslip page and Payroll Monthly Preview | Shipped |
| Issue notifications (4 types) + shared feed with attendance requests | Shipped |
| Edit/withdraw/delete an issue after submitting | NOT possible by design (no UPDATE/DELETE policy) |
| Reopen a decided issue | NOT possible; the employee raises a NEW one ("Raise Again") |
| Free-form comment threads / salary concern module (`ATTENDANCE_MODULE_PLAN.md` 3.10) | Planned only, not built |
| Exit/leaver handling (`users.exit_date`) in payroll | NOT built (see 05) |

## 3. Pages and API routes

- Pages: `/my-issues` (any employee; own list, status, History, `?issue=<id>` deep link as a FILTER over rows the caller already owns), `/my-issues/notifications`; `/attendance/correction-log` (admin queue "Reported attendance issues" above the import audit trail); `/payroll/results/[periodId]/[employeeId]` (admin review panel on the disputed payslip); `/payroll?issue=<objection id>` (notification landing: resolves to the payslip); `/attendance/notifications` and `/payroll/notifications` (two admin doors onto the SAME `attendance_payroll` feed); `/attendance/employees`, `/attendance/employees/[id]` (admin).
- API:
  | Route | Verbs | Auth / behaviour |
  |---|---|---|
  | `/api/objections` | GET | `resolveCaller`; non-admin pinned to own rows; admin may filter `employee_id`, `status`, `id`, and a payroll run (`payroll_period_id` or `payroll_year`+`payroll_month`, resolved via `payroll_results.payroll_period_id`); admin rows embed the employee and `payroll_result ( payroll_period_id, employee_id )` |
  | `/api/objections` | POST | `resolveCaller`; body `{attendance_date | payroll_result_id (exactly one), reason}`; snapshot built SERVER-SIDE from the caller's own data; 409 on duplicate pending; 403 (flat, same for colleague's or missing result) on foreign payroll result; 201 + notifies every active admin |
  | `/api/objections/review` | POST | `requireAdmin` + calls RPC `review_employee_record_objection` as the admin (anon client carrying the caller's bearer) ; 404 not found, 409 already reviewed; then notifies the employee once |
  | `/api/update-employee` | POST | Admin only (`ALLOWED_ROLES=['admin']`); writes Employee Master fields incl. `monthly_salary`, `payroll_notes` |
  | `/api/attendance/employee-records` | GET | `requireSelfOrAdmin`; paged read of ALL attendance rows for one employee (id from the authorised result, never the raw query string) |
  | `/api/attendance/employee-monthly-detail` | GET | `requireSelfOrAdmin` (shared with 03; includes requests) |
  | `/api/payroll/participation` | GET, PATCH | admin only (returns salaries; not opened to Custom members) |

## 4. Database

### `employee_record_objections` (`20260823000000_employee_record_objections.sql`)
- Columns: `employee_id` (default `auth.uid()`, FK users ON DELETE CASCADE), `attendance_date` OR `payroll_result_id` (FK payroll_results ON DELETE CASCADE) - CHECK `num_nonnulls(...) = 1`; `reason` (CHECK `btrim <> ''`); `subject_snapshot` (server-composed text, kept so a reviewed issue reads sensibly after correction); `status` pending|approved|rejected; `reviewed_by/at`, `review_note`, `created_at`.
- Attendance issues are keyed by DATE (a day with no punches has no `attendance_records` row and those are the days people most want to dispute).
- Two partial unique indexes: one pending per `(employee_id, attendance_date)` and one pending per `(employee_id, payroll_result_id)`. Resolved issues do not block a new one. Index `(status, created_at DESC)` serves the admin queue.
- RLS: INSERT own only (`employee_id = auth.uid()`, status pending, review fields null, user active, and the payroll result must belong to the caller - the EXISTS clause stops A referencing B's result); SELECT own, or any as active admin. NO UPDATE or DELETE policy for anyone; GRANT SELECT, INSERT to authenticated only.
- `review_employee_record_objection(uuid, text, text)` SECURITY DEFINER, `search_path = public, pg_temp`, EXECUTE to `authenticated`: asserts `auth.uid()` is an active admin (28000 / 42501 `OBJECTION_FORBIDDEN`), status in approved|rejected (22023), locks the row FOR UPDATE, only a still-pending row (55000 `OBJECTION_ALREADY_REVIEWED`, P0002 `OBJECTION_NOT_FOUND`), sets exactly four columns.
- Notification enum values: `attendance_issue_raised`, `payroll_issue_raised` (`20260824000000`), `attendance_issue_reviewed`, `payroll_issue_reviewed` (`20260825000000`). `notifications.entity_id` is a single uuid: it carries the OBJECTION id.
- Interaction with other tables: regenerating payroll UPSERTS `payroll_results` (the row and its objections survive); permanently deleting a period (`delete_payroll_period`, `20260830000000`) DELETES the period's objections and records only their count in `payroll_deletion_audit.removed_counts`.
- No storage bucket. No views.
- Apply-state (from memory, unverified here): 20260823 applied to prod 2026-08-08; 20260824 applied 2026-08-08; 20260825 required before the code that writes the reviewed type (the whole feed filter breaks with 22P02 if one enum value is missing). Employee Master has no table of its own: it edits `public.users`.

### `public.users` columns relevant to (A)
`employee_code`, `fingerprint_employee_code`, `joining_date`, `office_timing` (text, e.g. "9:00 AM"; parsed only for display in `employee-monthly-detail`, NOT used by the payroll engine), `payroll_active` (default true, since `20260607000100`), `employment_type`, `exit_date` (exists; unused by engine), private columns `monthly_salary`, `payroll_notes`, `performance_tracking_note` (column privileges, `20260813000000`: `select('*')` on users fails 42501; use `USER_PROFILE_COLUMNS` in `src/lib/users/safeColumns.ts`). `public.users.id = auth.users.id` by convention only (NO FK); `handle_new_auth_user()` swallows every exception, `users.phone` is UNIQUE with a `''` default, so test actors need unique phones and explicit profile upserts.

## 5. Permissions & access

- Raise/read own issue: any signed-in active employee (self-service route of the Attendance & Payroll module, not a module-permission key; the launcher card visibility is a usability decision only).
- Review/resolve: active admin only, asserted in the route AND inside the SECURITY DEFINER function.
- Every endpoint pins a non-admin to their own rows regardless of the query string; RLS says the same again for direct PostgREST callers.
- Employee Master (`/attendance/employees*`, `/api/update-employee`): admin only; Control Center visibility cannot widen it.
- Notifications: the feed `attendance_payroll` is no longer admin-only (`ADMIN_ONLY_CATEGORIES = []` in `src/lib/notifications.ts`) because decision notifications go to employees; row access is `user_id = caller`. `canReadNotificationCategory()` (`src/lib/notificationAccess.ts`) stays as machinery for the next admin-only feed.
- View As: previewing an employee renders their interface, but writes are disabled while previewing; "Switch User" is NOT impersonation and cannot be used to test employee API authorization.

## 6. Business rules

- Status flow: `pending -> approved | rejected`, final. Employee labels: Issue Pending / Resolved / Rejected.
- One pending per record (employee + date, or employee + payroll result). After a decision the employee may "Raise Again": a NEW row; the old one is never reopened, rewritten or deleted. Attempts link by the record they dispute, not by a parent id. History modal (`buildIssueHistory`) is derived from the rows - sound only because nothing overwrites them.
- Reason: required, trimmed, max `REASON_MAX_LENGTH = 500`. Exactly one target.
- Snapshots: attendance (date, IST punch clock, effective status; absent when no row) and payroll (month/year, gross, deductions, net) are built by the server, never accepted from the browser.
- Notifications: admins get `*_issue_raised` (attendance lands on `/attendance/correction-log`, payroll on the payslip via `/payroll?issue=<id>`); the employee gets `*_issue_reviewed` once, only after the status change succeeded (a repeated review stops at 409); recipient read from the reviewed row, never the request. Notification failures are logged and never fail the raise/review.
- Payroll issues shown on a payroll screen are scoped to that run via the result's `payroll_period_id` (never by comparing month text or the calendar).
- Participation (`payroll_active`): excluded members are not calculated or counted but their history stays; the importer keeps writing their rows.
- Employee Master: the fingerprint code maps imports by exact string (no normalisation); manual one-off mapping in the import UI does NOT write a code.

## 7. Key components & lib files
- `src/lib/objections.ts` (statuses, `canRaiseIssue`, `payrollObjectionHref`, scope query helpers, `validateObjectionInput`, snapshot builders, `buildIssueHistory`), `src/components/objections/{RaiseIssueModal,IssueHistoryModal,ObjectionQueue,ObjectionReviewPanel,useObjections}.ts(x)`.
- `src/app/api/objections/{route.ts,review/route.ts}`, `src/lib/notifications.ts`, `src/lib/notificationAccess.ts`, `src/components/notifications/*`.
- `src/app/my-issues/page.tsx`, `src/app/attendance/correction-log/page.tsx`, `src/app/attendance/employees/{page.tsx,[id]/page.tsx}`, `src/app/api/update-employee/route.ts`, `src/lib/payroll/participation.ts`, `src/lib/users/safeColumns.ts`.
- `docs/Module Docs/ATTENDANCE_PAYROLL_ISSUES.md` (as built).

## 8. Decisions made and why
- One table for both subjects so the isolation rule is written once (the original defect came from one rule restated in three places).
- No reuse of `attendance_day_corrections` / `payroll_pending_adjustments`: a row in either IS a change to pay; employee-writable rows there would let an employee move their own money.
- No UPDATE/DELETE policies (matches `order_requests`, `asset_change_requests`): the review function is the only writer after INSERT.
- Attendance keyed by date, not by an `attendance_records` id.
- A decision notifies the employee (originally the feed was admin-only; this changed with `20260825000000`).
- Notification deep link carries the objection id and resolves server-side (`/api/objections?id=`) because `entity_id` is one uuid and the payslip route needs two.
- "Manager" lost access in the isolation audit (`20260812000000`).

## 9. Known traps / gotchas / unfixed defects
- A `SECURITY DEFINER` function reading `auth.uid()` cannot be called with the service-role client (28000). Use an anon client with the caller's `authorization` header, as `/api/objections/review` does.
- `payroll_results` has no `payroll_month/payroll_year`; selecting them gives 42703 and PostgREST returns `data:null`. NEVER turn a query error into "Forbidden"; check `error` separately and return 500.
- A green RLS suite (`objectionIsolation.test.ts`, 17 tests) says nothing about how a ROUTE reaches the RPC; both bugs above were found only by browser E2E.
- Adding a notification type requires (1) the enum migration BEFORE code, (2) adding the type to a category filter - `getNotificationMeta` returning an href does not make a row visible (the issue notifications were unreachable until a feed existed).
- Enum membership probe: `.eq('type', 'payroll_issue_raised')` returns 22P02 while the value is missing.
- Deleting a payroll period deletes its issues (only counts audited). Regenerating does not.
- `ATTENDANCE_PAYROLL_ISSUES.md` and older comments in `notificationAccess.ts` still describe an admin-only feed; `src/lib/notifications.ts` is current.
- `handle_new_auth_user()` swallows errors: a failed profile insert is silent; test actors must set a unique phone.
- `users.monthly_salary` was once peer-readable; fixed by column grants, not RLS. Never loosen.
- Test suites `objectionIsolation` (sandbox year 2997) and `attendancePayrollApiIsolation` (2021) are LIVE-DB; they SKIP without a database and are refused against production by the UAT guard.
- The PowerShell/Git-Bash scripting traps in 05 apply to editing these files.

## 10. Tests that guard it
Run `npx tsx --test src/lib/objections*.test.ts src/lib/objectionVisibility.test.ts src/lib/objectionWorkflow.test.ts src/lib/payrollIssuePeriodScope.test.ts src/lib/attendancePayrollNotifications.test.ts` or the full suite (03 section 10). Live DB: `src/lib/security/objectionIsolation.test.ts` (17 RLS tests), `attendancePayrollApiIsolation.test.ts` (route handlers with real bearer tokens), `attendancePayrollSelfService.test.ts`, `attendancePayrollIsolation.test.ts`. Also `src/lib/notificationSystemActivity.test.ts` (inventories notification writers), `src/lib/moduleAccess.test.ts`.

## 11. Open items / next planned work
- Resolve owner-level question of leaver handling; no code yet.
- Possible: an employee-visible note when a salary decision from an attendance review is saved (not built).
- Members/Admin API security audit was the recorded next item after the repo-health cleanup (from memory).

## 12. Recheck before changing this module
1. `supabase/migrations/20260823000000`, `20260824000000`, `20260825000000`, `20260830000000` (objection delete path).
2. `src/app/api/objections/route.ts` and `review/route.ts`; `src/lib/objections.ts`; `src/lib/notifications.ts` (category filters/types) and `notificationAccess.ts`.
3. `src/lib/security/attendancePayrollApiAuth.ts`; `src/app/api/update-employee/route.ts`; `src/lib/users/safeColumns.ts`.
4. `docs/Module Docs/ATTENDANCE_PAYROLL_ISSUES.md` and `ATTENDANCE_PAYROLL_MODULE.md`.
5. Live checks (read-only): enum membership for all four issue types; pending-index presence; `migration list`.
6. Run the section 10 tests; for UI changes verify in a browser (the two route bugs were invisible to automated tests).
