-- Central Payroll Settings, and the per-period snapshot that keeps history stable.
--
-- WHAT THIS ADDS
-- -------------
--   public.payroll_settings              append-only; the newest row is active
--   public.payroll_periods.settings_snapshot   jsonb; what THIS period was run with
--
-- WHY APPEND-ONLY RATHER THAN ONE MUTABLE ROW
-- -------------------------------------------
-- The requirement is an audit trail of who changed a calculation parameter and
-- when, without a version-management UI to maintain. An append-only table gives
-- exactly that and nothing more: every save is a new row carrying created_by and
-- created_at, the active settings are simply the newest row, and the admin form
-- never has to show a version picker because there is nothing to pick. History
-- is a consequence of the shape rather than a feature layered on top.
--
-- A single mutable row would have needed a second audit table, two writes per
-- save, and a way to keep them consistent. This needs one INSERT.
--
-- WHY THE SNAPSHOT LIVES ON THE PERIOD
-- ------------------------------------
-- A payroll month must always be explainable with the rules it was actually run
-- under. If a generated period read the live settings, then editing the per-day
-- divisor in October would silently restate March's payslips — figures an
-- employee has already been paid against and may have queried.
--
-- So generation pins the settings it is about to use onto the period, before the
-- first employee is calculated, and every later read of that period uses the pin.
-- jsonb on payroll_periods rather than a foreign key to a settings row because
-- the snapshot must be immune to the settings table being edited, reordered or
-- pruned later; a copy cannot be changed out from under the period that owns it.
--
-- NULL is meaningful here. It marks a period generated before this migration
-- existed, and the application resolves it to the documented legacy constants —
-- see LEGACY_PAYROLL_SETTINGS in src/lib/payroll/settings.ts. It deliberately
-- does NOT resolve to the currently active settings, because that would
-- reintroduce the exact drift the snapshot prevents. No backfill is performed,
-- for the same reason: writing today's settings onto a period that ran under the
-- old constants would be recording a claim we cannot support.
--
-- AUTHORIZATION
-- -------------
-- Settings are calculation policy for the whole company, not an employee record.
-- No employee has any business reading or writing them, so both tables are
-- admin-only in full — there is no self-service predicate here at all. RLS is
-- enabled and the ONLY policy grants admin. Everything else is denied by the
-- absence of a policy, which is how RLS fails closed.
--
-- The snapshot column inherits payroll_periods' existing policies unchanged; it
-- adds no new row visibility, only a column on rows the caller could already
-- read. An employee who can see their own period can see the rules it was run
-- under, which is a description of their own payslip.
--
-- DATABASE-LEVEL VALIDATION
-- -------------------------
-- The API validates every field against src/lib/payroll/settings.ts. The CHECK
-- below is the second line: it constrains the handful of values that would not
-- merely be unusual but would break the calculation outright — a zero divisor
-- divides by zero, and a time outside a day is not a time. It is deliberately
-- not a restatement of the whole application schema, which would have to be kept
-- in step across two languages and would drift.
--
-- PRODUCTION SAFETY
-- -----------------
-- Purely additive. One new table, one new nullable column with no default (so no
-- table rewrite on payroll_periods), and one seed row. No existing row is read,
-- rewritten or deleted, and no existing policy is altered. Every statement is
-- guarded, so re-running is safe.
--
-- DEPLOYMENT ORDER
-- ----------------
-- Apply before the application code that reads payroll_settings or
-- payroll_periods.settings_snapshot. PostgREST answers an unknown table or
-- column with an error (42P01 / 42703) rather than an empty result, so the
-- settings page and payroll generation would both fail until this lands.
--
-- ROLLBACK
-- --------
--   ALTER TABLE public.payroll_periods DROP COLUMN IF EXISTS settings_snapshot;
--   DROP TABLE IF EXISTS public.payroll_settings;
-- Lossless for payroll: with no snapshot column every period resolves to the
-- legacy constants, which is the behaviour that preceded this migration.

