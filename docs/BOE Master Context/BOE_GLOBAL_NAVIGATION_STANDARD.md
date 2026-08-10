# BOE Global Navigation Standard

Last Updated: 10 August 2026

## Purpose

This document defines the standard left navigation structure for all BOE OS modules.

This standard applies to all current and future modules, including:

- Task Management
- Sample Tracking
- Attendance & Payroll
- Assets & Access
- Showroom QR
- Employee Records
- Future BOE modules

The goal is to keep module navigation consistent, simple, and easy for employees to understand.

---

## Global Rule

Every BOE module must have its own module-specific left navigation.

The left navigation must not become a common cross-module menu.

Module navigation should only contain options related to the current module.

A module may own more than one route tree. `Attendance & Payroll` owns
`/attendance/*`, `/payroll/*` and the self-service `/my-*` routes, and serves all
of them from **one** navigation definition and **one** shell — see
`docs/Module Docs/ATTENDANCE_PAYROLL_MODULE.md`. Two route trees is not a licence
for two sidebars; a second copy of a link list is how the two drift apart.

Desktop and mobile navigation must come from the same source of truth. The mobile
menu is the same sidebar element with a class toggled, never a second list.

---

## Standard Sidebar Structure

Every module sidebar must follow this structure:

```text
Top:
- Module icon
- Module name
- Home button

Middle:
- Current module navigation options only

Bottom:
- Logged-in user profile
- Account Settings access
- View As user switcher for admins
- Sign Out