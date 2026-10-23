-- Order approval with cash that has not reached the company yet.
--
-- Owner decision 2026-10-23. When Nitish approves a PI into an Order, every
-- verified PNB, Paytm or Canara payment on it should already be with the
-- company (its cash journey closed, 20270413000000). Real life does not always
-- allow that — "Nishant took the cash and is out of town for 7 days" — and the
-- Order must still be aligned. So the approver may go ahead WITH A WRITTEN
-- REASON, recorded as an exception; the money stays on the "not yet with the
-- company" list, marked, until it arrives.
--
-- ENFORCED WITHOUT TOUCHING approve_order_submission (its body is pinned and
-- load-bearing): a BEFORE INSERT trigger on orders refuses an Order whose source
-- PI has verified, tracked, unclosed payments not covered by an exception row.
-- Approval of an Order with only HDFC money is exactly as before.
--
-- NOT FINANCIAL. Nothing here changes a payment, a total, an allocation, the
-- 40% gate or any verification. It only asks the approver to say why.

-- ─── 1. The exception record ─────────────────────────────────────────────────

create table if not exists public.order_submission_cash_exceptions (
  id                  uuid primary key default gen_random_uuid(),
  order_submission_id uuid not null references public.order_submissions(id) on delete cascade,
  payment_ids         uuid[] not null check (coalesce(array_length(payment_ids, 1), 0) > 0),
  reason              text not null check (char_length(btrim(reason)) between 10 and 500),
  created_by          uuid not null references public.users(id),
  created_at          timestamptz not null default now(),
  is_test_data        boolean not null default false
);
create index if not exists order_submission_cash_exceptions_submission_idx
  on public.order_submission_cash_exceptions (order_submission_id);

do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'stamp_is_test_data'
  ) then
    execute 'drop trigger if exists order_submission_cash_exceptions_stamp_test_data on public.order_submission_cash_exceptions';
    execute 'create trigger order_submission_cash_exceptions_stamp_test_data
               before insert on public.order_submission_cash_exceptions
               for each row execute function public.stamp_is_test_data()';
  end if;
end $$;

create or replace function public.order_submission_cash_exceptions_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- UPDATE only: a PI that is deleted takes its exception rows with it (cascade),
  -- exactly as it takes its allocations; no client role holds DELETE.
  raise exception 'ORDER_SUBMISSION_CASH_EXCEPTION_IMMUTABLE: an approval exception is a permanent record.'
    using errcode = 'P0001';
end $$;

drop trigger if exists order_submission_cash_exceptions_immutable_trg on public.order_submission_cash_exceptions;
create trigger order_submission_cash_exceptions_immutable_trg
  before update on public.order_submission_cash_exceptions
  for each row execute function public.order_submission_cash_exceptions_immutable();

alter table public.order_submission_cash_exceptions enable row level security;

drop policy if exists order_submission_cash_exceptions_select on public.order_submission_cash_exceptions;
create policy order_submission_cash_exceptions_select on public.order_submission_cash_exceptions
  for select to authenticated
  using (
    public.actor_can_approve_order()
    or public.can_view_order_submission(order_submission_id)
    or exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin' and u.is_active)
  );

revoke all on public.order_submission_cash_exceptions from public, anon, authenticated;
grant select on public.order_submission_cash_exceptions to authenticated;

-- ─── 2. Which of a PI's payments have not reached the company ───────────────
-- Verified, tracked (PNB / Paytm / Canara), actively allocated to this PI, not
-- deleted, and not with a company cash custodian.

create or replace function public.order_submission_unreceived_cash(p_submission_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(distinct f.id order by f.id), '{}'::uuid[])
    from public.finance_payment_allocations a
    join public.finance_payment_requests f on f.id = a.payment_request_id
   where a.order_submission_id = p_submission_id
     and a.status = 'active'
     and f.deleted_at is null
     and public.finance_payment_status_is_verified(f.status)
     and public.payment_mode_requires_custody(f.payment_mode)
     and not public.finance_payment_is_closed(f.id)
