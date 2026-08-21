# BOE TASK MANAGEMENT

# Current Roadmap

Last Updated: September 2026 — Order Management is the active focus.

---

# PROJECT STATUS

Overall Status:

Production Active

Current Users:

Internal BOE Team

Development Approach:

Incremental development through small verified changes.

Primary Objective:

Expand BOE Task Management from a task execution platform into a complete internal operating system while maintaining simplicity and usability.

---

# CURRENT DEVELOPMENT PRIORITIES

Priority 1

Sample Tracking Completion

Priority 2

Attendance Management

Priority 3

Payroll Management

Priority 4

Assets & Access Completion

Priority 5

Employee Records

---

# PRIORITY 1

# SAMPLE TRACKING

Status:

Active Development

Business Goal:

Create complete visibility and accountability for every sample from request through final closure.

Current Focus Areas:

* Lifecycle completion
* Notifications
* Accountability tracking
* Customer sample history
* Return management
* Replacement management
* Closure workflows

Success Criteria:

* No sample can be lost without visibility.
* Sample ownership is always known.
* Management can track sample status at any time.
* Complete audit trail exists.

---

# PRIORITY 2

# ATTENDANCE MANAGEMENT

Status:

Foundation Exists

Business Goal:

Centralize employee attendance records within BOE.

Planned Features:

* Daily attendance
* Attendance import
* Attendance dashboard
* Leave tracking
* Monthly summaries
* Employee attendance history

Success Criteria:

* Eliminate manual attendance tracking.
* Provide management visibility.
* Support payroll calculations.

---

# PRIORITY 3

# PAYROLL MANAGEMENT

Status:

Foundation Exists

Business Goal:

Create a payroll system integrated with attendance and employee records.

Planned Features:

* Salary calculation
* Payroll generation
* Payroll locking
* Incentive handling
* Payroll reports
* Historical payroll records

Success Criteria:

* Controlled payroll process.
* Reduced spreadsheet dependency.
* Auditability.

---

# PRIORITY 4

# ASSETS & ACCESS

Status:

Asset lifecycle complete. Access credentials still V1.

Business Goal:

Track company assets and employee access rights.

Delivered:

* Individual asset page with the asset's full history
* Permanent, append-only transfer and custody history
* Repair / service records with total spend
* Warranty and purchase details, with derived warranty status
* Asset documents (invoice, warranty card, supporting files)
* Inventory search and filters
* Asset notifications, sharing the Task Management interaction model
* Immutable per-asset activity history

Current Focus:

* **Credential storage rework.** `access_records.secret_value` is plaintext, so
  the Access Register is admin-only and cannot be delegated. Encrypting it (or
  moving it to a secrets manager) is what unblocks manager access to the second
  half of this module.

Next (not started):

* Scheduled warranty-expiry reminders. Today the sweep runs when someone opens
  the inventory, because BOE has no scheduler for application code; a database
  cron job or a Vercel cron would make the reminder time-driven instead.
* Recurring maintenance schedules. A next-service date is recorded and shown,
  but nothing generates the next service from it.
* Asset reporting (spend by category, ageing). Deliberately deferred — the
  module is operational, not analytical, and BOE avoids dashboards until a real
  question needs one.

Success Criteria:

* Clear ownership of company assets. **Met** — an asset can never read as
  assigned without naming a custodian.
* A permanent record of who held what, when. **Met.**
* Clear visibility of employee access permissions. **Partly** — visible to
  admins only until the credential rework.

---

# PRIORITY 5

# EMPLOYEE RECORDS

Status:

Planned

Business Goal:

Create a centralized employee information repository.

Potential Scope:

* Personal information
* Employment details
* Documents
* Joining records
* Role history
* Department information

---

# ACTIVE IMPROVEMENT TRACKS

These are improvements to existing modules rather than new modules.

---

## Task Management

Completed Improvements:

* Task cancellation workflow (June 2026) — creator/admin can cancel tasks with mandatory reason, dedicated cancelled task list pages, restore support, full audit trail

Potential Improvements:

