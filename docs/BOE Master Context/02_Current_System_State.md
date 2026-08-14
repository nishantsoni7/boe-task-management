# BOE TASK MANAGEMENT

# Current System State

Last Updated: June 2026 (updated after Task Cancellation implementation)

---

# MODULE STATUS OVERVIEW

| Module                 | Status         |
| ---------------------- | -------------- |
| Authentication         | Active         |
| Members Management     | Active         |
| Task Management        | Active         |
| Notifications          | Active         |
| Performance Management | Active         |
| Team Performance       | Active         |
| Sample Tracking        | In Progress    |
| Attendance             | Early Stage    |
| Payroll                | Early Stage    |
| Assets & Access        | Active         |
| Employee Records       | Planned        |

---

# AUTHENTICATION

Implemented:

* User login
* Role-based access
* Password management
* User activation/deactivation
* Password reset by admin
* Self password change

Roles:

* Admin
* Manager
* Employee

Administrative functions are hidden from standard users.

---

# MEMBERS MANAGEMENT

Implemented:

* Employee listing
* Employee activation
* Employee deactivation
* Soft delete
* Restore deleted employee
* Permanent deletion
* Password reset controls

Administrative access only.

---

# TASK MANAGEMENT

Status: Production Active

This is currently the primary operational module used by employees.

---

## My Tasks

Implemented:

* View All
* Self Tasks
* Delegated Tasks
* Search
* Filters
* Priority indicators
* Due dates
* Status visibility
* Create Self Task

Important Rules:

* Self-created tasks display "Assigned By: Self"
* Task ownership is always visible
* Minimal table layout preferred

---

## Assigned By Me

Implemented:

* View delegated tasks
* Track progress
* Review status
* Review activity history
* Open task details

---

## Task Detail

Implemented:

* Current status display
* Activity timeline
* Internal conversation thread
* Attachments
* Due date editing
* Priority editing
* Completion workflow
* Restore workflow
* Cancellation workflow

Important Rules:

* Acknowledge → Working
* Working button removed
* Waiting and Blocked are primary exception states
* Cancelled is a terminal status distinct from Completed
* Cancelled tasks do not count toward completion metrics or performance scoring

---

## Task Cancellation Workflow

Implemented:

* Cancel Task action on task detail page
* Mandatory cancellation reason selection (6 preset options)
* Cancellation confirmation modal
* Post-cancel redirect to Cancelled Tasks list
* Cancelled task card showing reason and cancellation details
* Restore from Cancelled back to pre-cancel status
* Cancellation activity log entry
* Assignee notification on cancellation

Permission Rules:

* Task creator can cancel
* Admin can cancel
* Assignee cannot cancel (unless they are also the creator or admin)
* Server-side enforcement in `/api/cancel-task`

Cancellation Reasons:

* No longer required
* Duplicate task
* Created by mistake
* Requirement changed
* Completed outside system
* Other (requires text entry)

Status Behaviour:

* `cancelled` is a terminal status separate from `completed`
* Cancelled tasks are excluded from all active task lists
* Cancelled tasks are excluded from overdue and needs-update counts
* Cancelled tasks are excluded from performance and team performance metrics
* Cancelled tasks remain visible in dedicated Cancelled Tasks pages for audit and restore

---

## Cancelled Tasks Pages

Implemented:

* `/tasks/cancelled` — My Cancelled Tasks (assigned to or created by current user)
* `/tasks/assigned-by-me/cancelled` — Tasks cancelled that were assigned by current user to others
* Both pages accessible from sidebar navigation under their respective groups

---

## Collaboration Workflow

Implemented:

* Waiting On User
* Waiting Notes
* Blocked Notes
* Unblock Requests
* Supporting Attachments

Purpose:

Reduce communication gaps and make blockers visible.

---

## Activity Tracking

Implemented:

