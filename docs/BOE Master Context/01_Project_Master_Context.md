# BOE TASK MANAGEMENT

## Project Master Context

### Project Overview

BOE Task Management is the internal operating platform being developed for Best of Exports (BOE).

The objective is to replace scattered communication, informal follow-ups, and manual tracking with a structured system that improves visibility, accountability, execution, and operational control across the company.

The platform is intended to become the central operating system for BOE and will gradually expand beyond task management into broader business operations.

---

## Company Context

Company: Best of Exports (BOE)

Location: Jodhpur, Rajasthan, India

Industry: Manufacturing and export of hospitality furniture for hotels, restaurants, cafés, resorts, villas, and commercial hospitality projects.

The company operates through multiple departments and requires clear coordination between sales, design, production, procurement, quality control, dispatch, administration, HR, and management teams.

---

## Long-Term Vision

The long-term goal is to create a single internal platform covering:

* Task Management
* Performance Management
* Sample Tracking
* Attendance Management
* Payroll Management
* Employee Records
* Asset Management
* Internal Communication
* Approvals and Workflows
* Operational Reporting
* Department-Specific Modules

The system should eventually become the primary operating platform used by BOE employees on a daily basis.

---

## Current Development Philosophy

The project follows a practical implementation-first approach.

Core principles:

* Build working solutions before perfect solutions.
* Keep workflows simple.
* Minimize clicks and typing.
* Prefer operational clarity over visual complexity.
* Avoid unnecessary dashboards and reports.
* Validate ideas through actual team usage before expanding them.
* Improve gradually based on feedback from real users.

The goal is adoption and usability rather than feature count.

---


## Global Module Standards

All BOE modules must comply with:

- BOE_GLOBAL_NAVIGATION_STANDARD.md
- BOE_MODULE_LAYOUT_STANDARD.md

These standards apply to all current and future modules.

No new module should be designed or implemented without following these standards.

## Primary Business Objectives

The platform is designed to improve:

* Accountability
* Task ownership
* Follow-up discipline
* Communication visibility
* Employee productivity
* Team coordination
* Manager oversight
* Operational transparency

Every new feature should support at least one of these objectives.

---

## Technology Stack

Frontend:

* Next.js 16
* React
* TypeScript
* Tailwind CSS v4

Backend:

* Supabase

Database:

* PostgreSQL (Supabase)

Authentication:

* Supabase Authentication

Hosting:

* Vercel

Version Control:

* GitHub

---

## Production Environment

Production URL:

https://boe-task-management.vercel.app

Deployment Flow:

GitHub → Vercel

Database:

Supabase Production Project

The production environment is actively used by BOE employees.

Changes should be treated as production changes and verified carefully before deployment.

---

## User Roles

Current user categories include:

* Admin
* Manager
* Employee

Visibility and permissions may vary depending on role and module.

Administrative users have access to management and reporting functions that are not visible to standard employees.

---

## Product Design Principles

The user interface should prioritize:

* Fast loading
* Clear navigation
* Low training requirements
* Mobile-friendly layouts
* Minimal data entry
* Clear ownership
* Clear status visibility

The application is designed primarily for operational staff rather than technical users.

---

## Development Method

Development is performed in small, isolated tasks.

Each task should:

1. Solve one problem.
2. Affect the minimum number of files.
3. Be verified before moving to the next task.
4. Be committed only after successful testing.

Large architectural changes should be avoided unless clearly justified.

---

## Important Technical Constraints

The following items must not be changed without explicit approval:

* Supabase project configuration
* Supabase production data
* GitHub repository structure
* Vercel project configuration
* Authentication architecture
* Existing production workflows

Any major change must be evaluated for impact on current users before implementation.

---

## Success Criteria

The platform is successful when:

* Employees consistently use it as part of their daily work.
* Managers can easily identify delays, blockers, and ownership gaps.
* Communication becomes traceable and visible.
* Follow-ups require less manual effort.
* Operational decisions can be made using information available inside the system.

The focus is operational effectiveness rather than software complexity.
