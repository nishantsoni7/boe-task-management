-- ═════════════════════════════════════════════════════════════════════════════
-- A PRODUCTION-SHAPED NUMBERING AND PAYMENT-ENTRY SCHEMA, for 20261009000000
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WHY THIS EXISTS. 20261009000000 replaces four applied functions
-- (allocate_confirmed_order_number, set_next_confirmed_order_number,
-- assign_order_display_number, approve_order_submission, reset_confirmed_order_
-- number_cycle) and adds two. Reading the text proves nothing about the two
-- properties the feature stands on — that two callers cannot take the same
-- number, and that the Order comes out carrying the number its PI was promised.
-- Only running it does, and only with real locks and real concurrent sessions.
--
-- WHAT IS FAITHFUL, BECAUSE THE TEST IS ABOUT IT
-- ----------------------------------------------
--   * order_number_cycle, its singleton row, and the FOR UPDATE contract.
--   * allocate_confirmed_order_number and set_next_confirmed_order_number in
--     their 20260704000000 form, and assign_order_display_number in its
--     20260703000000 form, applied here FIRST — so the migration is seen to
--     replace the deployed bodies rather than to install into a vacuum.
--   * orders.display_number: text, NOT NULL, UNIQUE, four-digit CHECK, assigned
--     only by the BEFORE INSERT trigger, immutable afterwards.
--   * orders.source_order_submission_id and its partial UNIQUE index — the
--     structural reason one reservation can produce only one Order.
--   * in_pi_submission_approval(), the transaction-local approval marker.
--   * order_submission_activity and its CLOSED action check.
--   * finance_payment_requests / finance_payment_allocations with the capacity
--     rule, the one-target rule and the per-target uniqueness the real tables
--     carry, and allocate_payment_to_target_internal reduced to its refusals.
--   * No client-role INSERT/UPDATE grant on order_submissions, so every write
--     goes through a SECURITY DEFINER function, exactly as in production.
--
-- WHAT IS STUBBED, AND WHY THAT IS HONEST
-- ---------------------------------------
--   * auth.uid() reads a session GUC, which is how every one of these suites
--     impersonates a caller.
--   * resolve_permission / actor_has_module_permission / module_entry_open are
--     backed by a plain grants table. The migration asks them questions; it does
--     not implement them, and the real ones are proved elsewhere.
--   * The parts of approve_order_submission this migration does not touch — the
--     finance-verification test, the payment routes, the exception currency, the
--     item and image invariants, the storage probe — are modelled by helpers
--     that answer the same shape. This suite is about the reservation clause and
--     the number the Order comes out with; the payment gate has its own suite.
--   * RLS is not enabled. Every function under test is SECURITY DEFINER and
--     decides its own authorization in its body, which is what is being tested.
-- ═════════════════════════════════════════════════════════════════════════════

-- The two client roles, FIRST: every revoke below names them, and a revoke on a
-- role that does not exist is an error rather than a no-op.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
end $$;

create schema if not exists auth;
create schema if not exists storage;
grant usage on schema public to authenticated, anon;
create extension if not exists pgcrypto;

-- ── The caller ───────────────────────────────────────────────────────────────
create table public.users (
  id         uuid primary key default gen_random_uuid(),
  email      text,
  role       text not null default 'employee',
  team       text,
  is_active  boolean not null default true,
  is_deleted boolean not null default false
);

create or replace function auth.uid()
returns uuid language sql stable as $$
  select nullif(current_setting('boe.test_actor', true), '')::uuid
$$;

-- ── Permissions, as a grants table ───────────────────────────────────────────
create table public.test_grants (
  user_id uuid not null references public.users(id),
  module  text not null,
  action  text not null,
  primary key (user_id, module, action)
);

create or replace function public.resolve_permission(p_user uuid, p_module text, p_action text)
returns boolean language sql stable as $$
  select exists (select 1 from public.test_grants g
                 where g.user_id = p_user and g.module = p_module and g.action = p_action)
$$;

create or replace function public.actor_has_module_permission(p_module text, p_action text)
returns boolean language sql stable as $$
  select exists (
    select 1 from public.users u
    where u.id = auth.uid() and u.is_active and not u.is_deleted
      and (u.role = 'admin' or public.resolve_permission(u.id, p_module, p_action))
  )
