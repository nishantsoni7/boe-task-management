-- ═══════════════════════════════════════════════════════════════════════════
-- Customer Review Outreach — who can read a request, proved against a database
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY THIS FILE EXISTS, AND WHY THE TEXT AUDIT WAS NOT ENOUGH.
--
-- migration.test.ts and securityContract.test.ts read the migration as text.
-- They are worth having, and they missed a defect that made the module's
-- primary action impossible:
--
--   customer_review_requests_select delegated to
--   can_view_customer_review_request(), which resolves a request by looking it
--   up in public.customer_review_requests — the very table the policy guards.
--
--   On a plain SELECT that is redundant. On `INSERT ... RETURNING` it is fatal.
--   Postgres applies the SELECT policy to the row an INSERT is about to return;
--   the helper is STABLE, so it runs against the statement's own snapshot,
--   where the new row does not exist. The lookup finds nothing, the policy
--   evaluates false, and the insert is refused 42501 "new row violates
--   row-level security policy" — for everybody, admins included, with nothing
--   wrong with the payload.
--
--   PostgREST turns .select() into RETURNING, so that was every create in the
--   UI. No amount of reading the SQL revealed it. Executing it did, at once.
--
-- The decisive assertion is §2: an authorized creator inserting WITH RETURNING.
-- It fails against the old policy and passes against the corrected one.
--
-- WHERE TO RUN IT
-- ---------------
-- A THROWAWAY database with the module's migration applied. It creates its own
-- fictional people, exercises them, and deletes everything it made. It is not
-- for production and it is not idempotent against real data: the fixed UUIDs
-- below are reserved for it.
--
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/customer_review_request_visibility_assertions.sql
--
-- Any failure raises, so a non-zero exit is the whole result.

-- ─── 0. Fictional fixtures ─────────────────────────────────────────────────
--
-- Seven people, because the policy has more edges than it looks. Two ordinary
-- `use` holders (so "can a colleague read my customer's number" is a real
-- question rather than a hypothetical), a verifier, an admin, somebody with
-- nothing, and deactivated copies of the two identities that would otherwise
-- have the most reach.

-- Clean any residue from an interrupted previous run, in dependency order.
-- storage.objects carries a BEFORE DELETE guard (storage.protect_objects_delete)
-- that refuses direct deletion: in a real deployment the object FILE would be
-- orphaned by it. This harness only ever wrote the ROW — there is no file — so
-- the guard is suspended for the length of one transaction to clear up after
-- itself. SET LOCAL, so it is scoped to the transaction and reverts on commit;
-- no product code path does this, and nothing else in this file runs with it
-- off.
begin;
  set local session_replication_role = 'replica';
  delete from storage.objects
   where bucket_id = 'customer-review-photos'
     and split_part(name, '/', 1) in ('aaaaaaaa-0000-4000-8000-000000000001',
                                      'aaaaaaaa-0000-4000-8000-000000000002');
commit;

do $$
declare
  v_module uuid;
  v_use    uuid;
  v_verify uuid;
