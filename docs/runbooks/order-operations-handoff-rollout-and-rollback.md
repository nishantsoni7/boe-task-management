# The PI-to-operations handoff (`20261229000000`): rollout and rollback

This migration is **additive and forward-only**, but it is not "one trigger".
It adds two tables, two enum values, five functions (one of them a re-emission
of `set_order_production_alignment()`), one trigger, two RLS policies, and the
code reads the tables. Undoing it is therefore a **forward-fix**, written as a
new migration, never an edit or removal of this file once it has been applied.

## What the migration installs

| Object | Kind | Undo |
| --- | --- | --- |
| `order_operations_handoffs`, `order_operations_reviewers` | tables + RLS + grants | can stay (harmless when unused) or be dropped by a forward migration |
| `notification_type` values `order_operations_review_requested`, `_decided` | enum values | **cannot be dropped** from a Postgres enum; harmless if never written |
| `order_pi_versions_record_operations_handoff()` + trigger | AFTER trigger on `order_pi_versions` | `drop trigger` stops all recording and alignment resets |
| `decide_order_operations_handoff()`, `set_order_operations_reviewer()` | RPCs (authenticated) | `revoke execute` closes the doors; `drop function` removes them |
| `order_operations_handoff_set_alignment()` | internal function | `drop function` |
| `set_order_production_alignment()` | **re-emitted** existing RPC | must be **restored** to its `20261119000000 §8` body by a forward migration |

## Safe sequence: migration first, then code

1. **Apply the migration** (`supabase db push`, migrations enabled in
   `config.toml`). It is safe to apply twice (verified on a disposable stack).
   Nothing running changes: no Order column moves at apply time, no row is
   backfilled, and the trigger fires only on the **next** PI approval.
2. **Deploy the code.** Until it is deployed, the only visible change is that
   `set_order_production_alignment()` on an Order that already carries a
   handoff routes to the reviewer — and no Order carries one until a PI is
   approved after step 1. Deploying the code first instead would break the
   Order page's handoff read (the table is absent), so keep the order.
3. **Assign the reviewer** in Control Center → Operations Handoff **before the
   next PI approval**. A PI approved before that is recorded as an unassigned
   handoff, shown on the Order, the dashboard and the Action Queue; assigning
   someone then readdresses every waiting or flagged handoff to them.
4. Tell the approver and the reviewer what changed (the manual checklist in
   the PR): on an Order with a handoff there is no header "Align for
   Production" button; **Accept for production** on the Operations review card
   is the one decision, and it aligns the Order.

## Rollback (forward-fix), if the handoff must be switched off

Write a new migration `2026XXXXXXXXXX_order_operations_handoff_disable.sql`
containing, in this order:

```sql
-- 1. Stop recording, and stop resetting alignment on new versions.
drop trigger if exists order_pi_versions_record_operations_handoff on public.order_pi_versions;

-- 2. Close the doors. The rows stay readable for audit.
revoke execute on function public.decide_order_operations_handoff(uuid, text, text) from authenticated;
revoke execute on function public.set_order_operations_reviewer(uuid) from authenticated;

-- 3. Restore the alignment door to its 20261119000000 §8 body (copy it
--    verbatim from that file: orders.align_production, note ≤ 500, cancelled
--    refused, idempotent, production_alignment_changed event). Its grants are
--    unchanged. After this, every Order — handoff or not — aligns the old way.
create or replace function public.set_order_production_alignment(p_order_id uuid, p_aligned boolean, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
  -- …the 20261119000000 §8 body, unchanged…
$$;
```

Then deploy code that no longer renders the Operations review card, the
dashboard card, the queue rows and the Control Center tab (revert the PR's
`src` changes). Order of operations for the rollback is the **reverse** of the
rollout: code first (so nothing reads the doors you are about to close), then
the migration.

What the rollback does **not** do, on purpose:

* It does not delete `order_operations_handoffs` rows. They are the record of
  who accepted what; keep them.
* It does not touch `orders.production_alignment`. An Order aligned by an
  acceptance stays aligned; one reset by a later version stays not aligned
  until somebody aligns it the old way. Both states are true statements about
  what happened, and both are on the Order's history.
* It does not remove the enum values (Postgres cannot), and need not.

## Verifying either direction on a disposable stack

`supabase/tests/run_order_operations_handoff_local.sh` applies the migration
twice and runs `order_operations_handoff_assertions.sql` through the real
`approve_order_submission()` door. For a rollback migration, run it once on top
and assert that `set_order_production_alignment()` no longer routes to the
handoff (`pg_get_functiondef` must not contain
`decide_order_operations_handoff(`).
