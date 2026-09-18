-- Shaped schema for run_schedule_terms_amendment_suite.sh (20261217000000).
--
-- The smallest database in which update_order_submission_schedule_terms() meets
-- the REAL Order column guard:
--
--   * public.orders with every column orders_guard_amendable_columns() reads;
--   * public.order_submissions with every column the function reads or writes;
--   * public.order_activity_log, which the function inserts into.
--
-- The runner installs the DEPLOYED bodies of in_order_amendment(),
-- in_production_alignment() and orders_guard_amendable_columns() (extracted
-- from their migrations) and the BEFORE UPDATE trigger that binds the guard.
-- Only the helpers the guard never sees are stubbed here: the two edit
-- permission checks (the admin may edit), supersede_order_documents() (no
-- documents) and log_order_submission_activity() (records its call).
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

create table public.orders (
  id                        uuid primary key,
  display_number            text,
  client_name               text,
  requested_by              uuid,
  assigned_to               uuid,
  confirm_date              date,
  due_date                  date,
  total_value               numeric,
  total_product_value       numeric,
  lead_source               text,
  notes                     text,
  created_by                uuid,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz,
  production_alignment      text default 'not_aligned',
  production_aligned_by     uuid,
  production_aligned_at     timestamptz,
  production_alignment_note text
);

create table public.order_submissions (
  id                      uuid primary key,
  status                  text not null,
  order_id                uuid references public.orders(id),
  row_version             integer not null default 1,
  order_confirmation_date date,
  due_date                date,
  dispatch_commitment     text,
  payment_terms           text,
  billing_terms           text,
  updated_at              timestamptz
);

create table public.order_activity_log (
  id         bigserial primary key,
  order_id   uuid not null,
  actor_id   uuid,
  event_type text not null,
  payload    jsonb
);

create table public.test_submission_activity_calls (action text, reason text);

-- ── Stubs for what the guard never sees ─────────────────────────────────────
create or replace function public.can_admin_edit_order_submission(p_submission_id uuid)
returns boolean language sql stable as $$ select true $$;
create or replace function public.can_edit_order_submission(p_submission_id uuid)
returns boolean language sql stable as $$ select false $$;
create or replace function public.supersede_order_documents(p_order_id uuid, p_reason text)
returns integer language sql as $$ select 0 $$;
create or replace function public.log_order_submission_activity(
  p_submission_id uuid, p_actor uuid, p_action text, p_from text, p_to text, p_reason text, p_payload jsonb)
returns void language sql as $$
  insert into public.test_submission_activity_calls values (p_action, p_reason)
$$;

grant select, insert, update on all tables in schema public to authenticated;
grant usage on all sequences in schema public to authenticated;
