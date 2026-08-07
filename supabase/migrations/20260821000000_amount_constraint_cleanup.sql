-- Finance & Orders — remove the duplicate amount constraints, validate the real ones.
--
-- Found by RUNNING supabase/tests/financial_amount_invariants_assertions.sql
-- against the migrated database. A negative product value was refused — but by
-- `orders_total_product_value_check`, not by the constraint 20260817000000 had
-- just added. Inspecting pg_constraint showed why:
--
--   orders.total_product_value          orders_total_product_value_check          VALID
--   order_requests.total_product_value  order_requests_total_product_value_check  VALID
--   order_requests.total_value          order_requests_total_value_nonneg         NOT VALID
--
-- Three of those five columns were ALREADY constrained. 20260817000000 asserted
-- in its own header that every amount column in the sales chain was
-- unconstrained; that was checked against the migration files, where the
-- product-value CHECKs are inline column constraints on the ADD COLUMN in
-- 20260696000000 and easy to miss, rather than against pg_constraint. Reading
-- the schema would have shown it. This is the correction.
--
-- Two of the five were genuinely new and remain:
--
--   finance_payment_requests_amount_positive   amount > 0
--   orders_total_value_non_negative            total_value IS NULL OR >= 0
--
-- Nothing about the enforcement changes for any column — every one of the five
-- was and still is constrained. What changes is that each column is constrained
-- ONCE, by a constraint whose name says what it does, instead of twice by two
-- with identical predicates.
--
-- Scope: three DROP CONSTRAINT, two VALIDATE. No table, column, row, policy,
-- privilege or function.

-- ── 1. Drop the duplicates this branch introduced ────────────────────────────
--
-- Only the ones 20260817000000 added are dropped. The pre-existing constraints
-- are left exactly as they are — including
-- `order_requests_total_value_nonneg`, which is somebody else's NOT VALID
-- constraint and is not this branch's to validate or rename.

alter table public.orders
  drop constraint if exists orders_total_product_value_non_negative;

alter table public.order_requests
  drop constraint if exists order_requests_total_value_non_negative;

alter table public.order_requests
  drop constraint if exists order_requests_total_product_value_non_negative;

-- ── 2. Validate the two that are real ────────────────────────────────────────
--
-- 20260817000000 added these NOT VALID deliberately, because it was written
-- without access to production data and a single non-compliant legacy row would
-- have failed the deployment itself. That survey has since been run against the
-- live database:
--
--   finance_payment_requests.amount <= 0 or null ....... 0 rows  (of 6 total)
--   orders.total_value < 0 ............................. 0 rows  (of 0 total)
--
-- Zero violations, so the scan is safe and the constraints can carry their full
-- guarantee instead of applying only to new writes. VALIDATE takes a SHARE
-- UPDATE EXCLUSIVE lock, which does not block reads or writes; on tables of six
-- and zero rows it is instantaneous.

alter table public.finance_payment_requests
  validate constraint finance_payment_requests_amount_positive;

alter table public.orders
  validate constraint orders_total_value_non_negative;

-- ── 3. Deliberately NOT done ─────────────────────────────────────────────────
--
--   * `order_requests_total_value_nonneg` is left NOT VALID. It predates this
--     branch, the survey shows it would validate cleanly, and validating
--     somebody else's constraint is a change they should make knowingly.
--     Recorded in docs/Module Docs/FINANCE_ORDER_WORKFLOW.md.
--   * No constraint is renamed. A rename is a schema churn with no behavioural
--     gain, and the surviving names are already accurate.
