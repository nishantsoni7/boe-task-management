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

## Part B — the migration: WRITTEN AND APPLIED

`supabase/migrations/20261015000000_task_health_check_stops_notifying.sql`.
Pushed; `supabase migration list --linked` reports Local and Remote both at
`20261015000000`.

**It must not be edited or renumbered.** Its bytes are pinned by SHA-256 in the
`FROZEN` list in `src/lib/finance/participantAndOrderTotalSecurity.test.ts`, and
that hash is a claim about the exact bytes the database ran. A correction after
this point is a new migration, 116 or later.

Its header still reads `NOT APPLIED`. That line is stale and is left alone on
purpose: `20261007000000` and `20261008000000` carry the same stale line for the
same reason. `FROZEN` — not a file header — is where applied status is recorded.

### What it changed

Removed, and nothing else:

| | |
|---|---|
| 4 × `INSERT INTO notifications` | one `overdue`, three `escalation` (24h, 48h, 72h) |
| 2 × `ELSIF` branch heads | 24h and 48h, whose only effect was those inserts |

38 lines removed, 0 added, proven by a multiset diff in
`healthCheckMigrationAudit.test.ts` against the captured baseline.

Preserved byte for byte: the task selection and its
`status NOT IN ('completed', 'blocked')` filter; the overdue activity-log write
with its `IF NOT EXISTS` guard and its `CONTINUE`; the waiting `CONTINUE`; the
72h activity-log write with its guard; the whole stale block (6-day probe, 5-day
age test, the `tasks` UPDATE, the `stale_flagged` write); every threshold;
`LANGUAGE plpgsql`; `RETURNS void`; the signature; `SECURITY INVOKER` (preserved
by saying nothing — it is the default and `pg_get_functiondef` omits the clause).
No `SET search_path`, no owner/`GRANT`/`REVOKE`, no cron change, no historical
row deleted.

### Rollback

`docs/proposals/run_task_health_check.production.sql` holds the pre-change
definition verbatim. Running it restores the old behaviour; nothing else needs
undoing, because the migration touched no table, row, cron entry, grant or
ownership.

### The UI was already safe either way

The feed, the badge count, mark-all-read and delete-all exclude these types by
name (`SYSTEM_TYPE_EXCLUSION`), so whether the job writes them or not, no user
sees one. The migration stopped the writes; it did not change what is displayed.

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