* Status changes
* Notes
* Attachments
* Edit history
* Delete history
* Task restoration tracking
* Cancellation tracking (reason stored in activity log)

Purpose:

Create a complete audit trail.

---

# NOTIFICATIONS

Status: Production Active

Implemented:

* Task acknowledged
* Task completed
* Task cancelled
* Cancellation reversed (restore from cancelled)
* Waiting updates
* Blocked updates
* Comments
* Read/unread tracking
* Bulk delete
* Delete all
* Mark as read

Purpose:

Reduce dependency on WhatsApp follow-ups.

---

# PERFORMANCE MANAGEMENT

Status: Production Active

Performance system officially launched on 8 June 2026.

Historical calculations begin from launch date to maintain fairness.

---

## Today

Implemented:

* Daily score calculation
* EOD submission
* Self rating
* Coaching feedback
* Reflection generation
* Performance scoring

Categories:

* Output
* Momentum
* Discipline
* Risk

Purpose:

Create daily accountability and self-review.

---

## Monthly Performance

Implemented:

* Current Month
* Last Month
* Daily score history
* Submitted days
* Missed days
* Monthly average

Detailed score breakdown available per day.

---

## EOD System

Implemented:

* Daily work summary
* Self rating
* Submission tracking

Purpose:

Provide management visibility without requiring manual follow-up.

---

# TEAM PERFORMANCE

Status: Admin Only

Purpose:

Allow management to identify risks before tasks become overdue.

Implemented:

* Team score visibility
* Attention Required indicators
* Waiting task tracking
* Blocked task tracking
* Overdue task tracking
* Member drill-down views
* Stuck task modal

Current Focus:

Improving root-cause visibility and management actions.

---

# SAMPLE TRACKING

Status: Active Development

Purpose:

Track samples from request through approval, dispatch, delivery, return, replacement, loss, and closure.

---

## Implemented

* Sample request creation
* Approval workflow
* Request editing
* Request deletion
* Dispatch tracking
* Dispatch audit logs
* QR dispatch workflow
* QR slip generation
* Lost sample workflow
* Approval tracking
* Return tracking foundation

---

## Current Development Focus

* Notifications
* End-to-end lifecycle visibility
* Sample accountability
* Customer sample history

---

# ATTENDANCE

Status: Foundation Stage

Implemented:

* Attendance import structure
* Attendance visibility framework

Planned:

* Daily attendance
* Leave tracking
* Monthly attendance summaries

---

# PAYROLL

Status: Foundation Stage

Implemented:

* Payroll engine framework
* Draft payroll generation
* Payroll locking structure

Planned:

* Salary processing
* Incentive calculations
* Payroll reports

---

# ASSETS & ACCESS

Status: Operational (asset lifecycle complete); access credentials still V1

Purpose:

Track company assets through their whole life — purchase, custody, movement,
repair and retirement — and record the access credentials assigned to employees.

Implemented:

* **Individual asset page** — `/assets-access/[id]`, the single source of truth
  for one asset. Five sections: Overview, Assignment History, Repair & Service,
  Warranty & Documents, Activity History.
* **Permanent transfer history** — every movement of custody is an append-only
  record (`asset_transfers`): who or where it came from, who or where it went,
  both departments, the recorded and effective handover dates, condition,
  remarks and who performed it. Nothing is ever edited or deleted; a correction
  is a new entry.
* **Repair & service history** — one record per service event, with type, issue,
  vendor, dates, cost, condition after service and the next service date. Total
  spend, record count, last service and next service are shown per asset.
* **Warranty and purchase details** — purchase date, price, vendor, invoice
  number, warranty start/expiry/type/remarks. Warranty status is **derived**,
  never stored.
* **Asset documents** — invoice, warranty card and supporting files in a private
  bucket, opened only through short-lived signed URLs. Removal is a soft delete
  that is always recorded.
