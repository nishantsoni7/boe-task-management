# Finance, Quotation, Order Request & Confirmed Order — Workflow and Current State

Last updated: 2 August 2026

This document is two things:

1. **A current-state map** of every surface in the Quotation → Order Request →
   Confirmed Order → Payment chain, verified against the code and the migration
   files rather than against comments.
2. **A per-requirement status matrix** for the end-to-end testing and hardening
   pass, so what was implemented, what already existed, and what is deferred are
   all separable.

> **Scope honesty.** This pass was carried out with repository access only.
> No authenticated browser session, no production or staging database
> connection, and no production-role accounts were available. **No test records
> were created, and no browser acceptance run was performed.** Everything marked
> *Implemented* below is verified by TypeScript, ESLint and the unit test suite;
> everything requiring a live database is marked *Blocked — no DB access* and
> has an executable SQL assertion script prepared for it. See
> `docs/testing/finance-orders-quotation-acceptance.md`.

---

## 1. Current-state map

### 1.1 Pages

| Route | File | Purpose |
| --- | --- | --- |
| `/finance` | `src/app/finance/page.tsx` | Payment Requests (pre-approval stage only) |
| `/finance/received` | `src/app/finance/received/ReceivedPaymentsView.tsx` | Received Payments (both approved statuses) |
| `/finance/received/linked` · `/unlinked` | `src/app/finance/received/*/page.tsx` | Routed views of the same ledger |
| `/orders` | `src/app/orders/page.tsx` | Orders dashboard |
| `/orders/all` | `src/app/orders/all/page.tsx` | Confirmed Order list |
| `/orders/[id]` | `src/app/orders/[id]/page.tsx` | Confirmed Order detail |
| `/orders/requests` | `src/app/orders/requests/page.tsx` | Order Request list + create |
| `/orders/requests/[id]` | `src/app/orders/requests/[id]/page.tsx` | Order Request detail + convert |
| `/tasks/quotation-requests` | `src/app/tasks/quotation-requests/page.tsx` | Quotation Requests |
| `/admin/control-center/action-queue` | `.../action-queue/page.tsx` | Admin pending-decision queue |

### 1.2 Tables

| Table | Created by | Notes |
| --- | --- | --- |
| `orders` | `20260655` | Confirmed Orders. Permanent — no DELETE policy, `orders_prevent_delete` trigger. |
| `order_activity_log` | `20260656` | Append-only. No DELETE policy. |
| `order_requests` | `20260680000000` | Pre-order. `request_number` immutable by trigger. |
| `order_request_activity` | `20260680000000` | Append-only, written only by a definer trigger. |
| `order_request_attachments` | `20260711000000` | Private bucket, Main PI mandatory. |
| `finance_payment_requests` | `20260628000200` | **All five payment statuses live in this one table.** There is no separate received-payments table. |
| `finance_payment_request_activity_log` | `20260674` | Append-only. |
| `payment_proof_attachments` | `20260672` | |
| `order_change_requests` | `20260816000000` | Proposed amendments and cancellations. |
| `finance_payment_allocations` | `20260918000000` | **How much of one payment is claimed by one PI submission or one Order.** A CHILD of `finance_payment_requests`, not a second ledger. Reversed, never deleted. |
| `tasks` (`task_type='quotation_request'`) | `20260652` | **Quotation Requests are a task type, not a module.** |

### 1.3 Key RPCs

`convert_order_request_to_order`, `finalize_order_request`, `edit_order_request`,
`reject_order_request`, `reapply_order_request`, `request_order_request_clarification`,
`respond_to_clarification`, `admin_delete_order_request`,
`approve_finance_payment_request`, `link_finance_payment_to_order`,
`link_finance_payment_to_order_request`, `unlink_finance_payment_from_order`,
`unlink_finance_payment_from_order_request`, `set_next_confirmed_order_number`,
`get_confirmed_order_number_cycle`, `execute_test_data_cleanup`.

**Added by the amendment pass:** `amend_order`, `cancel_order`,
`approve_order_change_request`, `reject_order_change_request`,
`order_linked_payment_total`, plus the internal `apply_order_amendment`,
`cancel_order_with_audit`, `assert_order_amender`, `in_order_amendment`.

**Added by Payment Phase 1 (`20260918000000`):** `allocate_payment_to_target`,
`reverse_payment_allocation`. No existing RPC signature changed.

**Added by Payment Phase 2 (`20260919000000`):** `record_pi_submission_payment`,
`pi_submission_payment_summary`, `can_read_payment_as_participant`, and
`allocate_payment_to_target_internal` — the shared implementation behind
`allocate_payment_to_target`, whose signature, argument names, return shape and
ACL are unchanged.

### 1.4 Statuses

* **`orders.status`** — `running`, `on_hold`, `ready_for_dispatch`, `dispatched`,
  `cancelled`. (`requested` was retired in `20260702000000`; conversion *is* the
  approval, so an Order is born at `running`.)
* **`order_requests.status`** — `submitted`, `needs_clarification`, `rejected`,
  `converted`.
* **`finance_payment_requests.status`** — `pending_approval`,
  `needs_clarification`, `rejected`, `approved_unlinked`, `approved_linked`.
  **Unchanged by Payment Phase 1.** `pending_approval` *is* "Awaiting
  Verification"; that is a label the UI will apply later, not a sixth value. A
  new status would break the exhaustive partition `paymentRouting.ts` relies on
  (`REQUEST_STAGE_STATUSES` / `CONFIRMED_PAYMENT_STATUSES`) and five deployed
  CHECK constraints.
* **`finance_payment_allocations.status`** — `active`, `reversed`. Terminal in
  one direction: a reversed allocation can never be made active again.

---

## 2. Confirmed defects found

### D1 — Operations could rewrite any Order field *(Priority A · fixed)*

`orders_operations_update` (`20260655`) grants `UPDATE` on `public.orders` to
every operations-team member **with no column restriction**. Its own comment
claims "update status/notes"; the policy permits rewriting `total_value`,
`client_name`, `requested_by`, `assigned_to` — anything on the row, silently and
with no audit entry.

**Fixed** by `orders_guard_amendable_columns` (`20260816000000` §1), which
splits the columns into frozen / commercial / operational tiers and refuses a
commercial change outside an amendment. Because it is a trigger, it holds for
the **service role and direct SQL** too, not only for PostgREST.

### D2 — An Order's commercial terms were immutable *(Priority C · fixed)*

The only `orders` mutation anywhere in the application was
`update({ status })`. There was **no path at all** — for anyone, admin
included — to correct an order value, client name, confirm/due date or lead
source after conversion. The only remedy was direct SQL against production,
which leaves no actor, no reason and no history.

**Fixed** by `amend_order()` and the `order_change_requests` proposal flow.

### D3 — No amount was constrained in the database *(Priority A · fixed)*

`finance_payment_requests.amount` is an unconstrained `numeric not null`, and
all four order-value columns are unconstrained `numeric(12,2)`. The only thing
preventing a negative or zero receipt was `isValidAmount()` in
`src/lib/currency.ts` — **a client-side function**. Anything reaching PostgREST
without that form (a service-role route, a crafted request, an import script,
psql) could write `amount = -50000`, and every derived figure absorbs it
silently: the Order detail Received/Pending/Completion band, the advance on an
Order Request, and the conversion rule's "at least one approved payment" count.

