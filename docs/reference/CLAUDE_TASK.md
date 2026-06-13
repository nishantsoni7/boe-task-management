# FILE 4 → `docs/CLAUDE_TASK.md`

# BOE Task Management System — Claude Working Instructions

# Primary Instruction

You are NOT building a generic task management SaaS.

You are building a lightweight operational accountability system for Best of Exports.

All implementation decisions should support:

* faster updates
* easier accountability
* lower employee friction
* operational visibility
* mobile-first usage

---

# Before Any Task

Always read:

1. `docs/PROJECT_CONTEXT.md`
2. `docs/UI_RULES.md`
3. `docs/CURRENT_STATE.md`
4. `BOE_Task_Management_Master_Context.txt`
5. `BOE_Phase_1_Process_Consultant_Review.html`
6. `BOE_Dashboard_Layout_Redesign.html`

Do not begin implementation without understanding these files.

---

# Current Development Phase

The project is currently in:

## Operational Refinement Phase

Do NOT:

* restart planning
* redesign architecture
* rebuild navigation
* replace layout systems
* rethink stack decisions

Architecture already exists.

Current work is refinement and operational polish.

---

# Existing Architecture Must Be Preserved

The following are already stabilized:

* Next.js architecture
* Supabase integration
* application shell
* sidebar system
* responsive layout
* dashboard direction

Do not modify these casually.

---

# UI Direction

UI source of truth:

`BOE_Dashboard_Layout_Redesign.html`

All UI work should align with:

* spacing
* hierarchy
* card structure
* sidebar behavior
* typography
* responsiveness
* interaction philosophy

Do not invent a separate visual language.

---

# Workflow Logic Source

Operational rules are defined in:

`BOE_Phase_1_Process_Consultant_Review.html`

This includes:

* acknowledgement logic
* escalation behavior
* stale task logic
* overdue handling
* delegation acceptance
* notification philosophy

Implementation should follow these rules.

---

# Implementation Style

Claude should work in:

* small steps
* reviewable tasks
* modular changes
* focused edits

Avoid:

* massive rewrites
* large uncontrolled refactors
* speculative improvements

---

# Required Workflow Before Editing

For every implementation task:

1. Inspect existing files
2. Understand current structure
3. Explain intended approach briefly
4. Make minimal required changes
5. Summarize:

   * files changed
   * what changed
   * why changed

---

# Important UX Principles

Every feature should prioritize:

* minimum typing
* one-tap actions
* fast scanning
* mobile usability
* operational clarity
* accountability visibility

If a workflow feels slow, simplify it.

---

# Important Product Principles

The system should make it:

* easier to give honest updates
* harder to avoid accountability

Avoid features that:

* create noise
* encourage fake activity
* increase friction
* add unnecessary complexity

---

# Phase 1 Constraints

Do NOT introduce:

* comments/chat systems
* file attachments
* subtasks
* recurring tasks
* analytics dashboards
* complex reporting
* multiple assignees
* advanced ERP behavior

These are intentionally deferred.

---

# Development Safety Rules

Ask before changing:

* database schema
* auth flow
* core routing
* sidebar structure
* shell architecture
* notification architecture

Do not make foundational decisions independently.

---

# Operational Mentality

This software is for:

* BOE sales teams
* BDM teams
* operations
* design
* purchase
* management

The users are operational employees, not technical power users.

Speed and clarity matter more than feature richness.

---

# Important Rule

Consistency is more important than creativity.

Preserve the system direction already established.
