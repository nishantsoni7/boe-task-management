-- Orders: Payment plan — how much more the client must pay before a dispatch.
--
-- WHY
--   Before a lot is dispatched the owner needs one sheet that says how much of
--   the PI the client must already have paid: the goods leaving in full, plus a
--   chosen share (50% unless changed) of the goods still to come, and GST on
--   the billed part of what leaves. Much old payment data is not in the app, so
--   the advance can be typed in and saved; the sheet fills it from Finance when
--   Finance has the payments.
--
-- THE CALCULATION (also in src/lib/orders/paymentPlan.ts, which is what the
-- screen, the Excel and the PDF use — the database stores inputs, never results)
--   T  = the PI's total before GST (products - discount + fabric + packing +
--        transport). Every charge is carried by the goods in proportion to value.
--   Dc = value of everything dispatched to date plus the planned lot, at rate.
--   G  = value of every ordered line, at rate.
--   dispatch amount  A = T x Dc / G                       (paid in full)
--   GST on dispatch    = A x billing% x GST rate          (the billed part only)
--   pending share      = (T - A) x pending%               (no GST)
--   required           = A + GST + pending share
--   still to collect   = required - advance received
--
-- WHAT THIS DOES
--   1. Registers orders.view_payment_plan and orders.edit_payment_plan
--      (deny-by-default; admins hold them through the admin branch).
--   2. order_payment_plans          one row per Order: pending %, billing %
--                                  override, typed advance, note.
--   3. order_dispatch_lots / _lines  the dispatch history and the one planned
--                                  lot. A line is keyed by the PI line's
--                                  item_sequence (the line's identity).
--   4. order_dispatch_lot_events   append-only trail of every change.
--   5. Functions: order_payment_plan_read, order_payment_plan_save,
--      order_dispatch_lot_save, order_dispatch_lot_mark_dispatched,
--      order_dispatch_lot_admin_change.
--
-- ACCESS MODEL
--   RLS on, NO policies, nothing granted to anon/authenticated on the tables:
--   they are reached only through the functions above, which ask for the Orders
--   entry gate, the permission, and the unscoped right to open the Order.
--   Viewing and saving are separate permissions. Changing a lot AFTER it was
--   marked dispatched is admin only, with a reason.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--   * Writes nothing to orders, order_submissions, payments or allocations, and
--     moves no Order status. "Dispatched" here is the lot's own state.
--   * Reads payments only as totals (verified, awaiting, count): no payer, no
--     proof, no payment id leaves the database.
--
-- ROLLBACK
--   drop function public.order_dispatch_lot_admin_change(uuid, text, jsonb, date);
--   drop function public.order_dispatch_lot_mark_dispatched(uuid, date);
--   drop function public.order_dispatch_lot_save(uuid, jsonb, date);
--   drop function public.order_payment_plan_save(uuid, numeric, numeric, numeric, text);
--   drop function public.order_payment_plan_read(uuid);
--   drop function public.order_payment_plan_assert(uuid, boolean);
--   drop function public.order_payment_plan_check_lines(uuid, jsonb, uuid);
--   drop table public.order_dispatch_lot_events;
--   drop table public.order_dispatch_lot_lines;
--   drop table public.order_dispatch_lots;
--   drop table public.order_payment_plans;
--   The two permission rows may stay.

do $dep$
begin
  if to_regprocedure('public.actor_has_module_permission(text, text)') is null then
    raise exception 'DEPENDENCY MISSING: public.actor_has_module_permission(text, text)';
  end if;
  if to_regprocedure('public.module_entry_open(text)') is null then
    raise exception 'DEPENDENCY MISSING: public.module_entry_open(text)';
  end if;
  if to_regprocedure('public.can_view_order_unscoped(uuid)') is null then
    raise exception 'DEPENDENCY MISSING: public.can_view_order_unscoped(uuid)';
  end if;
  if to_regprocedure('public.assert_order_amender()') is null then
    raise exception 'DEPENDENCY MISSING: public.assert_order_amender()';
  end if;
  if to_regprocedure('public.finance_payment_status_is_verified(text)') is null then
    raise exception 'DEPENDENCY MISSING: public.finance_payment_status_is_verified(text)';
  end if;
  if to_regclass('public.orders') is null
     or to_regclass('public.order_submissions') is null
     or to_regclass('public.order_submission_items') is null
     or to_regclass('public.finance_payment_allocations') is null
     or to_regclass('public.finance_payment_requests') is null then
    raise exception 'DEPENDENCY MISSING: orders / PI / finance tables';
  end if;
  if not exists (select 1 from public.permission_modules where module_key = 'orders') then
    raise exception 'DEPENDENCY MISSING: permission module orders';
  end if;
end $dep$;


-- ═══ §1. Permissions ════════════════════════════════════════════════════════

insert into public.permission_actions (action_key, display_name, is_system)
values ('view_payment_plan', 'View Payment plan', false),
       ('edit_payment_plan', 'Edit Payment plan', false)
on conflict (action_key) do nothing;

insert into public.module_permission_actions (module_id, action_id, default_allowed)
select pm.id, pa.id, false
from public.permission_modules pm
join public.permission_actions pa on pa.action_key in ('view_payment_plan', 'edit_payment_plan')
where pm.module_key = 'orders'
on conflict (module_id, action_id) do nothing;


-- ═══ §2. Tables ═════════════════════════════════════════════════════════════

create table public.order_payment_plans (
  order_id         uuid primary key references public.orders(id) on delete cascade,
  -- The share of the goods still to come that must be paid in advance.
  pending_percent  numeric(5,2) not null default 50
                   check (pending_percent between 0 and 100),
  -- Used when the PI declares no billing percentage, or to try another.
  billing_percent  numeric(5,2) check (billing_percent is null or billing_percent between 0 and 100),
  -- Typed when Finance does not hold the payments. NULL = use Finance's figure.
  advance_override numeric(14,2) check (advance_override is null or advance_override >= 0),
  note             text check (note is null or char_length(note) <= 1000),
  updated_by       uuid references public.users(id) on delete set null,
  updated_at       timestamptz not null default now()
);

create table public.order_dispatch_lots (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.orders(id) on delete cascade,
  lot_no        integer not null check (lot_no > 0),
  status        text not null default 'planned' check (status in ('planned', 'dispatched')),
  planned_on    date,
  dispatched_on date,
  created_by    uuid references public.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint order_dispatch_lots_lot_no_unique unique (order_id, lot_no),
  constraint order_dispatch_lots_state check ((status = 'dispatched') = (dispatched_on is not null))
);

-- One open ("next dispatch") plan per Order.
create unique index order_dispatch_lots_one_planned
  on public.order_dispatch_lots (order_id) where status = 'planned';

create table public.order_dispatch_lot_lines (
  lot_id        uuid not null references public.order_dispatch_lots(id) on delete cascade,
  item_sequence text not null check (btrim(item_sequence) <> '' and char_length(item_sequence) <= 60),
  quantity      numeric(12,2) not null check (quantity > 0),
  primary key (lot_id, item_sequence)
);

create table public.order_dispatch_lot_events (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null references public.orders(id) on delete cascade,
  -- Not a foreign key: the trail outlives a discarded or deleted lot.
  lot_id     uuid,
  lot_no     integer,
  event      text not null check (event in ('planned', 'dispatched', 'discarded', 'admin_changed', 'admin_deleted')),
  reason     text check (reason is null or char_length(reason) between 10 and 500),
  detail     jsonb not null default '{}'::jsonb,
  actor      uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index order_dispatch_lot_events_order_idx on public.order_dispatch_lot_events (order_id, created_at desc);

alter table public.order_payment_plans enable row level security;
alter table public.order_dispatch_lots enable row level security;
alter table public.order_dispatch_lot_lines enable row level security;
alter table public.order_dispatch_lot_events enable row level security;

revoke all on public.order_payment_plans from anon, authenticated;
revoke all on public.order_dispatch_lots from anon, authenticated;
revoke all on public.order_dispatch_lot_lines from anon, authenticated;
revoke all on public.order_dispatch_lot_events from anon, authenticated;

comment on table public.order_payment_plans is
  'Orders Payment plan: pending %, billing % override, typed advance, note. Inputs only; the sheet is computed by src/lib/orders/paymentPlan.ts. Reached only through order_payment_plan_* functions (20270428000000).';
comment on table public.order_dispatch_lots is
  'Orders Payment plan: dispatch history and the one planned lot per Order. "dispatched" is this lot''s own state; no Order status is touched (20270428000000).';
comment on table public.order_dispatch_lot_lines is
  'Quantity per PI line (item_sequence) in one dispatch lot (20270428000000).';
comment on table public.order_dispatch_lot_events is
  'Append-only trail of Payment plan lot changes, including admin changes with their reason (20270428000000).';


-- ═══ §3. Internal helpers (no client grant) ═════════════════════════════════

create or replace function public.order_payment_plan_assert(p_order_id uuid, p_edit boolean)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not public.module_entry_open('orders')
     or not public.actor_has_module_permission(
          'orders', case when p_edit then 'edit_payment_plan' else 'view_payment_plan' end)
     or not public.can_view_order_unscoped(p_order_id) then
    raise exception 'PAYMENT_PLAN_FORBIDDEN' using errcode = '42501';
  end if;
  if p_edit and exists (select 1 from public.orders o where o.id = p_order_id and o.status = 'cancelled') then
    raise exception 'PAYMENT_PLAN_ORDER_CANCELLED' using errcode = '22023';
  end if;
end;
$$;
revoke all on function public.order_payment_plan_assert(uuid, boolean) from public, anon, authenticated;

-- Validates a lines array and returns it normalised ([{item_sequence, quantity}]).
-- Every sequence must be a line of the Order's PI, quantities are positive
-- rupees-and-paise style (two decimals, never rounded), and no line may go
-- beyond what was ordered once every OTHER lot is counted.
create or replace function public.order_payment_plan_check_lines(
  p_order_id uuid, p_lines jsonb, p_exclude_lot uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_sub uuid;
  v_out jsonb := '[]'::jsonb;
  v_el jsonb;
  v_seq text;
  v_qty numeric;
  v_ordered numeric;
  v_other numeric;
  v_seen text[] := '{}';
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'DISPATCH_LINES_INVALID' using errcode = '22023';
  end if;
  if jsonb_array_length(p_lines) > 200 then
    raise exception 'DISPATCH_LINES_TOO_MANY' using errcode = '22023';
  end if;
  select o.source_order_submission_id into v_sub from public.orders o where o.id = p_order_id;
  if v_sub is null then
    raise exception 'PAYMENT_PLAN_NO_PI' using errcode = '22023';
  end if;

  for v_el in select * from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(v_el) <> 'object'
       or jsonb_typeof(v_el -> 'item_sequence') <> 'string'
       or jsonb_typeof(v_el -> 'quantity') <> 'number' then
      raise exception 'DISPATCH_LINES_INVALID' using errcode = '22023';
    end if;
    v_seq := btrim(v_el ->> 'item_sequence');
    v_qty := (v_el ->> 'quantity')::numeric;
    if v_qty <= 0 or v_qty <> round(v_qty, 2) then
      raise exception 'DISPATCH_QUANTITY_INVALID: % (needs a positive number, two decimals at most)', v_seq
        using errcode = '22023';
    end if;
    if v_seq = any (v_seen) then
      raise exception 'DISPATCH_LINE_DUPLICATED: %', v_seq using errcode = '22023';
    end if;
    v_seen := v_seen || v_seq;

    select i.quantity into v_ordered
      from public.order_submission_items i
     where i.submission_id = v_sub
       and coalesce(nullif(btrim(i.item_sequence), ''), i.id::text) = v_seq;
    if v_ordered is null then
      raise exception 'DISPATCH_LINE_NOT_ON_PI: %', v_seq using errcode = '22023';
    end if;

    select coalesce(sum(l.quantity), 0) into v_other
      from public.order_dispatch_lot_lines l
      join public.order_dispatch_lots t on t.id = l.lot_id
     where t.order_id = p_order_id
       and l.item_sequence = v_seq
       and (p_exclude_lot is null or t.id <> p_exclude_lot);
    if v_other + v_qty > v_ordered then
      raise exception 'DISPATCH_QUANTITY_EXCEEDS_ORDER: line % ordered %, already in other lots %, asked %',
        v_seq, v_ordered, v_other, v_qty using errcode = '22023';
    end if;

    v_out := v_out || jsonb_build_array(jsonb_build_object('item_sequence', v_seq, 'quantity', v_qty));
  end loop;
  return v_out;
end;
$$;
revoke all on function public.order_payment_plan_check_lines(uuid, jsonb, uuid) from public, anon, authenticated;


-- ═══ §4. Read ═══════════════════════════════════════════════════════════════
--
-- One call returns everything the sheet needs. Payments come back as totals
-- only: verified, awaiting verification (not rejected), and how many.

create or replace function public.order_payment_plan_read(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_sub public.order_submissions%rowtype;
  v_items jsonb;
  v_plan jsonb;
  v_lots jsonb;
  v_verified numeric;
  v_awaiting numeric;
  v_count integer;
begin
  perform public.order_payment_plan_assert(p_order_id, false);

  select * into v_order from public.orders where id = p_order_id;
  if not found then
    return jsonb_build_object('found', false);
  end if;
  select * into v_sub from public.order_submissions where id = v_order.source_order_submission_id;
  if not found then
    return jsonb_build_object('found', true, 'has_pi', false,
                              'order', jsonb_build_object('id', v_order.id, 'display_number', v_order.display_number));
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'item_sequence', coalesce(nullif(btrim(i.item_sequence), ''), i.id::text),
           'product_name', i.product_name,
           'quantity', i.quantity,
           'rate', i.cost_per_piece,
           'line_total', i.total_amount
         ) order by i.sort_order), '[]'::jsonb)
    into v_items
    from public.order_submission_items i
   where i.submission_id = v_sub.id;

  select jsonb_build_object(
           'pending_percent', p.pending_percent,
           'billing_percent', p.billing_percent,
           'advance_override', p.advance_override,
           'note', p.note,
           'updated_at', p.updated_at)
    into v_plan
    from public.order_payment_plans p
   where p.order_id = p_order_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', t.id,
           'lot_no', t.lot_no,
           'status', t.status,
           'planned_on', t.planned_on,
           'dispatched_on', t.dispatched_on,
           'lines', (select coalesce(jsonb_agg(jsonb_build_object(
                         'item_sequence', l.item_sequence, 'quantity', l.quantity)
                         order by l.item_sequence), '[]'::jsonb)
                       from public.order_dispatch_lot_lines l where l.lot_id = t.id)
         ) order by t.lot_no), '[]'::jsonb)
    into v_lots
    from public.order_dispatch_lots t
   where t.order_id = p_order_id;

  select coalesce(sum(a.allocated_amount) filter (where public.finance_payment_status_is_verified(r.status)), 0),
         coalesce(sum(a.allocated_amount) filter (where r.status in ('pending_approval', 'needs_clarification')), 0),
         count(*) filter (where r.status <> 'rejected')
    into v_verified, v_awaiting, v_count
    from public.finance_payment_allocations a
    join public.finance_payment_requests r on r.id = a.payment_request_id
   where a.order_id = p_order_id
     and a.status = 'active'
     and r.deleted_at is null;

  return jsonb_build_object(
    'found', true,
    'has_pi', true,
    'order', jsonb_build_object(
      'id', v_order.id,
      'display_number', v_order.display_number,
      'status', v_order.status,
      'total_value', v_order.total_value,
      'client_name', v_sub.client_name),
    'pi', jsonb_build_object(
      'gross_product_amount', v_sub.gross_product_amount,
      'discount_amount', v_sub.discount_amount,
      'subtotal_after_discount', v_sub.subtotal_after_discount,
      'fabric_cost', v_sub.fabric_cost,
      'packing_cost', v_sub.packing_cost,
      'transportation_amount', v_sub.transportation_amount,
      'transportation_text', v_sub.transportation_text,
      'total_before_gst', v_sub.total_before_gst,
      'gst_amount', v_sub.gst_amount,
      'grand_total', v_sub.grand_total,
      'billing_percentage', v_sub.billing_percentage),
    'items', v_items,
    'plan', v_plan,
    'lots', v_lots,
    'finance', jsonb_build_object(
      'verified', v_verified, 'awaiting', v_awaiting, 'payment_count', v_count)
  );
