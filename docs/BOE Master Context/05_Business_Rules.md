# BOE TASK MANAGEMENT

# Business Rules

Last Updated: September 2026 — Order Management rules added, and a "Known Gaps"
register added (M-5, task escalation thresholds); earlier sections unchanged.

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

## Order Requests — RETIRED (branch, not applied)

**The Order Request workflow is retired.** The only active Order lifecycle is:

```
PI upload / import → PI Draft → submit for review → finance / payment
conditions → management approval → Confirmed Order
```

Anything not finally approved stays under **PI Drafts**, and only an approved PI
becomes a Confirmed Order. There is no active Order Request creation, list,
dashboard card, action, navigation entry or workflow.

**Finance Payment Requests are NOT retired.** They are a different record on a
different table with a different lifecycle and remain fully active.

Everything under the three headings that follow — Order Request Attachments,
Order Request Payment Targets and Order Request Approval Requirement — describes
records that **already exist** and is kept because those records are still
readable and their money is still on the books. None of it describes something
anybody can still do:

* no new Order Request can be created (the INSERT policy is dropped and a trigger
  refuses every INSERT, for every role);
* none can be converted into an Order (both writes are refused, in the two places
  they happen);
* no NEW payment may name one (`ORDER_REQUESTS_RETIRED`), though an existing link
  may still be **cleared**, which is how historical money reaches a real target;
* the ten workflow RPCs are executable by no client role.

Under the canonical attribution rule an Order Request has never attributed a
rupee — only `order_id` is a fallback — so a historical request-linked payment
with no allocations now reads as **Available to Allocate**, which is what it is.

See `docs/BOE Master Context/02_Current_System_State.md` for the guards, the
Access Control options that were removed, and the payment classification that
replaced the old linked/non-linked split.

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

---

# ORDER MANAGEMENT RULES

*September 2026. Everything in this section is production unless marked
**(branch)** — meaning complete on `claude/confirmed-order-handoff-performance`,
not merged and not applied.*

## PI submission

* A PI enters the system as an **uploaded workbook**, and the browser's reading
  of it is never an input. The server re-parses the same file and persists only
  what **its own** parse produced. A client that lied about a price, a quantity
  or an image mapping changes nothing, because none of those words cross the
  wire.
* **The workbook is immutable once submitted.** `order-files` has no UPDATE
  policy for any role, and the write predicate admits only the owner while the
  record is a draft or has been returned. A reviewer reads every file and writes
  none — which is what keeps "the workbook the approver read is the workbook the
  employee uploaded" true.
* A figure the workbook states is **never repaired**. Where quantity × rate
  disagrees with the stored line total, both are reported and the workbook's
  value is what is kept. Substituting our arithmetic would make the record
  disagree with the document the client was sent.
* **A cost's MEANING is a column, not an inference from its amount.** "Not
  applicable" and "Included" both add zero and are opposite answers to "was the
  client charged for packing?".

## Payment

* Money is recorded against a PI as a **payment plus an allocation**. The
  payment row carries the proof and the Finance history; the allocation says how
  much of it belongs to which target.
* **Only Finance-verified money counts.** A payment awaiting verification is
  excluded from every verified total, on every screen and in every document —
  and where it exists it is *reported* alongside, never folded in.
* A payment may legitimately be **split across targets**, so a total is always
  the sum of *allocated* figures, never of whole ledger amounts.
* **The money MOVES; it is never copied.** At approval the PI's active
  allocations are re-pointed onto the new Order in one UPDATE — same ids, same
  payments, same amounts, same provenance. A reversed allocation stays with the
  PI it was reversed against.

## The reduced-payment exception

* The standard requirement is **40% of the grand total**, as an exact amount and
  never a rounded percentage: 40% of ₹100.01 is ₹40.004, and ₹40.00 — which
  displays as "40%" — does not meet it. The outstanding figure a person is shown
  is rounded **up**, so paying it always closes the gate.
