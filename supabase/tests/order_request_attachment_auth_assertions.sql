-- Order Request attachment authorization assertions (RLS + finalization RPCs)
-- ===========================================================================
-- Runs entirely inside ONE transaction that ends in ROLLBACK, so every fixture
-- (draft requests + attachment metadata) is discarded. Asserts ONLY the database
-- authorization contract of 20260711000000_order_request_attachments.sql. Storage
-- API behavior (uploads / signed URLs / object deletion) is NOT duplicated here —
-- see docs/testing/order-request-attachment-storage-tests.md.
--
-- PREREQUISITES (controlled environment, migrations already applied):
--   * Run with psql as a role that may `SET ROLE authenticated` (standard
--     Supabase `postgres` connection).
--   * Replace the THREE real user UUIDs in the config block below:
--       test.admin_id      -> a public.users row with role = 'admin'
--       test.sales_id      -> a NON-admin, ELIGIBLE order assignee (active Sales
--                             member / authorised assignee). Eligibility is
--                             enforced when a draft is assigned to them.
--       test.unrelated_id  -> any other user; not admin, not the assignee.
--     All three must exist in public.users and be distinct.
--
-- On success it prints NOTICE 'ALL ASSERTIONS PASSED' and rolls back. Any failed
-- ASSERT / unexpected result aborts the transaction with an error.

\set ON_ERROR_STOP on

begin;

-- ── Config: the ONLY lines a tester edits ─────────────────────────────────────
do $$
begin
  perform set_config('test.admin_id',     '11111111-1111-1111-1111-111111111111', true); -- REPLACE
  perform set_config('test.sales_id',     '22222222-2222-2222-2222-222222222222', true); -- REPLACE
  perform set_config('test.unrelated_id', '33333333-3333-3333-3333-333333333333', true); -- REPLACE
  -- Fixture request ids (generated placeholders):
  perform set_config('test.d_creator',       gen_random_uuid()::text, true);
  perform set_config('test.d_creator_clean', gen_random_uuid()::text, true);
  perform set_config('test.d_assignee',      gen_random_uuid()::text, true);
  perform set_config('test.d_admin_own',     gen_random_uuid()::text, true);
  perform set_config('test.d_stale',         gen_random_uuid()::text, true);
  perform set_config('test.d_default',       gen_random_uuid()::text, true);
  perform set_config('test.d_explicit_null', gen_random_uuid()::text, true);
end $$;

-- ── Fixtures (created on the superuser connection; RLS bypassed) ──────────────
-- A DRAFT is finalized_at explicitly NULL. request_number is set by the trigger.

-- Creator's own drafts (created_by = sales)
insert into public.order_requests
  (id, client_name, requested_by, created_by, assigned_to, status, finalized_at)
values
  (current_setting('test.d_creator')::uuid,       'ASSERT creator draft', current_setting('test.sales_id')::uuid, current_setting('test.sales_id')::uuid, current_setting('test.sales_id')::uuid, 'submitted', null),
  (current_setting('test.d_creator_clean')::uuid, 'ASSERT creator clean', current_setting('test.sales_id')::uuid, current_setting('test.sales_id')::uuid, current_setting('test.sales_id')::uuid, 'submitted', null);

-- Admin-created drafts assigned to the salesperson (pure-assignee + admin-own)
insert into public.order_requests
  (id, client_name, requested_by, created_by, assigned_to, status, finalized_at)
values
  (current_setting('test.d_assignee')::uuid,  'ASSERT assignee draft',  current_setting('test.admin_id')::uuid, current_setting('test.admin_id')::uuid, current_setting('test.sales_id')::uuid, 'submitted', null),
  (current_setting('test.d_admin_own')::uuid, 'ASSERT admin own draft', current_setting('test.admin_id')::uuid, current_setting('test.admin_id')::uuid, current_setting('test.sales_id')::uuid, 'submitted', null);

-- A Main PI already staged on the admin-created draft: lets us prove the pure
-- assignee cannot READ it while a draft, and lets the admin finalize it later.
insert into public.order_request_attachments
  (order_request_id, attachment_type, file_name, storage_path, uploaded_by)
values
  (current_setting('test.d_assignee')::uuid, 'main_pi', 'admin-pi.xlsx',
   current_setting('test.d_assignee') || '/main-pi/' || gen_random_uuid() || '-admin-pi.xlsx',
   current_setting('test.admin_id')::uuid);

-- Stale draft by an unrelated user, backdated > 24h for the admin sweep/cleanup.
insert into public.order_requests
  (id, client_name, requested_by, created_by, assigned_to, status, finalized_at, created_at)
