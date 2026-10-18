# START HERE — BOE One app-context system

This folder is the **living memory of the application**. It exists so that every new feature or module starts from what was really built, re-verifies it, and is planned before any code is written — and so the whole system can be rebuilt after a crash.

## Reading order (every session, every feature)

| # | File | Use it for |
|---|---|---|
| 1 | `02_MASTER_INSTRUCTION_SHEET.md` | The process: Recall → Recheck → Plan → Build → Verify → Document → Release → Backup |
| 2 | `01_APP_CONTEXT.md` | System map: stack, architecture, conventions, roles, every module's status |
| 3 | `modules/NN-*.md` | Per-module dossier — read the module(s) you touch **and** their neighbours |
| 4 | `APP_INVENTORY.generated.md` | Machine-read facts (routes, tables, functions, migrations, env names). Regenerate, never hand-edit |
| 5 | `04_NEW_MODULE_CHECKLIST.md` | Tick-list when adding a module or a cross-cutting feature |
| 6 | `03_BACKUP_AND_RECOVERY.md` | Backup layers, commands, and the restore runbooks |
| 7 | `CHANGELOG.md` | What changed, when, and the apply state of each migration |
| 8 | `05_OWNER_ROUTINE.md` | Recurring tasks the owner must do (drive copy, checks, renewals) — with the reminder script that remembers them |

Older, deeper material stays valid but is secondary: `docs/BOE Master Context/*` (platform standards — navigation and layout standards are **mandatory**), `docs/Module Docs/*`, `docs/runbooks/*`, `docs/releases/*`, `docs/testing/*`, `docs/security/*`, `docs/BOE_VISUAL_IDENTITY.md`. Where an older document disagrees with `01_APP_CONTEXT.md` or the code, the code wins, then this folder.

## The three rules that keep this system honest

1. **The code is the truth; documents are claims about the code.** Verify before relying (Sheet §2).
2. **Docs ship with code.** A pull request that changes behavior, schema or process updates its dossier, the module table, the inventory, the changelog and the memory in the same PR (Sheet §7).
3. **Nothing is done until it is backed up.** After every merge: `backup-all.mjs`, then `verify-backups.mjs` (Sheet §8–9).

## Where the other kinds of memory live

- **Project memory** (decisions, traps, owner preferences, PR/merge facts): `~/.claude/projects/C--Users-Lenovo-BOE-Development-repositories-boe-task-management/memory/` — index `MEMORY.md`. Copies are taken by every full backup.
- **Global rules** (workspace location, worktrees, no Desktop output): `~/.claude/CLAUDE.md`.
- **Project rules loaded by the AI at session start:** `CLAUDE.md` → `AGENTS.md` (Next.js is not the one you know) → they point here.
