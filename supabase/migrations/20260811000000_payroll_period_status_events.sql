-- Payroll period status events — the permanent record of finalisation changes.
--
-- Why this table exists
-- ---------------------
-- Locking a payroll period was recorded by two columns on payroll_periods
-- (locked_at, locked_by). That is enough while locking is one-way, but an
-- unlock has to record something a column cannot hold: WHY. It also has to
-- record it WITHOUT destroying the lock it reverses — clearing locked_at /
-- locked_by would erase the only evidence the period was ever finalised, and
-- overwriting them on the next lock would erase the cycle before it.
--
-- So the transition itself becomes the record. One append-only row per
-- finalisation event, carrying the period, the direction, both statuses, the
-- actor (id and the display name as it read at the time), the stated reason and
-- the timestamp. locked_at / locked_by on payroll_periods are left exactly as
-- they are — the unlock route never touches them — so the original locking
-- record survives its own reversal.
--
-- Append-only, and enforced as such
-- ---------------------------------
-- RLS is on and the table carries a SELECT policy only. No client role holds
-- INSERT, UPDATE or DELETE — admins included — so an audit row cannot be
-- written, edited or removed through the app or through a raw PostgREST call.
-- Every write goes through the service-role payroll routes, which are the only
-- place the status change and its audit entry happen together.
--
-- (Deliberately no immutability TRIGGER, unlike asset_activity_log: payroll
-- periods are still created and deleted wholesale by the payroll test suite,
-- and a BEFORE DELETE trigger would defeat the ON DELETE CASCADE that keeps
-- those runs from leaving orphaned audit rows behind. RLS already blocks every
-- client path; the service role is trusted code in this codebase.)
--
-- Production safety
-- -----------------
-- Purely additive: one new table, its index and its policy. No existing table
-- is altered and no existing row is read or written. Re-running is safe.
--
-- Rollback
-- --------
--   DROP TABLE public.payroll_period_status_events;
-- is lossless for payroll figures — nothing else references it and no
-- calculation reads it. It does discard the unlock history, so roll back only
-- if the unlock workflow itself is being withdrawn.

CREATE TABLE IF NOT EXISTS public.payroll_period_status_events (
  id                 uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,

  payroll_period_id  uuid        NOT NULL
                                 REFERENCES public.payroll_periods(id) ON DELETE CASCADE,

  -- What happened. Kept narrow on purpose: this table records finalisation
  -- changes, not every payroll event (generation already has its own log in
  -- public.payroll_generation).
  event              text        NOT NULL CHECK (event IN ('locked', 'unlocked')),

  previous_status    text        NOT NULL CHECK (previous_status IN ('draft', 'generated', 'locked')),
  new_status         text        NOT NULL CHECK (new_status     IN ('draft', 'generated', 'locked')),

  actor_id           uuid        NOT NULL REFERENCES public.users(id),
  -- Snapshotted rather than joined: the name is part of the audit statement and
  -- must keep reading the same after the person is renamed or deactivated.
  actor_name         text,

  -- Mandatory for an unlock (see the CHECK below), optional for a lock, which
  -- needs no justification — finalising is the normal end of a payroll month.
  reason             text,

  created_at         timestamptz NOT NULL DEFAULT now(),

  -- An unlock with no stated reason is not auditable, which is the entire point
  -- of the row. btrim() here strips spaces only; the route trims all whitespace
  -- before writing, so this is the backstop, not the primary check.
  CONSTRAINT payroll_period_status_events_unlock_reason CHECK (
    event <> 'unlocked' OR (reason IS NOT NULL AND btrim(reason) <> '')
  ),

  -- A recorded transition that changed nothing would be noise in the trail.
  CONSTRAINT payroll_period_status_events_status_changed CHECK (
    previous_status <> new_status
  )
);

-- The dashboard reads the latest event per period, and the latest unlock per
-- period, on every load.
CREATE INDEX IF NOT EXISTS payroll_period_status_events_period_idx
  ON public.payroll_period_status_events (payroll_period_id, created_at DESC);

ALTER TABLE public.payroll_period_status_events ENABLE ROW LEVEL SECURITY;

-- Read only, and only for admins — payroll is an admin-only module today.
DROP POLICY IF EXISTS "admins_read_payroll_period_status_events"
  ON public.payroll_period_status_events;
CREATE POLICY "admins_read_payroll_period_status_events"
  ON public.payroll_period_status_events
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role = 'admin'
    )
  );
