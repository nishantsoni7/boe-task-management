# BOE Credits

**Status:** Phases 1A–1C shipped 2026-09-02 (PRs #85, #86, #87; migrations
`20261101000000`–`20261103000000` applied). **Phase 1D — configurable settings,
monthly review qualification with provisional credits, settings-priced
attendance redemption, and the payroll salary addition — built 2026-09-03;
migration `20261104000000_boe_credits_phase_1d.sql` NOT yet applied to
production.**

This document is the technical and business reference after Phase 1D. Where
an earlier phase's rule changed, the current rule is stated and the old one is
noted; nothing already recorded was re-valued.

---

## 1. The rules, in one place

| Setting (global, admin-managed, newest row active) | Production value |
|---|---|
| `review_reward_credits` — credits ONE verified review earns | **1** |
| `credit_value` — rupees ONE credit adds to salary | **₹100** |
| `half_day_redemption_credits` — cost of covering a chargeable Half Day | **8** |
| `full_day_redemption_credits` — cost of covering a chargeable Absent day (independent; never derived from the half day) | **15** |
| `minimum_monthly_reviews` — verified reviews a review month needs | **3** |

Every change **applies to future actions only**. Rewards, redemptions and
payroll applications already recorded keep the numbers written on them.

1. **Earning.** `submitted → verified` in the Review Workflow posts exactly one
   `review_reward` row of `review_reward_credits` for the review's holder
   (`booked_by`), in the same transaction as the verification.
2. **Attribution.** The reward counts for the **Asia/Kolkata calendar month of
   `submitted_at`** — the successful submission the verifier is confirming —
   never `booked_at` or `verified_at`. Submitted 30 Sep 23:59 IST, verified
   2 Oct → September. A returned and resubmitted review carries the later
   submission's instant (the transition overwrites `submitted_at`).
3. **Provisional.** Until the employee's month reaches its minimum, that
   month's reward credits are **recorded but not spendable**. Older credits are
   untouched. Displayed as *Pending monthly target*.
4. **Qualification.** The review that reaches the minimum flips the month to
   `qualified`: all its still-valid rewards become spendable; further rewards
   in that month are spendable immediately. The minimum that applies is the
   one **snapshotted when the month row was created** (first reward of the
   month).
5. **Finalization** (admin, explicit, after the month has ended IST):
   a qualified month is stamped finalized; a month below the minimum
   **lapses** with ONE `review_month_lapse` ledger row removing exactly that
   month's still-valid reward credits. Idempotent: a finalized month is
   returned unchanged and never posts a second lapse. No scheduler.
6. **Individual reversal.** An invalid review's reward is reversed by an
   admin (History → *Reverse this entry*, or `POST /api/boe-credits/reversals`).
   Before finalization it drops out of the month's count; after a qualified
   month closed it does not reopen the month; a reward whose month **lapsed**
   cannot be reversed (its credit is already gone); a lapse row itself cannot
   be reversed (post an adjustment).
7. **Attendance.** A chargeable Half Day costs `half_day_redemption_credits`,
   a chargeable Absent day `full_day_redemption_credits`, read from the newest
   settings row at the moment of redemption and written on the record. A
   record priced at 1 credit under Phase 1C stays 1 credit.
8. **Payroll.** The employee applies N **spendable** credits to an unlocked,
   generated payroll month as a salary addition of N × `credit_value`, both
   snapshotted. Settlement adds it to Salary Payable; nothing in the payroll
   engine, gross salary, attendance or `net_salary` changes; it is not capped
   by gross or by any deduction. At most one active application per
   employee-period; changing it is a reversal + a new redemption (atomic); the
   same N twice is a no-op; a locked period freezes it; regeneration never
   re-prices it.
9. **Carry forward.** Available credits never expire.
10. **Balances.** `recorded = SUM(ledger)`, `provisional = un-reversed rewards
    of open months`, `spendable = recorded − provisional`. A redemption is
    checked against **spendable**, under the per-employee advisory lock.

---

## 2. Objects — the four migrations

### 2.1 Foundation (`20261101000000`)

* `boe_credit_transactions` — the append-only ledger. `employee_id`,
  `transaction_type`, signed integer `credits` (never 0), `source_type` +
  `source_id`, nullable `payroll_period_id`, `description`, `created_by`,
  `created_at`. `BEFORE UPDATE OR DELETE` refuses everybody, the service role
  included.
* `boe_credit_settings` — append-only; newest row active.
* `can_manage_boe_credits()` — an active, non-deleted admin.
* `post_boe_credit_transaction(...)` / `reverse_boe_credit_transaction(...)`
  — service role only; the only write paths.
* **The uniqueness rule:** `UNIQUE (employee_id, transaction_type, source_type,
  source_id) WHERE source_id IS NOT NULL` — one source event → at most one row
  of a kind per employee. One reward per review, one reversal per row, one
  lapse per month.