values
  (current_setting('test.d_stale')::uuid, 'ASSERT stale draft', current_setting('test.unrelated_id')::uuid, current_setting('test.unrelated_id')::uuid, null, 'submitted', null, now() - interval '30 hours');

-- Default-value contract fixtures.
insert into public.order_requests (id, client_name, requested_by, created_by, status)   -- finalized_at OMITTED
values (current_setting('test.d_default')::uuid, 'ASSERT default', current_setting('test.sales_id')::uuid, current_setting('test.sales_id')::uuid, 'submitted');
insert into public.order_requests (id, client_name, requested_by, created_by, status, finalized_at)  -- explicit NULL
values (current_setting('test.d_explicit_null')::uuid, 'ASSERT explicit null', current_setting('test.sales_id')::uuid, current_setting('test.sales_id')::uuid, 'submitted', null);

do $$
begin
  assert (select finalized_at is not null from public.order_requests where id = current_setting('test.d_default')::uuid),
    'omitted finalized_at should receive the now() default (operational)';
  assert (select finalized_at is null from public.order_requests where id = current_setting('test.d_explicit_null')::uuid),
    'explicit finalized_at = null should remain an upload-stage draft';
end $$;

-- ── CREATOR (salesperson): see draft, insert Main PI, finalize, clean ─────────
do $$
declare v_res jsonb;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', current_setting('test.sales_id'), true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('test.sales_id'), 'role', 'authenticated')::text, true);

  assert exists (select 1 from public.order_requests where id = current_setting('test.d_creator')::uuid),
    'creator should see own explicit-null draft';

  insert into public.order_request_attachments
    (order_request_id, attachment_type, file_name, storage_path, uploaded_by)
  values (current_setting('test.d_creator')::uuid, 'main_pi', 'pi.xlsx',
          current_setting('test.d_creator') || '/main-pi/' || gen_random_uuid() || '-pi.xlsx',
          current_setting('test.sales_id')::uuid);

  v_res := public.finalize_order_request(current_setting('test.d_creator')::uuid);
  assert (v_res->>'finalized_now') = 'true', 'creator finalize should perform the transition';

  v_res := public.cleanup_unfinalized_order_request(current_setting('test.d_creator_clean')::uuid);
  assert (v_res->>'deleted') = 'true', 'creator should discard own recent failed draft';
  assert not exists (select 1 from public.order_requests where id = current_setting('test.d_creator_clean')::uuid),
    'creator cleanup should remove the draft row';
end $$;

-- ── PURE ASSIGNEE (salesperson) of an admin draft: no access at all ───────────
do $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', current_setting('test.sales_id'), true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('test.sales_id'), 'role', 'authenticated')::text, true);

  assert not exists (select 1 from public.order_requests where id = current_setting('test.d_assignee')::uuid),
    'pure assignee must not see an unfinalized draft';
  assert (select count(*) from public.order_request_attachments
          where order_request_id = current_setting('test.d_assignee')::uuid) = 0,
    'pure assignee must not read draft metadata (a Main PI exists but is hidden)';

  begin
    insert into public.order_request_attachments
      (order_request_id, attachment_type, file_name, storage_path, uploaded_by)
    values (current_setting('test.d_assignee')::uuid, 'reference', 'x.pdf',
            current_setting('test.d_assignee') || '/references/' || gen_random_uuid() || '-x.pdf',
            current_setting('test.sales_id')::uuid);
    raise exception 'FAIL: pure assignee metadata insert should be denied';
  exception when insufficient_privilege then null;  -- expected: RLS 42501
  end;

  begin
    perform public.finalize_order_request(current_setting('test.d_assignee')::uuid);
    raise exception 'FAIL: pure assignee finalize should be denied';
  exception when insufficient_privilege then null;
  end;

  begin
    perform public.cleanup_unfinalized_order_request(current_setting('test.d_assignee')::uuid);
    raise exception 'FAIL: pure assignee cleanup should be denied';
  exception when insufficient_privilege then null;
  end;
end $$;

