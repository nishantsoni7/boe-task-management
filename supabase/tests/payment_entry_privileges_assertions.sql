-- Privilege assertions for 20261013000000_payment_entry_destination_model.sql,
-- under PRODUCTION-SHAPED default privileges.
--
-- WHY THIS FILE EXISTS. The first version of §2 revoked the intent table's
-- privileges from PUBLIC and anon and never named `authenticated`:
--
--   revoke all ... from public, anon;
--   grant select ... to authenticated;
--
-- On a bare PostgreSQL that is exactly right — the table starts with an empty
-- ACL, so `authenticated` ends with the one SELECT it was granted, and every
-- local suite passed. On a Supabase project it is exactly wrong. The project
-- bootstrap runs
--
--   alter default privileges in schema public
--     grant all on tables to anon, authenticated, service_role;
--
-- for the role the migration runner connects as, so the table is CREATED with
-- `authenticated=arwdDxt/postgres` already on it. Revoking from PUBLIC and anon
-- leaves that untouched, and granting SELECT to a role that already holds
-- everything narrows nothing. The migration's own §9f caught it — in
-- production, on the push, after every local suite had gone green.
--
-- So the gap was never the assertion. It was the FIXTURE: a local database that
-- did not model the one thing the production database does before a migration
-- runs. run_payment_entry_privileges_suite.sh builds that model, and this file
-- is what it proves against it.
--
-- TWO KINDS OF PROOF, deliberately. has_table_privilege() answers the question
-- §9f asks; `set role` and a real attempted write answer the question a client
-- asks. A privilege audit that never tries the write is a spelling test.
--
-- One transaction, rolled back: nothing is left behind.

\set ON_ERROR_STOP on

-- ── The control, OUTSIDE the transaction below ───────────────────────────────
--
-- A CHECK THAT CANNOT FAIL IS NOT A CHECK. Before asserting anything about the
-- intent table, prove this database really does hand new tables to
-- `authenticated` with ALL privileges — otherwise every assertion below would
-- pass on a fixture that had quietly stopped modelling production, which is the
-- precise failure this suite exists to prevent.
create table public.privilege_model_control (id int);

do $$
begin
  if not has_table_privilege('authenticated', 'public.privilege_model_control', 'insert') then
    raise exception
      'THE FIXTURE IS NOT PRODUCTION-SHAPED: a new table did not inherit INSERT for authenticated, so nothing below would prove anything. Check the ALTER DEFAULT PRIVILEGES in the suite runner.';
  end if;
  if not has_table_privilege('anon', 'public.privilege_model_control', 'select') then
    raise exception
      'THE FIXTURE IS NOT PRODUCTION-SHAPED: a new table did not inherit SELECT for anon.';
  end if;
  raise notice '0. CONTROL — this database grants ALL on a new table to anon and authenticated, exactly as a Supabase project does';
end $$;

drop table public.privilege_model_control;

begin;

create or replace function pg_temp.act_as(p_id uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_id, 'role', 'authenticated')::text, true);
end $$;

insert into public.users (id, email, role, full_name) values
  ('11111111-1111-4111-8111-111111111111', 'admin@boe.test', 'admin',       'Admin'),
  ('22222222-2222-4222-8222-222222222222', 'sales@boe.test', 'salesperson', 'Sales');
insert into public.finance_permission_grants (user_id, action) values
  ('22222222-2222-4222-8222-222222222222', 'finance.create');
insert into public.orders (id, display_number, status, client_name, created_by) values
  ('a0000000-0000-4000-8000-00000000000a', 'ORD-A', 'running', 'Kalyan Interiors',
   '11111111-1111-4111-8111-111111111111'),
  ('b0000000-0000-4000-8000-00000000000b', 'ORD-B', 'running', 'Menon Builders',
   '11111111-1111-4111-8111-111111111111');
