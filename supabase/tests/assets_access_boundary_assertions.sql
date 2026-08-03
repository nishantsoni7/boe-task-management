-- Assets & Access data-boundary assertions
-- ===========================================================================
-- Covers 20260810000000_assets_access_own_records_boundary.sql: an employee
-- holding only the system-default 'view' can reach their OWN asset records and
-- nothing else, a manager's authority comes from a grant rather than a role
-- name, and approving a request is never a back door to an action the approver
-- could not perform directly.
--
-- Every check runs as the real Postgres role `authenticated` with a simulated
-- JWT, so RLS is genuinely enforced — a script that only calls the definer
-- functions would prove nothing about the SELECT policies, which are exactly
-- where the defect lived.
--
-- Runs inside ONE transaction that ends in ROLLBACK, so every fixture and every
-- permission override is discarded. The asset codes the fixtures consume come
-- from public.asset_code_seq, which is a SEQUENCE — nextval() is NOT
-- transactional, so a handful of codes are burned by running this. That is the
-- only trace it leaves, and it is harmless: the format holds 999,999.
--
-- PREREQUISITES (controlled environment, migrations already applied):
--   * 20260803000000 (permanently_delete_asset) AND 20260810000000 must both be
--     applied. Section 5b asserts against both.
--   * Run with psql as a role that may SET ROLE and set session GUCs
--     (standard Supabase `postgres`).
--   * Replace the FOUR real user UUIDs below; all must exist and be distinct:
--       test.admin_id      -> public.users row, role = 'admin', is_active
--       test.employee_a    -> a NON-admin, holds asset A
--       test.employee_b    -> a DIFFERENT non-admin, holds asset B
--       test.manager_id    -> a NON-admin who is granted 'manage' below
--     employee_a and employee_b are two DISTINCT people on purpose: a
--     cross-user isolation test with one user proves nothing.
--   * employee_a, employee_b and manager_id must hold NO employee override for
--     assets_access beyond the system default. The script asserts this.
--
-- On success it prints NOTICE 'ALL ASSERTIONS PASSED' and rolls back.

\set ON_ERROR_STOP on

begin;

-- ── Config: the ONLY lines a tester edits ─────────────────────────────────────
do $$
begin
  perform set_config('test.admin_id',   '11111111-1111-1111-1111-111111111111', true); -- REPLACE
  perform set_config('test.employee_a', '22222222-2222-2222-2222-222222222222', true); -- REPLACE
  perform set_config('test.employee_b', '33333333-3333-3333-3333-333333333333', true); -- REPLACE
  perform set_config('test.manager_id', '44444444-4444-4444-4444-444444444444', true); -- REPLACE

  perform set_config('t.asset_a',    gen_random_uuid()::text, true); -- held by employee_a
  perform set_config('t.asset_b',    gen_random_uuid()::text, true); -- held by employee_b
  perform set_config('t.asset_free', gen_random_uuid()::text, true); -- held by nobody
  perform set_config('t.req_b',      gen_random_uuid()::text, true); -- employee_b's request
end $$;

do $$
begin
  assert (select count(distinct id) from public.users
           where id in (current_setting('test.admin_id')::uuid,
                        current_setting('test.employee_a')::uuid,
                        current_setting('test.employee_b')::uuid,
                        current_setting('test.manager_id')::uuid)) = 4,
    'the four configured user ids must all exist and be distinct — replace the placeholders';
  assert (select role = 'admin' and is_active from public.users
           where id = current_setting('test.admin_id')::uuid),
    'test.admin_id must be an ACTIVE admin';
  assert (select bool_and(role <> 'admin' and is_active) from public.users
           where id in (current_setting('test.employee_a')::uuid,
                        current_setting('test.employee_b')::uuid,
                        current_setting('test.manager_id')::uuid)),
    'employee_a, employee_b and manager_id must all be ACTIVE non-admins';

  -- The premise of the whole script: these three resolve 'view' and nothing
  -- more. A leftover management override would make every result below lie.
  --
  -- A live `view = true` override is explicitly TOLERATED. Most employees carry
  -- one from the 2026-07-16 Control Center grants, and it is identical in effect
  -- to the system default 20260723000000 §1 gives everybody — so requiring zero
  -- rows would reject almost every real user for no reason. What must not exist
  -- is a create/assign/edit/delete/manage grant, or a view DENY.
  assert (select count(*) from public.employee_permission_overrides eo
            join public.permission_modules pm on pm.id = eo.module_id
            join public.permission_actions   pa on pa.id = eo.action_id
           where pm.module_key = 'assets_access'
             and eo.revoked_at is null
             and eo.user_id in (current_setting('test.employee_a')::uuid,
                                current_setting('test.employee_b')::uuid,
                                current_setting('test.manager_id')::uuid)
             and (pa.action_key <> 'view' or not eo.allowed)) = 0,
    'the three non-admin test users must hold no live assets_access override beyond view=true';
