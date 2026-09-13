# BOE Credits

**Status (verified with `supabase migration list --linked`, 2026-09-13):**
Phases 1A–1D (`20261101000000`–`20261104000000`), decimal credits
(`20261204000000`) and Custom Review Submissions (`20261205000000`) are
**applied**. **The Custom Review phase — `20261206000000_customer_review_custom_reapply_and_monthly_rules.sql`
(monthly submission rules, reapplication, the new settings row with the 1.5
image reward) — is in the repository and NOT yet applied.** **The attendance
redemption switches — `20261208000000_boe_credits_redemption_toggles.sql` — are
in the repository and NOT yet applied.**

This document is the technical and business reference. Where an earlier phase's
rule changed, the current rule is stated and the old one is noted; nothing
already recorded was re-valued. The Review Workflow side is in
`docs/Module Docs/CUSTOMER_REVIEW_OUTREACH.md`.

---

## 1. The rules, in one place

| Setting (global, admin-managed, newest row active) | Custom Review phase value |
|---|---|
| `credit_value` — rupees ONE credit adds to salary | **₹50** |
| `review_reward_credits` — credits ONE approved **Text** Review earns | **1** (₹50) |
| `image_review_reward_credits` — credits ONE approved **Image** Review earns | **1.5** (₹75) |
| `minimum_monthly_reviews` — approved reviews a review month needs | **3** |
| `max_monthly_review_submissions` — custom reviews an employee may submit a month | **10** |
| `minimum_monthly_image_reviews` — of those, Image Reviews required | **3** |
| `half_day_redemption_credits` — cost of covering a chargeable Half Day | **8** (carried over) |
| `full_day_redemption_credits` — cost of covering a chargeable Absent day | **15** (carried over) |
| `half_day_redemption_enabled` — whether a chargeable Half Day may be covered at all (`20261208000000`) | **off** (column default off); an administrator may switch it on |
| `full_day_redemption_enabled` — whether a chargeable Absent day may be covered at all (`20261208000000`) | **off** (column default off); an administrator may switch it on |

`20261206000000` inserts ONE new settings row with the first six values and the
attendance prices of the row in force, only if the newest row does not already
say exactly that. Before it, production's active row was ₹50, text 1, image 1.
Earlier history: Phase 1D seeded 1 credit / ₹100 / 8 / 15 / 3.

Every change **applies to future actions only**. Rewards, redemptions and
payroll applications already recorded keep the numbers written on them.

1. **Earning.** An approved review posts exactly one `review_reward` row for its
   employee, in the same transaction as the approval, priced by the review's
   stored type: Text → `review_reward_credits`, Image →
   `image_review_reward_credits`. Never both.
   * **Custom review** (the current path): `approve_customer_review_custom_submission()`,
     source `customer_review_custom_submission` / submission id. A verifier
     confirms the configured amount; only `can_manage_boe_credits()` may award
     another. Approving again posts nothing.
   * **Generated review** (paused for candidates): `submitted → verified` in
     `transition_customer_review_test_card()`, source `customer_review` / card id.
2. **Attribution.** A custom review counts for the **Asia/Kolkata month of its
   first submission** (`submitted_at`, never overwritten — a reapplication keeps
   it). A generated review counts for the month of its latest submission.
   Submitted 30 Sep 23:59 IST, approved 2 Oct → September.
3. **Provisional.** Until the employee's month has `minimum_monthly_reviews` (3)
   approved reviews, that month's review credits are **recorded but not
   spendable**. Older credits are untouched. Displayed as *Pending*.
4. **Qualification.** The approval that reaches the minimum flips the month to
   `qualified`: all its still-valid rewards become spendable; further rewards in
   that month are spendable immediately. The minimum that applies is the one
   **snapshotted when the month row was created** (first reward of the month).
5. **No penalty for missing the minimum.** Nothing posts a negative row because
   a month has 0, 1 or 2 approved reviews — such a month simply earns nothing
   usable. **Finalization** (admin, explicit, after the month has ended IST): a
   qualified month is stamped finalized; a month below the minimum **lapses**
   with ONE `review_month_lapse` row removing exactly that month's still-valid
   (provisional) review credits — never more, never credits held before.
   Idempotent. No scheduler.
