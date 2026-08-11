# BOE MASTER CONTEXT — START HERE

**This is the canonical entry point for the BOE Task Management repository.**
Every contributor and every AI assistant reads this file first. There is no
second start page; anything else claiming to be one is historical.

Last verified: 2026-08-11

---

## ⚠️ Production safety

**This repository is deployed and in daily use by Best of Exports staff.** It
holds real salaries, real attendance records, real employee data and real audit
history.

Before any change:

- Do **not** modify production data.
- Do **not** apply migrations to production without explicit instruction.
- Do **not** treat hidden navigation as authorization.
- Do **not** weaken a test to make a suite pass.
- Do **not** describe branch-only work as live.

---

## What this system is

An internal operating system for Best of Exports (Jodhpur, India — hospitality
furniture manufacture and export). It began as task management and is expanding
into attendance, payroll, performance, samples, assets, meetings and employee
records.

Architecture: a **modular monolith** — one Next.js App Router application on
Supabase (Postgres + Auth + RLS), deployed on Vercel. See
[ADR-0002](../adr/0002-modular-monolith.md).

---

## Required reading order

1. **This file**
2. [01_Project_Master_Context.md](01_Project_Master_Context.md) — company, vision, philosophy
3. [02_Current_System_State.md](02_Current_System_State.md) — what actually exists today
4. [06_Module_Architecture.md](06_Module_Architecture.md) — structure and ownership
5. [05_Business_Rules.md](05_Business_Rules.md) — narrative business rules
6. [07_Business_Rule_Index.md](07_Business_Rule_Index.md) — the enforceable rule index
7. [08_Authorization_Matrix.md](08_Authorization_Matrix.md) — who may do what, and where it is enforced
8. [BOE_GLOBAL_NAVIGATION_STANDARD.md](BOE_GLOBAL_NAVIGATION_STANDARD.md) — mandatory
9. [BOE_MODULE_LAYOUT_STANDARD.md](BOE_MODULE_LAYOUT_STANDARD.md) — mandatory
10. [09_Risk_Register.md](09_Risk_Register.md) — known debt, before proposing new work
11. [04_Current_Roadmap.md](04_Current_Roadmap.md) — what is planned
12. [03_Development_History.md](03_Development_History.md) — how it got here

Then, for the area you are touching: the module document in
[../Module Docs/](../Module%20Docs/README.md).

---

## Source-of-truth hierarchy

When two sources disagree about **what the system does**, believe them in this
order:

| Rank | Source | Why |
| --- | --- | --- |
| 1 | Application code and its tests | It is what runs |
| 2 | Applied migration history and schema | It is what the database is |
| 3 | Current configuration (`package.json`, `next.config.ts`, workflows) | It is what executes |
| 4 | Module documentation (`docs/Module Docs/`) | Closest to the code |
| 5 | Master documentation (this folder) | Broader, updated less often |
| 6 | Reference and historical plans (`docs/Reference/`) | Original intent, often superseded |

**For what the system *should* do**, this order does not apply. An explicit
business rule outranks code. Code that contradicts a stated business rule is a
**finding**, not a new rule — record it in the mismatch register at the end of
[07_Business_Rule_Index.md](07_Business_Rule_Index.md) and raise it. Never
silently rewrite a rule to match the code, and never change a calculation to
match an old document.

---

## Which record holds what

| Record | Kind | Holds |
| --- | --- | --- |
| [01_Project_Master_Context.md](01_Project_Master_Context.md) | Vision | Company, long-term direction, philosophy |
| [02_Current_System_State.md](02_Current_System_State.md) | **Current state** | Module status, workflows, limitations |
| [03_Development_History.md](03_Development_History.md) | History | Milestones already delivered |
| [04_Current_Roadmap.md](04_Current_Roadmap.md) | Plans | Now / Next / Later / Deferred |
| [05_Business_Rules.md](05_Business_Rules.md) | Rules | Narrative business rules |
| [07_Business_Rule_Index.md](07_Business_Rule_Index.md) | **Rules** | Indexed, testable, traceable rules |
| [06_Module_Architecture.md](06_Module_Architecture.md) | Structure | Modules, boundaries, ownership |
| [08_Authorization_Matrix.md](08_Authorization_Matrix.md) | Security | Route/role/enforcement map |
| [09_Risk_Register.md](09_Risk_Register.md) | Debt | Known structural risks |
| [10_Documentation_Update_Matrix.md](10_Documentation_Update_Matrix.md) | Process | What to update for each change type |
| [../adr/README.md](../adr/README.md) | **Decisions** | Architecture decision records |
| [../Module Docs/README.md](../Module%20Docs/README.md) | Modules | Per-module documentation index |
| [../Reference/](../Reference/PROJECT_CONTEXT.md) | Historical | Original vision and planning; superseded in places |
| [../testing/](../testing/) | Testing | Manual test scripts and acceptance passes |

---

## How to find module documentation

Start at [../Module Docs/README.md](../Module%20Docs/README.md). It indexes every
module document and states each module's maturity. New module documents use
[../Module Docs/_MODULE_TEMPLATE.md](../Module%20Docs/_MODULE_TEMPLATE.md).

---

## How to verify a change

One command:

```bash
npm run verify
```

That runs, in order: a tracked-file credential scan, documentation checks, type
checking, the lint baseline ratchet, the full test suite and a production build.
Individual steps are `npm run check:secrets`, `npm run docs:check`,
`npm run typecheck`, `npm run lint:baseline`, `npm test`, `npm run build`.

Plain `npm run lint` is ESLint without the ratchet and is not what `verify`
calls. At `a0352e5` the suite is **3,239 tests in 668 suites, all passing**.

Full detail, including what CI runs and what it cannot: see
[../../AGENTS.md](../../AGENTS.md).

---

## How documentation must be updated

Documentation is updated **in the same commit as the code**, not afterwards. The
rules are in [../../AGENTS.md](../../AGENTS.md) (the contributor contract) and the
per-change-type table is in
[10_Documentation_Update_Matrix.md](10_Documentation_Update_Matrix.md).

`npm run docs:check` enforces the mechanical parts — files exist, links resolve,
module documents carry their required sections, ADR numbers are unique. It cannot
check whether a sentence is true. That remains the author's responsibility.

---

## When code and documentation disagree

1. Trust the code for **what happens** (hierarchy above).
2. Check whether the documentation states a **business rule**. If it does, the
   disagreement is a finding, not a documentation bug.
3. Record it in the mismatch register in
   [07_Business_Rule_Index.md](07_Business_Rule_Index.md).
4. Fix the documentation if it is merely stale.
5. Raise it for a decision if money, access, privacy or audit history is
   involved. Do not resolve it by changing a calculation.

A worked example of exactly this, and how it was handled, is in
[ADR-0005](../adr/0005-guide-content-derives-from-engine-constants.md).
