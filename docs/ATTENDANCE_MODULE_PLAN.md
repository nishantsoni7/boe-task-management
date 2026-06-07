# Attendance & Salary Module — Planning Document

**Date:** 2026-06-07
**Status:** Planning only — no code written
**Scope:** Version 1 (MVP)

---

## 1. Module Structure Inside the Existing App

The module lives inside `src/app/attendance/` as a new top-level route group, following the same conventions as `src/app/tasks/` and `src/app/admin/`.

```
src/app/attendance/
  layout.tsx                    ← shared attendance layout (wraps DashboardLayout)
  page.tsx                      ← redirect to /attendance/dashboard or my-attendance
  dashboard/page.tsx            ← HR/Admin summary view
  employee-master/page.tsx
  leave/
    apply/page.tsx
    approvals/page.tsx
  late-arrival/
    request/page.tsx
    approvals/page.tsx
  early-departure/
    request/page.tsx
    approvals/page.tsx
  guard/
    scanner/page.tsx            ← QR scanner for guards
    approvals/page.tsx
  upload/page.tsx               ← bulk attendance upload (HR/Admin)
  salary/
    calculate/page.tsx          ← salary run (HR/Admin)
    my-salary/page.tsx          ← employee view own payslip
    concerns/page.tsx           ← raise or review salary concerns
```

Shared components go in `src/components/attendance/`.

The existing `DashboardLayout` sidebar gains an "Attendance" section — visible to all roles, but individual links are gated by role exactly like the existing Performance / Settings sections.

---

## 2. User Roles and Access

The existing `role` field on the `users` table (`admin | manager | member`) needs two new values for attendance purposes: `hr` and `guard`. Until the schema is extended, map roles as follows for Version 1:

| Role     | Existing value | Attendance permissions |
|----------|---------------|------------------------|
| Employee | `member`      | Apply leave, request late/early, view own payslip, raise salary concern |
| Guard    | `guard` (new) | QR scanner, log entry/exit |
| HR       | `hr` (new)    | All employee actions + upload attendance, run salary, manage all leave/late |
| Manager  | `manager`     | Approve leave/late/early for own team members |
| Admin    | `admin`       | Full access — everything HR can do plus employee master |

All role-gating follows the existing pattern in `DashboardLayout` — check `userProfile.role` before rendering links or page content.

---

## 3. Required Screens

### 3.1 Employee Master
**Who:** Admin, HR
**Purpose:** View and edit employee attendance-relevant details (joining date, department, shift).
**Key fields shown:** Name, employee code, department, shift, joining date, is_active.
**V1 rule:** Read-only list with basic filters. Edit limited to joining date and shift assignment.

### 3.2 Leave Apply
**Who:** Employee, Manager, HR, Admin (self-apply)
**Purpose:** Submit a leave request for a date range.
**Key fields:** Leave type (casual / sick / earned), from date, to date, reason, optional attachment.
**V1 rule:** No leave balance tracking — just submit and route for approval.

### 3.3 Leave Approval
**Who:** Manager (own team), HR, Admin
**Purpose:** List pending leave requests, approve or reject with a comment.
**V1 rule:** Single-level approval only — no escalation chains.

### 3.4 Late Arrival Request
**Who:** Employee (self)
**Purpose:** Declare a late arrival with reason, so it is not auto-marked absent.
**Key fields:** Date, expected arrival time, reason.
**V1 rule:** Guard or HR manually marks arrival; this is just the request record.

### 3.5 Early Departure Request
**Who:** Employee (self)
**Purpose:** Request permission to leave before shift end.
**Key fields:** Date, departure time, reason.
**V1 rule:** Manager or HR approves.

### 3.6 QR Approval / Guard Scanner
**Who:** Guard
**Purpose:** Scan employee QR code to log entry or exit. Can also manually mark entry/exit by employee search.
**V1 rule:** Each employee gets a static QR code derived from their user ID. No dynamic/expiring QR in V1. The scanner page is a simple camera input that decodes the QR and calls a Supabase insert.

### 3.7 Attendance Upload
**Who:** HR, Admin
**Purpose:** Upload a CSV/Excel file of daily attendance records in bulk (useful for importing from a biometric device export).
**V1 rule:** Simple CSV upload — parse rows, insert into `attendance_logs`. Show a summary of rows inserted vs. errors. No deduplication logic beyond unique constraint on (employee_id, date).

### 3.8 Salary Calculation
**Who:** HR, Admin
**Purpose:** Run salary calculation for a selected month. Computes gross salary from attendance, deductions, and adjustments.
**V1 rule:** Single flat salary per employee (from employee master). Deductions: LOP (loss of pay) days × daily rate. No PF/ESI/tax in V1.

### 3.9 My Salary
**Who:** Employee (self), Manager (self)
**Purpose:** View own monthly payslip — days worked, LOP, gross, deductions, net.
**V1 rule:** Read-only. No download in V1.

### 3.10 Salary Concern
**Who:** Employee (raises), HR/Admin (reviews and responds)
**Purpose:** Employee flags a discrepancy in their payslip. HR comments and resolves.
**V1 rule:** Simple comment thread per concern. Status: open → resolved.

---

## 4. Suggested Database Tables (Planning Level)

All tables follow the existing Supabase conventions: `id uuid primary key`, `created_at timestamptz`, and `created_by uuid references users(id)`.

### `employee_profiles`
Extends the existing `users` table with attendance-specific fields.

| Column | Type | Notes |
|--------|------|-------|
| user_id | uuid FK → users | primary key |
| employee_code | text | unique, e.g. BOE-001 |
| department | text | |
| shift | text | morning / evening / general |
| joining_date | date | |
| monthly_salary | numeric | gross CTC per month |

