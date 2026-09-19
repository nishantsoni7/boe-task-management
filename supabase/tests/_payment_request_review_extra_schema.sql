-- TEST-ONLY. Brings the shaped Orders/Finance schema (the chain
-- run_payment_entry_edit_race.sh builds through 20261014000000) up to
-- PRODUCTION'S shape for everything the Finance review modal's two decisions
-- touch, so that 20261211000000 (the decision guard + rejection RPC) and
-- 20261220000000 (the clarification RPC) can be applied and EXECUTED on top.
-- run_payment_request_review_suite.sh appends the deployed function bodies it
-- needs, extracted verbatim from their own migrations.
--
-- Every addition below exists in production; the source is named on each line.

-- Columns the decision guard and the activity trigger read.
alter table public.finance_payment_requests
  add column if not exists rejected_at                timestamptz,   -- 20260678
  add column if not exists clarification_requested_at timestamptz;   -- 20260678

alter table public.finance_payment_request_activity_log
  add column if not exists actor_id   uuid,                                  -- 20260675
  add column if not exists payload    jsonb not null default '{}'::jsonb,    -- 20260675
  add column if not exists created_at timestamptz not null default now();    -- 20260675

-- actor_has_permission(), which the production UPDATE policies call. The same
-- grants-table stand-in as actor_has_module_permission() in
-- _admin_payment_deletion_and_payment_id_extra_schema.sql.
create or replace function public.actor_has_permission(p_module text, p_action text)
returns boolean
language sql stable
as $$ select public.actor_has_module_permission(p_module, p_action) $$;

