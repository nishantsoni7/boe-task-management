-- ═════════════════════════════════════════════════════════════════════════════
-- TEST FIXTURE TEARDOWN — Review Workflow Test (Internal) cards
-- ═════════════════════════════════════════════════════════════════════════════
--
-- THIS FILE MUST NEVER ENTER supabase/migrations, AND MUST NEVER DEPLOY.
--
-- It removes exactly the rows customer_review_test_cards.sql inserts, by
-- card_ref, and nothing else. It does not TRUNCATE, it does not
-- `delete from ... ` unqualified, and it does not touch any other table: a
-- teardown that clears more than its fixture created is a teardown that will
-- one day clear something somebody wanted.
--
-- The screenshots and the trail cascade from the cards, which is what makes a
-- reload from a clean state possible. The objects in the private bucket do NOT
-- cascade — Postgres cannot delete a file — so a stack that has had screenshots
-- uploaded to it should be rebuilt with `supabase db reset --no-seed` rather
-- than cleared with this file alone. That is stated here because a teardown
-- that leaves orphaned objects behind while looking complete is worse than one
-- that says what it cannot do.
--
-- HOW IT IS LOADED
--   docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/fixtures/customer_review_test_cards_clear.sql
--
-- IT CARRIES THE SAME GUARD AS THE FIXTURE, for the same reason: a DELETE
-- pointed at production is worse than an INSERT pointed at production.

do $$
declare
  v_marker text;
begin
  select coalesce(shobj_description(oid, 'pg_database'), '')
    into v_marker
  from pg_database
  where datname = current_database();

  if v_marker <> 'boe-disposable-customer-review-test' then
    raise exception
      'REFUSING TO CLEAR TEST DATA: % is not a database marked disposable. Nothing was deleted.',
      current_database()
      using errcode = '42501';
  end if;
end $$;

delete from public.customer_review_test_cards
where card_ref in (
  'TEST-001', 'TEST-002', 'TEST-003', 'TEST-004',
  'TEST-005', 'TEST-006', 'TEST-007', 'TEST-008',
  'TEST-009', 'TEST-010', 'TEST-011', 'TEST-012',
  'TEST-013', 'TEST-014', 'TEST-015', 'TEST-016'
);