### `leave_requests`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | |
| employee_id | uuid FK → users | |
| leave_type | text | casual / sick / earned |
| from_date | date | |
| to_date | date | |
| reason | text | |
| status | text | pending / approved / rejected |
| reviewed_by | uuid FK → users | nullable |
| review_comment | text | nullable |

### `late_arrival_requests`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | |
| employee_id | uuid FK → users | |
| date | date | |
| expected_time | time | |
| reason | text | |
| status | text | pending / approved / rejected |
| reviewed_by | uuid FK → users | nullable |

### `early_departure_requests`
Same structure as `late_arrival_requests` — replace `expected_time` with `departure_time`.

### `attendance_logs`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | |
| employee_id | uuid FK → users | |
| date | date | |
| check_in | timestamptz | nullable |
| check_out | timestamptz | nullable |
| source | text | qr_scan / manual / upload |
| logged_by | uuid FK → users | guard or HR who entered it |
| unique constraint on (employee_id, date) | | prevent duplicates |

### `salary_runs`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | |
| month | text | YYYY-MM |
| run_by | uuid FK → users | HR/Admin |
| run_at | timestamptz | |
| status | text | draft / published |

### `payslips`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | |
| salary_run_id | uuid FK → salary_runs | |
| employee_id | uuid FK → users | |
| working_days | int | calendar days in month |
| present_days | int | from attendance_logs |
| lop_days | int | working_days − present_days |
| gross_salary | numeric | from employee_profiles |
| lop_deduction | numeric | (gross / working_days) × lop_days |
| net_salary | numeric | gross − lop_deduction |

### `salary_concerns`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | |
| payslip_id | uuid FK → payslips | |
| employee_id | uuid FK → users | |
| description | text | |
| status | text | open / resolved |
| response | text | nullable |
| resolved_by | uuid FK → users | nullable |

---

## 5. Salary Calculation Inputs

Version 1 keeps salary calculation deliberately simple:

| Input | Source |
|-------|--------|
| Monthly gross salary | `employee_profiles.monthly_salary` |
| Working days in month | Calendar calculation (Mon–Sat or configured) |
| Present days | Count of `attendance_logs` rows where the employee has a `check_in` for the month |
| Leave days (approved) | `leave_requests` where status = approved for the month |
| LOP days | `working_days − (present_days + approved_leave_days)` |
| Daily rate | `monthly_salary / working_days` |
| LOP deduction | `daily_rate × lop_days` |
| Net salary | `monthly_salary − lop_deduction` |

No PF, ESI, TDS, HRA, DA, or allowance breakdowns in Version 1.

---

## 6. Version 1 Scope

These features ship in V1:

- Employee master (read list + edit shift/joining date)
- Leave apply and single-level approval
- Late arrival request and approval
- Early departure request and approval
- Guard QR scanner (static QR, entry/exit log)
- HR manual attendance entry (single record)
- Bulk attendance CSV upload
- Salary calculation — gross − LOP only
- My Salary payslip view (read-only)
- Salary concern with HR response

Role-based sidebar visibility for all of the above.

---

## 7. What Should NOT Be Built in Version 1

Keep these out to avoid scope creep:

- Leave balance tracking / accrual engine
- Half-day leave
- Compensatory off / comp-off tracking
- PF, ESI, TDS, or any statutory deductions
- Salary slip PDF download or email
- Biometric device direct integration (use CSV upload instead)
- Dynamic or time-expiring QR codes
- Overtime calculation
- Shift scheduling / rosters
- Holiday master calendar (hardcode working days count for V1)
- Multi-level approval chains
- Notifications / email alerts (defer to V2)
- Mobile app or PWA
- Attendance regularisation workflow (auto-request when absent)

---

## 8. Step-by-Step Build Order

Build in this order so each step is independently usable before moving to the next:

1. **Database tables** — Create all tables in Supabase: `employee_profiles`, `attendance_logs`, `leave_requests`, `late_arrival_requests`, `early_departure_requests`, `salary_runs`, `payslips`, `salary_concerns`. Add new role values (`hr`, `guard`) to any role enum/check constraint.

2. **Add `hr` and `guard` roles** — Update the role check in `UserProfile` type and in `DashboardLayout` role checks. Seed one HR user and one Guard user for testing.

3. **Employee Master screen** — List view of all users with their `employee_profiles` data. Inline edit for shift and joining date. This establishes the data foundation all other features depend on.

4. **Attendance log entry (manual + QR)** — Guard scanner page with static QR decode. Manual entry form for HR. Verify `attendance_logs` rows are written correctly before building anything that reads them.

5. **Bulk attendance upload** — CSV parse and insert into `attendance_logs`. Test with realistic sample data so salary calc has real inputs.

6. **Leave Apply + Approval** — Employee submits, manager/HR approves. Confirm approved leave days are queryable before wiring into salary.

7. **Late Arrival and Early Departure requests** — Same pattern as leave, simpler fields.

8. **Salary Calculation screen** — Pick month, compute payslips, save to `salary_runs` + `payslips`. Show a preview table before finalising.

9. **My Salary screen** — Employee reads own payslip rows. Confirm RLS policy so employees can only see their own rows.

10. **Salary Concern** — Employee raises concern on a payslip, HR responds and marks resolved.

11. **Sidebar integration** — Add "Attendance" section to `DashboardLayout` with role-gated links for all screens built above.

12. **End-to-end smoke test** — Full flow: employee logs in → applies leave → guard scans entry → HR uploads CSV → HR runs salary → employee views payslip → employee raises concern → HR resolves.

---

*End of planning document. No code changes made.*
