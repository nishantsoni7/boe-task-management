# BOE TASK MANAGEMENT

# Module Architecture

Last Updated: September 2026 — Order Management module added; earlier sections unchanged.

---

# PURPOSE

This document describes the structure of the BOE Task Management application.

It is intended to help future developers, ChatGPT sessions, and Claude sessions quickly understand:

* Module organization
* Page structure
* Navigation structure
* Major feature ownership
* Important implementation areas

This document focuses on architecture and module relationships, not business rules.

---

# APPLICATION OVERVIEW

BOE Task Management is a modular internal operating system.

Current major modules:

* Authentication
* Members
* Task Management
* Notifications
* Performance
* Team Performance
* Sample Tracking
* Attendance & Payroll
* Assets & Access
* Employee Records (planned)

---

# TECHNOLOGY STACK

Frontend

* Next.js 16
* React
* TypeScript
* Tailwind CSS v4

Backend

* Supabase

Database

* PostgreSQL (Supabase)

Hosting

* Vercel

Version Control

* GitHub

---

# REPOSITORY STRUCTURE

Current project structure:

```text
src/
public/
supabase/
docs/

package.json
package-lock.json
next.config.ts
.env.local
```

The old root-level app folder should not exist.

All application development should happen inside src/.

---

# MAIN APPLICATION AREAS

## Dashboard

Purpose:

Landing page after login.

Provides operational visibility and quick access.

---

## My Tasks

Purpose:

Employee task execution workspace.

Key Functions:

* View tasks
* Update tasks
* Create self tasks
* Review due dates
* Review priorities

Primary User:

All employees

---

## Assigned By Me

Purpose:

Track delegated work.

Key Functions:

* Review assigned tasks
* Review status
* Review ownership
* Review progress

Primary User:

Managers and task creators

---

## Task Detail

Purpose:

Single source of truth for a task.

Contains:

* Status
* Activity history
* Attachments
* Conversations
* Ownership
* Due dates
* Priority

---

## Notifications

Purpose:

Display important task events.

Contains:

* Read status
* Notification actions
* Task links

---

## Performance

Purpose:

Employee self-review and accountability.

Contains:

### Today

* Daily score
* Coaching
* Reflection
* EOD

### Monthly

* Current month
* Last month
* Daily score history

---

## Team Performance

Purpose:

Management visibility.

Contains:

* Attention Required
* Stuck Tasks
* Waiting Tasks
* Blocked Tasks
* Overdue Tasks

Admin-only access.

---

## Members

Purpose:

Employee management.

Contains:

* Employee list
* Activation
* Deactivation
* Restore
* Password reset

Admin-only access.

---

# SAMPLE TRACKING MODULE

Status:

Active Development

Purpose:

Manage complete sample lifecycle.

Current Areas:

* Requests
* Approvals
* Dispatch
* QR Tracking
* Lost Samples
* Returns

Expected Future Areas:

* Customer sample history
* Lifecycle analytics
* Sample notifications

---

# ATTENDANCE & PAYROLL MODULE

Status:

Operational. **One module in the user interface, two domains in the code.**

Reference:

ATTENDANCE_PAYROLL_MODULE.md (start here), ATTENDANCE_MODULE_PLAN.md,
PAYROLL_ATTENDANCE_RULES.md, PAYROLL_RULES_V1.md

Purpose:

Attendance is where payroll's input comes from, so the two present as a single
module: one launcher card, one shell, one sidebar. Internally they stay
separate — separate tables, calculations, guards, audit trails and URL trees.
Merging the navigation did not merge the domains.

## Surfaces

| Surface | Routes | Who |
| --- | --- | --- |
| Management | `/attendance/*`, `/payroll/*` | Admins only, always |
| Self-service | `/my-attendance`, `/my-payroll`, `/my-issues` | The employee's own record only |

Guards are separate and unchanged: `AttendanceGuard`
(`src/app/attendance/layout.tsx`) and `PayrollGuard`
(`src/app/payroll/layout.tsx`). `app_modules` still holds two rows, `attendance`
and `payroll`, configured independently in Control Center; the launcher card is
shown when either admits the viewer.

## Areas

Attendance: monthly fingerprint import, attendance records, employee/device
mapping, monthly attendance review, corrections and correction log, holidays.

Payroll: payroll runs, monthly payroll preview, per-employee payslips,
adjustments, settlements, salary report, locking/unlocking, payroll settings,
the calculation guide.

