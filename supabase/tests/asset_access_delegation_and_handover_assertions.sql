-- Assets & Access — delegated Access Records, and the handover acknowledgement
-- ===========================================================================
-- Covers:
--   20261028000000_assets_access_manage_access_records.sql
--   20261029000000_asset_handover_acknowledgement.sql
--
-- The TypeScript suite proves the SHAPE of both migrations (that the policy
-- reads the predicate, that the RPC takes the flag). Only a live database can
-- prove the BEHAVIOUR: that a direct PostgREST-style request from someone
-- without the grant is actually refused, that an acceptance really does record
-- the employee, the moment, the version and the text, and that BOTH the new and
-- the legacy acceptance entry points work.
--
-- Every check runs as the real Postgres role `authenticated` with a simulated
-- JWT, so RLS is genuinely enforced. A script that only called the definer
-- functions would prove nothing about the SELECT policies, which is exactly
-- where a delegation defect would live.
--
-- SELF-CONTAINED. It creates its own four fictional employees, its own assets
-- and its own credentials, and ends in ROLLBACK. THERE ARE NO PLACEHOLDER UUIDS
-- TO EDIT, and no real person is named anywhere in it. Running it leaves
-- nothing behind but a handful of burned public.asset_code_seq values —
-- nextval() is not transactional — which is harmless.
--
-- IT REFUSES TO RUN ON A DATABASE THAT HAS PEOPLE IN IT.
-- The first thing it does is check that public.users is EMPTY. A database with
-- employees in it is somebody's, and this script would be creating accounts and
-- permission grants in it. Pointing psql at production and running this writes
-- nothing: the refusal happens before the first fixture.
--
-- HOW TO RUN IT
--   supabase/tests/run_assets_access_delegation_and_handover_local.sh
-- builds a throwaway database from the test-only baseline and the real
-- prerequisite migrations, then applies this. Do not run it by hand against a
-- database you did not build for it.
--
-- On success it prints NOTICE 'ALL ASSERTIONS PASSED' and rolls back.

\set ON_ERROR_STOP on

begin;

-- ── The refusal, before anything is written ─────────────────────────────────
do $$
begin
  if exists (select 1 from public.users) then
    raise exception
      'ASSET_ASSERT_REFUSED: public.users is not empty. This script creates its own '
      'employees and permission grants, so it only runs on a database built for it. '
      'Nothing was written.';
  end if;
end $$;

-- ── Fixture identities. Fictional, fixed, and obviously not real people ─────
--
-- Fixed rather than generated so that a failure message names the same id the
-- next run will use, and so the four roles below are readable at a glance.
--
--   admin        an ACTIVE administrator
--   issuer       a non-admin who is granted `assign` and hands the asset over
--   holder       a DIFFERENT non-admin, who receives it and accepts
--   access_admin a non-admin who is granted manage_access_records
--
-- issuer and holder are two DISTINCT people on purpose: "only the allocated
-- employee may accept" proves nothing when tested with one user.

do $$
begin
  perform set_config('t.admin',        'a55e7000-0000-4000-8000-000000000001', true);
  perform set_config('t.issuer',       'a55e7000-0000-4000-8000-000000000002', true);
  perform set_config('t.holder',       'a55e7000-0000-4000-8000-000000000003', true);
  perform set_config('t.access_admin', 'a55e7000-0000-4000-8000-000000000004', true);
end $$;

insert into public.users (id, full_name, email, role, team, is_active)
values
  (current_setting('t.admin')::uuid,        'ASSERT Admin',        'assert.admin@example.invalid',  'admin',  'management', true),
  (current_setting('t.issuer')::uuid,       'ASSERT Issuer',       'assert.issuer@example.invalid', 'member', 'operations', true),
  (current_setting('t.holder')::uuid,       'ASSERT Holder',       'assert.holder@example.invalid', 'member', 'operations', true),
  (current_setting('t.access_admin')::uuid, 'ASSERT AccessAdmin',  'assert.access@example.invalid', 'member', 'operations', true);

do $$
begin
  assert (select count(*) from public.users) = 4, 'exactly four fixture employees';
  assert (select count(*) from public.users where role = 'admin') = 1, 'exactly one admin';