end;
$$;
revoke all on function public.order_payment_plan_read(uuid) from public, anon;
grant execute on function public.order_payment_plan_read(uuid) to authenticated;


-- ═══ §5. Save the inputs ════════════════════════════════════════════════════

create or replace function public.order_payment_plan_save(
  p_order_id uuid,
  p_pending_percent numeric,
  p_billing_percent numeric,
  p_advance_override numeric,
  p_note text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  perform public.order_payment_plan_assert(p_order_id, true);

  if p_pending_percent is null or p_pending_percent < 0 or p_pending_percent > 100
     or p_pending_percent <> round(p_pending_percent, 2) then
    raise exception 'PAYMENT_PLAN_PERCENT_INVALID: pending' using errcode = '22023';
  end if;
  if p_billing_percent is not null
     and (p_billing_percent < 0 or p_billing_percent > 100 or p_billing_percent <> round(p_billing_percent, 2)) then
    raise exception 'PAYMENT_PLAN_PERCENT_INVALID: billing' using errcode = '22023';
  end if;
  if p_advance_override is not null
     and (p_advance_override < 0 or p_advance_override <> round(p_advance_override, 2)) then
    raise exception 'PAYMENT_PLAN_ADVANCE_INVALID' using errcode = '22023';
  end if;
  if v_note is not null and char_length(v_note) > 1000 then
    raise exception 'PAYMENT_PLAN_NOTE_TOO_LONG' using errcode = '22023';
  end if;

  insert into public.order_payment_plans as p
    (order_id, pending_percent, billing_percent, advance_override, note, updated_by, updated_at)
  values (p_order_id, p_pending_percent, p_billing_percent, p_advance_override, v_note, auth.uid(), now())
  on conflict (order_id) do update
    set pending_percent = excluded.pending_percent,
        billing_percent = excluded.billing_percent,
        advance_override = excluded.advance_override,
        note = excluded.note,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at;
end;
$$;
revoke all on function public.order_payment_plan_save(uuid, numeric, numeric, numeric, text) from public, anon;
grant execute on function public.order_payment_plan_save(uuid, numeric, numeric, numeric, text) to authenticated;


-- ═══ §6. The planned lot ════════════════════════════════════════════════════
--
-- Replaces the Order's one planned lot with these lines (creating it if there
-- is none). An empty array discards the planned lot. Returns the lot id, or
-- NULL when the plan was discarded / there was nothing to discard.

