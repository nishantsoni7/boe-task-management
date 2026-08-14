# BOE TASK MANAGEMENT

# Business Rules

Last Updated: June 2026

---

# PURPOSE

This document contains operational rules, workflow rules, scoring rules, accountability rules, and business logic that define how BOE Task Management functions.

If a conflict exists between implementation and this document, the business rule should be reviewed before changing system behavior.

---

# GLOBAL PRODUCT RULES

## Accountability Principle

The system should always make it:

* Easier to provide honest updates
* Harder to avoid accountability

Every feature should support this principle.

---

## Simplicity Principle

Prefer:

* Faster workflows
* Fewer clicks
* Less typing

Avoid unnecessary complexity.

---

## Visibility Principle

Users should always be able to identify:

* Current owner
* Status
* Due date
* Blockers
* Assignment source

---

## Form Modal Dismissal Rule

Applies to any modal, dialog, drawer, or pop-up that contains a form or unsaved user-entered data (typed values, selections, toggles).

Users may spend time entering data into these modals. An accidental click outside the modal must never destroy that work.

A form modal may be closed ONLY through:

* the explicit Cancel button
* the × close control in the top-right corner
* the Escape key
* a successful submission, where the workflow already closes the modal

Rules:

* A backdrop, overlay, or any outside-the-dialog click must do nothing.
* A failed submission must keep the modal open with all entered values intact.
* Loading/submitting state must not permit accidental duplicate saves.
* Escape, Cancel, and × close directly — do not add a confirmation prompt for them unless a modal already uses one.
* Read-only detail pop-ups (no form, no unsaved input) may keep click-away-to-close.

This is a permanent product rule for all current and future BOE form modals. Shared modal components expose an explicit `closeOnBackdropClick` flag that defaults to the legacy behaviour; every form-modal usage must set it to `false`.

Two further requirements, learned from the Assets & Access modals:

* The modal must sit **above the sidebar**. `.boe-sidebar` is `position: fixed;
  z-index: 100`, so an overlay below that leaves the navigation live and
  clickable behind an apparently-modal dialog. Overlay 200 / dialog 201.
* Background scrolling is locked for the lifetime of the modal, Tab and
  Shift+Tab cannot leave the dialog, and focus returns to whatever opened it.

The rule itself is code, in `src/lib/ui/modalDismissal.ts`, and is not
re-decided inline by any component.

---

## Asset Ownership Rule

An asset whose status is `Assigned` MUST resolve to a named custodian, and an
asset that is not assigned must NOT claim one.

Both halves matter. A row showing "Assigned" with a blank holder is an
accountability hole; a row showing "Available — held by Priya" is worse, because
it reads as settled. The custodian is therefore never a stored string that can
drift out of step: it is derived from the live custody row every time it is
shown, and a contradiction between the two is displayed **as** a contradiction
("Assigned — custodian missing"), never smoothed over into an empty cell.

Custody does not end when an asset goes for service. The person it is charged to
stays accountable while a vendor has it; the asset's own status says where it
physically is.

---

## Asset History Rule

An asset's movement, custody, service and audit history is permanent.

* Movement records (`asset_transfers`) and audit records
  (`asset_activity_log`) are **append-only**. No client role holds UPDATE or
  DELETE on them, and neither does an admin. The database refuses the write, not
  just the UI.
* A correction is a **new entry** that names what it corrects. History is never
  edited in place, and never silently.
* An asset that has ever been assigned, moved, serviced, or has a document on
  file **cannot be deleted**. Deletion exists for a mistaken inventory entry —
  something nobody ever held — and for nothing else.
* Removing a document is a soft delete that is always recorded. The stored file
  is retained.

---

## Asset Warranty Rule

Warranty status is **derived, never stored**:

| Status | Meaning |
| --- | --- |
| Active | An expiry date is recorded and has not passed |
| Expiring Soon | Active, and within **30 days** of expiry |
| Expired | An expiry date is recorded and has passed |
| Not Available | No expiry date recorded |

"Not Available" is not "Expired". Almost every asset that predates the module is
in that state, and it is a legitimate permanent state rather than missing data.

A stored status column would be a second copy of a fact that changes by itself
every midnight, and would be wrong on any row nobody happened to touch that day.

---

## Asset Repair Cost Rule

