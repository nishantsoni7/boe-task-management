-- ═════════════════════════════════════════════════════════════════════════════
-- ACL AND DEFAULT-PRIVILEGE REGRESSION
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WHY THIS FILE EXISTS. 20261006000000 was rejected by the linked database
-- twice, both times on a grant the local harness did not reproduce:
--
--   attempt 1  ERROR: anon must not hold EXECUTE on can_read_payment_as_participant
--   attempt 2  ERROR: EXECUTE on can_view_order_as_actor(uuid) is granted to
--                     {authenticated,service_role}, expected only {authenticated}
--
-- They are two different mechanisms wearing the same clothes:
--
--   INHERITED  PostgreSQL grants EXECUTE on every new function to PUBLIC. anon
--              is a member of PUBLIC, so anon can execute without ever appearing
--              in the ACL. 20260919000000 §2 wrote a grant and no revoke, so
--              can_read_payment_as_participant kept that default. Attempt 1.
--   DIRECT     a hosted Supabase database runs `alter default privileges in
--              schema public grant all on functions to postgres, anon,
--              authenticated, service_role`, so every new function is ALSO born
--              with three real ACL entries. `revoke ... from public, anon`
--              clears PUBLIC and anon and leaves service_role. Attempt 2.
--
-- So this file asserts, in order:
--
--   1. the harness gives a NEWLY created function the same privileges the linked
--      database gives one — if that stops being true, nothing below means
--      anything;
--   2. the UNCORRECTED forms reproduce BOTH remote failures, on a probe function
--      created here, so the harness is proved to catch them rather than assumed;
--   3. after 20261006000000, each of the three functions has its own exact ACL;
--   4. nothing functional broke: the policies still resolve, participants keep
--      their visibility, anon is refused, service_role is refused.
--
-- Runs in BOTH phases, detecting which by the existence of can_view_order_as_actor().
--
-- Run: see supabase/tests/run_security_suite.sh

\set ON_ERROR_STOP on

begin;

-- ─── Fixtures ────────────────────────────────────────────────────────────────
--
-- Its own, because payment_participant_security.sql ends in a rollback and
-- leaves nothing behind. Same ids and same shape, so the two files describe the
-- same world: SALLY requests ORDER_X, PIA created SUBMISSION_P, FIONA holds
-- finance.view_all and submitted both payments.

insert into public.users (id, full_name, role, team) values
  ('00000000-0000-0000-0000-00000000ad00','Admin','admin',   null),
  ('00000000-0000-0000-0000-0000000005a1','Sally','employee','sales'),
  ('00000000-0000-0000-0000-0000000009a1','Pia',  'employee','sales'),
  ('00000000-0000-0000-0000-0000000000f1','Fiona','employee','finance');

insert into public.t_permission_grants (user_id, module_key, action_key) values
  ('00000000-0000-0000-0000-0000000005a1','orders','view'),
  ('00000000-0000-0000-0000-0000000009a1','orders','view'),
  ('00000000-0000-0000-0000-0000000000f1','finance','view'),
  ('00000000-0000-0000-0000-0000000000f1','finance','view_all');

insert into public.orders (id, display_number, requested_by) values
  ('00000000-0000-0000-0000-00000000d0e1','ORD-X','00000000-0000-0000-0000-0000000005a1');

insert into public.order_submissions (id, status, created_by) values
  ('00000000-0000-0000-0000-00000000b0a1','submitted','00000000-0000-0000-0000-0000000009a1');

insert into public.finance_payment_requests (id, amount, status, submitted_by) values
  ('00000000-0000-0000-0000-0000000c00a1',1000000.00,'approved_unlinked','00000000-0000-0000-0000-0000000000f1'),
  ('00000000-0000-0000-0000-0000000c00b1',1000000.00,'approved_unlinked','00000000-0000-0000-0000-0000000000f1');