### 2.2 Review reward (`20261102000000`) and attendance redemption (`20261103000000`)

* The verify transition posts the reward in its own transaction (1B).
* `boe_credit_attendance_redemptions` — one row per covered day; closed once
  by the reversal of its ledger row (`AFTER INSERT` trigger on the ledger);
  `UNIQUE (employee_id, attendance_date) WHERE reversal_transaction_id IS NULL`.
  The lifecycle (`src/lib/payroll/creditCoverage.ts`) reverses coverage when
  the deduction stops existing and **re-prices only when the KIND of day
  changes** (Absent → Half Day), never because the price setting changed.

### 2.3 Phase 1D (`20261104000000`)

| Object | What it is |
|---|---|
| `boe_credit_settings` + 3 columns | `half_day_redemption_credits` (8), `full_day_redemption_credits` (15), `minimum_monthly_reviews` (3); `credit_value > 0`; one new active row `(1, 100.00, 8, 15, 3)` inserted idempotently; the Phase 1A row `(100, 1.00)` is kept as history |
| ledger kind `review_month_lapse` | negative; `source_type 'boe_credit_review_month'`, `source_id` = the month row → the uniqueness index makes a second lapse impossible; admin actor; never checked against the balance |
| `boe_credit_review_months` | one row per employee + `review_month` (first day, IST): `minimum_reviews_snapshot`, `qualifying_review_count`, `earned_review_credits` (still-valid), `status open/qualified/lapsed`, `qualified_at`, `finalized_at/by`, `lapse_transaction_id`. Guard trigger: identity and minimum never move, lapsed is final, qualified never un-qualifies, finalized never re-finalized |
| `boe_credit_review_rewards` | one row per reward ledger row: `card_id`, `card_ref`, `submitted_at`, `review_month`, `review_month_id`. Append-only. Attribution is decided once, here |
| `boe_credit_payroll_applications` | `credits_used`, `credit_value_snapshot`, `credit_amount_snapshot` (= credits × rate, CHECKed), `redemption_transaction_id`, `reversal_transaction_id/reversed_at`; partial unique active per employee-period; close-once guard |
| `boe_credit_provisional_credits(uuid)`, `boe_credit_spendable_balance(uuid)` | SECURITY INVOKER reads |
| `boe_credit_balances` (view) | `available_credits` (recorded), `provisional_credits`, `spendable_credits`, counts |
| `post_boe_credit_transaction(...)` re-created | five kinds; redemption checked against **spendable**; the ONE non-admin reversal: an employee reversing their own `payroll_redemption` |
| `boe_credit_reversal_guard()` (BEFORE INSERT) | refuses reversing a lapsed month's reward, a lapse row, and any redemption (attendance or payroll) inside a **locked** payroll month |
| `boe_credit_reversal_effects()` (AFTER INSERT) | a reversed reward refreshes its month; a reversed payroll redemption closes its application |
| `post_boe_credit_review_reward(employee, card, ref, submitted_at, actor)` | service role only (the transition calls it as owner): reward + record + month upsert + refresh, under the employee lock |
| `refresh_boe_credit_review_month(employee, month)` | recount un-reversed rewards; `open → qualified` only |
| `finalize_boe_credit_review_month(employee, month, actor)` | admin; month ended (IST); recount; qualified → finalized; below minimum → lapse; idempotent |
| `transition_customer_review_test_card()` re-created | byte-identical to 1B before the reward branch; the branch calls `post_boe_credit_review_reward` with `c.submitted_at`; returns `{card, reward: {transaction_id, credits, review_month, month_status, qualifying_review_count, minimum_reviews, provisional, employee_id, employee_name}}` |
| `redeem_boe_credits_for_attendance(...)` re-created | price from the settings; returns `available_credits` = the **spendable** balance afterwards |
| `apply_boe_credits_to_payroll(employee, period, credits, actor)` | employee-only actor; FOR SHARE on the period; refuses locked / ungenerated; idempotent for the same N; replace = reversal + new |
| `remove_boe_credit_payroll_application(employee, period, actor)` | employee-only; refuses locked; nothing-to-remove is not an error |

**Indexes.** `boe_credit_review_months (employee_id, review_month)` unique,
`(review_month, status)`; `boe_credit_review_rewards (review_month_id)` + PK on
`transaction_id`; `boe_credit_payroll_applications` partial unique
`(employee_id, payroll_period_id) WHERE reversal_transaction_id IS NULL` and
`(payroll_period_id, employee_id)`. The ledger keeps its foundation indexes.

**RLS.** Every Phase 1D table: RLS on, ONE `SELECT` policy (`employee_id =
auth.uid() OR can_manage_boe_credits()`), all client writes revoked, anon
blind. Every write function is service-role only with `search_path = public,
pg_temp`; the transition stays `authenticated`-callable on its signature.

