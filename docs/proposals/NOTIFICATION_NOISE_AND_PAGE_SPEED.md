# `run_task_health_check` — read-only inspection, then a migration

Everything here is a proposal. **No migration exists in `supabase/migrations/`,
nothing has been applied, and no production data has been touched.**

Business Outcome 1 is complete on the read side and on every application write
path. The one remaining writer of `escalation` / `overdue` rows is an hourly
database job that **is not in this repository** — it was installed directly
against the database, so its body cannot be read from here and no migration for
it can be written honestly until someone runs the queries in Part A.

---

## Part A — read-only inspection

The queries live in one copyable file next to this one:

**[`run_task_health_check_inspection.sql`](./run_task_health_check_inspection.sql)**

Strictly read-only: no CREATE/ALTER/DROP/INSERT/UPDATE/DELETE/GRANT/REVOKE, no
cron changes, and the function under inspection is never called — it is only
named in a WHERE clause. Safe to run against production.

| § | Answers |
|---|---|
| A1 | the complete function definition, signature, security mode, owner, `search_path`, volatility (+ A1b, a name fallback if A1 is empty) |
| A2 | pg_cron presence, every scheduled job, and recent run history |
| A3 | owner and grants, which the migration must restate exactly |
| A4 | every trigger touching or mentioning `notifications` |
| A5 | outbound HTTP extensions, Supabase webhook entry points, and any function body combining notifications with an HTTP call |
| A6 | every function that inserts into `notifications` |
| A7 | **whether escalation history exists outside `notifications`** — the answer that decides the migration |
| A8 | columns, `notification_type` enum labels, indexes and table size |

Run it top to bottom and copy back what each section's `COPY BACK` line asks
for. **An empty result grid is an answer** — report it as `0 rows` rather than
omitting it, because "empty" and "not run" are indistinguishable otherwise.

**A7c is the one that matters most.** If the activity log holds system-written
(actor-less) escalation rows, the migration only deletes the notification
insert. If it holds none, the notification row IS the only record of an
escalation, and deleting the insert would destroy history rather than relocate
it — the migration must then add the log write in the same statement, which
needs A1's body to do correctly.

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