-- ─── 1. The settings table ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.payroll_settings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settings    jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES public.users(id) ON DELETE SET NULL,
  -- Optional free text an admin can leave to say why a rule changed. Not
  -- required: forcing a note on every save trains people to type "update".
  note        text
);

COMMENT ON TABLE public.payroll_settings IS
  'Payroll calculation parameters. Append-only: the row with the newest created_at is the active one, and every earlier row is the audit trail of what changed and who changed it. Never UPDATE or DELETE a row here — save a new one.';

COMMENT ON COLUMN public.payroll_settings.settings IS
  'The full PayrollSettings object (src/lib/payroll/settings.ts). Always complete — a partial object is rejected by the API rather than merged over defaults.';

-- The active-settings read is "newest first, limit 1", and the settings page and
-- every payroll generation both do it.
CREATE INDEX IF NOT EXISTS payroll_settings_created_at_idx
  ON public.payroll_settings (created_at DESC);

-- ─── 2. Fail-closed validation for the values that would break payroll ───────
-- Range checks the application also enforces. Stated here so a row written by
-- any future path — a script, a manual fix, a migration — cannot poison every
-- subsequent payroll run.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.payroll_settings'::regclass
      AND conname  = 'payroll_settings_sane_values_check'
  ) THEN
    ALTER TABLE public.payroll_settings
      ADD CONSTRAINT payroll_settings_sane_values_check
      CHECK (
        jsonb_typeof(settings) = 'object'
        -- Divisors are used as denominators. Zero or negative is not a policy
        -- choice, it is a division error or a negative salary.
        AND (settings->>'per_day_divisor')::numeric > 0
        AND (settings->>'per_day_divisor')::numeric <= 31
        AND (settings->>'full_day_hours')::numeric  > 0
        AND (settings->>'full_day_hours')::numeric  <= 24
        AND (settings->>'half_day_fraction')::numeric > 0
        AND (settings->>'half_day_fraction')::numeric < 1
        -- A rounding block of zero minutes makes the deduction rounding divide
        -- by zero; a negative one inverts it.
        AND (settings->>'rounding_block_minutes')::numeric > 0
        AND (settings->>'rounding_block_hours')::numeric  >= 0
        AND (settings->>'missing_punch_hours')::numeric   >= 0
        -- Times are minutes past midnight, so a day is [0, 1440).
        AND (settings->>'scheduled_in_minutes')::numeric         BETWEEN 0 AND 1439
        AND (settings->>'grace_end_minutes')::numeric            BETWEEN 0 AND 1439
        AND (settings->>'scheduled_out_minutes')::numeric        BETWEEN 0 AND 1439
        AND (settings->>'lunch_in_before_minutes')::numeric      BETWEEN 0 AND 1439
        AND (settings->>'lunch_out_after_minutes')::numeric      BETWEEN 0 AND 1439
        AND (settings->>'single_punch_divider_minutes')::numeric BETWEEN 0 AND 1439
        AND (settings->>'weekly_off_day')::numeric               BETWEEN 0 AND 6
        -- The day must open before it closes, or every day is an early departure.
        AND (settings->>'scheduled_out_minutes')::numeric > (settings->>'scheduled_in_minutes')::numeric
        -- At least one paid-leave band, or the entitlement lookup finds nothing.
        AND jsonb_typeof(settings->'paid_leave_tiers') = 'array'
        AND jsonb_array_length(settings->'paid_leave_tiers') >= 1
      );
  END IF;
END $$;

-- ─── 3. Append-only, enforced ────────────────────────────────────────────────
-- The audit trail is only a trail if history cannot be rewritten. Postgres has
-- no "INSERT only" table mode, so the guarantee is a trigger. This is the same
-- shape as payroll_period_status_events, which is append-only for the same
-- reason.