-- The approval RPC's marker (20261118000000). 20261211000000 refuses to apply
-- without it. The shaped stand-in approval is re-emitted below with the one
-- set_config the real body carries around its UPDATE.
create or replace function public.approve_finance_payment_request(
  p_request_id uuid,
  p_admin_note text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_actor  uuid := auth.uid();
  v_req    public.finance_payment_requests%rowtype;
  v_status text;
  v_now    timestamptz := now();
begin
  if v_actor is null then
    raise exception 'Authentication required to approve a payment request' using errcode = '28000';
  end if;
  if not public.actor_has_module_permission('finance', 'approve') then
    raise exception 'Only an admin may approve a payment request' using errcode = '42501';
  end if;
  select * into v_req from public.finance_payment_requests where id = p_request_id for update;
  if not found then
    raise exception 'Payment request % not found', p_request_id using errcode = 'P0002';
  end if;
  if v_req.status <> 'pending_approval' then
    raise exception 'Only a pending payment request can be approved (% is %)',
      v_req.request_number, v_req.status using errcode = 'P0001';
  end if;
  v_status := case when v_req.payment_target_type = 'confirmed_order'
                   then 'approved_linked' else 'approved_unlinked' end;
  perform set_config('boe.finance_payment_verification', p_request_id::text, true);
  update public.finance_payment_requests
     set status = v_status, approved_by = v_actor, approved_at = v_now,
         admin_note = p_admin_note, updated_at = v_now
   where id = p_request_id;
  perform set_config('boe.finance_payment_verification', '', true);
  return jsonb_build_object('request_id', v_req.id, 'request_number', v_req.request_number, 'status', v_status);
end $$;
revoke execute on function public.approve_finance_payment_request(uuid, text) from public, anon;
grant  execute on function public.approve_finance_payment_request(uuid, text) to authenticated;

-- 20261211000000 re-creates reject_finance_payment_request(uuid, text) with a
-- jsonb result; the shaped stand-in returns void, which CREATE OR REPLACE cannot
-- change. Production has only the jsonb one.
drop function if exists public.reject_finance_payment_request(uuid, text);

-- THE TABLE AS A CLIENT SEES IT IN PRODUCTION. Supabase's default privileges
-- grant the table to authenticated; the four UPDATE policies are the deployed
-- set (20260628000200, 20260695000000, 20260901000000 ×2) that 20261211000000
-- asserts is exactly four. The SELECT policies stand in for Finance's read
-- rules: the submitter sees their own, a Finance holder sees all.
grant select, insert, update, delete on public.finance_payment_requests to authenticated;

drop policy if exists "finance_payment_requests_own_select" on public.finance_payment_requests;
create policy "finance_payment_requests_own_select" on public.finance_payment_requests
  for select to authenticated using (submitted_by = auth.uid());
drop policy if exists "finance_payment_requests_finance_select" on public.finance_payment_requests;
create policy "finance_payment_requests_finance_select" on public.finance_payment_requests
  for select to authenticated using (public.actor_has_permission('finance', 'view_all'));

drop policy if exists "finance_payment_requests_admin_update" on public.finance_payment_requests;
create policy "finance_payment_requests_admin_update" on public.finance_payment_requests
  for update to authenticated
  using (exists (select 1 from public.users where users.id = auth.uid() and users.role = 'admin'))
  with check (exists (select 1 from public.users where users.id = auth.uid() and users.role = 'admin'));
drop policy if exists "finance_payment_requests_own_update" on public.finance_payment_requests;
create policy "finance_payment_requests_own_update" on public.finance_payment_requests
  for update to authenticated
  using (submitted_by = auth.uid() and status in ('pending_approval', 'needs_clarification', 'rejected'))
  with check (submitted_by = auth.uid() and status in ('pending_approval', 'needs_clarification'));
drop policy if exists "finance_payment_requests_approver_decide" on public.finance_payment_requests;
create policy "finance_payment_requests_approver_decide" on public.finance_payment_requests
  for update to authenticated
  using (status = 'pending_approval' and public.actor_has_permission('finance', 'approve'))
  with check (status in ('rejected', 'needs_clarification'));
drop policy if exists "finance_payment_requests_manager_correct" on public.finance_payment_requests;
create policy "finance_payment_requests_manager_correct" on public.finance_payment_requests
  for update to authenticated
  using (status in ('approved_linked', 'approved_unlinked') and public.actor_has_permission('finance', 'manage'))
  with check (status in ('approved_linked', 'approved_unlinked'));

-- The same for two sibling tables the reset guard also sits on, so the
-- reproduction can show the refusal is the guard's and not RLS's: the policy
-- ADMITS the write, and it still fails. (Production's own policies on these
-- tables are narrower; any write they admit meets the same guard.)
grant select, insert on public.payment_proof_attachments to authenticated;
alter table public.payment_proof_attachments enable row level security;
drop policy if exists "harness_proof_insert" on public.payment_proof_attachments;
create policy "harness_proof_insert" on public.payment_proof_attachments
  for insert to authenticated with check (true);

grant select, update on public.orders to authenticated;
alter table public.orders enable row level security;
drop policy if exists "harness_orders_rw" on public.orders;
create policy "harness_orders_rw" on public.orders
  for all to authenticated using (true) with check (true);

-- PRODUCTION'S FUNCTION PRIVILEGES for the reset write guard (read-only catalog
-- check, 2026-09-19): authenticated holds EXECUTE on neither
-- in_test_data_cleanup() nor open_order_finance_reset_scope(), and the guard
-- is not SECURITY DEFINER.
revoke execute on function public.in_test_data_cleanup() from public, anon, authenticated;
revoke execute on function public.open_order_finance_reset_scope() from public, anon, authenticated;

-- A helper the SQL files call to run one statement AS the current role and
-- report how it ended, without aborting the surrounding transaction. Not
-- security definer: it runs as whoever calls it, which is the point.
create schema if not exists harness;
grant usage on schema harness to authenticated, anon;
create or replace function harness.try(p_sql text)
returns text
language plpgsql
as $$
begin
  execute p_sql;
  return 'OK';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
grant execute on function harness.try(text) to authenticated, anon;

-- Switch the session's auth.uid() for the rest of the transaction.
create or replace function harness.as_user(p_uid uuid) returns void language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
$$;
grant execute on function harness.as_user(uuid) to authenticated, anon;

-- Supabase grants the client roles usage on the auth schema, so auth.uid()
-- resolves inside a policy or an invoker-rights function.
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;

-- The policies read public.users (the admin check) and the permission stand-in
-- reads its grants table as the caller. Production's users table grants these
-- columns to authenticated; its permission resolver is security definer. Both
-- are read-only here.
grant select (id, role, is_active, is_deleted) on public.users to authenticated;
grant select on public.finance_permission_grants to authenticated;