$$;

-- Module entry: admin, or any grant at all in that module.
create or replace function public.module_entry_open(p_module text)
returns boolean language sql stable as $$
  select exists (
    select 1 from public.users u
    where u.id = auth.uid() and u.is_active and not u.is_deleted
      and (u.role = 'admin'
           or exists (select 1 from public.test_grants g
                      where g.user_id = u.id and g.module = p_module))
  )
$$;

-- ── The numbering cycle ──────────────────────────────────────────────────────
create table public.order_number_cycle (
  id            boolean primary key default true check (id),
  next_number   bigint not null default 1 check (next_number > 0),
  configured_at timestamptz not null default now(),
  configured_by uuid references public.users(id)
);
insert into public.order_number_cycle (id, next_number) values (true, 1);

create table public.test_data_cleanup_claims (
  id            uuid primary key default gen_random_uuid(),
  claim_token   uuid not null unique default gen_random_uuid(),
  root_type     text not null default 'order',
  storage_prefix text,
  finalized_at  timestamptz
);

create table public.order_number_cycle_resets (
  id                 uuid primary key default gen_random_uuid(),
  performed_by       uuid references public.users(id) on delete set null,
  performed_by_email text,
  performed_at       timestamptz not null default now(),
  claim_id           uuid references public.test_data_cleanup_claims(id) on delete set null,
  previous_number    bigint not null,
  new_number         bigint not null,
  evidence           jsonb not null default '{}'::jsonb
);