CREATE OR REPLACE FUNCTION public.payroll_settings_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'payroll_settings is append-only: save a new settings row instead of changing or deleting %',
    TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS payroll_settings_no_update ON public.payroll_settings;
CREATE TRIGGER payroll_settings_no_update
  BEFORE UPDATE OR DELETE ON public.payroll_settings
  FOR EACH ROW EXECUTE FUNCTION public.payroll_settings_append_only();

-- ─── 4. Authorization — admin only, in full ──────────────────────────────────
-- No employee policy exists, deliberately. With RLS enabled and no matching
-- policy, a non-admin SELECT returns zero rows and a non-admin INSERT is
-- rejected. That is the fail-closed default and it is what we want: calculation
-- policy is not employee data.

ALTER TABLE public.payroll_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admins_read_payroll_settings" ON public.payroll_settings;
CREATE POLICY "admins_read_payroll_settings"
  ON public.payroll_settings
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE users.id = auth.uid() AND users.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "admins_write_payroll_settings" ON public.payroll_settings;
CREATE POLICY "admins_write_payroll_settings"
  ON public.payroll_settings
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE users.id = auth.uid() AND users.role = 'admin'
    )
  );

-- No UPDATE or DELETE policy, on purpose. The trigger above refuses both even
-- for the service role; the absent policies refuse them one layer earlier for
-- everybody else.

-- ─── 5. The per-period snapshot ──────────────────────────────────────────────

ALTER TABLE public.payroll_periods
  ADD COLUMN IF NOT EXISTS settings_snapshot jsonb;

COMMENT ON COLUMN public.payroll_periods.settings_snapshot IS
  'The payroll settings this period was generated with, copied in before the first employee was calculated. Read in preference to the active settings for any generated or locked period, so an later settings change cannot restate a payslip. NULL means the period predates Central Payroll Settings; the application resolves that to the documented legacy constants, never to today''s settings.';

-- ─── 6. Seed the active settings ─────────────────────────────────────────────
-- One row, only if the table is empty, holding exactly the constants the engine
-- calculated with before this migration. Seeding today's behaviour rather than
-- leaving the table empty means the settings page has something to show on first
-- open and the "no settings row" case never has to be special-cased in the
-- calculation path.
--
-- These values are asserted against src/lib/payroll/settings.ts by
-- settings.migrationSeed.test.ts, so a constant that changes on one side without
-- the other breaks a test rather than a payslip.

INSERT INTO public.payroll_settings (settings, created_by, note)
SELECT
  jsonb_build_object(
    'per_day_divisor',   26,
    'full_day_hours',    8.5,
    'half_day_fraction', 0.5,

    'scheduled_in_minutes',    600,
    'grace_end_minutes',       615,
    'scheduled_out_minutes',   1110,
    'lunch_in_before_minutes', 840,
    'lunch_out_after_minutes', 780,
    'lunch_hours',             1,
    'weekly_off_day',          0,

    'single_punch_divider_minutes',           840,
    'missing_punch_hours',                    2,
    'threshold_full_present_hours',           7.5,
    'threshold_present_with_shortfall_hours', 5,
    'threshold_half_day_hours',               3.75,
    'threshold_short_present_hours',          2,

    'rounding_block_minutes', 30,
    'rounding_block_hours',   0.5,

    'paid_leave_tiers', jsonb_build_array(
      jsonb_build_object('min_days_present', 16, 'leave', 1),
      jsonb_build_object('min_days_present', 11, 'leave', 0.5),
      jsonb_build_object('min_days_present', 0,  'leave', 0)
    ),
    'half_days_per_paid_leave', 2,
    'hours_per_paid_leave',     8.5
  ),
  NULL,
  'Seeded from the constants the engine used before Central Payroll Settings. Not an admin decision — this is a record of existing behaviour.'
WHERE NOT EXISTS (SELECT 1 FROM public.payroll_settings);
