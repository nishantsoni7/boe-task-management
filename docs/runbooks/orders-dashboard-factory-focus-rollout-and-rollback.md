# The Orders dashboard, Factory Focus and Order visibility (`20270221000000`): rollout and rollback

This migration is **additive except three deliberate re-emissions**. It adds one
table for Factory Focus, two for visibility scopes, one guard trigger, one extra
`SELECT` policy on `public.orders`, several small functions and the dashboard's
single read. It **re-emits** `can_view_order_as_actor()`,
`can_read_payment_as_participant()` and `order_linked_payment_total()`, and
**replaces** the `finance_payment_allocations` order-participant policy, so that a
visibility scope reveals Orders and never a payment. Everybody's default scope is
"own", so **after this migration no one sees anything they did not see before**
until the owner changes a setting.

The code degrades to an explicit error state ("The dashboard could not be
loaded") when the read is missing, never to zeros. **Apply the migration first,
then deploy.**

## Blocker to settle before rollout: the test-data phase

Read-only check of production on 2026-09-29 (`supabase db query --linked`, plain
`select`s; the CLI mints its usual temporary login role):

| | |
| --- | --- |
| `test_data_cleanup_settings` | `enabled = true`, `permanently_disabled = false`, since 2026-07-21 |
| `orders` / `payments` | 0 / 0 (`is_test_data` orders: 0) |
| `order_submissions` | 1 |
| next Order number | 524 |

While `enabled` is true, **every new order is stamped `is_test_data = true`**
(`stamp_test_data_flag`, immutable afterwards). The dashboard — like the rest of
the app's cleanup tooling — treats those as test records and **excludes them from
every list, from Factory Focus and from revenue**. So if the first real orders are
created before the phase is switched off, the dashboard will look empty and
revenue will read zero, and the flags cannot be flipped later. The go-live steps
must therefore **disable the test-data phase (permanently) before the first real
Order**. If the business would rather the dashboard show flagged orders, that is a
one-line change in the read (drop `is_test_data` from four `where` clauses) and
needs Nishant's decision; nothing here assumes it.

## What it installs

| Object | Kind | Undo |
| --- | --- | --- |
| `order_factory_focus_selections` | table; RLS on; **no grant, no policy** | export, then `drop table` (audit history) |
| `order_factory_focus_guard()` + trigger | owner-only, two NEW per IST month, stamped month/salesperson, reason required to remove, append-only | dropped with the table |
| `select_order_for_factory_focus(uuid, text)`, `remove_order_factory_focus(uuid, text)` | the only write paths (owner) | `revoke execute`, then `drop function` |
| `order_visibility_scopes`, `order_visibility_scope_members` | tables; RLS on; no grant | `drop table` (everyone returns to "own") |
| `set_order_visibility_scope()`, `list_order_visibility_scopes()` | owner-only RPCs | `revoke execute` / `drop function` |
| `sales_scope_allows_order()` + policy `orders_sales_scope_select` | the scope, applied to the Orders table | `drop policy`, then the function |
| `can_view_order_unscoped()` | the previous rule, kept for Finance | keep |
| `can_view_order_as_actor()` | **re-emitted**: unscoped OR the scope branch | re-emit the 20261006000000 body |
| `can_read_payment_as_participant()`, `order_linked_payment_total()`, policy `finance_payment_allocations_order_participant_select` | **re-emitted / replaced** to ask the unscoped rule | restore the 20261006000000 bodies |
| `is_orders_owner()` | helper | `drop function` |
| `orders_dashboard_summary()` | the dashboard's one read | `drop function` |

No permission action is added: **Factory Focus needs no Control Center grant.**
Everybody with Orders module entry sees which orders are selected; what a card
shows follows Order visibility.

## Who is who

* **Nishant** is the account with `employee_code = 'TEST-001'`, via the existing
  `is_permanent_order_approver(uuid)` — never by name or uuid. He alone selects and
  removes Factory Focus and sets visibility scopes.
* A **sales candidate** is `is_eligible_order_assignee()`: the sales team, or a
  holder of `orders.can_be_order_assignee`. An Order belongs to a candidate through
  `assigned_to` (the salesperson) or `requested_by`.
* Revenue goes only to an active admin or a holder of `orders.view_all`. A scope
  never counts.

## Rollout

1. Settle the **test-data phase** above.
2. **Apply the migration** (`supabase db push` from the worktree, after the usual
   dry run against a local copy of production history). Its last block verifies the
   objects, that no client role can read the new tables, and that the Finance policy
   moved off the scope-aware rule.
3. **Smoke check as Nishant**: `select jsonb_object_keys(public.orders_dashboard_summary());`
   with his `request.jwt.claims` → `today, now, viewer, alignment_reviewer, groups,
   gaps, revenue, factory_focus`.
4. **Deploy the code.** Until then the old dashboard keeps working: it reads only
   tables this migration does not change.
5. In Control Center → **Order Visibility**, set each sales candidate's scope
   (default: their own orders). Check one candidate: their direct API reads, the
   dashboard and the Finance lists all stay inside the choice, and no colleague's
   payment appears.
6. Check `/orders` as Nishant (Factory Focus with Select/Remove), as Nitish
   (read-only), as a salesperson (their own scope; an out-of-scope Factory Focus card
   shows only its number, salesperson and month) and as a purchase-team user.

## Decisions encoded (changing one = a new migration)

* **Factory Focus.** Two NEW selections per IST calendar month, counted by
  `selected_month`, serialised by an advisory lock; a removal does **not** refund
  the month's selection. Active selections carry into later months, so more than two
  can be visible. Removal is manual and needs a reason (≤ 300 characters), which the
  Order's salesperson sees for 30 days. Nothing — not the calendar, a dispatch or a
  cancellation — hides a selection. An Order with no salesperson cannot be selected
  (there is nobody to recognise); a closed Order cannot be newly selected.
* **Not aligned.** `production_alignment <> 'aligned'`, said with whose court it is
  in and since when: awaiting the reviewer (since the handoff), no reviewer assigned
  (an administrator), flagged for clarification (the approver; since it was
  flagged), held for advance (the money; since the hold), or an older order with no
  handoff (since the Order was created). Only the first is "waiting on" the
  reviewer.
* **Advance.** `order_advance_position()`'s `shortfall > 0` against the current
  amended value; an approved exception is still listed and said.
* **Fabric / finish.** Each item on its own: the newest `order_approval_events` row;
  a recorded status other than Fully Approved is pending; **no row at all is "not
  recorded"**, a separate list. Flagged when `IST today − orders.confirm_date > 15`.
* **No overdue list** in this phase. Planned dispatch date is the date to use if one
  is added later; `orders.due_date` and every date and filter elsewhere are untouched.
* **Revenue.** Each non-cancelled, non-test Order once, by `confirm_date`, at its
  product value (the PI in force's after-discount subtotal while the Order still
  carries that PI's gross). Periods, IST: current month to today; the **six
  completed months before this one**; 1 January to today.
* **Scopes** widen Orders only. The advance position and the alignment list are
  Orders facts and follow them. No allocation, payment, payment total or revenue is
  reachable through a scope.

## Rollback

Forward-fix, as a new migration; never edit this file once applied. To switch the
features off without losing history:

```sql
-- everyone back to "own"
delete from public.order_visibility_scope_members;
delete from public.order_visibility_scopes;
-- close the doors
revoke execute on function public.orders_dashboard_summary() from authenticated;
revoke execute on function public.select_order_for_factory_focus(uuid, text) from authenticated;
revoke execute on function public.remove_order_factory_focus(uuid, text) from authenticated;
revoke execute on function public.set_order_visibility_scope(uuid, text, uuid[]) from authenticated;
revoke execute on function public.list_order_visibility_scopes() from authenticated;
```

The previous dashboard build is independent of all of it, so redeploying it
restores the previous page. The three re-emitted functions and the allocation policy
are safe to leave: with no scope rows they behave exactly as before. Drop the
objects only after exporting `order_factory_focus_selections`.