Shared: the employee issue workflow (raise, review, re-raise) on the one
`attendance_payroll` notification category.

---

# ASSETS & ACCESS MODULE

Status:

Asset lifecycle operational. Access credentials still V1 (admin-only).

Purpose:

Track company assets through their whole life, and record employee access.

## Screens

| Route | What it is |
| --- | --- |
| `/assets-access` | The module screen. Five views selected in the sidebar, deep-linkable with `?view=` |
| `/assets-access/[id]` | One asset's own permanent page — the single source of truth for it |
| `/assets-access/notifications` | Assets' own notification feed |

Sidebar views: My Assets, My Access, Notifications · Asset Inventory, Asset
Requests, Access Register (each permission-gated).

Asset detail sections: Overview, Assignment History, Repair & Service,
Warranty & Documents, Activity History.

## Tables

| Table | Holds | Mutability |
| --- | --- | --- |
| `assets` | The asset itself: identity, purchase, warranty, condition, current location and department | Updatable by whoever holds `edit`; every change audited |
| `employee_assets` | ONE custody period, with its one-time acceptance | Written only by the custody functions |
| `asset_transfers` | Every movement of custody, ever | **Append-only** — no UPDATE, no DELETE, for anyone |
| `asset_service_records` | One repair / maintenance / inspection / upgrade event | Written only by the service functions; corrections are admin-only and audited |
| `asset_documents` | Invoice, warranty card, supporting files | Insert + soft-delete only; never erased |
| `asset_activity_log` | The audit trail | **Immutable** — no INSERT, UPDATE or DELETE policy for anyone, including admins |
| `asset_change_requests` | Non-admin edit / removal requests | Insert + read; decisions only via definer functions |
| `access_records` | Employee login / credential assignment | Admin-only while `secret_value` is plaintext |

## Operations

Every operation that moves an asset is ONE `SECURITY DEFINER` function that
writes the custody row, the asset row, the movement record and the audit entry
in a single transaction:

`assign_asset` · `transfer_asset` · `return_asset` · `mark_asset_lost` ·
`recover_lost_asset` · `send_asset_for_repair` · `complete_asset_service` ·
`add_asset_service_record` · `correct_asset_service_record` · `retire_asset` ·
`restore_asset` · `remove_asset_document` · `accept_employee_asset`

## Permission actions (`assets_access`)

| Action | Grants |
| --- | --- |
| `view` | Read the inventory and who holds each asset |
| `create` | Add an asset |
| `assign` | Give an AVAILABLE asset to an employee |
| `edit` | Change master, warranty and document details; add historical service records |
| `manage` | Transfer, return, mark lost, recover, repair round-trip, retire, restore |
| `delete` | Remove an eligible, never-used asset |

Admin bypasses the engine, as in every cut-over module.

## Storage

Private bucket `asset-documents`. The asset id is always the first path
segment, because the storage policies read ownership from it. Files are reached
only through short-lived signed URLs. 10 MB per file, an explicit MIME
allow-list, and no macro-enabled Office formats or archives.

## Notifications

The shared `notifications` table with `asset_*` enum types and the ASSET id in
`entity_id`. Written by `/api/assets/notify` **after** the transaction commits,
never inside it. The feed, mark-read and delete behaviour are the shared
`NotificationsView` — no second notification architecture.

---

# EMPLOYEE RECORDS MODULE

Status:

Planned

Expected Areas:

* Personal information
* Employment history
* Documents
* Department information

---

# NAVIGATION STRUCTURE

## BOE OS Module Navigation Rule

Each BOE OS module must have independent module-specific navigation. No module sidebar should link directly into unrelated modules.

- Every authenticated module layout must use its own layout component with only that module's nav items.
- "Back to BOE OS" (→ `/modules`) is the only permitted cross-module exit from within a module sidebar.
- Shared generic layouts (e.g. `BoeOsLayout`) must NOT be used inside module pages if they carry nav links to other modules.

### Showroom QR sidebar items

| Label | Route | Condition |
|---|---|---|
| My Inquiries | `/showroom-admin` | All users |
| My QR Code | `/showroom-admin/qr` | All users |
| Product Master | `/showroom-admin/products` | Admin only |
| Back to BOE OS | `/modules` | All users |

---

Current navigation follows a role-based model.

Examples:

Employee:

* Dashboard
* My Tasks
* Performance
* Notifications

