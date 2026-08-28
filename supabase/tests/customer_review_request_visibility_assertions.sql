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

-- ─── 1. How the request policy is allowed to decide ────────────────────────
--
-- Read from pg_policies and pg_proc, so this describes the database that
-- exists rather than the file that built it.
--
-- Two distinct mistakes are being guarded against, and the second one was
-- introduced while fixing the first:
--
--   A. Resolving the request by SELECTing it. The request-id helper is STABLE
--      and re-reads this very table, so the row an INSERT ... RETURNING is
--      about to return is invisible to it: policy false, insert refused 42501.
--
--   B. Reading public.users inline in the policy body. A policy runs as the
--      CALLER, so that binds this module's visibility to another table's
--      grants and row security. It works today only because authenticated
--      happens to hold column SELECT on id/role/is_active and the users row
--      policy happens to agree with this predicate. Neither is this module's
--      to rely on.

do $$
declare v_qual text; v_src text;
begin
  -- Filtered by policyname: a second SELECT policy added later would otherwise
  -- make SELECT INTO assert against whichever row it happened to get.
  select coalesce(qual, '') into v_qual
  from pg_policies
  where schemaname = 'public'
    and tablename  = 'customer_review_requests'
    and cmd        = 'SELECT'
    and policyname = 'customer_review_requests_select';

  if v_qual is null or v_qual = '' then
    raise exception 'customer_review_requests_select is missing';
  end if;

  -- (A) matched on the exact name, so the _row variant does not count.
  if v_qual ~ 'can_view_customer_review_request\(' then
    raise exception 'the request SELECT policy re-queries its own table; INSERT ... RETURNING cannot pass it';
  end if;

  -- (B)
  if v_qual ~* '\mfrom\M\s+(public\.)?users\M' then
    raise exception 'the request SELECT policy reads public.users as the caller; it must go through the definer predicate';
  end if;

  if v_qual not like '%can_view_customer_review_request_row%' then
    raise exception 'the request SELECT policy does not use can_view_customer_review_request_row()';
  end if;

  if v_qual ~ '\mtrue\M' then
    raise exception 'the request SELECT policy contains an unconditional branch';
  end if;

  raise notice 'PASS  1a. the request policy neither re-reads its table nor reads users as the caller';

  -- The predicate it delegates to must have definer rights and a pinned
  -- search_path, or delegating solved nothing.
  if not exists (
    select 1 from pg_proc f join pg_namespace n on n.oid = f.pronamespace
    where n.nspname = 'public'
      and f.proname = 'can_view_customer_review_request_row'
      and f.prosecdef
      and array_to_string(coalesce(f.proconfig, '{}'), ',') like '%search_path=public, pg_temp%'
  ) then
    raise exception 'can_view_customer_review_request_row is missing, not SECURITY DEFINER, or does not pin search_path';
  end if;

  select coalesce(prosrc, '') into v_src
  from pg_proc f join pg_namespace n on n.oid = f.pronamespace
  where n.nspname = 'public' and f.proname = 'can_view_customer_review_request_row';

  -- FROM/JOIN rather than any occurrence: the body legitimately contains the
  -- string as resolve_permission()'s module key.
  if v_src ~* '(from|join)\s+(public\.)?customer_review_requests\M' then
    raise exception 'can_view_customer_review_request_row queries customer_review_requests; it must decide from its arguments';
  end if;
  if v_src not like '%is_active%' then
    raise exception 'can_view_customer_review_request_row no longer requires an active user';
  end if;

  -- Reachable by a signed-in employee, and by nobody else.
  if not has_function_privilege('authenticated',
       'public.can_view_customer_review_request_row(uuid)', 'EXECUTE') then
    raise exception 'authenticated cannot execute the row predicate, so the policy cannot pass';
  end if;
  if has_function_privilege('anon',
       'public.can_view_customer_review_request_row(uuid)', 'EXECUTE') then
    raise exception 'anon can execute the row predicate';
  end if;

  raise notice 'PASS  1b. the row predicate is definer-rights, path-pinned, argument-only, and not anon-callable';

  -- The CHILD tables must still go through the request-id helper: they ask
  -- about another table's row, where the lookup is correct and necessary.
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'customer_review_request_photos'
      and cmd = 'SELECT' and qual ~ 'can_view_customer_review_request\('
  ) then
    raise exception 'the photo SELECT policy no longer uses the request-id predicate';
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'customer_review_request_events'
      and cmd = 'SELECT' and qual ~ 'can_view_customer_review_request\('
  ) then
    raise exception 'the event SELECT policy no longer uses the request-id predicate';
  end if;

  raise notice 'PASS  1c. the child tables still share the request-id predicate';
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

