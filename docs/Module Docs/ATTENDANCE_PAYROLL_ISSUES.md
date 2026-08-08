# Attendance & Payroll Issues — as built

The employee-facing "Raise Issue" workflow and what an admin does with it. This
records what the code does, not what was planned; the planning-level ancestor of
this feature is "Salary Concern" in `ATTENDANCE_MODULE_PLAN.md` §3.10.

An issue is a **report, never a change**. Nothing in this workflow can move a
punch, a classification, a deduction, a salary or an adjustment. If the employee
is right, the admin still makes the correction through the existing attendance
correction workflow, which keeps its own audit trail.

## Where it lives

| Surface | Route | Who |
|---|---|---|
| Own issue list, raise, history | `/my-issues` | Any employee |
| Raise from an attendance day | `/my-attendance` | Any employee |
| Raise from a payslip | `/my-payroll` | Any employee |
| Own issue notifications | `/my-issues/notifications` | Any employee |
| Attendance review queue | `/attendance/correction-log` | Admin |
| Payroll review, on the disputed payslip | `/payroll/results/[periodId]/[employeeId]` | Admin |
| Issue notifications | `/attendance/notifications`, `/payroll/notifications` | Admin |

`/my-issues` is a self-service route of the Attendance & Payroll module, beside
`/my-attendance` and `/my-payroll` — not a new module. `/attendance` and
`/payroll` remain admin-only management surfaces (`resolveManagementAccess`,
`SELF_SERVICE_MODULE_KEYS`).

## Statuses

`pending` → `approved` or `rejected`, and no further. The employee sees
**Issue Pending**, **Resolved** and **Rejected**.

## Raising again after a decision

- While an issue is **pending**, the same record cannot be reported again. This
  is enforced by two partial unique indexes (`WHERE status = 'pending'`) in
  `20260823000000`, and the UI hides the action to match.
- Once an issue is **resolved or rejected**, the employee may raise the matter
  again. The action returns, labelled **Raise Again**.
- A re-raise **creates a new row**. The earlier issue is never reopened,
  rewritten or deleted — `employee_record_objections` has no UPDATE and no
  DELETE policy for anyone, and the review function refuses a row that is not
  still pending.
- Attempts are linked by the record they dispute (employee + attendance date, or
  employee + payroll result), not by a parent id.

## History

**View History** opens a modal with the whole trail for one record: every
submission with its reason and the snapshot taken at the time, and every
decision with its note, actor and timestamp. A re-raise is labelled as such.
Available to the employee on all three of their screens, and to the admin on the
queue and the review panel.

The trail is derived from the rows (`buildIssueHistory`), which is only sound
because nothing overwrites them.

## Notifications

One shared feed, category `attendance_payroll`, in the shared `notifications`
table. Four types:

| Type | Written to | Lands on |
|---|---|---|
| `attendance_issue_raised` | every active admin | `/attendance/correction-log` |
| `payroll_issue_raised` | every active admin | the disputed payslip |
| `attendance_issue_reviewed` | the employee who raised it | `/my-issues?issue=…` |
| `payroll_issue_reviewed` | the employee who raised it | `/my-issues?issue=…` |

- A decision notification is written **once**, and only after the status change
  has succeeded. A repeated review stops at a 409 before reaching it.
- The recipient is read from the reviewed row, never from the request.
- Notification failures are logged and never fail the raise or the review.
- Requires the enum values in `20260824000000` and `20260825000000`.
  **Apply `20260825000000` before deploying the code.** The category filter is
  `type.in.(…)` over all four types, and PostgREST rejects the whole filter with
  22P02 if one value is not in the enum — so the wrong order does not merely
  lose the new notification, it stops the entire feed loading, for admins too.

## Access

- An employee may read, raise and re-raise only their own issues. Every endpoint
  pins a non-admin to their own rows regardless of the query string, and the RLS
  policies say the same again for any client reaching PostgREST directly.
- A `?issue=` deep link is a **filter over rows the caller already owns**. An id
  belonging to a colleague selects nothing.
- Only an active admin may resolve or reject, asserted in the route and again
  inside `review_employee_record_objection()` (SECURITY DEFINER).