Manager:

* Dashboard
* My Tasks
* Assigned By Me
* Performance

Admin:

* Dashboard
* My Tasks
* Assigned By Me
* Members
* Team Performance
* Assets & Access

Navigation visibility is controlled by user role.

---

# DATABASE OWNERSHIP

High-Level Areas

Tasks

* Tasks
* Activity Logs
* Notifications

Performance

* Daily Performance
* Monthly Performance
* EOD Entries

Samples

* Sample Requests
* Sample Dispatch
* Sample Audit History

Attendance & Payroll

* Attendance Records
* Payroll Runs
* Payslips

Assets

* Employee Assets
* Employee Access Records

---

# DEVELOPMENT SAFETY AREAS

The following areas require additional caution:

Authentication

* Login
* Passwords
* User access

Task Lifecycle

* Status updates
* Completion logic
* Restore logic

Performance Scoring

* Daily calculations
* Monthly calculations

Sample Tracking

* Approval logic
* Dispatch logic
* Audit tracking

Payroll

* Salary calculations
* Deductions
* Adjustments

---

# DOCUMENTATION REFERENCES

Read in this order:

1. 01_Project_Master_Context.md
2. 02_Current_System_State.md
3. 05_Business_Rules.md
4. 03_Development_History.md
5. 04_Current_Roadmap.md

Reference Folder:

* BOE_Operational_Design_Principles.html
* BOE_Operational_UI_System.html
* MASTER_PRODUCT_VISION.md

These documents collectively represent the source of truth for the project.

---


---

# GLOBAL MODULE NAVIGATION STANDARD

All current and future BOE modules must follow a consistent navigation structure.

The purpose is to ensure employees do not need to relearn navigation when moving between modules.

---

## Sidebar Layout Structure

Every module must use the following layout:

```text
Top Section
- Module Icon
- Module Name
- Home Button

Middle Section
- Module-specific navigation only

Bottom Section
- User Profile
- Account Settings
- View As User (Admin)
- Sign Out
```

---

## Module Header

The top section must contain:

- Module icon
- Module name
- Home button

The Home button must always return the user to:

```text
/modules
```

The Home button should never take the user directly into another module.

---

## Module Navigation

The middle section should contain only navigation items related to the current module.

Examples:

Task Management:
- Dashboard
- My Tasks
- Assigned By Me

Sample Tracking:
- Pending Approval
- Approved
- Dispatched

Assets & Access:
- Employee Overview
- Inventory

Future modules should follow the same principle.

Cross-module navigation is not permitted inside module sidebars.

---

## Global User Area

The bottom section must be present in every module.

Required elements:

- User profile
- Account Settings
- View As User
- Sign Out

---

## Account Settings

Account Settings should open within the current module layout.

The sidebar must remain visible.

Users should not be redirected into another module to access account settings.

---

## View As User

All modules must support Admin View Mode.

Purpose:

- Permission testing
- Visibility testing
- Workflow testing

Rules:

- Admin remains in the current module
- Only effective user context changes
- Same page remains open
- Clear active-view banner must be shown
- Exit View Mode returns to admin context

---

## Future Module Requirement

Before creating a new module, verify:

1. Module-specific sidebar exists.
2. Home button returns to /modules.
3. User profile area exists.
4. Account Settings exists.
5. View As support exists.
6. Sign Out exists.

No module should be launched without complying with this standard.

# LONG-TERM ARCHITECTURE DIRECTION

The platform should evolve as a modular BOE operating system.

Future modules should be added as independent functional areas rather than tightly coupling unrelated workflows.

Goals:

* Clear ownership
* Simple maintenance
* Controlled growth
* Operational usability
* Long-term scalability

Architecture decisions should favor simplicity and maintainability over premature complexity.

---

## Access Control V1 — Architecture

**One authority, one vocabulary.** The permission engine
(`permission_modules` / `permission_actions` / `role_permissions` /
`department_permissions` / `employee_permission_overrides`, resolved by
`resolve_permission`) decides access. The level vocabulary lives once, in
`src/lib/permissions/levels.ts`, and is shared by the screen, the API and the
tests — the page no longer keeps its own copy.

**Layers**

