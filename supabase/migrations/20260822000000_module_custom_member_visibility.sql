-- Module Visibility → Custom members.
--
-- What this adds
-- --------------
-- A fifth visibility mode on public.app_modules, `custom`, which names the
-- individual members a module is available to, and the column that holds them:
--
--   allowed_user_ids uuid[]   — the named members, when visibility_type = 'custom'
--
-- Why a column and not a join table
-- ---------------------------------
-- `allowed_department` is already a `text[]` on this row (20260668), and the
-- launcher reads the whole app_modules table in one query to decide which cards
-- to render. A join table would turn that single read into a second round trip
-- on every page load and would need its own RLS policy, for a list that is a
-- handful of uuids per module. The array matches the shape that is already
-- there.
--
-- No foreign key is declared: Postgres cannot key an array element to
-- public.users(id). A member who is deleted therefore leaves a dangling uuid in
-- the array. That fails CLOSED — the id no longer matches any signed-in caller,
-- so it grants nothing — and /api/control-center/modules/[key] re-validates the
-- whole list against active, non-deleted users on every save, so the array is
-- cleaned the next time an admin touches the module.
--
-- Fail-closed by construction
-- ---------------------------
-- `custom` with an empty or null array admits nobody but admin. That is the
-- deliberate behaviour, not an oversight: a visibility mode that silently
-- widened to "everyone" when its list emptied would be the worst possible
-- failure for a module that carries salary. The API refuses to SAVE an empty
-- custom list; this constraint is the second line of that same rule.
--
-- Existing rows
-- -------------
-- Untouched. Every current module keeps its visibility_type and
-- allowed_department exactly as they are, and allowed_user_ids defaults to NULL
-- for all of them. No module changes who can see it as a result of this
-- migration.
--
-- Production safety
-- -----------------
-- Additive: one nullable column and one widened CHECK constraint. No row is
-- read, written or reclassified. Re-running is safe.
--
-- Rollback
-- --------
--   UPDATE public.app_modules SET visibility_type = 'admin_only'
--     WHERE visibility_type = 'custom';
--   ALTER TABLE public.app_modules DROP COLUMN allowed_user_ids;
--   ALTER TABLE public.app_modules DROP CONSTRAINT app_modules_visibility_type_check;
--   ALTER TABLE public.app_modules ADD CONSTRAINT app_modules_visibility_type_check
--     CHECK (visibility_type IN ('live','admin_only','department_only','hidden'));

-- ─── 1. The members column ───────────────────────────────────────────────────

ALTER TABLE public.app_modules
  ADD COLUMN IF NOT EXISTS allowed_user_ids uuid[];

COMMENT ON COLUMN public.app_modules.allowed_user_ids IS
  'Members a module is available to when visibility_type = ''custom''. Empty or null admits admins only.';

-- ─── 2. Allow the new mode ───────────────────────────────────────────────────
-- The seed constraint was created inline by 20260645 and therefore carries
-- Postgres''s generated name. Drop by that name, then restate the whole set so
-- the allowed values are readable in one place rather than spread across two
-- migrations.

ALTER TABLE public.app_modules
  DROP CONSTRAINT IF EXISTS app_modules_visibility_type_check;

ALTER TABLE public.app_modules
  ADD CONSTRAINT app_modules_visibility_type_check
  CHECK (visibility_type IN ('live', 'admin_only', 'department_only', 'hidden', 'custom'));

-- ─── 3. The array only means anything under `custom` ─────────────────────────
-- Keeping a stale member list behind a mode that ignores it is how a module
-- silently re-grants access the next time someone flips it back. The API nulls
-- the column for every other mode; this is the constraint that says so.

ALTER TABLE public.app_modules
  DROP CONSTRAINT IF EXISTS app_modules_allowed_user_ids_scope;

ALTER TABLE public.app_modules
  ADD CONSTRAINT app_modules_allowed_user_ids_scope
  CHECK (visibility_type = 'custom' OR allowed_user_ids IS NULL);
