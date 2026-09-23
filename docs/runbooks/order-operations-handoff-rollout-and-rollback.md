# The PI-to-operations handoff (`20261229000000`): rollout and rollback

This migration is **additive and forward-only**, but it is not "one trigger".
It adds two tables (and seeds one settings row), two enum values, eight
functions (two of them re-emissions of existing doors:
`set_order_production_alignment()` and `approve_order_pi_revision()`), one
trigger, RLS policies, and the code reads the tables. Undoing it is a
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
| `approve_order_pi_revision()` | **re-emitted** existing service-role door: the `20261124000000 §6` body word for word, plus one SHARE lock on the reviewer row before the Order lock | can **stay** after a rollback: with the table present the lock is a harmless no-op wait. Restore the 20261124 body only if the reviewers table is dropped |

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

The lock order is **order_operations_reviewers → orders → PI rows
(submission, versions) → order_operations_handoffs**. The reviewer settings
row always comes first:

| Path | Takes |
| --- | --- |
| initial approval (`approve_order_submission`) | submission row; its **new** orders row; trigger: reviewers **FOR SHARE** → handoffs |
| revision approval (`approve_order_pi_revision`, re-emitted) | reviewers **FOR SHARE** → orders **FOR UPDATE** → submission → versions; trigger: reviewers (already held) → handoffs |
| decision (`decide_order_operations_handoff`) | reviewers **FOR SHARE** → orders **FOR UPDATE** → handoff |
| alignment door (`set_order_production_alignment`) | reviewers **FOR SHARE** → orders **FOR UPDATE** → *then* checks for a live handoff (and routes to the decision) |
| assignment (`set_order_operations_reviewer`) | reviewers **FOR UPDATE** → handoffs `FOR UPDATE OF h` → orders **FOR KEY SHARE**, taken implicitly by the `order_activity_log` foreign key once per readdressed handoff |

**Why the reviewer row comes first.** The assignment is the only path that
reaches an Order after a handoff. Its history row's foreign-key check needs
`FOR KEY SHARE` on the Order, which conflicts with `FOR UPDATE`. So if any
path held an Order `FOR UPDATE` and then waited on the reviewer row or a
handoff, the two could deadlock. That was the original revision-approval
order, where the reviewer row was taken only in the trigger, after the Order.
Reproduced with two sessions, Postgres detected the deadlock and aborted one
transaction. Every such path now takes the reviewer row first, as SHARE. The
assignment holds that row exclusively, so it never runs while any of them
holds an Order. It waits for them, or they wait for it, before anyone holds
anything that the other needs. SHARE does not serialize approvals or
decisions against each other; the Order lock still does that.

**Rule for new code:** anything that locks an existing Order and can then
touch `order_operations_handoffs` or the reviewer row must first take
`perform 1 from public.order_operations_reviewers where duty = 'pi_handoff'
for share`. The apply-time assertions check this for the three doors above.

`supabase/tests/run_order_operations_handoff_race.sh` proves it with two real
sessions, each under a 20 s statement timeout:

* directions 1–3: a first approval against a reviewer change, in both orders
  and with the reviewer cleared;
* direction 4: a revised PI V2 on an Order whose V1 handoff is unresolved,
  through the real lease → `approve_order_pi_revision()` → release sequence,
  while Control Center changes that Order's reviewer, in both orders.

  - **4a, the approval holds the Order when the change arrives.** A test-only
    pause trigger holds the approval inside its own version write. The change
    waits, then readdresses V2 from A to B.
  - **4b, the change holds the reviewer row when the approval arrives.** The
    approval waits, then records V2 for B directly.

  Both must complete, with V1's handoff superseded, exactly one live handoff,
  B notified once for V2, and the approval and handoff on the history once.
  With the 20261124 body of `approve_order_pi_revision` restored, 4a fails
  with `deadlock detected`.

## Verifying either direction on a disposable stack

`supabase/tests/run_order_operations_handoff_local.sh` (migration applied
twice, then `order_operations_handoff_assertions.sql`) and
`supabase/tests/run_order_operations_handoff_race.sh`.