$$;
revoke all on function public.order_submission_unreceived_cash(uuid) from public, anon, authenticated;

-- What is still not covered by an exception on this PI.
create or replace function public.order_submission_uncovered_cash(p_submission_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(x order by x), '{}'::uuid[])
    from unnest(public.order_submission_unreceived_cash(p_submission_id)) as x
   where not exists (
     select 1 from public.order_submission_cash_exceptions e
      where e.order_submission_id = p_submission_id and x = any (e.payment_ids))
$$;
revoke all on function public.order_submission_uncovered_cash(uuid) from public, anon, authenticated;

-- ─── 3. The approver records the exception ───────────────────────────────────

create or replace function public.record_order_submission_cash_exception(
  p_submission_id uuid,
  p_reason        text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  uuid := auth.uid();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_ids    uuid[];
  v_id     uuid;
begin
  if v_actor is null or not public.actor_can_approve_order() then
    raise exception 'ORDER_SUBMISSION_CASH_EXCEPTION_NOT_ALLOWED: only an order approver can approve without the cash.'
      using errcode = '42501';
  end if;
  if v_reason is null or char_length(v_reason) < 10 or char_length(v_reason) > 500 then
    raise exception 'ORDER_SUBMISSION_CASH_REASON_REQUIRED: say why the order is approved before the cash reached the company (10 to 500 characters).'
      using errcode = 'P0001';
  end if;

  perform 1 from public.order_submissions s where s.id = p_submission_id for update;
  if not found then
    raise exception 'ORDER_SUBMISSION_NOT_FOUND: that PI no longer exists.' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.orders o where o.source_order_submission_id = p_submission_id) then
    raise exception 'ORDER_SUBMISSION_ALREADY_APPROVED: this PI already has an Order.' using errcode = 'P0001';
  end if;

  v_ids := public.order_submission_uncovered_cash(p_submission_id);
  if coalesce(array_length(v_ids, 1), 0) = 0 then
    return null; -- nothing outstanding: no exception is needed
  end if;

  insert into public.order_submission_cash_exceptions (order_submission_id, payment_ids, reason, created_by)
  values (p_submission_id, v_ids, v_reason, v_actor)
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.record_order_submission_cash_exception(uuid, text) from public, anon;
grant execute on function public.record_order_submission_cash_exception(uuid, text) to authenticated;

-- ─── 4. The rule, at the one place an Order is born ──────────────────────────

create or replace function public.orders_require_cash_or_exception()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_missing uuid[];
  v_labels  text;
begin
  if new.source_order_submission_id is null then
    return new;
  end if;
  v_missing := public.order_submission_uncovered_cash(new.source_order_submission_id);
  if coalesce(array_length(v_missing, 1), 0) > 0 then
    select string_agg(coalesce(f.human_payment_id, 'a payment'), ', ' order by f.human_payment_id)
      into v_labels from public.finance_payment_requests f where f.id = any (v_missing);
    raise exception 'ORDER_SUBMISSION_CASH_NOT_RECEIVED: the cash of % has not reached the company yet. Approve with a reason, or wait until it is received.', v_labels
      using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function public.orders_require_cash_or_exception() from public, anon, authenticated;

drop trigger if exists orders_require_cash_or_exception_trg on public.orders;
create trigger orders_require_cash_or_exception_trg
  before insert on public.orders
  for each row execute function public.orders_require_cash_or_exception();

-- ─── 5. The page asks what is outstanding before it asks for a reason ────────

create or replace function public.order_submission_cash_check(p_submission_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null or not (public.actor_can_approve_order() or public.can_view_order_submission(p_submission_id)) then
    return null;
  end if;
  return jsonb_build_object(
    'uncovered', (
      select coalesce(jsonb_agg(public.finance_cash_payment_state(x, v_actor) order by x), '[]'::jsonb)
        from unnest(public.order_submission_uncovered_cash(p_submission_id)) as x),
    'covered', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'reason', e.reason, 'by_name', u.full_name, 'at', e.created_at,
               'payment_count', array_length(e.payment_ids, 1)) order by e.created_at), '[]'::jsonb)
        from public.order_submission_cash_exceptions e
        left join public.users u on u.id = e.created_by
       where e.order_submission_id = p_submission_id)
  );
