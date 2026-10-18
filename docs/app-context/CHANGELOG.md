# App Context Changelog

Newest first. One entry per merged change that alters behavior, schema, process or backups. Keep entries short; the detail lives in the module dossier and the PR.

Format: `YYYY-MM-DD · PR · what · migrations (version → apply state) · backup taken (UTC stamp)`

## 2026-10-18 — App-context system and backup system introduced
- Added `docs/app-context/` (this folder): `00_README_FIRST.md`, `01_APP_CONTEXT.md`, `02_MASTER_INSTRUCTION_SHEET.md`, `03_BACKUP_AND_RECOVERY.md`, `04_NEW_MODULE_CHECKLIST.md`, `modules/*.md` dossiers, and the generated `APP_INVENTORY.generated.md` (`scripts/generate-app-inventory.mjs`).
- Added backup tooling `scripts/backup/*` (code mirror + bundle, uncommitted-work snapshot, memory copy, encrypted env copy, database + storage export, freshness verifier), versioned git hooks `.githooks/*`, and the GitHub Action `.github/workflows/backup-on-merge.yml`.
- Migrations: none. Production data: read-only export only.
- Found while building it: the legacy Supabase API keys in the local `.env.local` were disabled on 2026-08-16, so the database export needs the current `sb_secret_…` key in `BOE-Development/backups/.env.backup` (see `03_BACKUP_AND_RECOVERY.md` §6).
- Baseline: main at `852e0493` (#326), 330 migrations (latest `20270318000000_custody_handed_by_outside_name.sql`).