Service costs are `numeric(14,2)` and arrive from PostgREST as **strings**.
Adding them with `+` concatenates rather than sums. Every total goes through
`totalServiceCost` in `src/lib/assets/service.ts`, which parses each value,
contributes 0 for an unreadable one rather than making the whole total `NaN`,
and rounds to paise. All amounts display with Indian digit grouping.

---

## Asset Notification Rule

Notifications are created for changes to **ownership, assignment, transfers,
requests, status, loss, recovery, return, repair and warranty expiry** — and for
nothing else. Editing a serial number or a description does not notify: it is
already in the activity history, and notifying on it would train people to
ignore the bell.

* The actor is **never** notified about their own action. Filtering happens at
  one place in `/api/assets/notify`, so a new event cannot forget it.
* Duplicate rows for the same `(recipient, type, asset)` inside two minutes are
  suppressed, so a retry or a double-click cannot double-notify. Warranty
  reminders use a seven-day window.
* Notifications are written **after** the transaction commits. A failed
  notification must never roll back a movement that physically happened.

---

## Order Request Attachments

Every new Order Request carries file attachments in two categories:

* **Main PI** — the primary commercial document (Proforma Invoice). **Mandatory**, and **exactly one** per submitted request. Enforced in the database: a partial unique index caps it at one, and finalization (below) refuses to submit a request unless exactly one Main PI exists — so the rule holds even if the UI is bypassed.
* **Other Reference Attachments** — optional supporting files (drawings, reference images, specifications, client documents). Zero or many are allowed.

Rules:

* **Accepted types.** The **Main PI** accepts **Excel only — .xlsx or .xls**. A PI PDF or scan belongs under reference attachments instead. **Reference attachments** accept PDF, JPG/JPEG, PNG, WEBP, Word (DOC/DOCX), Excel (XLS/XLSX), CSV and TXT. Executables, macro-enabled Office formats (.docm/.xlsm/…), unknown binaries, ZIP archives (excluded pending a separate product decision) and raw CAD (DWG/DXF) are **not** accepted. Validation is extension-first: the file extension must be allow-listed (blocking double-extension tricks like `x.pdf.exe`), a reported browser MIME must be consistent with it, and the file is uploaded under its canonical MIME so a spoofed type cannot slip through. An unsupported file is refused with a message naming what that category allows.
* **File size — the stored file is never larger than 10 MB.** Separate the two sizes that matter:
  * **Original selected size** — may legitimately exceed 10 MB. The employee picks whatever they have; it is the app's job to deal with it, not theirs.
  * **Final uploaded size** — **must always be 10 MB or less** (10 × 1024 × 1024). This is the BOE product rule. A file over the limit is either reduced below it by a safe, format-specific processor or **refused**; the original oversized bytes are **never** stored.
  * The limit is enforced **twice, independently**: the frontend constant gives the employee a useful message before any upload, and the Storage bucket's `file_size_limit` refuses oversized objects regardless of what any client believes. The two must always be changed together.
  * **The Supabase project-wide Storage ceiling (50 MB on the current plan) is infrastructure headroom, not permission.** It must never be presented to an employee as the accepted attachment size, and the bucket must not be raised toward it.
  * **Images over 10 MB** are compressed automatically toward ~8 MB, leaving safe overhead — conservatively (generous resolution cap, high quality floor, EXIF orientation honoured, never upscaled), so drawing dimensions, finishes, labels and specifications stay legible. Compression **stops as soon as the target is reached** instead of degrading further. Transparency is preserved: a PNG is re-encoded losslessly as PNG and a WEBP as WEBP; either is flattened onto white (as JPEG) only as a last resort, and the file extension is rewritten to match whatever format was actually produced. Both the original and final size are recorded and shown. Only the processed result is uploaded. If it still cannot fit, that file is **refused** per-file with a clear message, and the rest of the selection is kept intact.
  * **Images at or below 10 MB, and every in-limit file of any accepted type, are stored unchanged.** A normal Excel Main PI therefore reaches Storage byte-for-byte and downloads exactly as submitted — formulas, formatting, drawings, merged cells, links and print settings preserved by construction, not by hopeful re-encoding.
  * **Non-image formats over 10 MB are currently refused** (Excel, PDF, Word, CSV, TXT). The app has no safe automatic reducer for them: rewriting a workbook or re-containerising an already-compressed format without validating the result risks silently corrupting a commercial document, so the app refuses rather than pretending it compressed something. The message states plainly that the app cannot reduce that format — it never claims an attempt that did not happen, and never implies larger files are accepted. *(Safe `.xlsx` embedded-media optimisation is under evaluation as a possible future addition; until it exists and is validated, refusal is the correct behaviour.)*
  * The application **never** converts Excel to PDF or images, wraps a workbook in a ZIP and calls it the Main PI, strips workbook data, or claims a compression it did not perform.