* An exception is a **commercial decision**, settled by
  `orders.approve_advance_exception`, which is **independent of PI approval in
  both directions**. Reviewing a PI and settling its terms are two decisions on
  one record and the business keeps them assignable to different people.
* **Money is tested before the decision that stands in for money.** A PI that
  reaches 40% while an exception request sits in a queue is approved on the
  standard route; the request simply stops mattering.

## Billing percentage

* It is how much of a PI's **pre-GST** value should be billed — a commercial
  decision somebody declares. Not a discount, not a payment percentage, and not
  anything the workbook carries.
* **Undeclared is a real state.** Not 0 and not 100. Nothing is backfilled and
  the screen says `Undeclared`.
* **The floor is 35 and the ceiling is 100.** A business rule, enforced in the
  form, the RPC and a CHECK constraint. Rejected rather than repaired: somebody
  who typed 30 meant 30, and saving 35 on their behalf would record a decision
  nobody took.
* **The value is `total_before_gst` × the percentage, and nothing else.** Never
  the grand total, which carries tax the percentage says nothing about. A PI with
  no stated pre-tax total produces **no** billing value and says so — never ₹0.
* It follows the PI onto the Order at approval and is **read-only there**: by
  then the PI is approved and the RPC that writes it refuses.

## Approval

* **The PI decision and the Confirmed Order are two acts** (20261119000000).
  `approve_pi_review()` records that management approves the document —
  `orders.approve_order`, a current finance check, no blocking issues — and
  creates nothing. `approve_order_submission()` creates exactly one Confirmed
  Order, allocates its number and moves the money, and is refused until the
  payment condition is cleared; it stamps the PI decision itself when it is the
  first press, so a fully paid PI keeps its one-click path.
* **The payment condition is verified payment ≥ 40% of the grand total, or a
  current approved reduced-payment exception.** Attached-but-unverified money
  clears no gate. An exception is never inferred from a PI approval.
* It requires `orders.approve_order` — a protected, deny-by-default action,
  granted per employee. It is **not** `orders.approve`, which means "convert an
  Order Request" and is a different, older authority.
* It requires **Finance verification**, and that verification **goes stale the
  moment the record moves** — as does the PI decision.
* **One submission, one Order, in both directions** — two partial unique indexes,
  not a convention in the function that writes them.
* A failed approval **consumes nothing**: the number cycle advances inside the
  caller's transaction and rolls back with it.

## Submission

* **The reason is owed below 40% ATTACHED payment** — verified plus awaiting
  Finance verification — zero included. At or above it nothing is mandatory. The
  route is chosen by the database under row locks; a percentage the browser
  sends decides nothing. The reason lives on the existing exception columns.

## PI versions on a Confirmed Order

* **A later PI never overwrites the current one.** It is a pending version in
  `order_pi_versions`; V1 is the document the Order was approved from. Exactly
  one approved and at most one pending version per Order, by partial unique
  index. A rejected revision keeps its file and its reason; a superseded one
  stays openable.
* Proposing needs the PI's owner or an admin holding `orders.create`, and a
  reason. Approving or rejecting is an **active admin**'s, with a reason on
  rejection. Approval applies the revised workbook through the one parser path
  and supersedes the previous version in the same transaction.

## Production alignment

* **Every Confirmed Order is born `Not Aligned`.** Commercial approval is not
  production acceptance. The Head of Manufacturing aligns it explicitly through
  `set_order_production_alignment()` under `orders.align_production` — a
  protected action no preset grants and neither `approve_order` nor `manage`
  implies. No other writer, service role included, may move the columns.

## Order numbering

* A confirmed Order number is **four digits, permanent, and never reused** —
  including when the Order is cancelled. A cancelled Order is a row like any
  other and keeps its number forever.
* **Drafts and failed approvals receive and consume no number.**
* The next number is an **admin decision** held in a single-row cycle table.
  There is exactly one allocator, it is reachable only through an INSERT
  trigger, and it is revoked from every role. Nothing in a browser generates,
  guesses or reads a number — no `max(display_number) + 1`, in any form.
