# Repository scripts

Last verified: **2026-08-11**

| Script | What it does | Writes data? |
| --- | --- | --- |
| `check-docs.mjs` | Documentation structure and link validation (`npm run docs:check`) | No |
| `check-secrets.mjs` | Credential scan of tracked files, optionally Git history (`npm run check:secrets`) | No |
| `lint-baseline.mjs` | Lint ratchet — fails only when problems rise above the recorded baseline | No |
| `sync-permissions.ts` | Sync the permission registry (`npm run permissions:sync`) | Yes — permissions |
| `uat-env.mjs` | Shared environment guard for the UAT scripts | No |
| `uat-seed.mjs` | Creates `[TEST-UAT]` users, tasks and activity | **Yes** |
| `uat-simulate.mjs` | Exercises user flows as seeded test users | **Yes** |
| `uat-cleanup.mjs` | Deletes every `[TEST-UAT]` record | **Yes — destructive** |

---

## ⚠️ Before running a UAT script

These three **write and delete real rows** using a Supabase `service_role` key,
which **bypasses every row-level security policy**. They are not read-only
diagnostics.

1. **Check the target.** Each script prints `UAT target: <url>` before doing
   anything. Read that line. Pointing `uat-cleanup` at production deletes every
   `[TEST-UAT]` row there.
2. **Prefer a scratch project.** Nothing forces these at production, and nothing
   should.
3. **Never commit the credentials.** `.env*` is git-ignored; the example file
   holds placeholders only.

## Supplying credentials

Credentials come from the environment. There are **no defaults and no
fallbacks** — a missing variable stops the script with a message naming what is
absent, because a silent fallback is how a script aimed at a scratch project
quietly runs against production instead.

```bash
cp scripts/uat.env.example .env.uat.local   # .env* is git-ignored
# fill in real values, then:
set -a; . ./.env.uat.local; set +a
node scripts/uat-seed.mjs
```

Or for a single command:

```bash
UAT_SUPABASE_URL=… UAT_SUPABASE_SERVICE_ROLE_KEY=… node scripts/uat-cleanup.mjs
```

| Variable | Needed by |
| --- | --- |
| `UAT_SUPABASE_URL` | all three |
| `UAT_SUPABASE_SERVICE_ROLE_KEY` | all three |
| `UAT_SUPABASE_ANON_KEY` | `uat-simulate` |
| `UAT_PASSWORD` | `uat-seed`, `uat-simulate` |

## Why the credentials moved

All three scripts previously hard-coded a production `service_role` key in
tracked source. See **R-0** in
[`../docs/BOE Master Context/09_Risk_Register.md`](../docs/BOE%20Master%20Context/09_Risk_Register.md).

Moving them to the environment stops the mistake continuing. It does **not**
revoke anything — the committed value remains in Git history, and only rotating
the key at Supabase revokes it.

`src/lib/security/uatScriptCredentials.test.ts` fails if a credential literal
reappears in any of these scripts.