* **Search and filters** on the inventory: one search box across name, code,
  serial, brand, model, holder and location; filters for category, status,
  assigned employee, department, location, condition, warranty status and
  purchase-date range.
* **Asset notifications** — the shared `notifications` table, `asset_*` types,
  its own feed at `/assets-access/notifications` with the same read/unread,
  mark-all-read, delete-one, delete-selected and delete-all behaviour as Task
  Management.
* **Activity history** — an immutable audit trail per asset. No client role
  holds INSERT, UPDATE or DELETE on it, including admins.
* Employee self-service: My Assets, one-time acceptance, My Access.
* Admin-approved edit and removal requests for non-admins.

Not yet done:

* `access_records.secret_value` is still plaintext, so the Access Register
  remains admin-only. Widening it waits for the credential-storage rework.
* No recurring-maintenance automation (a next-service date is recorded and
  displayed; nothing schedules itself).
* Warranty-expiry reminders are produced by a sweep that runs when the inventory
  is opened, not by a scheduler — BOE has no cron for application code.

---

# UI / UX DECISIONS

The following decisions were intentionally made and should not be reversed without strong justification.

---

## Simplicity First

Avoid:

* Overly detailed forms
* Complex workflows
* Multiple pages for simple actions

Prefer:

* Popups
* Inline actions
* Fast completion

---

## Accountability Visibility

Users should always know:

* Who owns a task
* Who assigned it
* Current status
* Pending blockers

---

## Minimal Data Entry

Reduce typing whenever possible.

Prefer:

* One-click actions
* Dropdowns
* Quick updates

---

## Management Visibility

Managers should be able to identify:

* Overdue work
* Waiting tasks
* Blocked tasks
* Missing EOD updates
* Low-performing users

without requiring direct follow-up.

---

# CURRENT PRIORITIES

Priority 1

Sample Tracking completion

Priority 2

Attendance module

Priority 3

Payroll module

Priority 4

Assets & Access completion

Priority 5

Employee Records

---

# KNOWN OPEN ITEMS

* Team Performance refinements
* Sample notification improvements
* Sample lifecycle completion
* Attendance workflow expansion
* Payroll workflow completion
* Mobile UI review and optimization

---

## Access Control V1

Status: **`20260901000000` and `20260902000000` applied to production and parity-
verified (2026-08-14); frontend merged to `main`.** A follow-up migration,
`20260903000000_protected_visibility_actions.sql`, is **written and unapplied** —
it adds three protected, Custom-only actions and corrects a production finding
that `orders.view` was granting company-wide sight of every order through the
blanket SELECT policies in `20260685000000`/`20260686000000`. Applying it
NARROWS Orders visibility for anyone holding `orders.view` without the new
`orders.view_all`. See
[ACCESS_CONTROL_V1.md](../Module%20Docs/ACCESS_CONTROL_V1.md) for the full rule
set, the Finance/Orders asymmetry, and the quotation enforcement limitation.

One administrator workflow — Control Center → Access Control — replaced the two
that could disagree with each other (Module Visibility and Access Control).
The separate Module Visibility navigation entry is gone; `app_modules` itself is
untouched and still governs Showroom QR's department rule and the
Attendance/Payroll self-service cards.

Five access levels: No Access, Viewer, Contributor, Manager, Custom. The former
`editor` and `admin` presets are removed — the `admin` preset granted every
action including `delete` and `assign`.

Nine protected permissions (`delete`, `admin`, `manage`, `assign`, `dispatch`,
`receive`, `mark_lost`, `close`, `can_be_order_assignee`) are reachable only
through Custom. Selecting a standard level clears them after a named
confirmation.

Finance and Orders enforcement moves onto the permission engine for the
protected actions only — approve, manage/correct, delete. View, create and edit
keep their existing ownership rules. Attendance and Payroll management remain
admin-only and are shown as a single non-editable self-service row.

Full detail: `docs/Module Docs/ACCESS_CONTROL_V1.md`.