end $$;

-- ── Fixtures ─────────────────────────────────────────────────────────────────
-- Three assets built identically apart from who holds them, so anything one
-- employee can see about another's is visible as a difference.

insert into public.assets (id, asset_type, asset_name, serial_no, status, location)
values
  (current_setting('t.asset_a')::uuid,    'laptop', 'ASSERT boundary A',    'SN-BOUND-A', 'assigned',  'Store Room'),
  (current_setting('t.asset_b')::uuid,    'laptop', 'ASSERT boundary B',    'SN-BOUND-B', 'assigned',  'Store Room'),
  (current_setting('t.asset_free')::uuid, 'mouse',  'ASSERT boundary free', 'SN-BOUND-F', 'available', 'Store Room');

insert into public.employee_assets (asset_id, employee_id, assigned_by, status, accepted_at)
values
  (current_setting('t.asset_a')::uuid, current_setting('test.employee_a')::uuid,
   current_setting('test.admin_id')::uuid, 'accepted', now() - interval '10 days'),
  (current_setting('t.asset_b')::uuid, current_setting('test.employee_b')::uuid,
   current_setting('test.admin_id')::uuid, 'accepted', now() - interval '10 days');

insert into public.asset_transfers (asset_id, event_type, to_employee_id, performed_by)
values
  (current_setting('t.asset_a')::uuid, 'assigned', current_setting('test.employee_a')::uuid,
   current_setting('test.admin_id')::uuid),
  (current_setting('t.asset_b')::uuid, 'assigned', current_setting('test.employee_b')::uuid,
   current_setting('test.admin_id')::uuid);

insert into public.asset_service_records (asset_id, service_type, issue, vendor, cost, status, recorded_by)
values
  (current_setting('t.asset_a')::uuid, 'repair', 'ASSERT boundary A screen', 'ACME', 100, 'completed',
   current_setting('test.admin_id')::uuid),
  (current_setting('t.asset_b')::uuid, 'repair', 'ASSERT boundary B screen', 'ACME', 100, 'completed',
   current_setting('test.admin_id')::uuid);

insert into public.asset_documents (asset_id, doc_type, file_name, storage_path, uploaded_by)
values
  (current_setting('t.asset_a')::uuid, 'invoice', 'a.pdf',
   current_setting('t.asset_a') || '/invoice/a.pdf', current_setting('test.admin_id')::uuid),
  (current_setting('t.asset_b')::uuid, 'invoice', 'b.pdf',
   current_setting('t.asset_b') || '/invoice/b.pdf', current_setting('test.admin_id')::uuid);

-- One request filed by employee_b about their own asset. employee_a must never
-- see it, and must never be able to decide it.
insert into public.asset_change_requests
  (id, asset_id, asset_name_snapshot, request_type, requested_by, reason, proposed_asset_name)
values
  (current_setting('t.req_b')::uuid, current_setting('t.asset_b')::uuid, 'ASSERT boundary B', 'edit',
   current_setting('test.employee_b')::uuid, 'ASSERT boundary reason', 'renamed B');

-- A credential belonging to employee_b, so "employee_a cannot read it" is a
-- test against a row that exists rather than against an empty table.
insert into public.access_records (employee_id, access_type, username, secret_value, status, updated_by)
values (current_setting('test.employee_b')::uuid, 'gmail', 'assert.boundary.b@example.com',
        'ASSERT-secret', 'active', current_setting('test.admin_id')::uuid);

-- ── Helper: become a signed-in employee ──────────────────────────────────────
-- The claims GUC is what auth.uid() reads; SET LOCAL ROLE is what makes RLS
-- apply at all. Both are transaction-local.

create or replace function pg_temp.act_as(p_uid uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_uid::text, 'role', 'authenticated')::text,
                     true);
end $$;

