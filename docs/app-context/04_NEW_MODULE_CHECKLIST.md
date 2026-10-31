# New Module / New Feature Checklist

Use together with `02_MASTER_INSTRUCTION_SHEET.md`. Copy this list into the PR description and tick every line (or write "n/a — because …").

## A. Before designing
- [ ] Recall + Recheck done (Sheet §1–2); neighbouring modules' dossiers read.
- [ ] Is this really a **new module**, or a feature of an existing one? Prefer extending an existing module whose users, data and permissions already match.
- [ ] Owner interview captured: who uses it (role, phone/desktop), the journey, what "done" looks like, what must be impossible. Business rules written as numbers/states, not adjectives.
- [ ] Platform standards read: global navigation, module layout, visual identity (BOE One).
- [ ] Overlap check: does an existing table, RPC, notification type, component or permission already do part of this? (grep `supabase/migrations`, `src/lib`, `src/components`).

## B. Registration points (a new module must be wired in all of these)
- [ ] **Routes:** `src/app/<module>/…` pages + `src/app/api/<module>/…` routes; each API route authenticates and checks module access server-side.
- [ ] **Launcher card:** `src/app/modules/page.tsx` (card definition with a stable `key`; personal ordering in `src/lib/modules/moduleOrder.ts` works on keys only).
- [ ] **Module visibility row:** `app_modules` (modes `live | admin_only | department_only | custom | hidden`); decide the default — usually `hidden`/`admin_only` until the owner opens it. Resolve with `resolveModuleAccess` (`src/lib/moduleAccess.ts`), never a new ad-hoc check.
- [ ] **Permission registry:** `src/lib/permissions/modules.ts` (modules + actions), then `npm run permissions:check`; apply via a **targeted migration**, not `permissions:sync` against production. Grants are per employee/position — no role inheritance.
- [ ] **Navigation:** sidebar / Control Center hub placement per the navigation standard; mobile layout verified at phone width.
- [ ] **Notifications:** new `notifications.type` values need a migration (Postgres enum) that is applied **before** the code that inserts them; add the module's own notification page if the pattern exists; respect the "silence" rules (no self-notify, system-activity filtering).
- [ ] **Control Center:** action-queue entries, announcements, data-management or test-data-cleanup coverage if the module creates test data.
- [ ] **View As:** reads show the viewed employee, writes remain the admin's; no writes while previewing.

## C. Data
- [ ] Migration files: unique 14-digit timestamps later than the latest; one concern each; idempotent where possible; self-assertions executed, not just written.
- [ ] RLS on every table; `SECURITY DEFINER` functions with fixed `search_path`, `auth.uid()` guard, `revoke … from public`, explicit grants; module-entry guard in RPCs (the Meetings RPC bypass is the cautionary tale).
- [ ] No policy OR-overlap that lets a submitter approve their own record (the finance payment RLS defect).
- [ ] Money as integer paise or the module's established whole-rupee rule; dates in IST helpers; counts above 1000 paged.
- [ ] Storage: bucket + policies in a migration; sizes/types validated; signed URLs; added to the backup (it is automatic — `backup-database.mjs` mirrors every bucket).
- [ ] Soft-delete vs hard-delete decided; permanent delete is admin-only and logged.
- [ ] Fixtures: any live-DB test uses the shared fixture helpers and cleans itself; no `@example.invalid` residue in production.

## D. Quality gates
- [ ] `npx tsc --noEmit`, `npm run lint` (0/0), `npm test` (0 failures; one suite at a time), `npm run permissions:check`, `npm run build`.
- [ ] Tests for: authorization (allowed / denied / wrong role), each state transition, the money/number rules, the migration (executed rehearsal), and the source-pinned invariants that guard a hard-won fix.
- [ ] Empty, loading, error and permission-denied states designed; phone width checked.
- [ ] Performance: first-load shell, no N+1 trips (DB is Tokyo, functions run in `hnd1`; each round trip costs); list state in the URL via `src/lib/listState.ts`.

## E. Release & recovery
- [ ] Rollout order written (migration → code …) and rollback written.
- [ ] Owner applied the migration and confirmed `supabase migration list --linked` shows it remote.
- [ ] Merged only with the owner's yes; Production deployment verified.
- [ ] GitHub "Backup on merge" run green after the merge (the local backup happens at 9:30 pm; no hand run).

## F. Knowledge
- [ ] New dossier `docs/app-context/modules/NN-<slug>.md` (template: any existing dossier — the 12 sections).
- [ ] `01_APP_CONTEXT.md` module table updated; `APP_INVENTORY.generated.md` regenerated; `CHANGELOG.md` entry added.
- [ ] Memory file(s) written/updated with PR, merge SHA, migration versions + apply state, traps, remaining owner steps; `MEMORY.md` index line updated.
