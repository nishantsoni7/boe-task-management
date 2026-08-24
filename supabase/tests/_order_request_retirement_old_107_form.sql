-- THE FIRST FORM OF MIGRATION 20261007000000 — the one that failed, preserved
-- ===========================================================================
-- Not a migration. A two-statement excerpt of the first form of
-- 20261007000000, kept verbatim so the suite can reproduce the exact linked
-- failure and prove the corrected form is what fixes it, rather than asserting
-- that from memory.
--
-- Both statements are copied unmodified from commit 2071258's
-- supabase/migrations/20261007000000_retire_order_requests.sql:
--
--   * §1's drop of the permissive INSERT policy, and
--   * §5b's assertion, which counted from pg_policies WITHOUT filtering on
--     `permissive` and so also matched the RESTRICTIVE module gate.
--
-- Expected outcome, and the runner requires exactly this:
--
--   ERROR:  order_requests still has 1 INSERT-capable polic(ies); the retired
--           workflow would remain creatable
--
-- No `begin`/`rollback` here on purpose. The runner invokes this with
-- --single-transaction, which is how a Supabase migration applies, so the raise
-- aborts the whole file and the drop above it rolls back with it — which is the
-- second thing the suite checks.

do $$
declare
  v_count int;
begin
  drop policy if exists "order_requests_requester_insert" on public.order_requests;

  -- 5b. No INSERT policy remains on order_requests, for any role. With RLS on
  -- and no INSERT policy, PostgREST refuses the command outright.
  select count(*) into v_count
  from pg_policies
  where schemaname = 'public'
    and tablename = 'order_requests'
    and cmd in ('INSERT', 'ALL');

  if v_count <> 0 then
    raise exception
      'order_requests still has % INSERT-capable polic(ies); the retired workflow would remain creatable',
      v_count;
  end if;
end $$;