begin
  delete from public.customer_review_request_photos
   where request_id in ('aaaaaaaa-0000-4000-8000-000000000001',
                        'aaaaaaaa-0000-4000-8000-000000000002');
  delete from public.customer_review_request_events
   where request_id in ('aaaaaaaa-0000-4000-8000-000000000001',
                        'aaaaaaaa-0000-4000-8000-000000000002');
  delete from public.customer_review_requests
   where id in ('aaaaaaaa-0000-4000-8000-000000000001',
                'aaaaaaaa-0000-4000-8000-000000000002');
  delete from public.employee_permission_overrides
   where user_id::text like 'ffffffff-0000-4000-8000-%';
  delete from public.users
   where id::text like 'ffffffff-0000-4000-8000-%';

  insert into public.users (id, full_name, email, role, team, is_active, created_at, updated_at)
  values
    ('ffffffff-0000-4000-8000-000000000001', 'Fixture Admin',      'fixture.admin@example.test',    'admin',  'management', true,  now(), now()),
    ('ffffffff-0000-4000-8000-000000000002', 'Fixture Owner',      'fixture.owner@example.test',    'member', 'sales',      true,  now(), now()),
    ('ffffffff-0000-4000-8000-000000000003', 'Fixture Colleague',  'fixture.colleague@example.test','member', 'sales',      true,  now(), now()),
    ('ffffffff-0000-4000-8000-000000000004', 'Fixture Verifier',   'fixture.verifier@example.test', 'member', 'sales',      true,  now(), now()),
    ('ffffffff-0000-4000-8000-000000000005', 'Fixture Nobody',     'fixture.nobody@example.test',   'member', 'sales',      true,  now(), now()),
    ('ffffffff-0000-4000-8000-000000000006', 'Fixture Ex-Admin',   'fixture.exadmin@example.test',  'admin',  'management', false, now(), now()),
    ('ffffffff-0000-4000-8000-000000000007', 'Fixture Ex-Verifier','fixture.exverif@example.test',  'member', 'sales',      false, now(), now());

  select id into v_module from public.permission_modules where module_key = 'customer_review_requests';
  if v_module is null then
    raise exception 'the customer_review_requests permission module is missing; is the migration applied?';
  end if;
  select a.id into v_use    from public.permission_actions a where a.action_key = 'use';
  select a.id into v_verify from public.permission_actions a where a.action_key = 'verify';

  -- Granted the way the product grants them: per-employee overrides, level 4.
  insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
  values
    ('ffffffff-0000-4000-8000-000000000002', v_module, v_use,    true, 'ffffffff-0000-4000-8000-000000000001'),
    ('ffffffff-0000-4000-8000-000000000003', v_module, v_use,    true, 'ffffffff-0000-4000-8000-000000000001'),
    ('ffffffff-0000-4000-8000-000000000004', v_module, v_use,    true, 'ffffffff-0000-4000-8000-000000000001'),
    ('ffffffff-0000-4000-8000-000000000004', v_module, v_verify, true, 'ffffffff-0000-4000-8000-000000000001'),
    ('ffffffff-0000-4000-8000-000000000007', v_module, v_verify, true, 'ffffffff-0000-4000-8000-000000000001');
end $$;

-- Run a read AS somebody, through their own RLS, the way PostgREST would.
create or replace function pg_temp.visible_to(p_user uuid, p_request uuid)
returns integer language plpgsql as $$
declare n integer;
begin
  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', p_user, 'role', 'authenticated')::text);
  set local role authenticated;
  select count(*) into n from public.customer_review_requests where id = p_request;
  reset role;
  return n;
end $$;

create or replace function pg_temp.photos_visible_to(p_user uuid, p_request uuid)
returns integer language plpgsql as $$
declare n integer;
begin
  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', p_user, 'role', 'authenticated')::text);
  set local role authenticated;
  select count(*) into n from public.customer_review_request_photos where request_id = p_request;
  reset role;
  return n;
end $$;

create or replace function pg_temp.events_visible_to(p_user uuid, p_request uuid)
returns integer language plpgsql as $$
declare n integer;
begin
  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', p_user, 'role', 'authenticated')::text);
  set local role authenticated;
  select count(*) into n from public.customer_review_request_events where request_id = p_request;
  reset role;
  return n;
end $$;

create or replace function pg_temp.objects_visible_to(p_user uuid, p_request uuid)
returns integer language plpgsql as $$
declare n integer;
begin
  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', p_user, 'role', 'authenticated')::text);
  set local role authenticated;
  select count(*) into n from storage.objects
   where bucket_id = 'customer-review-photos'
     and split_part(name, '/', 1) = p_request::text;
  reset role;
  return n;
end $$;

-- ─── 1. The policy must not look its own table up again ────────────────────
--
-- Checked against pg_policies rather than against the migration text, so it
-- describes the database that exists rather than the file that built it.

do $$
declare v_qual text;
begin
  select coalesce(qual, '') into v_qual
  from pg_policies
  where schemaname = 'public' and tablename = 'customer_review_requests' and cmd = 'SELECT';

  if v_qual is null or v_qual = '' then
    raise exception 'customer_review_requests has no SELECT policy';
  end if;
  if v_qual like '%can_view_customer_review_request%' then
    raise exception 'the request SELECT policy re-queries its own table; INSERT ... RETURNING cannot pass it';
  end if;
  if v_qual not like '%is_active%' then
    raise exception 'the request SELECT policy no longer requires an active user';
  end if;
  if v_qual not like '%created_by%' then
    raise exception 'the request SELECT policy no longer reads created_by off the candidate row';
  end if;
  if v_qual ~ '\mtrue\M' then
    raise exception 'the request SELECT policy contains an unconditional branch';
  end if;

  -- The CHILD tables must still go through the shared helper: they ask about
  -- another table's row, where the lookup is both correct and necessary.
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'customer_review_request_photos'
      and cmd = 'SELECT' and qual like '%can_view_customer_review_request%'
  ) then
    raise exception 'the photo SELECT policy no longer uses the shared predicate';
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'customer_review_request_events'
      and cmd = 'SELECT' and qual like '%can_view_customer_review_request%'
  ) then
    raise exception 'the event SELECT policy no longer uses the shared predicate';
  end if;

  raise notice 'PASS  1. the request policy decides on the row; the children still share the predicate';
