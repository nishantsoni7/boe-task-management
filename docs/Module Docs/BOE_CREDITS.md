# BOE Credits

**Status:** Phase 1A shipped 2026-09-02 (PR #85, `4ae3caa`, migration
`20261101000000` applied). Phase 1B — review reward — shipped 2026-09-02
(PR #86, `623ad7a`, migration `20261102000000` applied). Phase 1C —
attendance redemption — built 2026-09-02, local only, migration
`20261103000000` **not applied** to production.

## Phase 1C — an employee covers an attendance deduction with credits

| deduction | cost |
|---|---|
| Half Day | **1 credit** |
| Absent (full day) | **2 credits** |

Whole credits, fixed, and **not** linked to salary, rupees or
`credit_value`. The two literals live in `redeem_boe_credits_for_attendance()`
and in `ATTENDANCE_REDEMPTION_COST` (`src/lib/boeCredits/attendanceRedemption.ts`);
`attendanceRedemption.test.ts` pins them against each other. There is no
settings row for the cost, by design.

**Where.** `/my-payroll/[periodId]`, the employee's own payslip. A deduction
row whose day credits could cover carries a "Use 1 credit" / "Use 2 credits"
action; it opens a small confirmation (`RedeemCreditsModal`: the date, the
deduction removed, the credits used, the credits left) and posts
`{ payroll_period_id, attendance_date }` to `POST /api/boe-credits/redemptions`.
Afterwards the row reads **"Covered with 1 BOE Credit"** at ₹0. The admin's
Payroll Result Detail shows the same row the same way; the admin has no
redeem action.

**What qualifies.** Eligibility is asked of the payroll **engine's settled
deduction line**, never of the raw attendance status: an `absent` or
`half_day` line at more than ₹0 on a date up to today (IST), in an unlocked,
generated month. Refused, each with a sentence: late arrivals, early
departures, missing punches, short hours; a company-paid (paid-leave) day; a
day already covered; a future date; a locked month; a month with no
generated result for the employee. The route runs the engine over the
caller's live attendance, corrections, settings snapshot and existing
coverage and refuses before the database is asked; the browser's offer is
not trusted.

**How it is recorded — the foundation's vocabulary, unchanged.** One ledger
row of the existing kind `redemption` (negative), `source_type`
`attendance_redemption`, `source_id` = the id of the redemption record,
`payroll_period_id` set, `created_by` the actor, description
`Attendance redemption · 12 Aug 2026 · Half Day` — and, in the same
transaction, one row in **`boe_credit_attendance_redemptions`** (date, kind,
credits, `transaction_id`, period). No transaction kind is added or renamed:
the applied CHECK admits exactly `review_reward | redemption | reversal |
admin_adjustment`. The record exists because a ledger row cannot say which
day it covered or whether it was a half day.

**Active, closed, never edited.** A record is **active** while
`reversal_transaction_id IS NULL`. It is closed exactly once — by an `AFTER
INSERT` trigger on the ledger, the moment its ledger row is reversed by any
path — with the reversal's id and instant; a guard trigger refuses every
other UPDATE, every DELETE, and a hand-close with a foreign reversal, for
every role. `UNIQUE (employee_id, attendance_date) WHERE
reversal_transaction_id IS NULL` is the table-level guarantee of **at most
one active coverage per day**; the function pre-checks the same under the
per-employee advisory lock (taken first, before the period row, in both
functions). History is complete: redemption, reversal and any later
redemption of the same day are separate rows.

**Re-redemption after a reversal.** A reversed day drops out of the active
index, so once it carries an eligible deduction again it may be covered
again — a new record, a new ledger row. `redeem → reverse → redeem again`
is proven at the database (§12) and two active coverages can never coexist.

**Lifecycle — credits stay spent only while the deduction exists.** Both
write-intent engine paths (the attendance-correction route and payroll
generation) call `reconcileAttendanceCoverage`
(`src/lib/payroll/creditCoverage.ts`) before writing a result: for every
active redemption it compares the engine's settled line for that date and
   * reverses the redemption when the day is no longer a chargeable Absent /
     Half Day (corrected to Present, absorbed by paid leave, ₹0, or a
     half-day coverage on a day that became a full absence) — credits
     restored through `reverse_boe_credit_attendance_redemption()` by the
     admin, with the reason on the reversal row;
   * re-prices a day bought as Absent that became a Half Day — the 2-credit
     row is reversed and a fresh 1-credit redemption is posted by the admin
     on the employee's behalf (`redeem_boe_credits_for_attendance` admits an
     active admin actor for exactly this).
No ledger amount is edited and no balance is adjusted by hand. The
read-only previews and the day view never reconcile.

**Payroll effect.** The engine takes the coverage as its last argument
(`generatePayrollForEmployee(…, settings, redemptions)`), applies it **after**
paid-leave absorption and only to a line still chargeable, and settles that
line at ₹0 with `waived_by: 'boe_credits'` and `credits_redeemed`. The
classification, `days_absent`, `half_day_count`, the punches and the
attendance tables are untouched. Every engine caller passes the coverage —
generation, attendance correction, the monthly preview (both routes), the day
view — so a regenerated month carries each redemption exactly once. An
absent-day redemption still covers a day that later became a half day; a
half-day one does not stretch to a full absence.