insert into public.finance_payment_allocations (id, payment_request_id, allocated_amount, status, order_id, order_submission_id) values
  ('00000000-0000-0000-0000-00000000a111','00000000-0000-0000-0000-0000000c00a1',400000.00,'active','00000000-0000-0000-0000-00000000d0e1', null),
  ('00000000-0000-0000-0000-00000000a222','00000000-0000-0000-0000-0000000c00b1',250000.00,'active', null,'00000000-0000-0000-0000-00000000b0a1');

insert into public.payment_proof_attachments (id, payment_request_id) values
  ('00000000-0000-0000-0000-0000000f0001','00000000-0000-0000-0000-0000000c00a1');

-- ═══ 1 & 2. The harness's own defaults, and both remote failures ═══════════

do $$
declare
  v_acl       aclitem[];
  v_owner     text;
  v_grantees  text[];
begin
  -- 1. A FUNCTION CREATED RIGHT HERE must be born with what the linked database
  -- gives one. This is the assertion whose absence let two migrations through.
  create function public.t_acl_probe() returns int language sql as $f$ select 1 $f$;

  select p.proacl, pg_get_userbyid(p.proowner) into v_acl, v_owner
  from pg_proc p where p.oid = 'public.t_acl_probe()'::regprocedure;

  select coalesce(array_agg(distinct g order by g), '{}') into v_grantees
  from (select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as g
        from aclexplode(v_acl) a where a.privilege_type = 'EXECUTE') x
  where g <> v_owner;

  if v_grantees is distinct from array['PUBLIC','anon','authenticated','service_role'] then
    raise exception
      'HARNESS DOES NOT MATCH THE LINKED DATABASE: a new function is born with %, expected {PUBLIC,anon,authenticated,service_role}. Every grant assertion below is meaningless until this matches.',
      v_grantees;
  end if;
  raise notice 'DEFAULTS pass — a new function is born with %, exactly as on the linked database', v_grantees;

  -- 2a. REMOTE FAILURE 1, reproduced: the form 20260919000000 §2 used — a grant
  -- and no revoke — leaves anon able to execute, through PUBLIC and directly.
  grant execute on function public.t_acl_probe() to authenticated;
  if not has_function_privilege('public', 'public.t_acl_probe()', 'execute') then
    raise exception 'REMOTE FAILURE 1 did not reproduce: PUBLIC does not hold EXECUTE';
  end if;
  if not has_function_privilege('anon', 'public.t_acl_probe()', 'execute') then
    raise exception 'REMOTE FAILURE 1 did not reproduce: anon cannot execute';
  end if;
  raise notice 'REMOTE FAILURE 1 reproduced — grant-without-revoke leaves anon able to execute';

  -- 2b. REMOTE FAILURE 2, reproduced: the form 20261006000000 shipped with —
  -- `revoke ... from public, anon` — clears PUBLIC and anon and leaves the
  -- platform's DIRECT service_role grant standing.
  revoke execute on function public.t_acl_probe() from public, anon;

  select p.proacl into v_acl from pg_proc p
  where p.oid = 'public.t_acl_probe()'::regprocedure;
  select coalesce(array_agg(distinct g order by g), '{}') into v_grantees
  from (select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as g
        from aclexplode(v_acl) a where a.privilege_type = 'EXECUTE') x
  where g <> v_owner;

  if v_grantees is distinct from array['authenticated','service_role'] then
    raise exception
      'REMOTE FAILURE 2 did not reproduce: after the shipped revoke the grantees are %, expected {authenticated,service_role}',
      v_grantees;
  end if;
  raise notice
    'REMOTE FAILURE 2 reproduced — `revoke from public, anon` leaves %, the exact ACL the linked database rejected',
    v_grantees;

  -- 2c. And the DETERMINISTIC form, applied to the same probe, fixes it.
  revoke all on function public.t_acl_probe() from public;
  revoke all on function public.t_acl_probe() from anon;
  revoke all on function public.t_acl_probe() from service_role;
  grant execute on function public.t_acl_probe() to authenticated;

  select p.proacl into v_acl from pg_proc p
  where p.oid = 'public.t_acl_probe()'::regprocedure;
  select coalesce(array_agg(distinct g order by g), '{}') into v_grantees
  from (select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as g
        from aclexplode(v_acl) a where a.privilege_type = 'EXECUTE') x
  where g <> v_owner;

  if v_grantees is distinct from array['authenticated'] then
    raise exception 'the deterministic revoke form left %, expected {authenticated}', v_grantees;
  end if;
  if not has_function_privilege(v_owner, 'public.t_acl_probe()', 'execute') then
    raise exception 'the deterministic revoke form cost the owner its EXECUTE';
  end if;
  raise notice
    'DETERMINISTIC form pass — three explicit revokes leave %, and the owner keeps EXECUTE', v_grantees;

  drop function public.t_acl_probe();
