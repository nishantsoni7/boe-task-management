# BOE TASK MANAGEMENT

# Development History

This document records major milestones, architectural decisions, feature launches, and important project evolution points.

It is intended to preserve project history without requiring access to old chat conversations.

---

# PROJECT ORIGIN

BOE Task Management was created as an internal operating system for Best of Exports.

The initial objective was to replace scattered task discussions across WhatsApp, verbal follow-ups, and manual reminders with a centralized accountability platform.

From the beginning, the goal was not to build generic project management software but to build a system designed around BOE's internal operating processes.

Core philosophy established early:

* Simple first
* Fast first
* Practical first
* Improve through real usage
* Avoid unnecessary complexity

---

# PHASE 1

# Foundation Setup

Completed:

* Next.js application setup
* Supabase integration
* Authentication framework
* User management structure
* Deployment pipeline
* GitHub integration
* Vercel deployment

Major Decision:

The system would remain internally focused rather than becoming a general-purpose SaaS product.

---

# PHASE 2

# Core Task Management Launch

Objective:

Create a complete accountability system for daily task execution.

Implemented:

* Task creation
* Task assignment
* Self tasks
* Delegated tasks
* Due dates
* Priorities
* Status tracking
* Activity history
* Attachments

Major Decisions:

* Ownership must always be visible.
* Simplicity is preferred over advanced project management features.
* Employees should be able to update tasks quickly.
* Managers should not need to chase updates manually.

Result:

Task Management became the first production-ready module.

---

# PHASE 3

# Task Workflow Refinement

Several rounds of feedback-driven improvements were completed.

Key Changes:

* Simplified task detail layout.
* Reduced unnecessary navigation.
* Improved task visibility.
* Improved activity tracking.
* Added edit and restore workflows.
* Improved attachment handling.

Major Decisions:

* Popups preferred over opening new pages.
* Reduce screen clutter.
* Display task titles instead of large descriptions.
* Keep focus on execution rather than documentation.

---

# PHASE 4

# Notification System

Objective:

Reduce dependency on WhatsApp for internal follow-up.

Implemented:

* Acknowledgement notifications
* Completion notifications
* Waiting notifications
* Blocked notifications
* Comment notifications

Additional Improvements:

* Read/unread status
* Bulk actions
* Delete controls
* Direct task access

Result:

Important task activity became visible inside the application.

---

# PHASE 5

# Performance Management Launch

Objective:

Create daily accountability without excessive reporting requirements.

Implemented:

* Daily EOD reporting
* Self ratings
* Performance scoring
* Coaching feedback
* Monthly performance reporting

Major Decisions:

* Coaching-focused approach instead of punishment-focused scoring.
* Daily feedback is more valuable than large monthly reports.
* Fairness is critical.

Important Rule:

Official performance tracking start date:

8 June 2026

Historical dates before launch are excluded from score calculations.

---

# PHASE 6

# Team Performance

Objective:

Provide management with visibility into team execution risks.

Implemented:

* Team performance dashboard
* Attention indicators
* Waiting task tracking
* Blocked task tracking
* Overdue tracking
* Member performance drill-down

Major Decisions:

* Focus on identifying risks early.
* Show actionable information.
* Avoid management dashboards filled with vanity metrics.

Result:

Managers gained visibility into execution bottlenecks.

---

# PHASE 7

# Sample Tracking Module

Objective:

Track customer samples through their full lifecycle.

Business Need:

Samples were being tracked through fragmented communication and manual follow-up.

Development Milestones:

* Sample request workflow
* Approval workflow
* Edit workflow
* Delete workflow
* Dispatch tracking
* Dispatch audit tracking
* QR workflow
* Approval tracking
* Lost sample tracking

Current Status:

Module is under active development.

Current Focus:

Complete lifecycle visibility and accountability.

---

# PHASE 8

# Attendance and Payroll Foundation

Objective:

Move additional operational processes into the BOE platform.

Work Completed:

* Attendance framework
* Payroll framework
* Administrative structures
* Data model planning

Current Status:

Foundation completed.

Full workflows remain under development.

---

# PHASE 9

# Assets & Access Management

Objective:

Track company assets and employee access assignments.

Work Completed:

* Asset allocation structure
* Employee access tracking structure
* Administrative workflows

Current Status:

Active development.

---

# PHASE 10

# Task Cancellation Workflow

Objective:

Allow task creators and admins to formally cancel tasks that are no longer valid, with a mandatory reason, without treating them as completed.

Business Need:

Tasks were sometimes becoming stranded — no longer relevant but with no clean way to remove them from active views. Marking them complete was inaccurate since the work was not done. A separate terminal status with audit trail was required.

Work Completed:

* Database migration adding `cancelled` status, `cancelled_by`, `cancelled_at`, `cancellation_reason` columns
* New `/api/cancel-task` endpoint with creator/admin-only enforcement
* Updated `/api/restore-task` to support restoring from cancelled back to prior active status
* Cancel Task button and reason selection modal on task detail page
* Post-cancellation redirect to dedicated Cancelled Tasks list
* Cancelled task card showing reason, cancelled date, and Restore option
* `/tasks/cancelled` page — My Cancelled Tasks
* `/tasks/assigned-by-me/cancelled` page — tasks assigned by current user that were cancelled
* Sidebar navigation updated with Cancelled entries under both My Tasks and Assigned By Me groups
* Cancelled tasks excluded from all active task list fetches
* Cancelled tasks excluded from performance metrics (individual and team)
* Cancelled tasks excluded from overdue and needs-update calculations
* Cancellation and restore events logged in activity history
* Assignee notification sent on cancellation and restoration

Permission Rules Established:

* Task creator can cancel their own task
* Admin can cancel any task
* Assignee cannot cancel unless they are also the creator or admin
* Same rules enforced at both UI and API layers

Design Decisions:

* Cancelled is not Completed — they are semantically distinct terminal states
* Cancellation reason is mandatory, not optional
* Cancelled tasks remain visible for audit and restore; they are never hidden permanently
* Restore from cancelled returns the task to its status at the time of cancellation

---

# USER EXPERIENCE EVOLUTION

Throughout development several recurring design decisions were adopted.

---

## Decision: Simplicity Over Feature Count

Many proposed features were intentionally not implemented.

Reason:

User adoption was prioritized over functionality volume.

---

## Decision: Fast Updates Over Detailed Reporting

