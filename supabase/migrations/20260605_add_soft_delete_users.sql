-- Soft delete support for users table.
-- Members are never immediately hard-deleted; they are marked deleted and
-- permanently purged only after the 30-day restoration window expires.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS is_deleted          boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS deleted_at          timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by          uuid,
  ADD COLUMN IF NOT EXISTS deletion_scheduled_at timestamptz;

-- Backfill rows that existed before the column was added (is_deleted may be null
-- if the column was previously added without a DEFAULT or the ALTER was partial).
UPDATE public.users SET is_deleted = false WHERE is_deleted IS NULL;

-- Fast filter: most queries need only non-deleted users
CREATE INDEX IF NOT EXISTS users_is_deleted_idx ON public.users (is_deleted);