end $$;

-- ═══ 3. The three functions' own exact ACLs ════════════════════════════════

do $$
declare
  corrected  boolean := to_regprocedure('public.can_view_order_as_actor(uuid)') is not null;
  phase      text;
  v_acl      aclitem[];
  v_owner    text;
  v_grantees text[];
  v_n        int;
begin
  phase := case when corrected then 'AFTER ' else 'BEFORE' end;

  select p.proacl, pg_get_userbyid(p.proowner) into v_acl, v_owner
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.oid = 'public.can_read_payment_as_participant(uuid)'::regprocedure;

  select coalesce(array_agg(distinct g order by g), '{}') into v_grantees from (
    select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as g
    from aclexplode(v_acl) a where a.privilege_type = 'EXECUTE'
  ) x where g <> v_owner;

  if not corrected then
    -- ═══ BEFORE: the defect must actually be present ═══════════════════════
    if not has_function_privilege('public', 'public.can_read_payment_as_participant(uuid)', 'execute') then
      raise exception
        'BEFORE: PUBLIC does not hold EXECUTE — the harness is not reproducing the applied grant state, which is the mistake that let 20261006000000 fail remotely';
    end if;
    if not has_function_privilege('anon', 'public.can_read_payment_as_participant(uuid)', 'execute') then
      raise exception 'BEFORE: anon does not inherit EXECUTE — the defect did not reproduce';
    end if;
    raise notice
      'BEFORE grants EXPOSED — anon inherits EXECUTE through PUBLIC (grantees beside owner %: %)',
      v_owner, v_grantees;
    return;
  end if;

  -- ═══ AFTER: the four questions, asked separately ═════════════════════════
  if has_function_privilege('public', 'public.can_read_payment_as_participant(uuid)', 'execute') then
    raise exception 'AFTER  grants FAILED: PUBLIC still holds EXECUTE';
  end if;
  raise notice 'AFTER  grants pass — PUBLIC holds no EXECUTE';

  if has_function_privilege('anon', 'public.can_read_payment_as_participant(uuid)', 'execute') then
    raise exception 'AFTER  grants FAILED: anon still holds EXECUTE';
  end if;
  raise notice 'AFTER  grants pass — anon holds no EXECUTE';

  if not has_function_privilege('authenticated', 'public.can_read_payment_as_participant(uuid)', 'execute') then
    raise exception 'AFTER  grants FAILED: authenticated lost EXECUTE — every payment policy would error';
  end if;
  raise notice 'AFTER  grants pass — authenticated holds EXECUTE';

  if v_acl is null then
    raise exception 'AFTER  grants FAILED: default privileges restored, which IS the PUBLIC grant';
  end if;
  if v_grantees is distinct from array['authenticated'] then
    raise exception
      'AFTER  grants FAILED: EXECUTE granted to %, expected only {authenticated} beside owner %',
      v_grantees, v_owner;
  end if;
  raise notice 'AFTER  grants pass — the only grantee beside the owner (%) is authenticated', v_owner;

  -- service_role is deliberately NOT granted. It holds BYPASSRLS, so the four
  -- policies that call this function are never evaluated for it and it never
  -- reaches the function at all. Asserted, not assumed.
  if has_function_privilege('service_role', 'public.can_read_payment_as_participant(uuid)', 'execute') then
    raise exception
      'AFTER  grants FAILED: service_role holds EXECUTE; bypassing RLS is not a reason to hold an RPC';
  end if;
  raise notice 'AFTER  grants pass — service_role holds no EXECUTE, and needs none';