-- ─── 6. What a create is allowed to claim ──────────────────────────────────
--
-- The correction changed reading, not writing — which is exactly when nobody
-- re-checks writing. Every column the INSERT policy pins is exercised, one at
-- a time, and each refusal must be the RIGHT refusal.
--
-- WHY THE SQLSTATE IS ASSERTED. These began as "exception when others then
-- pass", which is a test that cannot fail for the right reason: a typo, a
-- missing grant, a constraint firing first, an absent function — all of them
-- look identical to a policy doing its job. 42501 is the policy. Anything
-- else is reported as a wrong-reason failure rather than a pass. The row
-- count is checked too, because "it raised" and "it wrote nothing" are two
-- claims.
--
-- Several cases set a timestamp and its paired actor together on purpose: the
-- _fields_consistent CHECK constraints would otherwise refuse first with
-- 23514, and this section is about the policy, not about the constraints.

create or replace function pg_temp.refused(p_user uuid, p_sql text, p_label text)
returns void language plpgsql as $$
declare v_state text; v_reached boolean := false; v_before bigint; v_after bigint;
begin
  select count(*) into v_before from public.customer_review_requests;
  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', p_user, 'role', 'authenticated')::text);
  set local role authenticated;
  begin
    execute p_sql;
    v_reached := true;
  exception when others then
    v_state := sqlstate;
  end;
  reset role;
  select count(*) into v_after from public.customer_review_requests;

  if v_reached then
    raise exception 'NOT REFUSED: %', p_label;
  end if;
  if v_state <> '42501' then
    raise exception 'refused, but with % rather than 42501 — wrong reason: %', v_state, p_label;
  end if;
  if v_after <> v_before then
    raise exception 'refused, yet a row appeared: %', p_label;
  end if;
  raise notice 'PASS      42501, no row  — %', p_label;
end $$;

do $$
begin
  raise notice 'PASS  6. every column the INSERT policy pins, refused one at a time:';
end $$;

