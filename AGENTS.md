<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Read the app-context system before any feature work

Before planning or changing anything, follow `docs/app-context/00_README_FIRST.md`:

0. **First, run `node "$HOME/BOE-Development/backups/tools/owner-reminders.mjs" --due`.** If it lists anything, tell the owner in plain words (one line each, with the first step) BEFORE any other work, and offer to do the parts you can. The owner does not remember these routines; you must. Record `done <id>` when they confirm a task. See `docs/app-context/05_OWNER_ROUTINE.md`.
1. Read `docs/app-context/02_MASTER_INSTRUCTION_SHEET.md` (the process) and `01_APP_CONTEXT.md` (the system map).
2. Read the dossier in `docs/app-context/modules/` for every module the request touches or neighbours, then **re-verify it against the code and migrations** — documents age, the code is the truth.
3. Present a plan and get agreement before writing code.
4. In the same pull request, update the dossier, `01_APP_CONTEXT.md`, `CHANGELOG.md`, regenerate `APP_INVENTORY.generated.md`, and the project memory.
5. After every merge run `node "$HOME/BOE-Development/backups/tools/backup-all.mjs"` and `verify-backups.mjs` (see `03_BACKUP_AND_RECOVERY.md`).
