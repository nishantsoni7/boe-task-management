-- permanently_delete_asset() assertions
-- ===========================================================================
-- Covers 20260803000000_asset_permanent_delete.sql: an administrator erasing
-- one asset together with every record that belongs solely to it, and nothing
-- else.
--
-- Runs entirely inside ONE transaction that ends in ROLLBACK, so every fixture
-- is discarded. The asset codes the fixtures consume come from
-- public.asset_code_seq, which is a SEQUENCE — nextval() is NOT transactional,
-- so a handful of codes are burned by running this. That is the only trace it
-- leaves, and it is harmless: the format holds 999,999.
--
-- PREREQUISITES (controlled environment, migrations already applied):
--   * Run with psql as a role that may set session GUCs (standard Supabase
--     `postgres`).
--   * Replace the THREE real user UUIDs below; all must exist and be distinct:
--       test.admin_id     -> a public.users row with role = 'admin', is_active
--       test.employee_id  -> a NON-admin who will hold the doomed asset
--       test.other_id     -> a NON-admin who holds the BYSTANDER asset
--
-- Every guard under test is a SECURITY DEFINER function or a trigger, so this
-- script simulates the session with request.jwt.claims rather than SET ROLE —
-- the same idiom the Order Requests assertion scripts use.
--
-- On success it prints NOTICE 'ALL ASSERTIONS PASSED' and rolls back.

\set ON_ERROR_STOP on

begin;

-- ── Config: the ONLY lines a tester edits ─────────────────────────────────────
do $$
begin
  perform set_config('test.admin_id',    '11111111-1111-1111-1111-111111111111', true); -- REPLACE
  perform set_config('test.employee_id', '22222222-2222-2222-2222-222222222222', true); -- REPLACE
  perform set_config('test.other_id',    '33333333-3333-3333-3333-333333333333', true); -- REPLACE

  perform set_config('t.doomed',    gen_random_uuid()::text, true); -- full history, gets erased
  perform set_config('t.bystander', gen_random_uuid()::text, true); -- full history, must survive
  perform set_config('t.clean',     gen_random_uuid()::text, true); -- no history at all
end $$;

do $$
begin
  assert (select count(*) from public.users
           where id in (current_setting('test.admin_id')::uuid,
                        current_setting('test.employee_id')::uuid,
                        current_setting('test.other_id')::uuid)) = 3,
    'the three configured user ids must all exist — replace the placeholders';
  assert (select role = 'admin' and is_active from public.users
           where id = current_setting('test.admin_id')::uuid),
    'test.admin_id must be an ACTIVE admin';
  assert (select role <> 'admin' from public.users
           where id = current_setting('test.employee_id')::uuid),
    'test.employee_id must NOT be an admin';
end $$;

-- ── Fixtures ─────────────────────────────────────────────────────────────────
-- Two assets built identically, so anything the purge does to one and not the
-- other is visible. Inserting the assets already writes an asset_activity_log
-- row each (assets_log_created), and the service/document/request inserts below
-- write more, so the timeline is populated the way real use populates it.

insert into public.assets (id, asset_type, asset_name, serial_no, status, location)
values
  (current_setting('t.doomed')::uuid,    'laptop', 'ASSERT purge doomed',    'SN-DOOMED',    'available', 'Store Room'),
  (current_setting('t.bystander')::uuid, 'laptop', 'ASSERT purge bystander', 'SN-BYSTANDER', 'available', 'Store Room'),
  (current_setting('t.clean')::uuid,     'mouse',  'ASSERT purge clean',     'SN-CLEAN',     'available', 'Store Room');

-- Custody history: assigned, accepted, returned. Exactly the shape that used to
-- read "This asset has assignment history and cannot be deleted."
insert into public.employee_assets (asset_id, employee_id, assigned_by, status, accepted_at, returned_at)
values
  (current_setting('t.doomed')::uuid,    current_setting('test.employee_id')::uuid,
   current_setting('test.admin_id')::uuid, 'returned', now() - interval '30 days', now() - interval '2 days'),
  (current_setting('t.bystander')::uuid, current_setting('test.other_id')::uuid,
   current_setting('test.admin_id')::uuid, 'returned', now() - interval '30 days', now() - interval '2 days');