do $$
begin
  perform pg_temp.refused('ffffffff-0000-4000-8000-000000000002',
    $q$insert into public.customer_review_requests
         (customer_name, created_by, status, verified_at, verified_by)
       values ('Fixture Forged', 'ffffffff-0000-4000-8000-000000000002', 'verified', now(), 'ffffffff-0000-4000-8000-000000000002')$q$,
    'status, with its timestamps satisfied so only the policy can object');
  perform pg_temp.refused('ffffffff-0000-4000-8000-000000000002',
    $q$insert into public.customer_review_requests
         (customer_name, created_by, status, sent_at, sent_by)
       values ('Fixture Forged', 'ffffffff-0000-4000-8000-000000000002', 'draft', now(), 'ffffffff-0000-4000-8000-000000000002')$q$,
    'sent_at + sent_by');
  perform pg_temp.refused('ffffffff-0000-4000-8000-000000000002',
    $q$insert into public.customer_review_requests
         (customer_name, created_by, status, responded_at, responded_by)
       values ('Fixture Forged', 'ffffffff-0000-4000-8000-000000000002', 'draft', now(), 'ffffffff-0000-4000-8000-000000000002')$q$,
    'responded_at + responded_by');
  perform pg_temp.refused('ffffffff-0000-4000-8000-000000000002',
    $q$insert into public.customer_review_requests
         (customer_name, created_by, status, verified_at, verified_by)
       values ('Fixture Forged', 'ffffffff-0000-4000-8000-000000000002', 'draft', now(), 'ffffffff-0000-4000-8000-000000000002')$q$,
    'verified_at + verified_by');
  perform pg_temp.refused('ffffffff-0000-4000-8000-000000000002',
    $q$insert into public.customer_review_requests
         (customer_name, created_by, status, closed_at, closed_by, verified_at, verified_by)
       values ('Fixture Forged', 'ffffffff-0000-4000-8000-000000000002', 'draft', now(), 'ffffffff-0000-4000-8000-000000000002', now(), 'ffffffff-0000-4000-8000-000000000002')$q$,
    'closed_at + closed_by');
  perform pg_temp.refused('ffffffff-0000-4000-8000-000000000002',
    $q$insert into public.customer_review_requests
         (customer_name, created_by, status, cancelled_at, cancelled_by)
       values ('Fixture Forged', 'ffffffff-0000-4000-8000-000000000002', 'draft', now(), 'ffffffff-0000-4000-8000-000000000002')$q$,
    'cancelled_at + cancelled_by');
  perform pg_temp.refused('ffffffff-0000-4000-8000-000000000002',
    $q$insert into public.customer_review_requests
         (customer_name, created_by, status, whatsapp_opened_at)
       values ('Fixture Forged', 'ffffffff-0000-4000-8000-000000000002', 'draft', now())$q$,
    'whatsapp_opened_at');
  perform pg_temp.refused('ffffffff-0000-4000-8000-000000000002',
    $q$insert into public.customer_review_requests
         (customer_name, created_by, status, whatsapp_opened_count)
       values ('Fixture Forged', 'ffffffff-0000-4000-8000-000000000002', 'draft', 1)$q$,
    'whatsapp_opened_count');
  perform pg_temp.refused('ffffffff-0000-4000-8000-000000000002',
    $q$insert into public.customer_review_requests
         (customer_name, created_by, status, review_public_url)
       values ('Fixture Forged', 'ffffffff-0000-4000-8000-000000000002', 'draft', 'https://example.test/published')$q$,
    'review_public_url');
  perform pg_temp.refused('ffffffff-0000-4000-8000-000000000002',
    $q$insert into public.customer_review_requests
         (customer_name, created_by, status, verification_note)
       values ('Fixture Forged', 'ffffffff-0000-4000-8000-000000000002', 'draft', 'checked by me')$q$,
    'verification_note');
  perform pg_temp.refused('ffffffff-0000-4000-8000-000000000002',
    $q$insert into public.customer_review_requests
         (customer_name, created_by, status, cancel_reason)
       values ('Fixture Forged', 'ffffffff-0000-4000-8000-000000000002', 'draft', 'never mind')$q$,
    'cancel_reason');

  -- ...and the two identity rules, which are not about columns but about who.
  perform pg_temp.refused('ffffffff-0000-4000-8000-000000000002',
    $q$insert into public.customer_review_requests (customer_name, created_by, status)
       values ('Fixture Impersonation', 'ffffffff-0000-4000-8000-000000000003', 'draft')$q$,
    'a create attributed to another employee');
  perform pg_temp.refused('ffffffff-0000-4000-8000-000000000005',
    $q$insert into public.customer_review_requests (customer_name, created_by, status)
       values ('Fixture Unauthorized', 'ffffffff-0000-4000-8000-000000000005', 'draft')$q$,
    'a create by an employee without the use permission');
end $$;

-- ─── 6b. The predicate survives public.users being tightened ───────────────
--
-- THE POINT OF THE WHOLE DEFINER ARRANGEMENT, demonstrated rather than argued.
--
-- The baseline gives public.users the row security and column grants it has in
-- production. Those happen to be compatible with reading users as the caller,
-- which is why an inline policy passed every earlier test. This asks the
-- question that matters instead: what happens when they are NOT compatible?
--
-- Below, the users read policy is dropped — row security stays on, so no
-- authenticated caller can read any users row. That is a plausible future
-- tightening, not a contrived one.

