# Documentation Update Matrix

Last verified: **2026-08-11**

Which records must be updated for each kind of change. Paths are this
repository's actual filenames.

The rule itself — update documentation **in the same commit as the code** — is in
[../../AGENTS.md](../../AGENTS.md).

---

## Is this a major change?

Use the matrix if the change is any of:

new module · new workflow · **business-rule change** · **permission change** ·
**database migration** · new API family · route restructuring · a shared
component used by several modules · **calculation change** · **audit behaviour
change** · authentication change · major UI or navigation consolidation ·
deployment or environment change.

**Not** a major change: copy fixes, styling, a bug fix that restores documented
behaviour, adding a test, a comment. These need no documentation update — forcing
one produces meaningless edits.

---

## The matrix

| Change type | Required records |
| --- | --- |
| **New module** | `02_Current_System_State.md` · `06_Module_Architecture.md` · `04_Current_Roadmap.md` · new `docs/Module Docs/<MODULE>.md` from `_MODULE_TEMPLATE.md` · row in `docs/Module Docs/README.md` · `03_Development_History.md` |
| **Business-rule change** | `07_Business_Rule_Index.md` (row + Last verified) · `05_Business_Rules.md` if narrative · module document · the test that proves it · `03_Development_History.md` |
| **New table or migration** | `06_Module_Architecture.md` (data ownership) · module document (Tables) · `02_Current_System_State.md` if it changes status · migration file header comment stating rollback/corrective-forward plan |
| **Permission change** | `08_Authorization_Matrix.md` · module document (Permissions) · the test that proves it · `03_Development_History.md` · ADR if the *model* changed |
| **Route or API change** | `06_Module_Architecture.md` · module document (Routes/APIs) · contract or access test |
| **Major UI or navigation change** | Module document · `02_Current_System_State.md` if user-visible status changes · `BOE_GLOBAL_NAVIGATION_STANDARD.md` if the standard itself moves |
| **Calculation change** | `07_Business_Rule_Index.md` · module document · engine tests · `03_Development_History.md` · **ADR** (calculations are hard to reverse once a month is generated) |
| **Audit behaviour change** | Module document (Audit history) · `07_Business_Rule_Index.md` · `03_Development_History.md` |
| **Architecture decision** | New ADR in `docs/adr/` · row in `docs/adr/README.md` · `06_Module_Architecture.md` if structure moves · `03_Development_History.md` |
| **Deployment or environment change** | `02_Current_System_State.md` (Deployment model) · `.github/workflows/verify.yml` if CI is affected · `03_Development_History.md` |
| **Structural debt discovered** | `09_Risk_Register.md` (new row with evidence) |
| **Rule/code conflict discovered** | Mismatch register in `07_Business_Rule_Index.md`. **Do not resolve by changing a calculation.** |
| **Work started or finished** | `04_Current_Roadmap.md` status |

---

## Every update also requires

1. The **Last verified** date on each record you touched, set to the real date.
2. Status language that distinguishes **deployed** from **branch-only**. Never
   call unmerged work production.
3. Migration status stated only with evidence — a non-empty `remote` value in
   `supabase migration list`. "Written" is not "applied".
4. `npm run verify` passing before the commit.

---

## What the validator enforces

`npm run docs:check` fails on: a missing required document · a broken local link
in `docs/`, `README.md` or `AGENTS.md` · a `Full` module document missing a
required section · a duplicate ADR number · an ADR missing from its index, or an
index row pointing at a missing file · a module index row pointing at a missing
document.

It **cannot** check whether a sentence is true. That is the author's job, and
`AGENTS.md` says so explicitly.
