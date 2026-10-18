# Owner Routine — what the owner must do regularly

The owner is **not expected to remember any of this**. Three things remember for them:

1. **`owner-reminders.mjs`** keeps the list, the schedule and the "last done" dates (state is stored outside git, in `BOE-Development/backups/boe-task-management/status/owner-reminders.json`).
2. **A Windows pop-up** appears from the daily 9:30 pm backup task whenever something is due (at most once a day, it closes itself after 15 minutes so it never blocks the backup).
3. **Every Claude session** must run the reminder check at its start and tell the owner, in plain words, what is due — before any other work (see `AGENTS.md`). The owner can also say **"show my BOE reminders"** at any time.

## The routines

| What | How often | Measured how | What the owner does |
|---|---|---|---|
| Plug in the external drive and copy the backup | every 7 days | automatic (date of last copy to the drive) | Plug in the hard disk (D:), say "run the backup" |
| Daily 9:30 pm backup is healthy | every 2 days | automatic (last successful run) | Leave the laptop on at 9:30 pm; if it keeps failing, say "check the backup task" |
| Supabase still takes daily backups | monthly | owner says "done supabase-backups" | Supabase > Database > Backups > confirm a backup from the last 2 days |
| Password manager still holds every key | every 6 months | "done password-manager" | Check passphrase, Supabase secret key, CRON_SECRET, FAL_KEY, ANTHROPIC_API_KEY, Minop token, GitHub + Vercel recovery codes |
| GitHub security and access review | every 3 months | "done github-security" | Security tab alerts, the two main rules are Active, collaborators |
| Restore rehearsal | every 3 months | "done restore-rehearsal" | Start Docker Desktop, ask Claude "do the restore rehearsal" (free, local, ~3 min) |
| Tidy old branches and worktrees | monthly | "done housekeeping" | Ask Claude to prune merged branches and worktrees |
| Rotate the Supabase backup secret key | yearly | "done supabase-key-rotation" | Create a new key, update `backups/.env.backup`, delete the old key |
| Renew the GitHub mirror token | **by 2027-09-17** (token expires 2027-10-17) | fixed date | Regenerate the `boe-mirror` token, update the `BACKUP_MIRROR_TOKEN` secret |

After every **merge** the backup ritual applies too (Master Instruction Sheet §8) — Claude runs it; the owner only needs the drive plugged in when asked.

## Commands (Claude runs these; the owner never has to)

```bash
node "$HOME/BOE-Development/backups/tools/owner-reminders.mjs"            # everything with status
node "$HOME/BOE-Development/backups/tools/owner-reminders.mjs" --due      # only what needs action (exit 1 if any)
node "$HOME/BOE-Development/backups/tools/owner-reminders.mjs" done <id>  # record that the owner did it today
node "$HOME/BOE-Development/backups/tools/owner-reminders.mjs" snooze <id> 3
```

Ids: `external-drive`, `daily-backup-health`, `supabase-backups`, `password-manager`, `github-security`, `restore-rehearsal`, `housekeeping`, `supabase-key-rotation`, `mirror-token`.

## Rules for Claude sessions

- At session start: run `--due`. If anything is listed, say so first, in plain words, one line each with the first step, and offer to do the parts Claude can do (backup, restore rehearsal, housekeeping).
- When the owner says they did a manual task, run `done <id>` immediately.
- Never mark a task done on the owner's behalf without being told they did it.
- To add a routine: add one entry to `TASKS` in `scripts/backup/owner-reminders.mjs`, a row to the table above, rerun `install-backup-system.mjs`, and mention it in the changelog.
