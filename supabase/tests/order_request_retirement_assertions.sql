-- ORDER REQUEST RETIREMENT assertions — the state AFTER migration 20261007000000
-- ===========================================================================
-- Run against the production-shaped harness
-- (supabase/tests/_order_requests_shaped_schema.sql) with 20261007000000
-- applied. Proves that the retired workflow is genuinely uncreatable, that the
-- history it left behind is still readable by exactly the people who could read
-- it before, that the cleanup and unlink doors still open, and that Finance
-- Payment Requests — a live workflow that shares a table with the retired one —
-- are untouched.
--
-- ORDER REQUESTS ARE NOT FINANCE PAYMENT REQUESTS. §6 exists to keep that
-- distinction provable rather than assumed.
--
-- The read matrix the six fixture users are required to produce, unchanged from
-- before the retirement because the retirement drops no SELECT policy:
--
--   ADMIN     1  finalized only — 20260711000000 hid upload-stage drafts
--   OWNER     2  their own rows, finalized or not
--   ASSIGNEE  1  finalized only
--   VIEWALL   2  orders:view_all is company-wide sight
--   OUTSIDER  0  passes the module gate, matches no permissive SELECT policy
--   STRANGER  0  the module gate closes first
--
-- Runs inside ONE transaction that ends in ROLLBACK. Nothing is left behind —
-- including the fixture request §5 deletes and the linkage §5 clears.
--
-- PREREQUISITES: psql as a role that can `set local role authenticated`.
-- On success prints NOTICE 'RETIREMENT ASSERTIONS PASSED'.

\set ON_ERROR_STOP on

begin;

-- ═══ 1. The policy set the retirement is required to leave ══════════════════

do $$
declare
  v_actual   text[];
  v_expected constant text[] := array[
    'order_requests_admin_select',
    'order_requests_assignee_select',
    'order_requests_module_entry_gate',
    'order_requests_requester_select',
    'order_requests_view_all_select'];
  v_names text;
  v_gate  record;
begin
  select array_agg(policyname order by policyname) into v_actual
  from pg_policies where schemaname = 'public' and tablename = 'order_requests';

  if v_actual is distinct from v_expected then
    raise exception 'post-107 policy set is wrong. expected %, found %', v_expected, v_actual;
  end if;

  -- No permissive policy grants any write, for any command.
  select string_agg(policyname || ' (' || cmd || ')', ', ' order by policyname) into v_names
  from pg_policies
  where schemaname = 'public' and tablename = 'order_requests'
    and permissive = 'PERMISSIVE' and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL');
  if v_names is not null then
    raise exception 'a permissive write policy survived the retirement: %', v_names;
  end if;

  -- At least one intended SELECT policy remains, or the history would be gone.
  if (select count(*) from pg_policies
      where schemaname = 'public' and tablename = 'order_requests'
        and permissive = 'PERMISSIVE' and cmd = 'SELECT') < 1 then
    raise exception 'every SELECT policy was removed; historical requests are unreadable';
  end if;

  -- The module gate is still there and still RESTRICTIVE. It is not a leftover
  -- to be tidied away: it is the parent-module check 20260905000000 put on all
  -- 27 module data tables, and dropping it would WIDEN the retired table.
  select permissive, cmd into v_gate from pg_policies
  where schemaname = 'public' and tablename = 'order_requests'
    and policyname = 'order_requests_module_entry_gate';
  if v_gate.permissive <> 'RESTRICTIVE' or v_gate.cmd <> 'ALL' then
    raise exception 'the module entry gate is now % %, not RESTRICTIVE ALL', v_gate.permissive, v_gate.cmd;
  end if;

  -- RLS itself is still on. Without it the absence of policies would mean the
  -- opposite of what the assertions above take it to mean.
  if not exists (select 1 from pg_class where oid = 'public.order_requests'::regclass and relrowsecurity) then
    raise exception 'row level security is disabled on order_requests';
  end if;

  raise notice '1. policy set: 4 permissive SELECT + 1 restrictive gate, no permissive write, RLS on';
end $$;

-- ═══ 2. The history is still readable, by exactly the same people ═══════════

do $$
declare
  v_case record;
  v_seen int;