The system should encourage usage.

Employees should not spend excessive time entering information.

---

## Decision: Popups Over Navigation

Where practical:

* View details in modal
* Update in modal
* Review information in modal

Reason:

Reduced navigation friction.

---

## Decision: Operational Visibility

Every module should improve visibility of:

* Ownership
* Accountability
* Delays
* Risks
* Blockers

---

# CURRENT PROJECT POSITION

The application has evolved from a task management tool into an internal operations platform.

Production modules:

* Task Management
* Notifications
* Performance Management
* Team Performance

Expanding modules:

* Sample Tracking
* Assets & Access

Foundation modules:

* Attendance
* Payroll

Future modules:

* Employee Records
* Internal Communication
* Additional BOE operational systems

The project continues to follow an implementation-first approach with small verified changes and incremental expansion.


---

# PHASE 10

# Global Module Navigation Standard

Objective:

Create a consistent navigation and layout experience across all BOE modules.

Business Need:

As BOE expands beyond Task Management into Sample Tracking, Attendance, Payroll, Assets & Access, Showroom QR, Employee Records, and future operational modules, users should not need to relearn navigation patterns.

Implemented:

* Global navigation standard document
* Global module layout standard document
* Module header standard
* Home button standard
* User profile area standard
* Account Settings standard
* Admin View As standard
* Sign Out standard

Architectural Decisions:

* Every module must have its own module-specific sidebar.
* Cross-module navigation is not allowed inside module sidebars.
* Home button always returns to `/modules`.
* Account Settings must open inside the current module layout.
* Admin View As must exist across modules.
* User profile, View As, and Sign Out are mandatory sidebar elements.

Result:

All current and future BOE modules will follow a consistent navigation structure and user experience.

Reference Documents:

* BOE_GLOBAL_NAVIGATION_STANDARD.md
* BOE_MODULE_LAYOUT_STANDARD.md

---

# Assets & Access — Full Asset Lifecycle

Date: 1 August 2026

Migrations: 20260726000000 – 20260731000000 (all applied)

## Problem

An asset was five columns and a custody row. That answered "who has the laptop"
and nothing else: no purchase record, no warranty, no repair history, no
documents, no movement history beyond the current holder, and no audit trail of
what anybody changed. Deleting an asset could take its custody records with it,
and the inventory list had no search and no filters.

## What was built

* **Individual asset page** at `/assets-access/[id]` — Overview, Assignment
  History, Repair & Service, Warranty & Documents, Activity History.
* **`asset_transfers`** — append-only movement history covering initial
  assignment, employee-to-employee transfer, employee-to-location,
  location-to-employee, return, loss, recovery, repair round-trip, retirement
  and disposal. From/to person or place, both departments, recorded and
  effective dates, condition, remarks, actor.
* **`asset_service_records`** — repair / maintenance / inspection / upgrade,
  with vendor, dates, `numeric(14,2)` cost, condition after service and next
  service date. Total spend, count, last and next service shown per asset.
* **Warranty and purchase columns** on `assets`, with warranty status derived
  at display time rather than stored.
* **`asset_documents`** + a private `asset-documents` bucket, reached only
  through short-lived signed URLs. Removal is a recorded soft delete.
* **Search and eight filters** on the inventory, all pure and unit-tested.
* **Asset notifications** — fifteen `asset_*` enum types on the shared
  `notifications` table, `/assets-access/notifications` built from the same
  `NotificationsView` as Task Management.
* **Activity history** extended to the new events, still immutable.

## Architectural decisions

* **One function per operation.** Every custody move writes the custody row,
  the asset row, the movement record and the audit entry in one transaction.
  Before this, "Mark Returned" was two client updates that could half-succeed.
* **History is append-only in the database, not in the UI.** `asset_transfers`
  and `asset_activity_log` have no UPDATE or DELETE policy for anyone,
  including admins, and a trigger enforces it against the service role and psql
  too. A correction is a new row.
* **Warranty status is derived.** A stored copy would be wrong on any row
  nobody touched that day.
* **Notifications are written after commit**, by an API route, never inside the
  transaction — a failed notification must not roll back a movement that
  happened.
* **The list lost its button strip.** Row actions are Assign and Open; every
  other operation moved to the asset's own page, where the reader can see who
  holds the asset before acting on it. That is also what keeps nine columns
  inside a normal desktop width.
* **One modal shell** for the module (`components/assets/AssetModal.tsx`),
  raised above the sidebar's `z-index: 100` — the layering bug that left
  navigation clickable behind a dialog.

## Deliberately not built

* Recurring-maintenance automation.
* Scheduled warranty reminders — the sweep runs on inventory visits, because
  BOE has no scheduler for application code.
* Asset reporting / dashboards.
* Any change to `access_records`; its `secret_value` is still plaintext, so the
  Access Register stays admin-only.

## Verification

1181 automated tests pass. Migrations applied and confirmed against the remote.
Database-level guarantees are scripted in
`docs/Module Docs/assets-lifecycle-verification.sql`; the signed-in UI pass is
`docs/testing/assets-lifecycle-manual-tests.md`.

---

## Access Control V1 (branch `feature/access-control-v1`, not deployed)

Merged Module Visibility and Access Control into one administrator workflow and
moved Finance and Orders authorization onto the permission engine.

**Why.** Three systems decided access: `app_modules` visibility, the permission
engine, and hardcoded `users.role === 'admin'` checks. Dhruv held every Finance
and Orders permission and still could not see the admin options, because every
control inside both modules — and every RLS policy and RPC behind them — checked
the role. A baseline capture confirmed the grants were real and inert.

**What changed.** Five access levels replaced six (the old `admin` preset
granted every action, `delete` and `assign` included). Nine protected
permissions became Custom-only, and choosing a standard level now clears them
after a named confirmation. Finance and Orders protected actions —
approve, manage/correct, delete — moved onto the engine via
`20260901000000`; view/create/edit kept their ownership rules.
`20260902000000` removes the broad Meetings role defaults, grandfathers the
eleven active real employees who hold Meetings today, and revokes the two
protected Orders grants held by a test account. Attendance and Payroll became a
single non-editable self-service row.

**Two defects were found and fixed during the audit.** An RLS `WITH CHECK`
sees only the new row, so the approver policy would have let a
`finance.approve` holder rewrite a pending request's amount while rejecting it —
closed with a column-immutability trigger. And the admin short-circuit,
written to mirror the checks it replaced, would have let a deactivated or
soft-deleted admin keep Finance and Orders authority — both branches now require
an active, non-deleted user.