insert into public.asset_transfers (asset_id, event_type, to_employee_id, performed_by)
values
  (current_setting('t.doomed')::uuid,    'assigned', current_setting('test.employee_id')::uuid,
   current_setting('test.admin_id')::uuid),
  (current_setting('t.bystander')::uuid, 'assigned', current_setting('test.other_id')::uuid,
   current_setting('test.admin_id')::uuid);

insert into public.asset_service_records (asset_id, service_type, issue, vendor, cost, status, recorded_by)
values
  (current_setting('t.doomed')::uuid,    'repair', 'ASSERT purge screen', 'ACME', 100, 'completed',
   current_setting('test.admin_id')::uuid),
  (current_setting('t.bystander')::uuid, 'repair', 'ASSERT purge screen', 'ACME', 100, 'completed',
   current_setting('test.admin_id')::uuid);

insert into public.asset_documents (asset_id, doc_type, file_name, storage_path, uploaded_by)
values
  (current_setting('t.doomed')::uuid,    'invoice', 'doomed.pdf',
   current_setting('t.doomed') || '/invoice/doomed.pdf',       current_setting('test.admin_id')::uuid),
  (current_setting('t.bystander')::uuid, 'invoice', 'bystander.pdf',
   current_setting('t.bystander') || '/invoice/bystander.pdf', current_setting('test.admin_id')::uuid);

insert into public.asset_change_requests
  (asset_id, asset_name_snapshot, request_type, requested_by, reason, proposed_asset_name)
values
  (current_setting('t.doomed')::uuid,    'ASSERT purge doomed',    'edit',
   current_setting('test.employee_id')::uuid, 'ASSERT purge reason', 'renamed doomed'),
  (current_setting('t.bystander')::uuid, 'ASSERT purge bystander', 'edit',
   current_setting('test.other_id')::uuid,    'ASSERT purge reason', 'renamed bystander');

-- Notifications: one asset_* row per asset (deleted with its asset), one
-- access_* row whose entity_id is the DOOMED asset id (must survive — the type
-- prefix, not the id alone, is what makes a notification the asset's), and one
-- task-shaped row with no entity_id at all.
insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
values
  (current_setting('test.employee_id')::uuid, null, current_setting('t.doomed')::uuid,
   'asset_assigned', 'ASSERT purge doomed assigned', null, true),
  (current_setting('test.other_id')::uuid,    null, current_setting('t.bystander')::uuid,
   'asset_assigned', 'ASSERT purge bystander assigned', null, true),
  (current_setting('test.employee_id')::uuid, null, current_setting('t.doomed')::uuid,
   'access_granted', 'ASSERT purge unrelated access', null, true);

-- Baselines for the "nothing unrelated moved" assertions at the end.
do $$
begin
  perform set_config('t.users_before',    (select count(*) from public.users)::text, true);
  perform set_config('t.notifs_before',   (select count(*) from public.notifications)::text, true);
  perform set_config('t.activity_doomed', (select count(*) from public.asset_activity_log
                                            where asset_id = current_setting('t.doomed')::uuid)::text, true);
end $$;

do $$
begin
  assert current_setting('t.activity_doomed')::int > 0,
    'fixtures should have produced activity for the doomed asset (assets_log_created and friends)';
end $$;

-- ── 1. A NON-ADMIN is refused, even holding assets_access.delete ─────────────
-- The permission engine is not consulted at all: the function's own check is
-- role = 'admin', so this is the strictest possible reading of "admin-only".

-- No SET ROLE: auth.uid() reads the jwt GUCs, and every guard under test is a
-- SECURITY DEFINER function or a trigger, both of which bind the superuser
-- connection too. Staying `postgres` keeps the fixture and injection steps
-- below working without a role dance.
do $$
declare v_msg text;
begin
  perform set_config('request.jwt.claim.sub', current_setting('test.employee_id'), true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('test.employee_id'), 'role', 'authenticated')::text, true);

  begin
    perform public.permanently_delete_asset(current_setting('t.clean')::uuid);
    assert false, 'a non-admin must not be able to permanently delete an asset';
  exception when insufficient_privilege then
    get stacked diagnostics v_msg = message_text;
    assert v_msg like 'ASSET_DELETE_DENIED:%',
      'the refusal must carry the ASSET_DELETE_DENIED marker, got: ' || v_msg;
  end;

  assert exists (select 1 from public.assets where id = current_setting('t.clean')::uuid),
    'a refused delete must leave the asset in place';