begin
  for v_case in
    select * from (values
      ('ADMIN',    '11111111-0000-4000-8000-000000000001'::uuid, 1),
      ('OWNER',    '11111111-0000-4000-8000-000000000002'::uuid, 2),
      ('ASSIGNEE', '11111111-0000-4000-8000-000000000003'::uuid, 1),
      ('VIEWALL',  '11111111-0000-4000-8000-000000000004'::uuid, 2),
      ('OUTSIDER', '11111111-0000-4000-8000-000000000005'::uuid, 0),
      ('STRANGER', '11111111-0000-4000-8000-000000000006'::uuid, 0)
    ) as t(label, actor, expected)
  loop
    set local role authenticated;
    perform set_config('request.jwt.claim.sub', v_case.actor::text, true);
    select count(*) into v_seen from public.order_requests;
    reset role;

    if v_seen <> v_case.expected then
      raise exception '% sees % historical request(s), expected %', v_case.label, v_seen, v_case.expected;
    end if;
  end loop;

  -- The finalized request specifically, since that is the row an authorised
  -- viewer follows a confirmed Order's provenance back to.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '11111111-0000-4000-8000-000000000001', true);
  if not exists (select 1 from public.order_requests where request_number = 'REQ-FIXTURE-1') then
    raise exception 'an admin can no longer read the finalized historical request';
  end if;
  reset role;

  raise notice '2. historical visibility unchanged: admin 1, owner 2, assignee 1, view_all 2, outsider 0, stranger 0';
exception when others then
  reset role;
  raise;
end $$;

-- ═══ 3. Creating a request is impossible, at both layers ════════════════════

do $$
declare
  ADMINU constant uuid := '11111111-0000-4000-8000-000000000001';
  OWNER  constant uuid := '11111111-0000-4000-8000-000000000002';
  v_case record;
  v_sqlstate text;
  v_message  text;
begin
  -- Layer one: the guard trigger, which is what a client actually hits.
  for v_case in
    select * from (values ('admin', ADMINU), ('owner', OWNER)) as t(label, actor)
  loop
    v_sqlstate := null;
    begin
      set local role authenticated;
      perform set_config('request.jwt.claim.sub', v_case.actor::text, true);
      insert into public.order_requests (request_number, client_name, created_by, requested_by, assigned_to)
      values ('POST107-REFUSED', 'Nope', v_case.actor, v_case.actor, v_case.actor);
    exception when others then
      get stacked diagnostics v_sqlstate = returned_sqlstate, v_message = message_text;
    end;
    reset role;

    if v_sqlstate is null then
      raise exception 'the % session created an Order Request after the retirement', v_case.label;
    end if;
    if v_message not like '%ORDER_REQUESTS_RETIRED%' then
      raise exception 'the % INSERT was refused with "%", not the retirement guard', v_case.label, v_message;
    end if;
  end loop;

  raise notice '3a. INSERT refused for admin and owner sessions: ORDER_REQUESTS_RETIRED';
exception when others then
  reset role;
  raise;
end $$;

do $$
declare
  OWNER constant uuid := '11111111-0000-4000-8000-000000000002';
  v_refused boolean := false;
begin
  -- Layer two: RLS on its own. With the trigger disabled the WITH CHECK has
  -- nowhere to pass, because no permissive INSERT policy exists — so the
  -- retirement does not depend on the trigger alone. This is the database
  -- authority that a UI bypass would run into.
  alter table public.order_requests disable trigger order_requests_refuse_new;
  begin
    set local role authenticated;
    perform set_config('request.jwt.claim.sub', OWNER::text, true);
    insert into public.order_requests (request_number, client_name, created_by, requested_by, assigned_to)
    values ('POST107-RLS', 'Nope', OWNER, OWNER, OWNER);
  exception when insufficient_privilege or check_violation then
    v_refused := true;
  end;
  reset role;
  alter table public.order_requests enable trigger order_requests_refuse_new;

  if not v_refused then
    raise exception 'with the guard trigger off, RLS still allowed the INSERT';
  end if;
  raise notice '3b. with the guard trigger disabled, RLS refuses the INSERT on its own';
exception when others then
  reset role;
  raise;
end $$;

-- ═══ 4. The retired edit and conversion paths stay refused ══════════════════

do $$
declare
  REQ    constant uuid := '33333333-0000-4000-8000-0000000000b1';
  ADMINU constant uuid := '11111111-0000-4000-8000-000000000001';
  OWNER  constant uuid := '11111111-0000-4000-8000-000000000002';
  v_case record;
  v_rows int;
