# Order Management — Payment work, phase by phase

A running record of the payment workstream, so the next session can pick it up
without re-deriving what was decided and why. One entry per phase, newest last.

---

## Phase 1 — the allocation database foundation

| | |
|---|---|
| Status | **Merged and applied to production** |
| PR | [#42](https://github.com/nishantsoni7/boe-task-management/pull/42) |
| Squash merge | `871cbfda1331716ba7f759820c74a4f4784770fd` |
| Migration | `20260918000000_finance_payment_allocations.sql` |
| Verified by | Nishant, from the linked Windows environment |

**What it delivered.** `public.finance_payment_allocations` — a child of
`finance_payment_requests`, which remains the only payment ledger — recording how
much of one payment is claimed by one PI submission or one Confirmed Order. The
unallocated balance is derived (`amount − sum(active allocations)`) and never
stored. Allocations are reversed, never deleted. Two protected Finance actions,
`finance.allocate` and `finance.allocate_correct`, granted to nobody.

**Deliberately deferred, and recorded at the time:**

1. **Parent payment visibility** for PI/Order participants — paid by Phase 2.
2. **Cleanup-chain discovery** of PI-only allocated payments — paid by Phase 2.

---

## Phase 2 — recording a payment against a PI

| | |
|---|---|
| Status | **Merged and applied to production** |
| PR | [#43](https://github.com/nishantsoni7/boe-task-management/pull/43) |
| Squash merge | `8d3bbe61a67d6627e321adc0ccd8958c420749f7` |
| Migration | `20260919000000_pi_submission_payment_entry.sql` |

**What it delivers.** The entry point Phase 1 had no way to reach: a payment can
now be recorded against a PI submission before any Order exists, from the PI
detail page, at every open stage (draft, submitted, under review, needs changes).

* `record_pi_submission_payment(...)` — records the payment **and** its full
  allocation in one transaction. No exception handler, so atomicity is structural
  rather than compensating.
* `pi_submission_payment_summary(uuid)` — the card's rows and its five totals,
  computed in `numeric` in the database. No financial arithmetic in the browser.
* `allocate_payment_to_target_internal(...)` — Phase 1's rules, now shared by two
  doors so the PI path can reuse them without duplicating a financial rule.
  `allocate_payment_to_target` keeps its exact signature and still requires
  `finance.allocate`.
* Participant SELECT visibility on `finance_payment_requests` and
  `payment_proof_attachments`, with the Finance module gate **restated** rather
  than dropped so the Finance pages stay gated.
* `resolve_test_data_cleanup_chain()` sweeps PI-only allocated payments.
* `received_in` becomes nullable — NULL means *not stated*, never `'other'`.
* One `Payments` card on the PI detail page.

**Not changed:** the Order approval gate still reads the declared advance; no new
payment status; no new permission action; no payment splitting; no PI-to-Order
allocation movement.

**Found by the pre-deployment audit of PR #43:**

* Making `received_in` nullable was only half the job. The Payment Requests edit
  modal seeded its destination from `readDestinationKey()` — whose documented
  fallback is the DEFAULT account — and wrote **both** halves of the pair
  unconditionally on save. A PI payment recorded as *UPI, account not stated*
  became *Bank Transfer / HDFC* the moment anyone opened that modal and saved any
  field. Fixed with `readDestinationKeyOrNull()` and a conditional write.
* The `draftsAccess` "only writes are the status RPCs" guard went **blind** when
  the payment write moved behind a library wrapper — it scans the page file for
  `.rpc(`. It now also names every indirect write the page reaches, on a closed
  list, and a probe importing an unlisted helper fails it.

**Two defects this phase's own tests caught, worth remembering:**

* The authorization branch read
  `admin OR submitted_by = actor OR created_by = actor OR assigned_to = actor`.
  `assigned_to` is nullable, so on any PI with no named reviewer the whole
  expression evaluated to `NULL` and `if not NULL` never fired — it failed
  **open** for every unrelated caller. Now wrapped in `coalesce(…, false)`.
* Phase 1's allocation door required `finance.allocate`, which a PI's own
  uploader does not hold, so the atomic RPC refused the primary use case. Fixed
  by the two-door split rather than by widening the door.

---

## Hotfix — Finance/Admin could not verify a payment

| | |
|---|---|
| Status | **Merged and applied to production** |
| PR | [#44](https://github.com/nishantsoni7/boe-task-management/pull/44) |
| Squash merge | `f5613dea8adabe7b5065ddd00651dcb59a18dc16` |
| Migration | `20260920000000_finance_approver_can_verify_payment.sql` |
| Reported against | `PAY-REQ-2026-0038`, a payment recorded from a PI |

Reported as one problem. It was two, sitting on top of each other, and only the
first is about PI payments at all.

### Defect 1 — the UI had no verification control on the route people take

Verification lived in exactly one place: `AdminReviewModal`, opened only by
clicking a table **row**, and only for a viewer holding the approval capability.
The row's explicit **View** button opened `DetailsModal` instead — which offered
Pending Review / Needs Clarification / Rejected and Delete / Edit, and no way to
verify anything. An administrator taking the obvious route was stuck.

This was never PI-specific: *any* pending payment opened through View was stuck.
PI payments merely made it the common case, because a PI payment is the kind
somebody goes looking for rather than triages from the list.

Fixed in the UI alone. `DetailsModal` gained a **Verify Payment** panel above
Admin controls, with a two-step confirmation, a ref-guarded submit, and the
existing RPC underneath. The rule is one exported function,
`canVerifyPayment(status, mayApprove)` — approval capability **and**
`pending_approval`, nothing else — so the modal and the row cannot disagree.

Not put in the status-correction dropdown, deliberately: `20260692000000` removed
both approved statuses from `STATUS_CORRECTION_OPTIONS` precisely because
reaching them needs the RPC's row locking and `order_id` bookkeeping. A protected
server action gets a primary button; it does not become an option in a `<select>`.

### Defect 2 — no non-admin approver could verify ANY payment

Found while writing the backend assertions for defect 1, and invisible to
admin-only testing.

`20260901000000` §4a added `finance_payment_requests_guard_pending_decision` so a
`finance.approve` holder could **decide** a pending request without being able to
rewrite it — an RLS `WITH CHECK` sees only the new row, so it cannot say "the
amount may not change". Its stated intent was that everyone else "may change only
the three decision columns" (`status`, `admin_note`, `updated_at`).

But `approve_finance_payment_request` writes **five**: it also stamps
`approved_by` and `approved_at`, which is the whole point of an audit trail. Both
were on the guard's refusal list, so the sanctioned approval path raised

```
42501  Payment PAY-REQ-… may be approved or rejected, not edited
```

for every non-admin approver — PI payment, Order payment and Order Request
payment alike. Admins were exempt from the guard, which is why this never showed
up until a non-admin approver was put in front of it.

`20260920000000` fixes it with the project's existing capability-marker pattern,
taken verbatim from `in_payment_allocation_release` (`20260918000000` §7): the
RPC marks the one payment it is deciding, transaction-locally, and the guard
steps aside for exactly that row. The marker is set immediately before the
statement, cleared immediately after, and sits behind a predicate function
revoked from every client role.

**Nothing was widened.** The gate is still, and only,
`actor_has_module_permission('finance', 'approve')`. `finance.view`,
`finance.view_all`, `finance.manage` and `finance.allocate` remain no route to
verification, and outside the RPC the guard still refuses every column it
refused before — proven from both sides in
`supabase/tests/finance_payment_verification_assertions.sql`.

### What the fix does not change

A verified PI payment still lands in `approved_unlinked` with `order_id` left
null; its allocation keeps its id, status, amount and PI; the payment keeps its
id and number; nothing is copied. Needs Clarification and Rejected remain
separate decisions on the direct-update route, and neither status can be verified
without travelling back through correction first. The Order approval gate and the
declared-advance rule are untouched.

### Worth remembering

* The repo's `migrationContract` suite finds "the last definition before ours" by
  excluding **one filename**, not by comparing timestamps. A later migration
  restating one of the eleven functions therefore became its own baseline and
  reported a long-since-made substitution as missing. Now bounded with `<`.
* A guard that greps for a comment pattern needs to match the comments actually
  written: `/^ *-- .*\n/` silently skipped bare `--` separator lines, which was
  enough to make a faithful restatement look unfaithful.

---

## Phase 3 — the verified-payment approval gate

| | |
|---|---|
| Status | **PR open, not merged. Migration NOT applied.** |
| Branch | `claude/boe-verified-payment-approval-phase3-hgevan` |
| Migration | `20260921000000_order_submission_verified_payment_gate.sql` |
| Built on | `f5613dea8adabe7b5065ddd00651dcb59a18dc16` (production `main`) |

**The rule that changed, in one line.** An Order number is assigned only when at
least **40% of the PI's grand total has actually been received and verified by
Finance**, or when an authorised approver has accepted proceeding on less.

| | Before | After |
|---|---|---|
| What the gate reads | `order_submission_advance_ready(advance_condition, advance_exception_percent, advance_exception_status)` — a DECLARATION | `order_submission_payment_ready(grand_total, VERIFIED PAYMENT summed live from `finance_payment_allocations` under row locks, advance_exception_status)` |
| When it is read | at approval, from stored columns | at approval, re-derived from allocation rows under `FOR UPDATE` |
| What a declared advance does | decides whether an Order exists | **nothing** |
| What the salesperson declares | an advance amount, on every submission | nothing; a reason and Payment Terms only when below the requirement |

### The two routes

**Standard.** `verified >= grand_total * 40 / 100`, compared as exact `numeric`
and never as a rounded displayed percentage. 40% of ₹100.01 is ₹40.004, and
₹40.00 — which displays as "40%" — does not meet it. No exception is needed, and
a pending one simply stops mattering.

**Reduced or zero payment.** Below the requirement — zero included — the PI may
still be submitted for management review, but:

* a **reason** for asking to confirm an Order below 40% is mandatory;
* **Payment Terms** are mandatory;
* the request goes to the **existing** advance-exception route
  (`orders.approve_advance_exception`, `approve_pi_advance_exception`,
  `reject_pi_advance_exception`), which is adapted rather than duplicated;
* management may review the PI while the exception is pending;
* **no Order number is assigned** until it is approved;
* a rejection returns the PI to Needs Changes, exactly as before.

### What counts, and what does not

`order_submission_verified_payment(uuid)` sums **active** allocations naming the
PI whose **parent payment** is verified by Phase 1's single rule,
`finance_payment_status_is_verified(text)`. So `pending_approval`,
`needs_clarification`, `rejected` and any **reversed** allocation count as
nothing — and an approved exception never converts unverified money into verified
money. Finance verification of a payment and the PI Finance check remain two
separate actions, both required, neither standing in for the other.

### Legacy declared-advance treatment

**No column is dropped and no historical value is rewritten.**

| Column | Status after Phase 3 |
|---|---|
| `advance_declared_amount` | **Legacy.** Retained and readable; gates nothing; new submissions do not ask for it and write NULL. |
| `advance_exception_percent` | **Re-purposed.** Now the verified-payment percentage at the moment the exception was requested — a snapshot for the reviewer and the trail, never the gate. Pre-Phase-3 rows keep their original meaning. |
| `advance_condition` | **Operational.** `standard` / `exception`, now read as the payment route. |
| `advance_exception_status` / `_reason` / `_requested_by` / `_requested_at` / `_decided_by` / `_decided_at` / `_rejection_reason` | **Operational.** They carry the reduced-payment exception unchanged. |

`order_submission_advance_ready(text, numeric, text)` still exists and is still
correct about what it describes; nothing consults it any more.

### Payment Terms and Billing Terms

Two new plain-text columns on `order_submissions`, non-blank when present and at
most 500 characters. Payment Terms are the agreed collection arrangement
(*"30% advance, 30% during production, 40% before dispatch"*); Billing Terms are
the agreed invoicing arrangement (*"100% invoice before dispatch"*). Payment
Terms are mandatory only on the reduced-payment route; Billing Terms are always
optional. **Nothing parses either of them** — no instalments, no schedules, no
due-date tracking, no reminders.

### PI-to-Order allocation continuity

At approval, inside the one transaction that creates the Order, the PI's **active
allocations MOVE onto it**:

* one `UPDATE`; no `INSERT`, no `DELETE`, no payment row created or copied;
* allocation ids, `payment_request_id`, amounts, `created_by`, `created_at` and
  `origin_target_type` are all unchanged, so provenance survives;
* reversed allocations stay with the PI — that history belongs to it;
* the PI stops counting the money and the Order starts, without a figure being
  rewritten anywhere;
* payment proof, verification status and Finance history stay attached to the
  same payment row, findable by the same id.

`finance_payment_allocations_guard_transition()` is **restated**, which
`20260918000000` §6 said in as many words that Phase 3 would have to do. The one
new move is admitted only when the transaction is inside
`approve_order_submission()` **for that submission**, the allocation is active and
names that submission, and the destination Order's `source_order_submission_id`
is that submission. Everything else stays immutable, a reversal is still terminal,
and there is no exemption for any role including the service role.

If anything fails, the whole transaction rolls back: no Order row, no Order
number consumed, no moved allocation.

### Activity and notifications

* `finance_payment_request_activity_log` gains **`allocation_moved`**, written by
  the same trigger that writes `allocation_created` and `allocation_reversed`,
  carrying both ends of the move and the unchanged provenance.
* `order_submission_activity` gains **`payment_allocations_moved`**.
* The `approved` event now carries `payment_route`, `verified_payment` and
  `required_payment`, so the trail records **why** the approval was allowed
  without inventing a second event for it.
* The exception reuses `advance_exception_requested` / `_approved` / `_rejected`.
* A **refused** approval writes nothing, deliberately: `approve_order_submission()`
  raises, and a row written inside a transaction that raises would vanish with it.
* Three notification types — `pi_exception_requested` (to everyone who may
  decide), `pi_exception_approved` and `pi_exception_rejected` (to the submission
  owner) — through a new server route that mirrors the existing Finance/Orders
  notify pattern. Recipients are resolved server-side by
  `users_with_module_permission('orders','approve_advance_exception')`.

### UI

* **Submit for Review** no longer asks for a declared advance at all. It states
  the live position — Grand Total, Verified Payment, Verified Payment %, Awaiting
  Verification, Needed for Standard Approval — and says *Standard payment
  requirement met* or *Admin approval required to proceed below 40%*. Below the
  requirement it asks for a reason and Payment Terms; Billing Terms stay optional.
* The **PI Payments card** gains the Grand Total tile, the approval position with
  its own sentence, and the agreed terms. It shows no declared advance.
* The **commercial snapshot** at the top of the PI now reports **Verified
  payment** and the approval position, in place of the declared advance.
* The **Order detail** page reads its own active allocations alongside the legacy
  `order_id` link, deduplicated by payment id, so a converted PI's money is
  visible on the Order.

### Not changed

Numbering (no second allocator; a cancelled number still cannot be reused; a PI
held for insufficient payment or a pending exception is assigned none); the
Finance verification flow; the payment-splitting UI; unallocated-funds selection;
allocation-correction requests; the Confirmed Payments view; Debit Notes; refunds;
Order cancellation; Excel or PDF generation.

---

## What remains

**Phase 4 and beyond, in no fixed order:** payment splitting across several
PIs/Orders in the UI; unallocated-funds selection; allocation-correction
requests; the Confirmed Payments view rename; Debit Notes and refunds; Order
cancellation and the post-Order commercial change requests that depend on it;
numbered Excel and PDF generation.
## What remains

### Known limitation carried forward

Proof **objects** are still visible only to the payment's submitter and to an
admin (`20260672`). A PI owner who did not enter the payment sees that a proof
exists but cannot open it; the card asks the server and hides the action rather
than offering one that would fail. Widening proof-object visibility to PI
participants is a deliberate, separate decision.
