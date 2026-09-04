> ## ⚠️ SUPERSEDED — this is not the entry point
>
> This file is **historical**. It describes an early, Phase-1-only version of
> BOE Task Management (task management only — no Attendance, Payroll, BOE
> Credits, Assets & Access, Orders, Finance, Meetings or the other modules that
> have since shipped) and does not reflect the current shipped system.
>
> The canonical entry point is
> [../BOE Master Context/00_README_FIRST.md](../BOE%20Master%20Context/00_README_FIRST.md),
> which sets the reading order into the current project records. For what is
> actually implemented today, read
> [../BOE Master Context/02_Current_System_State.md](../BOE%20Master%20Context/02_Current_System_State.md)
> directly.
>
> Read this file only for the original product intent, not as a working
> instruction.

# BOE Operational Accountability System — Start Here (historical)

Before doing ANY implementation work, read these files carefully in the following order:

1. PROJECT_CONTEXT.md
2. UI_RULES.md
3. CURRENT_STATE.md
4. CLAUDE_TASK.md

Then review the foundational reference files:

5. MASTER_PRODUCT_VISION.md
6. BOE_Operational_Design_Principles.html
7. BOE_Operational_UI_System.html

Do not begin implementation before understanding these files.

---

# IMPORTANT PROJECT STATE

This project is NOT in architecture planning phase.

The following already exist and are considered stabilized:

* Next.js architecture
* Supabase integration
* application shell
* sidebar navigation system
* responsive layout structure
* dashboard direction
* operational UI hierarchy

Do NOT:

* restart from zero
* redesign the app entirely
* rebuild navigation
* replace layout systems
* introduce random UI patterns
* over-engineer workflows

---

# CURRENT PRODUCT DIRECTION

The product has evolved from:

* lightweight mobile-first task management

Into:

* desktop-first operational accountability workspace
* structured operational monitoring system
* management visibility platform
* escalation-aware workflow system

Desktop is the primary operational environment.

Responsive mobile support exists for:

* quick updates
* acknowledgements
* approvals
* fast operational actions

---

# CORE PRODUCT PHILOSOPHY

The system should feel:

* faster than WhatsApp
* easier than ClickUp
* simpler than ERP systems

while still maintaining:

* accountability visibility
* escalation awareness
* workflow clarity
* operational discipline

---

# UI SYSTEM RULE

The uploaded:
`BOE_Operational_UI_System.html`

is the visual source of truth.

All future UI work must align with:

* shell structure
* sidebar hierarchy
* operational card system
* dashboard density
* spacing rhythm
* manager monitoring philosophy
* escalation visibility
* interaction behavior

Do NOT invent a separate design language.

---

# OPERATIONAL WORKFLOW RULE

The uploaded:
`BOE_Operational_Design_Principles.html`

defines:

* escalation philosophy
* delegation logic
* stale task behavior
* accountability systems
* workflow psychology
* notification discipline
* operational failure prevention

Implementation should follow these principles carefully.

---

# IMPLEMENTATION STYLE

Work in:

* small steps
* modular changes
* reviewable tasks
* minimal safe edits

Avoid:

* broad rewrites
* speculative improvements
* unnecessary abstraction
* uncontrolled refactors

---

# BEFORE MODIFYING ANYTHING

Always:

1. inspect the existing implementation
2. understand current structure
3. preserve architecture consistency
4. preserve UI consistency
5. explain major changes briefly before editing

---

# IMPORTANT UX PHILOSOPHY

Every workflow should prioritize:

* low friction
* fast scanning
* minimum typing
* operational clarity
* accountability visibility
* manager visibility
* responsive usability

Avoid unnecessary complexity.

---

# IMPORTANT PRODUCT PRINCIPLE

The system should make it:

* easier to give honest updates
* harder to avoid accountability

Any feature that creates:

* fake activity
* operational noise
* excessive notifications
* clutter
* unnecessary friction

should be reconsidered.

---

# FINAL RULE

Consistency is more important than creativity.

Operational clarity is more important than feature quantity.

Preserve the established system direction.
