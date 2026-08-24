-- ORDER REQUEST RETIREMENT — the state BEFORE migration 20261007000000
-- ===========================================================================
-- Run against the production-shaped harness
-- (supabase/tests/_order_requests_shaped_schema.sql) with NO retirement
-- migration applied. Proves two things, and the second is the one that matters.
--
-- 1. The harness really does reconstruct the policy set the linked database
--    carries. Seven policies, arrived at by replaying the migration history
--    rather than declared — four permissive SELECT, one permissive INSERT, one
--    permissive DELETE, and one RESTRICTIVE ALL.
--
-- 2. WHICH of them actually grants INSERT.
--
--    The failure report attributed the linked apply-time failure to the
--    remaining `cmd = ALL` policy, on the reasoning that "an ALL policy
--    includes INSERT authority, even if it was originally intended for
--    administrative management". For this policy that is not so, and the
--    difference decides whether the correct fix drops it or keeps it.
--
--    `order_requests_module_entry_gate` is RESTRICTIVE. PostgreSQL AND-s
--    restrictive policies onto whatever the permissive policies allow; a
--    restrictive policy can only ever narrow. On a table with no permissive
--    INSERT policy, a restrictive ALL policy grants nothing at all — there is
--    nothing for it to narrow. So the assertions below drop ONLY the permissive
--    INSERT policy, leave the gate standing, and require the INSERT to be
--    refused anyway. Dropping the gate would have REMOVED a restriction and
--    widened the retired table, and it would have broken 20260905000000's own
--    assertion that all 27 module gates are present.
--
-- Runs inside ONE transaction that ends in ROLLBACK. Nothing is left behind.
--
-- PREREQUISITES: psql as a role that can `set local role authenticated`.
-- On success prints NOTICE 'PRE-107 ASSERTIONS PASSED'.

\set ON_ERROR_STOP on

begin;

do $$
declare
  OWNER constant uuid := '11111111-0000-4000-8000-000000000002';
  v_names   text;
  v_actual  text[];
  v_expected constant text[] := array[
    'order_requests_admin_delete_unconverted',
    'order_requests_admin_select',
    'order_requests_assignee_select',
    'order_requests_module_entry_gate',
    'order_requests_requester_insert',
    'order_requests_requester_select',
    'order_requests_view_all_select'];
  v_permissive text;
  v_cmd        text;
  v_ok         boolean;
begin
  -- ── 1. The pre-retirement policy set, exactly ─────────────────────────────
  select array_agg(policyname order by policyname) into v_actual
  from pg_policies where schemaname = 'public' and tablename = 'order_requests';

  if v_actual is distinct from v_expected then
    raise exception
      'the harness does not reconstruct the pre-107 policy set. expected %, found %',
      v_expected, v_actual;
  end if;

  -- ── 2. Exactly one policy carries cmd = ALL, and it is RESTRICTIVE ────────
  --
  -- This is the policy the failure report identified. Its category is the whole
  -- question, so it is asserted rather than assumed.
  select policyname, permissive into v_names, v_permissive
  from pg_policies
  where schemaname = 'public' and tablename = 'order_requests' and cmd = 'ALL';

  if v_names is distinct from 'order_requests_module_entry_gate' then
    raise exception 'expected exactly one ALL policy named order_requests_module_entry_gate, found %', v_names;
  end if;
  if v_permissive <> 'RESTRICTIVE' then
    raise exception
      'order_requests_module_entry_gate is % — the correction below assumes RESTRICTIVE', v_permissive;
  end if;

  -- ── 3. Exactly one PERMISSIVE INSERT policy, and it is the requester one ──
  select policyname into v_names
  from pg_policies
  where schemaname = 'public' and tablename = 'order_requests'
    and permissive = 'PERMISSIVE' and cmd in ('INSERT', 'ALL');

  if v_names is distinct from 'order_requests_requester_insert' then
    raise exception
      'expected the only permissive INSERT-capable policy to be order_requests_requester_insert, found %',
      v_names;
  end if;

  raise notice 'pre-107 policy set confirmed: 7 policies, 1 permissive INSERT, 1 restrictive ALL gate';
end $$;

-- ── 4. WITH the permissive INSERT policy, the owner can create a request ────
--
-- The workflow is live before the retirement, and this is what makes it live.
do $$
declare
  OWNER constant uuid := '11111111-0000-4000-8000-000000000002';
  v_id uuid := gen_random_uuid();
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', OWNER::text, true);

  insert into public.order_requests (id, request_number, client_name, created_by, requested_by, assigned_to)
  values (v_id, 'PRE107-LIVE', 'Pre-107 Client', OWNER, OWNER, OWNER);

  reset role;
  if not exists (select 1 from public.order_requests where id = v_id) then
    raise exception 'the pre-107 INSERT did not land; the harness is not reproducing the live workflow';
  end if;
  delete from public.order_requests where id = v_id;
  raise notice 'pre-107: the permissive INSERT policy does grant creation — the workflow is live';
exception when others then
  reset role;
  raise;
end $$;

-- ── 5. THE CORRECTION ───────────────────────────────────────────────────────
--
-- Drop ONLY the permissive INSERT policy. Leave the RESTRICTIVE ALL gate
-- standing. If the failure report's reading were right — that the ALL policy
-- carries INSERT authority — this INSERT would still succeed. It does not.
do $$
declare
  OWNER constant uuid := '11111111-0000-4000-8000-000000000002';
  ADMINU constant uuid := '11111111-0000-4000-8000-000000000001';
  v_id uuid := gen_random_uuid();
  v_refused boolean;
begin
  drop policy "order_requests_requester_insert" on public.order_requests;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'order_requests'
      and policyname = 'order_requests_module_entry_gate') then
    raise exception 'the restrictive gate was removed; this probe would prove nothing';
  end if;

  -- The owner, who could insert a moment ago.
  v_refused := false;
  begin
    set local role authenticated;
    perform set_config('request.jwt.claim.sub', OWNER::text, true);
    insert into public.order_requests (id, request_number, client_name, created_by, requested_by, assigned_to)
    values (v_id, 'PRE107-GATE-OWNER', 'Pre-107 Client', OWNER, OWNER, OWNER);
  exception when insufficient_privilege or check_violation then
    v_refused := true;
  end;
  reset role;
  if not v_refused then
    raise exception
      'the owner still inserted with only the restrictive ALL gate present — the gate DOES grant INSERT';
  end if;

  -- The admin, who opens the module gate by role and so passes the restrictive
  -- policy outright. If an ALL policy granted anything, this is where it would
  -- show.
  v_refused := false;
  begin
    set local role authenticated;
    perform set_config('request.jwt.claim.sub', ADMINU::text, true);
    insert into public.order_requests (id, request_number, client_name, created_by, requested_by, assigned_to)
    values (gen_random_uuid(), 'PRE107-GATE-ADMIN', 'Pre-107 Client', ADMINU, ADMINU, ADMINU);
  exception when insufficient_privilege or check_violation then
    v_refused := true;
  end;
  reset role;
  if not v_refused then
    raise exception
      'the admin still inserted with only the restrictive ALL gate present — the gate DOES grant INSERT';
  end if;

  raise notice 'CORRECTION PROVED: the restrictive ALL gate grants no INSERT to anyone, admin included';
exception when others then
  reset role;
  raise;
end $$;

do $$ begin raise notice 'PRE-107 ASSERTIONS PASSED'; end $$;

rollback;