create or replace function public.order_dispatch_lot_save(
  p_order_id uuid, p_lines jsonb, p_planned_on date
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lot public.order_dispatch_lots%rowtype;
  v_lines jsonb;
  v_el jsonb;
begin
  perform public.order_payment_plan_assert(p_order_id, true);
  -- One writer at a time per Order, so two saves cannot both pass the totals check.
  perform 1 from public.orders where id = p_order_id for update;

  select * into v_lot from public.order_dispatch_lots
   where order_id = p_order_id and status = 'planned';

  v_lines := public.order_payment_plan_check_lines(p_order_id, p_lines, v_lot.id);

  if jsonb_array_length(v_lines) = 0 then
    if v_lot.id is null then
      return null;
    end if;
    delete from public.order_dispatch_lots where id = v_lot.id;
    insert into public.order_dispatch_lot_events (order_id, lot_id, lot_no, event, actor)
    values (p_order_id, v_lot.id, v_lot.lot_no, 'discarded', auth.uid());
    return null;
  end if;

  if v_lot.id is null then
    insert into public.order_dispatch_lots (order_id, lot_no, planned_on, created_by)
    values (p_order_id,
            coalesce((select max(t.lot_no) from public.order_dispatch_lots t where t.order_id = p_order_id), 0) + 1,
            p_planned_on, auth.uid())
    returning * into v_lot;
  else
    update public.order_dispatch_lots
       set planned_on = p_planned_on, updated_at = now()
     where id = v_lot.id;
    delete from public.order_dispatch_lot_lines where lot_id = v_lot.id;
  end if;

  for v_el in select * from jsonb_array_elements(v_lines) loop
    insert into public.order_dispatch_lot_lines (lot_id, item_sequence, quantity)
    values (v_lot.id, v_el ->> 'item_sequence', (v_el ->> 'quantity')::numeric);
  end loop;

  insert into public.order_dispatch_lot_events (order_id, lot_id, lot_no, event, detail, actor)
  values (p_order_id, v_lot.id, v_lot.lot_no, 'planned', jsonb_build_object('lines', v_lines), auth.uid());

  return v_lot.id;
end;
$$;
revoke all on function public.order_dispatch_lot_save(uuid, jsonb, date) from public, anon;
grant execute on function public.order_dispatch_lot_save(uuid, jsonb, date) to authenticated;


-- ═══ §7. Mark the planned lot dispatched ════════════════════════════════════

create or replace function public.order_dispatch_lot_mark_dispatched(p_order_id uuid, p_dispatched_on date)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lot public.order_dispatch_lots%rowtype;
begin
  perform public.order_payment_plan_assert(p_order_id, true);
  perform 1 from public.orders where id = p_order_id for update;

  if p_dispatched_on is null then
    raise exception 'DISPATCH_DATE_REQUIRED' using errcode = '22023';
  end if;
  if p_dispatched_on > current_date + 1 then
    raise exception 'DISPATCH_DATE_IN_FUTURE' using errcode = '22023';
  end if;

  select * into v_lot from public.order_dispatch_lots
   where order_id = p_order_id and status = 'planned';
  if not found then
    raise exception 'DISPATCH_NO_PLANNED_LOT' using errcode = '22023';
  end if;
  if not exists (select 1 from public.order_dispatch_lot_lines where lot_id = v_lot.id) then
    raise exception 'DISPATCH_NO_PLANNED_LOT' using errcode = '22023';
  end if;

  update public.order_dispatch_lots
     set status = 'dispatched', dispatched_on = p_dispatched_on, updated_at = now()
   where id = v_lot.id;

  insert into public.order_dispatch_lot_events (order_id, lot_id, lot_no, event, detail, actor)
  values (p_order_id, v_lot.id, v_lot.lot_no, 'dispatched',
          jsonb_build_object('dispatched_on', p_dispatched_on), auth.uid());
end;
$$;
revoke all on function public.order_dispatch_lot_mark_dispatched(uuid, date) from public, anon;
grant execute on function public.order_dispatch_lot_mark_dispatched(uuid, date) to authenticated;


-- ═══ §8. Admin change to a dispatched lot ═══════════════════════════════════
--
-- Active administrator only (assert_order_amender), reason of 10-500 characters.
-- New lines replace the lot's lines; an empty array deletes the lot. The date,
-- when given, replaces the dispatched date.

create or replace function public.order_dispatch_lot_admin_change(
  p_lot_id uuid, p_reason text, p_lines jsonb, p_dispatched_on date
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lot public.order_dispatch_lots%rowtype;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_lines jsonb;
  v_old jsonb;
  v_el jsonb;
begin
  perform public.assert_order_amender();

  select * into v_lot from public.order_dispatch_lots where id = p_lot_id for update;
  if not found or v_lot.status <> 'dispatched' then
    raise exception 'DISPATCH_LOT_NOT_FOUND' using errcode = '22023';
  end if;
  perform public.order_payment_plan_assert(v_lot.order_id, true);
  perform 1 from public.orders where id = v_lot.order_id for update;

  if char_length(v_reason) < 10 or char_length(v_reason) > 500 then
    raise exception 'DISPATCH_REASON_REQUIRED' using errcode = '22023';
  end if;
  if p_dispatched_on is not null and p_dispatched_on > current_date + 1 then
    raise exception 'DISPATCH_DATE_IN_FUTURE' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('item_sequence', l.item_sequence, 'quantity', l.quantity)), '[]'::jsonb)
    into v_old from public.order_dispatch_lot_lines l where l.lot_id = v_lot.id;

  v_lines := public.order_payment_plan_check_lines(v_lot.order_id, p_lines, v_lot.id);

  if jsonb_array_length(v_lines) = 0 then
    delete from public.order_dispatch_lots where id = v_lot.id;
    insert into public.order_dispatch_lot_events (order_id, lot_id, lot_no, event, reason, detail, actor)
    values (v_lot.order_id, v_lot.id, v_lot.lot_no, 'admin_deleted', v_reason,
            jsonb_build_object('was', v_old, 'dispatched_on', v_lot.dispatched_on), auth.uid());
    return;
  end if;

  delete from public.order_dispatch_lot_lines where lot_id = v_lot.id;
  for v_el in select * from jsonb_array_elements(v_lines) loop
    insert into public.order_dispatch_lot_lines (lot_id, item_sequence, quantity)
    values (v_lot.id, v_el ->> 'item_sequence', (v_el ->> 'quantity')::numeric);
  end loop;
  update public.order_dispatch_lots
     set dispatched_on = coalesce(p_dispatched_on, dispatched_on), updated_at = now()
   where id = v_lot.id;

  insert into public.order_dispatch_lot_events (order_id, lot_id, lot_no, event, reason, detail, actor)
  values (v_lot.order_id, v_lot.id, v_lot.lot_no, 'admin_changed', v_reason,
          jsonb_build_object('was', v_old, 'now', v_lines,
                             'dispatched_on_was', v_lot.dispatched_on,
                             'dispatched_on_now', coalesce(p_dispatched_on, v_lot.dispatched_on)),
          auth.uid());