**Fixed** by five `CHECK` constraints (`20260817000000`), added `NOT VALID` so
the deployment cannot fail on a legacy row, with a survey script to run before
validating.

### D4 — Cancelling an Order said nothing about the money *(Priority C · fixed)*

Cancellation was a plain `update({ status: 'cancelled' })` behind a yes/no
dialog. It recorded **no reason**, and — the operationally dangerous part —
never told the person clicking it that money had been received against the
order. Linked payments stayed `approved_linked`, the Payment Summary kept
reporting "Received ₹X", and nothing anywhere recorded that a settlement was
outstanding.

**Fixed** by `cancel_order()` / `cancel_order_with_audit()`, which require a
reason and write `received_at_cancellation` into the activity log **even when it
is zero** — "no money had been received" is itself a fact worth being able to
prove. The cancel dialog reads the true received total through a `SECURITY
DEFINER` function, so a salesperson is not shown a figure narrowed by their own
RLS scope.

### D5 — Quotation Requests are entirely disconnected from Order Requests *(open)*

A Quotation Request is a `tasks` row with `task_type = 'quotation_request'`
(`20260652`). There is **no** foreign key, no conversion RPC, and no reference
column linking it to `order_requests` or `orders`. A quotation cannot become an
Order Request through the system; the connection exists only in people's heads.

Duplicate-conversion protection is therefore **not applicable** — there is no
conversion to protect. Documented, not built: creating that link is a product
decision about whether the quotation *is* the pre-order artifact or a separate
stage, and building it speculatively would risk a second competing pre-order
entity next to `order_requests`.

### D6b — The amendment guard was the *only* control on commercial columns *(Priority A · fixed in `20260818000000`)*

Found by reviewing `20260816000000` rather than by writing it, and confirmed
against the live database:

```
information_schema.role_table_grants, public.orders
  authenticated : SELECT INSERT UPDATE DELETE TRUNCATE REFERENCES TRIGGER
  anon          : SELECT INSERT UPDATE DELETE TRUNCATE REFERENCES TRIGGER
```

Supabase's blanket `grant all on all tables` default, never narrowed for this
table. RLS decides *which rows* may be updated; `orders_operations_update` says
"any row, for anyone on the operations team". **Nothing said which columns.** So
`20260804`'s trigger — which refuses a commercial change unless a
transaction-local GUC is set — was not defence in depth. It was the only depth.

The GUC is not reachable today: no function anywhere takes a GUC name as a
parameter, and PostgREST cannot issue a bare `SET`. That is not the point. A
session variable is a *coordination signal* between a definer function and its
own trigger; it must never be the thing that decides whether a write is allowed,
because it only has to become settable once — one future RPC forwarding a
parameter into `set_config`, one SQL-execution path — and the protection is gone
silently.

**Fixed** by making a privilege the primary control:

```sql
revoke update, delete, truncate, references, trigger
  on public.orders from authenticated, anon;
grant update (status) on public.orders to authenticated;
```

Checked by Postgres before RLS and before any trigger, and not overridable by
anything a client can put in a transaction. The `20260804` trigger keeps the job
it is actually suited to: catching the **service role** and direct SQL, which
hold their own grants.

`DELETE` and `TRUNCATE` went with it. `20260705 §2` dropped the DELETE *policy*
and added a row trigger to make Confirmed Orders permanent, but left the DELETE
and TRUNCATE *grants* — and **a row-level `BEFORE DELETE` trigger never fires on
`TRUNCATE`**, so the grant was a hole straight through that guarantee.

### D6c — An approved change request could silently clobber a newer amendment *(Priority A · fixed in `20260818000000`)*

`order_change_requests` stored only the *proposed* values, and approval applied
them with no reference to what the requester had been looking at:

1. Order value is ₹2,50,000. Sales raises "make it ₹3,00,000".
2. Admin amends directly to ₹4,00,000 (client added a wardrobe).
3. Admin approves the request from step 1.
4. Value is silently ₹3,00,000. The wardrobe is gone and nothing says a decision
   was reversed.

Both amendments are individually audited, so it is not *invisible* — but it is
not **detected**, and the approver is given no reason to look.

**Fixed** by a server-captured baseline (a `BEFORE INSERT` trigger, so a client
cannot forge it and thereby opt out of the check) plus a staleness gate in
`approve_order_change_request`. Comparison is **per proposed field**: a request
proposing a new value is not stale because somebody else moved the due date —
refusing on that would train admins to re-submit blindly, which is the failure
this prevents. A stale request is **refused, not auto-rejected**; it stays
pending so a human decides whether the proposal still makes sense.

### D7 — Any authenticated user could create a Confirmed Order directly *(FIXED in `20260819000000`)*

`orders_sales_insert` (`20260655`) permits `INSERT` where
`requested_by = auth.uid()`, and `authenticated` holds the table INSERT grant.
That lets a client create an Order outright — bypassing the Order Request →
conversion → numbering path, and burning a real number from the display-number
cycle via `orders_assign_display_number`.

The policy was **vestigial**: written when sales inserted their own rows at
status `requested`, a status `20260702000000` retired.

**Fixed** by dropping `orders_sales_insert` and revoking `INSERT` from
`authenticated` and `anon`. `convert_order_request_to_order` is `SECURITY
DEFINER` owned by `postgres`, so conversion is unaffected — verified against the
live database before the revoke. `orders_admin_insert` is deliberately left in
place: with the privilege gone it grants nothing, but it is correct as written,
so restoring a deliberate admin escape hatch later is a one-line `GRANT` rather
than a rediscovered policy.

### R2 — The status graph lived only in the browser *(FIXED in `20260819000000`)*

`TRANSITION_GRAPH` / `allowedTransitions()` were client-side only, so
`dispatched → running`, or a salesperson cancelling an order, were refused by
the UI and accepted by PostgREST. `20260818000000` narrowed *which columns* a
client may write; `status` is deliberately the one left writable, and nothing
constrained its *values*.

`orders_enforce_status_transition` now applies three gates: the graph (every
caller, including the service role — which is what makes "a cancelled order can
never be dispatched" a database invariant), the path (`cancelled` is reachable
only from inside `cancel_order_with_audit`, so a bare
`.update({status:'cancelled'})` by an admin can no longer bypass the mandatory
reason and the money disclosure), and the role (admin: any legal transition;
operations: the three operational ones; everyone else: none).

The graph mirrors the client's **exactly**, including what it omits —
`ready_for_dispatch → running` is not added here, because the UI does not offer
it and a transition nothing can reach would be worse than none.

### D8 — The blanket grant pattern is project-wide *(open)*

`public.orders` was narrowed because this branch is about Order integrity. Every
other table in `public` still carries the same default
`GRANT ALL TO anon, authenticated`, with RLS as the sole gate and no column
restriction anywhere in the project (`grep` for `grant update (` returns
nothing). A project-wide privilege audit is a separate task.