do $$
declare v_req uuid := 'aaaaaaaa-0000-4000-8000-000000000001'; v_seen integer; v_err text;
begin
  -- EVERYTHING BELOW IS UNDONE IN THE EXCEPTION HANDLER AS WELL AS ON SUCCESS.
  -- This block deliberately breaks two policies to see what depends on them;
  -- an assertion failing in the middle must not leave the database that way.
  begin
    drop policy "Users can read all active users" on public.users;

    -- The shipped policy delegates to a SECURITY DEFINER predicate, so it reads
    -- users with the definer's rights and is unaffected.
    v_seen := pg_temp.visible_to('ffffffff-0000-4000-8000-000000000002', v_req);
    if v_seen <> 1 then
      raise exception 'with users locked down, the owner lost sight of their own request (saw %)', v_seen;
    end if;
    raise notice 'PASS  6b-i.  users fully locked down, and the owner still sees their request';

    -- Now the same policy written the other way — reading users inline, as the
    -- caller. This is the version an earlier round of this work shipped.
    drop policy "customer_review_requests_select" on public.customer_review_requests;
    create policy "customer_review_requests_select" on public.customer_review_requests
      for select to authenticated
      using (
        exists (
          select 1 from public.users u
          where u.id = auth.uid() and u.is_active
            and (customer_review_requests.created_by = auth.uid()
                 or u.role = 'admin'
                 or public.resolve_permission(auth.uid(), 'customer_review_requests', 'verify'))
        )
      );

    v_seen := pg_temp.visible_to('ffffffff-0000-4000-8000-000000000002', v_req);
    if v_seen <> 0 then
      raise exception 'the inline-users policy was expected to go blind here, but saw % row(s) — this test no longer proves anything', v_seen;
    end if;
    raise notice 'PASS  6b-ii. the same policy reading users inline goes blind — which is what the definer predicate avoids';

  exception when others then
    v_err := sqlerrm;
    -- Put both back before re-raising, whatever went wrong above.
    execute $r$drop policy if exists "customer_review_requests_select" on public.customer_review_requests$r$;
    execute $r$create policy "customer_review_requests_select" on public.customer_review_requests
              for select to authenticated
              using (public.can_view_customer_review_request_row(customer_review_requests.created_by))$r$;
    execute $r$drop policy if exists "Users can read all active users" on public.users$r$;
    execute $r$create policy "Users can read all active users" on public.users
              for select to authenticated using (is_active = true)$r$;
    raise exception 'while users/policies were broken for the test: %', v_err;
  end;

  -- Put both back on the success path.
  drop policy "customer_review_requests_select" on public.customer_review_requests;
  create policy "customer_review_requests_select" on public.customer_review_requests
    for select to authenticated
    using (public.can_view_customer_review_request_row(customer_review_requests.created_by));
  create policy "Users can read all active users" on public.users
    for select to authenticated using (is_active = true);

  v_seen := pg_temp.visible_to('ffffffff-0000-4000-8000-000000000002', v_req);
  if v_seen <> 1 then
    raise exception 'restoring the shipped policy did not restore visibility (saw %)', v_seen;
  end if;
  raise notice 'PASS  6b-iii. both restored, and visibility is back';
end $$;

-- ─── 6c. A browser cannot ask a permission question ON SOMEBODY ELSE ───────
--
-- Every predicate here is granted to authenticated, so its arguments are
-- chosen by a browser. While they took an acting-user id, a signed-in
-- employee could pass a colleague's uuid and read back who is active, who is
-- an admin and who holds verify — one call at a time, from the browser
-- console. The parameter is gone; these check that it stayed gone.

do $$
declare v_n integer;
begin
  select count(*) into v_n
  from pg_proc f join pg_namespace n on n.oid = f.pronamespace
  where n.nspname = 'public'
    and f.proname like '%customer_review%'
    and has_function_privilege('authenticated', f.oid, 'EXECUTE')
    and pg_get_function_arguments(f.oid) ~* '(p_user_id|p_actor_id|p_acting)';
  if v_n <> 0 then
    raise exception '% browser-callable function(s) still accept an acting-user id', v_n;
  end if;
  raise notice 'PASS  6c-i.  no authenticated-callable function takes an acting-user id';

  -- The two-argument forms must not merely be discouraged; they must not exist.
  select count(*) into v_n
  from pg_proc f join pg_namespace n on n.oid = f.pronamespace
  where n.nspname = 'public'
    and f.proname in ('can_view_customer_review_request',
                      'can_view_customer_review_request_row',
                      'can_edit_customer_review_request',
                      'can_create_customer_review_request')
    and f.pronargs <> 1;
  if v_n <> 0 then
    raise exception '% read/create predicate(s) do not take exactly one argument', v_n;
  end if;
  raise notice 'PASS  6c-ii. all four predicates take exactly one argument';
end $$;

