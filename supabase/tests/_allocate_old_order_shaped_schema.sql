-- Shaped schema for run_allocate_old_order_suite.sh (20270407000000).
--
-- Just what the legacy-order allocation reads or writes. The runner installs the
-- DEPLOYED bodies of the capacity trigger, the reversal trigger, reverse_payment_
-- allocation, the transition guard and the activity writer on top of this, and
-- then applies the migration.
--
-- SHAPED, NOT THE REAL TABLES: finance_payment_allocations carries the real
-- columns and constraints of 20260918000000 (so the migration's replacement of
-- two of them is proved against the originals); the payment, order and PI tables
-- are reduced to the columns read. The Record Payment base and the
-- Order/PI allocator are STAND-INS, written only so the new wrapper has
-- something to call; this suite proves the wrapper and the legacy path, not
-- them. A disposable database only. It never talks to a linked project.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;

create schema auth;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create table public.users (
  id         uuid primary key,
  full_name  text,
  role       text not null default 'employee',
  is_active  boolean not null default true,
  is_deleted boolean default false
);

create table public.finance_payment_requests (
  id               uuid primary key default gen_random_uuid(),
  request_number   text,
  status           text not null default 'pending_approval',
  amount           numeric not null,
  client_name      text,
  submitted_by     uuid references public.users(id),
  order_id         uuid,
  order_request_id uuid,
  is_test_data     boolean not null default false
);

create table public.orders (
  id            uuid primary key default gen_random_uuid(),
  display_number text,
  client_name   text,
  status        text not null default 'confirmed',
  source_order_submission_id uuid
);

create table public.order_submissions (
  id                    uuid primary key default gen_random_uuid(),
  client_name           text,
  status                text not null default 'draft',
  order_id              uuid,
  draft_reference       text,
  source_workbook_name  text,
  source_order_number   text,
  reserved_order_number text
);

create table public.order_requests (
  id                 uuid primary key default gen_random_uuid(),
  created_by         uuid,
  requested_by       uuid,
  assigned_to        uuid,
  converted_order_id uuid
);

create table public.finance_payment_request_activity_log (
  id                 uuid primary key default gen_random_uuid(),
  payment_request_id uuid not null,
  actor_id           uuid,
  event_type         text not null,
  payload            jsonb,
  created_at         timestamptz not null default now()
);

-- ── the real table, 20260918000000 §1/§2 ────────────────────────────────────
create table public.finance_payment_allocations (
  id uuid primary key default gen_random_uuid(),
  payment_request_id uuid not null
    constraint finance_payment_allocations_payment_fk
    references public.finance_payment_requests(id),
  order_submission_id uuid
    constraint finance_payment_allocations_order_submission_fk
    references public.order_submissions(id),
  order_id uuid
    constraint finance_payment_allocations_order_fk
    references public.orders(id),
  allocated_amount numeric not null,
  status text not null default 'active',
  origin_target_type text not null,
  created_by uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  reversed_by uuid references public.users(id),
  reversed_at timestamptz,
  reversal_reason text,
  is_test_data boolean not null default false,
  constraint finance_payment_allocations_amount_valid check (
    allocated_amount <> 'NaN'::numeric
    and allocated_amount > 0
    and allocated_amount = round(allocated_amount, 2)
  ),
  constraint finance_payment_allocations_one_target check (
    num_nonnulls(order_submission_id, order_id) = 1
  ),
  constraint finance_payment_allocations_status_known check (
    status in ('active', 'reversed')
  ),
  constraint finance_payment_allocations_origin_known check (
    origin_target_type in ('order_submission', 'confirmed_order')
  ),
  constraint finance_payment_allocations_origin_matches_target check (
    origin_target_type <> 'confirmed_order' or order_id is not null
  ),
  constraint finance_payment_allocations_reversal_complete check (
    (status = 'active'
     and reversed_by is null
     and reversed_at is null
     and reversal_reason is null)
    or
    (status = 'reversed'
     and reversed_by is not null
     and reversed_at is not null
     and reversal_reason is not null
     and btrim(reversal_reason) <> '')
  ),
  constraint finance_payment_allocations_reversal_not_before_creation check (
    reversed_at is null or reversed_at >= created_at
  )
);

create unique index finance_payment_allocations_unique_active_submission
  on public.finance_payment_allocations (payment_request_id, order_submission_id)
  where status = 'active' and order_submission_id is not null;
create unique index finance_payment_allocations_unique_active_order
  on public.finance_payment_allocations (payment_request_id, order_id)
  where status = 'active' and order_id is not null;

-- ── helpers the deployed bodies and the migration call ─────────────────────
create function public.in_test_data_cleanup() returns boolean language sql stable as $$ select false $$;
create function public.in_pi_submission_approval(p uuid) returns boolean language sql stable as $$ select false $$;
create function public.module_entry_open(p text) returns boolean language sql stable as $$ select true $$;

-- The test sets which finance permissions the caller holds: set local test.perms = 'allocate,view'.
create function public.actor_has_module_permission(p_module text, p_action text)
returns boolean language sql stable as $$
  select p_action = any (string_to_array(coalesce(current_setting('test.perms', true), ''), ','))
$$;
create function public.resolve_permission(p_user uuid, p_module text, p_action text)
returns boolean language sql stable as $$
  select p_action = any (string_to_array(coalesce(current_setting('test.perms', true), ''), ','))