### D6 — Order activity entries are written client-side *(open, low)*

`StatusControl` writes its `order_activity_log` row from the browser, in a
second round trip after the status update. If that insert fails the status
change is silently unlogged, and `order_activity_log_operations_insert` lets an
operations user post arbitrary events. Cancellation no longer has this problem —
`cancel_order_with_audit` writes both in one transaction — but the other four
transitions still do. Recommended as the next small task (§6).

---

## 3. What was implemented

### 3.1 The amendment model

**Two doors, one apply path.**

```
admin ─────────────► amend_order() ─────────┐
                                            ├─► apply_order_amendment() ─► orders
everyone else ─► order_change_requests ─────┘         │
                        │                             └─► order_activity_log
                        └─► approve_order_change_request()
```

* **`NULL` means "leave this field alone."** Both doors `COALESCE` every
  proposed value against the stored one. The deliberate consequence: **neither
  door can blank a field back to `NULL`**, so a form submitting an empty box can
  never silently erase a due date. Clearing a field is not offered rather than
  half-offered through a sentinel.
* **An amendment that changes nothing is refused** (`ORDER_AMENDMENT_NO_CHANGE`),
  because an audit row saying nothing happened is worse than no row.
* **The diff is built from what the database stored**, not from the arguments,
  so a value equal to the one already there never appears in the audit row as
  though it were a change.
* **A reason is mandatory** on both doors and on cancellation.
* **A closed Order (`dispatched` / `cancelled`) refuses amendment**, at the
  database, in the insert policy, and in the UI.
* **`FOR UPDATE` on the Order** — two amendments racing serialize, so the
  "before" values in the audit log are the ones actually replaced.
* **Approval is atomic with its effect.** Every refusal raises and rolls the
  whole transaction back, so no request is ever marked `approved` without the
  change having landed.
* **`order_change_requests` has no `UPDATE` and no `DELETE` policy, for anyone
  including admins.** A client cannot move a request to approved, cannot write
  `reviewed_by`/`reviewed_at`, and cannot erase a decision.
* **One open request of each type per Order per person** (partial unique index).
  The UI disables the button rather than letting the insert die on a constraint.

**Why a GUC rather than "exempt admins" in the guard:** an exemption for a *role*
audits nothing — it would let an admin's ordinary PostgREST `PATCH` rewrite the
order value with no activity row, which is precisely the state D2 describes. A
GUC is a *context*: set only by `apply_order_amendment()`, only after the actor
is validated, only in the same transaction that writes the audit row,
transaction-local, and unsettable from any client. Same idiom as
`in_test_data_cleanup()` (`20260705000000`).

### 3.2 Cancellation

Cancellation is separated from amendment because it is not a change of terms.

* Requires a reason.
* Records `received_at_cancellation` in the activity log.
* **Touches no payment.** Payments linked to a cancelled Order stay linked and
  stay `approved_linked`: the money genuinely arrived, and *a cancellation is
  not a refund*. Refunding is a separate deliberate act by whoever moves funds.
* A dispatched Order cannot be cancelled; a cancelled one cannot be cancelled
  twice.
* Non-admins get `request_type = 'cancel'`, because cancelling is the one
  lifecycle move a salesperson has a legitimate reason to ask for and no
  authority to make (`allowedTransitions()` returns `[]` for them).

### 3.3 Calculation definitions *(as implemented today)*

| Figure | Definition | Where |
| --- | --- | --- |
| Gross received | `sum(amount)` over `status = 'approved_linked'` for the Order | `order_linked_payment_total()`; Order detail page |
| Pending | `total_value − gross received`, floored at 0 for display | Order detail page |
| Completion | `round(gross received / total_value × 100)` | Order detail page |

Pending and rejected payments are **excluded** from every one of these. Refund,
reversal, net-received and overpayment are **not yet modelled** — see §4.

---

## 4. Deferred, with reasons

These are specified rather than built. Each was deferred because it needs a
product decision or a data model that should not be guessed at, not because it
is unimportant.

### 4.1 Refunds, reversals and customer credit *(Priority C · deferred)*

The prompt asks these be distinguished rather than collapsed into "refund":

| Event | Meaning | Correct model |
| --- | --- | --- |
| Refund | Money returned to the customer | New signed record referencing the original payment |
| Data-entry error | The payment never happened | **Void** the original, not a refund |
| Bank reversal / bounce | Money arrived then left | Reversal record; original stays visible |
| Wrong allocation | Right money, wrong order | **Relink**, which already exists |
| Wrong amount or date | Right event, wrong facts | **Correction**, with before/after |

**Recommended shape:** a `finance_payment_adjustments` table — one row per
adjustment, `adjustment_type` in (`refund`, `void`, `reversal`, `correction`),
`original_payment_id`, amount, date, mode/destination, reason, supporting
document, requested_by, approved_by, status, timestamps. Then:

```
gross received  = Σ approved_linked payments
refund total    = Σ approved refunds
reversal total  = Σ approved reversals + voids
net received    = gross received − refund total − reversal total
balance due     = current order value − net received
overpayment     = max(net received − current order value, 0)
```

**Why not implemented now:** it must not be a negative `amount` row in
`finance_payment_requests`. That would be the fastest route and the wrong one —
it corrupts every existing count and sum, including the conversion rule's
"at least one approved payment", and it is exactly what the new
`finance_payment_requests_amount_positive` constraint now forbids. The
constraint was added deliberately **before** the refund work so the wrong shape
is closed off first.

Customer credit (money retained against a cancelled order for a future one) is
a further state on top of this and should not be designed before the adjustment
table exists.

### 4.2 Dispatch readiness gate *(Priority C · deferred)*

Requirements 13.2–13.4 (invoice, dispatch document, e-way bill, vehicle number,
transporter, vehicle type, freight, dispatch date, shipping and billing
address) are **entirely absent today** — `ready_for_dispatch → dispatched` is a
plain status update with no data requirement whatsoever.

`orders` carries no address columns, no dispatch columns and no dispatch
document category. Building this needs: new columns or a `order_dispatch`
table, a storage category in the existing attachment infrastructure, a
server-side transition guard, and a "Not Applicable + reason" path for
documents that genuinely do not apply. That is a phase of its own, and half of
it would be worse than none — a dispatch gate that validates four of nine
fields trains people to trust a check that does not hold.

**Future Transport Module integration point:** keep transporter, vehicle type
and freight as plain columns on the dispatch record now, and add a nullable
`transport_record_id` FK later. Do not create transport tables speculatively.

### 4.3 Fabric and finish *(deferred)*

Requirement 11. No fabric or finish field, column or attachment category
exists. Once built it should follow the amendment model in §3.1 when
manufacturing has already received the order.

### 4.4 Post-approval correction requests for **payments** *(deferred)*

Requirement 7.5. Approval is currently a hard wall in Finance:
`canManageRequest()` returns false for both approved statuses and there is **no
request-an-edit path** for a salesperson. The Order-side equivalent now exists
(`order_change_requests`); the Finance-side equivalent should reuse the same
shape but is a separate table and a separate phase, and it overlaps heavily
with the adjustment model in §4.1 — building them in the wrong order would
produce two competing correction workflows.