6. **A closed month earns nothing new.** A custom review whose month has lapsed
   can no longer be approved or reapplied (`CUSTOMER_REVIEW_CUSTOM_MONTH_CLOSED`):
   a reward posted into a lapsed month would be spendable at once, because only
   open months are provisional.
7. **Individual reversal.** An invalid review's reward is reversed by an admin
   (History → *Reverse this entry*, or `POST /api/boe-credits/reversals`).
   Before finalization it drops out of the month's count; after a qualified
   month closed it does not reopen the month; a reward whose month **lapsed**
   cannot be reversed; a lapse row itself cannot be reversed (post an adjustment).
8. **Attendance.** A chargeable Half Day costs `half_day_redemption_credits`, a
   chargeable Absent day `full_day_redemption_credits`, read at redemption and
   written on the record — **only while that kind is switched on** (see
   *Attendance redemption switches* below).
9. **Payroll.** The employee applies N **spendable** credits to an unlocked,
   generated payroll month as a salary addition of round(N × `credit_value`, 2),
   both snapshotted. At most one active application per employee-period; the
   same N twice is a no-op; a locked period freezes it; regeneration never
   re-prices it. 1.5 credits × ₹50 = ₹75.00.
10. **Carry forward.** Available credits never expire.
11. **Balances.** `recorded = SUM(ledger)`, `provisional = un-reversed rewards
    of open months`, `spendable = recorded − provisional`. A redemption is
    checked against **spendable**, under the per-employee advisory lock.

### Decimal credits (`20261204000000`)

Every credit amount is `numeric(12,2)`: 1.5 is one and a half credits, a third
decimal place is refused (`BOE_CREDITS_PRECISION`) rather than rounded, and
every balance, month total and payroll amount is exact. Attendance prices and
the monthly counts stay whole numbers.

### The monthly submission rules (`20261206000000`)

Two settings that act at SUBMISSION, not at approval — the Review Workflow
enforces them in `check_customer_review_custom_month_rules()`:

* at most `max_monthly_review_submissions` custom reviews per employee per IST
  month; every submitted review holds its slot; a reapplication takes none;
* a Text Review only when `max − (submitted + 1) ≥ max(0, min_images − images)`.

They are separate from the credits minimum: *3 approved reviews to earn* is not
*3 Image Reviews submitted*.

### Attendance redemption switches (`20261208000000`)

Two booleans on the settings row, `half_day_redemption_enabled` and
`full_day_redemption_enabled`, each with a switch on `/payroll/credits`. **Both
are OFF.** The columns default **false** — redemption is optional, and a
settings row does not switch it on unless an administrator does. Adding the
columns gives every existing row, the active one included, `false` without
updating or inserting a row (earlier settings-history rows therefore also show
"(off)"); the stored Half Day / Full Day prices are untouched. The in-code
fallback `DEFAULT_BOE_CREDIT_SETTINGS` is also **false**, so a screen that cannot
read the row never offers one. Switching either on is an ordinary settings save —
its own history row, future actions only.

A switched-OFF kind of day:

* **is not offered** — `attendanceRedemptionEligibility()` refuses it
  (`redemption_disabled`), so the payslip's `redeemable_dates` omits it and
  `POST /api/boe-credits/redemptions` answers 422;
* **is refused by the database** — the `BEFORE INSERT` trigger
  `boe_credit_attendance_redemptions_enabled_guard` on
  `boe_credit_attendance_redemptions` raises `BOE_CREDITS_REDEMPTION_DISABLED`;
* **is not explained** — My Credits and How BOE Credits Work render only
  switched-on redemptions; with both off neither page names attendance
  redemption;
* **keeps its price** — while off the price is not required or validated, and
  the parser carries the price in force;
* **never changes the past** — existing records, ledger rows and balances stay;
  the coverage lifecycle skips an Absent → Half Day re-price while Half Day is
  off and leaves the absent-day coverage in place.

---

## 2. Objects

### 2.1 Foundation (`20261101000000`)

