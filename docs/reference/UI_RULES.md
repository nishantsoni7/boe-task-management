> ## ⚠️ Partly superseded
>
> This file is **historical**. The UI *philosophy* below (operational, fast,
> compact, mobile-first, low friction) is still the direction, but the
> **source-of-truth claim is not current**: `BOE_Dashboard_Layout_Redesign.html`
> is **absent from this repository**.
>
> The current mandatory standards are
> [BOE_GLOBAL_NAVIGATION_STANDARD.md](../BOE%20Master%20Context/BOE_GLOBAL_NAVIGATION_STANDARD.md)
> and
> [BOE_MODULE_LAYOUT_STANDARD.md](../BOE%20Master%20Context/BOE_MODULE_LAYOUT_STANDARD.md).
> For what is actually implemented today, read
> [../BOE Master Context/02_Current_System_State.md](../BOE%20Master%20Context/02_Current_System_State.md).
> The canonical entry point is
> [../BOE Master Context/00_README_FIRST.md](../BOE%20Master%20Context/00_README_FIRST.md).

# FILE 2 → `docs/UI_RULES.md`

# BOE Task Management System — UI Rules (historical)

# UI Source of Truth

The approved UI direction was defined by:

`BOE_Dashboard_Layout_Redesign.html` — **no longer present in this repository;
see the banner above for the current standards.**

All future UI work must follow this structure and visual language.

Do not invent a new UI style.

---

# Core UI Philosophy

The interface should feel:

* operational
* fast
* lightweight
* compact
* serious
* low-friction
* mobile-first

This is NOT a generic SaaS dashboard.

This is an operational accountability system.

---

# Approved Design Direction

## Theme

* Dark operational UI
* Neutral-heavy palette
* Minimal bright colors
* Color used only for meaning
* No gradient-heavy modern SaaS styling

---

# Layout Rules

## Unified Shell

The application shell is already finalized.

Includes:

* fixed sidebar
* top page header
* unified spacing rhythm
* responsive content area
* consistent panel behavior

Do not redesign the shell unless explicitly instructed.

---

# Sidebar Rules

Sidebar architecture is stabilized.

Rules:

* compact navigation
* operational grouping
* clear active states
* minimal clutter
* low visual noise
* consistent spacing
* small badges only when meaningful

No experimental sidebar redesigns.

---

# Dashboard Rules

Dashboard should prioritize:

* named operational lists
* accountability visibility
* urgency visibility
* task status clarity
* escalation awareness

Avoid:

* large empty spaces
* decorative analytics
* excessive charts
* vanity metrics
* marketing-style widgets

---

# Card System

Approved card types:

* KPI cards
* task cards
* escalation cards
* panel cards
* member cards
* activity timeline cards

All future cards should visually belong to this system.

---

# Interaction Philosophy

Every common action should aim for:

* one tap
* minimum typing
* low thinking effort
* fast update completion

Daily updates should never require long forms.

---

# Form Modal Dismissal

Any modal, dialog, drawer, or pop-up that holds a form or unsaved user input must protect that input from accidental loss.

A form modal may close ONLY through:

* the Cancel button
* the × close control (top-right)
* the Escape key
* a successful submission

Rules:

* Backdrop / overlay / outside clicks must do nothing — never wire the backdrop to close.
* Clicking inside the dialog must not bubble into a close handler.
* A pointer-down inside the dialog followed by pointer-up outside must not close it.
* Dropdowns, date pickers, comboboxes, and portals must keep working.
* A failed save keeps the modal open with all entered values intact.
* Submitting state must not allow accidental duplicate saves.
* Read-only detail pop-ups (no input) may keep click-away-to-close.

Shared modal components take an explicit `closeOnBackdropClick` prop that defaults to the legacy behaviour; every form-modal usage passes `false`. This is a permanent rule for all current and future BOE form modals. See `05_Business_Rules.md → Form Modal Dismissal Rule`.

---

# Typography Rules

Use compact operational typography.

Priorities:

1. readability
2. scan speed
3. hierarchy clarity
4. compact density

Avoid oversized headings or excessive whitespace.

---

# Mobile Rules

Mobile is a primary platform.

Requirements:

* responsive stacking
* thumb-friendly actions
* large tap targets
* reduced typing
* compact scrolling
* fast visibility

No desktop-only flows.

---

# Status System

Approved statuses:

* Pending
* Started
* Working
* Waiting
* Blocked
* Completed

These statuses are operational logic.

Do not invent new statuses casually.

---

# Waiting vs Blocked

These are NOT the same.

## Waiting

* external dependency
* escalation paused

## Blocked

* internal dependency
* escalation continues
* manager visibility required

UI should visually distinguish both clearly.

---

# Escalation Visibility

Escalations must feel operationally important.

Use:

* subtle red emphasis
* clear visibility
* compact urgency indicators

Avoid flashy warning systems.

---

# Notification Philosophy

The UI should reduce notification dependency.

The dashboard itself should communicate:

* pending updates
* escalation risks
* stale tasks
* accountability gaps

The app should not rely on constant push notifications.

---

# Manager View Philosophy

Manager screens should prioritize:

* who is silent
* who is blocked
* who is overloaded
* who is overdue
* where work is stuck

Manager view is not analytics software.

It is an operational monitoring layer.

---

# Task Detail Philosophy

Task detail screens should prioritize:

* ownership clarity
* status clarity
* fast updates
* permanent activity logs
* escalation visibility

Avoid clutter.

---

# Create Task Philosophy

Task creation must be:

* fast
* guided
* structured
* low-friction

Use:

* templates
* hints
* soft warnings
* smart defaults

Avoid:

* long forms
* excessive mandatory fields
* complex workflows

---

# Important Constraints

Do NOT add:

* decorative animations
* complex transitions
* bloated UI libraries
* enterprise ERP styling
* unnecessary charts
* dense tables everywhere

---

# Consistency Rule

Every new screen must visually feel like it belongs inside:

* Dashboard
* Manager View
* Members
* Task Detail
* Create Task

If a screen breaks visual consistency, redesign it before implementation.

---

# Development Rule

Before creating a new UI pattern:

1. Check if an existing pattern already solves it
2. Reuse existing spacing
3. Reuse existing card system
4. Reuse existing interaction logic

Consistency is more important than novelty.