* **DB-backed finalization — a request is submitted only after the Main PI is verified.** Creating a request first makes an **upload-stage draft** that is invisible to reviewers and assignees, excluded from every list and count, and fires **no notification and no `request_submitted` activity**. Only when the database has verified **exactly one Main PI** (`finalize_order_request`) does the request become an operational submission, at which point its notification and `request_submitted`/`attachments_uploaded` activity are written. Finalization is idempotent: a retried finalize on an already-finalized request is treated as success but writes no second activity row and sends no second notification (the notification fires only on the call that performs the first transition). If the Main PI or any selected reference fails, the whole draft is rolled back (files + row removed) and the form stays open with every value and selection intact — no success is reported and no reviewer is notified. A selected reference is never silently dropped.
* **Interrupted sessions & stale drafts.** An interrupted upload leaves only an invisible draft. A creator may discard their **own** unfinalized draft automatically on their next visit **while it is less than 24 hours old** (objects removed first, then the row, so nothing is orphaned). Drafts **24 hours or older** are never touched by that self-cleanup; a **non-creator admin** may clean them only through the defined admin route (`admin_list_stale_order_request_drafts`, which lists drafts past the stale threshold, then `cleanup_unfinalized_order_request`), never silently treated as resolved. Assignment access to a request begins only after finalization.
* **Storage & access:** attachments live in a **private** bucket and are reached only through short-lived signed URLs — never public URLs. Access is enforced by database RLS and storage policies, not only the frontend, and depends on whether the request is still a draft:
  * **Unfinalized draft** — an upload-stage draft is the creator's incomplete submission workspace, so it is visible and manageable **only by its creator/owner (created_by / requested_by) and admin**. A person the request is merely *assigned to* (but did not create) has **no** access to the draft: they cannot see it, read its attachment metadata, generate signed URLs, upload objects, finalize, or clean it. When an admin creates a request **for** a salesperson, the admin completes the form, uploads the mandatory Main PI, and finalizes it; the assigned salesperson participates only afterwards.
  * **Finalized request** — assignment access begins. The full participation set (admin, the requester, and the person it is assigned to) may read attachment metadata and open files through signed URLs; a converted request keeps them viewable as history.
  * PDFs and images open inline; other reference formats (Word/Excel/CSV/TXT) are served as a **download** (attachment disposition), never rendered inline. Attachments may be written **only during the upload stage** (creator/owner/admin); once a request is finalized no one — admin included — can add an object or remove the Main PI through an ordinary client Storage call (direct storage DELETE is draft-only).
* **Accountability & deletion:** attachments remain associated with the request as history. A converted request keeps its attachments viewable and never allows deletion. Removing a **finalized** request's objects happens only as part of deleting the whole request, through an admin-authenticated, request-scoped, **service-role cleanup API** — invoked by both admin request-delete and admin Test Data Cleanup after the database deletion rules (which refuse converted requests) have run. A storage-cleanup failure is always surfaced, never reported as a clean deletion.

---

## Payment Request Targets

A Payment Request is always raised against **exactly one of three** stages of the sales lifecycle. They are different business stages — not three shades of one option — with different linkage, different permissions and different approval behaviour, so the submission form offers all three explicitly and never folds two together.

* **New Order** — money has been received or reported, and **no Order Request and no Confirmed Order exists yet**. The client name is typed by hand. The payment stays **unallocated** until someone attaches it to a real record later.
* **Order Request** — an Order Request already exists and has **not** been approved or converted, and the payment is the advance against that proposed order. The salesperson selects it while submitting, by searching on request number or client name.
* **Confirmed Order** — the order is approved and carries an Order number, and the payment belongs to that Order.

Rules:

