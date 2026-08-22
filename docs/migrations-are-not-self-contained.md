# The migration history cannot build a database on its own

**Status:** open blocker. Nothing in this document has been acted on — it records
what was measured and what the safest fix would be.

## The short version

`supabase/migrations` cannot be replayed into an empty PostgreSQL database. Four
tables are referenced by the migrations but created by none of them:

| Table | References in the migrations | First reference |
|---|---|---|
| `public.users` | 367 | `20260605_add_soft_delete_users.sql` |
| `public.tasks` | 23 | `20260628000100_create_user_top_tasks.sql` |
| `public.task_activity_log` | 7 | `20260833000000_task_creator_approval.sql` |
| `public.notifications` | 12 | `20260705000000_protect_finalized_orders_and_payments.sql` |

The very first migration in the directory, `20260530_create_positions.sql`,
already assumes `public.users` exists — it declares a foreign key against it. So
the gap is not a late omission; the repository's history begins *after* the
schema it depends on was created.

## How this was measured

Not from memory. Every `.sql` file in `supabase/migrations` was parsed with SQL
comments stripped, collecting:

* every object the migrations **create** — `create table`, `create sequence`,
  `create view` (75 tables, 2 sequences, 1 view), and
* every object they **reference** — `alter table public.X`,
  `references public.X`, `from public.X`, `join public.X`,
  `insert into public.X`, `on public.X`, `nextval('public.X')`.

Referenced minus created leaves exactly the four tables above. Stripping
comments matters: an unfiltered scan also returns `and`, `the`, `only`, `may`
and a dozen other English words out of the prose, and reports
`resolve_effective_permissions` as missing when it is a set-returning **function**
created in `20260660_create_permission_engine.sql`.

Reproduce it by parsing the directory the same way; the numbers above are the
output.

## Confirmed by trying it

A local PostgreSQL 16 was started, the Supabase-shaped roles (`anon`,
`authenticated`, `service_role`) and an `auth` schema with `auth.uid()` /
`auth.role()` / `auth.jwt()` shims were created, and all 196 migrations were
applied in filename order with `ON_ERROR_STOP`:

```
FIRST FAILURE: 20260530_create_positions.sql
psql: ERROR:  relation "users" does not exist
APPLIED=12  FAILED=184
```

The 184 failures are almost entirely cascade: once `users` is absent, nearly
every later file that touches a policy, a foreign key or a `SECURITY DEFINER`
function fails too.

## What it blocks

1. **`supabase/tests/*.sql` cannot be executed by anyone.** There are 29
   assertion files, several of them the only proof of a security boundary — RLS
   isolation, the approval gate, allocation capacity, permission precedence.
   They are written to run against a migrated database, and no such database can
   be built from this repository. In practice they can only ever have been run
   against a live environment.
2. **A migration cannot be rehearsed before it is applied.** There is no way to
   prove a new forward-only migration applies cleanly, only to read it carefully.
   The project compensates with apply-time `do $$ ... raise exception ... $$`
   blocks inside the migrations themselves, which is a good practice and not a
   substitute.
3. **A new environment cannot be provisioned from source.** Staging, a review
   app, or a restored disaster-recovery instance all need the four tables from
   somewhere other than this repository.

## What it does *not* block

Production is unaffected. The four tables exist in the live database — they were
created before this migration history began, almost certainly through the
Supabase dashboard or an earlier tool. Every migration since has applied against
them successfully. **This is a repeatability problem, not a correctness one.**

## Why a baseline migration was not written

The obvious fix — add a `00000000000000_baseline.sql` that creates the four
tables — is the one thing that must not be done casually:

* **It would be guesswork.** The migrations reveal which columns of `users` are
  *read*: `id`, `email`, `full_name`, `role`, `team`, `is_active`, `is_deleted`,
  `employee_code`, `exit_date`, `performance_tracking_enabled`,
  `performance_tracking_note` — eleven of them. They reveal almost nothing about
  the exact types, nullability, defaults, constraints, indexes or RLS policies
  the real table carries, and a baseline that got any of those wrong would be a
  *false* record of production, which is worse than no record.
* **`tasks` and `notifications` are worse.** The migrations touch one column of
  `tasks` (`attachment_storage_path`, which they add themselves) and no column of
  `notifications` at all. There is essentially no evidence here to reconstruct
  from.
* **It would be dangerous to deploy.** A baseline that runs against production
  must be a provable no-op. `create table if not exists` silently succeeds
  against a table with a *different* shape, which would leave the repository
  asserting a schema the database does not have — the exact drift a baseline is
  supposed to end.

## The safest fix, in order

1. **Dump the real schema.** From the production or staging database:
   ```
   pg_dump --schema-only --schema=public \
           --table=public.users --table=public.tasks \
           --table=public.task_activity_log --table=public.notifications \
           "$DATABASE_URL" > baseline.sql
   ```
   This is the only accurate source. It requires production credentials, which
   is why it has not been done here.
2. **Check it in as a test bootstrap, not as a migration.** Put it at
   `supabase/tests/bootstrap/000_pre_migration_schema.sql`, outside
   `supabase/migrations`, so the deployment path is untouched and there is no
   possibility of it running against production. A local test harness applies
   the bootstrap first, then the migrations in order, then the assertion files.
3. **Only then consider a real baseline migration**, and only with its no-op
   safety proven against a copy of production first.

Step 2 delivers everything the assertion files need and carries no deployment
risk at all. It is the recommended next action.

## Related

* `src/lib/supabasePaging.ts` — the other place this project has been bitten by
  something that fails silently rather than loudly.
* Apply-time assertions inside recent migrations
  (`20261004000000`, `20261005000000`) — the current, and currently only,
  mechanism for catching a bad migration.