Detail: `docs/Module Docs/ACCESS_CONTROL_V1.md`.

---

## Order Management — Payment Phase 3: the verified-payment approval gate
*(branch `claude/boe-verified-payment-approval-phase3-hgevan`, migration
`20260921000000_order_submission_verified_payment_gate.sql`, **not applied**)*

**Why.** BOE's rule has always been that an Order is worked once 40% has been
received. Until Payment Phases 1 and 2 there was no way to know whether it had,
so the system asked the salesperson to DECLARE an advance and gated Order
creation on that declaration. Every migration involved said, at length, that a
declaration is not a payment — `20260913000000` opens with "THIS RECORDS A
COMMERCIAL CONDITION. IT IS NOT A PAYMENT." The declaration was a proxy, and the
proxy could be wrong in the one direction that costs money: an Order confirmed,
numbered and worked against nothing received.

**What changed.** `approve_order_submission()` now sums FINANCE-VERIFIED payment
allocated to the PI, live, under row locks, at the instant of the decision, and
compares it as exact `numeric` with 40% of the grand total. Below that, an
Order number is assigned only when an authorised approver has approved
proceeding on less — including on nothing.

**What was deliberately NOT built.** A second exception system. The reduced- and
zero-payment route reuses `20260913000000`'s columns, guard trigger, two decision
RPCs and `orders.approve_advance_exception` permission unchanged; what changed is
what the request means and that a reason and Payment Terms are mandatory to raise
one. Building a parallel workflow would have split every audit trail in half.

**Three things the design turns on:**

* **Exact amounts, never a rounded percentage.** 40% of ₹100.01 is ₹40.004, and
  ₹40.00 — which displays as "40%" — does not meet it. The figure a person is
  shown as still outstanding is rounded **up** to whole paise, so paying it
  always closes the gate.
* **Money is tested before the decision that stands in for money.** A PI that
  reaches 40% while an exception request sits in a queue is approved on the
  standard route; the request simply stops mattering. The converse also holds: an
  approved exception permits approval however little arrived, because that is
  what approving it meant.
* **The money MOVES; it is never copied.** At approval the PI's active
  allocations are re-pointed onto the new Order in one `UPDATE` — same ids, same
  payments, same amounts, same provenance — so proof, verification and Finance
  history stay attached to a payment row nothing rewrote.
  `finance_payment_allocations_guard_transition()` was restated to admit exactly
  that one move, which `20260918000000` §6 had already written down as work Phase
  3 would have to do "as a visible, reviewed change to one named function in its
  own migration".

**Legacy data.** No column dropped, no historical value rewritten.
`advance_declared_amount` is retained and re-documented as legacy;
`advance_exception_percent` is re-purposed as the verified-payment snapshot taken
when a request is raised. `order_submission_advance_ready()` still exists and is
simply no longer consulted.

**Also added.** `payment_terms` and `billing_terms` — plain text, never parsed —
and three notification types for the exception request and its two outcomes.

Detail: `docs/Module Docs/FINANCE_ORDER_WORKFLOW.md` §11 and
`docs/Module Docs/PAYMENT_PHASE_PROGRESS.md`.

---

## PR #46 — Rework the two PI screens, and give the PI a real due date

*Merged to `main`. Applied. `20260922000000_order_submission_due_date.sql`.*

**The defect.** A PI states when it is due. Nothing carried that anywhere: the
Order it became had `due_date` null, and the earlier design note said that was
deliberate because `dispatch_commitment` is free text ("45 days") with no safe
conversion to a date.

That reasoning was right about the prose and wrong about the conclusion. Some
PIs state an explicit calendar date. Refusing to read *any* of them because
*some* say "45 days" threw away the ones that were unambiguous.

**What changed.** `order_submissions.due_date` — a real `date`, written **only**
from an explicit, plausible calendar date, backfilled for existing rows under
the same rule, and never derived from the prose beside it. A PI that states only
"45 days" still carries a null due date and shows its commitment as words:
`Commitment: 6 weeks from date of confirmation`, prefixed so it can never be
misread as a date.

**The risky part was not the two lines that motivated it.**
`approve_order_submission()` is a 435-line SECURITY DEFINER function that
allocates Order numbers and moves money, and re-emitting it to add one column
meant a dropped `security definer`, a changed `search_path`, a lost row lock or
a quietly altered payment gate would all still compile and still pass every
behavioural test. So `dueDateContinuity.test.ts` diffs the re-emitted text
against the applied one and requires the **only** differences to be the
`due_date` column, its value, and the comment introducing them.

---

## PR #47 — Recompose the PI summary, and give the PI a declared billing percentage

*Merged to `main`. Applied. `20260923000000_order_submission_billing_percentage.sql`.*

**What it is.** How much of a PI's **pre-GST** value should be billed. A
commercial decision somebody takes and declares — not a discount, not a payment
percentage, and not anything the workbook carries.

**Undeclared is a real state.** Not 0, not 100. A PI nobody has decided about
and a PI somebody decided to bill in full are different facts, and collapsing
them would make the second unprovable. The column is nullable, no row is
backfilled, and the screen says `Undeclared` rather than showing a figure
nobody chose.

**The floor is 35 and it is a business rule, not a technical one.** Below 35% is
outside what this business bills against a proforma. It is enforced in three
places that must agree — the form, the RPC, and a CHECK constraint — and
`billingPercentage.test.ts` pins every boundary so they cannot drift. The
constraint is the one that actually holds; the other two exist so a person is
told why before the database has to refuse them.

**The value is derived from `total_before_gst` and nothing else.** Not the grand
total, which includes tax the percentage says nothing about; not the product
value, which is before the costs the subtotal already absorbed. Substituting
either would produce a plausible figure that answers a different question. A PI
whose workbook never stated a pre-tax total produces **no** billing value and
says so, rather than printing ₹0.

`billingContinuity.test.ts` applies the same single-difference proof to the
second re-emission of `approve_order_submission()`.

---

## Branch — `claude/confirmed-order-handoff-performance`

*Draft PR. **Not merged. Three migrations, none applied to any database.***

Everything in this section is complete on the branch and reviewed as a draft. It
is recorded here so the history is continuous; it is **not production**, and no
statement below should be read as describing the live system.

