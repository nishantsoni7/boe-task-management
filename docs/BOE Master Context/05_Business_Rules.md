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
