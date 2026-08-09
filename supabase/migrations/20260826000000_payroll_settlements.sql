-- Payroll settlement: carry-forward, actual payment, closing balance.
--
-- WHAT THIS ADDS AND WHY IT IS A SEPARATE LAYER
-- --------------------------------------------
-- Payroll already answers "what did this month earn": payroll_results holds
-- gross_salary, total_deductions, pending_adjustment_total and net_salary, and
-- payroll_pending_adjustments holds the manual additions and recoveries the
-- engine applied. What BOE could not record is what it actually SETTLED — money
-- owed from an earlier month, and money genuinely paid out — so an underpayment
-- or an advance had nowhere to live except somebody's memory.
--
-- Settlement is deliberately NOT an engine input. Recording a payment must never
-- rerun attendance, never restate gross salary and never move a deduction, so
-- nothing here feeds generatePayrollForEmployee(). The engine's inputs are
-- unchanged by this migration.
--
-- THE DOUBLE-COUNTING INVARIANT
-- -----------------------------
-- net_salary ALREADY contains Other Adjustments (engine.ts computes
-- gross − deductions + net_adjustment). So the settlement layer must never build
-- on net_salary, and carry-forward must never be written as a
-- payroll_pending_adjustments row. Those two rules are what make each figure
-- countable exactly once:
--
--   salary_after_attendance = gross_salary − total_deductions   (floor at 0 when days_present = 0)
--   net_adjustments         = carry_forward_amount + pending_adjustment_total
--   salary_payable          = salary_after_attendance + net_adjustments
--   closing_balance         = salary_payable − amount_paid       (NULL when amount_paid IS NULL)
--
-- Every one of those is COMPUTED AT READ TIME from stored primitives. None is
-- stored here, so there is no second copy of a total to drift out of step with
-- payroll_results, and a regenerated result flows straight through.
--
-- UNKNOWN IS NOT ZERO
-- -------------------
-- amount_paid IS NULL means nobody has stated what was paid, and there is then
-- NO closing balance — not a balance equal to the whole Salary Payable. Coalescing
-- the missing value to 0 would manufacture a debt for every month an admin has
-- simply not filled in yet, and carry that invention into the next month as if it
-- were a reviewed figure. A RECORDED 0, by contrast, is a real statement that
-- nothing was paid, and does produce a balance for the full amount. The two must
-- never render alike, which is why amount_paid is nullable rather than
-- NOT NULL DEFAULT 0.
--
-- SIGN CONVENTION, stated once
-- ----------------------------
--   carry_forward_amount > 0   BOE still owes the employee
--   carry_forward_amount < 0   the employee has already received excess/advance
--   closing_balance      > 0   BOE owes the employee (becomes next month's proposal)
--   closing_balance      < 0   the employee is in advance
--
-- Production safety: two new tables, three new columns on an existing one, and
-- one trigger. No existing row is read, rewritten or deleted; no existing column
-- changes type or nullability. Historical payroll — locked or not — is untouched.

-- ─── payroll_settlements ─────────────────────────────────────────────────────
-- One row per employee per payroll period, mirroring payroll_results' own
-- (period, employee) uniqueness so the two are 1:1 by construction.

CREATE TABLE IF NOT EXISTS public.payroll_settlements (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  payroll_period_id     uuid NOT NULL REFERENCES public.payroll_periods(id),
  employee_id           uuid NOT NULL REFERENCES public.users(id),

  -- The result this settles. Nullable so a settlement can exist for a period an
  -- employee has no result in yet; it is stamped when generation materialises.
  payroll_result_id     uuid REFERENCES public.payroll_results(id),

  -- ── Carry forward ────────────────────────────────────────────────────────
  -- Three columns rather than one, because "what the system worked out" and
  -- "what the admin decided" are different facts and losing either one makes the
  -- balance lineage unauditable.

  /** The automatic value: the source period's closing balance at materialisation. */
  proposed_carry_forward         numeric(12, 2) NOT NULL DEFAULT 0,

  /** Which month the proposal came from. Null when there is no prior period. */
  carry_forward_source_period_id uuid REFERENCES public.payroll_periods(id),

  /** The EFFECTIVE value used in Salary Payable. Equals the proposal unless overridden. */
  carry_forward_amount           numeric(12, 2) NOT NULL DEFAULT 0,

  /** True once an admin has overridden the proposal. Keeps the two distinguishable. */
  carry_forward_is_manual        boolean NOT NULL DEFAULT false,

  carry_forward_remark           text,
  carry_forward_set_by           uuid REFERENCES public.users(id),
  carry_forward_set_at           timestamptz,

  -- ── Actual payment ───────────────────────────────────────────────────────
  -- NULL means "not recorded yet", which is NOT the same as 0 ("paid nothing").
  -- The distinction is load-bearing: an unrecorded month must read as unsettled
  -- rather than as a month BOE deliberately paid nothing for.

  amount_paid           numeric(12, 2),
  payment_date          date,
  payment_remark        text,
  payment_recorded_by   uuid REFERENCES public.users(id),
  payment_recorded_at   timestamptz,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT payroll_settlements_period_employee_unique
    UNIQUE (payroll_period_id, employee_id),

  -- A manual override without a stated reason is exactly the untraceable
  -- restatement of somebody's pay this table exists to prevent. Enforced here
  -- and not only in the route, so no future caller can skip it.
  CONSTRAINT payroll_settlements_manual_needs_remark
    CHECK (
      carry_forward_is_manual = false
      OR (carry_forward_remark IS NOT NULL AND btrim(carry_forward_remark) <> '')
    ),

  -- A payment is money leaving BOE. Negative would be a refund, which is a
  -- different transaction and would silently invert the closing balance.
  CONSTRAINT payroll_settlements_amount_paid_non_negative
    CHECK (amount_paid IS NULL OR amount_paid >= 0)
);

CREATE INDEX IF NOT EXISTS payroll_settlements_employee_idx
  ON public.payroll_settlements (employee_id);

CREATE INDEX IF NOT EXISTS payroll_settlements_period_idx
  ON public.payroll_settlements (payroll_period_id);

-- Lineage lookups: "which month did this balance come from".
CREATE INDEX IF NOT EXISTS payroll_settlements_source_period_idx
  ON public.payroll_settlements (carry_forward_source_period_id)
  WHERE carry_forward_source_period_id IS NOT NULL;

-- ─── payroll_settlement_events ───────────────────────────────────────────────
-- Append-only history of the changes that move money. Six named events, not a
-- generic event system: this table is only ever read by the payroll audit trail,
-- and a free-form event type would make it impossible to know what it holds.

CREATE TABLE IF NOT EXISTS public.payroll_settlement_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_settlement_id uuid NOT NULL
                          REFERENCES public.payroll_settlements(id) ON DELETE CASCADE,

  event text NOT NULL CHECK (event IN (
    'carry_forward_proposed',    -- materialised automatically from the prior month
    'carry_forward_overridden',  -- an admin replaced the proposal
    'carry_forward_reset',       -- an admin returned to the proposed value
    'payment_recorded',          -- first time an amount was recorded
    'payment_changed',           -- a recorded amount, date or remark was corrected
    'payment_cleared'            -- a recorded payment was withdrawn
  )),

  -- What the figure was and became. Both nullable: a proposal has no previous
  -- value, and a cleared payment has no new one.
  previous_amount numeric(12, 2),
  new_amount      numeric(12, 2),

  remark      text,
  actor_id    uuid REFERENCES public.users(id),
  -- Denormalised so the trail still names who acted after a user row changes.
  -- Same reasoning as payroll_period_status_events.actor_name.
  actor_name  text,

  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payroll_settlement_events_settlement_idx
  ON public.payroll_settlement_events (payroll_settlement_id, created_at DESC);

-- ─── Adjustment void trail ───────────────────────────────────────────────────
-- payroll_pending_adjustments.status already allows 'cancelled'; nothing ever
-- set it, because DELETE /api/payroll/adjustments/[id] hard-deleted the row and
-- took the reason, the actor and the amount with it. These three columns turn
-- that into a void, so a removed adjustment stays explainable.
--
-- The existing rule is unchanged: only a 'pending' adjustment can be removed. An
-- adjustment the engine has already applied stays applied, so voiding can never
-- silently move net_salary underneath a generated payroll.

ALTER TABLE public.payroll_pending_adjustments
  ADD COLUMN IF NOT EXISTS voided_by   uuid REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS voided_at   timestamptz,
  ADD COLUMN IF NOT EXISTS void_reason text;

-- ─── Locked periods are immutable ────────────────────────────────────────────
-- Stated in the database, not only in the API route. The routes check the lock
-- too — this is the backstop that makes "locked payroll cannot change" true for
-- every caller, including a service-role client, which RLS does not constrain.

CREATE OR REPLACE FUNCTION public.payroll_settlement_lock_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_period uuid;
  target_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_period := OLD.payroll_period_id;
  ELSE
    target_period := NEW.payroll_period_id;
  END IF;

  SELECT status INTO target_status
  FROM public.payroll_periods
  WHERE id = target_period;

  IF target_status = 'locked' THEN
    RAISE EXCEPTION
      'Payroll period is locked — carry-forward and payment records cannot be changed. Unlock the period first.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS payroll_settlements_lock_guard ON public.payroll_settlements;
CREATE TRIGGER payroll_settlements_lock_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_settlements
  FOR EACH ROW EXECUTE FUNCTION public.payroll_settlement_lock_guard();

-- ─── Row level security ──────────────────────────────────────────────────────
-- The shape established by 20260812_attendance_payroll_isolation: an own-row
-- read for the employee keyed on auth.uid(), everything for admin, and NOT ONE
-- write policy for an employee. Every mutation in the app goes through a
-- service-role route that checks the caller's role and the period's lock state.

ALTER TABLE public.payroll_settlements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "employees_read_own_settlement" ON public.payroll_settlements;
CREATE POLICY "employees_read_own_settlement"
  ON public.payroll_settlements
  FOR SELECT
  TO authenticated
  USING (employee_id = auth.uid());

DROP POLICY IF EXISTS "admins_manage_settlements" ON public.payroll_settlements;
CREATE POLICY "admins_manage_settlements"
  ON public.payroll_settlements
  FOR ALL
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin')
  );

-- The event log is an administrative audit surface: it records who changed an
-- employee's balance and why. The employee sees the RESULT (the remark on their
-- own settlement row), not the trail of who edited it, which is the same line
-- payroll_generation and attendance_correction_log already draw.
ALTER TABLE public.payroll_settlement_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admins_read_settlement_events" ON public.payroll_settlement_events;
CREATE POLICY "admins_read_settlement_events"
  ON public.payroll_settlement_events
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin')
  );

-- Deliberately NO insert, update or delete policy on the event log, for anybody
-- including admin. Append-only, written by the service-role route alongside the
-- change it records — the same construction as payroll_period_status_events.

-- ─── Rollback ────────────────────────────────────────────────────────────────
--   DROP TRIGGER payroll_settlements_lock_guard ON public.payroll_settlements;
--   DROP FUNCTION public.payroll_settlement_lock_guard();
--   DROP TABLE public.payroll_settlement_events;
--   DROP TABLE public.payroll_settlements;
--   ALTER TABLE public.payroll_pending_adjustments
--     DROP COLUMN voided_by, DROP COLUMN voided_at, DROP COLUMN void_reason;
-- Nothing else is touched, so a rollback restores the exact prior schema.