-- ── ADMIN: own draft read/insert/finalize + stale-draft cleanup (admin rule) ──
do $$
declare v_res jsonb;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', current_setting('test.admin_id'), true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('test.admin_id'), 'role', 'authenticated')::text, true);

  assert exists (select 1 from public.order_requests where id = current_setting('test.d_admin_own')::uuid),
    'admin should see own draft (creator visibility)';

  insert into public.order_request_attachments
    (order_request_id, attachment_type, file_name, storage_path, uploaded_by)
  values (current_setting('test.d_admin_own')::uuid, 'main_pi', 'admin-own-pi.xlsx',
          current_setting('test.d_admin_own') || '/main-pi/' || gen_random_uuid() || '-pi.xlsx',
          current_setting('test.admin_id')::uuid);

  v_res := public.finalize_order_request(current_setting('test.d_admin_own')::uuid);
  assert (v_res->>'finalized_now') = 'true', 'admin should finalize own draft';

  assert exists (
    select 1 from jsonb_array_elements(public.admin_list_stale_order_request_drafts(24)) e
    where (e->>'id')::uuid = current_setting('test.d_stale')::uuid),
    'admin stale-draft listing should include the > 24h draft';
  v_res := public.cleanup_unfinalized_order_request(current_setting('test.d_stale')::uuid);
  assert (v_res->>'deleted') = 'true', 'admin should clean a stale draft via the admin rule';
end $$;

-- ── AFTER FINALIZATION: assignment access begins ──────────────────────────────
do $$
declare v_res jsonb;
begin
  -- admin finalizes the assignee draft (its single Main PI is already staged)
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', current_setting('test.admin_id'), true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('test.admin_id'), 'role', 'authenticated')::text, true);
  v_res := public.finalize_order_request(current_setting('test.d_assignee')::uuid);
  assert (v_res->>'finalized_now') = 'true', 'admin should finalize the assignee draft';
end $$;

do $$
begin
  -- assigned salesperson now sees the request AND its metadata
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', current_setting('test.sales_id'), true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('test.sales_id'), 'role', 'authenticated')::text, true);
  assert exists (select 1 from public.order_requests where id = current_setting('test.d_assignee')::uuid),
    'assigned salesperson should see the request after finalization';
  assert (select count(*) from public.order_request_attachments
          where order_request_id = current_setting('test.d_assignee')::uuid) = 1,
    'assigned salesperson should read attachment metadata after finalization';
end $$;

do $$
begin
  -- unrelated user sees neither the request nor its metadata
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', current_setting('test.unrelated_id'), true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('test.unrelated_id'), 'role', 'authenticated')::text, true);
  assert not exists (select 1 from public.order_requests where id = current_setting('test.d_assignee')::uuid),
    'unrelated user must not see the request';
  assert (select count(*) from public.order_request_attachments
          where order_request_id = current_setting('test.d_assignee')::uuid) = 0,
    'unrelated user must not read metadata';
end $$;

reset role;

-- ── Activity CHECK constraint: the migration REWRITES it, so every previously
-- permitted value must survive alongside the new one. This guards the exact
-- defect found on 2026-07-25: an earlier draft of 20260711 re-created the
-- constraint from an older list and silently revoked 'request_edited', which
-- would have made every edit_order_request() call fail with 23514 — invisible
-- until the first real edit, because the activity table was empty at apply time.
do $$
declare
  v_def text;
  v_missing text[] := '{}';
  v_value text;
begin
  select pg_get_constraintdef(c.oid) into v_def
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public'
    and t.relname = 'order_request_activity'
    and c.conname = 'order_request_activity_event_type_check';

  assert v_def is not null, 'order_request_activity_event_type_check must exist';

  foreach v_value in array array[
    'request_submitted', 'status_changed', 'request_converted',
    'clarification_requested', 'clarification_resubmitted', 'request_rejected',
    'reapplication_submitted', 'payment_linked', 'payment_unlinked',
    'request_edited',        -- 20260708 — the one that was nearly dropped
    'attachments_uploaded'   -- 20260711
  ] loop
    if position('''' || v_value || '''' in v_def) = 0 then
      v_missing := array_append(v_missing, v_value);
    end if;
  end loop;

  assert cardinality(v_missing) = 0,
    'event_type CHECK is missing permitted value(s): ' || array_to_string(v_missing, ', ');
end $$;

-- Behavioural proof, not just text matching: a request_edited row must still be
-- insertable after this migration has rewritten the constraint.
do $$
declare v_req uuid := current_setting('test.d_assignee')::uuid;
begin
  insert into public.order_request_activity (order_request_id, event_type, actor_id)
  values (v_req, 'request_edited', current_setting('test.creator_id')::uuid);
  assert exists (
    select 1 from public.order_request_activity
    where order_request_id = v_req and event_type = 'request_edited'
  ), 'a request_edited activity row must still be insertable after 20260711';
end $$;

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;

rollback;
