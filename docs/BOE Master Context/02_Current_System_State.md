# BOE TASK MANAGEMENT

# Current System State

Last Updated: September 2026 — Order Management state, routes, storage and permissions. See "Order Management — where it stands".

**Branch — Order Requests retired, and one payment classification.** The Order
Request workflow is retired; PI Drafts are the only pre-approval Order workflow,
and a Confirmed Order arises only from an approved PI. Payments carry one
canonical classification — Orders, PI Drafts, Available — computed by the
database. Both are described below and are **not yet applied**: they arrive with
migrations `20261007000000` and `20261008000000`, which have not been pushed.

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

Status: **Phase C, the advance-amount declaration, and Payment Phases 1, 2 and
the verification hotfix are all applied to production** (production `main` is
`f5613dea8adabe7b5065ddd00651dcb59a18dc16`; migration history matches through
`20260920000000`).

**One forward migration is written and unapplied:**
`20260921000000_order_submission_verified_payment_gate.sql` — Payment Phase 3,
which moves the final-approval gate off the DECLARED advance and onto
**Finance-verified payment**, and moves a PI's allocations onto the Order it
becomes. See *The payment gate on final approval* below.

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
2. **Submit.** Until Phase 3 this meant declaring an advance **amount**. From
   Phase 3 the employee declares nothing: the database reads how much
   Finance-verified payment the PI has, and either the standard requirement is
   met or a reduced-payment exception is raised — with a mandatory reason and
   mandatory Payment Terms — for a holder of
   `orders.approve_advance_exception`. See *The payment gate on final approval*
   below.
3. **Finance verification** (Phase C). A finance authority signs off that the
   commercial figures and advance terms are correct.
4. **Final approval** (Phase C). A PI reviewer approves, and exactly one
   Confirmed Order is created with an official four-digit number.

Management can send the PI back (`Needs Changes`) or end it (`Reject`) at any
point while it is submitted — **including after finance has verified it**. A
verified PI is not an approved one.

### The advance declaration — the rule

**The employee declares an AMOUNT in rupees. The percentage is derived from it.**
What a client agrees to is a figure; "40%" is what that figure comes to. The
Submit for Approval dialog offers three mutually exclusive choices:

| Choice | Amount | Reason | Route |
| --- | --- | --- | --- |
| **Advance: 40% or above** | at least `grand_total × 40 ÷ 100`, at most the grand total. Pre-filled with the exact 40% figure and editable | none | standard — no exception, no decision |
| **Reduced advance: below 40%** | above ₹0 and below `grand_total × 40 ÷ 100` | **mandatory** | the existing Admin advance-exception workflow |
| **No advance: 0%** | fixed ₹0, no editable field | **mandatory** | the same exception workflow |

**Classification uses the amount, never a displayed percentage.** ₹39,999.99
against a ₹1,00,000 grand total is 39.99999%, which *rounds* to 40.00 — it is a
reduced advance all the same, because the amount is a paisa short of the
requirement. The comparison is `advance_declared_amount` against
`grand_total * 40 / 100` in exact numeric arithmetic, as a table CHECK.

**The derived percentage is truncated to two decimal places, never rounded up**,
so no screen and no stored figure can claim the requirement is met by an amount
that does not meet it — and so an exception percentage stays strictly below the
40 its applied constraint demands.

**The 40% reference figure is the ceiling to the paisa.** 40% of ₹100.01 is
₹40.004, which nobody can pay; rounding gives ₹40.00, which is *below* the
requirement. `order_submission_standard_advance_amount()` gives ₹40.01 — the
smallest real figure that satisfies "at least 40%" — so the amount the dialog
pre-fills is always one the database accepts.

**An amount and the total it was measured against cannot disagree.** Replacing
the parse changes `grand_total`; a BEFORE UPDATE trigger clears
`advance_declared_amount` in the same statement, for every caller including the
service role. The PI is in draft or needs-changes at that point and must be
resubmitted anyway, which writes a fresh amount against the fresh total.

**Records written before this existed keep working.** `advance_declared_amount`
is NULL on every PI declared earlier, and NULL is read as what the record has
always meant — the standard 40% of its current grand total, or its stored
exception percentage of it. `order_submission_effective_advance_amount()` is the
single place that rule lives, mirrored in `advanceRequirement.ts`. A legacy
approved exception resubmitted at its equivalent amount stays approved.

**Nothing here is a payment.** No payment is created, requested, verified,
linked, allocated or reconciled, and no Finance table is read or written. The
dialog says so: *"This records the advance amount declared for this PI. Payment
verification and linking will be added separately."*

`submit_order_submission_with_advance_amount(uuid, text, text, numeric, text)` is
the door the screen uses. The three applied doors —
`submit_order_submission`, `submit_order_submission_with_note` and the
percentage-carrying `submit_order_submission_with_advance` — keep their exact
names, signatures and behaviour, and all four run one implementation.

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