-- ═══ 1. The predicates themselves ═══════════════════════════════════════════

select pg_temp.act_as(current_setting('test.employee_a')::uuid);
set local role authenticated;
do $$
begin
  assert public.can_access_assets_module(),
    'an employee with the system-default view must be able to ENTER the module';
  assert not public.can_view_asset_inventory(),
    'THE DEFECT: an employee with only view must NOT see the organisation-wide inventory';
  assert not public.can_review_asset_requests(),
    'an employee must not be able to review requests';
  assert not public.can_read_asset_records(),
    'the shared record-read predicate must no longer answer yes to a plain viewer';
  assert public.holds_or_held_asset(current_setting('t.asset_a')::uuid),
    'employee_a holds asset A';
  assert not public.holds_or_held_asset(current_setting('t.asset_b')::uuid),
    'employee_a does not hold asset B';
end $$;
reset role;

select pg_temp.act_as(current_setting('test.manager_id')::uuid);
set local role authenticated;
do $$
begin
  assert not public.can_view_asset_inventory(),
    'the manager ROLE alone must confer no inventory access';
  assert not public.can_review_asset_requests(),
    'the manager ROLE alone must confer no review right';
end $$;
reset role;

select pg_temp.act_as(current_setting('test.admin_id')::uuid);
set local role authenticated;
do $$
begin
  assert public.can_view_asset_inventory(), 'an admin sees the inventory';
  assert public.can_review_asset_requests(), 'an admin reviews requests';
  assert public.can_write_asset_records(),  'an admin writes asset records';
end $$;
reset role;

-- ═══ 2. Employee A: own records only ════════════════════════════════════════

select pg_temp.act_as(current_setting('test.employee_a')::uuid);
set local role authenticated;
do $$
begin
  -- 2a. assets — the asset they hold, and no other.
  assert exists (select 1 from public.assets where id = current_setting('t.asset_a')::uuid),
    'employee_a must be able to read the asset they hold';
  assert not exists (select 1 from public.assets where id = current_setting('t.asset_b')::uuid),
    'employee_a must NOT be able to read employee_b''s asset by direct id';
  assert not exists (select 1 from public.assets where id = current_setting('t.asset_free')::uuid),
    'employee_a must NOT be able to read an unassigned asset by direct id';

  -- 2b. A search of the inventory returns exactly the assets they hold.
  assert (select count(*) from public.assets
           where asset_name like 'ASSERT boundary%') = 1,
    'employee_a searching assets must find only their own';

  -- 2c. employee_assets — their assignment, not anyone else's.
  assert exists (select 1 from public.employee_assets
                  where asset_id = current_setting('t.asset_a')::uuid),
    'employee_a must be able to read their own assignment';
  assert not exists (select 1 from public.employee_assets
                      where employee_id = current_setting('test.employee_b')::uuid),
    'employee_a must NOT be able to read employee_b''s assignment';

  -- 2d. History tables — B's asset is invisible in every one of them.
  assert not exists (select 1 from public.asset_transfers
                      where asset_id = current_setting('t.asset_b')::uuid),
    'employee_a must NOT read employee_b''s transfers';
  assert not exists (select 1 from public.asset_service_records
                      where asset_id = current_setting('t.asset_b')::uuid),
    'employee_a must NOT read employee_b''s service records';
  assert not exists (select 1 from public.asset_documents
                      where asset_id = current_setting('t.asset_b')::uuid),
    'employee_a must NOT read employee_b''s documents';
  assert not exists (select 1 from public.asset_change_requests
                      where id = current_setting('t.req_b')::uuid),
    'employee_a must NOT read employee_b''s change request';
  assert not exists (select 1 from public.asset_activity_log
                      where asset_id = current_setting('t.asset_b')::uuid),
    'employee_a must NOT read employee_b''s activity history';

  -- 2e. …and their own history is still there.
  assert exists (select 1 from public.asset_service_records
                  where asset_id = current_setting('t.asset_a')::uuid),
    'employee_a must still read the service history of the asset they hold';
  assert exists (select 1 from public.asset_documents
                  where asset_id = current_setting('t.asset_a')::uuid),
    'employee_a must still read the documents of the asset they hold';

  -- 2f. Access records: their own only. secret_value is never another's.
  assert not exists (select 1 from public.access_records
                      where employee_id = current_setting('test.employee_b')::uuid),
    'employee_a must NOT read employee_b''s access records';