### Ledger source vocabulary

| `transaction_type` | sign | `source_type` / `source_id` |
|---|---|---|
| `review_reward` | + | `customer_review` / card id |
| `redemption` | − | `attendance_redemption` / record id **or** `payroll_redemption` / application id |
| `reversal` | −original | `boe_credit_transaction` / the reversed row |
| `admin_adjustment` | any | `manual` / none (reason mandatory) |
| `review_month_lapse` | − | `boe_credit_review_month` / month row |

---

## 3. Settlement (Payroll)

```
salary_after_attendance = gross − attendance deductions      (floored at 0 when days_present = 0)
net_adjustments         = carry_forward + other_adjustments
boe_credit_addition     = active application's credit_amount_snapshot, or 0
salary_payable          = salary_after_attendance + net_adjustments + boe_credit_addition
closing_balance         = salary_payable − amount_paid
```

`computeSettlement(result, settlement, credits)` (`src/lib/payroll/settlement.ts`)
takes the application as its third input. Every surface that states the final
payable reads it: the payslip's settlement block (`buildSettlementBlock`), the
PATCH settlement route's confirmed figures, the salary report and its WhatsApp
text (a `BOE Credits: +₹500` line and *Amount Payable*), and the next month's
proposed carry-forward (`previousClosingBalance`). `payroll_results.net_salary`
is unchanged in meaning and is not the final figure.

Example: normal payable ₹30,000, 5 credits × ₹100 → Salary Payable ₹30,500.

---

## 4. Code

* `src/lib/boeCredits/` — `types.ts`, `settings.ts` (defaults + parser, five
  fields), `ledger.ts` (pure: sums, running balance, **human descriptions**),
  `service.ts` (all reads and the RPC wrappers), `attendanceRedemption.ts`
  (settings-driven eligibility), `paths.ts`.
* Routes (`src/app/api/boe-credits/`): `settings` (GET any employee / PUT admin),
  `ledger` (self-or-admin; three balances, explained rows with running balance,
  review months), `balances` (admin), `adjustments` (admin),
  `redemptions` (employee; attendance), **`payroll-applications`** (POST/DELETE,
  employee from the token, only `{payroll_period_id, credits}`),
  **`review-months`** (GET month status + unresolved-review warning, POST
  finalize; admin), **`reversals`** (admin).
* Employee: `/my-credits` (balance, uses, this month's target, activity),
  `/my-credits/how-it-works` (the knowledge page, driven by the live settings),
  `CreditsSummaryCard` on `/my-payroll`, `PayrollCreditsPanel` on
  `/my-payroll/[periodId]`, the *Use N credits* offer on deduction rows.
* Admin: `/payroll/credits` — settings form (five fields, future-only note),
  month close (warning for reviews still awaiting verification; one explicit
  close; idempotent), employee balances (spendable / pending / recorded,
  search), History with *Reverse this entry*, Adjust, settings history.
* Review Workflow: tiles say the next step; the detail carries a progress
  strip and "Go to it"; the To-verify notice says the credits and the month's
  standing ("2 of 3 this month").

## 5. Invariants

* Balance never goes below zero through a redemption; provisional credits are
  never spendable by any path (the check is inside the one write path, under
  the employee lock).
* Nothing on the ledger, the reward records, the month rows (past their
  status), or the applications is ever edited or deleted; corrections are new
  rows.
* One reward per review, one reversal per row, one lapse per month, one active
  application per employee-period, one active coverage per employee-day — all
  at the table.
* A locked payroll month freezes its coverage and its application, including
  against a direct admin reversal.
* Historical values are snapshots: attendance cost on the record, rate and
  rupees on the application, minimum on the month row.

## 6. Tests

* `src/lib/boeCredits/{settings,ledger,service,migration,reviewReward,attendanceRedemption,phase1d}.test.ts`
* `src/app/api/boe-credits/routesAuthority.test.ts`
* `src/lib/payroll/{settlement,salaryReport,creditCoverage,engine.creditRedemption,resultDetailPayload.stale}.test.ts`
* `src/lib/customerReviews/nextStep.test.ts`
* Database: `supabase/tests/boe_credits_phase_1d_assertions.sql` via
  `run_boe_credits_phase_1d_local.sh` (bare container; applies the chain twice,
  runs the 1D suite twice, then the 1C behavioural suite at the 1C prices).
  The transition itself is exercised on a full local stack (see the report).

## 7. Not built (by design)

Campaigns, per-employee rates, credit expiry, cash-out, transfers, a
scheduler for month close, charts/leaderboards, a Half Day = Full Day / 2
rule, automatic reversal on review deletion (deleting a verified review stays
a tombstone; an admin reverses the reward explicitly).