### 4.5 Missing-document double confirmation *(deferred)*

Requirement 9.2. Today the **Main PI is mandatory** and enforced in the
database (exactly one, verified at finalization), which covers the most
important half. What is missing is the **two-step confirmation when no
*reference* attachment — drawing, specification, client document — is present**.
This is a contained UI change and is the cheapest item on this list; it was
sequenced after the Priority A items per §22.

### 4.6 Sales Manager team visibility *(open question)*

`orders_sales_select` scopes to `requested_by = auth.uid() OR assigned_to =
auth.uid()` — correct for a Sales Executive, and it means a **Sales Manager
currently sees only their own records**, not their team's. Whether managers
should see team records is a permission-model decision (the permission engine
in `20260660` is the right place for it, not a hardcoded `role = 'manager'`
policy). Flagged, not changed.

### 4.7 Conversion payment prerequisite *(verified, unchanged)*

`convert_order_request_to_order` requires **at least one approved linked
payment**, and refuses while any linked payment is still awaiting a Finance
decision. This is a documented business rule
(`05_Business_Rules.md` → "Order Request Approval Requirement") and was
**deliberately left exactly as it is**.

**Conflict worth raising with the Product Owner:** this makes a zero-advance or
credit order impossible to enter. If those occur in practice, the correct
remedy is a narrow admin override requiring a reason and a permanent audit
entry — *not* weakening the database rule. Not built, because inventing an
override for a rule the owner may still want absolute would be the wrong
default.

---

## 5. Requirement status matrix

| § | Requirement | Status |
| --- | --- | --- |
| 7.1 | Payment against no sales record | **Verified existing** — `unallocated` target |
| 7.2 | Payment against Order Request | **Verified existing** — `20260698`/`20260699`/`20260715` |
| 7.3 | Payment against Confirmed Order | **Verified existing**; cancelled-order handling **deferred** (§4.1) |
| 7.4 | Edit/delete before approval | **Verified existing** — `20260700` |
| 7.5 | Post-approval correction requests | **Deferred** (§4.4) |
| 7.6 | Clarification and rejection | **Verified existing** |
| 7.7 | Race conditions | **Partially verified** — new RPCs use `FOR UPDATE`; existing paths reviewed, not executed (no DB access) |
| 8.1 | Partial payments / totals | **Partially existing** — gross only; net/refund/overpayment **deferred** (§4.1) |
| 8.2 | Advance before finalization | **Verified existing** (code review only) |
| 8.3 | Overpayment | **Documented only** — survey query added; no separate display |
| 8.4 | Underpayment | **Verified existing** — no full-payment dispatch block introduced |
| 8.5 | Refunds | **Deferred with spec** (§4.1) |
| 8.6 | Reversal / correction taxonomy | **Documented only** (§4.1) |
| 8.7 | Customer credit | **Deferred with spec** (§4.1) |
| 9.1 | Order Request creation | **Verified existing** |
| 9.2 | Missing-document protection | **Partially existing** — Main PI mandatory; double confirmation **deferred** (§4.5) |
| 9.3 | Edit/delete before approval | **Verified existing** |
| 9.4 | Post-lock amendment | **Verified existing** for requests (clarification/reapply flow) |
| 9.5 | Conversion | **Verified existing, unchanged** (§4.7) |
| 10.1 | Order-number integrity | **Verified existing** — `20260703`/`20260704`, immutable by trigger |
| 10.2 | Amendments to confirmed fields | **Implemented** (§3.1) — commercial fields; product/fabric/dispatch fields **deferred** |
| 10.3 | Order amount changes | **Implemented** — payments untouched, balance recalculates, revision audited |
| 10.4 | Controlled cancellation | **Implemented** (§3.2) — reason + money position; refund/credit **deferred** |
| 10.5 | Reopening cancelled orders | **Not added**, per the prompt's safer default |
| 11 | Fabric and finish | **Deferred** (§4.3) |
| 12 | Status flow | **Verified existing**; transition graph is client-side — see risk R2 |
| 13 | Dispatch requirements | **Deferred with spec** (§4.2) |
| 14 | Quotation workflow | **Defect documented** (D5) — no link to Order Requests exists |
| 15 | Permissions matrix | **Partially verified**; Sales Manager scope **open** (§4.6) |
| 16 | Audit and notifications | **Implemented** for amendments/cancellation; notifications **deferred** (Action Queue used instead) |
| 17 | Amounts and calculations | **Implemented** — DB constraints + `parseMoney` with 44 unit tests |
| 18 | Automated tests | **Implemented** — 44 new unit tests + 2 SQL assertion scripts |
| 19 | Database verification | **Implemented** — 2 new migrations, 2 assertion scripts; **not applied** (no DB access) |
| 20 | Manual acceptance test | **Blocked** — no authenticated access; checklist written |
| 21 | Documentation | **Implemented** — this file + business rules |

---

## 6. Remaining risks

> **Status update — all migrations APPLIED to production.** Renumbered to
> `20260816`–`20260821` (the originals were `20260804`–`20260806`, which would
> have landed *below* nine already-applied migrations). Applied in order, each
> after a clean dry-run. Both SQL assertion suites pass against the migrated
> database, and the live access model is verified in §9 below.
>
> **Executing the assertions found three defects that reading them had not:**
>
> 1. A **test bug** — the audit-payload assertion compared `numeric(12,2)` as
>    text, so `250000.00` failed against `'250000'`.
> 2. A **product bug in `20260818000000`** — `v_stale := v_stale || 'literal'`
>    resolves to array-concat, not append, so the staleness gate raised a raw
>    `22P02` cast error instead of `ORDER_CHANGE_REQUEST_STALE`. It failed
>    *safe* (the exception still aborted the approval, so no stale amendment was
>    ever applied) but the admin got an unmappable error. Fixed in
>    `20260820000000` with `array_append`.
> 3. A **false claim in `20260817000000`** — it stated every amount column was
>    unconstrained. Three of the five already had `CHECK`s, inline on the
>    `ADD COLUMN` in `20260696000000`. The duplicates are dropped and the two
>    genuinely-new constraints are now `VALIDATE`d (`20260821000000`).
>
> ~~**R1 — None of the three migrations has been applied.**~~ *(resolved)*

**R1 — None of the three migrations has been applied.** `20260816000000`,
`20260817000000` and `20260818000000` are written and reviewed but have never
run against any database. The UI shipped alongside them **will fail** until they
are applied: `amend_order` and `order_change_requests` do not exist yet. Apply
the migrations **before** deploying the application code.

**R1b — `supabase db push` would also apply an unrelated, uncommitted
migration.** The dry-run reports three pending files, and the first is
`20260803000000_asset_permanent_delete.sql` — untracked work belonging to a
different in-flight session, which adds a destructive
`permanently_delete_asset()` capability. `db push` has no per-file selection, so
applying this branch's migrations means applying that one too. **That is why
nothing has been applied**, and it must be resolved with the owner of the assets
work before any push.