end $$;
reset role;

-- ═══ 3. Employee A cannot mutate anything ═══════════════════════════════════

select pg_temp.act_as(current_setting('test.employee_a')::uuid);
set local role authenticated;
do $$
declare v_msg text; v_n int;
begin
  -- 3a. Create: refused by assets_insert.
  begin
    insert into public.assets (asset_type, asset_name, status)
    values ('laptop', 'ASSERT boundary illegal', 'available');
    assert false, 'employee_a must not be able to create an asset';
  exception when insufficient_privilege then null;
  end;

  -- 3b. Edit: RLS filters the row out, so the UPDATE touches nothing. No
  -- error, no write — which is the correct outcome for a policy, and the
  -- reason this is asserted on the row count rather than on an exception.
  update public.assets set asset_name = 'ASSERT boundary hijacked'
   where id = current_setting('t.asset_a')::uuid;
  get diagnostics v_n = row_count;
  assert v_n = 0, 'employee_a must not be able to edit even their own asset directly';

  update public.assets set asset_name = 'ASSERT boundary hijacked'
   where id = current_setting('t.asset_b')::uuid;
  get diagnostics v_n = row_count;
  assert v_n = 0, 'employee_a must not be able to edit employee_b''s asset';

  -- 3c. Delete.
  delete from public.assets where id = current_setting('t.asset_free')::uuid;
  get diagnostics v_n = row_count;
  assert v_n = 0, 'employee_a must not be able to delete an asset';

  -- 3d. Custody RPCs, called directly the way a hand-written client would.
  begin
    perform public.assign_asset(current_setting('t.asset_free')::uuid,
                                current_setting('test.employee_a')::uuid);
    assert false, 'employee_a must not be able to assign an asset to themselves';
  exception when insufficient_privilege then
    get stacked diagnostics v_msg = message_text;
    assert v_msg like 'ASSET_CUSTODY_DENIED:%', 'unexpected refusal: ' || v_msg;
  end;

  begin
    perform public.return_asset(current_setting('t.asset_b')::uuid);
    assert false, 'employee_a must not be able to return employee_b''s asset';
  exception when insufficient_privilege then null;
  end;

  begin
    perform public.mark_asset_lost(current_setting('t.asset_b')::uuid);
    assert false, 'employee_a must not be able to mark employee_b''s asset lost';
  exception when insufficient_privilege then null;
  end;

  -- 3e. Reviewing someone else's request.
  begin
    perform public.approve_asset_change_request(current_setting('t.req_b')::uuid, null);
    assert false, 'employee_a must not be able to approve a request';
  exception when insufficient_privilege then
    get stacked diagnostics v_msg = message_text;
    assert v_msg like 'ASSET_REQUEST_FORBIDDEN:%', 'unexpected refusal: ' || v_msg;
  end;

  begin
    perform public.reject_asset_change_request(current_setting('t.req_b')::uuid, null);
    assert false, 'employee_a must not be able to reject a request';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- ═══ 4. Employee A may request a change to their OWN asset, and only that ═══

select pg_temp.act_as(current_setting('test.employee_a')::uuid);
set local role authenticated;
do $$
begin
  insert into public.asset_change_requests
    (asset_id, asset_name_snapshot, request_type, reason, proposed_asset_name)
  values
    (current_setting('t.asset_a')::uuid, 'ASSERT boundary A', 'edit',
     'ASSERT the serial number on my laptop is wrong', 'ASSERT boundary A corrected');

  -- The row is theirs: requested_by defaults to auth.uid() and the policy
  -- pins it, so a client cannot file in someone else's name.
  assert (select requested_by from public.asset_change_requests
           where asset_id = current_setting('t.asset_a')::uuid)
         = current_setting('test.employee_a')::uuid,
    'a request must be recorded against the person who filed it';
  assert (select status from public.asset_change_requests
           where asset_id = current_setting('t.asset_a')::uuid) = 'pending',
    'a new request starts pending';

  -- Somebody else's asset.
  begin
    insert into public.asset_change_requests
      (asset_id, asset_name_snapshot, request_type, reason, proposed_asset_name)
    values
      (current_setting('t.asset_b')::uuid, 'ASSERT boundary B', 'edit',
       'ASSERT not mine', 'hijacked');
    assert false, 'employee_a must not be able to file a request about employee_b''s asset';
  exception when insufficient_privilege then null;
  end;

  -- An asset nobody holds.
  begin
    insert into public.asset_change_requests
      (asset_id, asset_name_snapshot, request_type, reason, proposed_asset_name)
    values
      (current_setting('t.asset_free')::uuid, 'ASSERT boundary free', 'edit',
       'ASSERT not mine either', 'hijacked');
    assert false, 'employee_a must not be able to file a request about an unassigned asset';
  exception when insufficient_privilege then null;
  end;

  -- Filing in someone else's name.
  begin
    insert into public.asset_change_requests
      (asset_id, asset_name_snapshot, request_type, requested_by, reason, proposed_asset_name)
    values
      (current_setting('t.asset_a')::uuid, 'ASSERT boundary A', 'edit',
       current_setting('test.employee_b')::uuid, 'ASSERT impersonation', 'x');
    assert false, 'a request may never be filed in another person''s name';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- ═══ 5. A manager's authority comes from a GRANT ════════════════════════════