| Layer | File |
|---|---|
| Levels and protected actions | `src/lib/permissions/levels.ts` |
| What the engine actually decides, per module | `src/lib/permissions/enforcement.ts` |
| Module visibility from effective access | `src/lib/permissions/moduleVisibility.ts` |
| Capability derivation | `assetsAccess.ts`, `meetings.ts`, `finance.ts`, `orders.ts` |
| SQL authorization helpers | `actor_has_permission`, `actor_has_module_permission` (20260901000000) |

**Capability pattern.** A module turns raw effective permissions into named UI
booleans in one file, and every button maps to exactly one capability, so a
control can never appear for a permission its RPC will refuse.

**Enforcement is stated, not assumed.** `enforcement.ts` records per module
whether the engine is Active, Partly active, Prepared, or Not used, and
repository tests fail when a claim and the code disagree. A single
enforced/not-enforced flag could not describe Orders and had gone stale on
Meetings.

**Legacy `app_modules` is retained deliberately** for the modules that still
depend on it. It is labelled honestly rather than falsely routed through the
engine, which keeps rollback cheap.

**No V2 features in V1**: no role templates, department-role editors, scopes,
approval chains, access-history screens, or permission exports.

---

# ORDER MANAGEMENT MODULE

*September 2026. Marked **(branch)** where the work is complete on
`claude/confirmed-order-handoff-performance` but not merged and not applied.*

## Screens

| Route | File | What it is |
| --- | --- | --- |
| `/orders` | `src/app/orders/page.tsx` | Dashboard — running Orders and five figures |
| `/orders/all` | `src/app/orders/all/page.tsx` | Every Order the viewer may see |
| `/orders/[id]` | `src/app/orders/[id]/page.tsx` | One Confirmed Order |
| `/orders/drafts` | `src/app/orders/drafts/page.tsx` | PI drafts and submissions |
| `/orders/drafts/[submissionId]` | `.../[submissionId]/page.tsx` | One PI — review, decisions, payments, approval |
| `/orders/import` | `src/app/orders/import/page.tsx` | Upload a PI workbook and read it back |
| `/orders/requests` | `src/app/orders/requests/page.tsx` | Order Requests list |
| `/orders/requests/[id]` | `src/app/orders/requests/[id]/page.tsx` | One Order Request |
| `/orders/notifications` | `src/app/orders/notifications/page.tsx` | Module notifications |

`src/app/orders/layout.tsx` is a guard on the critical path of all nine: it
renders a loading state instead of its children until it has confirmed module
entry, so every round trip it spends is spent by every route.

## API routes

| Route | Runtime | What it does |
| --- | --- | --- |
| `/api/orders/[id]` | node | one Order, server-side |
| `/api/orders/import/process-draft` | node | **the trusted parse** — downloads the workbook, re-parses it server-side, persists only its own reading |
| `/api/orders/[id]/documents` **(branch)** | node, `maxDuration = 60` | request → claim → generate → publish |
| `/api/orders/test-data-cleanup` | node | claim → storage removal → finalize |
| `/api/orders/requests/*`, `/api/orders/submissions/*`, `/api/orders/notify` | node | attachments, deletion, notifications |

## Tables

| Table | What it holds |
| --- | --- |
| `orders` | the Confirmed Order register. **No DELETE policy**, and `orders_prevent_delete` refuses every path including the service role |
| `order_activity_log` | the Order's own trail |
| `order_change_requests` | proposed amendments |
| `order_submissions` | the PI record |
| `order_submission_items` / `_item_images` | its product lines and photographs |
| `order_submission_activity` | the PI's **review** trail — deliberately not visible through the Order door |
| `order_requests` / `_attachments` / `_activity` | the older Order Request flow |
| `order_number_cycle` | single-row, admin-configured next number. RLS on, **no policies at all** |
| `test_data_cleanup_claims` / `_audit` | the cleanup protocol |
| `order_document_versions` **(branch)** | the document register |
| `order_number_cycle_resets` **(branch)** | a permanent audit of every reset |

## Storage — `order-files`

Private, 10 MiB per object, and **no UPDATE policy for any role**. That is what
makes a stored object immutable and what defeats upsert; every generation path
is built around it rather than asking for an exception.

```
submissions/{submission_id}/original/{uuid}.xlsx        the uploaded workbook
submissions/{submission_id}/images/{item_id}.{ext}      extracted photographs
orders/{order_id}/versions/{v}/attempts/{n}/approved.xlsx   (branch)
orders/{order_id}/versions/{v}/attempts/{n}/approved.pdf    (branch)
```