end $$;

-- ═══ Each function's OWN exact ACL, specified separately ═══════════════════
--
-- The same specification the migration asserts at apply time, restated here so
-- the repository carries it too. Deliberately three separate entries rather than
-- one shared list: they agree today, and a change to one must not be waved
-- through because the other two still match.

do $$
declare
  corrected boolean := to_regprocedure('public.can_view_order_as_actor(uuid)') is not null;
  v_fn       text;
  v_expected text[];
  v_acl      aclitem[];
  v_owner    text;
  v_grantees text[];
begin
  if not corrected then return; end if;

  foreach v_fn in array array[
    'can_view_order_as_actor(uuid)',
    'can_read_payment_as_participant(uuid)',
    'order_linked_payment_total(uuid)'
  ] loop
    v_expected := case v_fn
      when 'can_view_order_as_actor(uuid)'         then array['authenticated']
      when 'can_read_payment_as_participant(uuid)' then array['authenticated']
      when 'order_linked_payment_total(uuid)'      then array['authenticated']
      else null
    end;
    if v_expected is null then
      raise exception 'no ACL specified for %', v_fn;
    end if;

    select p.proacl, pg_get_userbyid(p.proowner) into v_acl, v_owner
    from pg_proc p where p.oid = ('public.' || v_fn)::regprocedure;

    if v_acl is null then
      raise exception '% carries default privileges, which include EXECUTE to PUBLIC', v_fn;
    end if;

    select coalesce(array_agg(distinct g order by g), '{}') into v_grantees
    from (select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as g
          from aclexplode(v_acl) a where a.privilege_type = 'EXECUTE') x
    where g <> v_owner;

    if v_grantees is distinct from v_expected then
      raise exception 'AFTER  ACL FAILED: % is granted to %, expected exactly %',
        v_fn, v_grantees, v_expected;
    end if;
    if has_function_privilege('public', 'public.' || v_fn, 'execute') then
      raise exception 'AFTER  ACL FAILED: PUBLIC can still execute %', v_fn;
    end if;
    if has_function_privilege('anon', 'public.' || v_fn, 'execute') then
      raise exception 'AFTER  ACL FAILED: anon can still execute %', v_fn;
    end if;
    if not has_function_privilege(v_owner, 'public.' || v_fn, 'execute') then
      raise exception 'AFTER  ACL FAILED: the owner % lost EXECUTE on %', v_owner, v_fn;
    end if;

    raise notice 'AFTER  ACL pass — % : direct grantees % beside owner %, PUBLIC and anon excluded',
      v_fn, v_grantees, v_owner;
  end loop;
end $$;

-- ═══ Direct service-role execution is refused, function by function ════════
--
-- The privilege layer, not a policy: service_role holds BYPASSRLS, so if it held
-- EXECUTE it would sail past every check these functions exist to make. None of
-- the three has a service-role caller, so all three must refuse it outright.

do $$
declare
  corrected boolean := to_regprocedure('public.can_view_order_as_actor(uuid)') is not null;
  ORDER_X uuid := '00000000-0000-0000-0000-00000000d0e1';
  P_X     uuid := '00000000-0000-0000-0000-0000000c00a1';
