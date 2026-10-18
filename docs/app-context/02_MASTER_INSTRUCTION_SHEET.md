# BOE One — Master Instruction Sheet

**Audience:** any engineer or AI session about to add, change, or fix anything in BOE One (repository `boe-task-management`).
**Authority:** this sheet is the process. `01_APP_CONTEXT.md` + `modules/*.md` are the facts. If they disagree with the code, **the code wins** — then fix the document in the same change.
**Rule zero:** do not write code until Phase 1 (Recall) and Phase 2 (Recheck) are complete and Phase 3 (Plan) has been agreed.

---

## 0. Non-negotiable standing rules

1. **Minimal scope.** Change only what the request needs. No drive-by refactors, no renames, no unrelated formatting. Root cause first, smallest diff that fixes it.
2. **`main` is production.** Merging to `main` deploys to Vercel and the live database is shared with it. Never merge, apply a migration to production, push, or delete anything shared without the owner's explicit yes *for that action*. Approval for one action does not carry to the next.
3. **Prove a migration can apply BEFORE merging** (see §7). A merge that ships code needing an unapplied migration breaks production (this has happened once, PR #119).
4. **Applied migrations are immutable.** Never edit an applied migration file. Correct forward with a new, later-timestamped migration. Several migrations are byte-pinned by SHA-256 in tests.
5. **Clean `main` = 0 test failures, 0 lint warnings.** There is no "pre-existing failure" baseline. If a test fails, either your change caused it or you fix the cause; never excuse it.
6. **Never `git add .` / `git add -A`.** Stage named files. Audit every uncommitted file before committing; never infer ownership from `git status`.
7. **Worktrees, not copies.** Work in `%USERPROFILE%\BOE-Development\worktrees\boe-task-management\<short-task-name>`. Never create anything on either Windows Desktop. Temporary files go to `%USERPROFILE%\BOE-Development\temporary\` or the session scratchpad. Remove a worktree (`git worktree remove`) only after its PR merged and it is clean; delete the `node_modules` junction first.
8. **No secrets in git, chat, memory, logs or docs.** Env var *names* are fine; values never. The repository is **public**.
9. **Never run two test suites at once** (live-DB suites share fixtures). Never run live-DB suites against production `.env.local` except where the UAT guard allows.
10. **Next.js here is not the Next.js you know** (v16.2.6, React 19.2). Read the relevant guide in `node_modules/next/dist/docs/` before writing framework code; heed deprecations.
11. **Grants, not role inheritance.** Access is granted per employee/position; do not infer permission from the Admin/Manager/Employee label. See `modules/09-*`.
12. **No browser testing unless asked**; the owner tests before commit. Report honestly: failing tests, skipped steps and unverified claims are stated, not smoothed over.

---

## 1. Phase 1 — Recall (before reading code)

Do these in order, every time, even for "small" requests:

1. Read `docs/app-context/01_APP_CONTEXT.md` (system map, conventions, module status table).
2. Open the dossier(s) in `docs/app-context/modules/` for **every module the request names or touches** — and for every module it *could* touch through shared tables, RPCs, notifications, permissions or navigation. Read the dossier's "Traps" and "Recheck before changing" sections in full.
3. Read the project memory index (`MEMORY.md`) and open each entry relevant to those modules.
4. Read the mandatory platform standards: `docs/BOE Master Context/BOE_GLOBAL_NAVIGATION_STANDARD.md`, `BOE_MODULE_LAYOUT_STANDARD.md`, `docs/BOE_VISUAL_IDENTITY.md`.
5. Run the freshness check so the facts are current:
   ```bash
   git fetch origin && git status -sb && git log --oneline origin/main -10
   node scripts/generate-app-inventory.mjs --check     # fails if APP_INVENTORY.generated.md is stale
   ```
6. Run the backup health check (§9). **If a layer is stale, refresh it before starting.**

## 2. Phase 2 — Recheck (verify the documents against reality)

Documents and memories age. Before planning, re-verify, for the area you will touch:

- `git log --oneline -20 -- <paths>` and `git log -5 --format=%h\ %s origin/main` — has anyone changed it since the dossier was written?
- **Migrations:** `ls supabase/migrations | tail`, and `grep -ril "<table or function>" supabase/migrations` — the *latest* definition of each function/policy/trigger wins; read it, not the first one.
- **Apply state (never assume):** `supabase migration list --linked` must show a non-empty `remote` column for a version before you call it applied. (`db push` is denied by the permission classifier — the owner applies; see §7.)
- **Callers:** `grep -rn "<symbol>" src` across pages, API routes, components, lib and tests — including tests that pin source text.
- **Permissions:** the module-access key and the RLS policies for each table you will read or write.
- **Notifications:** does the change need a new `notifications.type`? That column is a Postgres enum — the migration must land *before* the code that inserts it.
- **Open PRs / other sessions:** `gh pr list --state open`, `git worktree list`, and the session list — a parallel session may hold the same branch name or the same files.
- Record every place a document disagreed with the code; you will fix the document in Phase 7.

## 3. Phase 3 — Plan (write it down, get agreement)

Produce a plan containing **all** of:

1. **Goal in one sentence** and who uses it (role, device — most staff use phones).
2. **Journey first:** the user's steps, the screens, the empty / loading / error states. For non-trivial UI, two or three concept options with trade-offs and a recommendation.
3. **Impact map (from Phase 2):** modules, tables, RPCs, routes, components, permissions, notifications, caches, tests that this touches. Anything not on this map is out of scope.
4. **Data design:** new/changed tables, columns, constraints (including money in integer paise / whole-rupee rules where relevant), RLS, RPCs (`SECURITY DEFINER` + fixed `search_path`; see `docs/security/`), indexes. New migration filenames with unique 14-digit timestamps later than the latest one.
5. **Permission design:** which module-access key, who gets it by default (answer is usually "nobody until granted"), and how it is enforced server-side *and* in the database.
6. **Rollout order:** the exact sequence (migration → code → …) and the rollback for each step.
7. **Test plan:** the tests to add, the existing tests that pin related behavior, how each failure mode is proven (§6).
8. **Risks & open questions** for the owner. Ask them *before* building when the answer changes the design (a dispatch gate threshold, who approves, what is visible to whom). Do not guess business rules — they are decisions recorded in the dossiers.
9. **Checkpoints:** numbered, read-only checkpoints with the expected result stated *first*.

Stop and present the plan. Build only after the owner agrees.

## 4. Phase 4 — Branch & build

```powershell
git fetch origin
git worktree add -b <type>/<short-name> "$env:USERPROFILE\BOE-Development\worktrees\boe-task-management\<short-name>" origin/main
```

- Branch types: `feat/`, `fix/`, `perf/`, `chore/`, `docs/`. Before pushing, check no parallel session or remote already uses the name (`git ls-remote --heads origin <name>`).
- A fresh worktree needs dependencies: link/copy `node_modules` per the worktree-junction note, or `npm ci`. Remember the junction trap on removal.
- Follow the visual identity and layout standards; reuse existing components (`src/components/ui`, shared payment-form frame, `src/lib/listState.ts` for URL list state) before creating new ones.
- Every server write goes through an API route or RPC that checks module access; never trust the client. Service-role clients stay server-side.
- `users` has private columns — `select('*')` on it fails with 42501. `PostgREST` caps at 1000 rows — use `fetchAllRows`/`supabasePaging`.
- Write money, dates and counts the way the module already does (IST dates via `src/lib/istDate.ts`; currency via `src/lib/currency.ts`).
- Commit in small, reviewable steps with a message that says *why*. Commit messages end with the standard attribution lines for the tool in use.

## 5. Phase 5 — Database changes

- One concern per migration; `begin`/`commit`-safe; self-asserting `do $$ … $$` blocks are allowed but **must be executed** (a text-only test can pass while the real apply aborts).
- Guard every `SECURITY DEFINER` function: `set search_path = public, pg_temp`, explicit `auth.uid()` checks, `revoke … from public`, explicit `grant execute`.
- Do not leave test fixtures in production: live-DB tests create `@example.invalid` users — use the cleanup helpers, never ad-hoc inserts.
- Destructive SQL (drop/truncate/delete) is blocked by the permission classifier from the shell; write it via the Write tool to a file, and the owner decides.

## 6. Phase 6 — Verify (all of it, from a clean state)

```bash
npx tsc --noEmit
npm run lint            # baseline is 0 errors / 0 warnings
npm test                # tsx --test; baseline is 0 failures. Run ONE suite at a time.
npm run permissions:check   # fails on drift between code and DB permission seed
npm run build           # next build (CI-equivalent; ES2017 regex-flag issues show only here)
node scripts/generate-app-inventory.mjs     # refresh APP_INVENTORY.generated.md
```

- A passing source-text test is not proof of behavior; exercise the real path (route test, executed migration rehearsal, signed-in check) and state exactly what was and was not verified.
- A route move can silently break a query-string contract that a string test still passes — re-read callers after moving anything.
- For migrations use the rollback-rehearsal recipe (`BEGIN … ROLLBACK` against the linked DB via `supabase db query --file`, Windows path + `MSYS_NO_PATHCONV=1`), then confirm zero residue.

## 7. Phase 7 — Document (part of "done")

A change is not done until the knowledge is updated **in the same pull request**:

1. The affected `docs/app-context/modules/NN-*.md` dossier: status, routes, tables/RPCs, rules, decisions, traps, tests, open items.
2. `docs/app-context/01_APP_CONTEXT.md` module table row (status + last-changed PR).
3. Regenerate `APP_INVENTORY.generated.md` (`node scripts/generate-app-inventory.mjs`).
4. Append to `docs/app-context/CHANGELOG.md` (date, PR, what, migration versions, apply state, rollback).
5. If a platform-wide convention changed, update `docs/BOE Master Context/*` and this sheet.
6. Update the project memory index (`MEMORY.md`) and the module's memory file with: PR number + merge SHA, migration versions + **apply state**, new traps, remaining owner steps.

## 8. Phase 8 — Release ritual (every merge)

Follow in order; stop at any failure:

1. Open the PR (squash/rebase only; main requires the Vercel check, 0 approvals). Bind it to the session and read CI; fix red CI before anything else.
2. **Migrations first:** if the PR has a migration, prove it can apply (§6), then ask the owner to apply it (`supabase db push --dry-run` first; only the intended file may be pending). Confirm with `supabase migration list --linked` that `remote` is populated.
3. Ask the owner for the go-ahead to merge. Merge = production deploy.
4. After merge: confirm the Production deployment succeeded (GitHub deployments API, or the bundle grep recipe in memory `reference_production_deploy_verification`).
5. **Backup immediately:**
   ```bash
   node "$HOME/BOE-Development/backups/tools/backup-all.mjs"      # code + database + storage + memory + env
   node "$HOME/BOE-Development/backups/tools/verify-backups.mjs"  # must end "All required layers are fresh."
   ```
   The GitHub Action "Backup on merge" produces the off-machine bundle automatically; check it is green on the merge commit.
6. Update `main` in the primary checkout, remove the finished worktree (clean it first; delete the `node_modules` junction before `git worktree remove`).
7. Update memory + `CHANGELOG.md` with the merge SHA and the backup timestamp.

## 9. Backup duties (details in `03_BACKUP_AND_RECOVERY.md`)

| When | What |
|---|---|
| Every commit / merge / rebase / push (automatic) | git hooks refresh the local mirror (`post-commit`, `post-merge`, `post-rewrite`, `pre-push`) |
| Every merge to `main` (automatic) | GitHub Action stores a verified bundle (90 days) and optionally mirrors to a private repo |
| After every merge, and before any risky operation (manual) | `backup-all.mjs` then `verify-backups.mjs` |
| Daily (scheduled, once installed) | `backup-all.mjs` |
| Before any migration is applied to production | `backup-all.mjs` — the database export is your rollback data |
| Start of every session | `verify-backups.mjs` — refresh anything stale |

A session that merged something and did not run the backup has not finished the task.

## 10. Reporting back to the owner

- Lead with what is now true and what is not yet done or verified.
- Name every irreversible step still waiting on them (apply migration, merge, deploy, disable flag).
- Link PRs, files and commits; never a bare `#123`.
- Keep decisions you took on their behalf to defaults you state; list any you want confirmed.

## 11. Quick decision table

| Situation | Do |
|---|---|
| Request mentions a module | Read its dossier + memory + code, then plan |
| Request spans two modules | Read both dossiers and the shared tables' latest migrations |
| New module | Use `04_NEW_MODULE_CHECKLIST.md`; register in launcher, permissions, notifications, docs, tests, backup coverage |
| Production data looks wrong | Back up first (§9), then diagnose read-only; propose a fix; never repair in place without approval |
| A document disagrees with the code | Trust the code; fix the document in the same PR |
| Tests fail on a clean branch | Stop; it is a real defect or a drifted fixture — fix or report, never baseline it |
| About to run something destructive or shared | Ask first, with the exact command and its blast radius |
