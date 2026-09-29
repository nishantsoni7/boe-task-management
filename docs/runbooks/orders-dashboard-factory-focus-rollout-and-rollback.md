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
loaded") when the read is missing, never to zeros.

**Order of release — fixed:**

1. **Apply the reviewed migration `20270221000000` BEFORE the redesigned dashboard reaches production**
   (before the code deploys). The new dashboard calls `orders_dashboard_summary()`; deployed first, it
   shows the error state until the migration lands. The migration also starts fabric/finish tracking at
   the moment it is applied, so it must precede the first real order.
2. Deploy the code.
3. **Turn the test-data phase off BEFORE the first real order** (it may be done before or after 1–2, but
   never after a real order exists — the flag cannot be flipped later).

This review changes no production setting and applies no migration.

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
| `orders_dashboard_settings` | one row, no grant: `fabric_finish_tracking_from` (defaults to the moment the migration is applied) | `drop table` |
| `order_factory_focus_history()` + trigger | writes `factory_focus_selected` / `factory_focus_removed` (with the reason) to `order_activity_log`, for every writer | `drop trigger`; existing history rows stay |
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

1. **Apply the migration** — first, before the code deploys (see the order of release above) (`supabase db push` from the worktree, after the usual
   dry run against a local copy of production history). Its last block verifies the
   objects, that no client role can read the new tables, and that the Finance policy
   moved off the scope-aware rule.
2. **Smoke check as Nishant**: `select jsonb_object_keys(public.orders_dashboard_summary());`
   with his `request.jwt.claims` → `today, now, viewer, alignment_reviewer, groups,
   gaps, revenue, factory_focus`.
3. **Deploy the code**, only after the migration is applied and smoke-checked. Until then the old dashboard
   keeps working: it reads only tables this migration does not change.
4. **Turn the test-data phase off** (permanently) — **before the first real order**; see the blocker above.
   Do not create a real order until this is done.
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
  can be visible. Removal is manual and needs a reason (≤ 300 characters). The reason is
  written to the Order's **permanent activity log** (`factory_focus_removed`, with who and when) and shows in the
  Order's history to whoever may read that history — the salesperson and requester, operations, admins and
  `orders.view_all`. The dashboard also shows the reason to the salesperson for 30 days, as a convenience only. Nothing — not the calendar, a dispatch or a
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
* **Fabric / finish.** Each item on its own, so one approved item never hides the other. The newest `order_approval_events` row decides; a status other than Fully Approved is pending. **No event at all:** for an Order created on or after `orders_dashboard_settings.fabric_finish_tracking_from` the approval is required and has not been given, so it is **pending ("no approval recorded")**; for an Order created before that moment the missing record is ambiguous history and sits in a separate "older orders" list. Flagged when `IST today − orders.confirm_date > 15` (day 15 is not flagged, day 16 is). The tracking start defaults to the moment the migration is applied — so **apply it before the first real Order**, or every Order created before it is treated as history.
* **No overdue list** in this phase. Planned dispatch date is the date to use if one
  is added later; `orders.due_date` and every date and filter elsewhere are untouched.
* **Revenue.** Each non-cancelled, non-test Order once, by `confirm_date`, at its
  product value (the PI in force's after-discount subtotal while the Order still
  carries that PI's gross). Periods, IST: current month to today; the **six
  completed months before this one**; 1 January to today.
* **Scopes** widen Orders only. The advance position and the alignment list are
  Orders facts and follow them. No allocation, payment, payment total or revenue is
  reachable through a scope.

## Audit: what broadening Orders visibility can reach

The scope is one extra `SELECT` policy on `orders` and one branch in `can_read_order_detail()`. Audited on
2026-09-29 against a fully migrated database: every policy, function and view that reads Orders, and every
route in `src/` that reads `orders` under the caller's session.

**Follows the scope — by design, the order detail** (each already open to `orders.view_all`):
`order_approval_events`, `order_operations_handoffs`, `order_product_codes`, `order_pi_versions`,
`order_document_versions` / submissions / files, the confirmed order's PI (`order_submissions`, items, images,
activity) through `can_view_order_submission_via_order`, and the storage buckets `order-files` and
`order-approval-evidence`. The three PI detail RPCs follow it too (via `can_read_order_detail()`); `order_advance_readiness` does not. The middleman
commission is **not** among them: it has its own table and function (submitter, assigned reviewer, admin,
`orders.view_pi_commission`) that no Orders visibility reaches.

