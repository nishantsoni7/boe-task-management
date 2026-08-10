# What and why

<!-- One paragraph. What changed, and what problem it solves. -->

## Type of change

- [ ] Bug fix (restores documented behaviour)
- [ ] Feature / new workflow
- [ ] **Business-rule change**
- [ ] **Permission change**
- [ ] **Database migration**
- [ ] Refactor / structural
- [ ] Documentation only

## Verification

```
npm run verify
```

- [ ] `docs:check` passed
- [ ] `typecheck` passed
- [ ] `lint` — no **new** problems (baseline: 4 errors + 1 warning in `src/components/objections/*`)
- [ ] `test` passed — count: ____ passed / ____ failed
- [ ] `build` passed
- [ ] Any failure that is pre-existing is proven so, and named below

## Documentation

See [`AGENTS.md`](../AGENTS.md) §3 for what counts as a major change, and
[`10_Documentation_Update_Matrix.md`](../docs/BOE%20Master%20Context/10_Documentation_Update_Matrix.md)
for what each type requires.

- [ ] Not a major change — no documentation update needed
- [ ] Records updated **in this PR**, with real `Last verified` dates:

<!-- list them -->

## Migration

- [ ] No migration
- [ ] Migration included. Then:
  - [ ] Filename is `YYYYMMDDHHMMSS_snake_case.sql`
  - [ ] Forward-only — **no deployed migration was edited, renamed or deleted**
  - [ ] Rollback or corrective-forward plan stated in the file header
  - [ ] RLS policies and grants reviewed for every new table
  - [ ] Destructive statements called out below for explicit review
  - [ ] **Will be applied to production BEFORE this merge** (PostgREST returns
        42703 for an unknown column, so merging first breaks the module)

## Safety

- [ ] No secrets, `.env` files, generated output or unrelated changes in the diff
- [ ] No production data modified
- [ ] Privacy, audit trails and ownership records preserved
- [ ] Any new server route refuses unauthorized callers — **name the file that
      does it**, not "RLS" alone if the route uses the service role
- [ ] Nothing in this PR is described as production unless it is merged and
      deployed

## Notes for the reviewer

<!-- Known limitations, follow-ups, anything deliberately left out. -->
