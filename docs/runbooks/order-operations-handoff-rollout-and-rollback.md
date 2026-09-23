# The PI-to-operations handoff (`20261229000000`): rollout and rollback

This migration is **additive and forward-only**, but it is not "one trigger".
It adds two tables (and seeds one settings row), two enum values, seven
functions (one of them a re-emission of `set_order_production_alignment()`),
one trigger, RLS policies, and the code reads the tables. Undoing it is a
**forward-fix** written as a new migration, never an edit or removal of this
file once it has been applied.

## What the migration installs

| Object | Kind | Undo |
| --- | --- | --- |
| `order_operations_handoffs`, `order_operations_reviewers` (+ the `pi_handoff` row, nobody assigned) | tables + RLS + grants | can stay (harmless when unused) or be dropped by a forward migration |
| `notification_type` values `order_operations_review_requested`, `_decided` | enum values | **cannot be dropped** from a Postgres enum; harmless if never written |
| `order_pi_versions_record_operations_handoff()` + trigger | AFTER trigger on `order_pi_versions` | `drop trigger` stops all recording and alignment resets |
| `decide_order_operations_handoff()`, `set_order_operations_reviewer()` | RPCs (authenticated) | `revoke execute` closes the doors; `drop function` removes them |
| `order_operations_handoff_set_alignment()`, `operations_reviewer_can_open_order()`, `operations_reviewer_covers_all_orders()` | internal functions | `drop function` |
| `set_order_production_alignment()` | **re-emitted** existing RPC | must be **restored** to its `20261119000000 §8` body by a forward migration |

## The interval problem, and how the rollout closes it

Between applying the migration, deploying the UI and assigning the reviewer,
a PI approval would record a handoff that nobody is assigned to (and, before
the UI is deployed, the notification type is not yet in any feed). The
database already makes such a handoff **recoverable** — it is recorded
unassigned with `unassigned_reason = 'no_reviewer'`, every active admin gets a
notification row, and assigning a reviewer readdresses every waiting handoff —
but the rollout below makes sure it does not happen at all, and checks that it
did not.

### 0. Before the window: confirm the reviewer can be assigned

The reviewer must be able to open **every** Confirmed Order: an active admin,
an active member of the `operations` department, or an active holder of
`orders.view_all` — each with Orders module entry. `orders.view` alone is not
enough (it opens the module, not every row). Check Nitish, by email, against
the live database (read-only, SQL editor or `psql` as `postgres`) — **after**
step 2, since the helper arrives with the migration; before it, check the same
three conditions by hand in Control Center → People and → Access:

```sql
select u.id, u.full_name, u.role, u.team, u.is_active,
       public.operations_reviewer_covers_all_orders(u.id) as can_be_reviewer
  from public.users u
 where u.email = '<nitish email>';
```

If `can_be_reviewer` is false, fix his department or grant `View all Orders`
first; `set_order_operations_reviewer()` will refuse him otherwise.

### 1. Freeze PI approvals

Agree a short window with the approvers (Nishant and anyone holding
`orders.approve_order`): no **Approve** on a submitted PI, and no **Approve
revised PI** on a Confirmed Order, until step 5. Drafting, submitting,
payments and everything else continue. Note the time the freeze starts.

### 2. Apply the migration

`supabase db push` with `[db.migrations] enabled = true` in `config.toml`
(with it false, `db push` silently applies nothing). Safe to apply twice.
Nothing running changes: no Order column moves, no row is backfilled, and the
trigger fires only on the next approval.

### 3. Deploy the code

Migration first, then code: the Order page, the dashboard and the Action Queue
read `order_operations_handoffs`, and against a database without it those
reads fail (the Action Queue shows an error banner).

### 4. Assign the reviewer

Control Center → Operations Handoff → choose Nitish → Save. The RPC takes the
reviewer row lock, so it also waits for, and then readdresses, any approval
that slipped through the freeze.

### 5. Verify nothing is unseen, then lift the freeze

```sql
-- Every live, unresolved handoff and who it waits on. After step 4 this must
-- show no row with assigned_to null (other than ones whose reason says the
-- reviewer cannot open that Order, which an admin must then resolve).
select o.display_number, h.version_number, h.status, h.assigned_to, h.unassigned_reason, h.created_at
  from public.order_operations_handoffs h
  join public.orders o on o.id = h.order_id
 where h.superseded_at is null and h.status <> 'accepted' and o.status <> 'cancelled'
 order by h.created_at;

-- Anything approved since the freeze started (should be empty).
select o.display_number, h.version_number, h.created_at
  from public.order_operations_handoffs h join public.orders o on o.id = h.order_id
 where h.created_at >= '<freeze start>';
```

Then lift the freeze and walk through the manual checklist in the PR with
Nishant and Nitish.

## Rollback (forward-fix), if the handoff must be switched off

Code first (so nothing reads the doors you are about to close), then a new
migration `2026XXXXXXXXXX_order_operations_handoff_disable.sql`:

```sql
-- 1. Stop recording, and stop resetting alignment on new versions.
drop trigger if exists order_pi_versions_record_operations_handoff on public.order_pi_versions;

-- 2. Close the doors. The rows stay readable for audit.
revoke execute on function public.decide_order_operations_handoff(uuid, text, text) from authenticated;
revoke execute on function public.set_order_operations_reviewer(uuid) from authenticated;

-- 3. Restore the alignment door to its 20261119000000 §8 body (copy it
--    verbatim from that file: orders.align_production, note ≤ 500, cancelled
--    refused, idempotent, production_alignment_changed event). Grants are
--    unchanged. After this, every Order aligns the old way.
create or replace function public.set_order_production_alignment(p_order_id uuid, p_aligned boolean, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
  -- …the 20261119000000 §8 body, unchanged…
$$;
```

What the rollback does **not** do, on purpose:

* It does not delete `order_operations_handoffs` rows. They are the record of
  who accepted what; keep them.
* It does not touch `orders.production_alignment`. An Order aligned by an
  acceptance stays aligned; one reset by a later version stays not aligned
  until somebody aligns it the old way. Both are true statements about what
  happened, and both are on the Order's history.
* It does not remove the enum values (Postgres cannot), and need not.

Verify on a disposable stack that `pg_get_functiondef` of
`set_order_production_alignment` no longer contains
`decide_order_operations_handoff(`.

## Concurrency, for whoever changes this next

Lock order everywhere is **orders → order_operations_reviewers →
order_operations_handoffs**:

| Path | Takes |
| --- | --- |
| initial approval (`approve_order_submission`) | submission row; new orders row; trigger: reviewers **FOR SHARE** → handoffs |
| revision approval (`approve_order_pi_revision`) | orders **FOR UPDATE** → versions; trigger: reviewers **FOR SHARE** → handoffs → orders (already held) |
| assignment (`set_order_operations_reviewer`) | reviewers **FOR UPDATE** → handoffs `FOR UPDATE OF h` (never orders) |
| decision (`decide_order_operations_handoff`, and the alignment door routed to it) | orders **FOR UPDATE** → handoffs (never reviewers) |

No path takes them in the opposite order, so there is no cycle.
`supabase/tests/run_order_operations_handoff_race.sh` proves the approval /
assignment ordering with two real sessions, in both directions and for a
cleared reviewer.

## Verifying either direction on a disposable stack

`supabase/tests/run_order_operations_handoff_local.sh` (migration applied
twice, then `order_operations_handoff_assertions.sql`) and
`supabase/tests/run_order_operations_handoff_race.sh`.
