# App Context Changelog

Newest first. One entry per merged change that alters behavior, schema, process or backups. Keep entries short; the detail lives in the module dossier and the PR.

Format: `YYYY-MM-DD · PR · what · migrations (version → apply state) · backup taken (UTC stamp)`

## 2026-10-18 — DOM tests for the payment forms
- Added `jsdom` (dev dependency) and `src/lib/testing/domHarness.ts`. The payment forms (Add payment on a PI, Allocate Funds, Edit Received Payment, FormDialog and its parts) are now tested by running them in a DOM; the source-text checks they replace are removed. No product code changed. Migrations: none.

## 2026-10-18 — Big Finance screens split; test-run mechanism for split screens
- `finance/received/ReceivedPaymentsView.tsx` 3,850 → 1,468 lines and `finance/page.tsx` 3,796 → 946 lines: blocks moved into sibling files, each leaving a `// @split:` marker. No behavior change; exports re-exported from the original files.
- Tests: `npm test` and `npm run test:file -- <path>` now preload `scripts/testing/screen-source-preload.mjs`, which puts split blocks back whenever a test file reads a screen as text. `scripts/dev/split-block.mjs` performs a split. Guard: `src/lib/testing/screenSplits.test.ts`. Bare `tsx --test` no longer sees the original layout.
- Also this week (PRs #327–#334): main back to 0 failing tests; required `verify` CI check; nightly live-database suite (`supabase/tests/live-db-seed.sql`, `live-db-schema-version.txt`).
- Migrations: none.

## 2026-10-18 (restore rehearsal)
- First restore rehearsal PASSED: 156 tables / 96,121 rows / 21 auth users from the newest export loaded into a throwaway local Postgres with all counts and numeric sums matching; negative test (tampered manifest) correctly failed. Not covered: the 5 service-role-unreadable tables; schema (not rebuildable from migrations alone - use Supabase platform backups for a real disaster).

## 2026-10-18 (final) — Owner reminder system
- `scripts/backup/owner-reminders.mjs` + `05_OWNER_ROUTINE.md`: nine recurring owner routines with schedules, automatic measurement where possible, a daily Windows pop-up from the 9:30 pm task, and a rule in `AGENTS.md` that every Claude session reports what is due before other work.

## 2026-10-18 (late night) — Private mirror repo live
- `nishantsoni7/boe-task-management-mirror` (private) receives every branch and tag on each push to main (PR #341). Lessons: `actions/checkout` must use `persist-credentials: false` or its own token hides the mirror; a personal token needs the **Workflows** permission to push branches that contain workflow files. Known flake: `backup-all` can report `code:false` if run at the same instant as a git hook's quick backup (mirror lock); re-run it.

## 2026-10-18 (night) — Meetings module-entry fix shipped
- PR #310 merged (`40270642`). Migration `20270319000000_meetings_rpcs_require_module_entry.sql` (renumbered from `20270315000000`, which main already used) applied to production via `db push` after a dry run showing only that file; verified with `migration list --linked`. Backup taken before applying and after merging. Rollback: re-emit the previous guard definitions from `20260814000000_create_meetings_module.sql` in a new forward migration.
- Housekeeping: 7 merged worktrees and 131 fully-merged local branches removed (all preserved in the backup mirror); main checkout moved back to `main`.

## 2026-10-18 (evening) — Backup decisions
- Supabase Pro daily backups confirmed (7 days). PITR declined by the owner (cost). Daily Task Scheduler backup installed (21:30). Passphrase stored in the owner's password manager. Second copy on `D:BOE-Backups`.

## 2026-10-18 (later) — Backups proven, migrations verified
- First successful database + storage export (161 relations, 96,108 rows, 21 auth users). Five relations are denied to the service role and are not covered (see `03_BACKUP_AND_RECOVERY.md`). Second copy to an external drive works. Git-hook bug (stray `refs/local/*` in the real repo) fixed in #337.
- Verified read-only: every migration on main is applied in production; only `20261214000000` (not on main) is absent.

## 2026-10-18 — App-context system and backup system introduced
- Added `docs/app-context/` (this folder): `00_README_FIRST.md`, `01_APP_CONTEXT.md`, `02_MASTER_INSTRUCTION_SHEET.md`, `03_BACKUP_AND_RECOVERY.md`, `04_NEW_MODULE_CHECKLIST.md`, `modules/*.md` dossiers, and the generated `APP_INVENTORY.generated.md` (`scripts/generate-app-inventory.mjs`).
- Added backup tooling `scripts/backup/*` (code mirror + bundle, uncommitted-work snapshot, memory copy, encrypted env copy, database + storage export, freshness verifier), versioned git hooks `.githooks/*`, and the GitHub Action `.github/workflows/backup-on-merge.yml`.
- Migrations: none. Production data: read-only export only.
- Found while building it: the legacy Supabase API keys in the local `.env.local` were disabled on 2026-08-16, so the database export needs the current `sb_secret_…` key in `BOE-Development/backups/.env.backup` (see `03_BACKUP_AND_RECOVERY.md` §6).
- Baseline: main at `852e0493` (#326), 330 migrations (latest `20270318000000_custody_handed_by_outside_name.sql`).