**Payment Phase 1 (`20260918000000`) does not change that.** It adds
`finance_payment_allocations` — a child of `finance_payment_requests` recording
how much of one payment is claimed by one PI or one Order — plus
`allocate_payment_to_target()`, `reverse_payment_allocation()` and the two
protected actions `finance.allocate` / `finance.allocate_correct`. A payment's
unallocated balance is DERIVED (amount minus the sum of active allocations) and
never stored; allocations are reversed, never deleted. An UNVERIFIED payment may
be allocated — verification is the parent payment's status, read through
`finance_payment_status_is_verified()`, and is never copied onto the allocation.
All three foreign keys are NO ACTION, so no deletion path reaches an allocation
implicitly; only deleting an unverified payment releases its own.

**Payment Phase 2 (`20260919000000`, not applied)** adds the entry point: one
atomic RPC `record_pi_submission_payment()` that records a payment and allocates
it in full to a PI in a single transaction, a `pi_submission_payment_summary()`
read that computes the card's five figures in `numeric` in the database, the
participant SELECT visibility Phase 1 deferred, and one Payments card on the PI
detail page. `received_in` becomes optional so only amount, date and mode block
entry. A PI payment is `pending_approval` — shown as *Awaiting Verification* —
and the existing Finance verify / correct-and-verify / reject authority is the
only thing that changes that. **Payment Phase 2 left Order approval eligibility exactly as it was** — the
declared advance, with no payment figure gating anything. See
`docs/Module Docs/FINANCE_ORDER_WORKFLOW.md` §9a.

**Payment Phase 3 (`20260921000000`, written and NOT applied)** is what changes
it. See *The payment gate on final approval* below and
`docs/Module Docs/FINANCE_ORDER_WORKFLOW.md` §11.

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
- **Phase 3 (unapplied):** verified payment allocated to the PI is at least the
  exact 40% of its grand total, **or** a reduced-payment exception is approved.
  Summed live from `finance_payment_allocations` under row locks; pending,
  needs-clarification, rejected and reversed all count as nothing;
  *(before Phase 3: the advance requirement was settled — a standard declaration
  whose amount the table CHECK held at 40% or more, or an approved exception);*
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
| `due_date` | the submission's own `due_date` — **superseded, see below** |
| `billing_percentage` | the submission's declared percentage — **added later, see below** |
| `lead_source`, `notes`, `assigned_to` | left null — see below |