end $$;

-- ─── 2. THE DECISIVE REGRESSION: INSERT ... RETURNING ──────────────────────
--
-- This is what PostgREST emits for .insert().select(), and it is what the old
-- policy refused. Both an ordinary `use` holder and an admin must get their row
-- back.

do $$
declare v_returned uuid;
begin
  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', 'ffffffff-0000-4000-8000-000000000002',
                                   'role', 'authenticated')::text);
  set local role authenticated;

  insert into public.customer_review_requests (id, customer_name, created_by, status)
  values ('aaaaaaaa-0000-4000-8000-000000000001', 'Fixture Cafe',
          'ffffffff-0000-4000-8000-000000000002', 'draft')
  returning id into v_returned;

  reset role;

  if v_returned is distinct from 'aaaaaaaa-0000-4000-8000-000000000001'::uuid then
    raise exception 'the owner''s INSERT ... RETURNING gave back %', v_returned;
  end if;
  raise notice 'PASS  2a. an authorized owner INSERT ... RETURNING id succeeds';
exception
  when insufficient_privilege then
    raise exception 'REGRESSION: the owner''s INSERT ... RETURNING was refused (%) — the SELECT policy cannot see the new row', sqlerrm;
end $$;

do $$
declare v_returned uuid;
begin
  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', 'ffffffff-0000-4000-8000-000000000001',
                                   'role', 'authenticated')::text);
  set local role authenticated;

  insert into public.customer_review_requests (id, customer_name, created_by, status)
  values ('aaaaaaaa-0000-4000-8000-000000000002', 'Fixture Hotel',
          'ffffffff-0000-4000-8000-000000000001', 'draft')
  returning id into v_returned;

  reset role;

  if v_returned is distinct from 'aaaaaaaa-0000-4000-8000-000000000002'::uuid then
    raise exception 'the admin''s INSERT ... RETURNING gave back %', v_returned;
  end if;
  raise notice 'PASS  2b. an admin INSERT ... RETURNING id succeeds';
exception
  when insufficient_privilege then
    raise exception 'REGRESSION: the admin''s INSERT ... RETURNING was refused (%)', sqlerrm;
end $$;

-- ─── 3. Who can read the row afterwards ────────────────────────────────────

do $$
declare
  v_req uuid := 'aaaaaaaa-0000-4000-8000-000000000001';
begin
  if pg_temp.visible_to('ffffffff-0000-4000-8000-000000000002', v_req) <> 1 then
    raise exception 'the owner cannot see the request they just created';
  end if;
  raise notice 'PASS  3a. the inserted row is visible to its owner';

  -- The one that matters most: holding `use` opens the module, it does not
  -- disclose a colleague's customer, their number or their invitation.
  if pg_temp.visible_to('ffffffff-0000-4000-8000-000000000003', v_req) <> 0 then
    raise exception 'another ordinary `use` holder can read somebody else''s request';
  end if;
  raise notice 'PASS  3b. another ordinary `use` holder cannot select it';

  if pg_temp.visible_to('ffffffff-0000-4000-8000-000000000005', v_req) <> 0 then
    raise exception 'an employee with no grant at all can read the request';
  end if;
  raise notice 'PASS  3c. an employee with nothing sees no row';

  if pg_temp.visible_to('ffffffff-0000-4000-8000-000000000004', v_req) <> 1 then
    raise exception 'a verifier cannot read the request they are asked to verify';
  end if;
  raise notice 'PASS  3d. a verifier can select it';

  if pg_temp.visible_to('ffffffff-0000-4000-8000-000000000001', v_req) <> 1 then
    raise exception 'an admin cannot read the request';
  end if;
  raise notice 'PASS  3e. an admin can select it';

  -- An unauthenticated caller has no claim at all.
  if pg_temp.visible_to(null, v_req) <> 0 then
    raise exception 'a caller with no identity can read the request';
  end if;
  raise notice 'PASS  3f. a caller with no identity sees no row';
