# Finance / Orders / Quotation — signed-in acceptance pass

Last updated: 2 August 2026
Covers: `20260804000000_order_amendments.sql`,
`20260805000000_financial_amount_invariants.sql`, and the Order amendment UI.

---

## Status of this document

**Not yet executed.** This pass was carried out with repository access only —
no authenticated browser session, no database connection, and no production-role
accounts were available. Every scenario below is written to be run by a person
who has those, and **none of them has been performed**. Nothing in this file may
be reported as passing until an actual result is written into its row.

What *has* been verified, and how:

| Check | Command | Result |
| --- | --- | --- |
| TypeScript | `npx tsc --noEmit` | Clean, no output |
| ESLint | `npx eslint src/lib/orders src/components/orders "src/app/orders/[id]" src/app/admin/control-center/action-queue` | Clean, no output |
| Unit tests (new) | `npx tsx --test src/lib/orders/amendments.test.ts` | 44 pass, 0 fail |
| Unit tests (finance, regression) | `npx tsx --test src/app/finance/*.test.ts` | see §5 |

---

## 1. Preconditions

1. **Apply the migrations first.** The UI calls `amend_order`,
   `cancel_order`, `order_linked_payment_total`,
   `approve_order_change_request`, `reject_order_change_request` and reads
   `order_change_requests`. **None of these exist until the migrations are
   applied**, and every amendment control will fail until they are.

   ```bash
   npx supabase db push --dry-run
   ```

   Review the plan, then push. `20260804000000` before `20260805000000`.

2. **Run the two assertion scripts** (both end in `ROLLBACK`; edit the UUIDs at
   the top of each first):

   ```bash
   psql "$DATABASE_URL" -f supabase/tests/order_amendment_assertions.sql
   ```

   ```bash
   psql "$DATABASE_URL" -f supabase/tests/financial_amount_invariants_assertions.sql
   ```

   Each prints `ALL ASSERTIONS PASSED` on success.

3. **Act on Part 1 of the amount script** before running any
   `VALIDATE CONSTRAINT` statement. It surveys existing rows and lists anything
   that would make validation fail. The `VALIDATE` statements are at the foot of
   `20260805000000`, commented out deliberately.

## 2. Test identities

| Role | Requirement |
| --- | --- |
| Admin | `users.role = 'admin'`, `is_active` |
| Sales Executive A | non-admin, `is_active`, owns the fixture Orders |
| Sales Executive B | a different non-admin — used only to prove they see nothing |
| Operations | `users.team = 'operations'` — used for the guard test in 3.1 |

Sales Manager is `role = 'manager'`. Note the open question in
`FINANCE_ORDER_WORKFLOW.md` §4.6: a manager currently has **no** team-wide
visibility of Orders, only their own. Scenario 4.3 records what actually
happens rather than asserting a rule that has not been decided.

## 3. Test data

Prefix every fixture with `QA-FIN-20260802-`.

Minimum set for **this** pass (a subset of the full matrix in the brief — the
refund, dispatch and fabric fixtures are not listed because those workflows are
deferred and there is nothing to exercise):

* 2 Confirmed Orders owned by Sales Executive A, status `running`
* 1 Confirmed Order with an approved linked payment on it
* 1 Confirmed Order already `dispatched`
* 1 Confirmed Order already `cancelled`

**Disposition:** Confirmed Orders are permanent and cannot be deleted
(`orders_prevent_delete`). Fixtures created during this pass must be removed
through **Test Data Cleanup** (`/admin/control-center/test-data-cleanup`), which
is the only sanctioned path, or left cancelled with a `QA-` reason. Do **not**
attempt to delete them any other way — the database will refuse, correctly.

---

## 4. Scenarios

Fill in *Actual* and *Pass/Fail* when run.

### 4.1 The guard (D1) — the fix that matters most

| # | Steps | Expected | Actual | P/F |
| --- | --- | --- | --- | --- |
| 1.1 | As Operations, open a Confirmed Order and change status `running → on_hold` | Succeeds. The guard covers commercial columns only. | | |
| 1.2 | As Operations, `PATCH /rest/v1/orders?id=eq.<id>` with `{"total_value": 999999}` (bypassing the UI) | **Refused**, `ORDER_AMENDMENT_REQUIRED`, 42501 | | |
| 1.3 | Same PATCH as Admin | **Refused** — an admin's raw PATCH is refused too; that is the point | | |
| 1.4 | Same PATCH with `{"created_by": "<other uuid>"}` | **Refused**, `ORDER_FIELD_FROZEN` | | |

1.2–1.4 are the only scenarios here that need a REST client rather than the UI,
and they are the ones proving the fix holds when the UI is bypassed.

### 4.2 Amend Order — admin

| # | Steps | Expected | Actual | P/F |
| --- | --- | --- | --- | --- |
| 2.1 | Admin opens a `running` Order → **Amend Order** | Modal opens, all seven fields pre-filled with current values | | |
| 2.2 | Click **Amend Order** without changing anything | Button disabled; "Change at least one value before submitting." | | |
| 2.3 | Change Total Order Value, leave Reason empty | Button disabled; "Say why this order is being amended." | | |
| 2.4 | Enter `-5` as the value | Inline error on that field: "An amount cannot be negative." | | |
| 2.5 | Enter `2,75,000` and a reason, submit | Saves; summary strip shows ₹2,75,000; Activity shows **Order amended** with `Total Order Value: ₹2,50,000 → ₹2,75,000` and the reason | | |
| 2.6 | Clear the Due Date box entirely and amend something else | Due date is **unchanged** — an emptied box means "leave alone", never "blank it" | | |
| 2.7 | Click outside the modal while it holds typed values | Modal does **not** close and nothing is lost (Form Modal Dismissal Rule) | | |
| 2.8 | Press Escape | Modal closes | | |
| 2.9 | Amend a `dispatched` Order | **Amend Order** button is not shown | | |
| 2.10 | Payment Summary after 2.5 | Received unchanged; Pending and Completion recalculated from the new value | | |