end;
$$;
revoke all on function public.order_dispatch_lot_admin_change(uuid, text, jsonb, date) from public, anon;
grant execute on function public.order_dispatch_lot_admin_change(uuid, text, jsonb, date) to authenticated;


-- ═══ §9. Self-assertions (executed) ═════════════════════════════════════════

do $assert$
begin
  if (select count(*) from public.module_permission_actions mpa
        join public.permission_actions pa on pa.id = mpa.action_id
        join public.permission_modules pm on pm.id = mpa.module_id
       where pm.module_key = 'orders'
         and pa.action_key in ('view_payment_plan', 'edit_payment_plan')
         and mpa.default_allowed = false) <> 2 then
    raise exception 'ASSERT: the two Payment plan permissions must exist, denied by default';
  end if;
  if has_table_privilege('authenticated', 'public.order_dispatch_lots', 'select')
     or has_table_privilege('authenticated', 'public.order_payment_plans', 'select')
     or has_table_privilege('anon', 'public.order_dispatch_lot_lines', 'select') then
    raise exception 'ASSERT: Payment plan tables must not be readable by client roles';
  end if;
  if has_function_privilege('authenticated', 'public.order_payment_plan_check_lines(uuid, jsonb, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.order_payment_plan_assert(uuid, boolean)', 'execute') then
    raise exception 'ASSERT: internal Payment plan helpers must not be callable by clients';
  end if;
  if not has_function_privilege('authenticated', 'public.order_payment_plan_read(uuid)', 'execute')
     or has_function_privilege('anon', 'public.order_payment_plan_read(uuid)', 'execute') then
    raise exception 'ASSERT: order_payment_plan_read must be callable by authenticated only';
  end if;
end $assert$;