end $$;

-- ── 2. An asset with NO history can be permanently deleted ──────────────────

do $$
declare v_res jsonb;
begin
  perform set_config('request.jwt.claim.sub', current_setting('test.admin_id'), true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('test.admin_id'), 'role', 'authenticated')::text, true);

  v_res := public.permanently_delete_asset(current_setting('t.clean')::uuid);

  assert not exists (select 1 from public.assets where id = current_setting('t.clean')::uuid),
    'a never-assigned asset must be gone after the purge';
  assert (v_res->>'assignments')::int = 0, 'the clean asset had no custody rows to report';
  assert (v_res->>'asset_name') = 'ASSERT purge clean', 'the result should name what was deleted';
  assert not exists (select 1 from public.asset_activity_log
                      where asset_id = current_setting('t.clean')::uuid),
    'its creation entry must go too — nothing may point at a deleted asset';
end $$;

-- ── 3. Mid-purge failure leaves NOTHING deleted ─────────────────────────────
-- A trigger that always raises on asset_activity_log DELETE stands in for any
-- failure during dependent deletion. The purge deletes six other child sets
-- BEFORE reaching the timeline, so if the work were not atomic this is exactly
-- where a half-erased asset would appear.
--
-- CREATE FUNCTION and CREATE TRIGGER are transactional, so the ROLLBACK at the
-- end of this script removes both even if the run aborts early.

create or replace function public.assert_purge_boom()
returns trigger language plpgsql as $fn$
begin
  raise exception 'ASSERT_PURGE_BOOM: simulated failure during dependent deletion';
end;
$fn$;

create trigger assert_purge_boom
  before delete on public.asset_activity_log
  for each row execute function public.assert_purge_boom();

do $$
declare v_msg text;
begin
  begin
    perform public.permanently_delete_asset(current_setting('t.doomed')::uuid);
    assert false, 'the injected failure should have aborted the purge';
  -- raise_exception, not others: `assert false` above raises assert_failure,
  -- which must escape rather than be mistaken for the injected failure.
  exception when raise_exception then
    get stacked diagnostics v_msg = message_text;
    assert v_msg like 'ASSERT_PURGE_BOOM:%',
      'expected the injected failure, got: ' || v_msg;
  end;

  -- The whole statement rolled back to the implicit savepoint, so every row the
  -- purge had already removed is back.
  assert exists (select 1 from public.assets where id = current_setting('t.doomed')::uuid),
    'a failed purge must not leave the asset deleted';
  assert (select count(*) from public.employee_assets
           where asset_id = current_setting('t.doomed')::uuid) = 1,
    'a failed purge must not leave custody history deleted';
  assert (select count(*) from public.asset_transfers
           where asset_id = current_setting('t.doomed')::uuid) = 1,
    'a failed purge must not leave movement history deleted';
  assert (select count(*) from public.asset_service_records
           where asset_id = current_setting('t.doomed')::uuid) = 1,
    'a failed purge must not leave service history deleted';
  assert (select count(*) from public.asset_documents
           where asset_id = current_setting('t.doomed')::uuid) = 1,
    'a failed purge must not leave document metadata deleted';
  assert (select count(*) from public.asset_change_requests
           where asset_id = current_setting('t.doomed')::uuid) = 1,
    'a failed purge must not leave change requests deleted';
  assert (select count(*) from public.notifications
           where entity_id = current_setting('t.doomed')::uuid) = 2,
    'a failed purge must not leave notifications deleted';
  assert (select count(*) from public.asset_activity_log
           where asset_id = current_setting('t.doomed')::uuid)
         = current_setting('t.activity_doomed')::int,
    'a failed purge must leave the timeline exactly as it was';