begin
  -- Direct UPDATE and DELETE reach no row, for anyone. No permissive policy for
  -- either command exists, so RLS filters the row set to empty rather than
  -- raising — which is why these assert a row count, not an error.
  for v_case in
    select * from (values ('admin', ADMINU), ('owner', OWNER)) as t(label, actor)
  loop
    set local role authenticated;
    perform set_config('request.jwt.claim.sub', v_case.actor::text, true);

    update public.order_requests set client_name = 'Rewritten' where id = REQ;
    get diagnostics v_rows = row_count;
    if v_rows <> 0 then
      raise exception 'the % session updated % historical request row(s)', v_case.label, v_rows;
    end if;

    delete from public.order_requests where id = REQ;
    get diagnostics v_rows = row_count;
    if v_rows <> 0 then
      raise exception 'the % session deleted % historical request row(s)', v_case.label, v_rows;
    end if;

    reset role;
  end loop;

  raise notice '4a. direct UPDATE and DELETE affect 0 rows for admin and owner alike';
exception when others then
  reset role;
  raise;
end $$;

do $$
declare
  DRAFT constant uuid := '33333333-0000-4000-8000-0000000000b2';
  ORD   constant uuid := '22222222-0000-4000-8000-0000000000a1';
  v_message  text;
  v_sqlstate text;
begin
  -- And the conversion guard is the second layer under it: even a caller that
  -- bypasses RLS entirely — which is what every remaining SECURITY DEFINER
  -- function does — cannot resume the workflow.
  --
  -- The guard refuses the TRANSITION into `converted`, not the record, so this
  -- has to attempt it on a row that is not converted yet. That is the
  -- unfinalized draft; the finalized fixture was converted before the
  -- retirement and stays fully correctable, which is the point of §7.
  v_sqlstate := null;
  begin
    update public.order_requests set status = 'converted' where id = DRAFT;
  exception when others then
    get stacked diagnostics v_sqlstate = returned_sqlstate, v_message = message_text;
  end;
  if v_sqlstate is null then
    raise exception 'a definer-level status transition into converted succeeded; the retirement is bypassable';
  end if;
  if v_message not like '%ORDER_REQUESTS_RETIRED%' then
    raise exception 'the conversion transition was refused with "%", not the retirement guard', v_message;
  end if;

  -- The same conversion arriving by attaching the Order id instead.
  v_sqlstate := null;
  begin
    update public.order_requests set converted_order_id = ORD where id = DRAFT;
  exception when others then
    get stacked diagnostics v_sqlstate = returned_sqlstate, v_message = message_text;
  end;
  if v_sqlstate is null then
    raise exception 'a definer-level attachment of converted_order_id succeeded; the retirement is bypassable';
  end if;
  if v_message not like '%ORDER_REQUESTS_RETIRED%' then
    raise exception 'the id attachment was refused with "%", not the retirement guard', v_message;
  end if;

  -- An already-converted historical row is still correctable, as the migration
  -- deliberately leaves it. Refusing this would have frozen the record rather
  -- than the workflow.
  update public.order_requests
     set client_name = 'Fixture Client'
   where id = '33333333-0000-4000-8000-0000000000b1';

  raise notice '4b. conversion refused even for an RLS-bypassing caller; converted history stays correctable';
end $$;

-- A new Order may no longer claim Order Request provenance, which is the other
-- half of the conversion: the Order side.
do $$
declare
  v_sqlstate text;
  v_message  text;
begin
  begin
    insert into public.orders (id, display_number, client_name,
                               source_order_request_id, source_request_number)
    values (gen_random_uuid(), 'POST107-PROVENANCE', 'Fixture Client',
            '33333333-0000-4000-8000-0000000000b1', 'REQ-FIXTURE-1');
  exception when others then
    get stacked diagnostics v_sqlstate = returned_sqlstate, v_message = message_text;
  end;
  if v_sqlstate is null then
    raise exception 'a new Order was created carrying Order Request provenance';
  end if;
  if v_message not like '%ORDER_REQUESTS_RETIRED%' then
    raise exception 'the provenance-carrying Order was refused with "%", not the retirement guard', v_message;
  end if;

  raise notice '4c. a new Order can no longer be created carrying Order Request provenance';
