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
| Status | **PR open, not merged. Migration NOT applied.** |
| Branch | `claude/boe-verify-pi-payment-hotfix` |
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

## What remains

**Phase 3 — the verified-payment approval gate.** `approve_order_submission()`
still reads the DECLARED advance. Moving it onto verified allocated payment is
the next bounded change, and Phase 1 already wrote the rule it must consult:
`finance_payment_status_is_verified(text)`. It will also need the reduced/no-payment
exception route re-pointed at the same figure.

**Later, in no fixed order:** PI-to-Order allocation movement (the transition
guard on `finance_payment_allocations` must be restated then, on purpose);
payment splitting across several PIs/Orders in the UI; unallocated-funds
selection; allocation-correction requests; the Confirmed Payments view rename;
Debit Notes and refunds.

### Known limitation carried forward

Proof **objects** are still visible only to the payment's submitter and to an
admin (`20260672`). A PI owner who did not enter the payment sees that a proof
exists but cannot open it; the card asks the server and hides the action rather
than offering one that would fail. Widening proof-object visibility to PI
participants is a deliberate, separate decision.
