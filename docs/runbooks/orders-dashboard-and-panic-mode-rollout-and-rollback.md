# The Orders dashboard and PANIC MODE (`20270221000000`): rollout and rollback

This migration is **additive**. It changes no existing table, function, policy
or Order. It adds one permission action, one table, one trigger, five small
functions and the dashboard's single read. The code that reads it degrades to
an explicit error state ("The dashboard could not be loaded") when the read is
missing, never to zeros, so the order below is safe but not forgiving: **apply
the migration first, then deploy.**

## What it installs

| Object | Kind | Undo |
| --- | --- | --- |
| `orders.view_panic_mode` ("View PANIC MODE Orders") | protected Control Center action, `default_allowed = false` | delete its `employee_permission_overrides`, `module_permission_actions` and `permission_actions` rows |
| `order_panic_designations` | table; RLS on; **no grant and no policy** for any client role | export, then `drop table` (it is the audit history) |
| `order_panic_designations_guard()` + trigger | owner-only authority, two-per-IST-month limit, stamped time/month, append-only | dropped with the table |
| `is_orders_panic_owner()`, `can_view_panic_mode()` | helpers, `authenticated` | `drop function` |
| `designate_order_panic_mode(uuid, text)`, `remove_order_panic_mode(uuid, text)` | the only write paths | `revoke execute` closes them; `drop function` removes them |
| `orders_dashboard_summary()` | the dashboard's one read | `drop function` |

## Who is who

* **Nishant** is the account with `employee_code = 'TEST-001'`, resolved through
  the existing `is_permanent_order_approver(uuid)` — never by name and never by
  a uuid literal. He alone may designate or remove PANIC MODE, and always sees it.
* **Nitish** (or anyone else) sees PANIC MODE only after being granted
  `orders.view_panic_mode` in Control Center. `actor_has_permission()` has no
  admin short-circuit, so **an administrator without the grant does not see it**.
  Nothing is seeded for anybody: the migration grants no one.
* Revenue is sent only to an active admin or a holder of `orders.view_all`.

## Rollout

1. **Apply the migration** (`supabase db push`, from the worktree, after the
   usual dry run against a local copy of production history). It is idempotent
   and its last block verifies the objects and that no client role can read the
   table.
2. **Smoke check as Nishant** — the read succeeds and shows the four groups:
   ```sql
   select jsonb_object_keys(public.orders_dashboard_summary());
   ```
   (run with `request.jwt.claims` set to his id; expect `today, viewer, groups,
   gaps, revenue, panic`).
3. **Grant Nitish** `View PANIC MODE Orders` in Control Center → Access → Orders.
   He already sees every order and revenue through his existing grants.
4. **Deploy the code.** Until it is deployed the old dashboard keeps working: it
   reads only tables this migration does not touch.
5. **Check** `/orders` as Nishant (PANIC section with Add controls), as Nitish
   (PANIC section, read-only), and as a salesperson (only their own orders; no
   revenue; no PANIC section).

## Decisions the migration encodes (change one = a new migration)

* PANIC MODE limit: **two designations per IST calendar month; a removal does
  not give the slot back.** Counted by `designated_month`, serialised with an
  advisory lock, enforced by the trigger for every writer.
* An active designation is **never cleared by the calendar.** The dashboard stops
  drawing it once the Order is dispatched or cancelled; the row stays.
* Open Order = not `dispatched` and not `cancelled`; `orders.is_test_data` rows
  are excluded from every group and from revenue.
* "Below 40%": `order_advance_position()`'s own `shortfall > 0` against the
  Order's current (amended) `total_value`; approved reduced-advance exceptions
  are still listed, and said.
* Fabric / finish: the newest `order_approval_events` row per kind, none meaning
  Not Approved; pending when not Fully Approved; flagged when
  `IST today − orders.confirm_date > 15`.
* Revenue: each non-cancelled Order once, by `confirm_date`, at its product value
  (the PI in force's after-discount subtotal while the Order still carries that
  PI's gross; the Order's own figure otherwise).

## Rollback

Forward-fix, as a new migration; never edit this file once applied. To take the
feature away without losing history:

```sql
revoke execute on function public.orders_dashboard_summary() from authenticated;
revoke execute on function public.designate_order_panic_mode(uuid, text) from authenticated;
revoke execute on function public.remove_order_panic_mode(uuid, text) from authenticated;
```

The old dashboard code is independent of all of it, so redeploying the previous
build restores the previous page. Drop the objects only after exporting
`order_panic_designations`.
