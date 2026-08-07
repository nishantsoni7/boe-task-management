-- Finance & Orders — money is never negative, and a receipt is never zero.
--
-- The hole this closes
-- --------------------
-- Every amount column in the sales chain is an unconstrained `numeric`:
--
--   finance_payment_requests.amount   numeric not null    (20260628000200)
--   orders.total_value                numeric(12,2)       (20260655)
--   orders.total_product_value        numeric(12,2)       (20260696000000)
--   order_requests.total_value        numeric(12,2)       (20260680000000)
--   order_requests.total_product_value numeric(12,2)      (20260696000000)
--
-- The only thing standing between a negative receipt and the ledger is
-- isValidAmount() in src/lib/currency.ts — a client-side function. Anything
-- that reaches PostgREST without going through that form (a service-role route,
-- a crafted request, a future import script, psql) can write amount = -50000,
-- and every figure derived from it silently absorbs the change:
--
--   * the Order detail page's Received / Pending / Completion band,
--   * order_linked_payment_total() and therefore the figure recorded when an
--     Order is cancelled,
--   * the advance shown on an Order Request,
--   * the conversion RPC's "at least one approved payment" check, which counts
--     rows and would happily count a negative one.
--
-- No total anywhere in the application is defended against it, because every
-- one of them assumes the column already is what the form promised.
--
-- Why NOT VALID
-- -------------
-- These constraints are added NOT VALID deliberately. NOT VALID still enforces
-- the rule on every INSERT and UPDATE from this moment on — it only skips the
-- full-table scan that proves the existing rows comply. That matters because
-- this migration is written without access to production data: a legacy row
-- with a zero amount or a null-but-actually-meaningless value would otherwise
-- make the deployment itself fail, in a module people are using.
--
-- The rows are checked separately, deliberately, and only then validated:
--   1. run supabase/tests/financial_amount_invariants_assertions.sql
--   2. correct anything it lists, through the module's own correction path
--   3. run the VALIDATE CONSTRAINT statements printed at the foot of this file
--
-- Zero: allowed for an order value, refused for a receipt
-- ------------------------------------------------------
-- An Order legitimately has a value of zero before anyone has priced it, and a
-- product value of zero while only the order total is known. A *payment* of
-- zero is never a real event — no money moved — and a zero-amount row would
-- still be counted as "an approved payment exists" by the conversion rule.
-- The asymmetry is the business rule, not an oversight.
--
-- Scope discipline: five CHECK constraints and nothing else. No column is
-- added, dropped, retyped or backfilled; no policy, trigger, function or row is
-- touched; no default changes.

-- ── 1. A receipt is a positive amount ─────────────────────────────────────────

alter table public.finance_payment_requests
  drop constraint if exists finance_payment_requests_amount_positive;

alter table public.finance_payment_requests
  add constraint finance_payment_requests_amount_positive
  check (amount > 0) not valid;

comment on constraint finance_payment_requests_amount_positive
  on public.finance_payment_requests is
  'A payment records money that actually moved: strictly positive. Mirrors isValidAmount() in src/lib/currency.ts, which is a form-level convenience and never the control. A refund is NOT a negative payment — see the refund model in docs/Module Docs/FINANCE_ORDER_WORKFLOW.md.';

-- ── 2. An order value is never negative ───────────────────────────────────────
-- NULL stays permitted on all four: an Order Request may genuinely not carry a
-- value yet, and `check (x >= 0)` is NULL-tolerant by construction — a NULL
-- makes the expression NULL, which a CHECK treats as satisfied. Making these
-- NOT NULL is a separate decision with a separate backfill and is not made here.

alter table public.orders
  drop constraint if exists orders_total_value_non_negative;

alter table public.orders
  add constraint orders_total_value_non_negative
  check (total_value is null or total_value >= 0) not valid;

alter table public.orders
  drop constraint if exists orders_total_product_value_non_negative;

alter table public.orders
  add constraint orders_total_product_value_non_negative
  check (total_product_value is null or total_product_value >= 0) not valid;

alter table public.order_requests
  drop constraint if exists order_requests_total_value_non_negative;

alter table public.order_requests
  add constraint order_requests_total_value_non_negative
  check (total_value is null or total_value >= 0) not valid;

alter table public.order_requests
  drop constraint if exists order_requests_total_product_value_non_negative;

alter table public.order_requests
  add constraint order_requests_total_product_value_non_negative
  check (total_product_value is null or total_product_value >= 0) not valid;

-- ── 3. Validation, to be run only after the assertions script is clean ────────
--
--   alter table public.finance_payment_requests
--     validate constraint finance_payment_requests_amount_positive;
--   alter table public.orders
--     validate constraint orders_total_value_non_negative;
--   alter table public.orders
--     validate constraint orders_total_product_value_non_negative;
--   alter table public.order_requests
--     validate constraint order_requests_total_value_non_negative;
--   alter table public.order_requests
--     validate constraint order_requests_total_product_value_non_negative;
--
-- Left commented rather than executed: VALIDATE takes a SHARE UPDATE EXCLUSIVE
-- lock and fails outright on a single non-compliant row, which would abort the
-- deployment for a data problem that a person needs to look at.