### The Confirmed Order operational handoff

An Order created by approving a PI carried five facts: the client name, the two
dates, the grand total and the gross product amount, plus the billing
percentage. That is deliberately all of it — the PI stays the authority for its
own commercial detail — but it left `/orders/[id]` unable to tell an operations
reader what the order actually **is**.

The facts all existed. What was missing was **permission**, and the shape of
that problem is the interesting part: PI visibility is REVIEW visibility (the
owner, the named reviewer, an `orders.approve_order` holder, a finance
verifier), while ORDER visibility is a different question with a different
answer (admin, operations, requester, assignee, `orders.view_all`). An
operations lead who runs every Order in the building is in the second set and
not the first.

Widening the PI door would have handed drafts, returned records and review notes
to people entitled to none of them. So a **second, narrower door** was added,
and it only opens onto a submission that has already become an Order:

* `can_view_order(uuid)` — SECURITY **INVOKER**, so it *asks* the existing
  `orders` policies rather than restating them. A restatement would drift the
  first time a policy moved, silently and permissively.
* `confirmed_order_id_for_submission(uuid)` — resolves the link and authorizes
  nothing.
* `can_view_order_submission_via_order(uuid)` — the two composed.

Four additive SELECT policies follow. Nothing existing is dropped or narrowed,
no write policy is added, and a draft cannot come through the door because the
door **is** the Order.

### Document generation

Approval is atomic and must stay small — it holds a row lock on the submission,
advances the number cycle and rewrites allocations — so a workbook rewrite or a
PDF render inside it would mean a storage timeout could cost a business an Order
number. Generation is therefore separate, and `public.order_document_versions`
is what records that it is owed, who is doing it, whether it finished, and what
to show somebody while it has not.

A **version** is a business fact; an **attempt** is a technical one. A run that
fell over increments `attempt_count` and produces no version anybody can
download, and a retry does not advance the version number.

`ready` is impossible without both files — a CHECK constraint, not a convention.

**Two defects were found by running the migration against a real PostgreSQL**,
and both are the kind that read correctly:

1. The request began as a SECURITY DEFINER function that checked
   `can_view_order()`. Inside a definer the current user is the function's
   **owner**, who bypasses row-level security — so the check answered `true` for
   every Order in the business. It is now an ordinary client write decided by
   two RLS policies, and what that write can do is almost nothing: INSERT
   reaches two columns and UPDATE three.
2. `select *` and `returning *` need SELECT on every column including
   `claim_token`, which is granted to no client role — so under the caller's own
   privileges they are refused outright. The function names its columns.

### Confirmed Excel

The client's own workbook, with the Order number in `B20`. **Not** a round trip
through a spreadsheet library: that rebuilds the file from the library's model
of a workbook, and a BOE PI is mostly things that model does not carry —
anchored photographs, merged blocks, print setup, hidden rows, drawing
relationships. It would return a file that opens, looks approximately right, and
has lost the images.

So: ZIP surgery on the OOXML/fflate toolkit the repository already has. The
value goes in as an **inline** string, which is why it is safe — a shared string
would mean editing `sharedStrings.xml` and shifting an index every other cell is
measured against. The rebuilt package is re-opened and validated: same entries in
the same order, every image byte-for-byte, the **formula count unchanged across
the whole package**, every relationship still resolving, and the rewritten part
actually different.

### Confirmed PDF

A BOE-designed rendering on the existing pdfkit + sharp setup. Pagination is
explicit and decided in a pure function, because pdfkit will start a page
between a product's name and its price with no table head above the remainder.

Two defects, both caught by rendering real PDFs and reading the bytes back: a
two-page plan came out as **six** pages because pdfkit adds one whenever a text
call crosses the bottom margin (the footer is deliberately drawn in that band);
and two renders of one model produced different bytes because pdfkit stamps the
clock, which would have made the recorded hash a timestamp rather than an
identity.

**Amounts read `Rs.`, not `₹`.** The built-in PDF fonts cover Latin-1 and this
repository owns no licensed Unicode font asset. A presentation limitation,
printed on the document itself, and a one-line change the day a licensed font
lands.

### Cleanup safeguards and the number reset

The existing cleanup protocol was audited and holds up. Two things were missing:

* It **could not reach 0001**. `finalize_test_data_cleanup()` reclaims numbers
  from the top of the range, which lands on 1 only if Orders happen to be
  cleaned in descending order. `reset_confirmed_order_number_cycle(claim_token)`
  is a separate, audited act behind six gates, and the race with a concurrent
  approval is closed by locking the same cycle row the allocator locks — not by
  a check, which would be stale by the time the write happened.
* A defect this branch introduced: the new register holds a **no-cascade**
  foreign key to `orders`, so a cleanup would have failed on it *after* the
  files were gone. Closed with a BEFORE DELETE trigger, without re-emitting
  `finalize_test_data_cleanup()`.

### Performance

Every Order screen opened the same way — session, then profile, then
permissions, then records — and only the first is load-bearing. Sequential round
trips before content, measured from the source at `origin/main` and here:
`/orders` 7 → 4, `/orders/[id]` 8 → 5, both request screens 7 → 4.

No query was dropped, cached or derived, and no capability moved out of the
database. Two improvements were made and then **reverted** rather than weaken
byte-exact guards protecting the PI preview and the import screen.

### Manual testing, September 2026 — two failures and their causes

Nishant tested the preview after applying `20260924`–`20260926`. Three problems
came back. Two had exact causes; both are fixed on this branch.

**Document generation showed "That could not be done just now."**

Not a permission problem, though the sentence implied one and sent the
investigation there. `serviceClient()` read
`process.env.SUPABASE_SERVICE_ROLE_KEY!` — a non-null assertion over a value
the type system cannot vouch for. supabase-js throws `supabaseKey is required.`
when it is absent or empty, and that construction sat **outside** the route's
try/catch. The throw escaped, Next returned a bare 500 with no `message`, and
the card printed its own fallback sentence in place of a diagnosis it never
had. A deployment fault was rendered as a user refusal.

Fixed three ways, because any one of them alone would let it recur through a
different door: the client is built from a checked value and the route answers
`SERVER_NOT_CONFIGURED`; every error response now carries a `message`, which
two did not; and an outermost try/catch means nothing escapes unlabelled. The
client resolves a **code** against a table the bundle owns and never renders
the server's prose.

**Billing percentage Set/Edit failed.**