end $$;

-- ─── 4. Deactivation removes reach, including your own ─────────────────────
--
-- Inlining the predicate is exactly where an active-user check gets dropped by
-- accident, so all three branches are re-checked against a deactivated person.

do $$
declare v_req uuid := 'aaaaaaaa-0000-4000-8000-000000000001';
begin
  if pg_temp.visible_to('ffffffff-0000-4000-8000-000000000006', v_req) <> 0 then
    raise exception 'a DEACTIVATED admin can still read requests';
  end if;
  raise notice 'PASS  4a. a deactivated admin sees nothing';

  if pg_temp.visible_to('ffffffff-0000-4000-8000-000000000007', v_req) <> 0 then
    raise exception 'a DEACTIVATED verifier can still read requests';
  end if;
  raise notice 'PASS  4b. a deactivated verifier sees nothing';

  -- And the owner branch too: being the author is not a way around it.
  update public.users set is_active = false
   where id = 'ffffffff-0000-4000-8000-000000000002';
  if pg_temp.visible_to('ffffffff-0000-4000-8000-000000000002', v_req) <> 0 then
    raise exception 'a DEACTIVATED owner can still read their own request';
  end if;
  update public.users set is_active = true
   where id = 'ffffffff-0000-4000-8000-000000000002';
  raise notice 'PASS  4c. a deactivated owner cannot even read their own work';
end $$;

-- ─── 5. The children and the bucket are unchanged ──────────────────────────
--
-- The correction touched one policy. These three still resolve through
-- can_view_customer_review_request(), and must answer exactly as before.

do $$
declare v_req uuid := 'aaaaaaaa-0000-4000-8000-000000000001';
begin
  insert into public.customer_review_request_photos
    (request_id, kind, storage_path, file_name, mime_type, byte_size, content_sha256, uploaded_by)
  values (v_req, 'project_photo', v_req || '/project_photo/fixture.jpg', 'fixture.jpg',
          'image/jpeg', 2048, repeat('c', 64), 'ffffffff-0000-4000-8000-000000000002');

  insert into storage.objects (bucket_id, name)
  values ('customer-review-photos', v_req || '/project_photo/fixture.jpg');

  -- photo metadata
  if pg_temp.photos_visible_to('ffffffff-0000-4000-8000-000000000002', v_req) <> 1 then
    raise exception 'the owner cannot see their own photo metadata';
  end if;
  if pg_temp.photos_visible_to('ffffffff-0000-4000-8000-000000000003', v_req) <> 0 then
    raise exception 'a colleague can see somebody else''s photo metadata';
  end if;
  if pg_temp.photos_visible_to('ffffffff-0000-4000-8000-000000000004', v_req) <> 1 then
    raise exception 'a verifier cannot see the photo metadata they must check';
  end if;
  if pg_temp.photos_visible_to('ffffffff-0000-4000-8000-000000000006', v_req) <> 0 then
    raise exception 'a deactivated admin can see photo metadata';
  end if;
  raise notice 'PASS  5a. photo metadata visibility is unchanged';

  -- the append-only trail (the insert above wrote a photo_added entry)
  if pg_temp.events_visible_to('ffffffff-0000-4000-8000-000000000002', v_req) < 1 then
    raise exception 'the owner cannot see their own event trail';
  end if;
  if pg_temp.events_visible_to('ffffffff-0000-4000-8000-000000000003', v_req) <> 0 then
    raise exception 'a colleague can read somebody else''s event trail';
  end if;
  if pg_temp.events_visible_to('ffffffff-0000-4000-8000-000000000004', v_req) < 1 then
    raise exception 'a verifier cannot read the trail they must check';
  end if;
  raise notice 'PASS  5b. event-trail visibility is unchanged';

  -- the private bucket
  if pg_temp.objects_visible_to('ffffffff-0000-4000-8000-000000000002', v_req) <> 1 then
    raise exception 'the owner cannot see their own stored object';
  end if;
  if pg_temp.objects_visible_to('ffffffff-0000-4000-8000-000000000003', v_req) <> 0 then
    raise exception 'a colleague can see somebody else''s stored object';
  end if;
  if pg_temp.objects_visible_to('ffffffff-0000-4000-8000-000000000004', v_req) <> 1 then
    raise exception 'a verifier cannot see the object they must check';
  end if;
  if pg_temp.objects_visible_to('ffffffff-0000-4000-8000-000000000006', v_req) <> 0 then
    raise exception 'a deactivated admin can see a stored object';
  end if;
  raise notice 'PASS  5c. storage visibility is unchanged';