**Does not follow the scope** (explicit own / operations / admin / `view_all` rules, or pinned to the unscoped
rule): `order_activity_log` (the order's history — so the removal reason is readable by the salesperson and
requester, and *not* by a scoped colleague), `finance_payment_allocations`' order policy,
`can_read_payment_as_participant()`, `order_linked_payment_total()`, every other Finance policy, company revenue,
`order_submission_middleman_commissions`, `order_change_requests`, `order_pi_edit_drafts`, and the meeting-order
tables (which key on meetings, not Orders). The two Finance views (`finance_received_payments`,
`finance_payment_destinations`) are `security_invoker` and only LEFT JOIN `orders` for the order number of a
payment the caller can already see.

**Closed by this migration — a scope reveals Order detail, never money or authority.**

* `can_view_order_as_actor()` is the rule as it was (unscoped). `order_advance_readiness()`, the operations
  decisions and the payment helpers therefore ignore a scope: a scope-only viewer gets no payment-derived amount,
  percentage or shortfall from the order detail page or a direct RPC. The owner, the Order's own people and
  Finance users with the pre-scope right keep exactly what they had.
* `can_read_order_detail()` (unscoped OR scope) is used only by the read-only surfaces: the dashboard and the
  three PI detail RPCs (`order_pi_version_detail`, `…pdf_detail`, `order_pi_revision_differences`). PI PDF reading
  stays available wherever order-detail reading is.
* Finance: the picker calls `finance_order_search()`, the Finance screens' order-number lookups call
  `finance_order_lookup()`, and both Finance views join Orders behind `can_view_order_unscoped()`. A user with a
  scope and `finance.allocate` gets the same Orders and values as before the scope existed.
* Authority: `request_order_document_generation()` and the `order_document_versions` request/retry policies ask
  the unscoped rule; `/api/orders/[id]/notify` refuses (404) before reading when the caller lacks the unscoped
  right. `approve_order` was never scope-aware (it asks `orders.approve_order` and the unscoped view rule).

Function and view bodies are patched from their live definitions with asserts, and the patches are idempotent.
Proven at the database boundary by section 8 of `supabase/tests/orders_dashboard_assertions.sql` (owner,
scope-only salesperson, scope + Finance, approver, admin; direct calls, not hidden buttons).

**Matrix** — every cell is a direct RPC / table call by that persona on a colleague's order (section 8 of
the SQL suite), not a hidden button. The personas are distinct: a **plain sales owner** is the order's own
salesperson with *no* `approve_order` and no scope; **Nishant** is the owner account (TEST-001), who holds
`approve_order`. An administrator *role* is not the approval grant.

| Persona | Read the order | Payment-derived figures | Finance picker / lookup | Approve (PI, exception, cancel) | Generate / retry document | Notify gate | Factory Focus / scopes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Plain sales owner (own order, no grant) | yes | yes (own order, as before) | yes (as before) | **denied** (every RPC; API gate false) | **denied** | open | denied |
| Scope-only salesperson | yes, incl. PI PDF | **denied** | none | **denied** | **denied** | closed | denied |
| Scoped + `finance.allocate` | yes | denied | **none** (same as before the scope) | **denied** | **denied** | closed | denied |
| Approver (`approve_order` + scope, not the order's owner) | yes (scope) | denied | none | PI approve / reject pass the permission check; exception and cancel denied | passes the permission check, refused for visibility | closed | denied |
| Administrator (no `approve_order` grant) | yes | yes | yes | **denied** — the role is not the grant | passes permission | open | denied |
| Nishant (TEST-001) | yes | yes | yes | passes | passes | open | select / remove / scopes |

`approve_order_pi_revision` is callable by no signed-in user directly (service role only); the API route asks
`user_holds_permission(approve_order)` first. The one thing a plain owner may record on their own order is a
fabric/finish approval event — an intended feature (`can_record_order_approval`), not an order approval.

**Still true:** `/api/orders/[id]/pi-versions/[versionId]/pdf` reads with the caller's client, so a scoped viewer
opens a scoped Order's PI PDF — intended, it is order detail.

Nothing in the audit reaches another module's data: samples, showroom, tasks, performance, assets, notifications
and customer reviews never read `orders` under a user session.

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