`can_edit_order_submission()` ANDs its actor test *behind* its state tests, so
the admin branch is unreachable once a PI is submitted or acquires an Order. An
active admin was never able to correct a submitted PI; the rule had simply not
been exercised against one. Fixed in `20260927000000` by adding
`can_admin_edit_order_submission` **beside** the owner rule rather than
widening it — see 05_Business_Rules.

**PI data could not be corrected after import.**

A workbook imported without a client name left the PI showing "Not provided"
and no payment could be attributed to it. Fixed in two parts: `piReadiness()`
gives every surface one shared answer listing everything missing at once, and
`20260928000000` makes the client and party section editable, with a direct
**Add client details** action on the summary where something is missing.

The editing write path is deliberately **one section**, not the whole PI. Client
and party details are ten text columns that feed no total; the commercial inputs
and product rows are different in kind and need atomic recalculation plus a
re-evaluated payment position. Those remain open.

One defect was found by this migration's own assertions before it shipped: the
first cut used `updated_at` for optimistic concurrency, and `now()` is
transaction-scoped, so two writes in one transaction stamped the identical value
and a stale edit compared equal to a fresh one. Replaced with an explicit
monotonic `row_version` counter.

**The correction model was then settled, and the rest of the branch follows it.**

Two paths, approved rather than inferred: a direct edit for anything
descriptive, and Change PI for anything a workbook formula touches. The reason
the split exists at all is that BOE has never computed a PI total — the parser
transcribes what the spreadsheet produced and warns when its own two derivations
disagree — so recreating those formulas in PostgreSQL or React would be
inventing figures. See 05_Business_Rules for the field-by-field table.

`20260929000000` opened dates and terms, `20260930000000` gave the owner a
correction-request channel for a PI that has left their hands, `20261002000000`
opened the product descriptions and their order, and `20261001000000` closed a
latent defect the others would each have hit.

**The activity constraint had already been broken, invisibly.**

`order_submission_activity.action` carries a CLOSED check constraint by design.
`20260923000000` — applied to production — logs `billing_percentage_set` and
never declared it, so every successful billing write on it fails at the moment
it records what it did. Nobody noticed because it could not be reached: the
authority bug refused first, for everybody. Fixing the authority would have
exposed this to the next person who pressed Save. `20261001000000` restates the
set and a source-parsing test holds the two lists together.

That defect was found only because the local verification schema was corrected.
Over a hundred behavioural assertions had passed against a stub table that would
accept any string. **A stub more permissive than the real schema does not prove
less than the real thing — it proves the wrong thing, confidently.**

**Change PI could not run past draft, for anybody.**

The same stage-before-actor shape, in a second place:
`assert_order_submission_editor` refuses on state before it looks at the actor,
so no admin could ever replace the workbook of a submitted PI. And fixing that
alone would have changed nothing visible —
`begin_order_submission_processing` asked the same predicate and would have
refused the lease first. `20261003000000` adds
`assert_order_submission_workbook_editor` beside the old one and re-emits both
functions, each differing in exactly the documented places; two continuity tests
undo those edits and require the applied definitions back line for line.

**What a replacement means after submission** is the substance of that
migration: the finance verification is cleared (the existing trigger fires on a
status change, and a replacement is not one), the corrected values follow onto
the Order without its identity moving, the ready documents are superseded while
their files stay downloadable, and the previous workbook is KEPT — it is what
finance verified and management approved.

**Corrections now reach the generated Excel.** It was the stored workbook with
one cell filled in, so a corrected phone number never appeared in it.
`CONFIRMED_EDITABLE_CELLS` maps ten fields to cells the parser already reads;
nothing commercial is offered, and a field outside the contract is refused
rather than ignored.

---

## Branch — `claude/order-finance-integration-1e3y36`

Order Management and Finance were two modules describing the same money and
disagreeing about it. This branch makes them describe it the same way, and fixes
what the review found on the way through. **The three migrations it adds are
applied to the linked database; the application code is not merged and not
deployed.**

### The canonical attribution rule

One rule, stated once in `src/lib/finance/paymentAttribution.ts` and mirrored by
`order_linked_payment_total()` and the `finance_received_payments` projection:

1. If a payment has ANY active allocation, allocations are authoritative — each
   Order or PI receives only its own active allocated share, and the payment's
   direct `order_id` is ignored entirely, including when it names that Order.
2. If it has no active allocation, the direct link attributes the whole payment.
3. Reversed allocations count for nothing, so a payment whose only allocation was
   reversed falls back to rule 2.
4. Attribution across every target, plus what is unallocated, equals the payment
   exactly — never more.

Before this, a ₹10,00,000 payment linked to Order X and allocated ₹4,00,000 to
Order Y was credited ₹10,00,000 to X *and* ₹4,00,000 to Y: ₹14,00,000 of
attribution for ₹10,00,000 of money. Every screen agreed with every other screen
and all of them were wrong together.

Money is compared and summed in exact decimal on `bigint`
(`src/lib/finance/exactMoney.ts`), never through a JavaScript double, and
`numeric` is carried across PostgREST as the string it arrives as.

### Reads are bounded, and a short read is an error

Finance, Tasks, Quotations, Attendance and Payroll each had list reads that
relied on PostgREST returning everything. PostgREST caps a response at 1000 rows
**silently** — it is a cap, not an error — so those screens were quietly
truncating. Every such read now pages through `fetchAllRows`, and a partial read
raises `PagedReadError` rather than rendering as a short list. Filtering,
searching and tab counts moved server-side; nothing narrows a page of rows on the
client and calls the result a total.

### Security corrections found by the pre-application review

* **Legacy link plus allocation** — the over-attribution above.
* **`can_read_payment_as_participant()`** was `SECURITY DEFINER` with a bare
  `EXISTS` on `public.orders`. Inside a definer that reads as *"the Order
  exists"*, so every authenticated user could read any payment ledger row
  carrying an allocation to any Order. A `SECURITY INVOKER` helper called from
  inside a definer runs as the definer too, so `can_view_order()` could not be
  used there; `can_view_order_as_actor()` is its definer-safe sibling, written in
  `auth.uid()` terms.
* **`order_linked_payment_total()`** was granted to `authenticated` and gated on
  nothing — any signed-in user could ask what any Order UUID had received. It is
  now gated, and returns NULL for an Order the caller cannot see, the same answer
  an unknown UUID gets.