insert into public.order_submissions (id, client_name, status, created_by) values
  ('d0000000-0000-4000-8000-00000000000d', 'Kalyan Interiors', 'draft',
   '22222222-2222-4222-8222-222222222222');

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. authenticated MAY read the intent table at the privilege level
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The RLS policy is what narrows the read to the caller's own payments. The
-- PRIVILEGE has to be there for the policy to have anything to narrow — a
-- migration that revoked SELECT too would leave the detail and review modals
-- unable to say what a payment is for, and would do it silently.
do $$
begin
  if not has_table_privilege('authenticated', 'public.finance_payment_allocation_intents', 'select') then
    raise exception '1: authenticated must hold SELECT on the intent table';
  end if;
  if not (select relrowsecurity from pg_class
           where oid = 'public.finance_payment_allocation_intents'::regclass) then
    raise exception '1: RLS must be enabled — the SELECT privilege is only safe because a policy narrows it';
  end if;
  if (select count(*) from pg_policy
       where polrelid = 'public.finance_payment_allocation_intents'::regclass) <> 1 then
    raise exception '1: exactly one policy, and it is a SELECT policy';
  end if;
  if (select polcmd from pg_policy
       where polrelid = 'public.finance_payment_allocation_intents'::regclass) <> 'r' then
    raise exception '1: the only policy on the intent table must be for SELECT';
  end if;
  raise notice '1. READ — authenticated holds SELECT, RLS is on, and the one policy is a SELECT policy';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. authenticated may NOT write it — at the privilege level, and in fact
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE REGRESSION. Every write privilege by name, not the three the first
-- version of §9f happened to list.
do $$
declare v_priv text;
begin
  foreach v_priv in array array['insert', 'update', 'delete', 'truncate', 'references', 'trigger'] loop
    if has_table_privilege('authenticated', 'public.finance_payment_allocation_intents', v_priv) then
      raise exception
        '2: authenticated must not hold % on the intent table. A Supabase project grants ALL on every new table — revoke BY NAME, not by revoking from PUBLIC and anon.', v_priv;
    end if;
  end loop;
  raise notice '2a. WRITE PRIVILEGES — authenticated holds none of insert/update/delete/truncate/references/trigger';
end $$;

-- …and the same question asked the way a client asks it. `set role` makes the
-- privilege check real: this is the refusal PostgREST would return, raised
-- BEFORE any policy is consulted.
do $$
declare v_failed boolean; v_msg text;
begin
  set local role authenticated;

  v_failed := false;
  begin
    insert into public.finance_payment_allocation_intents
      (payment_request_id, target_type, order_id, intended_amount, created_by)
    values ('00000000-0000-4000-8000-000000000000', 'confirmed_order',
            'a0000000-0000-4000-8000-00000000000a', 1,
            '22222222-2222-4222-8222-222222222222');
  exception when insufficient_privilege then v_failed := true;
            get stacked diagnostics v_msg = message_text;
  end;
  if not v_failed then raise exception '2b: a direct INSERT as authenticated must be refused'; end if;

  v_failed := false;
  begin
    update public.finance_payment_allocation_intents set intended_amount = 1;
  exception when insufficient_privilege then v_failed := true; end;
  if not v_failed then raise exception '2b: a direct UPDATE as authenticated must be refused'; end if;

  v_failed := false;
  begin
    delete from public.finance_payment_allocation_intents;
  exception when insufficient_privilege then v_failed := true; end;
  if not v_failed then raise exception '2b: a direct DELETE as authenticated must be refused'; end if;

  reset role;
  raise notice '2b. WRITE IN FACT — INSERT, UPDATE and DELETE as authenticated are all refused for want of privilege';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. anon holds nothing at all
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare v_priv text;
begin
  foreach v_priv in array array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger'] loop
    if has_table_privilege('anon', 'public.finance_payment_allocation_intents', v_priv) then
      raise exception '3: anon must hold no privilege on the intent table (holds %)', v_priv;
    end if;
  end loop;
  raise notice '3. ANON — no read, no write, nothing';
end $$;

do $$
declare v_failed boolean;
begin
  set local role anon;
  v_failed := false;
  begin
    perform 1 from public.finance_payment_allocation_intents;
  exception when insufficient_privilege then v_failed := true; end;
  reset role;
  if not v_failed then raise exception '3b: a SELECT as anon must be refused'; end if;
  raise notice '3b. ANON IN FACT — even a bare SELECT is refused for want of privilege';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4 + 6. The doors still open, and the workflow still works
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Closing the table must not close the RPCs that write it. Called AS
-- authenticated, so the EXECUTE grant is exercised rather than assumed, and the
-- rows they create are proof that a SECURITY DEFINER function still reaches a
-- table its caller cannot touch.
-- THE CALL IS MADE AS authenticated; THE VERIFICATION IS NOT.
--
-- Reading the result back under `set role authenticated` would be answering a
-- different question — RLS, not privilege — and this fixture cannot answer that
-- one honestly (see §8). So the role is reset before anything is inspected, and
-- the assertions below read as the owner, like every other suite here.
do $$
declare v_res jsonb;
begin
  set local role authenticated;
  perform pg_temp.act_as('22222222-2222-4222-8222-222222222222');

  v_res := public.submit_payment_request(
    p_destination => 'pi_draft',
    p_target_id   => 'd0000000-0000-4000-8000-00000000000d',
    p_amount      => 25000, p_payment_date => current_date, p_payment_mode => 'upi');

  reset role;

  if v_res is null or (v_res->>'payment_request_id') is null then
    raise exception '4: submit_payment_request must be callable by authenticated';
  end if;
  perform set_config('pg_temp.the_payment', v_res->>'payment_request_id', true);