* A cleanup gives back only the numbers it freed **from the top of the range**,
  because an administrator who set the cycle to 1000 has said something and
  deleting a test Order is not a reason to unsay it.
* **(branch)** The cycle may be returned to **1** only through
  `reset_confirmed_order_number_cycle()`, and only when: an active admin asks;
  a **finalized** cleanup claim names the occasion (which is also proof the
  storage removal completed); **not one Order row remains**; no PI is submitted
  or approved; and no payment allocation still points at an Order or a PI. It
  deletes nothing, renumbers nothing, is idempotent, and is permanently audited
  with the evidence each gate saw.

## Order continuity — what follows a PI onto its Order

| Fact | Where it lives afterwards |
| --- | --- |
| Client name, confirm date, due date | copied onto `orders` |
| Grand total, gross product amount | copied onto `orders` |
| Billing percentage | copied onto `orders` |
| Payments and allocations | **moved**, never copied |
| GST, total before GST, the commercial breakdown | **stay on the PI**, read from there |
| Product lines and photographs | **stay on the PI**, read from there |
| Addresses, contact, both parties | **stay on the PI**, read from there |

**Order-side commercial values come from the linked approved PI.** GST and the
pre-GST total have no `orders` column and are not to be given one: a second copy
could disagree with the document the client agreed to.

## Confirmed documents *(branch)*

* A **version** is a business fact — the documents as they stand, or as they
  stand after an approved amendment. An **attempt** is a technical fact. A
  failed attempt increases attempt history and produces **no** user-facing
  version, and a retry never advances the version number.
* An Order is **document-ready only when both the Excel and the PDF exist.** The
  database refuses to record any other state.
* **Publication, not location, makes a file downloadable.** An object is readable
  only when a ready version row names it, so a partial attempt's output is
  unreachable by every client role, permanently.
* **The original uploaded PI is never overwritten.** It is read; the confirmed
  copy goes to a different key entirely.
* Generating and retrying require the **management approval authority**; viewing
  and downloading follow **Order visibility**. PI-review access alone reaches
  neither.

---

## PI EDITING AUTHORITY — REVISED, SEPTEMBER 2026

> **SUPERSEDES** the earlier rule that a submitted PI is read-only for
> everyone, admins included. That rule was found during manual testing to be
> stricter than intended: it made a PI imported with missing information
> permanently uncorrectable, which dead-ended the workflow.

### The owner

May add, edit, remove or correct PI business information while the PI is
**draft** or **needs_changes**. No reason is asked — a draft is theirs to
shape, and a mandatory reason on every keystroke of ordinary work is a
ritual, not an audit trail.

Once submitted to management the owner may no longer modify the PI directly.
They may send a **correction request** naming the field or section, the change
they want and a mandatory reason, recorded in Activity and visible to the
reviewing admin. *(Not yet implemented — see 03_Development_History.)*

### The active admin

May add, edit, remove or correct PI business information **at any stage** —
draft, submitted, needs changes, rejected, approved, and after the confirmed
Order exists. Editing after submission **requires a reason**, bounded at 500
characters and recorded in Activity.

"Active" is load-bearing: `role = 'admin' AND is_active AND NOT is_deleted`.
A deactivated admin is not an admin.

### Nobody else

Reviewers, Finance verifiers, managers and permission holders gain **no**
editing authority from being able to view, review, verify payment or approve.
Holding `orders.approve_order` is not editing authority. Each authority stays
separate.

### How the authority is expressed

Two predicates, deliberately not one:

| Predicate | Answers |
|---|---|
| `can_edit_order_submission(uuid)` | the OWNER rule — draft/needs_changes, no Order, owner or admin |
| `can_admin_edit_order_submission(uuid)` | active admin, **any stage** |

