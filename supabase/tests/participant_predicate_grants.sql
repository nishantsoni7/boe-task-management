-- ═════════════════════════════════════════════════════════════════════════════
-- GRANT REGRESSION: can_read_payment_as_participant(uuid)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- THE DEFECT THIS EXISTS FOR. PostgreSQL grants EXECUTE on a new function to
-- PUBLIC by default. 20260919000000 §2 wrote `grant ... to authenticated` and no
-- revoke, so the default survived and `anon` — a member of PUBLIC — inherited
-- EXECUTE. `create or replace` preserves an ACL, so correcting the function's
-- body in 20261006000000 §2 did not disturb it; §2a writes the revoke.
--
-- AND WHY IT IS A SEPARATE FILE. The first version of the production-shaped
-- harness added a revoke that the applied migration never had. It therefore
-- reproduced a grant state that did not exist, passed locally, and let
-- 20261006000000 reach the linked database and fail there. Grants are now
-- asserted from the catalog rather than assumed.
--
-- Runs in BOTH phases, detecting which one it is in by the existence of
-- can_view_order_as_actor():
--   BEFORE  anon must inherit EXECUTE through PUBLIC — the defect, demonstrated.
--   AFTER   PUBLIC and anon must hold nothing, authenticated must hold EXECUTE,
--           the function must still work when called through the RLS policies,
--           and no policy may have broken because of the revoke.
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