**R1c — Column privileges and the amendment guard must stay in step.** After
`20260818000000`, `status` is the only column a client role may update on
`orders`. Any future feature that needs to write another column from the client
must go through the amendment path — granting the column back would re-open
D6b silently, because the trigger alone never was sufficient.

**R1d — Legacy change requests carry no baseline.** Rows created between
`20260816000000` and `20260818000000` have `baseline_*` NULL and are therefore
exempt from the staleness gate. In practice there are none (the feature has
never been deployed), but the code path exists and both the SQL and the
TypeScript treat a missing baseline as "cannot judge" rather than "not stale by
default".

**R2 — The status transition graph is client-side only.** `TRANSITION_GRAPH` and
`allowedTransitions()` live in `src/app/orders/[id]/page.tsx`. RLS permits any
operations-team member to set `status` to any value the CHECK accepts, so
`dispatched → running` is refused by the UI and accepted by the database. The
new guard covers *commercial* columns; `status` is deliberately outside it. This
should become a database-side transition guard.

**R3 — Reassignment is now blocked for everyone.** `assigned_to` and
`requested_by` are in the guarded tier, and `amend_order` does not offer them.
No UI existed to change them before, so nothing regressed in practice — but if
reassigning an Order to another salesperson is a real need, it must be added to
the amend door rather than by loosening the guard.

**R4 — `NOT VALID` constraints are not yet validated.** They enforce on new
writes immediately, but existing rows are unproven until the survey script is
run and the `VALIDATE CONSTRAINT` statements are executed.

**R5 — Overpayment is still silent.** Nothing detects or displays a receipt
above the order value. The survey script in
`financial_amount_invariants_assertions.sql` will list existing cases.

---

## 7. Operations permissions — the exact allowed fields

After `20260818000000`, for every client role (`authenticated`, `anon`):

| Column | Client UPDATE? | Enforced by |
| --- | --- | --- |
| `status` | **Yes**, `authenticated` only | `GRANT UPDATE (status)`, then RLS (`orders_admin_update` / `orders_operations_update`) |
| `notes` | No | privilege, then the amendment guard |
| `client_name` | No | privilege, then the amendment guard |
| `total_value`, `total_product_value` | No | privilege, then the amendment guard |
| `confirm_date`, `due_date`, `lead_source` | No | privilege, then the amendment guard |
| `requested_by`, `assigned_to` | No | privilege, then the amendment guard |
| `created_by`, `created_at` | No — **frozen, amendment included** | privilege, then the guard's frozen tier |
| `display_number` | No | privilege, plus `orders_protect_display_number` (`20260703`) |
| `source_order_request_id`, `source_request_number` | No | privilege, plus `orders_protect_source_request` (`20260701`) |
| `is_test_data` | No | privilege, plus `orders_protect_test_data` (`20260706`) |

An Operations user can therefore perform status transitions and **nothing else**.
Billing details, payment linkage, cancellation metadata and amendment records
are not columns on `orders` at all — they live in `finance_payment_requests`,
`order_activity_log` and `order_change_requests`, none of which grants Operations
any write path.

`status` transition *validity* is still client-side only — see risk R2.

## 9. Verified live access model (post-migration)

Queried from `information_schema` / `pg_catalog` after applying, not inferred:

| Check | Result |
| --- | --- |
| `orders` table grants, client roles | `anon: SELECT`, `authenticated: SELECT` — nothing else |
| `orders` column UPDATE grants | `authenticated: status` — one column |
| `orders_sales_insert` | **DROPPED** |
| Triggers on `orders` | `enforce_status_transition`, `guard_amendable_columns`, `prevent_delete`, `protect_display_number`, `protect_source_request`, `protect_test_data`, `assign_display_number`, `stamp_test_data`, `set_updated_at` |
| Public RPCs | all 5 `SECURITY DEFINER`, owner `postgres`, `search_path=public, pg_temp` |
| Internal fns callable by a client role | **NONE** |
| `order_change_requests` UPDATE/DELETE policies | **NONE** |
| Amount constraints validated | `finance_payment_requests_amount_positive=true`, `orders_total_value_non_negative=true` |

Left deliberately: `order_requests_total_value_nonneg` stays `NOT VALID`. It
predates this branch and the survey shows it would validate cleanly, but
validating another workstream's constraint is a change they should make
knowingly.

Also left: `20260814000000_create_meetings_module.sql` and
`src/lib/meetings/schemaGuards.test.ts` cite migration `20260806000000` — the
pre-renumber number of what is now `20260818000000`. The migration is already
applied and must not be edited; the citation is stale but harmless.

## 9a. Payment Phase 1 — the allocation foundation (`20260918000000`)

Database only. **No UI, no approval-gate change, no production data touched.**

### Why a child table rather than another column on the payment

`finance_payment_requests` stays the only payment ledger. What it cannot express
is the two things the business confirmed it needs:

* a payment split across several PIs and Orders —
  `finance_payment_requests_one_link_target` (`20260698000000`) permits at most
  one link target per payment, and `amount` is a single scalar;
* a **partly** allocated payment with a residual to assign later — there is no
  concept of a residual anywhere; "unallocated" today means the whole payment is
  unlinked.

Adding `order_submission_id` as a fourth mutually-exclusive linkage column would
have delivered PI targeting alone and then had to be unwound, on live money rows,
the moment splitting landed. One child table costs one migration instead of two.

### The unallocated balance is derived, never stored

```
balance = finance_payment_requests.amount
        - sum(finance_payment_allocations.allocated_amount) where status = 'active'
```

There is no mutable balance column, and the migration's own assertions refuse one.
The figure is trustworthy because exactly one invariant has to hold, and a trigger
holds it on every write path — `finance_payment_allocations_enforce_capacity`,
which locks the **parent payment** `FOR UPDATE` before reading the total, so two
concurrent allocations against one payment serialize instead of both passing on a
stale read. Its mirror, `finance_payment_requests_guard_allocated_amount`, refuses
an amount correction that would drop a payment *below* what is already allocated.

### Verification belongs to the payment, never to the allocation

An **unverified payment may be allocated**, because that is the confirmed
sequence: Sales records money against a PI or an Order, the payment and its
allocation read as *Awaiting Verification*, and Finance then verifies,
corrects-and-verifies, or rejects. Requiring verification first would invert the
workflow and leave the salesperson nowhere to say what the money was for.

There is deliberately **no pending/verified pair of allocation statuses**.
`active`/`reversed` answers a different question — whether the allocation still
applies at all. Whether the money is confirmed is the parent's `status`, read
through one definition:

```sql
public.finance_payment_status_is_verified(text)
  -- true only for approved_unlinked and approved_linked
```

That function is the single rule any verified total consults. Phase 3
(`20260921000000`) is the phase that started reading it: it is what
`order_submission_verified_payment(uuid)` sums, and therefore what decides
whether an Order number is assigned.

A **rejected payment retains its allocations** — a rejection is frequently
corrected and reapplied (`20260695000000`), and destroying the allocation would
make the salesperson restate what the money was for. It simply never counts as
verified. Only a *new* allocation on a rejected payment is refused.

