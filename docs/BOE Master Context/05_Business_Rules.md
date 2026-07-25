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
