-- remove_unfinalized_order_request_attachment() assertions
-- ===========================================================================
-- Covers §10 of 20260711000000_order_request_attachments.sql: removing ONE
-- optional reference attachment from a live draft, without discarding the draft
-- and without ever exposing a general DELETE on order_request_attachments.
--
-- Runs entirely inside ONE transaction that ends in ROLLBACK, so every fixture
-- (drafts, a finalized request, a converted request and its Order) is discarded.
-- The Order created for the converted fixture allocates a Confirmed Order number
-- from public.order_number_cycle, which is a TABLE row — so the ROLLBACK returns
-- the cycle to its previous value and no number is burned.
--
-- PREREQUISITES (controlled environment, migrations already applied):
--   * Run with psql as a role that may SET ROLE (standard Supabase `postgres`).
--   * Replace the THREE real user UUIDs below; all must exist and be distinct:
--       test.admin_id      -> a public.users row with role = 'admin'
--       test.sales_id      -> a NON-admin, ELIGIBLE order assignee
--       test.unrelated_id  -> any other user; not admin, not the assignee
--
-- On success it prints NOTICE 'ALL ASSERTIONS PASSED' and rolls back.

\set ON_ERROR_STOP on

begin;

-- ── Config: the ONLY lines a tester edits ─────────────────────────────────────
do $$
begin
  perform set_config('test.admin_id',     '11111111-1111-1111-1111-111111111111', true); -- REPLACE
  perform set_config('test.sales_id',     '22222222-2222-2222-2222-222222222222', true); -- REPLACE
  perform set_config('test.unrelated_id', '33333333-3333-3333-3333-333333333333', true); -- REPLACE

  perform set_config('t.d_creator',   gen_random_uuid()::text, true); -- draft created by sales
  perform set_config('t.d_admin',     gen_random_uuid()::text, true); -- draft created by admin, assigned to sales
  perform set_config('t.d_final',     gen_random_uuid()::text, true); -- finalized request
  perform set_config('t.d_conv',      gen_random_uuid()::text, true); -- converted request
end $$;

-- ── Fixtures (superuser connection; RLS bypassed) ─────────────────────────────
insert into public.order_requests
  (id, client_name, requested_by, created_by, assigned_to, status, finalized_at)
values
  (current_setting('t.d_creator')::uuid, 'ASSERT removal creator draft',
   current_setting('test.sales_id')::uuid, current_setting('test.sales_id')::uuid,
   current_setting('test.sales_id')::uuid, 'submitted', null),
  (current_setting('t.d_admin')::uuid,   'ASSERT removal admin draft',
   current_setting('test.admin_id')::uuid, current_setting('test.admin_id')::uuid,
   current_setting('test.sales_id')::uuid, 'submitted', null),
  (current_setting('t.d_final')::uuid,   'ASSERT removal finalized',
   current_setting('test.sales_id')::uuid, current_setting('test.sales_id')::uuid,
   current_setting('test.sales_id')::uuid, 'submitted', now());

-- Converted fixture needs a real Order (FK + the converted-consistency CHECK).
-- display_number is overwritten by orders_assign_display_number regardless.
do $$
declare v_order uuid;
begin
  insert into public.orders (display_number, client_name)
  values ('0000', 'ASSERT removal converted order')
  returning id into v_order;

  insert into public.order_requests
    (id, client_name, requested_by, created_by, assigned_to, status,
     finalized_at, converted_order_id, converted_at)
  values
    (current_setting('t.d_conv')::uuid, 'ASSERT removal converted',
     current_setting('test.sales_id')::uuid, current_setting('test.sales_id')::uuid,
     current_setting('test.sales_id')::uuid, 'converted',
     now(), v_order, now());
end $$;

-- Attachments. The creator draft carries a Main PI plus TWO references, so we can
-- prove that removing one leaves the other AND the Main PI untouched.
do $$
declare
  v_main uuid; v_a uuid; v_b uuid; v_admin_ref uuid; v_final_ref uuid; v_conv_ref uuid;