**Generated and locked months.** The route requires a generated result and
refuses a locked period (`BOE_CREDITS_PERIOD_LOCKED`, and the period row is
read `FOR SHARE` so a concurrent lock waits). After the redemption commits it
regenerates the caller's result through the ordinary generation path
(`createGenerationRow` → `writeEngineResult` → `markAdjustmentsApplied`); if
that fails the redemption stands and the day view's existing staleness check
reports the stored money as out of date until the period is regenerated. An
unlocked month (status back to `generated`) admits redemption again; there is
no separate bypass.

**Security.** Both functions are service-role only; the redemption actor
must be the employee or an active admin; the route takes the employee from
the bearer token and accepts no employee id, cost, kind or balance from the
body. RLS on the record table: own rows or `can_manage_boe_credits()`; no
client writes.

**Old-code compatibility.** Migration `20261103000000` creates new objects,
adds one reversal-scoped `AFTER INSERT` trigger on the ledger and restates
two column comments; the runner diffs the foundation's function definitions,
constraints, indexes, columns, policies and view before and after and
requires them identical, so Phase 1B code keeps running while it is applied.

Proof: `src/lib/boeCredits/attendanceRedemption.test.ts`,
`src/lib/payroll/engine.creditRedemption.test.ts`,
`src/lib/payroll/creditCoverage.test.ts`,
`src/lib/payroll/resultDetailPayload.stale.test.ts` (the real stale helper),
the Phase 1C blocks in `service.test.ts` and `routesAuthority.test.ts`,
`supabase/tests/boe_credits_attendance_redemption_assertions.sql` executed
twice by `supabase/tests/run_boe_credits_attendance_redemption_local.sh` on a
bare PostgreSQL container, and the two-session races in
`supabase/tests/boe_credits_attendance_redemption_concurrency.sh`.

**Not built (by design):** admin/manual redemption, cash-out, partial
credits, advance redemption for future dates, a reversal UI (the service-layer
`reverseCreditTransaction` remains, admin-only), a separate admin management
page.

## Phase 1B — a verified review earns its reward

When a verifier moves a review `submitted → verified` through
`transition_customer_review_test_card()`, the same transaction posts exactly
one ledger row:

| field | value |
|---|---|
| `employee_id` | the review's **holder**, `customer_review_test_cards.booked_by` — never the verifier |
| `transaction_type` | `review_reward` |
| `credits` | the newest `boe_credit_settings.review_reward_credits` at that instant (no literal anywhere) |
| `source_type` / `source_id` | `customer_review` / the review's immutable `id` |
| `created_by` | the verifier (the actor whose decision it was) |
| `description` | `Review verified · <card_ref>` |

The function now returns `{ card, reward }` (jsonb). The detail screen goes
back to the To verify list exactly as it did before, carrying
`verified=<credits>` in the query string (the same one-shot flag pattern as
`?saved=1` on an order draft), and the list says "Review verified · +100
credits awarded to the tester." — credits, never rupees, and the number is the
one the database returned, never one the browser computed. The employee's own
`/my-payroll` card and history reflect the row with no further work.

**Why it cannot reward twice.** `verified` is terminal and the row is locked
before its status is read, so any retry, double click or concurrent request
is refused with `CUSTOMER_REVIEW_TEST_BAD_TRANSITION` before a reward is
attempted; the posting function's per-employee pre-check and the partial
unique index stand behind that.

**Not rewarded:** a return, a submit, a refused or unauthorized verify, a
pending or deleted review. **No backfill:** reviews verified before
`20261102000000` earn nothing from it; the migration's post-condition proves
it wrote zero ledger rows.

**Reversal is not wired.** The workflow has no unverify, reopen or
reject-after-verify; deleting a verified review is a tombstone (singly, in
bulk, or by replacement) and must not debit anyone. A wrong reward is
corrected by an administrator through the service layer's reversal or an
adjustment.

Proof: `src/lib/boeCredits/reviewReward.test.ts` (text) and
`supabase/tests/boe_credits_review_reward_assertions.sql` executed by
`supabase/tests/run_boe_credits_review_reward_local.sh` on a local Supabase
stack carrying the full Review Workflow chain.

Employees earn *credits*, never rupees. Phase 1A builds the ledger, the derived
balance, the settings, the permissions and the smallest read/adjust surface
that lets the foundation be verified. It deliberately does **not** connect
credits to the Review Workflow (1B), to Attendance deductions (1C) or to
Payroll (1D).

## The one rule

```
available credits = SUM(credits) over public.boe_credit_transactions
```

There is no stored balance. `public.boe_credit_balances` (a `security_invoker`
view) and `public.boe_credit_balance(uuid)` both sum the ledger on every read.
Corrections are new rows — a **reversal** (the original negated) or an
**admin adjustment** (any signed amount, with a mandatory reason). Nothing is
ever edited or deleted: a `BEFORE UPDATE OR DELETE` trigger refuses both for
every role, the service role included.

