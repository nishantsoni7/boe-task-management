# BOE TASK MANAGEMENT

# Module Architecture

Last Updated: June 2026

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
* Attendance (planned)
* Payroll (planned)
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

# ATTENDANCE MODULE

Status:

Planned / Foundation

Reference:

ATTENDANCE_MODULE_PLAN.md

Expected Areas:

* Attendance dashboard
* Leave management
* QR attendance
* Attendance uploads
* Employee attendance history

---

# PAYROLL MODULE

Status:

Planned / Foundation

Reference:

PAYROLL_RULES_V1.md

Expected Areas:

* Payroll generation
* Salary review
* Payslips
* Payroll adjustments

---

# ASSETS & ACCESS MODULE

Status:

In Development

Purpose:

Track company assets and employee access.

Expected Areas:

* Asset assignment
* Asset returns
* Access records
* Administrative controls

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

Attendance

* Attendance Records
* Leave Requests

Payroll

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
