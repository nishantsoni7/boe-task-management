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

---

## Order Management — PI submission to Confirmed Order

Status: **Phase C written, migration UNAPPLIED and awaiting Nishant's approval.**
Everything before Phase C is applied to production.

An imported BOE PI workbook (`.xlsx`) becomes a Confirmed Order through one
reviewed workflow. The record is `public.order_submissions`; the Order it
eventually becomes is `public.orders`.

### The workflow

```
draft ──► submitted ──► needs_changes ──► submitted ──► approved
              │                                            │
              ├──► rejected  (final)                        └──► one Confirmed Order,
              │                                                  with an official number
              └──► finance verification, then final approval
```

1. **Upload and parse.** The employee uploads the workbook. Every commercial
   figure and product line comes from a server-side parse
   (`replace_order_submission_parse`, service role only). A browser cannot
   manufacture a price, a quantity or a total.
2. **Submit**, declaring the advance requirement: the standard 40%, a reduced
   percentage, or none. The last two are *exception requests* and need a
   decision from a holder of `orders.approve_advance_exception`.
3. **Finance verification** (Phase C). A finance authority signs off that the
   commercial figures and advance terms are correct.
4. **Final approval** (Phase C). A PI reviewer approves, and exactly one
   Confirmed Order is created with an official four-digit number.

Management can send the PI back (`Needs Changes`) or end it (`Reject`) at any
point while it is submitted — **including after finance has verified it**. A
verified PI is not an approved one.

### Finance verification — the rule

Two authorities, and **neither implies the other**:

| Decision | Requires |
| --- | --- |
| Verify finance | active admin, **or** effective `finance.approve` **with** Finance module entry |
| Approve the PI | active admin, **or** effective `orders.approve_order` |
| Decide an advance exception | active admin, **or** effective `orders.approve_advance_exception` |

`orders.approve_order` grants **no** finance authority, and `finance.approve`
grants **no** PI-approval authority. Both are re-derived inside the RPCs.

**Verification records no payment.** It creates no payment, payment request,
receipt or reconciliation entry, and both dialogs say so in as many words. No
Finance table is read or written anywhere in this workflow.

**A verification goes stale the moment the record moves.** It is bound to the
`submitted_at` it was made against, and a trigger clears it outright on any
status change away from `submitted`. A PI returned and resubmitted must be
verified again. Approval is the one status change that keeps it, because who
signed the figures off is part of the approved record's history.

### Final approval — eligibility

`approve_order_submission(uuid)` re-derives **all** of the following from the
locked row, and refuses on any one of them:

- status is exactly `submitted`, and no Order is already linked;
- the caller is authenticated, active, and holds `orders.approve_order`;
- finance verification is **current** for this submission;
- the advance requirement is settled — standard, or an **approved** exception
  (pending and rejected both refuse, and so does an undeclared record);
- no blocking parse diagnostics;
- the workbook still exists in storage at the exact validated path, as an
  `.xlsx`;
- at least one product line, each with a sequence, a name and exactly one
  representative image, every image key naming its own submission, item, role
  and slot, and every image present in storage;
- no deletion reservation is in flight.

The RPC takes an **id and nothing else**. No total, client name, status or
number is accepted from the caller.

### Atomic Order creation

One transaction does all of it, or none of it:

lock the submission → re-validate → open the approval context → `INSERT` one
`public.orders` row → the existing trigger stamps the number → set the
submission to `approved` with `approved_by`, `approved_at` and `order_id` →
append one activity entry carrying the Order id and its display number.

- **Concurrency.** Two simultaneous approvals produce **one** Order: the second
  waits on the row lock, then returns the existing result with
  `already_approved: true`. A retry after commit does the same. Two partial
  unique indexes — `order_submissions_order_id_key` and
  `orders_source_order_submission_id_uidx` — make one-PI-one-Order a database
  guarantee rather than a property of the RPC.
- **Storage is not in the transaction.** Nothing here uploads or generates a
  file, so no PI can be left half-approved by a storage failure.

### Official numbering — timing

Numbering is unchanged and is **reused, never reimplemented**. The number comes
from `allocate_confirmed_order_number()` via the `orders_assign_display_number`
BEFORE INSERT trigger, which overwrites whatever a caller supplies. There is no
second allocator, no sequence, and no `MAX(display_number)+1` anywhere — in SQL
or in the browser.

**A number is allocated only at final approval.** Draft, submitted,
needs-changes and rejected PIs never receive one. Because the cycle is an
ordinary table row advanced under `FOR UPDATE` inside the caller's transaction,
a failed approval rolls the advancement back and **consumes no number**.

### Order field mapping

| Order column | Source |
| --- | --- |
| `display_number` | the allocator, via the trigger — never supplied |
| `client_name` | submission `client_name` |
| `requested_by` | submission `submitted_by` |
| `created_by` | the approving actor |
| `confirm_date` | `order_confirmation_date`, else the approval date |
| `total_value` | `grand_total` |
| `total_product_value` | `gross_product_amount` |
| `status` | `'running'` |
| `source_order_submission_id` | the submission (unique, immutable, NO ACTION FK) |
| `due_date`, `lead_source`, `notes`, `assigned_to` | left null — see below |

`due_date` is deliberately null: `dispatch_commitment` is free text ("45 days")
and there is no safe conversion to a date. `notes` is deliberately empty:
addresses, the commercial breakdown and the advance terms all live on the
submission, which the Order names.

### Still excluded

- **No numbered `.xlsx` and no PDF.** The repository has no facility that can
  edit the uploaded workbook without destroying its images, merged cells and
  print settings, and no faithful Excel-to-PDF converter. The reserved path
  `orders/{order_id}/versions/{n}/approved.xlsx` stays unwritten. **This is the
  next bounded phase.** Nothing in the employee UI mentions a pending document.
- **No Order product lines.** Orders have never had product-line storage. The
  approved submission and its items remain the authoritative PI snapshot,
  reached through `order_submissions.order_id`.
- No payment linking, split-payment allocation, payment recording or
  reconciliation.
- No post-approval commercial amendment (an approved PI is terminal; changing an
  Order's terms is `amend_order()`'s job).
- No production tracking, dispatch gate or notification.

### Migration

`supabase/migrations/20260915000000_order_submission_final_approval.sql` — one
additive migration, **not yet applied**. Nothing before it is edited.

### Test status

All Phase C suites pass, plus every pre-existing PI, permission, deletion and
advance suite. The full repository suite shows **9 failures, identical to the
starting commit** — all of them live-database tests requiring `.env.local`
Supabase credentials. TypeScript and the production build are clean; ESLint is
unchanged from baseline (5 pre-existing problems, none in Phase C files).

The database guarantees were additionally proven by applying the real migration
history to a **throwaway local PostgreSQL 16** and exercising the workflow
end to end: the two-authority split, blocking before verification, pending and
rejected exceptions, missing workbook and images, deletion reservation,
staleness across a resubmission, two concurrent approvals producing exactly one
Order, a retry allocating no second number, and a failed approval leaving the
cycle untouched.