* **One target, never two.** A Payment Request may hold no linkage, an Order Request linkage, or a Confirmed Order linkage — never both linkages at once. Enforced in the form (switching target clears every incompatible field, including the client name), in the submission mapping, and by a database CHECK constraint.
* **Only eligible Order Requests may be selected**, and only ones the submitter may actually use: an admin, the request's creator, the person it was requested for, or the person it is assigned to. A salesperson can never attach money to another salesperson's request. A **converted**, **rejected**, or unfinalized-draft request cannot receive a new payment request. All of this is enforced server-side, in the database, on every write path — the search filters exist to save a round trip, never as the control.
* **Nothing the client sends about the target is trusted.** The Order Request number and the client name are **derived from the database row**, not from the payload. Selecting an Order Request takes the client name from that request; selecting a Confirmed Order takes it from that Order.
* **The payment appears on the Order Request immediately**, with its real financial status — pending approval, needs clarification, rejected, or approved. The Order Request timeline records the association from **submission time**, not from approval.
* **Only an approved payment is received advance.** A pending, clarification or rejected payment is shown on the request and counted separately; it is never added to the advance figure, never presented as money received, and never described with "received" wording before Finance has approved it.
* **Approval keeps the linkage.** When an admin approves a payment raised against an Order Request, the money is confirmed received **and stays attached to that request** until the request is converted. Approval revalidates that the request still exists, is still active, and has not been converted; if it has, approval **fails with a clear error** rather than quietly turning the payment into an unallocated one.
* **The target may be corrected before approval, and the correction is audited.** While a payment is still the submitter's to edit (pending approval, needs clarification, rejected) its target can be changed, and both the payment's own history and the affected Order Request timelines record it. Once approved, the target is frozen.

## Order Request Approval Requirement

**An Order Request cannot be approved or converted into a Confirmed Order unless at least one approved payment is linked to it.**

* Only a **financially approved** payment counts. Pending approval, needs clarification and rejected payments do not, in any combination.
* An Order Request also cannot be converted while a payment linked to it is **still awaiting a Finance decision**. The admin approving the order must have finished reviewing the money raised against it. A rejected payment is a decision and does not block; it stays on the request as history and never transfers.
* The rule is enforced **inside the database function that performs the conversion**, before any Order is created and before any Order number is allocated. A refused conversion creates no Confirmed Order, does not mark the request converted, does not allocate a number, and returns a clear error. The frontend states the same rule before the click, but it is never the control.
* On a successful conversion, approved linked payments **transfer automatically** to the new Confirmed Order and keep a record of the request they came from. Payments that were not approved do not move.

---

## Confirmed Order Amendment Rule

A Confirmed Order is a permanent operational record. Its **commercial terms** — client name, total order value, total product value, confirm date, due date, lead source — are not ordinary editable fields, and no role may change them by an ordinary update.

* **The terms move only through an amendment**, which always records **who** changed **what**, **from what to what**, and **why**. This is enforced by a database trigger, not by hiding a form: a raw `PATCH`, a service-role route and direct SQL are all refused with `ORDER_AMENDMENT_REQUIRED`. An admin's raw update is refused too — an exemption for a role would audit nothing, which is the exact problem the rule exists to solve.
* **Two doors, one effect.** An admin amends directly. Everyone else who can see the Order **proposes** a change, and an admin's approval is what applies it. Both write the same audit entry, so an amendment reads identically regardless of who initiated it.
* **A reason is mandatory**, on every door, including cancellation.
* **An empty field means "leave this one alone", never "blank it".** Neither door can clear a stored value back to nothing, so a form submitted with an empty box can never silently erase an order's due date. Clearing a field is deliberately not offered rather than half-offered.
* **An amendment that changes nothing is refused.** An audit entry recording that nothing happened is worse than no entry.
* **A decision can never be un-made.** `order_change_requests` carries no UPDATE and no DELETE policy for anyone, admins included. A client cannot move a request to approved, write the reviewer fields, or erase a decision — only the review functions can.
* **Approval is atomic with its effect.** A refused amendment leaves the request pending; no request is ever marked approved without the change having landed.
* **One open request of each type per Order per person.** A reviewed request never blocks the next one.
* **A closed Order — dispatched or cancelled — accepts no amendment**, and no new change request may be filed against it.
* **The creation record (`created_by`, `created_at`) is frozen absolutely**, amendment context included, alongside the order number and the source-request provenance that already were.
* **`status` is deliberately outside this rule.** Day-to-day operational movement through the lifecycle is not an amendment and must not require one.