### 4.3 Request a Change — Sales Executive

| # | Steps | Expected | Actual | P/F |
| --- | --- | --- | --- | --- |
| 3.1 | Sales A opens their Order | Sees **Request a Change** and **Request Cancellation**, not **Amend Order** | | |
| 3.2 | Submit a change request with a reason | Saves; Change Requests card shows it as Pending; **the Order's values are unchanged** | | |
| 3.3 | Try to submit a second change request | Button reads **Change Requested** and is disabled | | |
| 3.4 | Sales B opens the same Order by URL | Order not visible at all (`orders_sales_select`) | | |
| 3.5 | Admin opens the Order | Sees the pending request with Sales A's name and a **Review** button | | |
| 3.6 | Admin → Review → **Approve & Apply** | Values change; request marked Approved; Activity shows an **Order amended** entry sourced `change_request` | | |
| 3.7 | Sales A reloads | Sees the request as Approved with the review note | | |
| 3.8 | Admin approves the same request again (second tab) | **Refused** — "already been reviewed by someone else" | | |
| 3.9 | Admin rejects a different request | Request marked Rejected; **Order untouched**; no Activity entry | | |
| 3.10 | Sales Manager opens an Order they neither raised nor are assigned to | Record what happens — see §4.6 open question | | |

### 4.4 Cancellation

| # | Steps | Expected | Actual | P/F |
| --- | --- | --- | --- | --- |
| 4.1 | Admin → Change Status → Cancelled, on an Order with an approved payment | Cancel dialog opens and states **"₹X has been received against this order"** with the not-a-refund wording | | |
| 4.2 | Submit with an empty reason | Button disabled | | |
| 4.3 | Submit with a reason | Order becomes Cancelled; Activity shows the transition, the reason, and "₹X received at cancellation" | | |
| 4.4 | Check the payment afterwards | Still `approved_linked`, still linked, amount unchanged — cancellation is not a refund | | |
| 4.5 | Cancel again | **Refused** — "already been cancelled" | | |
| 4.6 | Cancel a `dispatched` Order | Cancelled is not offered; if forced via RPC, `ORDER_DISPATCHED` | | |
| 4.7 | Sales A → **Request Cancellation** | Dialog shows the same received figure (read through the definer function, so it is the true total) and files a request; **Order stays active** | | |

### 4.5 Action Queue

| # | Steps | Expected | Actual | P/F |
| --- | --- | --- | --- | --- |
| 5.1 | Admin opens `/admin/control-center/action-queue` with a pending change request | Row appears, module **Orders**, action "Review change request" | | |
| 5.2 | A pending cancellation request | Action reads "Review cancellation request"; Amount is a dash, not ₹0 | | |
| 5.3 | Click the row | Navigates to the Order detail page, where the Review button is | | |
| 5.4 | Existing Finance and Order Request rows | Unchanged — no regression from the added query | | |

### 4.6 Amount invariants

| # | Steps | Expected | Actual | P/F |
| --- | --- | --- | --- | --- |
| 6.1 | Submit a Payment Request with amount `0` | Refused (client already refuses; the DB now does too) | | |
| 6.2 | `POST /rest/v1/finance_payment_requests` with `amount: -50000` | **Refused**, `finance_payment_requests_amount_positive` | | |
| 6.3 | Existing payment flows | Unchanged — a normal positive payment still submits, approves and links | | |

### 4.7 Mobile pass (375 px width)

Run 2.1–2.5, 3.1–3.2 and 4.1–4.3 at mobile width.

| # | Expected | Actual | P/F |
| --- | --- | --- | --- |
| 7.1 | Amend modal fits, all seven fields reachable, no horizontal page scroll | | |
| 7.2 | Header action buttons wrap rather than overflow | | |
| 7.3 | Change Requests card wraps; Review button stays reachable | | |
| 7.4 | Cancel dialog's money notice is fully readable | | |

---

## 5. Regression suite

Run before committing anything further:

```bash
npx tsx --test src/lib/orders/amendments.test.ts src/app/finance/paymentTargets.test.ts src/app/finance/paymentRouting.test.ts src/app/finance/paymentDestinations.test.ts src/app/orders/requests/components/shared.test.ts
```

Record the actual counts. Do not report "all tests pass" without them.

---

## 6. Explicitly not covered by this pass

Nothing below has a scenario here, because the workflow does not exist yet.
See `docs/Module Docs/FINANCE_ORDER_WORKFLOW.md` §4 for each one's specification
and the reason it was deferred.

* Refunds, voids, reversals, customer credit (§4.1)
* Net received / balance due / overpayment display (§4.1)
* Dispatch readiness and dispatch validation (§4.2)
* Fabric and finish (§4.3)
* Post-approval correction requests for **payments** (§4.4)
* Missing-document double confirmation (§4.5)
* Quotation → Order Request conversion — **no such path exists** (D5)