--
-- 'manage' is granted here as an employee override, exactly as Control Center
-- would write it — and rolled back with everything else.

insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
select current_setting('test.manager_id')::uuid, pm.id, pa.id, true,
       current_setting('test.admin_id')::uuid
  from public.permission_modules pm
  join public.module_permission_actions mpa on mpa.module_id = pm.id
  join public.permission_actions pa on pa.id = mpa.action_id
 where pm.module_key = 'assets_access' and pa.action_key = 'manage'
on conflict (user_id, module_id, action_id)
  do update set allowed = true, revoked_at = null, revoked_by = null;

select pg_temp.act_as(current_setting('test.manager_id')::uuid);
set local role authenticated;
do $$
declare v_msg text;
begin
  assert public.can_view_asset_inventory(),
    'a manage grant must open the inventory';
  assert public.can_review_asset_requests(),
    'a manage grant must open the review queue';

  -- The inventory is genuinely readable now: all three fixture assets.
  assert (select count(*) from public.assets where asset_name like 'ASSERT boundary%') = 3,
    'an inventory manager reads every asset';
  assert exists (select 1 from public.employee_assets
                  where employee_id = current_setting('test.employee_b')::uuid),
    'an inventory manager reads assignment information';
  assert exists (select 1 from public.asset_change_requests
                  where id = current_setting('t.req_b')::uuid),
    'a reviewer reads the queue';

  -- …but review is not a back door. Approving an EDIT performs an edit, which
  -- this manager has not been granted.
  begin
    perform public.approve_asset_change_request(current_setting('t.req_b')::uuid, null);
    assert false, 'a manage-only reviewer must not be able to approve an EDIT request';
  exception when insufficient_privilege then
    get stacked diagnostics v_msg = message_text;
    assert v_msg like 'ASSET_REQUEST_FORBIDDEN:%Approving an edit request%',
      'unexpected refusal: ' || v_msg;
  end;

  -- Create and delete did not come along with manage either.
  begin
    insert into public.assets (asset_type, asset_name, status)
    values ('laptop', 'ASSERT manage illegal create', 'available');
    assert false, 'manage must not confer create';
  exception when insufficient_privilege then null;
  end;

  -- Access Register stays shut.
  assert not exists (select 1 from public.access_records
                      where employee_id = current_setting('test.employee_b')::uuid),
    'a manager must not read another employee''s access records';
end $$;
reset role;

-- Rejecting needs nothing beyond review authority: it changes no asset.
select pg_temp.act_as(current_setting('test.manager_id')::uuid);
set local role authenticated;
do $$
begin
  perform public.reject_asset_change_request(current_setting('t.req_b')::uuid, 'ASSERT not now');
  assert (select status from public.asset_change_requests
           where id = current_setting('t.req_b')::uuid) = 'rejected',
    'a manage-only reviewer must be able to reject';
  assert (select reviewed_by from public.asset_change_requests
           where id = current_setting('t.req_b')::uuid)
         = current_setting('test.manager_id')::uuid,
    'a decision records who made it';
  assert (select reviewed_at is not null from public.asset_change_requests
           where id = current_setting('t.req_b')::uuid),
    'a decision records when it was made';
  -- The asset is untouched.
  assert (select asset_name from public.assets where id = current_setting('t.asset_b')::uuid)
         = 'ASSERT boundary B',
    'rejecting a request must not move the asset';