end $$;

do $$
declare
  v_res jsonb; v_pay uuid;
  v_intent public.finance_payment_allocation_intents%rowtype;
  v_n int; v_client text;
begin
  v_pay := current_setting('pg_temp.the_payment')::uuid;

  -- The submission wrote a row its caller cannot write directly.
  select * into v_intent from public.finance_payment_allocation_intents
   where payment_request_id = v_pay and status = 'pending';
  if not found then raise exception '6: the submission must have written an intent'; end if;
  if v_intent.order_submission_id <> 'd0000000-0000-4000-8000-00000000000d' then
    raise exception '6: the intent must name the PI that was submitted against';
  end if;

  set local role authenticated;
  perform pg_temp.act_as('22222222-2222-4222-8222-222222222222');
  v_res := public.edit_payment_request(
    p_payment_request_id => v_pay,
    p_destination => 'confirmed_order',
    p_target_id   => 'b0000000-0000-4000-8000-00000000000b',
    p_amount      => 25000, p_payment_date => current_date, p_payment_mode => 'upi');
  reset role;

  if v_res is null then raise exception '4: edit_payment_request must be callable by authenticated'; end if;

  select * into v_intent from public.finance_payment_allocation_intents
   where payment_request_id = v_pay and status = 'pending';
  if not found then raise exception '6: the correction must leave a pending intent'; end if;
  if v_intent.order_id <> 'b0000000-0000-4000-8000-00000000000b' then
    raise exception '6: the correction must have moved the intent to the Order';
  end if;

  select count(*) into v_n from public.finance_payment_allocation_intents
   where payment_request_id = v_pay and status = 'pending';
  if v_n <> 1 then raise exception '6: exactly one pending intent after the correction, got %', v_n; end if;

  -- …and the customer came from the record, not from the caller.
  select client_name into v_client from public.finance_payment_requests where id = v_pay;
  if v_client <> 'Menon Builders' then
    raise exception '6: the customer must be derived server-side, got %', coalesce(v_client, '(null)');
  end if;

  raise notice '4+6. THE DOORS — submit and edit are callable by authenticated, and they write what the caller cannot';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. The conversion is callable by nobody