begin
  insert into public.order_request_attachments
    (order_request_id, attachment_type, file_name, storage_path, uploaded_by)
  values (current_setting('t.d_creator')::uuid, 'main_pi', 'pi.xlsx',
          current_setting('t.d_creator')||'/main-pi/'||gen_random_uuid()||'-pi.xlsx',
          current_setting('test.sales_id')::uuid)
  returning id into v_main;

  insert into public.order_request_attachments
    (order_request_id, attachment_type, file_name, storage_path, uploaded_by)
  values (current_setting('t.d_creator')::uuid, 'reference', 'a.pdf',
          current_setting('t.d_creator')||'/references/'||gen_random_uuid()||'-a.pdf',
          current_setting('test.sales_id')::uuid)
  returning id into v_a;

  insert into public.order_request_attachments
    (order_request_id, attachment_type, file_name, storage_path, uploaded_by)
  values (current_setting('t.d_creator')::uuid, 'reference', 'b.pdf',
          current_setting('t.d_creator')||'/references/'||gen_random_uuid()||'-b.pdf',
          current_setting('test.sales_id')::uuid)
  returning id into v_b;

  insert into public.order_request_attachments
    (order_request_id, attachment_type, file_name, storage_path, uploaded_by)
  values (current_setting('t.d_admin')::uuid, 'reference', 'admin-ref.pdf',
          current_setting('t.d_admin')||'/references/'||gen_random_uuid()||'-admin-ref.pdf',
          current_setting('test.admin_id')::uuid)
  returning id into v_admin_ref;

  insert into public.order_request_attachments
    (order_request_id, attachment_type, file_name, storage_path, uploaded_by)
  values (current_setting('t.d_final')::uuid, 'reference', 'final-ref.pdf',
          current_setting('t.d_final')||'/references/'||gen_random_uuid()||'-final-ref.pdf',
          current_setting('test.sales_id')::uuid)
  returning id into v_final_ref;

  insert into public.order_request_attachments
    (order_request_id, attachment_type, file_name, storage_path, uploaded_by)
  values (current_setting('t.d_conv')::uuid, 'reference', 'conv-ref.pdf',
          current_setting('t.d_conv')||'/references/'||gen_random_uuid()||'-conv-ref.pdf',
          current_setting('test.sales_id')::uuid)
  returning id into v_conv_ref;

  perform set_config('t.a_main',      v_main::text, true);
  perform set_config('t.a_a',         v_a::text, true);
  perform set_config('t.a_b',         v_b::text, true);
  perform set_config('t.a_admin_ref', v_admin_ref::text, true);
  perform set_config('t.a_final_ref', v_final_ref::text, true);
  perform set_config('t.a_conv_ref',  v_conv_ref::text, true);
end $$;

-- Impersonation helper: makes auth.uid() return the given user. The RPC is
-- SECURITY DEFINER and authorizes from auth.uid(), so this is the whole gate.
create or replace function pg_temp.act_as(p_uid text) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_uid, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
end $$;

-- Runs the RPC and returns the SQLSTATE it raised, or null if it succeeded.
-- The assert is always made by the CALLER, outside any exception handler, so a
-- failing assert can never be swallowed and misreported (a trap this repo has
-- already been bitten by once).
create or replace function pg_temp.removal_sqlstate(p_att uuid) returns text
language plpgsql as $$
begin
  perform public.remove_unfinalized_order_request_attachment(p_att);
  return null;
exception when others then
  return sqlstate;
end $$;

-- ── 1–4. Function shape and grants ────────────────────────────────────────────
do $$
declare v_oid oid; v_secdef boolean; v_config text[];
begin
  select p.oid, p.prosecdef, p.proconfig into v_oid, v_secdef, v_config
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'remove_unfinalized_order_request_attachment';

  assert v_oid is not null, '1. function must exist';
  assert v_secdef, '2. function must be SECURITY DEFINER';
  assert v_config @> array['search_path=public'],
    '2b. function must pin search_path=public, got: ' || coalesce(array_to_string(v_config, ','), 'null');

  assert not has_function_privilege('public',
    'public.remove_unfinalized_order_request_attachment(uuid)', 'EXECUTE'),
    '3. PUBLIC must not execute';
  assert not has_function_privilege('anon',
    'public.remove_unfinalized_order_request_attachment(uuid)', 'EXECUTE'),
    '3b. anon must not execute';
  assert has_function_privilege('authenticated',
    'public.remove_unfinalized_order_request_attachment(uuid)', 'EXECUTE'),
    '4. authenticated must execute';
end $$;

-- ── 7–8. Denied callers (checked BEFORE the allowed ones, so a wrongly-permissive
--         function cannot pass by having already deleted the row) ──────────────
do $$
declare v_state text;
begin
  -- A pure assignee (assigned_to but not creator) on an admin-created draft.
  perform pg_temp.act_as(current_setting('test.sales_id'));
  v_state := pg_temp.removal_sqlstate(current_setting('t.a_admin_ref')::uuid);
  assert v_state = '42501', '7. non-creator assignee must be refused 42501, got ' || coalesce(v_state, 'success');
  assert exists (select 1 from public.order_request_attachments where id = current_setting('t.a_admin_ref')::uuid),
    '7b. the assignee-refused row must still exist';

  -- An unrelated authenticated user.
  perform pg_temp.act_as(current_setting('test.unrelated_id'));
  v_state := pg_temp.removal_sqlstate(current_setting('t.a_a')::uuid);
  assert v_state = '42501', '8. unrelated user must be refused 42501, got ' || coalesce(v_state, 'success');
  assert exists (select 1 from public.order_request_attachments where id = current_setting('t.a_a')::uuid),
    '8b. the unrelated-refused row must still exist';
end $$;