end $$;

-- ── Helper: become a signed-in employee ─────────────────────────────────────
-- The claims GUC is what auth.uid() reads; SET LOCAL ROLE is what makes RLS
-- apply at all. Both are transaction-local.

create or replace function pg_temp.act_as(p_uid uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_uid::text, 'role', 'authenticated')::text,
                     true);
end $$;

-- Grant an assets_access action to a fixture employee, the way Control Center
-- does — an employee_permission_overrides row and nothing else.
create or replace function pg_temp.grant_action(p_uid uuid, p_action text)
returns void language plpgsql as $$
begin
  insert into public.employee_permission_overrides
    (user_id, module_id, action_id, allowed, granted_by)
  select p_uid, pm.id, pa.id, true, current_setting('t.admin')::uuid
    from public.permission_modules pm
    join public.module_permission_actions mpa on mpa.module_id = pm.id
    join public.permission_actions pa on pa.id = mpa.action_id
   where pm.module_key = 'assets_access' and pa.action_key = p_action
  on conflict (user_id, module_id, action_id)
    do update set allowed = true, revoked_at = null, revoked_by = null;
end $$;

-- Module entry for all three non-admins, so that a later refusal is
-- attributable to the Access Register grant and never to the RESTRICTIVE entry
-- gate standing in front of it.
select pg_temp.grant_action(current_setting('t.issuer')::uuid,       'view');
select pg_temp.grant_action(current_setting('t.holder')::uuid,       'view');
select pg_temp.grant_action(current_setting('t.access_admin')::uuid, 'view');

-- ── Fixtures ────────────────────────────────────────────────────────────────

do $$
begin
  perform set_config('t.asset_new',    gen_random_uuid()::text, true); -- accepted the NEW way
  perform set_config('t.asset_legacy', gen_random_uuid()::text, true); -- accepted the OLD way
  perform set_config('t.record_h',     gen_random_uuid()::text, true); -- holder's credential
end $$;

insert into public.assets (id, asset_type, asset_name, serial_no, status, location)
values
  (current_setting('t.asset_new')::uuid,    'laptop', 'ASSERT handover laptop', 'SN-HANDOVER-NEW', 'available', 'Store Room'),
  (current_setting('t.asset_legacy')::uuid, 'laptop', 'ASSERT legacy laptop',   'SN-HANDOVER-OLD', 'available', 'Store Room');

-- A credential belonging to the holder: "somebody else cannot read it" is then
-- a test against a row that exists, not against an empty table.
insert into public.access_records (id, employee_id, access_type, username, secret_value, status, updated_by)
values (current_setting('t.record_h')::uuid, current_setting('t.holder')::uuid,
        'gmail', 'assert.holder@example.invalid', 'ASSERT-secret-original', 'active',
        current_setting('t.admin')::uuid);

-- ═══ PART A. Delegated Access Records ═══════════════════════════════════════

-- ── A1. The predicate, before any grant ─────────────────────────────────────

select pg_temp.act_as(current_setting('t.access_admin')::uuid);
set local role authenticated;
do $$
begin
  assert not public.can_manage_access_records(),
    'nobody manages access records until an administrator grants it';
end $$;
reset role;

select pg_temp.act_as(current_setting('t.admin')::uuid);
set local role authenticated;
do $$
begin
  -- (a) An active admin retains access automatically.
  assert public.can_manage_access_records(), 'an ACTIVE ADMIN manages access records automatically';
end $$;
reset role;

-- ── A2. (c) Without the grant: no read, no insert, no update ────────────────
--
-- These are DIRECT requests. No screen is involved; this is what a hand-rolled
-- PostgREST call would do.

select pg_temp.act_as(current_setting('t.issuer')::uuid);
set local role authenticated;
do $$
declare v_count int;
begin
  select count(*) into v_count from public.access_records
   where id = current_setting('t.record_h')::uuid;
  assert v_count = 0, 'an employee must not READ another employee''s access record';

  begin
    insert into public.access_records (employee_id, access_type, username, updated_by)
    values (current_setting('t.holder')::uuid, 'clickup', 'assert.forged',
            current_setting('t.issuer')::uuid);
    assert false, 'an employee must not CREATE an access record for anybody';
  exception when insufficient_privilege then null;
  end;

  -- RLS makes the row invisible rather than raising, so the test is that
  -- NOTHING moved.
  update public.access_records set username = 'assert.hijacked'
   where id = current_setting('t.record_h')::uuid;
  get diagnostics v_count = row_count;
  assert v_count = 0, 'an employee must not EDIT another employee''s access record';