-- ═══════════════════════════════════════════════════════════════════════════
--
-- apply_payment_allocation_intents turns unverified money into an allocation.
-- Approval calls it; a client may not, and neither may anon or the PUBLIC
-- pseudo-role — which for FUNCTIONS holds EXECUTE by default in PostgreSQL
-- itself, quite apart from anything Supabase does.
do $$
declare v_failed boolean; v_role text;
begin
  foreach v_role in array array['authenticated', 'anon', 'public'] loop
    if has_function_privilege(v_role, 'public.apply_payment_allocation_intents(uuid)', 'execute') then
      raise exception '5: % must not be able to convert an intent directly', v_role;
    end if;
  end loop;

  set local role authenticated;
  v_failed := false;
  begin
    perform public.apply_payment_allocation_intents('00000000-0000-4000-8000-000000000000');
  exception when insufficient_privilege then v_failed := true; end;
  reset role;
  if not v_failed then
    raise exception '5b: calling the conversion as authenticated must be refused for want of privilege';
  end if;

  -- The trigger functions are closed too. PostgreSQL refuses to call one
  -- outside a trigger regardless, so this is belt as well as braces — but a
  -- project's `grant all on functions` default leaves them reachable on paper,
  -- and 20260918000000 revoked every one of its own for exactly that reason.
  foreach v_role in array array['authenticated', 'anon', 'public'] loop
    if has_function_privilege(v_role,
         'public.finance_payment_allocation_intents_enforce_capacity()', 'execute')
       or has_function_privilege(v_role,
         'public.finance_payment_requests_cancel_intents_on_reject()', 'execute') then
      raise exception '5: % must not hold EXECUTE on a trigger function', v_role;
    end if;
  end loop;

  -- Approval, which is the one caller, still reaches it.
  if not has_function_privilege('authenticated',
        'public.approve_finance_payment_request(uuid, text)', 'execute') then
    raise exception '5c: approval must remain callable — it is what converts intents';
  end if;

  raise notice '5. THE CONVERSION — no client role may call it, and approval still can';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. And approval — the internal conversion — still works end to end
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare v_res jsonb; v_pay uuid; v_allocs int; v_pending int;
begin
  set local role authenticated;
  perform pg_temp.act_as('22222222-2222-4222-8222-222222222222');
  v_res := public.submit_payment_request(
    p_destination => 'confirmed_order',
    p_target_id   => 'a0000000-0000-4000-8000-00000000000a',
    p_amount      => 60000, p_payment_date => current_date, p_payment_mode => 'bank_transfer');
  v_pay := (v_res->>'payment_request_id')::uuid;

  perform pg_temp.act_as('11111111-1111-4111-8111-111111111111');
  v_res := public.approve_finance_payment_request(v_pay, null);
  reset role;

  if v_pay is null then raise exception '7: the submission must have returned a payment'; end if;
  if (v_res->>'allocations_applied')::int <> 1 then
    raise exception '7: approval must convert the intent, got %', v_res->>'allocations_applied';
  end if;
  select count(*) into v_allocs from public.finance_payment_allocations
   where payment_request_id = v_pay and status = 'active';
  select count(*) into v_pending from public.finance_payment_allocation_intents
   where payment_request_id = v_pay and status = 'pending';
  if v_allocs <> 1 or v_pending <> 0 then
    raise exception '7: expected one active allocation and no pending intent, got % and %', v_allocs, v_pending;
  end if;

  raise notice '7. APPROVAL — the internal conversion still runs, and still converts exactly once';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. The read policy is anchored to the payment's own visibility
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS FIXTURE CANNOT ANSWER, STATED PLAINLY. The shaped schema enables RLS
-- on finance_payment_requests and creates NONE of the policies production has,
-- so under `set role authenticated` that table denies everything — and with it,
-- through the anchor, every intent. That is a property of the fixture, not of
-- the migration, and an assertion that read intents as `authenticated` here
-- would be measuring the gap rather than the policy.
--
-- WHAT IT CAN ANSWER, and does: the SHAPE of the anchor. A minimal stand-in for
-- the payment table's own ownership policy is created for the length of this
-- block, and the intent policy is then shown to follow it in both directions —
-- a payment you can see yields an intent you can see, and one you cannot see
-- yields nothing. That is the whole claim the policy makes: it grants no sight
-- of its own.
do $$
declare v_mine uuid; v_theirs uuid; v_seen int;
begin
  select id into v_mine from public.finance_payment_requests
   where submitted_by = '22222222-2222-4222-8222-222222222222'
     and exists (select 1 from public.finance_payment_allocation_intents i
                  where i.payment_request_id = finance_payment_requests.id)
   order by created_at limit 1;
  if v_mine is null then raise exception '8: expected a payment with an intent from the earlier sections'; end if;

  -- A second payment, submitted by somebody else, also carrying an intent.
  insert into public.finance_payment_requests
    (client_name, amount, payment_date, payment_mode, status, submitted_by)
  values ('Kalyan Interiors', 5000, current_date, 'upi', 'pending_approval',
          '11111111-1111-4111-8111-111111111111')
  returning id into v_theirs;
  insert into public.finance_payment_allocation_intents
    (payment_request_id, target_type, order_id, intended_amount, created_by)
  values (v_theirs, 'confirmed_order', 'a0000000-0000-4000-8000-00000000000a', 5000,
          '11111111-1111-4111-8111-111111111111');

  -- The stand-in: you see the payments you submitted, and no others.
  create policy pg_temp_own_payments on public.finance_payment_requests
    for select to authenticated
    using (submitted_by = auth.uid());

  set local role authenticated;
  perform pg_temp.act_as('22222222-2222-4222-8222-222222222222');

  select count(*) into v_seen from public.finance_payment_allocation_intents
   where payment_request_id = v_mine;
  if v_seen = 0 then
    raise exception '8: an intent on a payment the caller CAN see must be readable';
  end if;

  select count(*) into v_seen from public.finance_payment_allocation_intents
   where payment_request_id = v_theirs;
  if v_seen <> 0 then
    raise exception '8: an intent on a payment the caller CANNOT see must not be readable, saw %', v_seen;
  end if;

  reset role;
  drop policy pg_temp_own_payments on public.finance_payment_requests;

  raise notice '8. THE ANCHOR — an intent is visible exactly when its payment is, and never on its own';
end $$;

rollback;

do $$ begin raise notice 'ALL PRIVILEGE ASSERTIONS PASSED'; end $$;