$$;
create function public.can_read_payment_as_participant(p uuid) returns boolean language sql stable as $$ select false $$;
create function public.received_payment_visible_to_actor(p uuid) returns boolean language sql stable as $$ select true $$;
create function public.finance_payment_status_is_verified(p_status text) returns boolean language sql immutable as $$
  select p_status in ('approved_unlinked', 'approved_linked')
$$;
create function public.assert_order_submission_actor() returns uuid language sql stable as $$ select auth.uid() $$;

-- ── STAND-INS for what the migration wraps ──────────────────────────────────

-- The Order / PI allocator: writes the row, nothing else.
create function public.allocate_payment_to_target_internal(
  p_payment_request_id uuid, p_order_submission_id uuid default null,
  p_order_id uuid default null, p_allocated_amount numeric default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  insert into public.finance_payment_allocations
    (payment_request_id, order_submission_id, order_id, allocated_amount, origin_target_type, created_by)
  values (p_payment_request_id, p_order_submission_id, p_order_id, p_allocated_amount,
          case when p_order_id is not null then 'confirmed_order' else 'order_submission' end, auth.uid())
  returning id into v_id;
  return jsonb_build_object('allocation_id', v_id);
end $$;

-- The deployed Record Payment core, reduced: the payment, its Order/PI rows, a
-- derived customer — and the same 'rows over the amount' refusal.
create function public.record_payment_with_allocations(
  p_amount numeric, p_payment_date date, p_payment_mode text, p_client_name text,
  p_received_in text default null, p_reference text default null, p_remarks text default null,
  p_allocations jsonb default '[]'::jsonb, p_custody_events jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row jsonb; v_id uuid; v_sum numeric := 0; v_res jsonb := '[]'::jsonb; v_a jsonb;
  v_client text; v_i int := 0;
begin
  for v_row in select jsonb_array_elements(p_allocations) loop
    if btrim(lower(v_row->>'kind')) not in ('order', 'submission') then
      raise exception 'PAYMENT_ALLOCATION_KIND_INVALID: row must name a Confirmed Order or a PI Draft.';
    end if;
    v_sum := v_sum + (v_row->>'amount')::numeric;
  end loop;
  if v_sum > p_amount then
    raise exception 'PAYMENT_ALLOCATIONS_EXCEED_AMOUNT: % allocated is more than the % received.', v_sum, p_amount;
  end if;
  select case when count(distinct name) = 1 then min(name) end into v_client
  from (select coalesce((select o.client_name from public.orders o where o.id = (t->>'id')::uuid),
                        (select s.client_name from public.order_submissions s where s.id = (t->>'id')::uuid)) as name
        from jsonb_array_elements(p_allocations) t) n where name is not null;
  insert into public.finance_payment_requests (request_number, status, amount, client_name, submitted_by)
  values ('PAY-REQ-T-' || (select count(*) + 1 from public.finance_payment_requests), 'pending_approval',
          p_amount, v_client, auth.uid())
  returning id into v_id;
  for v_row in select jsonb_array_elements(p_allocations) loop
    v_i := v_i + 1;
    v_a := public.allocate_payment_to_target_internal(v_id,
      case when btrim(lower(v_row->>'kind')) = 'submission' then (v_row->>'id')::uuid end,
      case when btrim(lower(v_row->>'kind')) = 'order' then (v_row->>'id')::uuid end,
      (v_row->>'amount')::numeric);
    v_res := v_res || jsonb_build_array(jsonb_build_object('row', v_i, 'kind', v_row->>'kind',
      'allocation_id', v_a->>'allocation_id', 'allocated_amount', (v_row->>'amount')::numeric));
  end loop;
  return jsonb_build_object('payment_request_id', v_id, 'allocation_count', jsonb_array_length(p_allocations),
    'allocated_total', v_sum, 'unallocated_balance', p_amount - v_sum, 'allocations', v_res);
end $$;
-- The migration renames record_payment_with_allocations_core; the stand-in is
-- therefore created under that name.
alter function public.record_payment_with_allocations(numeric, date, text, text, text, text, text, jsonb, jsonb)
  rename to record_payment_with_allocations_core;

-- The deployed readers/door the migration replaces, with their old shapes.
create function public.allocate_payment_to_targets(p_payment_request_id uuid, p_targets jsonb)
returns jsonb language sql as $$ select '{}'::jsonb $$;

create function public.received_payment_allocation_targets(p_payment_request_ids uuid[])
returns table (payment_request_id uuid, allocation_id uuid, target_type text, target_id uuid,
               target_reference text, reserved_order_number text, allocated_amount numeric)
language sql as $$ select null::uuid, null::uuid, null::text, null::uuid, null::text, null::text, null::numeric where false $$;

create function public.payment_allocation_ledger_for_correction(p_payment_request_id uuid)
returns table (allocation_id uuid, status text, allocated_amount numeric, order_id uuid,
               order_submission_id uuid, target_reference text, client_name text,
               created_at timestamptz, reversed_at timestamptz, reversal_reason text,
               reversed_by_name text)
language sql as $$ select null::uuid, null::text, null::numeric, null::uuid, null::uuid, null::text, null::text,
  null::timestamptz, null::timestamptz, null::text, null::text where false $$;