* Mobile usability review
* Faster task updates
* Additional audit controls

---

## Performance Management

Potential Improvements:

* Team visibility improvements
* Better management insights
* Additional coaching improvements

---

## Team Performance

Potential Improvements:

* Better root-cause analysis
* More actionable management views
* Faster identification of execution risks

---

# FUTURE MODULES

These modules are not currently prioritized but may be developed later.

Potential Areas:

* Internal Communication
* Approvals System
* Purchase Requests
* Procurement Tracking
* Production Coordination
* Quality Tracking
* Dispatch Tracking
* CRM Enhancements
* Department-Specific Workflows

Priority will be determined by operational need.

---

# DEVELOPMENT RULES

Every new feature should pass the following checks before implementation:

1. Does it solve a real operational problem?

2. Is it required for active users?

3. Can it be implemented in a simpler way?

4. Will employees actually use it?

5. Does it improve accountability, visibility, or execution?

If the answer is no, the feature should be postponed.

---

# DO NOT CHANGE WITHOUT REVIEW

The following items require deliberate review before modification:

* Supabase production environment
* Authentication architecture
* Existing task workflows
* Existing performance scoring logic
* Production database structures
* Vercel deployment configuration

---

# NEXT IMMEDIATE WORK

> **SUPERSEDED — September 2026.** The paragraph below named Sample Tracking as
> the current focus. It is kept for the record; the active focus is now Order
> Management, for the reasons in the section that follows.

Current Focus:

Sample Tracking Module

Current Goal:

Complete the end-to-end sample lifecycle and notification workflows before shifting major attention to Attendance and Payroll.

All development efforts should remain focused on finishing active modules before introducing major new systems.

---

# ACTIVE FOCUS — ORDER MANAGEMENT

*September 2026.*

Order Management is the module under active development. It is the one place in
the business where a document a client signs, money the client pays, and a
permanent register of Order numbers all meet — so it is also the module where a
defect is least recoverable, and it gets the attention accordingly.

## Where it stands

**In production.** A PI workbook is uploaded, parsed server-side, reviewed,
verified by Finance, and approved — and approval is the single atomic act that
creates the Confirmed Order, allocates its permanent four-digit number, and
moves the PI's payment allocations onto it. The PI now also carries a real due
date (PR #46) and a declared billing percentage (PR #47), both of which follow
it onto the Order.

**On `claude/confirmed-order-handoff-performance`, not merged and not applied.**
The Confirmed Order's operational handoff from its PI; the document-generation
register and its claim protocol; confirmed Excel and confirmed PDF generation;
the safeguards a controlled test-data cleanup needs and a gated way back to
Order number 0001; and a startup-latency pass across every Order screen.

**Planned, in order.**

1. **Apply the four branch migrations** to production, in order, and confirm the
   handoff and the documents against real records. Nothing on that branch has
   been applied anywhere, and the preview is not testable until it has been.
2. **Run the controlled test-data cleanup.** Every Order Management record today
   is test data, and real numbering must begin at `0001`. The tooling is
   complete and audited; running it is a decision, not a deployment. It is
   deliberately not something a development session performs.
3. **A licensed Unicode font asset**, so the confirmed PDF can print `₹` instead
   of `Rs.`. A presentation limitation today, not a functional one.
4. **Amendment-driven document versions** — a second version of an Order's
   documents after an approved amendment. The register already supports it; no
   screen offers it yet.

## What must not change while this work continues

These are settled and are not open questions:

* **A confirmed Order number is permanent and is never reused**, including when
  the Order is cancelled. Drafts and failed approvals receive and consume no
  number.
* **Approval stays atomic, and stays separate from document generation.** Nothing
  slow may move inside it.
* **Order-side commercial values come from the linked approved PI.** GST and the
  pre-GST total are not to be duplicated onto `orders`.
* **`order-files` has no UPDATE policy**, so stored objects are immutable and a
  Supabase upsert cannot replace one. Every generation path is built around that
  rather than asking for an exception to it.
* **Awaiting-verification payments are excluded from verified totals**, on every
  screen and in every document.
