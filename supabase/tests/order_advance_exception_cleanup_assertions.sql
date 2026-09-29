-- Test Data Cleanup: an advance exception pinned to a PI version (20270216000000)
-- ===========================================================================
-- The partial failure Order 0526 hit on 2026-09-27: storage was swept, then
-- finalize_test_data_cleanup() refused with
--
--   42501 ORDER_ADVANCE_EXCEPTION_IMMUTABLE
--
-- because deleting the PI cascades to order_pi_versions, whose ON DELETE SET
-- NULL on order_advance_exceptions.pi_version_id is an UPDATE the immutability
-- guard refused. The claim was kept (correctly), and every retry failed again.
--
--   A. the failing shape — a test Order, its approved PI, a PI version, and an
--      advance exception pinned to that version
--   B. THE RETRY — the claim is resumed by the same admin (files already gone,
--      nothing to sweep) and finalization now completes
--   C. idempotency — finalizing the consumed claim answers, deletes nothing
--   D. protections — a real Order is refused at the claim; its advance
--      exception stays immutable outside a cleanup, and inside one only the
--      foreign key's exact SET NULL is allowed
--
-- Runs entirely inside ONE transaction that ends in ROLLBACK.
--
-- PREREQUISITES: a database with production's public schema (for example a
-- private copy restored from `supabase db dump --linked --schema public`) and
-- 20270216000000 applied. Run as a SUPERUSER (supabase_admin locally): the
-- fixture is written with session_replication_role = replica so it can create
-- an already-approved PI without replaying the approval flow. Everything the
-- suite ASSERTS runs with triggers on, as the signed-in admin.
--
--   psql -h 127.0.0.1 -U supabase_admin -d <db> -v ON_ERROR_STOP=1 \
--        -f supabase/tests/order_advance_exception_cleanup_assertions.sql
--
-- Without 20270216000000 section B fails with ORDER_ADVANCE_EXCEPTION_IMMUTABLE.

\set ON_ERROR_STOP on

begin;

-- ── Helpers ─────────────────────────────────────────────────────────────────