end $$;

-- ─── 6. The INSERT policy still pins the sensitive columns ─────────────────
--
-- The correction changed reading, not writing. Asserted here because a create
-- path that has just been unblocked is exactly when nobody re-checks what a
-- create is allowed to claim.

do $$
declare v_ok boolean;
begin
  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', 'ffffffff-0000-4000-8000-000000000002',
                                   'role', 'authenticated')::text);
  set local role authenticated;
  begin
    insert into public.customer_review_requests
      (customer_name, created_by, status, sent_at, verified_at)
    values ('Fixture Forged', 'ffffffff-0000-4000-8000-000000000002', 'verified', now(), now());
    v_ok := false;
  exception when others then v_ok := true;
  end;
  reset role;
  if not v_ok then
    raise exception 'a client created a request already claiming sent and verified';
  end if;
  raise notice 'PASS  6a. a create cannot claim sent/verified status or timestamps';
end $$;

do $$
declare v_ok boolean;
begin
  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', 'ffffffff-0000-4000-8000-000000000002',
                                   'role', 'authenticated')::text);
  set local role authenticated;
  begin
    insert into public.customer_review_requests (customer_name, created_by, status)
    values ('Fixture Impersonation', 'ffffffff-0000-4000-8000-000000000003', 'draft');
    v_ok := false;
  exception when others then v_ok := true;
  end;
  reset role;
  if not v_ok then
    raise exception 'a client created a request owned by somebody else';
  end if;
  raise notice 'PASS  6b. a create cannot be attributed to another employee';
end $$;

do $$
declare v_ok boolean;
begin
  -- Somebody with no `use` grant cannot create at all, RETURNING or not.
  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', 'ffffffff-0000-4000-8000-000000000005',
                                   'role', 'authenticated')::text);
  set local role authenticated;
  begin
    insert into public.customer_review_requests (customer_name, created_by, status)
    values ('Fixture Unauthorized', 'ffffffff-0000-4000-8000-000000000005', 'draft');
    v_ok := false;
  exception when others then v_ok := true;
  end;
  reset role;
  if not v_ok then
    raise exception 'an employee without `use` created a request';
  end if;
  raise notice 'PASS  6c. an employee without `use` cannot create one';
end $$;

-- ─── 7. Clean up ───────────────────────────────────────────────────────────

-- storage.objects carries a BEFORE DELETE guard (storage.protect_objects_delete)
-- that refuses direct deletion: in a real deployment the object FILE would be
-- orphaned by it. This harness only ever wrote the ROW — there is no file — so
-- the guard is suspended for the length of one transaction to clear up after
-- itself. SET LOCAL, so it is scoped to the transaction and reverts on commit;
-- no product code path does this, and nothing else in this file runs with it
-- off.
begin;
  set local session_replication_role = 'replica';
  delete from storage.objects
   where bucket_id = 'customer-review-photos'
     and split_part(name, '/', 1) in ('aaaaaaaa-0000-4000-8000-000000000001',
                                      'aaaaaaaa-0000-4000-8000-000000000002');
commit;

do $$
begin
  -- Photos first: the request delete trigger refuses to orphan an object.
  delete from public.customer_review_request_photos
   where request_id in ('aaaaaaaa-0000-4000-8000-000000000001',
                        'aaaaaaaa-0000-4000-8000-000000000002');
  delete from public.customer_review_request_events
   where request_id in ('aaaaaaaa-0000-4000-8000-000000000001',
                        'aaaaaaaa-0000-4000-8000-000000000002');
  delete from public.customer_review_requests
   where id in ('aaaaaaaa-0000-4000-8000-000000000001',
                'aaaaaaaa-0000-4000-8000-000000000002');
  delete from public.employee_permission_overrides
   where user_id::text like 'ffffffff-0000-4000-8000-%';
  delete from public.users
   where id::text like 'ffffffff-0000-4000-8000-%';

  raise notice 'PASS  7. every fixture removed';
end $$;

do $$ begin raise notice '';
            raise notice 'customer_review_request_visibility_assertions: ALL ASSERTIONS PASSED';
end $$;