end $$;

do $$
declare
  v_name text;
  v_missing text;
begin
  -- The ten retired RPCs are unreachable from every client role, across every
  -- overload. A revoke that missed one overload would be a no-op in practice.
  select string_agg(format('%s/%s(%s)', p.proname, r.rolname, pg_get_function_identity_arguments(p.oid)), ', ')
    into v_missing
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join (values ('public'), ('anon'), ('authenticated')) as r(rolname)
  where n.nspname = 'public'
    and p.proname in (
      'finalize_order_request', 'resubmit_order_request', 'reapply_order_request',
      'respond_to_clarification', 'edit_order_request', 'edit_order_request_attachments',
      'request_order_request_clarification', 'reject_order_request',
      'convert_order_request_to_order', 'link_finance_payment_to_order_request')
    and has_function_privilege(r.rolname, p.oid, 'EXECUTE');

  if v_missing is not null then
    raise exception 'a retired Order Request RPC is still executable by a client role: %', v_missing;
  end if;

  raise notice '4d. all ten retired RPCs are unreachable from public, anon and authenticated';
end $$;

-- ═══ 5. Cleanup and unlink still work ═══════════════════════════════════════

do $$
declare
  v_name text;
begin
  -- Their grants survive. These are the doors the retirement must NOT close, or
  -- historical rows and historical money would be stranded.
  foreach v_name in array array[
    'admin_delete_order_request', 'cleanup_unfinalized_order_request',
    'remove_unfinalized_order_request_attachment', 'unlink_finance_payment_from_order_request']
  loop
    if not has_function_privilege('authenticated', format('public.%I(uuid)', v_name)::regprocedure, 'EXECUTE') then
      raise exception 'the cleanup RPC public.% is no longer executable by authenticated', v_name;
    end if;
  end loop;
  raise notice '5a. all four cleanup and unlink RPCs remain executable by authenticated';
end $$;

do $$
declare
  DRAFT constant uuid := '33333333-0000-4000-8000-0000000000b2';
  OWNER constant uuid := '11111111-0000-4000-8000-000000000002';
  v_rows int;
begin
  -- And they still DO something. A SECURITY DEFINER function bypasses RLS, so
  -- dropping the last permissive DELETE policy took nothing away from it — this
  -- is the assertion that proves that rather than assuming it.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', OWNER::text, true);
  select public.t_definer_delete_request(DRAFT) into v_rows;
  reset role;

  if v_rows <> 1 then
    raise exception 'the definer cleanup path deleted % rows, expected 1', v_rows;
  end if;
  if exists (select 1 from public.order_requests where id = DRAFT) then
    raise exception 'the definer cleanup path reported a delete that did not happen';
  end if;

  raise notice '5b. the definer cleanup path still deletes an unfinalized request';
exception when others then
  reset role;
  raise;
end $$;

do $$
declare
  PAY   constant uuid := '44444444-0000-4000-8000-0000000000c1';
  OWNER constant uuid := '11111111-0000-4000-8000-000000000002';
  v_rows int;
  v_still uuid;
begin
  if not exists (select 1 from public.finance_payment_requests
                 where id = PAY and order_request_id is not null) then
    raise exception 'the fixture payment does not carry the retired linkage; §5c would prove nothing';
  end if;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', OWNER::text, true);
  select public.t_definer_unlink_payment(PAY) into v_rows;
  reset role;

  if v_rows <> 1 then
    raise exception 'the definer unlink path updated % rows, expected 1', v_rows;
  end if;

  select order_request_id into v_still from public.finance_payment_requests where id = PAY;
  if v_still is not null then
    raise exception 'the retired linkage is still set after the unlink path ran';
  end if;

  raise notice '5c. the definer unlink path still clears a retired payment linkage';
exception when others then
  reset role;
  raise;
end $$;

-- ═══ 6. Finance Payment Requests are a LIVE workflow and stay live ══════════

do $$
declare
  v_name text;
  v_names text;
