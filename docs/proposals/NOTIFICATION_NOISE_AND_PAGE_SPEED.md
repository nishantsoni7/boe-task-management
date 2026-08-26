# `run_task_health_check` — read-only inspection, then a migration

Everything here is a proposal. **No migration exists in `supabase/migrations/`,
nothing has been applied, and no production data has been touched.**

Business Outcome 1 is complete on the read side and on every application write
path. The one remaining writer of `escalation` / `overdue` rows is an hourly
database job that **is not in this repository** — it was installed directly
against the database, so its body cannot be read from here and no migration for
it can be written honestly until someone runs the queries in Part A.

---

## Part A — the exact read-only SQL to run in the Supabase SQL Editor

All read-only. Run all eight; paste back the fields named under each.

### A1. The function definition — the blocker

```sql
select
  p.oid::regprocedure                as function_signature,
  n.nspname                          as schema_name,
  p.prosecdef                        as is_security_definer,
  pg_get_userbyid(p.proowner)        as owner,
  p.proconfig                        as config_settings,   -- search_path etc.
  l.lanname                          as language,
  pg_get_function_identity_arguments(p.oid) as identity_args,
  pg_get_functiondef(p.oid)          as function_definition
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
join pg_language  l on l.oid = p.prolang
where p.proname = 'run_task_health_check';
```

**Paste back: every column, and `function_definition` in full and verbatim.**
Do not trim it — the whole point is that the insert cannot be removed safely
without seeing what surrounds it. If this returns zero rows, say so: the job may
live under a different name or a different schema, and A2 will find it.

### A2. Its schedule

```sql
select jobid, schedule, command, nodename, database, username, active
from cron.job
order by jobid;
```

**Paste back: every row.** (Not just the matching one — a second job may write
notifications under another name.) If this errors with `relation "cron.job"
does not exist`, pg_cron is not installed in this database; say so and also run:

```sql
select extname, extversion from pg_extension order by extname;
```

### A3. Grants and privileges on the function

```sql
select
  p.oid::regprocedure as function_signature,
  coalesce(array_to_string(p.proacl, E'\n'), '(default: PUBLIC EXECUTE)') as grants
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'run_task_health_check';
```

**Paste back: `grants`.** The migration must restate exactly these.

### A4. Every trigger that can reach `notifications`

```sql
select
  c.relname            as table_name,
  t.tgname             as trigger_name,
  t.tgenabled          as enabled,
  pg_get_triggerdef(t.oid) as definition
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where not t.tgisinternal
  and (c.relname = 'notifications' or pg_get_triggerdef(t.oid) ilike '%notification%')
order by c.relname, t.tgname;
```

**Paste back: every row.** A trigger on `notifications` that fans out to a
webhook would be a delivery path the application layer cannot see.

### A5. Outbound delivery attached to notification inserts

```sql
-- Does the database make outbound HTTP at all?
select extname, extversion from pg_extension
 where extname in ('pg_net', 'http', 'pg_cron', 'supabase_vault');

-- Supabase Database Webhooks are implemented as triggers calling this schema.
select n.nspname, p.proname
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname in ('supabase_functions', 'net')
 order by 1, 2;

-- Any function body anywhere that mentions both notifications and an HTTP call.
select n.nspname, p.proname
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname not in ('pg_catalog', 'information_schema')
   and p.prosrc ilike '%notifications%'
   and (p.prosrc ilike '%net.http%' or p.prosrc ilike '%supabase_functions%'
        or p.prosrc ilike '%http_post%' or p.prosrc ilike '%webhook%')
 order by 1, 2;
```

**Paste back: all three result sets, including empty ones** (an empty result is
the answer I need, and I cannot distinguish "empty" from "not run").

### A6. Everything else that writes to `notifications`

```sql
select n.nspname as schema, p.proname as function_name, p.prosecdef as security_definer
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname not in ('pg_catalog', 'information_schema')
  and p.prosrc ~* 'insert\s+into\s+(public\.)?notifications'
order by 1, 2;
```

**Paste back: every row.** Expected: `transition_task_review` (human-invoked,
must keep notifying) and `run_task_health_check`. Anything else is a writer
nobody has accounted for.

### A7. Is escalation history stored anywhere but `notifications`?

This decides whether the migration may simply delete the insert or must add a
`task_activity_log` write in its place.

```sql
-- What actions the activity log already records.
select action, count(*) as rows,
       min(created_at) as first_seen, max(created_at) as last_seen
  from public.task_activity_log
 group by action
 order by rows desc;

-- Rows the log holds with no human actor — i.e. written by the system.
select action, count(*) as rows, max(created_at) as last_seen
  from public.task_activity_log
 where actor_id is null
 group by action
 order by rows desc;

-- The shape and volume of what the job has been writing.
select type, count(*) as rows,
       min(created_at) as first_seen, max(created_at) as last_seen,
       count(*) filter (where is_read) as read_rows
  from public.notifications
 where type in ('escalation','overdue','stale_flag','morning_digest','evening_digest')
 group by type
 order by rows desc;
```

**Paste back: all three result sets.**
If the second returns rows whose `action` looks like an escalation, the job
already records history and the migration only deletes the notification insert.
**If it returns nothing, the notification row IS the only record** and deleting
the insert would destroy history rather than relocate it — the migration must
then add the log write in the same statement, and I need A1's body to do it.

### A8. Column and type definitions the filter depends on