-- ...and behaviourally: the colleague probe does not work.
do $$
declare v_owner_sees boolean; v_probe boolean;
begin
  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', 'ffffffff-0000-4000-8000-000000000003', 'role', 'authenticated')::text);
  set local role authenticated;

  -- Fixture Colleague holds `use` and owns nothing. Asking about a request
  -- raised by the owner must answer for the COLLEAGUE, not the owner.
  v_probe := public.can_view_customer_review_request_row('ffffffff-0000-4000-8000-000000000002');
  reset role;

  if v_probe then
    raise exception 'a colleague evaluated the owner''s visibility as true — the predicate answered for the wrong person';
  end if;
  raise notice 'PASS  6c-iii. passing another employee''s uuid answers for the CALLER, not for them';

  -- And the same call, made by the owner, is true — so the false above is a
  -- real refusal rather than the function being broken.
  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', 'ffffffff-0000-4000-8000-000000000002', 'role', 'authenticated')::text);
  set local role authenticated;
  v_owner_sees := public.can_view_customer_review_request_row('ffffffff-0000-4000-8000-000000000002');
  reset role;
  if not v_owner_sees then
    raise exception 'the owner cannot see their own row through the predicate';
  end if;
  raise notice 'PASS  6c-iv. the owner still evaluates true for their own rows';
end $$;

-- ─── 6d. Creating survives public.users being taken away ───────────────────
--
-- The read policy was moved behind definer rights and the INSERT policy was
-- left reading users inline — the same defect on the write side. This is the
-- read-side test from 6b, aimed at creating.
--
-- Everything is restored in the EXCEPTION handler as well as on success, so a
-- failure here cannot leave the stack with users unreadable.

do $$
declare v_new uuid; v_err text;
begin
  begin
    drop policy "Users can read all active users" on public.users;
    revoke select on public.users from authenticated;

    execute format('set local request.jwt.claims = %L',
                   json_build_object('sub', 'ffffffff-0000-4000-8000-000000000002', 'role', 'authenticated')::text);
    set local role authenticated;

    insert into public.customer_review_requests (id, customer_name, created_by, status)
    values ('aaaaaaaa-0000-4000-8000-000000000003', 'Fixture Locked Down',
            'ffffffff-0000-4000-8000-000000000002', 'draft')
    returning id into v_new;

    reset role;

    if v_new is null then
      raise exception 'INSERT ... RETURNING gave nothing back with users locked down';
    end if;
    raise notice 'PASS  6d-i.  authorized INSERT ... RETURNING id succeeds with users unreadable';

    -- ...and the unauthorized cases are still refused, for the right reason,
    -- under the same conditions.
    perform pg_temp.refused('ffffffff-0000-4000-8000-000000000005',
      $q$insert into public.customer_review_requests (customer_name, created_by, status)
         values ('Fixture Locked Unauthorized', 'ffffffff-0000-4000-8000-000000000005', 'draft')$q$,
      'no use permission, users unreadable');

    perform pg_temp.refused('ffffffff-0000-4000-8000-000000000006',
      $q$insert into public.customer_review_requests (customer_name, created_by, status)
         values ('Fixture Locked Inactive', 'ffffffff-0000-4000-8000-000000000006', 'draft')$q$,
      'deactivated admin, users unreadable');

    perform pg_temp.refused('ffffffff-0000-4000-8000-000000000002',
      $q$insert into public.customer_review_requests (customer_name, created_by, status)
         values ('Fixture Locked Impersonation', 'ffffffff-0000-4000-8000-000000000003', 'draft')$q$,
      'created_by is somebody else, users unreadable');

  exception when others then
    v_err := sqlerrm;
    reset role;
    grant select (id, full_name, email, phone, role, team, position, is_active,
                  created_at, updated_at, employee_code, joining_date, office_timing,
                  fingerprint_employee_code, payroll_active, employment_type,
                  is_deleted, deleted_at, deleted_by, deletion_scheduled_at)
      on public.users to authenticated;
    create policy "Users can read all active users" on public.users
      for select to authenticated using (is_active = true);
    raise exception 'while users were locked down: %', v_err;
  end;

  -- Restore on the success path too.
  grant select (id, full_name, email, phone, role, team, position, is_active,
                created_at, updated_at, employee_code, joining_date, office_timing,
                fingerprint_employee_code, payroll_active, employment_type,
                is_deleted, deleted_at, deleted_by, deletion_scheduled_at)
    on public.users to authenticated;
  create policy "Users can read all active users" on public.users
    for select to authenticated using (is_active = true);

  delete from public.customer_review_request_events
   where request_id = 'aaaaaaaa-0000-4000-8000-000000000003';
  delete from public.customer_review_requests
   where id = 'aaaaaaaa-0000-4000-8000-000000000003';

  raise notice 'PASS  6d-ii. users restored, probe row removed';
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