-- ── 9. The Main PI is never individually removable ────────────────────────────
do $$
declare v_state text;
begin
  perform pg_temp.act_as(current_setting('test.sales_id'));   -- the creator
  v_state := pg_temp.removal_sqlstate(current_setting('t.a_main')::uuid);
  assert v_state = '42501', '9. Main PI removal must be refused 42501, got ' || coalesce(v_state, 'success');
  assert exists (select 1 from public.order_request_attachments where id = current_setting('t.a_main')::uuid),
    '9b. the Main PI row must survive';

  -- ...and not even for an admin.
  perform pg_temp.act_as(current_setting('test.admin_id'));
  v_state := pg_temp.removal_sqlstate(current_setting('t.a_main')::uuid);
  assert v_state = '42501', '9c. admin must not remove a Main PI either, got ' || coalesce(v_state, 'success');
end $$;

-- ── 10–11. Finalized and converted requests are untouchable ───────────────────
do $$
declare v_state text;
begin
  perform pg_temp.act_as(current_setting('test.sales_id'));
  v_state := pg_temp.removal_sqlstate(current_setting('t.a_final_ref')::uuid);
  assert v_state = '42501', '10. finalized request attachment must be refused 42501, got ' || coalesce(v_state, 'success');
  assert exists (select 1 from public.order_request_attachments where id = current_setting('t.a_final_ref')::uuid),
    '10b. finalized request attachment must survive';

  v_state := pg_temp.removal_sqlstate(current_setting('t.a_conv_ref')::uuid);
  assert v_state = '42501', '11. converted request attachment must be refused 42501, got ' || coalesce(v_state, 'success');
  assert exists (select 1 from public.order_request_attachments where id = current_setting('t.a_conv_ref')::uuid),
    '11b. converted request attachment must survive';

  -- An admin gets exactly the same refusals — this is not a role gate.
  perform pg_temp.act_as(current_setting('test.admin_id'));
  assert pg_temp.removal_sqlstate(current_setting('t.a_final_ref')::uuid) = '42501',
    '10c. admin must not remove a finalized request attachment';
  assert pg_temp.removal_sqlstate(current_setting('t.a_conv_ref')::uuid) = '42501',
    '11c. admin must not remove a converted request attachment';
end $$;

-- ── 5, 12–14. Creator removes ONE reference; everything else survives ─────────
do $$
declare v_res jsonb;
begin
  perform pg_temp.act_as(current_setting('test.sales_id'));
  v_res := public.remove_unfinalized_order_request_attachment(current_setting('t.a_a')::uuid);

  assert (v_res->>'removed')::boolean, '5. creator must remove their own draft reference';
  assert v_res->>'attachment_id' = current_setting('t.a_a'), '5b. response must identify the removed attachment';
  assert v_res->>'storage_path' is not null, '5c. response must return the storage path for reconciliation';
  assert v_res->>'file_name' = 'a.pdf', '5d. response must name the removed file';

  assert not exists (select 1 from public.order_request_attachments where id = current_setting('t.a_a')::uuid),
    '12. the selected row must be gone';
  assert exists (select 1 from public.order_request_attachments where id = current_setting('t.a_b')::uuid),
    '13. the OTHER reference must remain';
  assert exists (select 1 from public.order_request_attachments where id = current_setting('t.a_main')::uuid),
    '14. the Main PI must remain';
  assert (select count(*) from public.order_request_attachments
          where order_request_id = current_setting('t.d_creator')::uuid) = 2,
    '12b. exactly one row may be removed';
  -- The draft itself must survive — that is the whole point of this RPC.
  assert exists (select 1 from public.order_requests
                 where id = current_setting('t.d_creator')::uuid and finalized_at is null),
    '5e. the draft must remain usable after a single removal';
end $$;

-- ── 15. Repeated removal converges (idempotent not-found, not an error) ───────
do $$
declare v_res jsonb;
begin
  perform pg_temp.act_as(current_setting('test.sales_id'));
  v_res := public.remove_unfinalized_order_request_attachment(current_setting('t.a_a')::uuid);
  assert (v_res->>'removed')::boolean is false, '15. a repeated removal must not report a second removal';
  assert v_res->>'reason' = 'not_found', '15b. a repeated removal must return the standard not_found reason';
end $$;

-- ── 6. Admin removes a reference from a draft they did not create ─────────────
do $$
declare v_res jsonb;
begin
  perform pg_temp.act_as(current_setting('test.admin_id'));
  v_res := public.remove_unfinalized_order_request_attachment(current_setting('t.a_admin_ref')::uuid);
  assert (v_res->>'removed')::boolean, '6. admin must remove an unfinalized reference';
  assert not exists (select 1 from public.order_request_attachments where id = current_setting('t.a_admin_ref')::uuid),
    '6b. the admin-removed row must be gone';
end $$;

-- ── Unauthenticated ───────────────────────────────────────────────────────────
do $$
declare v_state text;
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  v_state := pg_temp.removal_sqlstate(current_setting('t.a_b')::uuid);
  assert v_state = '42501', 'unauthenticated caller must be refused 42501, got ' || coalesce(v_state, 'success');
  assert exists (select 1 from public.order_request_attachments where id = current_setting('t.a_b')::uuid),
    'the row must survive an unauthenticated attempt';
end $$;

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;

rollback;