---

## Order Cancellation Rule

Cancelling is not a change of terms, and it is not a refund.

* **A reason is mandatory.**
* **The money position is stated before the decision, and recorded with it.** The total approved money received against the Order is shown in the cancellation dialog and written into the activity log — **including when it is zero**, because "no money had been received" is itself a fact worth being able to prove later.
* **Cancellation touches no payment.** Linked payments stay linked and stay approved. The money genuinely arrived; returning it is a separate, deliberate act by whoever moves funds. A cancellation must never be allowed to look like a refund has happened.
* **Where money was received, a settlement — a refund or a credit toward a future order — remains outstanding** and must stay visible as such.
* **A dispatched Order cannot be cancelled.** A cancelled Order cannot be cancelled again, and is never deleted — it stays searchable as history.
* **A salesperson may request a cancellation but never perform one**, because cancelling an Order with money on it is a decision that needs the person who can see the money.

---

## Financial Amount Rule

Money is never negative, and a receipt is never zero.

* **A payment amount is strictly positive.** A zero-amount payment is not a real event, and would still be counted as "an approved payment exists" by the conversion rule.
* **An order value is never negative.** Zero is legitimate — an Order may not have been priced yet.
* Both are enforced by database `CHECK` constraints. The client-side `isValidAmount()` is a form convenience and **never the control**.
* **A refund is not a negative payment.** Reversing money must never be modelled as a negative row in the payments table: it corrupts every existing count and sum, including the conversion rule. Refunds, voids, reversals and corrections are distinct events and belong in their own record. See `docs/Module Docs/FINANCE_ORDER_WORKFLOW.md` §4.1.
* **Financial totals derive only from approved records.** Pending, clarification and rejected payments are counted separately and are never presented as money received.

---

# TASK MANAGEMENT RULES

## Self Tasks

When a user creates a task for themselves:

Display:

Assigned By: Self

Never display the user's own name as the assigner.

---

## Acknowledgement Rule

Task acknowledgement is required.

Current implementation:

Acknowledging a task immediately moves it into Working status.

Separate Working acknowledgement controls have been removed.

---

## Ownership Rule

Every task must always have a visible owner.

Task ownership must remain clear throughout:

* Assignment
* Delegation
* Completion
* Restoration

---

## Waiting vs Blocked

These statuses have different meanings.

### Waiting

External dependency.

Examples:

* Waiting for client response
* Waiting for vendor information

Escalation may pause.

---

### Blocked

Internal dependency.

Examples:

* Waiting for internal approval
* Waiting for another team member

Management visibility required.

---

## Activity History

Task activity history is permanent.

Activity logs should remain visible for accountability purposes.

---

## Restore Rule

Restoring a completed task should return the task to its previous working state.

The restore action should use the last valid activity state.

---

# NOTIFICATION RULES

Notifications should support accountability.

Notifications currently exist for:

* Acknowledgements
* Comments
* Waiting updates
* Blocked updates
* Completion updates

Users may:

* Mark read
* Delete selected
* Delete all

Notification noise should be minimized.

---

# PERFORMANCE MANAGEMENT RULES

## Official Launch Date

Performance tracking officially begins:

8 June 2026

Data before this date should not impact employee performance scoring.

---

## Performance Philosophy

Performance exists to:

* Encourage accountability
* Encourage consistency
* Encourage self-reflection

It is not intended as a punishment system.

---

## Daily EOD Rule

Employees submit:

* Work completed
* Self rating

The purpose is visibility and reflection.

---

## Monthly Performance Rule

Monthly scores are calculated only from valid tracking periods.

Missed submissions before launch date are ignored.

---

## Coaching Rule

Performance feedback should remain coaching-focused.

The objective is improvement, not punishment.

---

# TEAM PERFORMANCE RULES

## Management Purpose

Team Performance exists to help managers identify:

* Overdue work
* Waiting work
* Blocked work
* Missing updates
* Operational risks

---

## Attention Required Logic

Employees may be flagged due to:

* Overdue tasks
* Waiting tasks
* Stale blocked tasks
* Missed EOD entries
* Low performance scores

Reason visibility should always be available.

