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