end $$;
reset role;

do $$
begin
  assert (select username from public.access_records where id = current_setting('t.record_h')::uuid)
         = 'assert.holder@example.invalid',
    'the record must be exactly as it was left';
end $$;

-- The owner still reads their own row, and only their own. This is the policy
-- the delegation migration must not have disturbed.
select pg_temp.act_as(current_setting('t.holder')::uuid);
set local role authenticated;
do $$
begin
  assert (select count(*) from public.access_records) = 1,
    'the holder reads their own access record';
  assert (select employee_id from public.access_records) = current_setting('t.holder')::uuid,
    'and it is theirs';
end $$;
reset role;

-- ── A3. (d) No asset authority reaches the Access Register ──────────────────
--
-- Every asset action at once, on the issuer. If any of them widened the
-- register, this is where it shows.

select pg_temp.grant_action(current_setting('t.issuer')::uuid, 'create');
select pg_temp.grant_action(current_setting('t.issuer')::uuid, 'assign');
select pg_temp.grant_action(current_setting('t.issuer')::uuid, 'edit');
select pg_temp.grant_action(current_setting('t.issuer')::uuid, 'delete');
select pg_temp.grant_action(current_setting('t.issuer')::uuid, 'manage');

select pg_temp.act_as(current_setting('t.issuer')::uuid);
set local role authenticated;
do $$
begin
  assert public.can_view_asset_inventory(),
    'the five asset grants must still open the inventory (nothing was broken)';
  assert public.can_review_asset_requests(),
    'and still confer request review';
  assert not public.can_manage_access_records(),
    'NO amount of asset authority may reach the Access Register';
  assert (select count(*) from public.access_records) = 0,
    'asset authority must not read another employee''s access records';
end $$;
reset role;

-- ── A4. (b) With the grant: read, add and edit for EVERY employee ───────────

select pg_temp.grant_action(current_setting('t.access_admin')::uuid, 'manage_access_records');

select pg_temp.act_as(current_setting('t.access_admin')::uuid);
set local role authenticated;
do $$
declare v_count int; v_new uuid;
begin
  assert public.can_manage_access_records(), 'the grant must be resolvable';

  -- VIEW the whole register — every employee's records, not just their own.
  assert (select count(*) from public.access_records) = 1,
    'the grant must read another employee''s access record';

  -- ADD one for somebody else.
  insert into public.access_records (employee_id, access_type, username, secret_value, updated_by)
  values (current_setting('t.issuer')::uuid, 'system_login', 'assert.delegated.issuer',
          'ASSERT-secret-added', current_setting('t.access_admin')::uuid)
  returning id into v_new;
  assert v_new is not null, 'the grant must add an access record';

  -- EDIT another employee's username…
  update public.access_records
     set username = 'assert.holder.updated', updated_by = current_setting('t.access_admin')::uuid
   where id = current_setting('t.record_h')::uuid;
  get diagnostics v_count = row_count;
  assert v_count = 1, 'the grant must edit another employee''s access record';

  -- …REPLACE the stored secret, which is what the edit form's password field
  -- does. This is the half that would be broken by a column-level revoke, and
  -- it has to keep working.
  update public.access_records
     set secret_value = 'ASSERT-secret-replaced'
   where id = current_setting('t.record_h')::uuid;
  get diagnostics v_count = row_count;
  assert v_count = 1, 'the grant must be able to replace a stored login secret';

  -- …and DISABLE it, which is the register's third action.
  update public.access_records set status = 'disabled'
   where id = current_setting('t.record_h')::uuid;
  get diagnostics v_count = row_count;
  assert v_count = 1, 'the grant must be able to disable an access record';
end $$;
reset role;

