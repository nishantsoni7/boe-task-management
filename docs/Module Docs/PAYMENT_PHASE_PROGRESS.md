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
| Status | **PR open, not merged. Migration NOT applied.** |
| Branch | `claude/boe-pi-payment-entry-phase2` |
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