end $$;
reset role;

-- ═══ 5b. Removal approval is ADMIN-ONLY, even holding 'delete' ══════════════
--
-- The grantable assets_access 'delete' permission covers the ordinary,
-- policy-governed delete of a never-assigned inventory mistake
-- (20260803000000 §3). Approving a removal request DELETEs the asset master
-- row from inside a SECURITY DEFINER function, which never passes through the
-- assets_delete policy — so 'delete' must buy nothing here.

insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
select current_setting('test.manager_id')::uuid, pm.id, pa.id, true,
       current_setting('test.admin_id')::uuid
  from public.permission_modules pm
  join public.module_permission_actions mpa on mpa.module_id = pm.id
  join public.permission_actions pa on pa.id = mpa.action_id
 where pm.module_key = 'assets_access' and pa.action_key = 'delete'
on conflict (user_id, module_id, action_id)
  do update set allowed = true, revoked_at = null, revoked_by = null;

-- A removal request against the asset nobody holds, filed by employee_b so the
-- manager is not its requester and the self-review guard is not what refuses.
insert into public.asset_change_requests
  (asset_id, asset_name_snapshot, request_type, requested_by, reason)
values
  (current_setting('t.asset_free')::uuid, 'ASSERT boundary free', 'remove',
   current_setting('test.employee_b')::uuid, 'ASSERT removal request');

select pg_temp.act_as(current_setting('test.manager_id')::uuid);
set local role authenticated;
do $$
declare v_req uuid; v_msg text;
begin
  assert public.can_review_asset_requests(), 'the manager still reviews';

  select id into v_req from public.asset_change_requests
   where asset_id = current_setting('t.asset_free')::uuid
     and request_type = 'remove' and status = 'pending';
  assert v_req is not null, 'the removal request must be visible to the reviewer';

  begin
    perform public.approve_asset_change_request(v_req, null);
    assert false,
      'a non-admin reviewer holding assets_access delete must NOT be able to approve a removal';
  exception when insufficient_privilege then
    get stacked diagnostics v_msg = message_text;
    assert v_msg like 'ASSET_REQUEST_FORBIDDEN:%administrator%approve a removal%',
      'unexpected refusal: ' || v_msg;
  end;

  -- Rejecting it IS within reach: it deletes nothing.
  perform public.reject_asset_change_request(v_req, 'ASSERT not a manager''s call');
  assert (select status from public.asset_change_requests where id = v_req) = 'rejected',
    'a reviewer must still be able to reject a removal request';
  assert exists (select 1 from public.assets where id = current_setting('t.asset_free')::uuid),
    'a rejected removal must leave the asset in place';
end $$;
reset role;

-- The admin-only permanent-deletion RPC is a THIRD, separate thing and stays
-- shut to the same manager, delete permission and all.
--
-- Conditional on the function existing: 20260803000000 is a SEPARATE piece of
-- work with its own deployment decision, and this script must pass both before
-- and after it lands rather than fail on someone else's unapplied migration.
-- The skip is announced, never silent.
select pg_temp.act_as(current_setting('test.manager_id')::uuid);
set local role authenticated;
do $$
declare v_msg text;
begin
  IF to_regprocedure('public.permanently_delete_asset(uuid)') IS NULL THEN
    RAISE NOTICE 'SKIPPED: permanently_delete_asset() is not deployed (20260803000000 unapplied) — its admin-only guard was not exercised';
  ELSE
    begin
      perform public.permanently_delete_asset(current_setting('t.asset_free')::uuid);
      assert false, 'permanently_delete_asset must remain admin-only';
    exception when insufficient_privilege then
      get stacked diagnostics v_msg = message_text;
      assert v_msg like 'ASSET_DELETE_DENIED:%', 'unexpected refusal: ' || v_msg;
    end;
  END IF;
end $$;
reset role;

-- ═══ 6. With 'edit' as well, the same manager can approve an edit ═══════════

insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
select current_setting('test.manager_id')::uuid, pm.id, pa.id, true,
       current_setting('test.admin_id')::uuid
  from public.permission_modules pm
  join public.module_permission_actions mpa on mpa.module_id = pm.id
  join public.permission_actions pa on pa.id = mpa.action_id
 where pm.module_key = 'assets_access' and pa.action_key = 'edit'