-- Read back from outside RLS: the writes really landed.
do $$
declare v_row public.access_records;
begin
  select * into v_row from public.access_records where id = current_setting('t.record_h')::uuid;
  assert v_row.username = 'assert.holder.updated',      'the username was changed';
  assert v_row.secret_value = 'ASSERT-secret-replaced', 'the secret was replaced';
  assert v_row.status = 'disabled',                     'the record was disabled';
  assert v_row.updated_by = current_setting('t.access_admin')::uuid,
    'the editor is recorded';
  assert (select count(*) from public.access_records) = 2,
    'the added record exists';
end $$;

-- The blank-password path: leaving the field empty must not erase the stored
-- secret. The application omits the column entirely; this asserts the database
-- keeps it.
select pg_temp.act_as(current_setting('t.access_admin')::uuid);
set local role authenticated;
update public.access_records
   set username = 'assert.holder.updated.again'
 where id = current_setting('t.record_h')::uuid;
reset role;

do $$
begin
  assert (select secret_value from public.access_records where id = current_setting('t.record_h')::uuid)
         = 'ASSERT-secret-replaced',
    'an update that does not name secret_value must leave it exactly as it was';
end $$;

-- ── A5. The boundary the grant must NOT cross ───────────────────────────────

select pg_temp.act_as(current_setting('t.access_admin')::uuid);
set local role authenticated;
do $$
declare v_count int;
begin
  -- No asset authority of any kind.
  assert not public.can_view_asset_inventory(),
    'the Access Register grant must not open the organisation-wide inventory';
  assert not public.can_review_asset_requests(),
    'the Access Register grant must not confer request review';
  assert not public.can_write_asset_records(),
    'the Access Register grant must not confer asset writes';

  begin
    perform public.assign_asset(current_setting('t.asset_new')::uuid,
                                current_setting('t.holder')::uuid);
    assert false, 'the Access Register grant must not be able to assign an asset';
  exception when insufficient_privilege then null;
  end;

  begin
    perform public.return_asset(current_setting('t.asset_new')::uuid);
    assert false, 'the Access Register grant must not be able to return an asset';
  exception when insufficient_privilege then null;
  end;

  begin
    perform public.mark_asset_lost(current_setting('t.asset_new')::uuid);
    assert false, 'the Access Register grant must not be able to mark an asset lost';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.assets (asset_type, asset_name, status)
    values ('laptop', 'ASSERT forged asset', 'available');
    assert false, 'the Access Register grant must not be able to create an asset';
  exception when insufficient_privilege then null;
  end;

  -- No Control Center authority: the permission tables are admin-write only.
  update public.role_permissions set allowed = true
   where module_id in (select id from public.permission_modules where module_key = 'assets_access');
  get diagnostics v_count = row_count;
  assert v_count = 0, 'the Access Register grant must not edit role permissions';

  update public.employee_permission_overrides set allowed = true
   where user_id = current_setting('t.issuer')::uuid;
  get diagnostics v_count = row_count;
  assert v_count = 0, 'the Access Register grant must not edit employee permissions';

  begin
    insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
    select current_setting('t.access_admin')::uuid, pm.id, pa.id, true,
           current_setting('t.access_admin')::uuid
      from public.permission_modules pm
      join public.permission_actions pa on pa.action_key = 'manage'
     where pm.module_key = 'assets_access';
    assert false, 'the Access Register grant must not be able to grant itself more';
  exception when insufficient_privilege then null;
  end;

  -- No member management. `authenticated` holds no UPDATE on public.users at
  -- all (20260813000000 revokes it), so this raises rather than matching no
  -- rows — both are a refusal and either is accepted here, because the claim is
  -- "the employee is not deactivated", not "it fails in one particular way".
  begin
    update public.users set is_active = false
     where id = current_setting('t.issuer')::uuid;
    get diagnostics v_count = row_count;
    assert v_count = 0, 'the Access Register grant must not deactivate an employee';
  exception when insufficient_privilege then null;
  end;

  -- And still no DELETE on access_records, for anybody.
  delete from public.access_records where id = current_setting('t.record_h')::uuid;
  get diagnostics v_count = row_count;
  assert v_count = 0, 'access_records must not be deletable';
end $$;
reset role;