## Objects — `supabase/migrations/20261101000000_boe_credits_foundation.sql`

| Object | What it is |
|---|---|
| `boe_credit_transactions` | The append-only ledger. `employee_id`, `transaction_type`, signed integer `credits` (never 0), `source_type` + `source_id`, nullable `payroll_period_id`, `description`, `created_by` (null = system), `created_at`. |
| `boe_credit_balances` | View: `available_credits`, `transaction_count`, `last_transaction_at` per employee. Absent = zero. |
| `boe_credit_settings` | Append-only; newest row active. `review_reward_credits` (credits per verified review, default **100**) and `credit_value` (₹ per credit, default **1.00**). Two different things. |
| `can_manage_boe_credits()` | Management authority = an **active, non-deleted admin**. The one place to widen. |
| `post_boe_credit_transaction(...)` | **Service role only.** The only write path. |
| `reverse_boe_credit_transaction(...)` | **Service role only.** Posts the compensating row. |

### Transaction kinds

| `transaction_type` | Sign | `source_type` | Created by |
|---|---|---|---|
| `review_reward` | > 0 | `customer_review` | Phase 1B |
| `redemption` | < 0 | `payroll_period` | Phase 1C/1D |
| `reversal` | −original | `boe_credit_transaction` (the reversed row) | Phase 1A (service) |
| `admin_adjustment` | any | `manual`, no `source_id`; reason mandatory | Phase 1A (UI) |

### The uniqueness rule, exactly

```sql
UNIQUE (employee_id, transaction_type, source_type, source_id) WHERE source_id IS NOT NULL
```

One source event → at most one row of a given kind per employee. A verified
review is rewarded once; that reward can be reversed once; adjustments are
`manual` with no `source_id`, so the index never sees them and an employee can
be corrected any number of times. Re-awarding the same review after a reversal
is deliberately impossible through `review_reward`; the correction is an
adjustment, which records why. The rule is checked twice: a pre-check inside
the posting function under a per-employee advisory lock, and the index itself.
A redemption that would overdraw is refused under the same lock.

### Negative balances

Only a **redemption** is checked against the balance: it is refused if it
would take the balance below zero, and while the balance is negative no
redemption is accepted. A **reversal** is not checked — a reward invalidated
after its credits were spent is still reversed, and the balance goes negative
until later credits recover it. An **admin adjustment** is not checked either.
Proven by §11 of `supabase/tests/boe_credits_assertions.sql`.

## Authorization

| Who | Ledger | Balances | Settings | Adjust |
|---|---|---|---|---|
| Employee | own rows (RLS) | own (via `/api/boe-credits/ledger`) | read | no |
| Admin | all (RLS + route) | all (`/api/boe-credits/balances`) | read + write (`PUT /api/boe-credits/settings`) | `POST /api/boe-credits/adjustments` |
| anon | nothing | nothing | nothing | nothing |

* No client role holds INSERT/UPDATE/DELETE on either table; EXECUTE on the
  posting functions is revoked from `public`, `anon`, `authenticated`.
* The `/api/boe-credits/*` routes run on the service role behind `requireAdmin`
  / `requireSelfOrAdmin` (`src/lib/security/attendancePayrollApiAuth.ts`), so
  the route is the boundary and the database refuses everyone who did not come
  through it. For an adjustment or reversal the function re-verifies the actor
  is an active admin.
* **No new permission key.** Credits are read beside Attendance and spent in
  Payroll, both admin-only by product decision (`SELF_SERVICE_MODULE_KEYS`).
  Delegation later means widening `can_manage_boe_credits()` and nothing else.

## Code

* `src/lib/boeCredits/` — `types.ts`, `settings.ts` (defaults + parser),
  `ledger.ts` (pure: `sumCredits`, `formatCredits`, validation),
  `service.ts` (`getCreditBalance`, `getCreditTransactions`,
  `getAllCreditBalances`, `postCreditTransaction`, `postAdminAdjustment`,
  `reverseCreditTransaction`, settings read/save).
* `src/app/api/boe-credits/{ledger,balances,adjustments,settings}/route.ts`.
* Employee: `CreditsSummaryCard` on `/my-payroll` (“BOE Credits — N available”,
  History opens `CreditHistoryModal`).
* Management: `/payroll/credits` (nav entry “BOE Credits”): settings + history,
  every employee's balance, per-employee History, Adjust.

## Tests

* `src/lib/boeCredits/{ledger,settings,service,migration}.test.ts`
* `src/app/api/boe-credits/routesAuthority.test.ts`
* `supabase/tests/boe_credits_assertions.sql` — executes the migration on a
  disposable database: ledger math, isolation, self-award refusal, duplicate
  source, reversal, admin adjustment, settings defaults, zero credits.
  Runner: `supabase/tests/run_boe_credits_local.sh`.

## Not built (by design)

Review → credits, attendance redemption, payroll calculation, cash-out, expiry,
badges, levels, leaderboards, transfers, gifts, targets, department rules,
charts, notifications, monthly reset. Credits carry forward because they are
ledger rows.