Because a pending payment's amount is still editable by its submitter, the
payment-side half of the capacity invariant is what makes this safe, and it is a
`BEFORE UPDATE` **trigger** rather than a check inside an RPC — the commonest
edit in the module (the submitter's own PATCH through
`finance_payment_requests_own_update`) touches no RPC at all.

### What an allocation may ever do

Created `active`, then reversed. Nothing else. Payment, target, amount, provenance
and creation record are immutable; reversal is terminal and requires an actor, a
time and a non-blank reason, all server-derived.

### Nothing deletes financial history by side effect

All three foreign keys are **`NO ACTION`**, not `CASCADE` — the same choice
`20260915000000` §2 made for `orders.source_order_submission_id`, for the same
reason:

* an allocation **refuses deletion of its PI or its Order**, for every role
  including the service role;
* `finance_payment_allocations_guard_delete` refuses direct deletion on every
  path;
* the one deliberate release is the **parent payment's own deletion**. An
  unverified payment has always been deletable — `20260705000000` calls it "a
  mistake rather than an event" — and its allocations describe money that was
  never confirmed, so leaving them behind would be false history pointing at a
  payment that no longer exists. `finance_payment_requests_release_allocations`
  removes them explicitly, and only ever runs *after*
  `finance_payment_requests_guard_approved_delete` has already refused every
  verified payment. The exemption it sets is transaction-local **and pinned to
  one payment id**.