end $$;
revoke all on function public.order_submission_cash_check(uuid) from public, anon;
grant execute on function public.order_submission_cash_check(uuid) to authenticated;

-- ─── 6. Each payment's cash state carries its exception, if any ──────────────
-- Restated from 20270413000000 with one added field, 'order_exception'.

create or replace function public.finance_cash_payment_state(p_payment_id uuid, p_actor uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_pay    record;
  v_holder uuid;
  v_since  timestamptz;
  v_h      record;
  v_closed boolean;
  v_state  text;
begin
  select f.id, f.human_payment_id, f.client_name, f.amount, f.payment_mode, f.payment_date,
         f.created_at, f.submitted_by, f.status
    into v_pay from public.finance_payment_requests f where f.id = p_payment_id;
  if not found then return null; end if;

  v_holder := public.finance_payment_current_holder(p_payment_id);
  v_closed := public.finance_is_cash_custodian(v_holder);

  select e.occurred_at into v_since
    from public.finance_payment_custody_events e
   where e.payment_request_id = p_payment_id
   order by e.occurred_at desc, e.created_at desc limit 1;
  v_since := coalesce(v_since, v_pay.created_at);

  select h.id, h.human_id, h.status, h.giver_user_id, h.recipient_user_id, h.created_at,
         ru.full_name as recipient_name, gu.full_name as giver_name
    into v_h
    from public.finance_cash_handover_items i
    join public.finance_cash_handovers h on h.id = i.handover_id
    join public.users ru on ru.id = h.recipient_user_id
    join public.users gu on gu.id = h.giver_user_id
   where i.payment_request_id = p_payment_id and h.status in ('pending', 'disputed')
   order by h.created_at desc limit 1;

  v_state := case
    when v_closed then 'with_company'
    when v_h.id is not null and v_h.status = 'disputed' then 'disputed'
    when v_h.id is not null then 'waiting'
    else 'with_holder' end;

  return jsonb_build_object(
    'payment_id', v_pay.id,
    'human_payment_id', v_pay.human_payment_id,
    'client_name', v_pay.client_name,
    'amount', v_pay.amount,
    'payment_mode', v_pay.payment_mode,
    'payment_date', v_pay.payment_date,
    'recorded_at', v_pay.created_at,
    'tracked', public.payment_mode_requires_custody(v_pay.payment_mode)
                 and v_pay.status <> 'rejected',
    'state', v_state,
    'holder_id', v_holder,
    'holder_name', (select u.full_name from public.users u where u.id = v_holder),
    'holder_since', v_since,
    'age_hours', round((extract(epoch from now() - v_since) / 3600)::numeric, 1),
    'open_handover', case when v_h.id is null then null else jsonb_build_object(
        'id', v_h.id, 'human_id', v_h.human_id, 'status', v_h.status,
        'giver_id', v_h.giver_user_id, 'giver_name', v_h.giver_name,
        'recipient_id', v_h.recipient_user_id, 'recipient_name', v_h.recipient_name,
        'created_at', v_h.created_at) end,
    'order_exception', (
      select jsonb_build_object('reason', x.reason, 'by_name', u.full_name, 'at', x.created_at)
        from public.order_submission_cash_exceptions x
        left join public.users u on u.id = x.created_by
       where p_payment_id = any (x.payment_ids)
       order by x.created_at desc limit 1),
    'can_accept', v_h.id is not null and v_h.recipient_user_id = p_actor,
    'can_hand_over', not v_closed and v_h.id is null and v_holder = p_actor,
    'can_receive', not v_closed and public.finance_is_cash_custodian(p_actor)
  );
end $$;