do $$
begin
  assert (select is_active from public.users where id = current_setting('t.issuer')::uuid),
    'no employee record may have been modified';
  assert (select count(*) from public.access_records where id = current_setting('t.record_h')::uuid) = 1,
    'the access record must still exist';
end $$;

-- ── A6. A deactivated holder reads nothing ──────────────────────────────────

update public.users set is_active = false where id = current_setting('t.access_admin')::uuid;

select pg_temp.act_as(current_setting('t.access_admin')::uuid);
set local role authenticated;
do $$
begin
  assert not public.can_manage_access_records(),
    'a deactivated account must resolve nothing, however its grants were left';
  assert (select count(*) from public.access_records) = 0,
    'and it reads nothing';
end $$;
reset role;

update public.users set is_active = true where id = current_setting('t.access_admin')::uuid;

-- ── A7. Revoking the grant closes the door again ────────────────────────────
--
-- What the administrator does in Control Center when the delegation ends.

update public.employee_permission_overrides eo
   set allowed = false
  from public.permission_modules pm, public.permission_actions pa
 where eo.module_id = pm.id and pm.module_key = 'assets_access'
   and eo.action_id = pa.id and pa.action_key = 'manage_access_records'
   and eo.user_id = current_setting('t.access_admin')::uuid;

select pg_temp.act_as(current_setting('t.access_admin')::uuid);
set local role authenticated;
do $$
begin
  assert not public.can_manage_access_records(), 'a revoked grant resolves to nothing';
  assert (select count(*) from public.access_records) = 0, 'and the register closes';
end $$;
reset role;

-- Put it back; Part B does not depend on it, but leaving a revoked row would
-- make a later reading of this script confusing.
select pg_temp.grant_action(current_setting('t.access_admin')::uuid, 'manage_access_records');

-- ═══ PART B. Handover acknowledgement ═══════════════════════════════════════

-- ── B1. The assigning user records the handover ─────────────────────────────
--
-- The issuer holds `assign` from A3. They hand the asset to the holder, so
-- "only the allocated employee may accept" is tested across two people.

select pg_temp.act_as(current_setting('t.issuer')::uuid);
set local role authenticated;
do $$ begin perform public.assign_asset(
  current_setting('t.asset_new')::uuid,
  current_setting('t.holder')::uuid,
  null,
  'good',
  'Handed over at the desk',
  '65W charger, sleeve',
  'Small scratch on the lid'
); end $$;
reset role;

do $$
declare v_row public.employee_assets;
begin
  select * into v_row from public.employee_assets
   where asset_id = current_setting('t.asset_new')::uuid;

  assert v_row.status = 'pending_acceptance', 'a new assignment awaits acceptance';
  assert v_row.handover_condition = 'good',                          'the issued condition is recorded';
  assert v_row.handover_accessories = '65W charger, sleeve',         'the accessories are recorded';
  assert v_row.handover_existing_issues = 'Small scratch on the lid','the existing issue is recorded';
  assert v_row.accepted_at is null and v_row.accepted_by is null,    'nothing is accepted yet';
  assert v_row.acceptance_version is null and v_row.accepted_terms is null,
    'no terms are snapshotted before acceptance';

  perform set_config('t.assignment_new', v_row.id::text, true);
end $$;

-- ── B2. Only the allocated employee can accept ──────────────────────────────
--
-- Tested on BOTH entry points, because a compatibility wrapper that skipped the
-- ownership guard would be a hole the new path does not have.

select pg_temp.act_as(current_setting('t.issuer')::uuid);
set local role authenticated;
do $$
begin
  begin
    perform public.accept_employee_asset(current_setting('t.assignment_new')::uuid, true);
    assert false, 'the person who ISSUED the asset must not be able to accept it (new path)';
  exception when insufficient_privilege then null;
  end;

  begin
    perform public.accept_employee_asset(current_setting('t.assignment_new')::uuid);
    assert false, 'the person who ISSUED the asset must not be able to accept it (legacy path)';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