-- ── PI submissions ───────────────────────────────────────────────────────────
create table public.order_submissions (
  id                     uuid primary key default gen_random_uuid(),
  status                 text not null default 'draft'
                           check (status in ('draft','submitted','needs_changes','rejected','approved')),
  submitted_by           uuid not null references public.users(id),
  created_by             uuid not null references public.users(id),
  assigned_to            uuid references public.users(id),
  approved_by            uuid references public.users(id),
  approved_at            timestamptz,
  client_name            text,
  order_confirmation_date date,
  due_date               date,
  grand_total            numeric(12,2),
  gross_product_amount   numeric(12,2) not null default 0,
  billing_percentage     numeric(5,2),
  source_workbook_path   text,
  source_workbook_name   text,
  source_workbook_sha256 text,
  -- B20 of the Master sheet, as the ONE parser reads it. In production this is
  -- written by replace_order_submission_parse() and by nothing else, from a
  -- SERVER-SIDE parse of the stored bytes; the stand-in below preserves that
  -- property, because the whole revised-PI rule depends on it.
  source_order_number    text,
  parse_blocking_issues  jsonb not null default '[]'::jsonb,
  deletion_claim_token   uuid,
  advance_exception_status text,
  advance_exception_decided_grand_total numeric(12,2),
  advance_exception_decided_workbook_sha256 text,
  advance_exception_decided_payment_terms text,
  advance_exception_decided_billing_terms text,
  payment_terms          text,
  billing_terms          text,
  finance_verified_at    timestamptz,
  finance_verified_submission_at timestamptz,
  submitted_at           timestamptz,
  order_id               uuid,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create table public.order_submission_items (
  id            uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.order_submissions(id) on delete cascade,
  item_sequence integer,
  product_name  text,
  source_row    integer
);

create table public.order_submission_item_images (
  id            uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.order_submissions(id) on delete cascade,
  item_id       uuid not null references public.order_submission_items(id) on delete cascade,
  role          text not null default 'representative',
  position      integer not null default 1,
  sha256        text not null default repeat('a', 64),
  anchor_row    integer,
  storage_path  text not null
);

create table public.order_submission_activity (
  id              uuid primary key default gen_random_uuid(),
  submission_id   uuid not null references public.order_submissions(id) on delete cascade,
  actor_id        uuid references public.users(id),
  action          text not null,
  previous_status text,
  new_status      text,
  note            text,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

-- The CLOSED set, in its 20261001000000 form. The migration replaces it.
alter table public.order_submission_activity
  add constraint order_submission_activity_action_check
  check (action in (
    'submission_created','parse_replaced','submitted','changes_requested','rejected',
    'advance_exception_requested','advance_exception_approved','advance_exception_rejected',
    'finance_verified','approved','payment_recorded','payment_allocations_moved',
    'billing_percentage_set','billing_percentage_amended_by_admin',
    'client_details_updated','client_details_amended_by_admin',
    'schedule_terms_updated','schedule_terms_amended_by_admin',
    'correction_requested','correction_resolved','correction_rejected',
    'product_details_updated','product_details_amended_by_admin',
    'workbook_replaced_by_admin'
  ));

-- ── Confirmed Orders ─────────────────────────────────────────────────────────
create table public.orders (
  id                        uuid primary key default gen_random_uuid(),
  display_number            text not null unique
                              check (display_number ~ '^[0-9]{4}$' and display_number <> '0000'),
  client_name               text not null,
  requested_by              uuid references public.users(id),
  assigned_to               uuid references public.users(id),
  confirm_date              date,
  due_date                  date,
  total_value               numeric(12,2),
  total_product_value       numeric(12,2),
  billing_percentage        numeric(5,2),
  created_by                uuid references public.users(id),
  status                    text not null default 'running',
  source_order_submission_id uuid references public.order_submissions(id),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create unique index orders_source_order_submission_id_uidx
  on public.orders (source_order_submission_id)
  where source_order_submission_id is not null;

alter table public.order_submissions
  add constraint order_submissions_order_fk foreign key (order_id) references public.orders(id);

create table public.order_activity_log (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null references public.orders(id) on delete cascade,
  actor_id   uuid references public.users(id),
  event_type text not null,
  payload    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- ── Finance ──────────────────────────────────────────────────────────────────
create table public.finance_payment_requests (
  id             uuid primary key default gen_random_uuid(),
  request_number text unique,
  client_name    text not null,
  amount         numeric not null,
  payment_date   date not null,
  payment_mode   text not null check (payment_mode in ('bank_transfer','cash','upi','cheque','other')),
  received_in    text check (received_in in ('company_account','cash_in_hand','savings_account','other')),
  proof_note     text,
  order_number   text,
  sales_note     text,
  order_id       uuid references public.orders(id),
  status         text not null default 'pending_approval'
                   check (status in ('pending_approval','approved_unlinked','approved_linked',
                                     'needs_clarification','rejected')),
  submitted_by   uuid not null references public.users(id),
  created_at     timestamptz not null default now()
);

-- The number trigger the real table carries: a caller can never seed one.
create sequence public.finance_payment_request_seq_test;
create or replace function public.assign_finance_payment_request_number()
returns trigger language plpgsql as $$
begin
  new.request_number := 'PR-' || lpad(nextval('public.finance_payment_request_seq_test')::text, 5, '0');
  return new;
end $$;
create trigger finance_payment_requests_assign_number
  before insert on public.finance_payment_requests
  for each row execute function public.assign_finance_payment_request_number();

create table public.finance_payment_allocations (
  id                 uuid primary key default gen_random_uuid(),
  payment_request_id uuid not null references public.finance_payment_requests(id),
  order_submission_id uuid references public.order_submissions(id),
  order_id           uuid references public.orders(id),
  allocated_amount   numeric not null,
  status             text not null default 'active' check (status in ('active','reversed')),
  origin_target_type text not null check (origin_target_type in ('order_submission','confirmed_order')),
  created_by         uuid not null references public.users(id),
  created_at         timestamptz not null default now(),
  reversed_by        uuid references public.users(id),
  reversed_at        timestamptz,
  reversal_reason    text,
  is_test_data       boolean not null default false,
  constraint finance_payment_allocations_amount_valid check (
    allocated_amount <> 'NaN'::numeric and allocated_amount > 0
    and allocated_amount = round(allocated_amount, 2)),
  constraint finance_payment_allocations_one_target check (
    num_nonnulls(order_submission_id, order_id) = 1)
);

create unique index finance_payment_allocations_one_active_submission_uidx
  on public.finance_payment_allocations (payment_request_id, order_submission_id)
  where status = 'active' and order_submission_id is not null;

create unique index finance_payment_allocations_one_active_order_uidx
  on public.finance_payment_allocations (payment_request_id, order_id)
  where status = 'active' and order_id is not null;

-- The capacity invariant, as a trigger, exactly as 20260918000000 §2 holds it.
create or replace function public.finance_payment_allocation_capacity()
returns trigger language plpgsql as $$
declare v_amount numeric; v_active numeric;
begin
  select amount into v_amount from public.finance_payment_requests
   where id = new.payment_request_id for update;
  select coalesce(sum(allocated_amount), 0) into v_active
    from public.finance_payment_allocations
   where payment_request_id = new.payment_request_id and status = 'active' and id <> new.id;
  if new.status = 'active' and v_active + new.allocated_amount > v_amount then
    raise exception 'ALLOCATION_EXCEEDS_PAYMENT: capacity exceeded' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger finance_payment_allocations_capacity
  before insert or update on public.finance_payment_allocations
  for each row execute function public.finance_payment_allocation_capacity();

-- ── Storage, only far enough for the workbook probe ──────────────────────────
create table storage.objects (
  bucket_id text not null,
  name      text not null,
  metadata  jsonb not null default '{}'::jsonb,
  primary key (bucket_id, name)
);

-- ═════════════════════════════════════════════════════════════════════════════
-- The deployed functions, in their pre-20261009000000 form
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Installed FIRST and verbatim where they matter, so the migration is seen to
-- REPLACE a live body rather than to create one. A suite that installed only the
-- new versions would prove nothing about the replacement.

create or replace function public.format_confirmed_order_number(p_number bigint)
returns text language sql immutable set search_path = public as $$
  select case when p_number is null or p_number < 1 or p_number > 9999
              then null else lpad(p_number::text, 4, '0') end;
$$;

-- 20260704000000 §5, verbatim.
create or replace function public.allocate_confirmed_order_number()
returns text language plpgsql security definer set search_path = public as $$
declare v_next bigint; v_highest bigint; v_number text;
begin
  select c.next_number into v_next from public.order_number_cycle c where c.id = true for update;
  if not found then
    raise exception 'ORDER_NUMBER_CYCLE_MISSING: Confirmed Order numbering is not configured' using errcode = 'P0001';
  end if;
  if v_next is null or v_next <= 0 then
    raise exception 'ORDER_NUMBER_CYCLE_INVALID: The configured next Order number is not a valid positive number' using errcode = 'P0001';
  end if;
  if v_next > 9999 then
    raise exception 'ORDER_NUMBER_CYCLE_EXHAUSTED: Confirmed Order numbers are limited to 9999 and that limit has been reached' using errcode = 'P0001';
  end if;
  select coalesce(max(o.display_number::bigint), 0) into v_highest
  from public.orders o where o.display_number ~ '^[0-9]+$';
  if v_next <= v_highest then
    raise exception 'ORDER_NUMBER_CYCLE_BEHIND: The configured next Order number (%) is not above the highest existing Order number (%)',
      public.format_confirmed_order_number(v_next), public.format_confirmed_order_number(v_highest) using errcode = 'P0001';
  end if;
  v_number := public.format_confirmed_order_number(v_next);
  if exists (select 1 from public.orders o where o.display_number = v_number) then
    raise exception 'ORDER_NUMBER_IN_USE: Order number % is already in use', v_number using errcode = 'P0001';
  end if;
  update public.order_number_cycle set next_number = v_next + 1 where id = true;
  return v_number;
end $$;

revoke execute on function public.allocate_confirmed_order_number() from public;

-- 20260703000000 §7, verbatim: unconditional, so a caller can never seed one.
create or replace function public.assign_order_display_number()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.display_number := public.allocate_confirmed_order_number();
  return new;
end $$;

create trigger orders_assign_display_number
  before insert on public.orders
  for each row execute function public.assign_order_display_number();

-- 20260703000000 §8: an existing Order number is immutable.
create or replace function public.prevent_order_display_number_change()
returns trigger language plpgsql as $$
begin
  if new.display_number is distinct from old.display_number then
    raise exception 'ORDER_NUMBER_IMMUTABLE: an Order number cannot be changed' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger orders_protect_display_number
  before update on public.orders
  for each row execute function public.prevent_order_display_number_change();

-- 20260915000000 §2: provenance is write-once.
create or replace function public.prevent_order_source_submission_change()
returns trigger language plpgsql as $$
begin
  if old.source_order_submission_id is not null
     and new.source_order_submission_id is distinct from old.source_order_submission_id then
    raise exception 'ORDER_SOURCE_SUBMISSION_IMMUTABLE' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger orders_protect_source_submission
  before update on public.orders
  for each row execute function public.prevent_order_source_submission_change();

-- 20260915000000 §3: the transaction-local approval marker.
create or replace function public.in_pi_submission_approval(p_submission_id uuid)
returns boolean language plpgsql stable set search_path = public, pg_temp as $$
declare v_marker text := current_setting('boe.pi_submission_approval_id', true);
begin
  return p_submission_id is not null and v_marker is not null and v_marker <> ''
     and v_marker = p_submission_id::text;
exception when others then return false;
end $$;

-- 20260908000000 §8.
create or replace function public.assert_order_submission_actor()
returns uuid language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_actor uuid := auth.uid();
begin
  if v_actor is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  if not exists (select 1 from public.users u
                 where u.id = v_actor and u.is_active and coalesce(u.is_deleted, false) = false) then
    raise exception 'This account is not active' using errcode = '42501';
  end if;
  return v_actor;
end $$;

create or replace function public.log_order_submission_activity(
  p_submission_id uuid, p_actor_id uuid, p_action text,
  p_previous_status text, p_new_status text,
  p_note text default null, p_metadata jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.order_submission_activity
    (submission_id, actor_id, action, previous_status, new_status, note, metadata)
  values (p_submission_id, p_actor_id, p_action, p_previous_status, p_new_status,
          nullif(btrim(coalesce(p_note, '')), ''), coalesce(p_metadata, '{}'::jsonb));
end $$;

-- 20261003000000 §1, reduced to the two branches the reservation door asks about:
-- owner-or-admin while draft/needs_changes, active admin only thereafter, and
-- orders.create required on both.
create or replace function public.assert_order_submission_workbook_editor(
  p_submission_id uuid, p_actor_id uuid,
  p_reason text default null, p_require_reason boolean default true)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_is_admin boolean; v_is_owner boolean; v_after boolean; v_sub public.order_submissions%rowtype;
begin
  if p_actor_id is null then
    raise exception 'ORDER_SUBMISSION_ACTOR_REQUIRED: an acting employee is required' using errcode = '28000';
  end if;
  select coalesce(u.role = 'admin', false) into v_is_admin from public.users u
   where u.id = p_actor_id and u.is_active and coalesce(u.is_deleted, false) = false;
  if not found then
    raise exception 'ORDER_SUBMISSION_ACTOR_INVALID: that account is not active' using errcode = '42501';
  end if;
  if not (coalesce(v_is_admin, false)
          or coalesce(public.resolve_permission(p_actor_id, 'orders', 'create'), false)) then
    raise exception 'ORDER_SUBMISSION_FORBIDDEN: that employee cannot create order submissions' using errcode = '42501';
  end if;
  select * into v_sub from public.order_submissions where id = p_submission_id;
  if not found then
    raise exception 'Order submission % not found', p_submission_id using errcode = 'P0002';
  end if;
  v_is_owner := (v_sub.created_by = p_actor_id or v_sub.submitted_by = p_actor_id);
  v_after := v_sub.status not in ('draft', 'needs_changes') or v_sub.order_id is not null;
  if not v_after then
    if not (v_is_owner or coalesce(v_is_admin, false)) then
      raise exception 'ORDER_SUBMISSION_NOT_OWNED: that employee does not own this submission' using errcode = '42501';
    end if;
    return jsonb_build_object('after_submission', false, 'is_admin_amendment', false,
                              'reason', null, 'status', v_sub.status, 'order_id', v_sub.order_id);
  end if;
  if not coalesce(v_is_admin, false) then
    raise exception
      'ORDER_SUBMISSION_NOT_EDITABLE: a submission can only be changed while it is a draft or has been returned (this one is %)',
      v_sub.status using errcode = '42501';
  end if;
  return jsonb_build_object('after_submission', true, 'is_admin_amendment', true,
                            'reason', nullif(btrim(coalesce(p_reason, '')), ''),
                            'status', v_sub.status, 'order_id', v_sub.order_id);
end $$;

-- ── The approval helpers this migration does not touch ───────────────────────
create or replace function public.order_submission_finance_verified(
  p_verified_at timestamptz, p_verified_submission_at timestamptz, p_submitted_at timestamptz)
returns boolean language sql immutable as $$
  select p_verified_at is not null
     and p_verified_submission_at is not distinct from p_submitted_at
$$;

create or replace function public.order_submission_verified_payment(p_submission_id uuid)
returns numeric language sql stable as $$
  select coalesce(sum(a.allocated_amount), 0)
  from public.finance_payment_allocations a
  join public.finance_payment_requests f on f.id = a.payment_request_id
  where a.order_submission_id = p_submission_id and a.status = 'active'
    and f.status in ('approved_linked', 'approved_unlinked')
$$;

create or replace function public.order_submission_unverified_payment(p_submission_id uuid)
returns numeric language sql stable as $$
  select coalesce(sum(a.allocated_amount), 0)
  from public.finance_payment_allocations a
  join public.finance_payment_requests f on f.id = a.payment_request_id
  where a.order_submission_id = p_submission_id and a.status = 'active'
    and f.status in ('pending_approval', 'needs_clarification')
$$;

create or replace function public.order_submission_required_payment(p_total numeric)
returns numeric language sql immutable as $$ select round(coalesce(p_total, 0) * 0.40, 2) $$;

create or replace function public.order_submission_payment_shortfall(p_total numeric, p_verified numeric)
returns numeric language sql immutable as $$
  select greatest(public.order_submission_required_payment(p_total) - coalesce(p_verified, 0), 0)
$$;

create or replace function public.order_submission_exception_current(
  p_status text, p_decided_total numeric, p_total numeric,
  p_decided_sha text, p_sha text,
  p_decided_payment_terms text, p_payment_terms text,
  p_decided_billing_terms text, p_billing_terms text)
returns boolean language sql immutable as $$
  select p_status = 'approved'
     and p_decided_total is not distinct from p_total
     and p_decided_sha is not distinct from p_sha
     and p_decided_payment_terms is not distinct from p_payment_terms
     and p_decided_billing_terms is not distinct from p_billing_terms
$$;

-- ── The ONE writer of source_order_number ───────────────────────────────────
--
-- Reduced to the property the revised-PI rule depends on: it writes the header
-- from a payload the SERVER produced by parsing the stored workbook, and it is
-- executable by no client role. The real function is ~400 lines and this
-- migration does not touch it; what is modelled is the write and the reach.
create or replace function public.replace_order_submission_parse(
  p_submission_id uuid, p_actor_id uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_header jsonb := coalesce(p_payload -> 'header', '{}'::jsonb); v_status text;
begin
  select status into v_status from public.order_submissions where id = p_submission_id for update;
  if not found then
    raise exception 'Order submission % not found', p_submission_id using errcode = 'P0002';
  end if;

  update public.order_submissions
     set source_order_number    = nullif(btrim(coalesce(v_header ->> 'source_order_number', '')), ''),
         client_name            = coalesce(nullif(btrim(coalesce(v_header ->> 'client_name', '')), ''), client_name),
         source_workbook_path   = coalesce(p_payload ->> 'source_workbook_path', source_workbook_path),
         source_workbook_name   = coalesce(p_payload ->> 'source_workbook_name', source_workbook_name),
         source_workbook_sha256 = coalesce(p_payload ->> 'source_workbook_sha256', source_workbook_sha256),
         updated_at             = now()
   where id = p_submission_id;

  perform public.log_order_submission_activity(
    p_submission_id, p_actor_id, 'parse_replaced', v_status, v_status, null, '{}'::jsonb);

  return jsonb_build_object('submission_id', p_submission_id);
end $$;

revoke execute on function public.replace_order_submission_parse(uuid, uuid, jsonb)
  from public, anon, authenticated;

-- 20260908000000 §6. Encapsulated in production so the parent table, the child
-- tables and the storage policies cannot drift apart — and, just as importantly,
-- so a caller's visibility is a BOOLEAN rather than a three-valued expression
-- over nullable columns. Modelled here for both reasons.
create or replace function public.can_view_order_submission(p_submission_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.order_submissions s
    where s.id = p_submission_id
      and (s.submitted_by = auth.uid()
           or s.created_by = auth.uid()
           or s.assigned_to = auth.uid()
           or public.actor_has_module_permission('orders', 'view_all')
           or exists (select 1 from public.users u
                      where u.id = auth.uid() and u.is_active and not u.is_deleted
                        and u.role = 'admin'))
  )
$$;

-- ── The allocation door, reduced to its refusals ─────────────────────────────
--
-- Faithful in every rule 20261009000000 §1 relies on: exactly one target, a
-- positive rupees-and-paise amount, the payment locked before its state is
-- judged, a rejected payment refused, the target's existence and eligibility,
-- one active claim per payment per target, and the balance re-derived under the
-- lock. Visibility is reduced to finance.view_all or ownership, which is the
-- shape the real one has.
create or replace function public.allocate_payment_to_target_internal(
  p_payment_request_id uuid, p_order_submission_id uuid default null,
  p_order_id uuid default null, p_allocated_amount numeric default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := auth.uid();
  v_pay public.finance_payment_requests%rowtype;
  v_sub public.order_submissions%rowtype;
  v_ord public.orders%rowtype;
  v_finance_all boolean; v_allocated numeric; v_available numeric;
  v_origin text; v_target_id uuid; v_id uuid;
begin
  if v_actor is null then
    raise exception 'Authentication required to allocate a payment' using errcode = '28000';
  end if;
  if num_nonnulls(p_order_submission_id, p_order_id) <> 1 then
    raise exception 'ALLOCATION_TARGET_REQUIRED: name exactly one target — a PI submission or a Confirmed Order.' using errcode = 'P0001';
  end if;
  if p_allocated_amount is null or p_allocated_amount = 'NaN'::numeric
     or p_allocated_amount <= 0 or p_allocated_amount <> round(p_allocated_amount, 2) then
    raise exception 'ALLOCATION_AMOUNT_INVALID: an allocation must be a positive amount in rupees and paise.' using errcode = 'P0001';
  end if;
  select * into v_pay from public.finance_payment_requests where id = p_payment_request_id for update;
  if not found then
    raise exception 'PAYMENT_NOT_FOUND: payment request % not found', p_payment_request_id using errcode = 'P0002';
  end if;
  if v_pay.status = 'rejected' then
    raise exception 'PAYMENT_REJECTED: payment % was rejected and cannot receive a new allocation. Reapply it first.',
      v_pay.request_number using errcode = 'P0001';
  end if;
  v_finance_all := public.actor_has_module_permission('finance', 'view_all');
  if p_order_submission_id is not null then
    select * into v_sub from public.order_submissions where id = p_order_submission_id;
    if not found or not (v_finance_all or public.can_view_order_submission(p_order_submission_id)) then
      raise exception 'ALLOCATION_TARGET_NOT_AVAILABLE: the selected PI submission is not available.' using errcode = '42501';
    end if;
    if v_sub.deletion_claim_token is not null then
      raise exception 'ALLOCATION_TARGET_CLAIMED: this PI is reserved for deletion and cannot receive an allocation.' using errcode = '55P03';
    end if;
    if v_sub.status = 'approved' then
      raise exception 'ALLOCATION_TARGET_CONVERTED: this PI has been approved and is now an Order. Allocate to the Order instead.' using errcode = 'P0001';
    end if;
    if v_sub.status = 'rejected' then
      raise exception 'ALLOCATION_TARGET_NOT_ACTIVE: a rejected PI cannot receive an allocation.' using errcode = 'P0001';
    end if;
    v_origin := 'order_submission'; v_target_id := p_order_submission_id;
  else
    select * into v_ord from public.orders where id = p_order_id;
    if not found or not (v_finance_all or v_ord.requested_by = v_actor or v_ord.assigned_to = v_actor
                         or public.actor_has_module_permission('orders', 'view_all')
                         or exists (select 1 from public.users u where u.id = v_actor and u.is_active
                                    and not u.is_deleted and (u.role = 'admin' or u.team = 'operations'))) then
      raise exception 'ALLOCATION_TARGET_NOT_AVAILABLE: the selected Order is not available.' using errcode = '42501';
    end if;
    if v_ord.status = 'cancelled' then
      raise exception 'ALLOCATION_TARGET_NOT_ACTIVE: Order % is cancelled and cannot receive an allocation.',
        v_ord.display_number using errcode = 'P0001';
    end if;
    v_origin := 'confirmed_order'; v_target_id := p_order_id;
  end if;
  if exists (select 1 from public.finance_payment_allocations a
             where a.payment_request_id = p_payment_request_id and a.status = 'active'
               and (a.order_submission_id = p_order_submission_id or a.order_id = p_order_id)) then
    raise exception 'ALLOCATION_DUPLICATE: payment % is already allocated to this target. Reverse that allocation before creating another.',
      v_pay.request_number using errcode = 'P0001';
  end if;
  select coalesce(sum(a.allocated_amount), 0) into v_allocated
  from public.finance_payment_allocations a
  where a.payment_request_id = p_payment_request_id and a.status = 'active';
  v_available := v_pay.amount - v_allocated;
  if p_allocated_amount > v_available then
    raise exception 'ALLOCATION_EXCEEDS_PAYMENT: payment % has % unallocated; % cannot be allocated.',
      v_pay.request_number, v_available, p_allocated_amount using errcode = 'P0001';
  end if;
  insert into public.finance_payment_allocations (
    payment_request_id, order_submission_id, order_id,
    allocated_amount, status, origin_target_type, created_by)
  values (p_payment_request_id, p_order_submission_id, p_order_id,
          p_allocated_amount, 'active', v_origin, v_actor)
  returning id into v_id;
  return jsonb_build_object(
    'allocation_id', v_id, 'payment_request_id', p_payment_request_id,
    'request_number', v_pay.request_number, 'target_type', v_origin,
    'target_id', v_target_id, 'allocated_amount', p_allocated_amount,
    'payment_amount', v_pay.amount, 'unallocated_balance', v_available - p_allocated_amount);
end $$;

revoke execute on function public.allocate_payment_to_target_internal(uuid, uuid, uuid, numeric) from public;

-- ═════════════════════════════════════════════════════════════════════════════
-- The Order Request retirement guards, so §9f asks a real question
-- ═════════════════════════════════════════════════════════════════════════════
--
-- 20261009000000 re-asserts that 20261007000000's guards are still installed and
-- enabled, on the reasoning that a new payment-entry door is exactly the kind of
-- change that could quietly reopen a retired workflow. That assertion has to be
-- ABLE TO FAIL here, so the guards are present and doing their real job rather
-- than being named-only stubs — the negative case below drops one and proves the
-- migration refuses itself.

create table public.order_requests (
  id                uuid primary key default gen_random_uuid(),
  request_number    text unique,
  status            text not null default 'draft',
  converted_order_id uuid references public.orders(id),
  created_at        timestamptz not null default now()
);

alter table public.orders
  add column if not exists source_order_request_id uuid references public.order_requests(id),
  add column if not exists source_request_number text;

create or replace function public.order_requests_refuse_new()
returns trigger language plpgsql as $$
begin
  raise exception 'ORDER_REQUESTS_RETIRED: the Order Request workflow is retired' using errcode = '42501';
end $$;

create trigger order_requests_refuse_new
  before insert on public.order_requests
  for each row execute function public.order_requests_refuse_new();

create or replace function public.order_requests_refuse_conversion()
returns trigger language plpgsql as $$
begin
  if new.status = 'converted' and old.status is distinct from 'converted' then
    raise exception 'ORDER_REQUESTS_RETIRED: conversion is retired' using errcode = '42501';
  end if;
  if new.converted_order_id is not null and old.converted_order_id is null then
    raise exception 'ORDER_REQUESTS_RETIRED: conversion is retired' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger order_requests_refuse_conversion
  before update on public.order_requests
  for each row execute function public.order_requests_refuse_conversion();

create or replace function public.orders_refuse_request_provenance()
returns trigger language plpgsql as $$
begin
  if new.source_order_request_id is not null or new.source_request_number is not null then
    raise exception 'ORDER_REQUESTS_RETIRED: a new Order may not carry Order Request provenance' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger orders_refuse_request_provenance
  before insert on public.orders
  for each row execute function public.orders_refuse_request_provenance();

-- ── Privileges, as production has them ───────────────────────────────────────
--
-- No client-role write on order_submissions, so every write in this suite goes
-- through a SECURITY DEFINER function — which is the arrangement the migration's
-- authorization reasoning depends on.
grant select on public.order_submissions, public.order_submission_activity,
                public.orders, public.finance_payment_requests,
                public.finance_payment_allocations to authenticated;