The owner rule is **unwidened**. It gates many other write paths — items,
images, files, submission itself — and widening it would have handed an admin
all of them at once, unaudited. Each write path adopts the admin authority
deliberately. As of `20261003000000` five have: the billing percentage, client
and party details, dates and terms, product descriptions, and the workbook
itself.

### Billing percentage

Owner may set, change or clear it in draft/needs_changes; an active admin at
any stage, with a reason after submission. 35–100 or NULL (`Undeclared`).
Unrelated to GST, Grand Total, payment percentage, advance requirement and
approval eligibility. An unchanged value writes nothing and logs nothing.
Owner and admin edits are **different actions** in Activity —
`billing_percentage_set` and `billing_percentage_amended_by_admin` — so a
reader scanning the trail sees the difference without opening anything.

When an Order exists the value is mirrored onto it in the same transaction,
and its ready confirmed documents are marked superseded.

### Amendment and confirmed documents

An amendment **never** mutates a generated file. A ready version gains
`superseded_at` and `superseded_reason`: its files stay downloadable, its
status stays `ready`, and regeneration produces the next version. Supersession
is idempotent — the first thing that invalidated a version is the true answer.

The Order number, `source_order_submission_id` and payment allocation
identities and amounts are preserved by every amendment.

### The two kinds of correction

**This is the approved model, and it decides where every correction goes.**

Everything a PI says about MONEY is the output of formulas that live in the
uploaded workbook. The parser transcribes those results — it reads
`subtotal_after_discount` from I116, `total_before_gst` from I120, `grand_total`
from I122 — and derives only two figures of its own, raising a WARNING and
keeping the workbook's number when its arithmetic disagrees. **BOE has never
computed a PI total and must not start.** Recreating those formulas in
PostgreSQL or React would be inventing figures the spreadsheet did not produce.

So there are exactly two correction paths:

| | **A. Direct edit** (`Edit PI Details`) | **B. Change PI** (replace the workbook) |
|---|---|---|
| What | Non-commercial description | Anything a formula touches |
| Fields | Client name, contact, billing and shipping details, confirm date, due date, dispatch commitment, payment terms, billing terms, billing percentage, product code, product name, dimensions, material, specification note, product line order | Quantity, rate or unit cost, adding a product, removing a product, discount or design fees, fabric cost, packing cost, transportation or freight, GST, any other money-related input, **and the product image** |
| Where | One RPC per section, each its own transaction | The import route, under a processing lease |

Every screen showing a product line states path B's list under it, so nobody
hunts for a control that was never going to exist. The money figures are
rendered as **text, never as disabled inputs** — a greyed-out box over a price
reads as a permission somebody could be granted, and the answer is nobody.

**Product image is path B, deliberately.** A line's picture is an anchored
drawing tied to its row through the workbook's relationship parts; replacing
one safely means rewriting `xl/drawings/`, its `_rels`, and the media entry,
with no way to prove afterwards that the anchor still points where it did. The
existing Change PI worker already replaces images correctly, content-addressed
and verified by bytes, so images go through it.

### What an editor may change

| Section | Migration | Columns |
|---|---|---|
| Client and party details | `20260928000000` | `client_name`, `contact_number`, bill-to / ship-to name, phone, GST, address — ten text columns |
| Dates and terms | `20260929000000` | `order_confirmation_date`, `due_date`, `dispatch_commitment`, `payment_terms`, `billing_terms` |
| Billing percentage | `20260923000000` + `20260927000000` | `billing_percentage`, its own RPC and its own range rules |
| Product descriptions | `20261002000000` | per line: `item_sequence`, `source_product_code`, `product_name`, `dimensions`, `material`, `customization` |
| Product line order | `20261002000000` | `sort_order`, one write over every line |

Each is a database allow-list where an unrecognised key is **refused**, not
ignored — a payload carrying `quantity` is rejected BY NAME with the reason,
never silently dropped. Dates are validated for ISO shape *before* the cast,
because PostgreSQL otherwise accepts `'yesterday'`, `'today'`, `'infinity'` and
`'epoch'` and stores a relative date.