select pg_temp.act_as(current_setting('t.admin')::uuid);
set local role authenticated;
do $$
begin
  begin
    perform public.accept_employee_asset(current_setting('t.assignment_new')::uuid, true);
    assert false, 'not even an ADMIN may accept on an employee''s behalf (new path)';
  exception when insufficient_privilege then null;
  end;

  begin
    perform public.accept_employee_asset(current_setting('t.assignment_new')::uuid);
    assert false, 'not even an ADMIN may accept on an employee''s behalf (legacy path)';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- ── B3. On the NEW path the acknowledgement is required by the DATABASE ─────

select pg_temp.act_as(current_setting('t.holder')::uuid);
set local role authenticated;
do $$
begin
  begin
    perform public.accept_employee_asset(current_setting('t.assignment_new')::uuid, false);
    assert false, 'an explicit false must be refused';
  exception when insufficient_privilege then null;
  end;

  begin
    perform public.accept_employee_asset(current_setting('t.assignment_new')::uuid, null);
    assert false, 'a null must be refused too — the check is IS NOT TRUE, not <> false';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

do $$
begin
  assert (select accepted_at is null from public.employee_assets
           where id = current_setting('t.assignment_new')::uuid),
    'a refused acceptance must leave the row untouched';
end $$;

-- ── B4. The NEW path records employee, moment, version and terms ────────────

select pg_temp.act_as(current_setting('t.holder')::uuid);
set local role authenticated;
do $$ begin perform public.accept_employee_asset(current_setting('t.assignment_new')::uuid, true); end $$;
reset role;

do $$
declare
  v_row   public.employee_assets;
  v_terms public.asset_handover_terms;
  v_log   jsonb;
begin
  select * into v_row from public.employee_assets
   where id = current_setting('t.assignment_new')::uuid;
  select * into v_terms from public.current_asset_handover_terms();

  assert v_row.status = 'accepted',        'the assignment is accepted';
  assert v_row.accepted_at is not null,    'the moment is recorded';
  assert v_row.accepted_by = current_setting('t.holder')::uuid,
    'the ACCEPTING EMPLOYEE is recorded, and it is the allocated one';
  assert v_row.accepted_by = v_row.employee_id,
    'accepted_by can only ever be the allocated employee';
  assert v_row.acceptance_version = v_terms.version, 'the terms VERSION is recorded';
  assert v_row.accepted_terms = v_terms.body,
    'the EXACT terms body in force at acceptance is snapshotted';
  assert v_row.accepted_terms like '1. I confirm that I have received%',
    'the snapshot is the real terms text';
  assert v_row.accepted_terms like '%7. On return, any damage or loss%',
    'the snapshot is complete, not truncated';

  -- The handover facts survive acceptance unchanged.
  assert v_row.handover_condition = 'good',
    'accepting must not rewrite what was handed over';

  -- The audit entry says this one carried an explicit acknowledgement.
  select details into v_log from public.asset_activity_log
   where asset_id = current_setting('t.asset_new')::uuid
     and event_type = 'assignment_accepted';
  assert v_log ->> 'acknowledged_explicitly' = 'true',
    'the new path must record that the box was ticked';
  assert v_log ->> 'acceptance_version' = v_terms.version,
    'and which terms version was accepted';
end $$;

-- ── B5. Acceptance happens once ─────────────────────────────────────────────

select pg_temp.act_as(current_setting('t.holder')::uuid);
set local role authenticated;
do $$
begin
  begin
    perform public.accept_employee_asset(current_setting('t.assignment_new')::uuid, true);
    assert false, 'a second acceptance must be refused (new path)';
  exception when insufficient_privilege then null;
  end;

  begin
    perform public.accept_employee_asset(current_setting('t.assignment_new')::uuid);
    assert false, 'and the legacy path must not be a way round that';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- ── B6. THE LEGACY PATH — what the currently deployed frontend calls ────────
--
-- The whole point of keeping the one-argument wrapper: during the
-- database-first phase of a rollout, an old client must still be able to accept
-- an asset, and the acceptance it records must be complete.
--
-- The old client also calls assign_asset with FIVE arguments. That is exercised
-- here too, because a signature change would break the other half of the same
-- screen.

select pg_temp.act_as(current_setting('t.issuer')::uuid);
set local role authenticated;
-- Exactly the five-argument call the deployed frontend makes.
do $$ begin perform public.assign_asset(
  current_setting('t.asset_legacy')::uuid,
  current_setting('t.holder')::uuid,
  null,
  'fair',
  'Assigned by a client that predates the handover fields'
); end $$;
reset role;

