-- Order Request assignee-ownership assertions (20260710000000)
-- ===========================================================================
-- Validates the assignee-ownership rule enforced by
-- 20260710000000_order_request_assignee_ownership.sql:
--   * trigger public.validate_order_request_assignee (fires on INSERT and the
--     SECURITY DEFINER RPC UPDATE paths), and
--   * the tightened order_requests_requester_insert RLS policy.
--
-- Rules asserted:
--   * Non-admin INSERT: assigned_to MUST equal the actor (self-assign only);
--     assigning to another user — or leaving it null — is rejected.
--   * Non-admin UPDATE (RPC path): assigned_to must not change.
--   * Admin INSERT/UPDATE: may assign / reassign to any ELIGIBLE user.
--
-- Runs entirely inside ONE transaction that ends in ROLLBACK, so every fixture
-- is discarded. Storage is not involved here.
--
-- PREREQUISITES (controlled environment, migrations already applied):
--   * Run with psql as a role that bypasses RLS (standard Supabase `postgres`
--     connection) and may SET the `role` GUC to 'authenticated'.
--   * Replace the THREE real user UUIDs in the config block below:
--       test.admin_id   -> a public.users row with role = 'admin'
--       test.sales_id   -> a NON-admin, ELIGIBLE order assignee (active Sales
--                          member / authorised assignee).
--       test.sales2_id  -> a SECOND, DISTINCT non-admin ELIGIBLE order assignee.
--                          Required so the "assign to another user" case proves
--                          the OWNERSHIP rule and not eligibility: the trigger
--                          checks eligibility FIRST, so the target of a rejected
--                          cross-assignment must itself be eligible.
--     All three must exist in public.users and be distinct.
--
-- On success prints NOTICE 'ALL ASSERTIONS PASSED' and rolls back. Any failed
-- ASSERT / unexpected result aborts the transaction with an error.
--
-- NOTE: like order_request_attachment_auth_assertions.sql, this script is run in
-- a controlled, already-migrated environment; it is not executed by the JS test
-- suite.

\set ON_ERROR_STOP on

begin;

-- ── Config: the ONLY lines a tester edits ─────────────────────────────────────
do $$
begin
  perform set_config('test.admin_id',  '11111111-1111-1111-1111-111111111111', true); -- REPLACE
  perform set_config('test.sales_id',  '22222222-2222-2222-2222-222222222222', true); -- REPLACE
  perform set_config('test.sales2_id', '44444444-4444-4444-4444-444444444444', true); -- REPLACE
  perform set_config('test.r_reassign', gen_random_uuid()::text, true);
end $$;

-- ── Fixture (superuser connection; RLS bypassed) ──────────────────────────────
-- An existing request owned by the salesperson, used by the UPDATE (RPC-path)
-- checks below. request_number is assigned by its own trigger.
insert into public.order_requests
  (id, client_name, requested_by, created_by, assigned_to, status, finalized_at)
values
  (current_setting('test.r_reassign')::uuid, 'ASSERT reassign',
   current_setting('test.sales_id')::uuid, current_setting('test.sales_id')::uuid,
   current_setting('test.sales_id')::uuid, 'submitted', now());

-- ── NON-ADMIN INSERT: self-assign succeeds; other/null rejected ───────────────
-- Runs under the authenticated role (RLS + trigger both apply), the real Submit
-- insert path. Drafts (finalized_at NULL) avoid activity side effects.
do $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', current_setting('test.sales_id'), true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('test.sales_id'), 'role', 'authenticated')::text, true);

  -- Self-assignment succeeds.
  insert into public.order_requests (client_name, requested_by, created_by, assigned_to, status, finalized_at)
  values ('ASSERT self ok', current_setting('test.sales_id')::uuid, current_setting('test.sales_id')::uuid,
          current_setting('test.sales_id')::uuid, 'submitted', null);
  assert (select count(*) from public.order_requests
          where created_by = current_setting('test.sales_id')::uuid and client_name = 'ASSERT self ok') = 1,
    'non-admin self-assignment should succeed';

  -- Assigning to ANOTHER eligible user is rejected (ownership, not eligibility).
  begin
    insert into public.order_requests (client_name, requested_by, created_by, assigned_to, status, finalized_at)
    values ('ASSERT other bad', current_setting('test.sales_id')::uuid, current_setting('test.sales_id')::uuid,
            current_setting('test.sales2_id')::uuid, 'submitted', null);
    raise exception 'FAIL: non-admin assigning to another user should be denied';
  exception when insufficient_privilege then null;  -- expected: 42501
  end;

  -- A null assignee is rejected too (strict self-assign).
  begin
    insert into public.order_requests (client_name, requested_by, created_by, assigned_to, status, finalized_at)
    values ('ASSERT null bad', current_setting('test.sales_id')::uuid, current_setting('test.sales_id')::uuid,
            null, 'submitted', null);
    raise exception 'FAIL: non-admin null-assignee insert should be denied';
  exception when insufficient_privilege then null;  -- expected: 42501
  end;
end $$;

-- ── ADMIN INSERT: may assign to another eligible user ─────────────────────────
do $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', current_setting('test.admin_id'), true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('test.admin_id'), 'role', 'authenticated')::text, true);

  insert into public.order_requests (client_name, requested_by, created_by, assigned_to, status, finalized_at)
  values ('ASSERT admin assigns', current_setting('test.admin_id')::uuid, current_setting('test.admin_id')::uuid,
          current_setting('test.sales2_id')::uuid, 'submitted', null);
  assert (select assigned_to = current_setting('test.sales2_id')::uuid from public.order_requests
          where created_by = current_setting('test.admin_id')::uuid and client_name = 'ASSERT admin assigns'),
    'admin should be able to assign a new request to another eligible user';
end $$;

-- ── UPDATE (SECURITY DEFINER / RPC path): owner privileges + auth.uid from JWT ─
-- resubmit / reapply / edit run as the function owner (RLS bypassed) with
-- auth.uid() = the caller. Simulate that by returning to the superuser role
-- (RLS bypass) and setting the JWT subject: the BEFORE trigger still fires and
-- enforces the ownership rule on this path, which no RLS UPDATE policy governs.
reset role;
select set_config('request.jwt.claim.sub', current_setting('test.sales_id'), true);
select set_config('request.jwt.claims',
  json_build_object('sub', current_setting('test.sales_id'), 'role', 'authenticated')::text, true);

do $$
begin
  -- A non-admin may NOT change an existing request's assignee.
  begin
    update public.order_requests set assigned_to = current_setting('test.sales2_id')::uuid
    where id = current_setting('test.r_reassign')::uuid;
    raise exception 'FAIL: non-admin changing the assignee should be denied';
  exception when insufficient_privilege then null;  -- expected: 42501
  end;
  assert (select assigned_to = current_setting('test.sales_id')::uuid
          from public.order_requests where id = current_setting('test.r_reassign')::uuid),
    'assignee must be unchanged after the denied non-admin update';
end $$;

select set_config('request.jwt.claim.sub', current_setting('test.admin_id'), true);
select set_config('request.jwt.claims',
  json_build_object('sub', current_setting('test.admin_id'), 'role', 'authenticated')::text, true);

do $$
begin
  -- An admin MAY reassign to another eligible user.
  update public.order_requests set assigned_to = current_setting('test.sales2_id')::uuid
  where id = current_setting('test.r_reassign')::uuid;
  assert (select assigned_to = current_setting('test.sales2_id')::uuid
          from public.order_requests where id = current_setting('test.r_reassign')::uuid),
    'admin should be able to reassign an existing request to another eligible user';
end $$;

reset role;
do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;

rollback;