---

# SAMPLE TRACKING RULES

## Purpose

Every sample should be traceable from request through final closure.

---

## Sample Lifecycle

Current lifecycle includes:

* Request
* Approval
* Dispatch
* Delivery
* Return
* Replacement
* Lost
* Closed

---

## Audit Requirement

All major sample actions should be recorded.

Management must be able to identify:

* Who requested
* Who approved
* Who dispatched
* Who received
* Who marked lost

---

## Lost Sample Rule

Lost samples should remain visible in history.

Loss events must not silently disappear.

---

# ATTENDANCE RULES

Status:

Planning / Early Development

Reference:

ATTENDANCE_MODULE_PLAN.md

Important future rules should be documented here as they become finalized.

---

# PAYROLL RULES

Status:

Planning / Early Development

Reference:

PAYROLL_RULES_V1.md

Examples of future rules:

* Late deduction logic
* Half day logic
* Paid leave adjustments
* Missing punch deductions
* Payroll adjustments

Detailed payroll rules remain maintained in the dedicated payroll document until implementation begins.

---

# UI RULES

## Simplicity

Avoid unnecessary screens.

Prefer:

* Popups
* Inline actions
* Fast updates

---

## Mobile Consideration

All major workflows should remain usable on mobile devices.

---

## Consistency Rule

New UI patterns should reuse existing patterns whenever possible.

Consistency is preferred over novelty.

---

# DEVELOPMENT RULES

## Small Changes

Implement features through:

* Small tasks
* Small reviews
* Small commits

Avoid large uncontrolled changes.

---

## Production Safety

Changes affecting:

* Supabase schema
* Authentication
* Core workflows

should be reviewed before implementation.

---

# RULE CHANGE PROCESS

When a business rule changes:

1. Update this document.
2. Update related module documentation.
3. Verify implementation alignment.
4. Record the change in Development History.

This document should remain the primary source of operational rules for BOE Task Management.

---

## Access Control V1 — Rules

1. **Default deny.** A new employee receives no optional-module access. Access
   is granted per person; nothing arrives by virtue of a role.
2. **Five levels only.** No Access, Viewer, Contributor, Manager, Custom.
   Manager adds `approve` and `export` only where the module registers them.
3. **Protected permissions are Custom-only** — `delete`, `admin`, `manage`,
   `assign`, `dispatch`, `receive`, `mark_lost`, `close`,
   `can_be_order_assignee`, `view_quotations`, `manage_quotations`, `view_all`.
   No standard level grants any of them at any module.
4. **A standard level clears protected permissions**, after naming them and
   asking. Anyone holding one therefore reads as Custom.
5. **`assign` is separable from `edit`, `delete` and `manage`.** Handing out a
   laptop and writing one off are different decisions.
6. **`can_be_order_assignee` is never implied** by Manager or by `manage`.
7. **Module entry is not company-wide sight.** `orders.view` and `finance.view`
   open a module and leave record visibility to the ownership rules;
   `orders.view_all` and `finance.view_all` are what widen it. The two are
   granted per module and neither implies the other, so seeing every order
   reveals no price, payment or finance record. Neither implies any authority to
   act — no edit, approve, manage, delete, export or assignee eligibility.
   (`orders.view` carried company-wide sight until `20260903000000`; that was a
   defect, not the rule.)
8. **Quotation data is commercially sensitive.** Ordinary Task Management access
   reaches no quotation register, request form or customer commercial detail;
   those need `view_quotations`, and creating/editing/approving/sharing needs
   `manage_quotations` on top of it. A quotation request that is somebody's
   assigned task stays visible to them as a task — only the quotation framing
   and the customer's details are withheld.
7. **System Administrators are not editable here.** `users.role = 'admin'` is
   the authority; the grid is locked and no PUT is issued for them.
8. **Inactive and soft-deleted users are denied**, admins included. Deactivating
   an account does not end its session, so this is enforced in SQL.
9. **Attendance and Payroll management is admin-only.** No grant on this screen
   can open it. Employee self-service (`/my-attendance`, `/my-payroll`) is a
   separate surface and is unchanged.
10. **Module access on/off is not a second authority.** Off = No Access,
    On = Viewer. There is no separate visibility field.
11. **Migrations 901 and 902 deploy together**, 901 first, nothing between.
