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

# Phones: content first (owner, 2026-11-05)

Below 768px the page's content must start on the first screen. Every module layout follows these rules; the shared pieces enforce most of them.

- **Header: one row.** ☰, the title (one line), one short line under it (the subtitle, cut to one line), and icon buttons. Actions a layout adds to every page (Hand over cash, the Orders/Finance switch, Self Task and Delegate Task) go into `PhoneHeaderMenu` (⋯ or +) on a phone; on a desktop they stay as buttons (`.boe-desktop-only` / `.boe-phone-only`).
- **Number cards: one chip row.** `.fin-stats` scrolls sideways as chips ("● Running 13"); the line under the number is dropped.
- **Filters: search on its own row, chips under it.** A `FilterChip` opens as a sheet from the bottom of the screen. Confirmed Orders uses one Filter button (`PhoneListControls`).
- **Tables: cards.** Wrap a table in `PhoneTableCards`; each row becomes a card with "Column  value" lines. Nothing scrolls sideways.
- **Touch: 44px.** Buttons, tabs (`StatusTabs`), back links and pills are at least 44px tall (pills 40px), with 8px between them.


Consistency over experimentation.

Users should immediately understand how to navigate any BOE module without additional training.