> **CORRECTED — September 2026.** The paragraph that stood here said `due_date`
> is deliberately null, because `dispatch_commitment` is free text ("45 days")
> and there is no safe conversion to a date. **That is no longer true**, and the
> reasoning behind it has been superseded rather than abandoned:
>
> `20260922000000_order_submission_due_date.sql` (PR #46, production) added
> `order_submissions.due_date` — a real `date` column, written **only** from an
> explicit, plausible calendar date the PI itself states. It is never derived
> from the prose beside it, and a PI that states only "45 days" still carries a
> null due date and shows its commitment as words. `approve_order_submission()`
> then carries that column across to `orders.due_date`.
>
> So an Order created from a PI now has a due date whenever the PI stated one,
> and null otherwise — and the free-text commitment is still never converted.
> The rule the old paragraph protected is intact; only its conclusion moved.

`notes` is deliberately empty: addresses, the commercial breakdown and the
advance terms all live on the submission, which the Order names.

### Still excluded

- **No numbered `.xlsx` and no PDF** — *superseded by the branch above.* Both
  are now generated: the Excel by rewriting named cells of the stored workbook
  in place (ZIP surgery, so the anchored photographs, merged blocks and print
  setup survive), the PDF rendered from the record. Versions live in
  `order_document_versions` under a claim protocol with a 15-minute TTL. This
  bullet stands for production, where the register does not yet exist.
- **No Order product lines.** Orders have never had product-line storage. The
  approved submission and its items remain the authoritative PI snapshot,
  reached through `order_submissions.order_id`.
- No payment linking, split-payment allocation, payment recording or
  reconciliation.
- No post-approval commercial amendment — *narrowed by the branch above.* An
  approved PI remains terminal to its owner and to every reviewer. An ACTIVE
  ADMIN may correct it, with a mandatory reason: descriptively through
  `Edit PI Details`, or commercially by replacing the workbook through Change
  PI. Neither creates a second Order, moves an Order number, re-allocates a
  payment or rewrites a generated file. `amend_order()` remains the way to
  change an Order's own terms.
- No production tracking, dispatch gate or notification.

### The payment gate on final approval (Phase 3, `20260921000000`, unapplied)

**An Order number is assigned only when at least 40% of the PI's grand total has
actually been received and verified by Finance, or when an authorised approver
has approved proceeding on less — including on nothing.**

```
payment-ready  ⇔  verified >= grand_total * 40 / 100        the standard route
                  OR advance_exception_status = 'approved'  the reduced-payment route
```

* `verified` is summed **at the instant of approval, under row locks**, from
  active allocations naming the PI whose parent payment is verified by
  `finance_payment_status_is_verified()`. Never a stored column, never a figure a
  caller sent, never a displayed percentage.
* Exact `numeric` comparison. 40% of ₹100.01 is ₹40.004; ₹40.00 displays as "40%"
  and does not meet it.
* **The declared advance decides nothing.** `advance_declared_amount` is retained
  in full for historical records and re-documented as legacy; new submissions do
  not ask for it. `order_submission_advance_ready()` still exists and is no longer
  consulted.
* Below the requirement — zero included — the PI may still be submitted for
  management review, but a **reason** and **Payment Terms** are mandatory and the
  existing advance-exception route decides it. No Order number is assigned until
  it is approved. Rejection returns the PI to Needs Changes, as before.
* The **PI Finance check** remains required and remains a separate authority.
  Verifying a payment does not stamp it, and it says nothing about money arriving.
* **Payment Terms** and **Billing Terms** are new plain-text columns on
  `order_submissions` — the agreed collection and invoicing arrangements. Never
  parsed; no instalments, schedules, due dates or reminders.
* At approval, the PI's **active allocations MOVE onto the new Order** in the same
  transaction — one `UPDATE`, no payment row created or copied, ids and provenance
  unchanged. `finance_payment_allocations_guard_transition()` is restated to admit
  exactly that one move, which `20260918000000` §6 said Phase 3 would have to do.

**Found by the pre-deployment audit of PR #45, and fixed in the same unapplied
migration:** an allocation could race the approval and strand money (the
allocation door now locks the PI before the payment); an approved exception
outlived what it was a decision about (four `advance_exception_decided_*` columns
plus `order_submission_exception_current()`); Test Data Cleanup lost a converted
chain's payments; a rounded percentage could display "40%" beside a gate that
refuses; and the notification helper's PostgREST shape was wrong.

**The blocker that audit recorded is now fixed in the same unapplied
migration.** After the move the parent payment still reads `approved_unlinked`
with no `order_id`, so a linked/unlinked split reading the parent columns alone
would misclassify it and the counters would over-report. It cannot be fixed by
linking the payment — `approved_linked` requires `order_number`, which on a PI
payment holds the salesperson's reference. The ledger is therefore left alone and
the READ is corrected: §8a of `20260921000000` adds
`public.finance_received_payments`, a `security_invoker = true` projection
carrying `is_order_allocated` / `allocated_order_id` / `allocated_order_number`.
**Parent linkage fields remain for backward compatibility; active allocations are
authoritative for current confirmed-Order linkage; the Finance Linked/Non-Linked
lists, their counters and the Admin Action Queue's suspense item read the
allocation-aware projection; and no payment record is copied during PI
conversion.** See `docs/Module Docs/PAYMENT_PHASE_PROGRESS.md`.

### Migration

`supabase/migrations/20260915000000_order_submission_final_approval.sql` —
**applied to production** (merged as `91748e9`).

### Test status

All Phase C suites pass, plus every pre-existing PI, permission, deletion and
advance suite. The full repository suite shows **9 failures, identical to the
starting commit** — all of them live-database tests requiring `.env.local`
Supabase credentials. TypeScript and the production build are clean; ESLint is
unchanged from baseline (5 pre-existing problems, none in Phase C files).

Phase 3 adds three suites — `paymentGate.test.ts`, `orderPayments.test.ts` and
`verifiedPaymentGateSchema.test.ts` — plus
`supabase/tests/pi_verified_payment_gate_assertions.sql`, and leaves the same 9
environmental failures and the same 5 ESLint problems.

The database guarantees were additionally proven by applying the real migration
history to a **throwaway local PostgreSQL 16** and exercising the workflow
end to end: the two-authority split, blocking before verification, pending and
rejected exceptions, missing workbook and images, deletion reservation,
staleness across a resubmission, two concurrent approvals producing exactly one
Order, a retry allocating no second number, and a failed approval leaving the
cycle untouched.


### Test Data Cleanup and the PI provenance pair

Status: **`20260916000000_order_submission_test_cleanup.sql` written, UNAPPLIED,
awaiting Nishant's approval.**

#### Two defects, not one

**A — the reported one.** Phase C's provenance link points both ways, and both
sides are `NO ACTION`:

```
order_submissions.order_id           ->  orders(id)
orders.source_order_submission_id    ->  order_submissions(id)
```

Neither row can be deleted while the other exists.
`execute_test_data_cleanup()` knew only how to release the older Order Request
pair, so removing a test Order created from an approved PI failed in production
on Order 0001 with a raw foreign-key violation.

**B — found in review of the first fix.** Purging storage in one call and
deleting rows in another is **unsafe**, and the comment claiming "a storage
failure leaves a complete, retryable record" was **false**:

* `removeAllObjectsForSubmission()` deletes in batches and reports failures
  *afterwards*, so a partial success is a real outcome;
* even a completely successful sweep is followed by a *separate* database call
  that can refuse — cleanup disabled meanwhile, eligibility changed, a dropped
  connection, a closed laptop.

Either way an approved PI survives **with its workbook and product images
destroyed** — silent, permanent, and indistinguishable from a healthy record.

#### The fix: a durable claim

The remedy 20260914000000 already uses for ordinary PI deletion.

1. **`begin_test_data_cleanup(root, reason, confirmation)`** — every gate, the
   chain resolved, the rows locked, the provenance pair proved, the permanent
   audit written, and a durable claim taken. Nothing is destroyed. The Order and
   the PI are **frozen**: no competing claim, no mutation.
2. The server route removes Order Request attachments and PI files with the
   bounded, fully-settled sweeps. Both read their keys from the database.
3. **`finalize_test_data_cleanup(token)`** — re-lock, re-validate, open the
   cleanup context, break the Order's reference to the PI, delete the PI and its
   children, delete the Order, complete the audit, reclaim the freed Order
   numbers, consume the claim.

**Failure handling, and the distinction it turns on.** `removed` is what storage
*confirmed*; it is not what storage *did*. A `.remove()` can delete every key it
was given and then lose its response to a network or gateway failure — the client
sees a throw, or a reply naming nothing. **"Not confirmed removed" is not
"nothing removed"**, and releasing on an absent confirmation unfreezes a record
whose files are already gone.

So the helpers report a second, separate fact — `removalAttempted`, set
immediately *before* each remove request goes out, and also delivered through an
`onRemoveAttempt` callback so the caller knows even if the helper throws and
returns nothing. The claim is released **only when it is positively proven that
no destructive request was issued** — in practice, a listing or metadata read
that failed first. Any failure at or after a remove attempt keeps the claim: the
rows stay untouched, the records stay frozen, and running it again re-claims,
removes what remains and finalizes. Finalization is **idempotent**, so a lost
response is safe.

A false-positive reservation is acceptable and recoverable — one more click
finishes it. Releasing after uncertain deletion is not.

**Why the claim, not the settings row, authorises finalization.** Once a file is
destroyed there is no way back, so refusing to finalize would leave exactly the
corruption this design prevents. The five gates are enforced at claim time, when
nothing has happened; a cleanup disabled between the steps stops the *next* claim
and does not strand this one.

**The single-call door is closed.** `execute_test_data_cleanup()` is retired — it
raises `CLEANUP_USE_CLAIM_PROTOCOL` rather than being dropped, so a stale client
gets a message instead of a missing function.

#### Deletion order

`clear orders.source_order_submission_id` → `delete order_submissions` (items,
images and activity cascade) → `delete orders` (its activity cascades). Both
directions of the mutual foreign key hold at every moment. Three guards gain the
**existing** `boe.cleanup_context` exemption the Order, Order Request and payment
guards have carried since 20260705000000. Neither foreign key is dropped, altered
or made deferrable.

#### How a PI is judged to be test data

`order_submissions` has no `is_test_data` column and does not gain one. An
approved PI's only reason to exist is the Order it produced; the link is
one-to-one in both directions and immutable, so the PI **inherits the Order's
classification** — and the operation is refused, with a reason, if the two rows
do not name each other.

#### Order numbering

Finalization gives back **only the numbers this cleanup freed from the top of the
range**, walking the cycle down while the number immediately below it is one just
deleted. Deleting the only Order, 0001, therefore returns the cycle to 1 and
**0001 is genuinely reusable with no manual repair**. Deleting 0025 while 0050
survives changes nothing. It never advances the cycle, never goes below the
highest surviving Order + 1, and never touches `configured_at` / `configured_by`
— an administrator who deliberately set the cycle to 1000 has said something, and
a test deletion is not a reason to unsay it.

#### The browser makes one request

`/api/orders/test-data-cleanup` owns claim → storage → finalize. The page sends
the root type, root id, reason and confirmation, and **nothing else** — no path,
no submission id, no claim token. The claim token never reaches a response body.
Payment proofs are still removed after the commit, from their own bucket.

#### Also fixed

The Order detail Activity trail rendered the raw event key
`order_created_from_pi_submission`; it now reads **"Order created from PI
submission"**, in the same green as the other Order-created event.

#### Still excluded

Normal PI deletion rules, real Order and real approved PI protection, final
approval, the advance workflow, payments and unrelated UI are all unchanged.

#### Test status

`testDataCleanupPiSchema.test.ts` covers the claim, the freeze, the gate
ordering, idempotent finalization, the deletion order, the number-reclaim rule,
the retired door, the one-request page and the attempted-vs-confirmed release
rule. `submissionFilesServer.test.ts` and `orderRequestAttachmentsServer.test.ts`
cover the destructive-uncertainty contract directly against a fake storage
client: a remove that throws, a remove that returns an error, a response
confirming nothing, one batch succeeding while another loses its response, and a
listing failure before any remove (the one safe release).

The same conservative rule was applied to the pre-existing PI deletion route
(`/api/orders/submissions/delete`), which had the identical hole: it released the
deletion reservation whenever nothing was confirmed removed. The full suite shows **9 failures,
identical to production main** — all live-database tests requiring `.env.local`.
TypeScript and the production build are clean; ESLint is unchanged from baseline.

All ten failure windows were exercised against a throwaway local PostgreSQL 16
with the real migration history applied: partial storage deletion then failure
(rows and claim intact, retry finishes); finalize failing then succeeding once;
a lost response (repeat finalize deletes nothing twice); cleanup disabled between
claim and finalize (new claim refused, existing one still completes); two
concurrent requests (`CLEANUP_CLAIMED_BY_OTHER`); wrong and consumed tokens; real
Order and real PI impossible to claim; no orphan in either database or storage;
Order Request and payment cleanups unchanged; and Order 0001 reissued to a new
Order afterwards.


---

## Order Management — where it stands, September 2026

**Read this section for the status of anything below it.** Order Management is
now the module under active development, and the work sits at three different
levels of doneness. Nothing here blurs them.

| Level | Meaning |
| --- | --- |
| **Production** | Merged to `main` and applied to the production database. |
| **Branch** | Complete on `claude/confirmed-order-handoff-performance`, reviewed as a draft PR, **not merged and not applied anywhere**. |
| **Planned** | Decided, not built. |

### Production

* **PR #46 — the two PI screens, and a real due date.**
  `20260922000000_order_submission_due_date.sql`. `order_submissions.due_date`
  is a stored `date`, written only from an explicit, plausible calendar date the
  PI states, backfilled for existing rows and never derived from
  `dispatch_commitment`. `approve_order_submission()` was re-emitted to carry it
  onto `orders.due_date`, and `dueDateContinuity.test.ts` diffs the re-emitted
  function against the applied one to prove the due date is the *only* thing
  that moved in a 435-line SECURITY DEFINER function that allocates Order
  numbers and moves money.
* **PR #47 — the PI summary, and a declared billing percentage.**
  `20260923000000_order_submission_billing_percentage.sql`. Both
  `order_submissions` and `orders` gain `billing_percentage numeric(5,2)`,
  nullable, bounded to 35–100 by a CHECK. **Undeclared is a real state** — not
  0, not 100 — and no row is backfilled. `set_order_submission_billing_percentage()`
  is the only writer; `approve_order_submission()` was re-emitted again to carry
  it across, with `billingContinuity.test.ts` proving the same single-difference
  property.

### Branch — `claude/confirmed-order-handoff-performance`

Ten migrations, **all now applied to the linked project** — see the status table
in 03_Development_History, which also records why `20261001000000` must precede
the two after it. Applied is not deployed: this branch is still unmerged.

The branch now covers three things beyond the handoff itself: **the confirmed
Excel and PDF**, **correcting a PI after import** (a direct edit for anything
descriptive, Change PI for anything a workbook formula touches — 05_Business_Rules
has the field-by-field table), and **an admin's authority to correct a PI after
it has been submitted or approved**, with the Order's identity, its number, its
payments and its allocations all preserved and its ready documents superseded
rather than overwritten.

* **The Confirmed Order handoff.** `/orders/[id]` shows the approved PI it came
  from: the client and both parties, the schedule, Total before GST, the billing
  percentage and its derived value, the product lines with their photographs,
  the full commercial breakdown, and a download of the original uploaded
  workbook. Order-side commercial values are **read from the linked PI**, not
  duplicated onto `orders` — that is a standing decision, and GST and the
  pre-GST total have no `orders` column and are not to be given one.
  **The whole panel keys off one column, `orders.source_order_submission_id`**,
  which `approve_order_submission()` writes and nothing else does. An Order
  therefore carries a PI only if it was created by approving one; an Order made
  directly, or converted from an Order Request, never will. That column must
  never be backfilled by hand to make the panel appear — it is immutable once
  set and financial history hangs off it.
  An Order with no linked PI is **told so in a short read-only panel**. The
  first cut rendered nothing at all, on the reasoning that an absence needs no
  explanation; in use that silence was indistinguishable from the feature not
  being deployed, and was read that way. `supabase/tests/order_pi_handoff_eligibility.sql`
  reports which Orders qualify and why the rest do not.
* **A second visibility door, deliberately separate from the first.**
  `can_view_order(uuid)` is SECURITY **INVOKER** so it asks the existing `orders`
  SELECT policies rather than restating them. `can_view_order_submission_via_order()`
  composes it with the PI→Order link. PI-REVIEW visibility
  (`can_view_order_submission`) is untouched: holding `orders.approve_order`
  still confers no Order standing, and an operations lead still holds no PI
  review access.
* **Document generation.** `public.order_document_versions` is a register of
  user-facing document versions with an atomic, token-bearing claim. `ready` is
  impossible without both files — a CHECK constraint, not a convention. A
  version is a business fact; an attempt is a technical one and lives in
  `attempt_count`, never as a second row.
* **Confirmed Excel.** The client's own workbook with the Order number written
  into `B20`, by ZIP surgery on the existing OOXML/fflate toolkit. Every other
  entry comes back with the bytes it went in with, and the rebuilt package is
  re-opened and validated before it is published.
* **Confirmed PDF.** A BOE-designed rendering on the existing pdfkit + sharp
  setup, byte-deterministic for one model. **Amounts read `Rs.`, not `₹`** — the
  built-in PDF fonts cover Latin-1 only and this repository owns no licensed
  Unicode font asset. A presentation limitation, printed on the document itself;
  no figure is affected.
* **The number reset.** `reset_confirmed_order_number_cycle(claim_token)` returns
  the cycle to 1 behind six gates. **It has not been run and this branch runs
  nothing.**
* **Performance.** Every Order screen's startup was parallelized. No query was
  dropped, cached or derived, and no authority moved out of the database.

### Branch — `claude/order-finance-integration-1e3y36`

Order Management and Finance now describe the same money the same way. **Its
three migrations — `20261004000000`, `20261005000000`, `20261006000000` — are
applied to the linked database. The application code is not merged and not
deployed.**

**The canonical attribution rule.** Active allocations are authoritative; the
payment's direct `order_id` is a fallback used only when no active allocation
exists. A payment allocated to Order Y contributes **nothing** to Order X even
when X is the Order its `order_id` names — which is what stops the same rupee
being counted twice. A reversed allocation counts for nothing and returns the
payment to its link. Attribution across every target, plus what is unallocated,
equals the payment exactly and can never exceed it.

The rule lives once, in `src/lib/finance/paymentAttribution.ts`, and is mirrored
by `order_linked_payment_total()` and by `finance_received_payments`
(`allocated_total`, `attributed_total`, `allocation_state`). A parity test
requires the SQL and the TypeScript to agree on the same worked examples; a
runnable SQL assertion file proves the figures against rows.

**Money is exact.** All comparison and summation happens in exact decimal on
`bigint`; `numeric` crosses PostgREST as the string it arrives as and is never
routed through a JavaScript double. One formatter, not three.

**Reads are bounded and honest.** PostgREST caps a response at 1000 rows
silently. Every large list read — Finance, Tasks, Quotations, Attendance,
Payroll — now pages, and a partial read raises rather than rendering as a short
list. Filtering, searching and tab counts are server-side; no screen narrows one
page of rows and reports the result as a total.

**Three visibility rules changed, all narrowing.**

* A payment allocated to an Order is readable only by someone who can open that
  Order. It previously read as *"the Order exists"* to every authenticated user,
  because the predicate is `SECURITY DEFINER` and a definer bypasses the RLS it
  was believed to be asking. `can_view_order_as_actor()` is the definer-safe
  form; `can_view_order()` remains correct wherever the call chain is invoker.
* An Order's received total is readable only by someone who can view that Order,
  and returns NULL — not 0, not an error — otherwise, so an inaccessible Order
  and a non-existent one are indistinguishable.
* `can_view_order_as_actor`, `can_read_payment_as_participant` and
  `order_linked_payment_total` each grant EXECUTE to `authenticated` and to
  nobody else. PUBLIC, `anon` and `service_role` are each revoked explicitly, so
  the ACL does not depend on platform default privileges.

Nothing about payment capture, verification, rejection, the 40% advance rule,
exception approval, PI/Order continuity, numbering or documents changed.

### Planned

* A licensed Unicode font asset, so the confirmed PDF can print `₹`.
* The controlled test-data cleanup itself — the tooling is ready; running it is
  a decision, not a deployment.

---

## Order Management — routes, storage and permissions

### Routes (production, unless marked)

| Route | What it is |
| --- | --- |
| `/orders` | Dashboard: PI Drafts, review queue, Confirmed Orders and the money. **Branch:** reworked around the PI workflow |
| `/orders/all` | Every Order the viewer may see, filtered and sorted |
| `/orders/[id]` | One Confirmed Order. **Branch:** gains the approved-PI handoff and the documents card |
| `/orders/drafts` | PI drafts and submissions, with the review queue at the top |
| `/orders/drafts/[submissionId]` | One PI: review, decisions, payments, approval |
| `/orders/import` | Upload a PI workbook and read it back |
| `/orders/requests` | **Branch:** the retired-workflow notice, with an `Open PI Drafts` action |
| `/orders/requests/[id]` | **Branch:** the same notice, plus the Confirmed Order a converted request became where the reader may open it |
| `/orders/notifications` | Order Management notifications |

API routes: `/api/orders/[id]`, `/api/orders/import/process-draft`,
`/api/orders/submissions/*`, `/api/orders/test-data-cleanup`, and — **branch** —
`POST /api/orders/[id]/documents`.

**Branch — removed:** `/api/orders/notify` and `/api/orders/requests/*`. Every
one of them served a step in the retired workflow, and each was reachable by
POST whatever the sidebar offered.

### Storage — the `order-files` bucket

**Private, 10 MiB per object, and it has NO UPDATE POLICY.** That last fact is
load-bearing: with no UPDATE policy a Supabase upsert cannot replace a stored
object, which is what makes "the workbook the approver read is the workbook the
employee uploaded" true.

| Key shape | Written by | Read by |
| --- | --- | --- |
| `submissions/{id}/original/{uuid}.xlsx` | the PI owner, while it is a draft | PI reviewers; **branch:** also viewers of the Order it became |
| `submissions/{id}/images/{item_id}.{ext}` | the save route | as above |
| `orders/{order_id}/versions/{v}/attempts/{n}/approved.xlsx` | **branch** — the server, `upsert:false` | viewers of the Order, and **only once a ready version names it** |
| `orders/{order_id}/versions/{v}/attempts/{n}/approved.pdf` | as above | as above |

The attempt-scoped shape exists because objects are immutable: every write goes
to a key nothing has ever occupied, so a retry never needs upsert. **Publication,
not location, is what authorizes a read** — a partial attempt's output is named
by nothing and is unreachable by every client role, permanently.

### Permission model

| Action | Means |
| --- | --- |
| `orders.view` | module entry only — **never** company-wide sight of every Order |
| `orders.view_all` | company-wide sight. Protected; no preset grants it |
| `orders.create` | upload and own a PI |
| `orders.approve` | convert an Order **Request** (older, unrelated to PI approval) |
| `orders.approve_order` | **PI approval** — the management approval authority. Protected, deny-by-default, granted per employee |
| `orders.approve_advance_exception` | settle a reduced-payment exception. Independent of the above **in both directions** |
| `orders.manage` | amend a Confirmed Order directly |
| `finance.allocate` | record a payment against a PI |
| `finance.approve` | verify a payment |

Order visibility itself is the OR of the `orders` SELECT policies: an active
admin, the operations team, the requester, the assigned user, or an
`orders.view_all` holder. **Branch:** `can_view_order()` is the single predicate
that stands for exactly that, by asking those policies rather than restating
them.

### Document generation architecture (branch)

```
  request  ── as the CALLER, so two RLS policies decide
     │        (a SECURITY DEFINER function could not ask "may this person see
     │         this Order" honestly: inside one, the current user is the table
     │         owner, who bypasses row-level security)
     ▼
  claim    ── as the SERVER. One atomic UPDATE with the eligibility test in its
     │        WHERE clause; a stale claim is reclaimable after 15 minutes and a
     │        takeover mints a new token, locking the old worker out
     ▼
  generate ── confirmed Excel, then confirmed PDF, then both uploads
     ▼
  complete ── only with a live token, and only with BOTH files
```

Retry never creates an Order, never allocates a number and never moves a payment
allocation — asserted structurally in the migration, and behaviourally in
`supabase/tests/order_document_generation_assertions.sql`.

---

# ORDER REQUESTS — RETIRED (branch, not applied)

## The only Order lifecycle

```
  PI upload / import
      ▼
  PI Draft                      ← anything not finally approved stays here
      ▼
  submit for review
      ▼
  Finance / payment conditions
      ▼
  management approval
      ▼
  Confirmed Order               ← only an approved PI becomes one
```

There is no active Order Request creation, list, dashboard card, action,
navigation entry or workflow. **Finance Payment Requests are a different record
on a different table with a different lifecycle and remain fully active** —
raising one, verifying one, correcting one, allocating one and reversing an
allocation all behave exactly as they did.

## What the retirement actually closes

Hiding a screen is not retirement: a route gone from the sidebar is still a POST
away, and an RPC somebody holds a reference to still runs. `20261007000000`
closes the write paths, for every caller including the service role and any
SECURITY DEFINER function:

| Guard | Refuses |
| --- | --- |
| `order_requests_refuse_new` (BEFORE INSERT) | every new Order Request |
| `order_requests_refuse_conversion` (BEFORE UPDATE) | the transition into `converted`, and a new `converted_order_id` |
| `orders_refuse_request_provenance` (BEFORE INSERT) | a NEW Order carrying request provenance |
| `zz_finance_payment_requests_refuse_request_target` | a payment that NEWLY names an Order Request |

Plus the dropped `order_requests_requester_insert` policy — with RLS on and no
INSERT policy, PostgREST refuses the command outright — and EXECUTE revoked from
`public`, `anon` and `authenticated` on ten RPCs, across every overload:
`finalize_order_request`, `resubmit_order_request`, `reapply_order_request`,
`respond_to_clarification`, `edit_order_request`,
`edit_order_request_attachments`, `request_order_request_clarification`,
`reject_order_request`, `convert_order_request_to_order` and
`link_finance_payment_to_order_request`.

None of the guards reads `auth.uid()` and none exempts a role. A retirement an
admin or the service role could step around would not be one.

## Historical compatibility

**Nothing is deleted.** Not one table, column, foreign key, index, row, storage
object or audit entry. `order_requests`, `order_request_activity`,
`order_request_attachments`, `orders.source_order_request_id`,
`orders.source_request_number`, `finance_payment_requests.order_request_id` and
`order_request_number` all stay, and every SELECT policy on them is untouched —
asserted at apply time, so the migration refuses itself rather than shipping a
partial retirement.

* A confirmed Order created by conversion keeps its provenance, and
  `prevent_order_source_request_change` still refuses to alter it. Old Orders
  open exactly as before.
* `finance_payment_requests.order_request_id` is a historical fact about where
  money was parked. Nulling it would rewrite the payment trail — and under the
  canonical attribution rule it has never attributed a rupee, so such a payment
  now reads as **Available**, which is the truth about it.
* Five paths stay executable so nothing is stranded: `admin_delete_order_request`,
  `cleanup_unfinalized_order_request`,
  `remove_unfinalized_order_request_attachment`,
  `admin_list_stale_order_request_drafts` and
  `unlink_finance_payment_from_order_request`. None creates, advances or converts
  a request; the last is the one way historical money reaches a real target.
* If the remaining Order Request data is confirmed test data, it goes through the
  **existing controlled test-data cleanup protocol** (`20260706000000`), not
  through this migration and not as part of applying it.

## Access Control

Two options are no longer registered against Orders, because each existed only
for the retired workflow and would now grant nothing:

| Action | What it meant |
| --- | --- |
| `orders.approve` | convert an Order Request into an Order |
| `orders.can_be_order_assignee` | may be NAMED as an Order Request assignee |

Grants already stored are **not deleted**; they resolve to nothing. Offering
them would be the defect — an administrator would choose an authority nobody can
exercise. `orders.approve_order` is unaffected and is now the only approval
authority in the pre-Order workflow; it was deliberately never `approve`, which
is exactly why the retirement takes nothing away from anybody who reviews PIs.

## Retired routes still answer

`/orders/requests` and `/orders/requests/[id]` render a restrained explanation
with a single `Open PI Drafts` action. Order Request notifications were sent for
months and every one of them carries a request id, so a 404 would tell people
their link is broken. Where the request was converted before the retirement and
the reader can already open the resulting Order, the notice offers that Order
too — a READ, under the reader's own RLS, naming nothing they could not already
see. It offers no control that would restart the workflow and writes nothing.

---

# PAYMENT CLASSIFICATION (branch, not applied)

## The four views

One classification, defined once in `src/lib/finance/paymentClassification.ts`
and mirrored by the `finance_received_payments` projection
(`20261008000000`). Both Order Management and Finance read it.

| View | Means |
| --- | --- |
| **All Payments** | every payment that is not rejected |
| **Linked to Orders** | money attributed to one or more Confirmed Orders |
| **Linked to PI Drafts** | money attributed to one or more PI Drafts |
| **Available to Allocate** | a positive unallocated balance |

**The first three are not a partition, and must not be.** A payment split
between an Order and a PI belongs in BOTH linked views, and a partly allocated
payment appears in `Available` as well as wherever its allocated half went. The
four counts therefore do not sum to `All`, and each is its own exact query.

## The canonical allocation rule

Unchanged from PR #49. Every figure follows it; nothing restates it:

1. Any active allocation → **the allocations are authoritative**, and the
   payment's own `order_id` contributes nothing.
2. No active allocation → the direct linkage attributes the **whole** payment to
   the Order it names.
3. A reversed allocation is a withdrawn claim and counts for nothing.
4. What is left after active allocations is the **available balance**.
5. Attributed + available = the payment amount, exactly.

The two kind totals — to Orders, to PI Drafts — are that same attributed figure
**split by target kind**, and are asserted to sum back to it for every payment in
the database at apply time. A PI has no direct-link fallback, because the schema
has no PI equivalent of `order_id`.

**A retired Order Request attributes nothing**, and that is the rule rather than
a special case: rule 2 names `order_id` and only `order_id`.

## What is deliberately withheld

The projection is `SECURITY INVOKER`, so its allocation sums are what THIS caller
may read. A reader who reaches a payment through PI or Order participation sees
only the allocations naming records they can open — their sum understates the
attribution, which **overstates** the balance.

Overstating free money is the one error direction that must never happen: it gets
the same rupees allocated twice. So `available_balance` is `NULL`, never a
number, unless the caller's sight is complete — company-wide Finance sight
(admins included) or their own submitted payment, the same two cases
`payment_active_allocation_totals()` already treats as complete. A withheld
balance keeps the payment out of `Available` and out of the allocation control.

## Verification is a second axis

Whether the money ARRIVED and whose business it BELONGS TO are different
questions decided by different people, and the surface never merges them.
Awaiting-verification money is real, recorded and allocatable, so it classifies
exactly like verified money and is reported under its own status. **Rejected
money is in no view at all** — enforced by the projection's own booleans, in the
database, so a client that forgot the status filter cannot inflate a total.

**Over-allocated historical payments stay visible as an error state and are never
silently capped.** The capacity trigger refuses to create that state, so a row in
it is legacy data that needs a person, and rounding it away would erase the only
evidence.

## Where it is read

`/finance/received` is one list with four views, selected by `?view=`.
`/finance/received/linked` and `/finance/received/unlinked` forward to it with
the query string intact, so existing bookmarks and `?payment=` deep links keep
working. The Orders dashboard links into the same list; it does not rebuild it.

## Allocation

`allocate_payment_to_target()` is unchanged and remains the only door: it
requires `finance.allocate`, locks the payment, re-derives the balance under that
lock, re-validates that the target exists, is eligible and is visible to the
caller, refuses a duplicate active claim and a rejected payment, and writes the
activity trail itself. The picker offers a permitted Confirmed Order or a
permitted PI Draft — **never an Order Request** — searching by order number, PI
reference or client name, and shows what the target is worth, what it has already
received under the canonical rule, and what is still outstanding.

Neither `orders.view_all` nor `finance.view_all` is widened. A salesperson sees
and allocates only within the scope RLS already gives them.