* **Function ACLs** — a hosted Supabase database gives every new function in
  `public` four grants: PostgreSQL's built-in EXECUTE to PUBLIC, plus direct
  entries for `anon`, `authenticated` and `service_role` from the platform's
  `alter default privileges`. `revoke ... from public, anon` leaves
  `service_role` standing. All three functions now carry three explicit revokes
  and one explicit grant, so their ACL depends on no database default.

### Testing

`supabase/tests/` carries a production-shaped schema and a role-based suite —
`run_security_suite.sh` — because the migration set cannot build a database (see
`docs/migrations-are-not-self-contained.md`). It runs the matrix twice: once on
the pre-correction definitions, where the exposures are *required to reproduce*,
and once after the migrations, where every case must hold. It is not a
substitute for the missing baseline schema and must never be added to
`supabase/migrations`.

## Branch migrations — status

| Migration | Applied | What it carries |
|---|---|---|
| `20260924000000` | yes | Confirmed Order handoff — `can_view_order`, four additive SELECT policies |
| `20260925000000` | yes | Document register, claim protocol, publication |
| `20260926000000` | yes | Order-number cycle reset (six-gated; never invoked) |
| `20260927000000` | yes | Admin amendment authority, `supersede_order_documents`, 3-arg billing RPC |
| `20260928000000` | yes | Client and party details, `row_version` |
| `20260929000000` | yes | Dates and terms; ISO-shape date check |
| `20260930000000` | yes | Owner correction requests |
| `20261001000000` | yes | The activity action set, extended — **fixes an applied defect** |
| `20261002000000` | yes | Product descriptions and ordering; money refused by name |
| `20261003000000` | yes | Change PI authority, and what a replacement means after submission |
| `20261004000000` | yes | `finance_received_payments` gains `allocated_total` and `attributed_total`; allocation state computed from attribution |
| `20261005000000` | yes | `order_linked_payment_total()` rewritten to the canonical rule; adds the batched `payment_active_allocation_totals()` |
| `20261006000000` | yes | Participant predicate made definer-safe; the Order total gated; deterministic ACLs on all three functions |

Every migration in this table is applied to the linked database. Applying them
in order matters and always did: `20261001000000` must precede `20261002000000`
and `20261003000000`, which log actions it declares, and `20261006000000`
replaces functions `20261005000000` defines.

**Applied is not deployed.** The application code that reads these functions
lives on `claude/order-finance-integration-1e3y36` and has not been merged.

## Deployment configuration

**No new secret is needed.** The service-role credential is
`SUPABASE_SERVICE_ROLE_KEY`, established by reading the repository rather than
assumed: the name appears over a hundred times across `src/`, it is the name in
`.env.example`, and no other variant exists anywhere in the codebase or the
docs. A route that could not find it was looking correctly and finding nothing,
which is a deployment gap and not a naming disagreement. If document generation
or PI saving reports `SERVER_NOT_CONFIGURED` on the preview, that variable is
absent from the environment and needs adding under exactly that name.

---

# Review Workflow — the Custom Review phase

Date: 13 September 2026