begin
  if not corrected then return; end if;

  begin
    set local role service_role;
    perform public.can_view_order_as_actor(ORDER_X);
    reset role;
    raise exception 'AFTER  service_role FAILED: executed can_view_order_as_actor';
  exception when insufficient_privilege then
    reset role;
    raise notice 'AFTER  service_role pass — can_view_order_as_actor refused';
  end;

  begin
    set local role service_role;
    perform public.can_read_payment_as_participant(P_X);
    reset role;
    raise exception 'AFTER  service_role FAILED: executed can_read_payment_as_participant';
  exception when insufficient_privilege then
    reset role;
    raise notice 'AFTER  service_role pass — can_read_payment_as_participant refused';
  end;

  begin
    set local role service_role;
    perform public.order_linked_payment_total(ORDER_X);
    reset role;
    raise exception 'AFTER  service_role FAILED: executed order_linked_payment_total';
  exception when insufficient_privilege then
    reset role;
    raise notice 'AFTER  service_role pass — order_linked_payment_total refused';
  end;

  -- service_role keeps everything it actually needs: it bypasses RLS and reads
  -- the tables directly, which is how every real service operation works.
  set local role service_role;
  perform count(*) from public.finance_payment_requests;
  perform count(*) from public.finance_payment_allocations;
  reset role;
  raise notice 'AFTER  service_role pass — still reads the finance tables directly, bypassing RLS';
end $$;

-- ═══ The revoke must not have broken a single policy ═══════════════════════
--
-- The risk of revoking from PUBLIC is that some role was silently relying on the
-- inherited grant. Every reader below is exercised for real, through the
-- policies that call the function, AFTER the revoke.

do $$
declare
  corrected boolean := to_regprocedure('public.can_view_order_as_actor(uuid)') is not null;
  v_n int;
  SALLY uuid := '00000000-0000-0000-0000-0000000005a1';
  PIA   uuid := '00000000-0000-0000-0000-0000000009a1';
  ADMINU uuid := '00000000-0000-0000-0000-00000000ad00';
  FIONA uuid := '00000000-0000-0000-0000-0000000000f1';
  P_X   uuid := '00000000-0000-0000-0000-0000000c00a1';
  P_PI  uuid := '00000000-0000-0000-0000-0000000c00b1';
  v_user uuid;
begin
  if not corrected then return; end if;

  -- The predicate still RESOLVES for an authenticated caller: a participant read
  -- goes through finance_payment_requests_participant_select and the restrictive
  -- gate, both of which call it. A lost grant would raise
  -- "permission denied for function", not return zero rows.
  foreach v_user in array array[SALLY, PIA, ADMINU, FIONA] loop
    set local role authenticated;
    perform set_config('request.jwt.claim.sub', v_user::text, true);
    perform count(*) from public.finance_payment_requests;
    perform count(*) from public.payment_proof_attachments;
    reset role;
  end loop;
  raise notice 'AFTER  grants pass — all four payment policies still resolve for authenticated callers';

  -- And the participant paths still WORK, not merely fail to error.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', SALLY::text, true);
  select count(*) into v_n from public.finance_payment_requests where id = P_X;
  if v_n <> 1 then
    raise exception 'AFTER  grants FAILED: the Order participant lost sight of their payment (% rows)', v_n;
  end if;
  select count(*) into v_n from public.payment_proof_attachments where payment_request_id = P_X;
  if v_n <> 1 then
    raise exception 'AFTER  grants FAILED: the Order participant lost the proof metadata';
  end if;
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', PIA::text, true);
  select count(*) into v_n from public.finance_payment_requests where id = P_PI;
  if v_n <> 1 then
    raise exception 'AFTER  grants FAILED: the PI participant lost sight of their payment';
  end if;
  reset role;
  raise notice 'AFTER  grants pass — Order and PI participant reads still return their rows';

  -- anon is refused at the privilege layer, before any policy is consulted.
  begin
    set local role anon;
    perform public.can_read_payment_as_participant(P_X);
    reset role;
    raise exception 'AFTER  grants FAILED: anon executed the predicate';
  exception
    when insufficient_privilege then
      reset role;
      raise notice 'AFTER  grants pass — anon is refused with insufficient_privilege';
  end;
end $$;

rollback;
