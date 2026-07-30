-- System Adoption: first Task Management open per employee per IST business date.
--
-- WHY A NEW TABLE
--
-- The owner asked whether employees open Task Management near the start of the
-- working day. Every existing source was inspected first and none can answer it:
--
--   auth.users.last_sign_in_at   One value, overwritten on every sign-in. Cannot
--                                say whether someone opened the app on a given
--                                past date. A long-lived session also means no
--                                new sign-in happens for days.
--   task_activity_log            Cannot hold this event: task_id is NOT NULL with
--                                a foreign key to tasks.id, and `action` is the
--                                enum public.activity_action, whose 18 values are
--                                all task mutations. Storing a non-task event
--                                would need a nullable FK plus an enum change —
--                                far more invasive than one small table.
--   attendance_records           Fingerprint-machine import. Real check_in_at
--                                values, but coverage stops at 2026-06-30 and it
--                                measures arriving at the building, not opening
--                                the app.
--   daily_work_logs              End-of-day write-up, not a first open.
--   notifications                Delivery log, not a page-open log.
--   password_reset_log           Unrelated.
--
-- There is no analytics, session or page-view table anywhere in the schema.
--
-- WHAT THIS DELIBERATELY IS NOT
--
-- Not an analytics framework. One row per employee per business date, written
-- once, holding only the first-open timestamp. No per-navigation rows, no
-- user-agent, no IP, no route history beyond the first path, no client clock:
-- the business date and the timestamp are both decided server-side.

CREATE TABLE IF NOT EXISTS public.performance_app_opens (
  id              uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id         uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

  -- IST (Asia/Kolkata) business date, computed server-side. Never the browser's
  -- local date: a device with a wrong clock or a different timezone would
  -- otherwise file the event under the wrong day.
  business_date   date        NOT NULL,

  -- Server clock at the moment the first open was recorded.
  first_opened_at timestamptz NOT NULL DEFAULT now(),

  -- The Task Management path that triggered it, for spot-checking only.
  first_route     text,

  created_at      timestamptz NOT NULL DEFAULT now(),

  -- The uniqueness guarantee. "First open" is only meaningful if the second and
  -- every later open of the same day cannot create a row, so this is enforced by
  -- the database rather than by application logic. The recording endpoint inserts
  -- with ON CONFLICT DO NOTHING and relies on this constraint.
  CONSTRAINT performance_app_opens_user_date_unique UNIQUE (user_id, business_date)
);

COMMENT ON TABLE public.performance_app_opens IS
  'One row per employee per IST business date, recording the first time they '
  'opened a Task Management page that day. Feeds the Performance "System '
  'Adoption" section. Deliberately excluded from the official performance score.';

COMMENT ON COLUMN public.performance_app_opens.user_id IS
  'The real signed-in user. While an admin is using View As, the admin is '
  'recorded — never the impersonated employee — so impersonation cannot '
  'manufacture adoption history for someone else.';

COMMENT ON COLUMN public.performance_app_opens.business_date IS
  'IST business date resolved on the server. Not derived from the client clock.';

-- Range scans by date for a whole team over a reporting period.
CREATE INDEX IF NOT EXISTS performance_app_opens_date_idx
  ON public.performance_app_opens (business_date);

-- Per-employee history for the drawer. Leading user_id makes the composite
-- useful for "this employee over this range"; the unique constraint above already
-- covers exact (user_id, business_date) lookups.
CREATE INDEX IF NOT EXISTS performance_app_opens_user_date_idx
  ON public.performance_app_opens (user_id, business_date DESC);

-- ── RLS ────────────────────────────────────────────────────────────────────────
-- Same shape as attendance_records (migration 20260609): an employee may read
-- their own rows; every write and every team-wide read goes through a service-role
-- API route that checks the caller's role first.
ALTER TABLE public.performance_app_opens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_read_own_app_opens" ON public.performance_app_opens;
CREATE POLICY "users_read_own_app_opens"
  ON public.performance_app_opens
  FOR SELECT
  USING (auth.uid() = user_id);

-- No INSERT/UPDATE/DELETE policy. Direct client writes are impossible; the only
-- writer is POST /api/performance/app-open, which resolves the user from the
-- bearer token and cannot be told to write on someone else's behalf.

-- ── Rollback ───────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS public.performance_app_opens;
-- Nothing references it. The Performance routes tolerate the table being absent
-- (a failed read yields no adoption data and the page still renders), but roll the
-- code back alongside it for cleanliness.