end $$;

drop trigger assert_purge_boom on public.asset_activity_log;
drop function public.assert_purge_boom();

-- ── 4. The append-only guards still refuse everyone else ────────────────────
-- Removing the block for the purge must not have opened a general one.

do $$
declare v_msg text;
begin
  begin
    delete from public.asset_activity_log where asset_id = current_setting('t.doomed')::uuid;
    assert false, 'asset activity must still be undeletable outside a purge';
  exception when insufficient_privilege then
    get stacked diagnostics v_msg = message_text;
    assert v_msg like 'ASSET_ACTIVITY_IMMUTABLE:%', 'unexpected refusal: ' || v_msg;
  end;

  begin
    delete from public.asset_transfers where asset_id = current_setting('t.doomed')::uuid;
    assert false, 'transfer history must still be undeletable outside a purge';
  exception when insufficient_privilege then
    get stacked diagnostics v_msg = message_text;
    assert v_msg like 'ASSET_TRANSFER_IMMUTABLE:%', 'unexpected refusal: ' || v_msg;
  end;

  begin
    delete from public.assets where id = current_setting('t.doomed')::uuid;
    assert false, 'an ordinary DELETE on an asset with history must still be refused';
  exception when insufficient_privilege then
    get stacked diagnostics v_msg = message_text;
    assert v_msg like 'ASSET_DELETE_BLOCKED:%', 'unexpected refusal: ' || v_msg;
  end;
end $$;

-- ── 5. An asset WITH assignment history can be permanently deleted ──────────

do $$
declare v_res jsonb;
begin
  v_res := public.permanently_delete_asset(current_setting('t.doomed')::uuid);

  assert (v_res->>'assignments')::int   = 1, 'the custody period should be reported as removed';
  assert (v_res->>'transfers')::int     = 1, 'the movement row should be reported as removed';
  assert (v_res->>'service')::int       = 1, 'the service record should be reported as removed';
  assert (v_res->>'documents')::int     = 1, 'the document row should be reported as removed';
  assert (v_res->>'requests')::int      = 1, 'the change request should be reported as removed';
  assert (v_res->>'notifications')::int = 1, 'only the asset_* notification should be reported';
  assert (v_res->>'activity')::int      = current_setting('t.activity_doomed')::int,
    'every timeline entry should be reported as removed';
end $$;

-- ── 6. Every dependent record is gone, and nothing is orphaned ──────────────

do $$
begin
  assert not exists (select 1 from public.assets where id = current_setting('t.doomed')::uuid),
    'the asset itself must be gone';
  assert not exists (select 1 from public.employee_assets where asset_id = current_setting('t.doomed')::uuid),
    'custody history must be gone';
  assert not exists (select 1 from public.asset_transfers where asset_id = current_setting('t.doomed')::uuid),
    'movement history must be gone';
  assert not exists (select 1 from public.asset_service_records where asset_id = current_setting('t.doomed')::uuid),
    'service history must be gone';
  assert not exists (select 1 from public.asset_documents where asset_id = current_setting('t.doomed')::uuid),
    'document metadata must be gone';
  assert not exists (select 1 from public.asset_activity_log where asset_id = current_setting('t.doomed')::uuid),
    'the activity timeline must be gone';

  -- The two SET NULL foreign keys are the orphan risk: if either child had been
  -- left in place, it would still be here with asset_id silently nulled.
  assert not exists (
    select 1 from public.asset_change_requests
     where asset_name_snapshot = 'ASSERT purge doomed'
  ), 'no detached change request may survive with only a name snapshot';
  assert not exists (
    select 1 from public.asset_activity_log
     where asset_name_snapshot = 'ASSERT purge doomed'
  ), 'no detached activity entry may survive with only a name snapshot';

  assert not exists (
    select 1 from public.notifications
     where entity_id = current_setting('t.doomed')::uuid
       and left(type::text, 6) = 'asset_'
  ), 'the asset notification must be gone';