begin
  foreach v_name in array array[
    'approve_finance_payment_request', 'allocate_payment_to_target',
    'reverse_payment_allocation', 'link_finance_payment_to_order']
  loop
    if not has_function_privilege('authenticated', format('public.%I(uuid)', v_name)::regprocedure, 'EXECUTE') then
      raise exception 'the Finance RPC public.% is no longer executable by authenticated', v_name;
    end if;
  end loop;

  -- Finance keeps the permissive write policies the retirement removed from
  -- order_requests. Removing them here would have retired the wrong workflow.
  select string_agg(policyname || ' (' || cmd || ')', ', ' order by policyname) into v_names
  from pg_policies
  where schemaname = 'public' and tablename = 'finance_payment_requests'
    and permissive = 'PERMISSIVE' and cmd in ('INSERT', 'UPDATE', 'ALL');
  if v_names is null then
    raise exception 'finance_payment_requests has no permissive write policy left; Finance was retired too';
  end if;

  raise notice '6a. Finance RPCs executable; finance_payment_requests keeps its write policies: %', v_names;
end $$;

do $$
declare
  OWNER constant uuid := '11111111-0000-4000-8000-000000000002';
  ORD   constant uuid := '22222222-0000-4000-8000-0000000000a1';
  REQ   constant uuid := '33333333-0000-4000-8000-0000000000b1';
  v_id uuid := gen_random_uuid();
  v_message text;
begin
  -- A Finance Payment Request against a real Order: still allowed. This is the
  -- live workflow, and the single most important thing not to break.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', OWNER::text, true);
  insert into public.finance_payment_requests
    (id, request_number, client_name, amount, submitted_by, order_id)
  values (v_id, 'POST107-FINANCE-OK', 'Fixture Client', 1000, OWNER, ORD);
  reset role;

  if not exists (select 1 from public.finance_payment_requests where id = v_id) then
    raise exception 'a Finance Payment Request against a real Order was refused';
  end if;

  -- The same insert aimed at a retired Order Request: refused. The retired
  -- linkage column stays for history and stops being a target.
  begin
    set local role authenticated;
    perform set_config('request.jwt.claim.sub', OWNER::text, true);
    insert into public.finance_payment_requests
      (request_number, client_name, amount, submitted_by, order_request_id)
    values ('POST107-FINANCE-NO', 'Fixture Client', 1000, OWNER, REQ);
    raise exception 'a new payment was aimed at a retired Order Request';
  exception when others then
    get stacked diagnostics v_message = message_text;
    if v_message not like '%ORDER_REQUESTS_RETIRED%' then raise; end if;
  end;
  reset role;

  raise notice '6b. new Finance Payment Requests still target Orders, and no longer target retired requests';
exception when others then
  reset role;
  raise;
end $$;

-- ═══ 7. Nothing was removed ═════════════════════════════════════════════════

do $$
declare
  v_name text;
  v_missing text[] := '{}';
  v_order record;
begin
  foreach v_name in array array[
    'order_requests', 'order_request_activity', 'order_request_attachments']
  loop
    if to_regclass(format('public.%I', v_name)) is null then
      v_missing := v_missing || v_name;
    end if;
  end loop;
  if array_length(v_missing, 1) is not null then
    raise exception 'the retirement dropped historical table(s): %', v_missing;
  end if;

  -- The provenance a confirmed Order carries back to the request it came from.
  select source_order_request_id, source_request_number into v_order
  from public.orders where id = '22222222-0000-4000-8000-0000000000a1';
  if v_order.source_order_request_id is null or v_order.source_request_number is null then
    raise exception 'a confirmed Order lost its Order Request provenance';
  end if;

  -- The finalized request, its activity and its attachment. §5b deleted the
  -- UNFINALIZED draft and its children through the cleanup path; the finalized
  -- history is untouched.
  if not exists (select 1 from public.order_requests where id = '33333333-0000-4000-8000-0000000000b1') then
    raise exception 'the finalized historical request is gone';
  end if;
  if not exists (select 1 from public.order_request_activity
                 where order_request_id = '33333333-0000-4000-8000-0000000000b1') then
    raise exception 'historical activity was deleted';
  end if;
  if not exists (select 1 from public.order_request_attachments
                 where order_request_id = '33333333-0000-4000-8000-0000000000b1'
                   and storage_path is not null) then
    raise exception 'a historical attachment storage path was cleared';
  end if;

  raise notice '7. tables, provenance, history and storage paths all intact';
end $$;

do $$ begin raise notice 'RETIREMENT ASSERTIONS PASSED'; end $$;

rollback;