One line is one RPC and one transaction. A dialog editing several at once would
be several round trips behind one button, and a failure between them leaves the
PI half-corrected with nothing on screen saying which half.

### Change PI — the workbook replaced

`replace_order_submission_parse` has always existed and could not run once a PI
left draft, **for anybody**: `assert_order_submission_editor` judges STAGE
BEFORE ACTOR, so its admin branch was structurally unreachable — the same defect
`20260927000000` found in the billing percentage. `20261003000000` adds
`assert_order_submission_workbook_editor` **beside** it rather than widening it,
and re-emits both the replacement and the processing lease, which asked the same
predicate and would otherwise have refused an admin a lease before they ever
reached the write.

| Stage | Who | Reason |
|---|---|---|
| draft / needs_changes, no Order | owner, or an active admin | not required |
| anything after that | **active admin only** | **mandatory**, at most 500 characters |

Holding `orders.approve_order`, being the finance verifier, or owning the PI
grants nothing past draft. Authority is re-derived from the ACTOR ID, never from
`auth.uid()`, because the import worker runs as the service role.

Once a PI has left draft, a replacement additionally:

* **clears the finance verification.** `20260915000000`'s trigger fires on a
  STATUS CHANGE, and a replacement is not one — a submitted PI stays submitted —
  so a sign-off made against the previous figures would otherwise stand against
  the new ones.
* **carries the corrected values onto the linked Order** — client name, confirm
  date, due date, total value, product value, billing percentage — and touches
  nothing else. Not the Order id, not the confirmed number, not
  `source_order_submission_id`, not the status, not one payment and not one
  allocation. No second Order is created and nothing is re-allocated.
* **supersedes the ready document pair** and records the reason in both the PI's
  Activity and the Order's.
* **keeps the previous workbook.** A draft re-upload tidies up after itself; an
  amendment does not, because that file is what finance verified, what
  management approved and what the confirmed documents were generated from.

The reduced-advance exception needs **no** invalidation:
`order_submission_exception_current()` derives currency from the grand total, the
workbook hash and both terms, all of which a replacement moves. A declared
advance amount is cleared by `20260917000000`'s existing trigger whenever the
grand total is replaced.

A replay — the same file, the same fingerprint — supersedes nothing, clears
nothing and logs nothing. Pressing Retry after a timeout is not an amendment.

Every edit carries the row version it was read at (`order_submissions.row_version`,
a monotonic counter — **not** a timestamp, because `now()` is transaction-scoped
and cannot distinguish two writes in one transaction). A stale write is refused
with `ORDER_SUBMISSION_STALE` rather than silently winning.

A submitted PI may not have its client name cleared: `ORDER_SUBMISSION_CLIENT_NAME_REQUIRED`
says so in words, ahead of the CHECK constraint that would otherwise surface as
a catalog identifier.

### Readiness

`piReadiness()` is the single shared answer to "can this PI take a payment /
be submitted", listing everything missing **at once** rather than one refusal
at a time. Every requirement it reports mirrors an existing database gate;
optional fields are never reported. It is not the enforcement — the database
re-derives all of it under a row lock.

One computation is read by four surfaces: the payment control, the submit
control, the finance dialog and the approval control. The finance dialog SHOWS
it and is not refused by it — finance signs off on the figures, and whether the
PI carries a client name is not their decision — but approval refuses for it, so
a verifier who could not see it would sign off and then watch the approval
stall. On the approval control it is the **last** blocker: everything above it
is somebody else's outstanding task and a larger obstacle, and reporting an
absent client name ahead of an unverified PI reads as though it were the only
thing wrong.

### Corrections and the confirmed documents

A direct edit reaches the generated files. The confirmed PDF is rendered from
the record, so it carries every correction already. The confirmed Excel is the
uploaded workbook itself with cells rewritten in place — ZIP surgery, because a
round trip through any spreadsheet library loses the anchored photographs,
merged blocks and print setup — and `CONFIRMED_EDITABLE_CELLS` names the ten
cells a correction may reach.