Test Data Cleanup keeps working **unchanged** through that same release:
`finalize_test_data_cleanup()`'s existing `delete from
public.finance_payment_requests` fires it. No cleanup function is restated, and
no claim or finalize safeguard is weakened.

**Known cleanup limitation, for Phase 2.** `resolve_test_data_cleanup_chain()`
finds a chain's payments through `order_id` / `order_request_id`, not through
allocations. Today that is complete — Phase 1 only creates allocations for
payments already linked by `order_id` — but once Phase 2 lets a payment be
allocated to a PI *without* being linked, such a payment would not be claimed,
and its allocation would then block the Order or PI delete with a raw foreign-key
error rather than a readable "not eligible". Extending the chain resolver belongs
with the phase that creates those rows.

### Backfill

Every payment that is `approved_linked` **and** names an Order received exactly
one active allocation, for the full amount, against the same Order, with
`confirmed_order` provenance and the payment's own approval actor and timestamp.
Deliberately **not** backfilled: `approved_unlinked` payments (no target exists),
Order-Request-linked payments (a separate live flow with its own conversion sweep)
and anything pre-approval. Idempotent, and proved by apply-time assertions.

### Permissions

Two new **protected** Finance actions, `finance.allocate` and
`finance.allocate_correct` — separate from each other and from `finance.approve`
in every direction, so verifying that money arrived, deciding whose it is, and
undoing that decision can be held by three different people. `default_allowed`
is false on both, no role carries either, and the migration asserts that it
granted them to nobody. `finance.approve` is **not** renamed or re-scoped; it
remains the verification authority.

### What Phase 1 deliberately did NOT do

No UI. No payment entry against a PI (Phase 2). No `order_submission` value on
`payment_target_type`. No sixth payment status. No PI-to-Order allocation move —
Order creation from a PI is a later phase, and the transition guard will have to
be restated then, on purpose, as a visible reviewed change. And
`approve_order_submission()` still gates on the **declared** advance
(`order_submission_advance_ready`); payment does not gate Order approval yet.

> **Both of those last two were paid by Phase 3 (`20260921000000`).** The
> transition guard *was* restated, exactly as foreseen, to admit one move and
> nothing wider; and approval now gates on verified payment rather than on the
> declaration. See §11.

### Participant visibility — and why this table has no Finance module gate

The other three Finance tables carry a RESTRICTIVE `module_entry_open('finance')`
gate (`20260905000000` §2). **This one deliberately does not**, and it is the one
place in the schema where that is right.

The confirmed rule is that a salesperson may see the money attached to a PI or
Order **they uploaded or own** without holding Finance-module access. A
restrictive gate ANDs itself onto every permissive policy, so it would have
hidden a person's own record's payment from them unless somebody also granted
Finance — which grants far more than that narrow sight.

Nothing is widened by removing it, because each permissive policy carries its own
complete authority:

| Policy | Authority |
|---|---|
| admin | matches `finance_payment_requests_admin_select` |
| `finance.view_all` | the existing protected company-wide Finance sight |
| payment submitter | you raised this payment |
| PI participant | `module_entry_open('orders')` **and** `can_view_order_submission()` |
| Order participant | a plain `EXISTS` on `public.orders`, which inherits that table's own RLS *and* its RESTRICTIVE Orders gate |

Both participant branches still resolve to "a record this person can already
open". Someone with neither Finance nor Orders access reaches nothing.

**Seeing is not doing.** Write privileges are revoked outright and there is no
INSERT/UPDATE/DELETE policy for any role, so reading an allocation on your own PI
confers no `finance.allocate`, no `finance.allocate_correct`, no verification
authority and no Finance page.

### Required Phase 2 dependency

`finance_payment_requests` is **not** widened here and keeps its existing policies
and its Finance module gate. So a PI owner without Finance access can currently
read the *allocation* but not the payment row behind it — which is where
`payment_date`, `payment_mode`, `admin_note` and the rejection reason live.

**Phase 2 must add the matching participant SELECT policy to
`finance_payment_requests`** when it builds the PI/Order payment card. It is
deliberately not done here: widening the payment ledger belongs with the screen
that needs it, and doing it a phase early would expose payment rows nothing yet
reads.

---

## 9b. Payment Phase 2 — recording a payment against a PI (`20260919000000`)

**Not applied.** One new forward migration, one new card on the existing PI detail
page. Phase 1 could hold a PI payment; nothing could create one.

### What lands

| | |
|---|---|
| `record_pi_submission_payment(...)` | Records ONE payment and allocates it in full to the PI, **in one transaction** |
| `pi_submission_payment_summary(uuid)` | The card's rows and its five totals, computed in `numeric` in the database |
| `can_read_payment_as_participant(uuid)` | The single participant-visibility rule |
| `allocate_payment_to_target_internal(...)` | Phase 1's rules, now shared by two doors |

### Atomicity is structural, not compensating

The RPC has **no exception handler**. The payment insert and the allocation
happen in one transaction, so a failure in either leaves neither — there is no
window in which money exists unallocated, and none in which an allocation names a
payment that was never written. Asserted directly: the test reads the deployed
body and fails if an `exception when` block ever appears.

### One implementation, two doors

Phase 1's `allocate_payment_to_target` requires `finance.allocate` — correct for a
Finance user attaching money to somebody else's business, but wrong for a PI's own
uploader, who holds no Finance action at all. Rather than duplicate the capacity
lock, the target rules and the audit, the implementation moved to
`allocate_payment_to_target_internal` (executable by **no** client role) and each
door decides its own authorization. `allocate_payment_to_target` keeps its exact
signature and still requires `finance.allocate`; a door can widen *who* may
allocate, never *what* may be allocated.

### Who may record a payment

An **active admin**, the **PI's own uploader / creator / named reviewer**, or an
explicit **`finance.allocate`** holder. Wider Finance access — `view`, `view_all`,
`approve`, `manage` — is deliberately **not** a route, and the assertion suite
proves it with an account holding all four.

> The authorization check is wrapped in `coalesce(..., false)`. `assigned_to` is
> nullable, so `false or false or false or NULL` is `NULL`, and `if not NULL` does
> not fire — without the coalesce the check would have failed **open** for every
> unrelated caller on any PI with no named reviewer. Caught by test 4.

### `received_in` is now optional — and no screen may re-invent it

**The audit of PR #43 found a real defect here.** Making the column nullable was
only half the job: two Finance screens still assumed every payment carries a
destination pair.

* **Payment Requests → Edit** seeded its destination selector through
  `readDestinationKey()`, whose *documented* fallback is the DEFAULT account, and
  its save wrote **both** halves of the pair unconditionally. So a payment
  recorded against a PI as **UPI, account not stated** became **Bank Transfer /
  HDFC** the moment anyone opened that modal and saved *any* field — two recorded
  financial facts silently rewritten by a form opened to fix a typo. A PI payment
  is `pending_approval`, which is exactly what that page lists, so it was fully
  reachable.
* **Received Payments → Edit** bound a controlled `<select>` to a null value,
  which React renders as the first option — showing an account the money never
  went to.

The fix, at its narrowest:

| | |
|---|---|
| `readDestinationKeyOrNull()` | new; returns **null** when the stored pair names no account. `readDestinationKey()` keeps its own contract for callers that must land on a selectable choice |
| `destinationWritePair(null)` | returns null, spread as `...(pair ?? {})`, so **both columns are left alone** |
| destination selector | accepts null, shows no card active, and says the account was not stated |
| Received Payments | an explicit **Not stated** option whose `''` maps back to `NULL`, and a `receivedInLabel()` that reads *Not stated* instead of rendering blank |

Regression tests cover all of it, including a source-level assertion that the
edit modal never writes the pair unconditionally again.

### `received_in` is now optional

The confirmed rule is that only amount, date and mode may block entry.
`received_in` has been NOT NULL since `20260628000200`; it is now nullable, and
NULL means **not stated** rather than `'other'`. The domain CHECK is untouched
(`x in (…)` passes for NULL), every existing writer still supplies a value, and
every existing reader already falls back to the payment-mode label for a pair it
does not recognise. Finance can supply it later through the existing correction
path.

### Participant visibility — the Phase 1 dependency, paid

`finance_payment_requests` now carries a permissive participant SELECT policy, and
its RESTRICTIVE Finance module gate is **restated** rather than dropped:

```
USING       module_entry_open('finance') OR can_read_payment_as_participant(id)
WITH CHECK  module_entry_open('finance')
```

The Finance pages are unaffected — they select without an allocation predicate, so
a caller with no Finance entry still matches no permissive policy there. `WITH
CHECK` stays Finance-entry only, so **participant sight can never authorize a
write**; that line is asserted on its own. The proof *object* is not widened: only
its metadata row is, and the summary reports `can_view_proof` honestly so the card
offers the action only when the object would actually open.

### The five figures

All computed in the database in `numeric`, never in the browser:

| Figure | Rule |
|---|---|
| Verified payment | active allocations whose parent is verified (`finance_payment_status_is_verified`) |
| Awaiting verification | active allocations whose parent is `pending_approval` or `needs_clarification` |
| Payment received % | verified ÷ grand total |
| Needed for approval | `max(40% of grand total − verified, 0)` — reporting only until Phase 3, which made it the live gate and rounded it **up** (see §11) |
| Pending balance | `max(grand total − verified, 0)` |

Rejected payments count in **neither** total but stay in the history. Reversed
allocations count in neither, by both definitions. **Declared advance is never
shown as payment** — the summary has no field for it and the RPC does not read it.

#### The paise-rounding rule

Every figure is PostgreSQL `numeric` end to end. `grand_total` is
`numeric(12,2)` and `allocated_amount` carries a CHECK that it equals
`round(x, 2)`, so **every input is already exact to the paisa**. Therefore:

* **Subtraction is never rounded.** `pending_balance` is
  `max(grand_total − verified, 0)` on two 2-decimal values — exact, with nothing
  to round.
* **Division is rounded, half away from zero.** The only operations that can
  produce sub-paise are the 40% share (`grand_total × 40 / 100`) and the
  percentages. Those are `round(…, 2)`, and PostgreSQL's `numeric` round is half
  **away from zero**: `0.125 → 0.13`, `2.675 → 2.68`. A binary double gives
  `2.67` for that second one, which is why no approval figure is allowed near a
  float.
* **Order of operations matters.** `needed_for_standard` is
  `round(max(requirement − verified, 0), 2)` — the *result* is rounded, not the
  requirement first. On a ₹33,333.33 PI the 40% requirement is ₹13,333.332: with
  nothing verified the figure shown is **₹13,333.33**; with ₹0.30 already
  verified it is **₹13,333.03**.
* Money crosses the wire as a **string**, so no JSON double touches it before the
  browser formats it. The browser recomputes nothing — asserted by feeding the
  card deliberately inconsistent figures and requiring them to survive.

Five exact cases are driven end to end through the RPC in
`supabase/tests/pi_submission_payment_assertions.sql`, and the same five are
asserted at the formatting boundary in `src/lib/finance/piPaymentView.test.ts`.

**Order approval eligibility was unchanged by Phase 2.** `approve_order_submission()`
still read the declared advance and consulted no allocation. Phase 3
(`20260921000000`) changed exactly that — see §11.

### Cleanup-chain dependency, closed

`resolve_test_data_cleanup_chain()` now also sweeps payments reachable **only**
through an allocation to the chain's PI. Every downstream consumer — the delete
list, the eligibility test, the counts and the **proof storage paths** — reads the
same array, so all of them pick it up. `begin_`/`finalize_test_data_cleanup()` are
**not restated** and no claim, expiry, freeze or storage-removal rule is weakened.

### The UI

One `Payments` card on the PI detail page, in the same quiet register as the
Commercial breakdown and Activity cards: five compact tiles, a payment list, and
an `Add Payment` control shown only to permitted users. `pending_approval` reads
as **Awaiting Verification** — a label, not a sixth database status.

The PI screen writes nothing itself: the payment goes through the RPC, and the
optional proof through a shared `src/lib/finance/paymentProof.ts` helper, so the
existing rule that PI screens hand-roll no persistence still holds. A proof
failure **keeps the payment** and says so.

---

## 11. Payment Phase 3 — the verified-payment approval gate (`20260921000000`)

*Not applied. PR open on `claude/boe-verified-payment-approval-phase3-hgevan`.*

### The rule

An Order number is assigned only when **verified payment allocated to the PI is
at least 40% of its grand total**, or when an authorised approver has approved
proceeding on less — including on nothing.

```
payment-ready  ⇔  verified >= grand_total * 40 / 100        the standard route
                  OR advance_exception_status = 'approved'  the reduced-payment route