* `boe_credit_transactions` — the append-only ledger. `employee_id`,
  `transaction_type`, signed `credits` (numeric(12,2) since `20261204000000`,
  never 0), `source_type` + `source_id`, nullable `payroll_period_id`,
  `description`, `created_by`, `created_at`. `BEFORE UPDATE OR DELETE` refuses
  everybody, the service role included.
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
| `boe_credit_settings` + 3 columns | `half_day_redemption_credits` (8), `full_day_redemption_credits` (15), `minimum_monthly_reviews` (3); `credit_value > 0` |
| ledger kind `review_month_lapse` | negative; `source_type 'boe_credit_review_month'`, `source_id` = the month row → the uniqueness index makes a second lapse impossible; admin actor; never checked against the balance |
| `boe_credit_review_months` | one row per employee + `review_month` (first day, IST): `minimum_reviews_snapshot`, `qualifying_review_count`, `earned_review_credits` (still-valid), `status open/qualified/lapsed`, `qualified_at`, `finalized_at/by`, `lapse_transaction_id`. Guard trigger: identity and minimum never move, lapsed is final, qualified never un-qualifies, finalized never re-finalized |
| `boe_credit_review_rewards` | one row per reward ledger row: `card_id`, `card_ref` (for a custom review: the submission id and `CR-…` reference), `submitted_at`, `review_month`, `review_month_id`. Append-only |
| `boe_credit_payroll_applications` | `credits_used`, `credit_value_snapshot`, `credit_amount_snapshot`, `redemption_transaction_id`, `reversal_transaction_id/reversed_at`; partial unique active per employee-period; close-once guard |
| `boe_credit_provisional_credits(uuid)`, `boe_credit_spendable_balance(uuid)` | SECURITY INVOKER reads |
| `boe_credit_balances` (view) | `available_credits` (recorded), `provisional_credits`, `spendable_credits`, counts |
| `post_boe_credit_transaction(...)` | five kinds; redemption checked against **spendable**; the ONE non-admin reversal: an employee reversing their own `payroll_redemption` |
| `boe_credit_reversal_guard()` / `boe_credit_reversal_effects()` | refuse reversing a lapsed month's reward, a lapse row, a redemption in a locked payroll month; a reversed reward refreshes its month; a reversed payroll redemption closes its application |
| `post_boe_credit_review_reward(...)`, `refresh_boe_credit_review_month(...)`, `finalize_boe_credit_review_month(...)` | reward + record + month; recount (`open → qualified` only); close (qualified → finalized, below minimum → lapse) |
| `redeem_boe_credits_for_attendance(...)`, `apply_boe_credits_to_payroll(...)`, `remove_boe_credit_payroll_application(...)` | settings-priced attendance; payroll salary addition |

### 2.4 Decimal credits (`20261204000000`)

Five amount columns → `numeric(12,2)`; the three balance functions and the view
return numeric; `post_boe_credit_transaction` and `apply_boe_credits_to_payroll`
take `numeric` (the integer signatures dropped); every PL/pgSQL variable that
carried an amount is numeric, because an `integer` variable silently ROUNDED
1.5 to 2.

### 2.5 Custom Review Submissions (`20261205000000`) and the Custom Review phase (`20261206000000`)

| Object | What it is |
|---|---|
| `post_boe_credit_custom_review_reward(employee, submission, ref, credits, submitted_at, actor)` | service role; one `review_reward` (source `customer_review_custom_submission`), the reward record and the month, under the employee lock |
| `approve_customer_review_custom_submission(uuid, numeric)` | browser RPC; verify, never self, row locked, already-approved posts nothing; **since 20261206** takes the employee's credits lock and refuses a lapsed month |
| `boe_credit_settings` + 2 columns | `max_monthly_review_submissions` (default 10), `minimum_monthly_image_reviews` (default 3, ≤ the maximum) |
| `check_customer_review_custom_month_rules(...)` | the submission cap and image mix (service role) |

**RLS.** Every credits table: RLS on, ONE `SELECT` policy (`employee_id =
auth.uid() OR can_manage_boe_credits()`), all client writes revoked, anon blind.
Every write function is service-role only with `search_path = public, pg_temp`;
the two review decisions are `authenticated`-callable on their signatures.

