# BOE Module Layout Standard

Last Updated: June 2026

## Purpose

This document defines the standard layout structure that must be used by all BOE modules.

The objective is to provide a consistent user experience across the platform.

Every module should feel familiar regardless of functionality.

---

# Standard Module Layout

Every module must use a two-column layout.

```text
┌──────────────────────┬─────────────────────────────┐
│                      │                             │
│      SIDEBAR         │       CONTENT AREA          │
│                      │                             │
│                      │                             │
└──────────────────────┴─────────────────────────────┘
```

---

# Sidebar Structure

The sidebar always contains three sections.

---

## Section 1: Module Header

Contains:

- Module icon
- Module name
- Home button

Example:

[Samples]     [Home]

Rules:

- Home button always returns to `/modules`
- Home button position should remain consistent
- Module name should remain visible

---

## Section 2: Module Navigation

Contains only module-specific navigation items.

Examples:

Task Management:

- My Tasks
- Assigned By Me
- Completed
- Cancelled

Attendance:

- Dashboard
- Records
- Monthly Review

Assets:

- Employee Overview
- Inventory

Rules:

- No cross-module links
- No navigation to unrelated modules
- Only current module options

---

## Section 3: Global User Area

Located at bottom of sidebar.

Contains:

### User Profile

Displays:

- Name
- Role
- Team (optional)

---

### Account Settings

Opens inside the current module layout.

Sidebar remains visible.

Only the content area changes.

---

### View As User

Admin-only feature.

Allows testing module visibility from another user perspective.

Rules:

- Remain on same page
- Remain inside same module
- Show active view banner
- Exit returns to admin view

---

### Sign Out

Always final item.

Always located at bottom.

---

# Content Area

The right side of the screen is reserved for module content.

Examples:

- Dashboard
- Tables
- Forms
- Reports
- Settings
- Detail pages

Changing pages should not affect sidebar structure.

---

# Future Module Requirement

Every new module must reuse this layout standard.

Examples:

- Showroom QR
- Employee Records
- CRM
- Production
- Procurement
- Dispatch

All future modules must comply with this layout.

---

# Design Principle

Consistency over experimentation.

Users should immediately understand how to navigate any BOE module without additional training.