do $$
declare v_row public.employee_assets;
begin
  select * into v_row from public.employee_assets
   where asset_id = current_setting('t.asset_legacy')::uuid;
  assert v_row.status = 'pending_acceptance',
    'the five-argument assign_asset call must still work';
  assert v_row.handover_condition = 'fair',
    'and still record the condition it does send';
  assert v_row.handover_accessories is null and v_row.handover_existing_issues is null,
    'the two fields it cannot send are null, not invented';
  perform set_config('t.assignment_legacy', v_row.id::text, true);
end $$;

select pg_temp.act_as(current_setting('t.holder')::uuid);
set local role authenticated;
-- Exactly the one-argument call the deployed frontend makes.
do $$ begin perform public.accept_employee_asset(current_setting('t.assignment_legacy')::uuid); end $$;
reset role;

do $$
declare
  v_row   public.employee_assets;
  v_terms public.asset_handover_terms;
  v_log   jsonb;
begin
  select * into v_row from public.employee_assets
   where id = current_setting('t.assignment_legacy')::uuid;
  select * into v_terms from public.current_asset_handover_terms();

  -- The five facts. A compatibility wrapper that recorded less than the new
  -- path would leave a gap in the record for the whole rollout window.
  assert v_row.status = 'accepted',                     'legacy: the assignment is accepted';
  assert v_row.accepted_at is not null,                 'legacy: the moment is recorded';
  assert v_row.accepted_by = current_setting('t.holder')::uuid,
    'legacy: the accepting employee is recorded';
  assert v_row.acceptance_version = v_terms.version,    'legacy: the terms version is recorded';
  assert v_row.accepted_terms = v_terms.body,           'legacy: the exact terms are snapshotted';

  -- …and it is honest about what it cannot evidence.
  select details into v_log from public.asset_activity_log
   where asset_id = current_setting('t.asset_legacy')::uuid
     and event_type = 'assignment_accepted';
  assert v_log ->> 'acknowledged_explicitly' = 'false',
    'legacy: the audit entry must NOT claim the box was ticked';
end $$;

-- The shared implementation is not reachable by a client, which is what stops a
-- caller choosing p_explicit_acknowledgement for itself.
do $$
begin
  assert not has_function_privilege('authenticated',
    'public.accept_employee_asset_impl(uuid, boolean)', 'EXECUTE'),
    'accept_employee_asset_impl must not be executable by authenticated';
  assert has_function_privilege('authenticated',
    'public.accept_employee_asset(uuid, boolean)', 'EXECUTE'),
    'the new entry point must be executable by authenticated';
  assert has_function_privilege('authenticated',
    'public.accept_employee_asset(uuid)', 'EXECUTE'),
    'the legacy entry point must be executable by authenticated';
end $$;

-- ── B7. The terms table is readable and not writable from the app ───────────

select pg_temp.act_as(current_setting('t.holder')::uuid);
set local role authenticated;
do $$
declare v_count int;
begin
  select count(*) into v_count from public.asset_handover_terms where is_current;
  assert v_count = 1, 'an employee must be able to READ the terms they are asked to accept';

  begin
    insert into public.asset_handover_terms (version, body, is_current)
    values ('assert-forged', 'forged terms', false);
    assert false, 'nobody may write the terms from the application';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

select pg_temp.act_as(current_setting('t.admin')::uuid);
set local role authenticated;
do $$
declare v_count int;
begin
  -- A table with no UPDATE policy does not RAISE — it matches no rows. The
  -- assertion is therefore that nothing moved, not that an error came back.
  update public.asset_handover_terms set body = 'rewritten' where is_current;
  get diagnostics v_count = row_count;
  assert v_count = 0,
    'not even an ADMIN may rewrite the terms an acceptance was made against';
end $$;
reset role;

do $$
begin
  assert (select body from public.current_asset_handover_terms()) like '1. I confirm%',
    'the published terms must be exactly as the migration seeded them';
end $$;

do $$
begin
  raise notice 'ALL ASSERTIONS PASSED';
end $$;

rollback;