on conflict (user_id, module_id, action_id)
  do update set allowed = true, revoked_at = null, revoked_by = null;

select pg_temp.act_as(current_setting('test.manager_id')::uuid);
set local role authenticated;
do $$
declare v_req uuid;
begin
  select id into v_req from public.asset_change_requests
   where asset_id = current_setting('t.asset_a')::uuid and status = 'pending';
  assert v_req is not null, 'employee_a''s request from section 4 must be visible to the reviewer';

  perform public.approve_asset_change_request(v_req, 'ASSERT approved');

  assert (select status from public.asset_change_requests where id = v_req) = 'approved',
    'a reviewer holding edit must be able to approve an edit request';
  assert (select asset_name from public.assets where id = current_setting('t.asset_a')::uuid)
         = 'ASSERT boundary A corrected',
    'an approved edit must actually reach the asset';
end $$;
reset role;

-- ═══ 7. Nobody reviews their own request ════════════════════════════════════

select pg_temp.act_as(current_setting('test.manager_id')::uuid);
set local role authenticated;
do $$
declare v_req uuid; v_msg text;
begin
  insert into public.asset_change_requests
    (asset_id, asset_name_snapshot, request_type, reason, proposed_asset_name)
  values
    (current_setting('t.asset_free')::uuid, 'ASSERT boundary free', 'edit',
     'ASSERT self review', 'ASSERT self renamed')
  returning id into v_req;

  begin
    perform public.approve_asset_change_request(v_req, null);
    assert false, 'a requester must never approve their own request';
  exception when insufficient_privilege then
    get stacked diagnostics v_msg = message_text;
    assert v_msg like 'ASSET_REQUEST_FORBIDDEN:%your own request%',
      'unexpected refusal: ' || v_msg;
  end;

  begin
    perform public.reject_asset_change_request(v_req, null);
    assert false, 'a requester must never reject their own request';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- ═══ 8. The admin still works, end to end ═══════════════════════════════════

select pg_temp.act_as(current_setting('test.admin_id')::uuid);
set local role authenticated;
do $$
declare v_req uuid;
begin
  assert (select count(*) from public.assets where asset_name like 'ASSERT boundary%') = 3,
    'an admin reads the whole inventory';
  assert (select count(*) from public.employee_assets
           where asset_id in (current_setting('t.asset_a')::uuid,
                              current_setting('t.asset_b')::uuid)) = 2,
    'an admin reads every assignment';
  assert exists (select 1 from public.asset_activity_log
                  where asset_id = current_setting('t.asset_b')::uuid),
    'an admin reads every timeline';
  assert exists (select 1 from public.asset_transfers
                  where asset_id = current_setting('t.asset_b')::uuid),
    'an admin reads every movement';
  assert exists (select 1 from public.asset_documents
                  where asset_id = current_setting('t.asset_b')::uuid),
    'an admin reads every document';

  -- Direct edit.
  update public.assets set location = 'ASSERT admin edited'
   where id = current_setting('t.asset_free')::uuid;
  assert (select location from public.assets where id = current_setting('t.asset_free')::uuid)
         = 'ASSERT admin edited',
    'an admin can still edit an asset directly';

  -- Custody.
  perform public.return_asset(current_setting('t.asset_b')::uuid);
  assert (select status from public.assets where id = current_setting('t.asset_b')::uuid) = 'available',
    'an admin can still return an asset';

  -- Review: the manager's self-filed request from section 7 is the admin's to
  -- decide, and the admin is not its requester.
  select id into v_req from public.asset_change_requests
   where asset_id = current_setting('t.asset_free')::uuid and status = 'pending';
  perform public.approve_asset_change_request(v_req, 'ASSERT admin approved');
  assert (select asset_name from public.assets where id = current_setting('t.asset_free')::uuid)
         = 'ASSERT self renamed',
    'an admin can still approve a request';

  -- Access Register.
  assert public.can_view_asset_inventory() and public.can_review_asset_requests(),
    'an admin retains every capability';
end $$;
reset role;

-- Two ways of saying the same thing, because they reach different runners.
-- psql shows the NOTICE; the Supabase Management API (`supabase db query -f`)
-- drops NOTICEs and returns only the LAST result set, so without the SELECT a
-- clean run and a run that never reached the assertions look identical.
do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;
select 'ALL ASSERTIONS PASSED'::text as result;

rollback;
