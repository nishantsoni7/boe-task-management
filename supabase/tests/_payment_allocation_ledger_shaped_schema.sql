-- Shaped schema for run_payment_allocation_ledger_suite.sh (20261215000000).
--
-- The smallest database that has the SAME shape as production where the
-- Correct Allocation read is decided:
--
--   * public.finance_payment_requests and public.finance_payment_allocations,
--     with the SELECT policies that are LIVE on production for both (replayed
--     from the migrations that created them — names and predicates verbatim),
--     including the per-row participant policies that cause the defect;
--   * the tables those policies and the new RPC read: users, orders,
--     order_submissions, order_requests.
--
-- The permission engine is reduced to a grants table behind resolve_permission,
-- and the two Orders visibility predicates (can_view_order_submission,
-- can_view_order_as_actor) to "is this target in the caller's visible set" —
-- the only question the policies ask of them. module_entry_open,
-- actor_has_permission, actor_has_module_permission and
-- can_read_payment_as_participant are NOT stubbed: the runner installs their
-- deployed bodies, extracted from the migrations that define them.
--
-- A disposable database only. It never talks to a linked project.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon')          then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role')  then create role service_role nologin bypassrls; end if;
end $$;

create schema if not exists auth;
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

-- ── The people ──────────────────────────────────────────────────────────────
create table public.users (
  id         uuid primary key,
  full_name  text,
  role       text not null default 'employee',
  is_active  boolean not null default true,
  is_deleted boolean default false
);

-- ── The permission engine, reduced to its answer ────────────────────────────
create table public.test_permission_grants (
  user_id    uuid not null,
  module_key text not null,
  action_key text not null,
  primary key (user_id, module_key, action_key)
);

create or replace function public.resolve_permission(p_user_id uuid, p_module_key text, p_action_key text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.test_permission_grants g
    where g.user_id = p_user_id and g.module_key = p_module_key and g.action_key = p_action_key)
$$;

-- ── Which Orders / PI Drafts each person may open ───────────────────────────
create table public.test_visible_orders      (user_id uuid, order_id uuid);
create table public.test_visible_submissions (user_id uuid, submission_id uuid);

create or replace function public.can_view_order_as_actor(p_order_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.test_visible_orders v where v.user_id = auth.uid() and v.order_id = p_order_id)
$$;
create or replace function public.can_view_order_submission(p_submission_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.test_visible_submissions v where v.user_id = auth.uid() and v.submission_id = p_submission_id)
$$;
grant execute on function public.can_view_order_as_actor(uuid), public.can_view_order_submission(uuid) to authenticated;

-- ── The records ─────────────────────────────────────────────────────────────
create table public.orders (
  id             uuid primary key,
  display_number text,
  client_name    text
);
create table public.order_submissions (
  id                   uuid primary key,
  source_order_number  text,
  source_workbook_name text,
  client_name          text
);
create table public.order_requests (
  id                 uuid primary key,
  created_by         uuid,
  requested_by       uuid,
  assigned_to        uuid,
  converted_order_id uuid
);
create table public.finance_payment_requests (
  id               uuid primary key,
  request_number   text,
  amount           numeric(14,2) not null,
  status           text not null,
  submitted_by     uuid not null,
  order_id         uuid,
  order_request_id uuid,
  client_name      text
);
create table public.finance_payment_allocations (
  id                  uuid primary key,
  payment_request_id  uuid not null references public.finance_payment_requests(id),
  order_submission_id uuid references public.order_submissions(id),
  order_id            uuid references public.orders(id),
  allocated_amount    numeric(14,2) not null,
  status              text not null default 'active',
  created_at          timestamptz not null default now(),
  created_by          uuid not null references public.users(id),
  reversed_by         uuid references public.users(id),
  reversed_at         timestamptz,
  reversal_reason     text
);

grant select on public.users, public.orders, public.order_submissions, public.order_requests,
                public.finance_payment_requests, public.finance_payment_allocations
  to authenticated;

-- ── The LIVE SELECT policies, replayed verbatim ─────────────────────────────
alter table public.finance_payment_requests    enable row level security;
alter table public.finance_payment_allocations enable row level security;

-- finance_payment_requests (20260628000200, 20260699, 20260707, 20260903, 20260919)
create policy finance_payment_requests_own_select on public.finance_payment_requests
  for select to authenticated using (submitted_by = auth.uid());
create policy finance_payment_requests_admin_select on public.finance_payment_requests
  for select to authenticated using (exists (select 1 from public.users where users.id = auth.uid() and users.role = 'admin'));
create policy finance_payment_requests_order_request_owner_select on public.finance_payment_requests
  for select to authenticated using (
    (finance_payment_requests.order_request_id is not null and exists (select 1 from public.order_requests r where r.id = finance_payment_requests.order_request_id and (r.created_by = auth.uid() or r.requested_by = auth.uid())))
    or (finance_payment_requests.order_id is not null and exists (select 1 from public.order_requests r where r.converted_order_id = finance_payment_requests.order_id and (r.created_by = auth.uid() or r.requested_by = auth.uid()))));
create policy finance_payment_requests_order_request_assignee_select on public.finance_payment_requests
  for select to authenticated using (
    (finance_payment_requests.order_request_id is not null and exists (select 1 from public.order_requests r where r.id = finance_payment_requests.order_request_id and r.assigned_to = auth.uid()))
    or (finance_payment_requests.order_id is not null and exists (select 1 from public.order_requests r where r.converted_order_id = finance_payment_requests.order_id and r.assigned_to = auth.uid())));
create policy finance_payment_requests_view_all_select on public.finance_payment_requests
  for select to authenticated using (resolve_permission(auth.uid(), 'finance', 'view_all'));
-- participant_select and the RESTRICTIVE module gate are created by the runner,
-- after can_read_payment_as_participant / module_entry_open are installed.

-- finance_payment_allocations (20260918000000) — per-row participant policies.
create policy finance_payment_allocations_admin_select on public.finance_payment_allocations
  for select to authenticated using (exists (select 1 from public.users where users.id = auth.uid() and users.role = 'admin'));
create policy finance_payment_allocations_view_all_select on public.finance_payment_allocations
  for select to authenticated using (resolve_permission(auth.uid(), 'finance', 'view_all'));
create policy finance_payment_allocations_payment_owner_select on public.finance_payment_allocations
  for select to authenticated using (exists (select 1 from public.finance_payment_requests r where r.id = finance_payment_allocations.payment_request_id and r.submitted_by = auth.uid()));
-- Live form: `order_id is not null and exists (select 1 from public.orders o
-- where o.id = order_id)`, which inherits the orders table's own RLS. This
-- harness has no orders RLS, so the same question — can the caller open that
-- Order — is asked through the visibility stub instead.
create policy finance_payment_allocations_order_participant_select on public.finance_payment_allocations
  for select to authenticated using (finance_payment_allocations.order_id is not null and public.can_view_order_as_actor(finance_payment_allocations.order_id));