```

`verified` is summed **live, at the instant of approval, under row locks**, from
active allocations naming the PI whose parent payment is verified by
`finance_payment_status_is_verified()`. It is never read from a column, never
supplied by a caller, and never frozen from a displayed percentage.

**Exact amounts, not rounded percentages.** 40% of ₹100.01 is ₹40.004; ₹40.00
displays as "40%" and does not meet the requirement. `numeric` end to end.

### What no longer decides anything

`order_submission_advance_ready(text, numeric, text)` and the declared advance it
reads. The function still exists and is still correct about what it describes;
`approve_order_submission()` no longer calls it, and the migration asserts that at
apply time. `advance_declared_amount` is retained in full for historical records,
re-documented as legacy, and written NULL by the new submission door.

### The two things that DO still gate, and stay separate

1. **The PI Finance check** (`order_submission_finance_verified`, `20260915000000`)
   — somebody with finance authority has read the commercial figures. It goes
   stale the moment the record moves, and it is judged **before** the payment
   gate, exactly as it was.
2. **Verified payment**, above.

Neither sets the other. Verifying a payment does not stamp the PI finance check,
and the PI finance check says nothing about money arriving. If payment changes
after the finance check, approval still uses the live figure.

### The reduced-payment exception

The **existing** advance-exception workflow, adapted rather than duplicated:
`orders.approve_advance_exception` (which no preset grants),
`approve_pi_advance_exception(uuid)` and `reject_pi_advance_exception(uuid, text)`
are unchanged. What changed is what the request MEANS — "proceed below 40%
verified payment" rather than "proceed on a lower declared advance" — and that a
reason and Payment Terms are mandatory to raise one. Rejection still returns the
PI to Needs Changes with the reason as its correction instruction.

Live recalculation handles the four cases that matter:

| Situation | Outcome |
|---|---|
| Payment reaches 40% while a request is pending | Standard route succeeds; the exception is not consulted |
| Payment reversed below 40% after an exception was approved | The approved exception still permits approval |
| Payment reversed below 40% with no approved exception | Refused; the declared advance cannot rescue it |
| A pending payment would take the total over 40% | Refused, and the refusal says the money is with Finance |
| An approved exception with unverified payment | Order created; the payment stays unverified |

### Payment Terms and Billing Terms

`order_submissions.payment_terms` and `.billing_terms` — plain text, non-blank
when present, ≤ 500 characters, never parsed. Payment Terms are mandatory on the
reduced-payment route; Billing Terms are always optional. No instalments, no
schedules, no due dates, no reminders.

### PI-to-Order allocation continuity

At approval, in the same transaction that creates the Order, the PI's **active
allocations MOVE** — one `UPDATE`, no insert, no delete, no payment row created or
copied. Ids, payment, amount, provenance and creation record are all unchanged;
reversed allocations stay with the PI. The payment's proof, verification status
and Finance history are untouched, because the payment row is untouched.

`finance_payment_allocations_guard_transition()` is restated — the change
`20260918000000` §6 said Phase 3 would have to make — to admit exactly that move:
inside `approve_order_submission()`, for that submission, onto the Order whose
`source_order_submission_id` is that submission, with every other column frozen.
A reversed allocation cannot move; money cannot move to another Order or back to
a PI; the amount cannot be edited on the way across.

The Order detail page reads its own active allocations alongside the legacy
`order_id` link and deduplicates by payment id, so a converted PI's money is
visible on the Order and never counted twice.

### Numbering

Unchanged. `orders_assign_display_number` remains the only allocator; the
approval function neither names nor computes `display_number`. A PI held for
insufficient payment or a pending exception is assigned **no number at all**, and
a failed approval consumes none because the cycle is advanced inside the same
transaction that rolls back. Cancellation is not implemented in this phase; the
confirmed decision that a cancelled number cannot be reused is unaffected.

### The lock order, stated once for the whole module

Every writer that touches a PI's or an Order's money takes its locks in this
order, and multi-row sets in ascending `id`:

```
orders → order_requests → order_submissions → finance_payment_requests
       → finance_payment_allocations → order_number_cycle
```

It is the order `finalize_test_data_cleanup()` (`20260916000000`) already walks
and the one `reverse_payment_allocation()` (`20260918000000` §12) documents for
itself. Phase 3 made it true on the one path that had it inverted:
`allocate_payment_to_target_internal()` locked the payment first and read the PI
**unlocked**, so an allocation could land on a PI that had just been approved —
stranding money on a record that no longer counts it. It now locks the PI target
first. Two concurrent sessions prove both halves: the old order deadlocks, the
new one does not.

### Exception currentness

An approved exception is an approval of a PARTICULAR PI. The decision now records
the grand total, the workbook hash and both sets of terms it was taken against
(`advance_exception_decided_*`), and `order_submission_exception_current()` is the
one rule that compares them. A replaced workbook, a corrected total or different
terms make the approval stale, and final approval refuses it by name
(`ORDER_SUBMISSION_EXCEPTION_STALE`) rather than as "not enough payment" — a
different person has to do a different thing. The reason is frozen while an
approval stands, and the recorded basis can only move with the decision itself.

**A pre-Phase-3 approval recorded no basis and is never current.** It was a
decision about a declared advance, which is a different question from verified
payment; the migration reports how many PIs that affects rather than backfilling
one.

### Test Data Cleanup

`resolve_test_data_cleanup_chain()` reaches a payment three ways: the legacy
order/order-request link, an allocation still naming the PI (its reversed
history), and an allocation that has MOVED onto the Order. The third branch is
Phase 3's own — without it a converted test chain hid its payments and the NO
ACTION foreign key refused the Order delete with a raw constraint error.

### Known inconsistency, NOT fixed here

After the move the parent payment still carries `order_id = NULL` and
`approved_unlinked`, so Finance's linked/unlinked split — which reads only those
legacy columns — puts it in **Non-Linked Payments** and the counters over-report.
It cannot be fixed by linking the payment: `approved_linked` requires
`order_number`, and on a PI payment that column holds the salesperson's
reference. See `docs/Module Docs/PAYMENT_PHASE_PROGRESS.md` → *Blocker held for a
decision* for the two costed options. The PI side, the Order side and the
allocation trail are all correct; only the Finance classification is wrong.

### Trails

`allocation_moved` on the payment's Finance trail (server-derived, from the same
trigger that writes `allocation_created`), `payment_allocations_moved` on the PI,
and `payment_route` / `verified_payment` / `required_payment` on the existing
`approved` event. A **refused** approval writes nothing — the function raises, and
a row written inside a transaction that raises would vanish with it.

---

## 10. Recommended next small task

**Resolve R1b, apply the three migrations, run the assertion scripts, then close
D7.**

R1b first, because it is a blocker rather than a task: `db push` would carry an
unrelated session's destructive assets migration with it.

Then D7 — an authenticated user creating a Confirmed Order directly, bypassing
conversion and burning an order number — because it is a Priority A hole in the
same table this branch just hardened, and leaving it open undercuts the rest.

Then the missing-document double confirmation (§4.5): smallest remaining
requirement with a real operational cost, and it needs no new data model.

After that, the adjustment/refund table (§4.1) — it unblocks §8.1, §8.3, §8.5,
§8.7 and §7.5 together, and every one of those is currently waiting on the same
missing model.