Attempt-scoped, because objects are immutable: every write goes to a key nothing
has ever occupied, so a retry never needs upsert. Reads are always **short-lived
signed URLs** minted through the reader's own session — the bucket is never
public and no page embeds a URL.

## Permission actions (`orders`)

| Action | Means | Protected |
| --- | --- | --- |
| `view` | module entry only — never company-wide sight | no |
| `view_all` | company-wide sight of every Order | **yes** |
| `create` | upload and own a PI | no |
| `approve` | convert an Order **Request** (older, unrelated to PI approval) | no |
| `approve_order` | **PI approval** — the management approval authority | **yes**, deny-by-default |
| `approve_advance_exception` | settle a reduced-payment exception | **yes** |
| `manage` | amend a Confirmed Order directly | **yes** |
| `can_be_order_assignee` | eligibility other people's forms read | per-employee |

Finance carries two that Order Management depends on: `finance.allocate`
(record a payment against a PI) and `finance.approve` (verify one).

## The visibility predicates

Two doors, deliberately separate, and neither implies the other:

| Predicate | Means | Admits |
| --- | --- | --- |
| `can_view_order_submission(uuid)` | **PI review** visibility | the owner, the named reviewer, an `orders.approve_order` holder, an admin, a finance verifier on a submitted/approved record |
| `can_view_order(uuid)` **(branch)** | **Order** visibility | whatever the `orders` SELECT policies admit: admin, operations, requester, assignee, `orders.view_all` |
| `can_view_order_submission_via_order(uuid)` **(branch)** | the Order door onto an approved PI | a viewer of the Order the PI became — and never a draft |

`can_view_order` is **SECURITY INVOKER**, which is the design and not an
oversight: it *asks* the `orders` policies rather than restating them, so it can
never drift from the rule it stands for. The consequence is that it must not be
called from inside a SECURITY DEFINER function, where the current user is the
table owner and row security is bypassed.

## Document generation *(branch)*

```
src/lib/orders/orderDocuments.ts       states, paths, the view model, the
                                       failure allow-list
src/lib/orders/confirmedExcel.ts       which workbook, and proving it is that one
src/lib/orders/confirmedWorkbook.ts    the ZIP surgery and its safety gate
src/lib/orders/confirmedPdf.ts         what the PDF says, and where pages break
src/lib/orders/confirmedPdfRender.ts   pdfkit + sharp; decides nothing
src/app/api/orders/[id]/documents/     the worker
```

The split between `confirmedPdf` and `confirmedPdfRender` is deliberate:
everything that could be **wrong** about the document — a figure disagreeing
with the PI, a row lost at a page break, a header that does not repeat — is
decided in a pure module with no PDF library in its import graph, and is tested
without producing a byte of binary.

`request` is authorized **as the caller** by two RLS policies; `claim`,
`complete` and `fail` are SECURITY DEFINER and revoked from every client role.

## Where the shared PI logic lives

Nothing about a PI is implemented twice. The import preview, the PI detail
screen, the Order handoff and the confirmed PDF all read the same builders:

```
src/lib/pi/workbookReader.ts      the archive and cell layer
src/lib/pi/masterSheetParser.ts   the template, its fingerprint, its diagnostics
src/lib/pi/previewView.ts         what a figure IS — formatting, the commercial rows
src/lib/orders/draftsView.ts      persisted rows → the shapes those builders take
src/lib/finance/piPaymentView.ts  the payment position, from the database's own sums
src/components/orders/piPreview.tsx  the card, the table head, the thumbnails, the viewer
```

`src/lib/pi/previewView.ts`, `masterSheetParser.ts` and `piPreview.tsx` are held
**byte-for-byte** against their Phase-C base by `finalApprovalScope.test.ts`,
because they are shared across two screens and a change to any of them changes
both.

## Testing

Order Management is tested at three levels, and the boundaries are deliberate:

* **Pure unit tests** for every view model, formatter and state machine.
* **Repository checks** (`*Schema.test.ts`) that read the migrations themselves,
  because every promise a migration makes lives in SQL and fails silently — in
  the permissive direction — if a later change relaxes it. TypeScript sees none
  of it.
* **Behavioural assertion scripts** in `supabase/tests/*.sql`, run by hand
  against a controlled database inside one transaction that ends in `ROLLBACK`.
  These are where RLS is actually exercised, and they matter because a source
  guard proves a policy exists, not that it refuses the right person.