### Ledger source vocabulary

| `transaction_type` | sign | `source_type` / `source_id` |
|---|---|---|
| `review_reward` | + | `customer_review` / card id **or** `customer_review_custom_submission` / submission id |
| `redemption` | − | `attendance_redemption` / record id **or** `payroll_redemption` / application id |
| `reversal` | −original | `boe_credit_transaction` / the reversed row |
| `admin_adjustment` | any | `manual` / none (reason mandatory) |
| `review_month_lapse` | − | `boe_credit_review_month` / month row — removes only that month's provisional review credits |

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
text, and the next month's proposed carry-forward (`previousClosingBalance`).
`payroll_results.net_salary` is unchanged in meaning and is not the final figure.

Example: normal payable ₹30,000, 5 credits × ₹50 → Salary Payable ₹30,250.

---

## 4. Code

* `src/lib/boeCredits/` — `types.ts`, `settings.ts` (defaults = the Custom Review
  phase row, the parser for all eight fields, `parseBoeCreditSettingsRow`),
  `ledger.ts` (pure: sums, running balance, human descriptions), `service.ts`
  (reads and the RPC wrappers), `attendanceRedemption.ts`, `paths.ts`.
* Routes (`src/app/api/boe-credits/`): `settings` (GET any employee / PUT admin),
  `ledger`, `balances`, `adjustments`, `redemptions`, `payroll-applications`,
  `review-months` (the month close; counts custom reviews still Pending Approval
  as unresolved), `reversals`.
* Employee: `/my-credits` (balance, uses, this month's target, activity),
  `/my-credits/how-it-works` (driven by the live settings; the below-target
  example shows the month earning nothing — no negative row),
  `CreditsSummaryCard`, `PayrollCreditsPanel`.
* Admin: `/payroll/credits` — the settings form (all eight fields,
  future-only), month close, balances, History with *Reverse this entry*,
  Adjust, settings history.
* **Review Workflow:** the candidate's My Reviews shows the reward rules from
  the live settings and **This month / Last month** — approved vs the minimum,
  the image requirement, submitted vs the maximum, whether a Text Review is
  allowed now, and the month's review credits (spendable, pending or lapsed) —
  computed by `summarizeCustomReviewMonth()` from the month row
  (`qualifying_review_count`, `earned_review_credits`, `status`). See
  `CUSTOMER_REVIEW_OUTREACH.md` §15.

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
* A month below its minimum is never charged anything beyond its own
  provisional review credits.
* A locked payroll month freezes its coverage and its application, including
  against a direct admin reversal.
* Historical values are snapshots: attendance cost on the record, rate and
  rupees on the application, minimum on the month row, the reward on the ledger
  row and on the submission.

## 6. Tests

* `src/lib/boeCredits/{settings,ledger,service,migration,reviewReward,attendanceRedemption,phase1d,decimalCredits}.test.ts`
* `src/app/api/boe-credits/routesAuthority.test.ts`
* `src/lib/payroll/{settlement,salaryReport,creditCoverage,engine.creditRedemption,resultDetailPayload.stale}.test.ts`
* `src/lib/customerReviews/{nextStep,customSubmissions,customMonthlyRules,customReviewPhase}.test.ts`
* Database: `supabase/tests/boe_credits_phase_1d_assertions.sql` via
  `run_boe_credits_phase_1d_local.sh`; `custom_review_submissions_assertions.sql`
  and `custom_review_phase_assertions.sql` via
  `run_custom_review_submissions_local.sh` (bare container; applies
  `20261204000000`–`20261206000000` twice, runs both suites twice: decimal
  ledger, the 1.5 reward, qualification at the third approval, no negative row
  for a short month, a lapse that removes only the provisional credits, the
  closed-month refusal, no repricing after a settings change).

## 7. Not built (by design)

Campaigns, per-employee rates, credit expiry, cash-out, transfers, a scheduler
for month close, charts/leaderboards, a Half Day = Full Day / 2 rule, a
negative penalty for missing the monthly minimum, automatic reversal on review
deletion (deleting a verified review stays a tombstone; an admin reverses the
reward explicitly).
