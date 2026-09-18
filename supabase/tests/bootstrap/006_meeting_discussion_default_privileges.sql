-- ═════════════════════════════════════════════════════════════════════════════
-- TEST-ONLY — production's default privileges on the public schema
-- ═════════════════════════════════════════════════════════════════════════════
--
-- THIS FILE MUST NEVER ENTER supabase/migrations, AND MUST NEVER DEPLOY.
--
-- Loaded FIRST by supabase/tests/run_meeting_discussion_workflow_local.sh, before
-- any table or function exists, because default privileges only apply to objects
-- created after them.
--
-- WHY IT EXISTS
-- -------------
-- The migrations never GRANT table INSERT/SELECT or function EXECUTE on most of
-- what they create. They rely on the project's default privileges, and REVOKE
-- where they want less (20260814000000 §8i is the example). A current Supabase CLI
-- (2.114) starts a local stack whose `postgres` defaults give `authenticated` only
-- DELETE/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN on new tables and no EXECUTE on new
-- functions — so on that stack `INSERT INTO meetings` is refused before RLS is
-- ever consulted, and every RLS policy that calls a helper function fails. A test
-- that fails where production succeeds proves nothing.
--
-- These three statements are production's, read from the linked production
-- catalogue (pg_default_acl for the public schema, role postgres, read-only,
-- 2026-09-16):
--
--   r  {postgres=arwdDxtm, anon=arwdDxtm, authenticated=arwdDxtm, service_role=arwdDxtm}
--   S  {postgres=rwU,      anon=rwU,      authenticated=rwU,      service_role=rwU}
--   f  {postgres=X,        anon=X,        authenticated=X,        service_role=X}
--
-- The same catalogue read confirmed the effect on a real table: production's
-- public.meetings grants authenticated DELETE, INSERT, SELECT (the rest revoked by
-- 20260814000000), and public.tasks grants authenticated all seven privileges.

alter default privileges for role postgres in schema public
  grant all on tables to anon, authenticated, service_role;

alter default privileges for role postgres in schema public
  grant all on sequences to anon, authenticated, service_role;

alter default privileges for role postgres in schema public
  grant execute on functions to anon, authenticated, service_role;
