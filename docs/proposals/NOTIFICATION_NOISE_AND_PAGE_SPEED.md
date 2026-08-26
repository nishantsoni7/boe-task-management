# Proposed database work — NOT APPLIED

Everything in this file is a proposal. **No migration was created in
`supabase/migrations/`, nothing was applied, and no production data was
touched.** Two of the four business outcomes in this change are complete in
application code; the two items below are the parts that can only be finished
in the database, and both need a decision (and, for the first, a look at a
function body that does not exist in this repository) before anyone writes SQL.

---

## 1. `run_task_health_check` — the only remaining system-notification writer

### What it is

An hourly database cron job. `src/lib/notifications.ts` has recorded since June
that it writes `overdue` and `escalation` rows into `public.notifications` —
roughly 16,000 of them — and that none of those rows has ever been shown to a
user. Nothing in this repository creates it, calls it, or contains its body:
it was installed directly against the database, so the SQL below is a shape,
not a patch.

### Where it stands after this change

| | before | after |
|---|---|---|
| in-app: visible in the Notifications feed | no (excluded only as a side effect of the title whitelist) | no — excluded **explicitly** by type, on the list, the badge count, mark-all-read and delete-all |
| in-app: rows still written to `notifications` | yes, hourly | **yes, hourly** — unchanged |
| push | nothing in this codebase dispatches push; `is_push_sent` is a column set at insert time and no transport reads it here | unchanged |
| activity history | whatever the job writes to `task_activity_log` | unchanged |

So the user-facing half of "system actions must not create notifications" is
done and enforced in one place. The row-creation half is not, and cannot be:
the writer is a database function.

### What to change, and the one thing to check first

**Read the function body before writing anything:**

```sql
select prosrc from pg_proc where proname = 'run_task_health_check';
select * from cron.job where command ilike '%run_task_health_check%';
```

The requirement is that the escalation must still *happen* and must still be
*visible in the permanent task activity history* with its timestamps and
status information. So the change is only ever "stop the `notifications`
insert", never "stop the job". If the current body records escalations **only**
in `notifications`, deleting that insert would destroy the record rather than
relocate it, and the migration must add the `task_activity_log` write in the
same statement. That is the fact to establish first.

Shape of the migration, once the body is known:

```sql
-- Escalation stays an EVENT, and stops being a MESSAGE.
create or replace function public.run_task_health_check()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- … existing detection logic, unchanged …

  -- KEEP: the permanent record. Timestamps and status transitions intact.
  insert into public.task_activity_log (task_id, actor_id, action, from_status, to_status, note)
  select …;

  -- REMOVE: the insert into public.notifications.
  -- Nobody can act on an escalation, and no screen has ever displayed one.
end;
$$;
```

Historic rows are **not** deleted by this proposal. They are invisible either
way, deleting 16k rows is irreversible, and they are the only evidence of what
the job has been doing. If a cleanup is wanted it should be a separate,
separately-reviewed migration.

### What must NOT be swept up

`asset_warranty_expiring`. It is also raised without anyone clicking anything
(`/api/assets/warranty-sweep`), but it asks an admin to renew a warranty before
a date passes — an actionable reminder. It is listed explicitly in
`ACTIONABLE_SCHEDULED_NOTIFICATION_TYPES` and asserted to survive the rule in
`src/lib/notificationSystemActivity.test.ts`.

---

## 2. Indexes for the notification list and badge count

### The queries as they actually run

List (`GET /api/notifications`):

```sql
select … from notifications
 where user_id = $1
   and (title ilike '%acknowledged task%' or … 16 patterns …)
   and type not in ('escalation','overdue','stale_flag','morning_digest','evening_digest')
 order by created_at desc
 limit 51;
```

Badge count (`GET /api/notifications?count=1`):

```sql
select count(*) from notifications
 where user_id = $1 and is_read = false
   and (… same 16 ILIKE patterns …)
   and type not in (…);
```

Neither ILIKE chain is indexable. What *is* indexable is the leading
`user_id`, and — for the list — the `order by … limit`.

### Proposed

```sql
-- Lets the list walk one user's rows newest-first and stop at 51 matches
-- instead of sorting everything they own.
create index concurrently if not exists notifications_user_created_desc_idx
  on public.notifications (user_id, created_at desc);

-- The badge count touches only unread rows, which are a small minority of the
-- table. A partial index keeps it that size.
create index concurrently if not exists notifications_user_unread_idx
  on public.notifications (user_id)
  where is_read = false;
```

`concurrently` means these cannot run inside a transaction, so they need a
migration that does not wrap them — check how this project's runner behaves
before committing them.

**Not applied, and not required by this change.** The application-side work
(route prefetch, one shared identity resolution instead of a second auth round
trip and a duplicate profile read, a bounded page, and a shell that no longer
unmounts while the list loads) is independent of them. These indexes are the
next thing to reach for if the *server* portion of the notification queries is
measured to be the remaining cost.

### Before adding them, measure

```sql
explain (analyze, buffers)
select … ;                     -- the two queries above, with a real user_id

select relname, n_live_tup, pg_size_pretty(pg_total_relation_size(relid))
  from pg_stat_user_tables where relname = 'notifications';

select indexrelname, idx_scan from pg_stat_user_indexes
 where relname = 'notifications';
```

If `notifications` already carries an index leading on `user_id`, the first of
the two is redundant. That could not be checked from here — this environment
has no database credentials.
