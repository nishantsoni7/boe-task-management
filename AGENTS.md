<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

---

# BOE contributor contract

**This is the canonical instruction file.** `CLAUDE.md` includes it. Do not copy
these rules into another file — link to this one, so they cannot contradict each
other.

Applies to every contributor, human or AI.

---

## 0. This is production

BOE Task Management is deployed and in daily use. It holds real salaries, real
attendance, real employee data and real audit history.

Never: modify production data · apply a migration to production without explicit
instruction · treat hidden navigation as authorization · weaken a test to make a
suite pass · describe branch-only work as live.

---

## 1. Before editing

1. Read [`docs/BOE Master Context/00_README_FIRST.md`](docs/BOE%20Master%20Context/00_README_FIRST.md).
   It is the only entry point.
2. Read the module document for the area you are touching —
   [`docs/Module Docs/README.md`](docs/Module%20Docs/README.md).
3. **Inspect the current code before trusting any planning document.** Several
   master records were written in June 2026 and describe modules that have since
   shipped. The source-of-truth hierarchy is in `00_README_FIRST.md`:
   **code and tests outrank documentation for what the system does.**
4. For what the system *should* do, an explicit business rule outranks code. Code
   that contradicts a stated rule is a **finding** — record it in the mismatch
   register in `07_Business_Rule_Index.md`. Never resolve it by changing a
   calculation.

## 2. Identify the blast radius

Before writing code, name: affected **modules**, **files**, **business rules**
(by ID), **permissions**, **tables**, and **tests**.

## 3. What counts as a major change

New module · new workflow · **business-rule change** · **permission change** ·
**database migration** · new API family · route restructuring · a shared
component used by several modules · **calculation change** · **audit behaviour
change** · authentication change · major UI or navigation consolidation ·
deployment or environment change.

**Not major:** copy fixes, styling, a bug fix restoring documented behaviour,
adding a test, comments. These need **no** documentation update. Do not
manufacture edits to satisfy a process.

## 4. After a major change — the documentation contract

Do all of this **in the same commit as the code**:

1. Update every record named in
   [`10_Documentation_Update_Matrix.md`](docs/BOE%20Master%20Context/10_Documentation_Update_Matrix.md)
   for your change type.
2. Set the **Last verified** date on each record you touched to the real date.
3. Record rule changes in
   [`07_Business_Rule_Index.md`](docs/BOE%20Master%20Context/07_Business_Rule_Index.md),
   with the implementation file and the test.
4. Record architecture decisions as an ADR in [`docs/adr/`](docs/adr/README.md),
   and add the index row.
5. Record milestones in
   [`03_Development_History.md`](docs/BOE%20Master%20Context/03_Development_History.md).
6. Update [`02_Current_System_State.md`](docs/BOE%20Master%20Context/02_Current_System_State.md)
   when implementation status changes.
7. Update [`04_Current_Roadmap.md`](docs/BOE%20Master%20Context/04_Current_Roadmap.md)
   when work starts or finishes.
8. Add newly discovered debt to
   [`09_Risk_Register.md`](docs/BOE%20Master%20Context/09_Risk_Register.md), with
   evidence.
9. Record **how the change was verified** — the command run, the tests added,
   and any manual pass — in the module document or the record you touched. A
   change with no verification record is not finished.
10. Describe **completed work as completed and pending work as pending**. Never
    state production behaviour that has not been verified against production
    (see §5).

## 5. Statements you must never make loosely

- **Never call branch-only work production.** Say "branch-only" until it is
  merged and deployed.
- **Never call a migration deployed without evidence** — a non-empty `remote`
  value in `supabase migration list`. Written ≠ applied.
- **Never treat hidden UI as authorization.** See
  [ADR-0006](docs/adr/0006-server-authorization-independent-of-navigation.md).
  Name the server-side file that refuses the request.
- **Never weaken privacy, audit trails or ownership records** to simplify a
  change.

## 6. Verify before committing

```bash
npm run verify
```

Runs, in order: `check:secrets`, `docs:check`, `typecheck`, `lint:baseline`,
`test` and `build`. Individual steps: `npm run check:secrets` ·
`npm run docs:check` · `npm run typecheck` · `npm run lint:baseline` ·
`npm test` · `npm run build`.

Plain `npm run lint` runs ESLint without the baseline ratchet and is **not** what
`verify` calls. CI (`.github/workflows/verify.yml`) runs the same checks as
separate steps, with two differences: `lint` is `continue-on-error` because of
known pre-existing errors, and the production build is a **separate job gated on
`vars.CI_BUILD_ENABLED`**, so the build may be skipped in CI while passing
locally.

Then **read the final diff** for: secrets, `.env` files, generated output,
unrelated changes, accidental permission changes, calculation changes, schema
changes, broken links.

Do not claim a check passed if it was skipped. If a check fails for a
pre-existing reason, prove it fails on the baseline too, and report it separately.

## 7. Report what you changed

Every response that ends a change lists the **documents updated** alongside the
code. If none were needed, say why (see §3).

---

## Working style

- Simple first · fast first · usable first.
- Small improvements before large redesigns.
- Minimum affected files. No unrelated cleanup in a feature commit.
- Preserve current architecture, UI patterns and business rules unless the change
  is specifically justified, isolated, tested and documented.
- No enterprise pattern without an observed repository problem it solves.

## Migrations

Forward-only ([ADR-0003](docs/adr/0003-forward-only-migrations.md)). Never
rename, edit, reorder, combine or delete a deployed migration. New files use
`YYYYMMDDHHMMSS_snake_case.sql`. State the rollback or corrective-forward plan in
the file header. Apply migrations **before** the merge that deploys their code —
PostgREST returns 42703 for an unknown column.

## Git

Work on a feature branch, never `main`. Never `git reset --hard`, force-push,
rewrite history, or delete a branch. Never `git add .` — stage explicitly. Do not
merge or deploy unless asked.
