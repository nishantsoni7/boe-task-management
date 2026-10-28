# BOE One — Backup & Disaster Recovery

**Goal:** if the laptop, GitHub, Vercel or Supabase disappears at any moment, the app can be rebuilt to the **latest merged state** from what survives. Every layer below is independent; no single loss is fatal.

## 1. What is the app made of, and where does each part live?

| Part | Lives in | Is it reproducible? | Backed up by |
|---|---|---|---|
| Source code + all branches + PR heads | GitHub `nishantsoni7/boe-task-management` (**public**) and the laptop | yes (git) | local mirror, local bundle, GitHub Action bundle, optional private mirror repo |
| Database **schema, RLS, functions, triggers** | `supabase/migrations/*.sql` in git (330+ files) | yes — replay in order | code backup (it *is* the code) |
| Database **data** (≈150 tables) | Supabase Postgres, project ref `albnsrohngkljfsrrrhf` (Tokyo) | **no** — only by backup | `backup-database.mjs` (JSONL, encrypted) + Supabase's own backups |
| Auth users (email, metadata, ids) | Supabase Auth | no | `_auth_users` export. **Passwords cannot be exported**; users reset via "Forgot password" (shipped, #315) |
| Uploaded files (payment proofs, images, attachments) | Supabase Storage buckets | no | `storage/` mirror, incremental |
| Secrets / env values | `.env.local` (laptop) and Vercel project env | no | encrypted copy in `secrets/`; owner's password manager |
| Hosting config | `vercel.json` (regions `hnd1`, daily cron) in git; project settings in Vercel | mostly (see §6) | git + §6 checklist |
| Project memory (decisions, traps) | `~/.claude/projects/.../memory` | no | `memory/<timestamp>/` copies |
| Uncommitted work | worktrees on the laptop | no | `wip/<timestamp>/` copies — but **commit it** |

## 2. The backup layers

All local backups live in `%USERPROFILE%\BOE-Development\backups\boe-task-management\` (never the Desktop).

| Layer | Folder | Trigger | Content | Retention |
|---|---|---|---|---|
| L1 git mirror | `git/boe-task-management.git` | **every commit, merge, rewrite, push** (hooks) + every full backup | bare repo holding `refs/local/*` (all local branches, including unpushed work and stashes) and `refs/github/*` (heads, tags, **every PR head**). Never pruned; `gc` disabled | forever |
| L2 bundle | `bundles/boe-code-<UTC>.bundle` + `.sha256` | full backup | one verified file containing all refs | newest 30 |
| L3 uncommitted work | `wip/<UTC>/<worktree>/` | full backup | modified + untracked (non-ignored) files ≤ 20 MB | newest 10 |
| L4 memory | `memory/<UTC>/` | full backup | all project memory files + global CLAUDE.md | newest 20 |
| L5 secrets | `secrets/*.enc` | full backup | every `.env*` (except `.env.example`) AES-256-GCM encrypted | newest 20 per file |
| L6 database | `database/<UTC>/` | `backup-database.mjs` | every exposed table as `*.jsonl.gz.enc`, `_auth_users`, `rest-openapi.json` (schema snapshot), `MANIFEST.json` (row counts + sha256 + per-table count cross-check) | newest 14 |
| L7 storage | `storage/<bucket>/…` | `backup-database.mjs` | byte-for-byte copy of every bucket object, incremental by size | cumulative |
| L8 GitHub bundle | Actions artifact `boe-code-bundle-<sha>` | **every push to `main`** + weekly | verified bundle of all branches | 90 days |
| L9 private mirror repo | `nishantsoni7/boe-task-management-mirror` (private) — **ACTIVE since 2026-10-18** | every push to `main` + weekly | all 241 branches + tags (verified equal to the source) | forever |
| L10 second copy (recommended) | `BOE_BACKUP_COPY_TO` folder | `backup-all.mjs` | newest bundle, DB snapshot, secrets, memory, git mirror | per run |
| L11 Supabase platform backups | Supabase dashboard → Database → Backups | provider, daily ~21:55 UTC | **Pro plan: 7 daily PHYSICAL backups confirmed 2026-10-18** (full database incl. the 5 tables the export cannot read; storage objects NOT included). **PITR deliberately NOT enabled (owner decision, cost)** | 7 days |

**Encryption note.** Database tables and env files are encrypted with a passphrase (`BOE_BACKUP_PASSPHRASE`, or an auto-generated file `backups\.keys\backup-passphrase.txt`). **Copy that passphrase into your password manager once.** A laptop crash that also takes the key file makes the encrypted layers unreadable. Storage files are copied as-is (they are already served through signed URLs).

## 3. Commands

```bash
# Install hooks + tools (one time; re-run when scripts/backup or .githooks change)
node scripts/backup/install-backup-system.mjs

# Full backup — code, memory, env, database, storage
node "$HOME/BOE-Development/backups/tools/backup-all.mjs"
#   --skip-db  code only        --no-storage  skip the storage mirror        --no-github  offline
#   BOE_BACKUP_COPY_TO=D:\BOE-Backups   also copy newest snapshots to a second drive/folder

# Freshness report (exit 1 if a required layer is stale)
node "$HOME/BOE-Development/backups/tools/verify-backups.mjs"

# Decrypt one file during a restore
node "$HOME/BOE-Development/backups/tools/decrypt-file.mjs" <file>.enc <output>
```

What the database export needs: only Node 20+ and `.env.local` (`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`). No Docker, `psql` or `pg_dump`. It is **read-only** and never prints row data.

**Not covered (found 2026-10-18).** The service role has no SELECT on five relations, so the export lists them as `unreadable` and does not copy them: `finance_payment_destinations`, `finance_received_payments` (a view over other tables that ARE exported), `order_advance_exception_voids`, `order_advance_exceptions`, `order_advance_holds`. For these rely on Supabase platform backups (L11). Do not grant SELECT just for backups without the owner's decision.

**Closing that gap without grants (owner chose this 2026-10-28).** `backup-database.mjs` step 2b runs `pg_dump` for the three real tables (the two views are rebuilt from exported tables) inside a Docker container (default image `postgres:17`; set `BACKUP_PG_IMAGE=public.ecr.aws/supabase/postgres:17.6.1.171` in `backups\.env.backup` to use the Postgres 17 image that is already on this machine instead of downloading one) and writes `pg-dump-restricted-tables.sql.gz.enc` into the snapshot folder. It needs two things: Docker Desktop running, and `BACKUP_DATABASE_URL=postgresql://…` (Supabase session-pooler URI with the database password) in `backups\.env.backup`. Without either, the step is skipped with a log line and the tables stay listed as NOT COVERED — the backup itself still succeeds. To restore one: decrypt with `decrypt-file.mjs`, gunzip, run the SQL with `psql`. The view `finance_received_payments` is recreated by migrations.

**Honest limits.** (1) The REST export covers tables exposed through PostgREST in the `public` schema; the *schema itself* is restored from migrations, not from the export. (2) Auth password hashes are not exportable. (3) The export is a logical, row-level snapshot taken over several minutes, not a transactional point-in-time image — for point-in-time recovery rely on Supabase's own backups (L11). (4) Rows changed during the export can differ across tables by seconds. (5) Row counts are cross-checked against the server's exact count; a mismatch is listed in `MANIFEST.json` `errors`.

## 4. Triggers — when does each backup happen?

- **Automatic, offline, instant:** git hooks installed by `install-backup-system.mjs` → `backup-code.mjs --quick`. Hooks never block or fail a git command.
- **Automatic on GitHub:** `.github/workflows/backup-on-merge.yml` on every push to `main`.
- **Mandatory manual step after every merge:** `backup-all.mjs` then `verify-backups.mjs` (Master Instruction Sheet §8).
- **Daily schedule (INSTALLED 2026-10-18):** Windows Task Scheduler task `BOE Backup`, every day 21:30, runs `backups	oolsoe-backup-daily.cmd` (backup-all + verify, log in `backupsdaily-backup.log`; also copies to `D:BOE-Backups` when that drive is plugged in; runs on next start if the laptop was off). Disable/inspect with `Get-ScheduledTask 'BOE Backup'`. Original command form, for reference:
  ```powershell
  schtasks /Create /SC DAILY /ST 21:30 /TN "BOE Backup" /TR "node %USERPROFILE%\BOE-Development\backups\tools\backup-all.mjs" /F
  ```
  Create it only with the owner's approval; it makes read-only calls to production and writes under `backups\`.

## 5. Restore runbooks

### 5.1 Laptop lost (GitHub + Supabase + Vercel still alive)
1. Install Git, Node 20+, GitHub CLI; `git clone https://github.com/nishantsoni7/boe-task-management.git` into `%USERPROFILE%\BOE-Development\repositories\boe-task-management`.
2. `npm ci`. Recreate `.env.local` from the password manager (or decrypt `secrets\env-local-*.enc` from the second copy with `decrypt-file.mjs` + the passphrase). Variables are listed in `APP_INVENTORY.generated.md` and `.env.example`.
3. Unpushed branches/uncommitted work: restore from the second copy (L10) — `git clone <path>/git/boe-task-management.git x`, then `git branch <name> refs/local/heads/<name>`; or `git clone boe-code-*.bundle`.
4. Restore the project memory folder from `memory/<latest>/` into `~/.claude/projects/<project>/memory`.
5. `node scripts/backup/install-backup-system.mjs`, `npm test`, `npm run dev`.

### 5.2 GitHub repository lost or force-pushed
1. Restore from the newest of: local mirror (`git push <new-url> 'refs/local/heads/*:refs/heads/*'` and `refs/github/tags/*`), local bundle (`git clone boe-code-*.bundle` then push), the private mirror repo (L9), or a GitHub Action artifact (L8).
2. Recreate the repo (keep it private unless there is a reason), push `main`, re-add the **branch ruleset "Protect main"** (PR required, Vercel check required, squash/rebase only, 0 approvals, no force-push/deletion).
3. Re-connect the Vercel project to the new repo (§5.3). Re-add Actions secrets/variables for L9 if used.
4. PRs/issues/comments are not in git. Merged PR heads are preserved under `refs/github/pull/*` in the mirror; discussion text is lost unless exported separately (`gh pr list --state all --json …`).

### 5.3 Vercel project lost
1. New Vercel project from the GitHub repo; framework Next.js; root `/`; Node 20+; `vercel.json` supplies regions (`hnd1`) and the cron (`/api/image-editor/cleanup`, `0 3 * * *`).
2. Re-enter environment variables (Production + Preview) from the password manager / decrypted env backup. Required names are in `APP_INVENTORY.generated.md` ("Environment variable names"): at minimum `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`; plus `CRON_SECRET`, `FAL_KEY`, `ANTHROPIC_API_KEY`, `MINOP_*`, `NEXT_PUBLIC_SHOWROOM_IMAGE_HOSTS` as used.
3. Re-attach the production domain(s) and DNS; redeploy `main`; verify with the deploy-verification recipe.
4. The Minop device callback URL embeds a path token — reconfigure the MORX/Minop cloud with the new URL if the domain changed.

### 5.4 Supabase project lost or data corrupted
> **Rehearsed 2026-10-18** (`scripts/backup/restore-rehearsal.mjs`, free, local Docker): the newest export decrypts, un-gzips and loads cleanly - 156 tables, 96,121 rows, 21 auth users; every row count and every numeric column sum matched the backup's own record; a deliberately tampered copy was caught. This proves the DATA layer. It does NOT prove a schema rebuild: `docs/migrations-are-not-self-contained.md` - the migrations cannot rebuild an empty database on their own. **So for a real disaster use Supabase's platform backup first** (Database > Backups > Restore, or "Restore to new project"); use the export only for data Supabase cannot give back (the 5 unreadable tables are the exception - they exist ONLY in the platform backups).
1. **Prefer Supabase's own restore** (dashboard → Database → Backups / PITR) if the plan has it — it is transactionally consistent.
2. Otherwise build a new project and restore in this order:
   1. Create the project (same region, Tokyo); note new URL/keys.
   2. Replay schema: apply `supabase/migrations/*.sql` in filename order (`supabase link` + `supabase db push`, or the isolated-replay recipe in memory `reference_isolated_db_replay_recipe`). Do not edit any migration.
   3. Recreate Auth users: from `_auth_users` (ids, emails, metadata) via the Admin API keeping the **same `id`s** (foreign keys depend on them); everyone then uses "Forgot password".
   4. Load data: decrypt each `*.jsonl.gz.enc`, gunzip, insert in **foreign-key dependency order** with triggers disabled (`SET session_replication_role = replica`) so audit/notification triggers do not fire. Re-set sequences afterwards.
   5. Re-create storage buckets (`storage-buckets.json`) and upload `storage/<bucket>/…`.
   6. Update `NEXT_PUBLIC_SUPABASE_URL`, anon key and service key in `.env.local` and Vercel; redeploy.
   7. Compare table row counts with `MANIFEST.json`; run `npm run permissions:check`.
3. Write a restore script for the actual incident before running it; rehearse on a disposable project first (`docs/app-context/` rehearsal notes in memory: isolated DB replay).

### 5.5 Everything lost except one copy
Any one of: the L10 second copy, a GitHub artifact + password manager, or the private mirror repo plus Supabase platform backups, is enough to rebuild. This is why L10 and the password-manager copy of the passphrase are strongly recommended.

## 6. Manual / owner-side items that cannot be scripted

- [ ] **Enable the database export (required once).** The legacy Supabase keys in the local `.env.local` were disabled on 2026-08-16, so they no longer work. Create the file `%USERPROFILE%\BOE-Development\backups\.env.backup` (outside git and outside the Desktop) containing exactly two lines, using the project's current **secret key** (Supabase dashboard → Project Settings → API Keys → Secret keys, `sb_secret_…`):
  ```
  NEXT_PUBLIC_SUPABASE_URL=https://albnsrohngkljfsrrrhf.supabase.co
  SUPABASE_SERVICE_ROLE_KEY=sb_secret_xxxxxxxx
  ```
  `backup-database.mjs` prefers this file over `.env.local`; it is also included (encrypted) in every full backup. Until it exists the database layer reports FAIL in `verify-backups.mjs`.
- [ ] Copy `backups\.keys\backup-passphrase.txt` to the password manager (and every production secret value: Supabase keys, `CRON_SECRET`, `FAL_KEY`, `ANTHROPIC_API_KEY`, Minop token, Vercel/GitHub account recovery codes).
- [x] Supabase plan confirmed Pro with 7 daily backups (2026-10-18). PITR not enabled by choice; recovery-point is therefore up to ~24 h for database data.
- [x] Second copy: external drive `D:BOE-Backups` (set per run via `BOE_BACKUP_COPY_TO`; the daily task does it automatically when plugged in). Original note: choose a second location for `BOE_BACKUP_COPY_TO` (external drive or a cloud-synced folder **outside the Desktop**) and run a copy.
- [x] Private mirror repo created; secret `BACKUP_MIRROR_TOKEN` (fine-grained token `boe-mirror`, ONLY the mirror repo, Contents + Workflows read/write, **expires 2027-10-17 — renew before then**, then update the secret) and variable `BACKUP_MIRROR_REPO` set. If the mirror job ever fails with "Repository not found", check that `actions/checkout` still has `persist-credentials: false` in the mirror job.
- [ ] Record Vercel project settings that are not in git: team/project name, domain(s), DNS provider, Node version, build command overrides, env var list with Production/Preview scoping (names only in docs).
- [ ] Record GitHub ruleset "Protect main" JSON: `gh api repos/nishantsoni7/boe-task-management/rulesets` → keep a copy in the password manager.
- [ ] The repository is **public**. Nothing secret may ever be committed; if the owner wants it private, change it in GitHub settings (Vercel's GitHub integration keeps working).
- [x] Quarterly: restore rehearsal - `node ~/BOE-Development/backups/tools/restore-rehearsal.mjs` (needs Docker Desktop running; first done 2026-10-18; the reminder system asks every 90 days). Record the result in `CHANGELOG.md`.

## 7. Recovery-point summary

| Failure | Latest recoverable state | Needs |
|---|---|---|
| Laptop dies | last push to GitHub + last hook mirror copy only if disk survives; else GitHub + L10 | GitHub or L10 |
| Bad merge / force-push | any prior commit, via mirror/bundle/artifacts | any code layer |
| Deleted/corrupted data | Supabase PITR if enabled, else last `backup-database.mjs` snapshot (≤ 24 h with the schedule; exact moment of the last merge if the ritual was followed) | L6/L7/L11 |
| Vercel account lost | immediate (redeploy from git + env values) | secrets in password manager |
| All of GitHub lost | last push to `main` (artifact/mirror) | L1/L2/L8/L9/L10 |