Every one is a cell `masterSheetParser` already READS, so the reference a
correction writes to is the reference the import read from. Excluded, and each
for its own reason: every commercial cell (they are formula outputs);
`due_date`, `payment_terms` and `billing_terms` (editable on the record with no
template cell); `order_confirmation_date` at A113 (a DATE cell — every write
here is an inline string, and text would change the cell's type and strip its
number format, so the corrected date reaches the PDF only); `client_name`
(derived at import from `bill_to_name`, which owns B25); and product rows
(locating a line's row by position is the guess this approach exists to avoid).

A field outside that contract is **refused**, not ignored. A formula found in a
correction target refuses the whole document rather than publishing it with one
correction quietly missing.

---

# KNOWN GAPS — DOCUMENTATION VS. IMPLEMENTATION

Open, unresolved mismatches between an approved rule recorded elsewhere and
what the code actually does. Recorded because the mismatch itself is a fact
worth keeping, not because either side is being changed here. Each needs an
owner decision.

## M-5 — Task escalation thresholds

**The written rule.**
[`docs/reference/MASTER_PRODUCT_VISION.md`](../reference/MASTER_PRODUCT_VISION.md)
(lines 54–57) states: *"No update for 24 hours = Caution Zone. No update for 48
hours = Danger Zone. No update for 72 hours = Escalation to senior."* This is
the only surviving written statement of the rule — `MASTER_PRODUCT_VISION.md`
is an early-phase document and is not a current-state record, but nothing else
in the repository restates escalation thresholds as a named business rule.

**What the code actually does — two separate mechanisms, neither matching the
rule above:**

1. **`public.run_task_health_check()`**, an hourly `pg_cron` job whose current
   body is not tracked in `supabase/migrations/` (it was installed directly
   against the database — see
   [`docs/proposals/NOTIFICATION_NOISE_AND_PAGE_SPEED.md`](../proposals/NOTIFICATION_NOISE_AND_PAGE_SPEED.md)).
   Migration `20261015000000_task_health_check_stops_notifying.sql` is
   **applied** and removed the job's `notifications` inserts entirely: it now
   only writes a `task_activity_log` row at **24 hours** (overdue with no
   action) and at **72 hours** (no update since), each guarded against
   duplicates. The **48-hour branch was removed outright** — its only effect
   had been the notification insert that no longer exists, so there is no
   "Danger Zone" left in the code at all. Nothing here reaches a senior: it is
   a silent activity-log entry visible only inside that task's own history.
   Even before this migration, the `escalation`/`overdue` notification types it
   used to write were excluded from every user-visible feed by
   `SYSTEM_GENERATED_NOTIFICATION_TYPES` (`src/lib/notifications.ts:283-292`),
   so no user has ever actually seen one.
2. **The dashboard's admin-only escalation view**, `adminEscalations`
   (`src/app/dashboard/page.tsx:476-497`, rendered by `EscalationListDrawer`).
   Admin-only, and **day-granularity**, not hour-granularity: `> 5` days for
   `blocked`/`waiting` tasks, `> 7` days for `working`/`pending`/`started`
   tasks. No named zones ("Caution"/"Danger"), and it is a passive drawer an
   admin opens on demand — nothing is pushed to anyone, senior or otherwise.

**Status: open — needs an owner decision.** Both implemented thresholds are
several times looser than the written 24/48/72-hour rule, neither names a
"Caution Zone" or "Danger Zone", and neither notifies a senior. Do not resolve
this by editing thresholds or reintroducing the removed notification branch —
confirm with the owner which behaviour (if either) is actually intended first.
Verified against `src/app/dashboard/page.tsx`,
`supabase/migrations/20261015000000_task_health_check_stops_notifying.sql`,
`docs/proposals/run_task_health_check.production.sql` and
`src/lib/notifications.ts` on `main` at commit `ebc801c` (2026-09-04).