```sql
select column_name, data_type, udt_name, is_nullable, column_default
  from information_schema.columns
 where table_schema = 'public' and table_name = 'notifications'
 order by ordinal_position;

select t.typname, e.enumlabel, e.enumsortorder
  from pg_type t join pg_enum e on e.enumtypid = t.oid
 where t.typname = 'notification_type'
 order by e.enumsortorder;

select indexname, indexdef
  from pg_indexes
 where schemaname = 'public' and tablename = 'notifications';
```

**Paste back: all three.** The enum labels confirm the five suppressed values
still exist and that no sixth system type has been added since; the index list
decides whether Part C is needed at all.

---

## Part B — the migration, once A1 and A7 are answered

**Not written yet, deliberately.** `create or replace function` replaces the
whole body, so it cannot be written without A1's exact text, and A7 decides
whether the escalation record has anywhere else to live. What it will do:

- keep the detection/escalation calculation byte-for-byte as A1 returns it;
- keep — or, if A7 shows there is none, **add** — the `task_activity_log` write,
  preserving timestamps and from/to status;
- delete only the `insert into public.notifications` for the non-actionable
  types;
- touch no human-triggered notification and nothing addressed to a named user
  who must act;
- change no `cron.job` row, so timing is untouched;
- delete no historical row;
- restate the signature, `security definer`/`invoker` mode, `search_path`,
  owner and grants exactly as A1 and A3 report them.

Skeleton, with the parts that come from the inspection marked:

```sql
-- supabase/migrations/<ts>_task_health_check_stops_notifying.sql
begin;

create or replace function public.run_task_health_check()   -- ← A1 signature
returns void                                                -- ← A1 return type
language plpgsql
security definer                                            -- ← A1 prosecdef
set search_path = public, pg_temp                           -- ← A1 proconfig
as $$
begin
  -- ↓ A1 body, unchanged, EXCEPT:
  --   · the `insert into public.notifications (...)` block is removed;
  --   · if A7 showed no activity-log write, one is added here, recording the
  --     same task, the same escalation level and the same timestamps.
end;
$$;

alter function public.run_task_health_check() owner to <A3 owner>;
-- Restate A3's grants verbatim; do not widen them.

commit;
```

**Rollback:** capture A1's `function_definition` before applying and keep it
verbatim. Rolling back is re-running that exact text as a
`create or replace function`. Nothing else changes — no table, no row, no cron
entry, no grant — so there is nothing else to undo. Re-running the original
resumes the notification inserts from the next scheduled fire.

**Application-side safety net:** none of this can regress the UI. The feed, the
badge count, mark-all-read and delete-all already exclude these types by name
(`SYSTEM_TYPE_EXCLUSION`), so whether the job writes them or not, no user sees
them. The migration removes the writes; it does not change what is displayed.

---

## Part C — indexes (optional, measure first)

The list runs `user_id = $1 AND (16 ILIKE patterns) AND type NOT IN (…)
ORDER BY created_at DESC, id DESC LIMIT n+1`; the badge runs the same predicate
with `is_read = false` as a count. Neither ILIKE chain is indexable; the leading
`user_id` and the ordered limit are.

```sql
create index concurrently if not exists notifications_user_created_desc_idx
  on public.notifications (user_id, created_at desc, id desc);

create index concurrently if not exists notifications_user_unread_idx
  on public.notifications (user_id) where is_read = false;
```

`concurrently` cannot run inside a transaction — check the migration runner
before committing these. **A8's `pg_indexes` output decides whether either is
needed**; if an index already leads on `user_id`, the first is redundant.

Measure before adding:

```sql
explain (analyze, buffers) <the list query, with a real user_id>;
select relname, n_live_tup, pg_size_pretty(pg_total_relation_size(relid))
  from pg_stat_user_tables where relname = 'notifications';
select indexrelname, idx_scan from pg_stat_user_indexes where relname = 'notifications';
```

---

## Part D — the linked PostgREST checks I could not run

These need a signed-in session against the real project. All read-only except
where noted; **none should be run against production without test data**.

| # | Check | How |
|---|---|---|
| D1 | the enum `not.in` filter is accepted | `GET /rest/v1/notifications?select=id&type=not.in.(escalation,overdue,stale_flag,morning_digest,evening_digest)&limit=1` → **200 with a JSON array**, not a 400/404 mentioning `operator does not exist` |
| D2 | first page loads | `GET /api/notifications?category=task&limit=50` → `notifications` ≤ 50, `hasMore` boolean |
| D3 | unread count excludes system types | `GET /api/notifications?count=1&category=task`, then compare against `select count(*) from notifications where user_id = <me> and is_read = false and type in ('escalation','overdue','stale_flag','morning_digest','evening_digest')` — the second must be **excluded** from the first |
| D4 | ordering is total | `GET /api/notifications?category=task&limit=50` twice; the id sequences must be identical |
| D5 | mark-all-read covers every visible unread | **mutating** — needs a test account |
| D6 | delete-all covers every visible row | **mutating** — needs a test account |
| D7 | no visible row is undeletable | implied by D6 plus the id-scoped single delete, which applies no type filter |

**D5 and D6 mutate rows and were not run.** They need either a throwaway
account with seeded notifications or a staging project. Say which you want and
I will write the exact request sequence.

D1 is the one with real deployment risk: `notifications.type` is a Postgres
enum, and this repository has a recorded incident where a `LIKE` against it
failed server-side while a HEAD/count request swallowed the error and returned
`count: null`. `not.in` is the documented-correct operator for an enum and is
what the code uses, but it has not been exercised against the live PostgREST
from here.