create or replace function pg_temp.fails_with(p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return 'NO ERROR';
exception when others then
  return sqlstate || '|' || sqlerrm;
end $$;

create or replace function pg_temp.ok(p_condition boolean, p_what text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'ASSERTION FAILED: %', p_what;
  end if;
end $$;

create or replace function pg_temp.act_as(p_id uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_id, 'role', 'authenticated')::text, true);
end $$;

-- ── The fixture (triggers off) ──────────────────────────────────────────────
--
-- Ids share the prefix a0e5a0e5 so nothing here can be mistaken for real data.

set local session_replication_role = replica;

insert into public.users (id, email, phone, full_name, team, role) values
  ('a0e5a0e5-0000-4000-8000-000000000001', 'adv-admin@boe.test', '+10000009901', 'Adv Admin', 'management', 'admin');

insert into public.test_data_cleanup_settings (id, enabled, permanently_disabled)
values (true, true, false)
on conflict (id) do update set enabled = true, permanently_disabled = false;

-- A. the TEST Order, its approved PI, the version in force, and a below-40%
--    advance exception approved against that version.
insert into public.orders (id, display_number, client_name, status, is_test_data,
                           total_value, source_order_submission_id)
values ('a0e5a0e5-0000-4000-8000-00000000000a', '9901', 'Adv Test Client', 'running', true,
        100000, 'a0e5a0e5-0000-4000-8000-00000000000b');

insert into public.order_submissions (id, order_id, status, client_name, submitted_by, created_by,
                                      approved_by, approved_at, source_workbook_path)
values ('a0e5a0e5-0000-4000-8000-00000000000b', 'a0e5a0e5-0000-4000-8000-00000000000a',
        'approved', 'Adv Test Client',
        'a0e5a0e5-0000-4000-8000-000000000001', 'a0e5a0e5-0000-4000-8000-000000000001',
        'a0e5a0e5-0000-4000-8000-000000000001', now(), 'submissions/fixture/workbook.xlsx');

insert into public.order_pi_versions (id, order_id, submission_id, version_number, status,
                                      decided_by, decided_at, pdf_order_number)
values ('a0e5a0e5-0000-4000-8000-00000000000c', 'a0e5a0e5-0000-4000-8000-00000000000a',
        'a0e5a0e5-0000-4000-8000-00000000000b', 1, 'approved',
        'a0e5a0e5-0000-4000-8000-000000000001', now(), '9901');

insert into public.order_advance_exceptions (id, order_id, value_epoch, pi_version_id,
                                             verified_at_grant, reason, approved_by)
values ('a0e5a0e5-0000-4000-8000-00000000000d', 'a0e5a0e5-0000-4000-8000-00000000000a', 0,
        'a0e5a0e5-0000-4000-8000-00000000000c', 10000,
        'Client paid 10% up front; approved for production', 'a0e5a0e5-0000-4000-8000-000000000001');

-- D. a REAL Order of the same shape — the control.
insert into public.orders (id, display_number, client_name, status, is_test_data,
                           total_value, source_order_submission_id)
values ('a0e5a0e5-0000-4000-8000-00000000001a', '9902', 'Adv Real Client', 'running', false,
        100000, 'a0e5a0e5-0000-4000-8000-00000000001b');

insert into public.order_submissions (id, order_id, status, client_name, submitted_by, created_by,
                                      approved_by, approved_at, source_workbook_path)
values ('a0e5a0e5-0000-4000-8000-00000000001b', 'a0e5a0e5-0000-4000-8000-00000000001a',
        'approved', 'Adv Real Client',
        'a0e5a0e5-0000-4000-8000-000000000001', 'a0e5a0e5-0000-4000-8000-000000000001',
        'a0e5a0e5-0000-4000-8000-000000000001', now(), 'submissions/fixture/workbook.xlsx');

insert into public.order_pi_versions (id, order_id, submission_id, version_number, status,
                                      decided_by, decided_at, pdf_order_number)
values ('a0e5a0e5-0000-4000-8000-00000000001c', 'a0e5a0e5-0000-4000-8000-00000000001a',
        'a0e5a0e5-0000-4000-8000-00000000001b', 1, 'approved',
        'a0e5a0e5-0000-4000-8000-000000000001', now(), '9902');

insert into public.order_advance_exceptions (id, order_id, value_epoch, pi_version_id,
                                             verified_at_grant, reason, approved_by)
values ('a0e5a0e5-0000-4000-8000-00000000001d', 'a0e5a0e5-0000-4000-8000-00000000001a', 0,
        'a0e5a0e5-0000-4000-8000-00000000001c', 10000,
        'Client paid 10% up front; approved for production', 'a0e5a0e5-0000-4000-8000-000000000001');

set local session_replication_role = origin;

-- ── A. the claim is taken on the failing shape ──────────────────────────────

select pg_temp.act_as('a0e5a0e5-0000-4000-8000-000000000001');
set local role authenticated;

create temp table first_claim on commit drop as
select public.begin_test_data_cleanup(
  'order', 'a0e5a0e5-0000-4000-8000-00000000000a', 'advance exception regression', 'DELETE TEST DATA') as c;

select pg_temp.ok((select (c->>'resumed')::boolean = false from first_claim),
  'A1: the first claim is a new one');
select pg_temp.ok((select c->>'order_submission_id' = 'a0e5a0e5-0000-4000-8000-00000000000b' from first_claim),
  'A2: the claim covers the approved PI');

-- ── B. the retry, after the files were already removed ──────────────────────
--
-- The route's first attempt swept storage and then saw finalization refuse. The
-- admin runs it again: the SAME claim comes back (nothing is re-derived), the
-- sweep finds nothing left to remove, and finalization is reached again.

create temp table retry_claim on commit drop as
select public.begin_test_data_cleanup(
  'order', 'a0e5a0e5-0000-4000-8000-00000000000a', 'advance exception regression', 'DELETE TEST DATA') as c;

select pg_temp.ok((select (c->>'resumed')::boolean from retry_claim),
  'B1: the retry resumes the standing claim');
select pg_temp.ok((select r.c->>'claim_token' = f.c->>'claim_token' from retry_claim r, first_claim f),
  'B2: the retry is handed the same claim token');

create temp table finalized on commit drop as
select public.finalize_test_data_cleanup((select (c->>'claim_token')::uuid from retry_claim)) as r;

select pg_temp.ok((select (r->>'already_finalized')::boolean = false from finalized),
  'B3: finalization completes (was ORDER_ADVANCE_EXCEPTION_IMMUTABLE before 20270216000000)');
select pg_temp.ok((select (r->'deleted'->>'orders')::int = 1 and (r->'deleted'->>'order_submissions')::int = 1 from finalized),
  'B4: the Order and its PI are deleted');

reset role;

select pg_temp.ok(not exists (select 1 from public.orders where id = 'a0e5a0e5-0000-4000-8000-00000000000a'),
  'B5: the test Order is gone');
select pg_temp.ok(not exists (select 1 from public.order_pi_versions where order_id = 'a0e5a0e5-0000-4000-8000-00000000000a'),
  'B6: its PI versions are gone');
select pg_temp.ok(not exists (select 1 from public.order_advance_exceptions where order_id = 'a0e5a0e5-0000-4000-8000-00000000000a'),
  'B7: its advance exception is gone with the Order');
select pg_temp.ok((select finalized_at is not null from public.test_data_cleanup_claims
                    where claim_token = (select (c->>'claim_token')::uuid from first_claim)),
  'B8: the claim is consumed, and kept as the record');
-- finalize opens the cleanup context transaction-locally. In production every
-- RPC is its own transaction; this suite is ONE, so the context is closed by
-- hand here, or section D would run inside it.
select set_config('boe.cleanup_context', '', true);

-- ── C. idempotency ──────────────────────────────────────────────────────────

select pg_temp.act_as('a0e5a0e5-0000-4000-8000-000000000001');
set local role authenticated;

select pg_temp.ok(
  (public.finalize_test_data_cleanup((select (c->>'claim_token')::uuid from first_claim))->>'already_finalized')::boolean,
  'C1: finalizing the consumed claim answers instead of acting');

-- ── D. protections ──────────────────────────────────────────────────────────

select pg_temp.ok(
  pg_temp.fails_with($$select public.begin_test_data_cleanup('order', 'a0e5a0e5-0000-4000-8000-00000000001a', 'must refuse', 'DELETE TEST DATA')$$)
    like '%CLEANUP_NOT_ELIGIBLE%',
  'D1: a real Order cannot be claimed');

reset role;

select pg_temp.ok(
  pg_temp.fails_with($$update public.order_advance_exceptions set pi_version_id = null where id = 'a0e5a0e5-0000-4000-8000-00000000001d'$$)
    like '%ORDER_ADVANCE_EXCEPTION_IMMUTABLE%',
  'D2: outside a cleanup, clearing pi_version_id is refused');
select pg_temp.ok(
  pg_temp.fails_with($$delete from public.order_advance_exceptions where id = 'a0e5a0e5-0000-4000-8000-00000000001d'$$)
    like '%ORDER_ADVANCE_EXCEPTION_IMMUTABLE%',
  'D3: outside a cleanup, deleting is refused');
select pg_temp.ok(
  pg_temp.fails_with($$delete from public.order_pi_versions where id = 'a0e5a0e5-0000-4000-8000-00000000001c'$$)
    like '%ORDER_PI_VERSION_IMMUTABLE%',
  'D4: outside a cleanup, the real PI version cannot be deleted either');

-- Inside a cleanup context (set here by hand, as only the finalizers do), the
-- guard allows the foreign key's SET NULL and nothing else.
select set_config('boe.cleanup_context', 'test_data_cleanup', true);

select pg_temp.ok(
  pg_temp.fails_with($$update public.order_advance_exceptions set reason = 'rewritten during a cleanup' where id = 'a0e5a0e5-0000-4000-8000-00000000001d'$$)
    like '%ORDER_ADVANCE_EXCEPTION_IMMUTABLE%',
  'D5: inside a cleanup, any other change is still refused');
select pg_temp.ok(
  pg_temp.fails_with($$update public.order_advance_exceptions set pi_version_id = null, reason = 'rewritten during a cleanup' where id = 'a0e5a0e5-0000-4000-8000-00000000001d'$$)
    like '%ORDER_ADVANCE_EXCEPTION_IMMUTABLE%',
  'D6: inside a cleanup, SET NULL carrying another change is refused');
select pg_temp.ok(
  pg_temp.fails_with($$update public.order_advance_exceptions set pi_version_id = 'a0e5a0e5-0000-4000-8000-00000000000c' where id = 'a0e5a0e5-0000-4000-8000-00000000001d'$$)
    like '%ORDER_ADVANCE_EXCEPTION_IMMUTABLE%',
  'D7: inside a cleanup, repointing pi_version_id is refused');
select pg_temp.ok(
  pg_temp.fails_with($$update public.order_advance_exceptions set pi_version_id = null where id = 'a0e5a0e5-0000-4000-8000-00000000001d'$$)
    = 'NO ERROR',
  'D8: inside a cleanup, exactly the SET NULL is allowed');

select set_config('boe.cleanup_context', '', true);

select pg_temp.ok(
  (select reason = 'Client paid 10% up front; approved for production'
     from public.order_advance_exceptions where id = 'a0e5a0e5-0000-4000-8000-00000000001d'),
  'D9: the real advance exception still says what it said');
select pg_temp.ok(exists (select 1 from public.orders where id = 'a0e5a0e5-0000-4000-8000-00000000001a'),
  'D10: the real Order is untouched');

select 'order_advance_exception_cleanup_assertions: all passed' as result;

rollback;
