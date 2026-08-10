# BOE TASK MANAGEMENT — Current System State

Last verified: **2026-08-11**, against commit `a33c14e` on
`feat/attendance-payroll-module-merge` (branching from `origin/main` `0147b6f`).

> Rebuilt from code, tests and applied migrations. The June 2026 version of this
> file described Attendance and Payroll as "Early Stage"; both have been in
> production use for months. See the source-of-truth hierarchy in
> [00_README_FIRST.md](00_README_FIRST.md).

---

## Repository size (measured 2026-08-11)

| Metric | Count |
| --- | --- |
| TypeScript/TSX source files | 544 |
| Application pages (`page.tsx`, non-API) | 92 |
| Route layouts | 9 |
| API route handlers | 98 |
| Supabase migrations | 159 |
| Test files | 121 |
| Automated tests | 3,211 |
| Shared components | 57 |
| `src/lib` modules | 211 |

---

## Module status

Status vocabulary: **Active** (in daily production use) · **Foundation**
(usable, still gaining core workflows) · **Planned** (not built).

| Module | Status | `app_modules` key | Entry route |
| --- | --- | --- | --- |
| Authentication | Active | — | `/login` |
| Module launcher | Active | — | `/modules` |
| Task Management | Active | `task_management` | `/dashboard` |
| Notifications | Active | — | `/notifications` |
| Performance Management | Active | `performance` | `/performance` |
| Team Performance | Active | `performance` | `/performance/team` |
| Sample Tracking | Active | `sample_tracking` | `/samples` |
| **Attendance & Payroll** | **Active** | `attendance` + `payroll` | `/payroll` (admin) · `/my-attendance` (employee) |
| Assets & Access | Foundation | `assets_access` | `/assets-access` |
| Meetings | Active | `meetings` (permission-gated) | `/meetings` |
| Order Management | Active | `orders` (permission-gated) | `/orders` |
| Finance | Foundation | `finance` | `/finance` |
| Showroom QR | Active | `showroom_qr` | `/showroom-admin` |
| Employee Records | Active | `employee_records` | `/admin/members` |
| Admin Control Center | Active | — (admin only) | `/admin/control-center` |

**Correction to earlier records:** Employee Records is no longer "Planned" — it
is live at `/admin/members` with soft delete, restore, permanent deletion and
password-reset controls. Sample Tracking is no longer "In Progress".

---

## Attendance & Payroll consolidation

**Status: implemented on branch `feat/attendance-payroll-module-merge`, NOT yet
merged to `main` and NOT deployed.**

- One launcher card, "Attendance & Payroll", replacing two.
- One shell (`AttendancePayrollLayout`) and one navigation definition
  (`attendancePayrollNav.tsx`) replacing two near-identical copies.
- `/attendance/*` and `/payroll/*` URL trees, guards, tables, calculations and
  audit trails are **unchanged and still separate**.
- No migration was required.

See [../Module Docs/ATTENDANCE_PAYROLL_MODULE.md](../Module%20Docs/ATTENDANCE_PAYROLL_MODULE.md)
and [ADR-0004](../adr/0004-attendance-payroll-ui-consolidation.md).

---

## Major active workflows

**Task Management** — create, assign, self-assign, quotation requests, status
transitions, cancellation, completion, restore, attachments, per-task activity.

**Attendance** — monthly fingerprint Excel import with employee mapping,
day classification, date-level corrections with written reasons, correction log,
holiday management, monthly attendance review.

**Payroll** — period creation, generation from reviewed attendance, monthly
preview, per-employee payslips, pending adjustments with categories, settlements
and carry-forward, salary processing report with WhatsApp sharing, locking and
admin unlock, controlled period deletion, central payroll settings pinned per
period.

**Employee issues** — an employee raises an issue against an attendance date or a
payslip; an admin approves or rejects with a reason; the employee is notified and
may re-raise once the issue has been answered. One `attendance_payroll`
notification category, one feed, two role-specific doors.

**Performance** — daily/monthly scoring, EOD discipline, team execution view,
employees requiring attention, app-open tracking.

**Samples** — requests, dispatch, courier tracking, inward verification, audit
history.

**Assets & Access** — inventory, assignment, custody, repair/service, warranty,
change requests, access register, permanent deletion (admin only).

**Meetings** — New Order and Repair Order reviews, SKU updates, follow-ups.

**Orders & Finance** — order requests with attachments, amendments, payment
requests, received payments, payment destinations, deletion protection.

---

## Admin vs employee

**Admin-only surfaces:** `/attendance/*`, `/payroll/*` (except the calculation
guide), `/admin/*`, `/super-admin`, payroll settings, holiday management,
attendance import, issue review, permanent deletions.

**Employee self-service:** `/my-attendance`, `/my-payroll`, `/my-issues`,
`/notifications`, `/account`, `/tasks/*`, `/performance`, and
`/payroll/how-it-works` (the one `/payroll` route open to everyone, because it
holds no employee data).

Full mapping: [08_Authorization_Matrix.md](08_Authorization_Matrix.md).

---

## Privacy model

- **Salary columns on `users` are column-granted, not table-granted.** A
  `select('*')` on `users` raises SQLSTATE 42501. Use
  `USER_PROFILE_COLUMNS` / `src/lib/users/safeColumns.ts`.
- **Attendance and payroll tables are row-isolated** by RLS
  (`20260812000000_attendance_payroll_isolation.sql`).
- **Self-service APIs derive the employee from the bearer token.** There is no
  employee id parameter on `/api/payroll/my-result` to tamper with.
- **`payroll_settings` is admin-read-only**; the settings API refuses non-admins.
- **Module visibility is not authorization.** `app_modules` governs whether a
  card appears; `resolveManagementAccess` keeps Attendance and Payroll
  management admin-only whatever visibility says.

---

## Deployment model

- Hosting: **Vercel**, canonical domain `boe-task-management.vercel.app`.
  Per-deployment URLs sit behind Vercel SSO.
- Database/Auth: **Supabase**, project `albnsrohngkljfsrrrhf`.
- Migrations: **forward-only**, applied with `supabase db push --linked`.
  See [ADR-0003](../adr/0003-forward-only-migrations.md).
- Release: rebase-merge a feature branch into `main`; merging deploys.
  **Migrations are applied before the merge**, because PostgREST returns 42703
  for an unknown column.
- There is no `gh` CLI on the current development machine.

---

## Known limitations

Tracked with evidence and severity in [09_Risk_Register.md](09_Risk_Register.md).
Summary:

1. Authorization is enforced consistently on the server but **client route
   gating is inconsistent** — some route families have a layout guard, others
   gate inside the page, several rely on the API alone.
2. **71 API routes hand-roll their role check** against `users`; only 15 use the
   shared `requireAdmin`.
3. Several **very large multi-responsibility page files** (largest: 2,679 lines).
4. **Self-service routes have no module guard** — an employee whose card is
   hidden can still open `/my-attendance` by URL. They see only their own data.
   Classified as intended self-service access pending confirmation.
5. `threshold_half_day_hours` is **stored, validated and editable but read by no
   calculation** since the half-day band was widened.
6. **Two migration filename conventions** coexist (65 eight-digit, 94 fourteen-digit).
7. Automated coverage is **concentrated in payroll, assets and meetings**; large
   UI areas have no tests.
8. `payroll_holidays` is empty in production.