Branch: `feat/review-custom-reapply-monthly-rules` (from `main` after PR #153).
Migration: `20261206000000_customer_review_custom_reapply_and_monthly_rules.sql`
— **not yet applied** at the time of writing.

## Problem

Custom Review Submissions (PR #153, `20261205000000`) let an employee submit
proof of a review they arranged, but:

* a reviewer was never told a review was waiting, and had no count of the queue;
* a rejected review was final — the only way forward was a new submission;
* there was no monthly limit and no requirement for Image Reviews;
* candidates were still pointed at the generated / booked workflow the business
  had decided to pause;
* an approval landing in a month an administrator had already closed below the
  minimum would have been spendable at once (only open months are provisional).

## What was built

* **Reapplication on the same row** (`reapply_customer_review_custom_submission`,
  `PATCH /api/customer-reviews/custom-submissions`): owner only, rejected only,
  corrections plus an optional note; `submitted_at` never moves, so the monthly
  slot and the credit month stay put.
* **An append-only history** (`customer_review_custom_submission_events`),
  written by a trigger for every submission, rejection, reapplication and
  approval.
* **Reviewer notifications** from the same trigger, to active `verify` holders
  except the submitter; a `review` notification category and feed.
* **The pending badge** on Custom Submissions.
* **Monthly rules** in `check_customer_review_custom_month_rules()` under a
  per-employee lock: 10 submissions a month, at least 3 Image Reviews by the
  remaining-slot formula. Two new settings; a settings row with ₹50 / text 1 /
  image 1.5 / 3 / 10 / 3.
* **Candidate Current Month and Last Month panels** and the live reward rules.
* **The generated workflow paused for candidates** — UI routes and a booking
  trigger — with nothing deleted.
* **The closed-month guard** on approval and reapplication.

## Decisions

* **The status keeps its stored name** (`pending_verification`, shown "Pending
  Approval"); no stored draft state — the unsaved form is the draft.
* **The month of a review is its first submission**, for the slot and the credit
  alike, so a reapplication cannot move either.
* **Notifications are written inside the transaction**, not after commit, so a
  notification cannot exist for a submission that rolled back and a retry that
  changes nothing writes none.
* **No penalty.** The existing provisional / lapse model already means a short
  month earns nothing usable; no new negative ledger row was introduced, and the
  knowledge page no longer shows a lapse as a minus figure.

## Verification

`npx tsc --noEmit` 0 errors; `npm run lint` 0 errors, 0 warnings; the SQL suites
applied `20261204000000`–`20261206000000` twice on a bare PostgreSQL 16
container and every assertion passed twice. Full `npm test`, `npm run build` and
`git diff --check` results are in the branch's completion report.

---

# BOE Credits — Half Day and Full Day redemption switches

Date: 13 September 2026

Branch: `feat/boe-credits-redemption-toggles` (from `main` at `ad8a0ac7`).
Migration: `20261208000000_boe_credits_redemption_toggles.sql` — **not yet
applied** at the time of writing.

## Problem

The business wants attendance redemption unavailable for now without removing
it. An administrator could only change the two prices, both were always
required (an empty Half Day value blocked the whole save), and every employee
screen always described both redemptions.

## What was built

* Two independent settings, `half_day_redemption_enabled` and
  `full_day_redemption_enabled`, each with a switch on `/payroll/credits`. A
  switched-off price is disabled in the form, not validated, and kept.
* The shared eligibility rule refuses a switched-off kind
  (`redemption_disabled`), so the payslip lists no offer and
  `POST /api/boe-credits/redemptions` refuses one. A `BEFORE INSERT` trigger on
  `boe_credit_attendance_redemptions` refuses it in the database
  (`BOE_CREDITS_REDEMPTION_DISABLED`).
* The payroll coverage lifecycle skips an Absent → Half Day re-price while Half
  Day is off and leaves the existing coverage in place.
* My Credits and How BOE Credits Work render only the switched-on redemptions;
  with both off neither page names attendance redemption.

## Decisions

* **Configuration, not removal.** Prices, history, ledger rows and balances are
  untouched; switching back on restores the redemption at the price in force.
* **Both redemptions are OFF from the migration onward.** The columns default to
  false, which gives every existing settings row — the active one included —
  `false` without an UPDATE (the table is append-only) or a new row; the stored
  Half Day / Full Day prices are untouched. An administrator switches either on
  later. The in-code fallback is also OFF, so a screen that cannot read the
  settings never offers a switched-off redemption.
* **A trigger, not a re-created redemption function**, so the decimal-credits
  function body is not copied again.

---

# Notifications — quotation and approval silence, and the loading delay

Date: 15 September 2026

Branch: `fix/notifications-quotation-approval` (from `main` at `78869984`).
Migration: `20261212000000_task_review_approval_stops_notifying.sql` — **not
applied**, prepared for review.

## What was built

* Quotation requests write no notification: every Task Management writer reads
  `tasks.task_type`. Approval writes none (the migration). Submit for approval,
  return and reopen still notify. See 05_Business_Rules → NOTIFICATION RULES.
* The Task feed, its unread count, Mark all read and Delete all hide existing
  quotation and approval rows before paging and counting. Nothing is deleted.
* Self Task / Delegate Task are withheld on `/notifications`, every
  `/tasks/quotation-requests` screen and a quotation's detail page.
* `/api/notifications` no longer waits for the View As subject check before an
  ordinary read; the decision is still enforced before anything is returned.

* Mark all read and Delete all send their id chunks up to four at a time, and
  report a failure part-way with exact counts (`partial: true`) instead of
  looking like nothing happened; the browser then re-reads rather than
  restoring rows the server really removed.
* The list, count, delete-all and mark-read handlers are covered by tests that
  RUN them (`src/app/api/notifications/routeBehaviour.test.ts`).

## Measured cause of the loading delay (16 September 2026)

Measured on a preview deployment with temporary `Server-Timing`
instrumentation, since reverted.

WHERE THE TIME GOES, first visit to `/notifications` after signing in:

| Stage | Measured |
| --- | --- |
| Document, first paint | 0.08 s, 0.64 s |
| Page JavaScript ready (one 12 KB chunk took 4.78 s) | 5.35 s |
| List request sent (view mounts at the same moment) | 5.39 s |
| Server time for that request | 3.08 s |
| List data on screen | ~10.1 s |

On a repeat visit, with the JavaScript cached, the same request is sent at
0.18 s and the rows are on screen at 3.07 s — so the first-visit gap is
JavaScript loading, not application logic.

SERVER STAGES (list request): `auth` 0.73 s, `viewas` 0.65 s, query wave
0.97 s, enrichment 1.38 s, total 3.08 s. The unread count: `auth` 0.67 s,
`viewas` 0.26 s, query 0.32 s, total 0.99 s.

REGION, STATED PRECISELY. The Supabase project is in `ap-northeast-1` (Tokyo,
from the Supabase Management API) and every response carries
`x-vercel-id: …::iad1`, so the functions run in US East. Each server-side round
trip to the database measured 0.26–0.97 s, while the same kind of read straight
from the browser measured 0.25–0.7 s. The server time above is five such trips.
A function region matching the database is therefore supported by the stage
timings, but the improvement is an estimate until it is measured:
`docs/proposals/notifications-function-region.md` holds the exact change,
affected routes and rollback. It is a deployment decision and is NOT made on
this branch.

NOT the cause: the console messages reported with the problem ("message channel
closed", "Receiving end does not exist", "No resource with given URL found", an
unused CSS preload) are browser-extension, DevTools and prefetch messages. None
of them appeared in a browser without extensions.

RETURNING FROM A TASK. Pressing Back after opening a task showed the list
0.23 s after the click, served from the browser's cache with no server request
(the API answers `Cache-Control: public, max-age=0, must-revalidate`), so a
returning reader can briefly see a pre-deletion list. Pre-existing, not changed
here.

---

## Meetings — the order-discussion workflow, and How Meetings Work

`20261213000000_meeting_order_discussion_workflow.sql` — written, rehearsed,
**not applied**.

**The problem.** Sales assigns a task to management: "Order 2041 — customer says
the finish is wrong". Management needs that on the next review's agenda in a few
taps, and then needs it to STAY there, with its own continuing history, until
somebody actually resolves it. Some issues finish in one meeting; others run
through five or six.

**Why the Order rail could not do it.** `meeting_orders` is the Order as
discussed in ONE meeting, matched across meetings on `order_number_key`. That
is right for "what is happening with 2041" and wrong for "this particular repair
complaint": one Order can carry two unrelated running-order concerns and an
after-sales replacement at the same time, and each needs its own thread. The
missing unit was the issue itself.

**What was added.** Three tables — the persistent issue
(`meeting_discussion_items`), the issue on one meeting's agenda
(`meeting_discussion_appearances`) and the issue's append-only trail
(`meeting_discussion_events`) — plus one nullable column on
`meeting_order_evidence` so an image attached while discussing an issue is known
to belong to it, and two new triggers on `public.meetings`. No existing policy,
grant, function or trigger was edited.

**Four decisions worth remembering.**

1. **Carry-forward is a trigger, not a step in the browser.** An AFTER INSERT
   trigger on `public.meetings` runs the engine in the transaction that creates
   the meeting, so a review cannot exist without its inherited agenda. It is
   idempotent through `UNIQUE (meeting_id, discussion_item_id)` +
   `ON CONFLICT DO NOTHING`, so a retry adds nothing twice.
2. **The Order row is created LAZILY, not during carry-forward.**
   `meetings_prevent_delete_with_content` refuses to delete a meeting that has
   ANY order row. Creating one per inherited issue up front would have made every
   new draft undeletable — a shipped behaviour this must not change. The row is
   created the first time evidence needs a folder.
3. **The Inbox is not a table.** An open issue that no meeting has claimed IS the
   Inbox. Nothing is moved out of it, so nothing can be lost from it and the
   source task link cannot be dropped.
4. **A reopen clears `resolved_at`/`_by`/`_note`** — the CHECK constraint
   requires an open issue to claim none of them — exactly as a reopen clears
   `meetings.completed_at`. The ORIGINAL resolution therefore survives only in
   the events table, and the reopen event carries the old note forward so the two
   read together.

**The rehearsal earned its keep.** Executed against the linked database inside
`BEGIN … ROLLBACK` with `lock_timeout = '3s'`, it failed twice before it
passed, on two things no repository test could see:

* `SELECT o_uid, o_appearance, o_item, o_meeting INTO …` — plpgsql's
  multi-target `SELECT … INTO` accepts only SCALAR targets, so a convenience
  guard handing back four composite rows did not compile at any call site. The
  guard now returns the caller's id and locks the rows; each writer reads its own.
* `pg_get_function_identity_arguments()` returns parameter NAMES on this stack
  (`p_order_id uuid, p_storage_path text, p_file_name text`), not bare types —
  so the assertion pinning `add_meeting_order_evidence()`'s untouched signature
  was wrong in a way that only an apply could reveal.

Afterwards: no table, column, function or trigger left behind, and
`migration list --linked` still shows `20261213000000` local-only. That rehearsal
was of an EARLIER version of the file; after the PR review changes below it no
longer counts, and must be repeated on the frozen file before the migration is
applied.

**How Meetings Work** (`/meetings/guide`) ships with it — an in-app visual
guide inside the Meetings module, offered from the module header on every
Meetings screen. Its diagrams are CSS grids rather than SVG, so a mind map
becomes a stack of cards and a horizontal flow becomes a vertical timeline
instead of overflowing a phone. Every sentence lives in `guideContent.ts` and
is asserted against the constant or the migration that actually implements it:
a guide that describes a rule the system does not apply is worse than no guide.

**One change outside Meetings:** an "Add to Meeting" action and its quick sheet
on Task Detail. It writes no task field, no activity row and no notification.

**What review then found, and fixed.** A second pass — the migration applied on a
disposable local stack, the real components rendered at desktop and phone widths
— found defects that neither the text tests nor the production rehearsal could:

* **An issue could be placed on the wrong review.** Carry-forward matched on the
  review type, but manual attach and capture-with-target did not. A shared
  mapping function now decides the pairing on every path.
* **An Inbox item would enter a back-dated meeting.** It now only enters a
  meeting dated on or after the day it was raised.
* **A completed meeting showed today's state.** An issue resolved in a meeting and
  reopened a month later made that meeting read "Open". Meetings now replay the
  trail up to their completion, and show later changes beside the record.
* **A repeat capture said "in the Inbox" for an issue already on an agenda.**
* **A `$$` became `$`** in a function inserted by a Node script:
  `String.replace` treats `$$` in a replacement string as a literal `$`.
  Script edits to SQL now use split/join.
* Rendered-only defects: a follow-up task's owner line ran past a phone's edge;
  Add to Meeting could be submitted while the meeting list was still loading
  (silently choosing the Inbox); a completed meeting said "resolved today"; the
  earlier-meetings count included the non-meeting group; the Inbox's waiting chip
  wore the After Sales amber.

**Undo was removed** from the capture result. No operation removes an agenda
entry, and using Resolve to stand in for one would record that the business issue
was finished.

**A CSS placement choice avoided a change outside scope.** Appending the Meetings
block at the end of `globals.css` made `piDetail.render.test.tsx` — whose
`pageCss()` slices from its own heading to the end of the file — judge the
Meetings rules as PI rules. The block now sits before the PI block, and that test
is untouched.

**PR #164 review — the second round (2026-09-16).** Reading the complete diff
against the database the migration builds on found seven defects, four of them in
the migration itself. They were fixed in a follow-up commit rather than an
amended one, so the review trail stays readable:

1. **A draft holding a discussion could be deleted.** The existing delete guard
   only looks for Order rows, and appearances cascade with their meeting — so a
   draft in which issues had been updated or resolved could be deleted, taking
   that meeting's record with it and leaving a resolution attached to no meeting.
   A second BEFORE DELETE trigger now refuses any substantive activity; only
   untouched automatic appearances (the new `placement` column) may go.
2. **Meeting notes were readable outside the meeting.** Trail rows followed the
   ISSUE's visibility, so an attendee of one meeting could read another meeting's
   updates and decisions, and a Meetings `edit` grant could read every issue in
   the company. Trail rows now follow the meeting they were recorded in
   (`can_view_discussion_event`), `resolution_note` is not granted to any client
   role, and `edit`/`manage` reveal an issue only while it is in the Inbox.
   This is the same rule `meeting_update_history` already follows.
3. **The Inbox was computed in the browser** as "open issues minus the agendas I
   can see", which lists an issue on somebody else's meeting as waiting. It is now
   `list_meeting_discussion_inbox()`.
4. **Clearing a decision silently did nothing**, because NULL meant "leave alone".
   Clearing is now an explicit flag.
5. **"Earlier meetings" included later meetings** on a completed meeting's view.
6. **Add to Meeting was drawn for people the database always refuses** — any
   Meetings user on a closed task, and task delegators. It is now drawn only for
   the creator, the current assignee or an admin.
7. **Retrying a failed follow-up link created a second task.** The created task
   is now kept and only "Retry link" is offered.

Smaller: the Inbox save showed "Added to the meeting agenda"; a failed meeting
list in Add to Meeting read as "no live meeting" and sent the issue to the Inbox;
the guide promised a Task Detail indicator that does not exist; "resolved today"
counted an issue reopened later; and a failed load could render as an empty board
or an empty Inbox.

**Proving the new checks can fail.** The local suite grew to 29 sections, with
fixtures for an edit-only grant and a user whose Meetings access is removed, and
every "cannot see" check first proves the hidden rows exist. Three checks that
could never fail were rewritten. Then three deliberate breakages of the migration
were run against it — notes readable through issue visibility, a deletion guard that
only checks manual placement, and an Inbox read that trusts visible appearances — and
each was caught by the section written for it before the file was restored
byte-for-byte.