end $$;

-- ── 7. Nothing unrelated moved ──────────────────────────────────────────────

do $$
begin
  -- Employees and users are untouched, including the person who held the asset.
  assert (select count(*) from public.users)::text = current_setting('t.users_before'),
    'no user row may be added or removed by a purge';
  assert exists (select 1 from public.users where id = current_setting('test.employee_id')::uuid and is_active),
    'the custodian of the deleted asset must remain an active employee';
  assert exists (select 1 from public.users where id = current_setting('test.admin_id')::uuid),
    'the administrator performing the purge must remain';

  -- The bystander asset keeps every one of its own records.
  assert exists (select 1 from public.assets where id = current_setting('t.bystander')::uuid),
    'an unrelated asset must survive';
  assert (select count(*) from public.employee_assets  where asset_id = current_setting('t.bystander')::uuid) = 1,
    'an unrelated asset keeps its custody history';
  assert (select count(*) from public.asset_transfers  where asset_id = current_setting('t.bystander')::uuid) = 1,
    'an unrelated asset keeps its movement history';
  assert (select count(*) from public.asset_service_records where asset_id = current_setting('t.bystander')::uuid) = 1,
    'an unrelated asset keeps its service history';
  assert (select count(*) from public.asset_documents  where asset_id = current_setting('t.bystander')::uuid) = 1,
    'an unrelated asset keeps its documents';
  assert (select count(*) from public.asset_change_requests where asset_id = current_setting('t.bystander')::uuid) = 1,
    'an unrelated asset keeps its change requests';
  assert (select count(*) from public.asset_activity_log where asset_id = current_setting('t.bystander')::uuid) > 0,
    'an unrelated asset keeps its timeline';

  -- Notifications: only the ONE asset_* row pointing at the doomed asset went.
  -- The access_* row with the SAME entity_id proves the type prefix is doing
  -- the filtering, not the id alone.
  assert exists (
    select 1 from public.notifications
     where entity_id = current_setting('t.doomed')::uuid and type::text = 'access_granted'
  ), 'a non-asset notification must survive even when its entity_id matches';
  assert exists (
    select 1 from public.notifications
     where entity_id = current_setting('t.bystander')::uuid
  ), 'another asset''s notification must survive';
  assert (select count(*) from public.notifications)::int
         = current_setting('t.notifs_before')::int - 1,
    'exactly one notification may be removed by this purge';
end $$;

-- ── 8. The purge flag does not leak past the function ───────────────────────
-- It is transaction-local AND cleared on the way out, so nothing later in this
-- same transaction can ride on it.

do $$
declare v_msg text;
begin
  assert coalesce(nullif(current_setting('boe.asset_purge_id', true), ''), '') = '',
    'the purge flag must be cleared when the function returns';
  assert not public.asset_purge_in_progress(current_setting('t.bystander')::uuid),
    'no asset may read as being purged outside the function';

  begin
    delete from public.assets where id = current_setting('t.bystander')::uuid;
    assert false, 'the bystander must still be protected after a purge of another asset';
  exception when insufficient_privilege then
    get stacked diagnostics v_msg = message_text;
    assert v_msg like 'ASSET_DELETE_BLOCKED:%', 'unexpected refusal: ' || v_msg;
  end;
end $$;

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;

rollback;
