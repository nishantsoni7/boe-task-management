# BOE Credits

**Status:** Phase 1A — the foundation. Built 2026-09-02, local only, migration
**not applied** to production.

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
