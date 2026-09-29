-- ═══════════════════════════════════════════════════════════════════════════
-- ORDERS DASHBOARD: what needs intervention, revenue, and PANIC MODE.
--
-- WHAT THIS MIGRATION ADDS
--   1. orders.view_panic_mode      a PROTECTED Control Center action: who may SEE
--                                  the PANIC MODE designations.
--   2. order_panic_designations    the designations, append-only history.
--   3. A guard trigger             the two-per-calendar-month limit, the
--                                  owner-only authority and the append-only rule,
--                                  enforced for EVERY writer, not only the RPCs.
--   4. designate_order_panic_mode / remove_order_panic_mode
--                                  the only write paths. Owner only.
--   5. orders_dashboard_summary()  ONE read that returns everything the Orders
--                                  dashboard draws, computed by the database.
--
-- IT CHANGES NO EXISTING TABLE, FUNCTION, POLICY OR ORDER. Additive only.
--
-- WHO IS "NISHANT". By employee_code TEST-001, through the existing
-- is_permanent_order_approver(uuid) — the convention 20260697000000 and
-- 20261224000000 established. Never by full_name, never by a uuid literal.
--
-- WHO MAY SEE PANIC MODE. The owner, or a holder of
-- orders.view_panic_mode, resolved by actor_has_permission() (NO admin
-- short-circuit), so an administrator who has not been granted it does not see
-- it. The summary returns `panic: null` — the key carries no data at all — to
-- everybody else.
--
-- THE DEFINITIONS THE SUMMARY USES (also stated on the dashboard):
--   open Order            status not in ('dispatched', 'cancelled')
--                         — orderWorkspace.ORDER_CLOSED_STATUSES.
--   test data             orders.is_test_data = true is excluded everywhere.
--   verified advance %    order_advance_position(): verified allocations
--                         ÷ orders.total_value (the current, amended Order value).
--                         "Below 40%" is that function's own shortfall > 0.
--   overdue               due_date < today (IST); days = today - due_date.
--   fabric / finish       newest order_approval_events row per kind; no row is
--                         Not Approved; anything other than Fully Approved is
--                         pending. Flagged when today (IST) - orders.confirm_date
--                         is MORE THAN 15 days.
--   not aligned           orders.production_alignment <> 'aligned'.
--   revenue               product value of each non-cancelled, non-test Order
--                         ONCE, by orders.confirm_date, in IST calendar periods.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
begin
  if to_regprocedure('public.order_advance_position(uuid)') is null then
    raise exception 'DEPENDENCY MISSING: order_advance_position(uuid) (20270116000000)';
  end if;
  if to_regprocedure('public.is_permanent_order_approver(uuid)') is null then
    raise exception 'DEPENDENCY MISSING: is_permanent_order_approver(uuid) (20261224000000)';
  end if;
  if to_regprocedure('public.can_view_order_as_actor(uuid)') is null
     or to_regprocedure('public.module_entry_open(text)') is null
     or to_regprocedure('public.actor_has_permission(text, text)') is null
     or to_regprocedure('public.assert_order_submission_actor()') is null then
    raise exception 'DEPENDENCY MISSING: the Orders access helpers';
  end if;
  if to_regclass('public.order_approval_events') is null then
    raise exception 'DEPENDENCY MISSING: order_approval_events (20261227000000)';
  end if;
  if to_regclass('public.order_operations_handoffs') is null then
    raise exception 'DEPENDENCY MISSING: order_operations_handoffs (20261229000000)';
  end if;
end $$;

-- ═══ 1. The protected action ═════════════════════════════════════════════════

insert into public.permission_actions (action_key, display_name, is_system)
values ('view_panic_mode', 'View PANIC MODE Orders', false)
on conflict (action_key) do nothing;

insert into public.module_permission_actions (module_id, action_id, default_allowed)
select pm.id, pa.id, false
from public.permission_modules pm
join public.permission_actions pa on pa.action_key = 'view_panic_mode'
where pm.module_key = 'orders'
on conflict (module_id, action_id) do nothing;

-- ═══ 2. Who may do what ══════════════════════════════════════════════════════

-- The owner: employee_code TEST-001, and an active account.
create or replace function public.is_orders_panic_owner()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null
     and public.is_permanent_order_approver(auth.uid())
     and exists (
       select 1 from public.users u
        where u.id = auth.uid() and u.is_active and coalesce(u.is_deleted, false) = false);
$$;
revoke execute on function public.is_orders_panic_owner() from public, anon;
grant  execute on function public.is_orders_panic_owner() to authenticated;
comment on function public.is_orders_panic_owner() is
  'True only for the owner account (employee_code TEST-001) while active. The one authority that may designate or remove PANIC MODE. 20270221000000.';

-- Who may SEE PANIC MODE: the owner, or a holder of the protected action.
-- actor_has_permission has no admin branch, so an administrator without the
-- grant does not see it.
create or replace function public.can_view_panic_mode()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    auth.uid() is not null
    and public.module_entry_open('orders')
    and (public.is_orders_panic_owner()
         or public.actor_has_permission('orders', 'view_panic_mode')),
    false);
$$;
revoke execute on function public.can_view_panic_mode() from public, anon;
grant  execute on function public.can_view_panic_mode() to authenticated;
comment on function public.can_view_panic_mode() is
  'May the caller see PANIC MODE designations? The owner, or a holder of the protected orders.view_panic_mode. No admin short-circuit. 20270221000000.';

-- ═══ 3. The designations ═════════════════════════════════════════════════════

create table if not exists public.order_panic_designations (
  id                uuid        primary key default gen_random_uuid(),
  order_id          uuid        not null references public.orders(id) on delete cascade,
  designated_by     uuid        not null references public.users(id),
  designated_at     timestamptz not null default now(),
  -- First day of the IST calendar month of designated_at. Set by the guard, so
  -- a writer cannot file a designation under another month.
  designated_month  date        not null,
  reason            text,
  removed_by        uuid        references public.users(id),
  removed_at        timestamptz,
  removal_reason    text,
  constraint order_panic_reason_length
    check (reason is null or (char_length(btrim(reason)) between 1 and 200)),
  constraint order_panic_removal_reason_length
    check (removal_reason is null or (char_length(btrim(removal_reason)) between 1 and 200)),
  constraint order_panic_removal_consistency
    check ((removed_by is null) = (removed_at is null)
           and (removed_at is null or removed_at >= designated_at)),
  constraint order_panic_month_is_first_of_month
    check (designated_month = date_trunc('month', designated_month)::date)
);

comment on table public.order_panic_designations is
  'PANIC MODE designations, one row each, kept for ever. Active = removed_at is null. Written only through designate_order_panic_mode() / remove_order_panic_mode() and guarded again by order_panic_designations_guard(): owner only, two designations per IST calendar month (removed ones still count), never deleted. A designation is NOT cleared at month end or when the Order closes — the dashboard simply stops drawing it once the Order is dispatched or cancelled, and the row stays. 20270221000000.';

-- One ACTIVE designation per Order.
create unique index if not exists order_panic_one_active_per_order
  on public.order_panic_designations (order_id) where removed_at is null;
create index if not exists order_panic_by_month
  on public.order_panic_designations (designated_month);

alter table public.order_panic_designations enable row level security;
revoke all on table public.order_panic_designations from public, anon, authenticated;
-- No policy and no grant: nothing reads or writes this table except the
-- definer functions below.

create or replace function public.order_panic_designations_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_used   integer;
begin
  if tg_op = 'INSERT' then
    -- The owner, and only the owner. auth.uid() is null for a service-role
    -- writer, so the row itself must still NAME the owner.
    if not public.is_permanent_order_approver(new.designated_by) then
      raise exception 'PANIC_MODE_NOT_OWNER: only the owner account may designate PANIC MODE'
        using errcode = '42501';
    end if;
    if auth.uid() is not null and auth.uid() is distinct from new.designated_by then
      raise exception 'PANIC_MODE_NOT_OWNER: a designation is recorded as the person making it'
        using errcode = '42501';
    end if;

    -- Stamped here, never trusted from the writer.
    new.designated_at    := now();
    new.designated_month := date_trunc('month', timezone('Asia/Kolkata', new.designated_at))::date;
    new.removed_by := null; new.removed_at := null; new.removal_reason := null;

    select o.status into v_status from public.orders o where o.id = new.order_id;
    if v_status is null then
      raise exception 'ORDER_NOT_FOUND: That Order no longer exists' using errcode = 'P0002';
    end if;
    if v_status in ('dispatched', 'cancelled') then
      raise exception 'PANIC_MODE_ORDER_CLOSED: a % Order cannot be put in PANIC MODE', v_status
        using errcode = 'P0001';
    end if;

    -- THE LIMIT, serialised per month so two racing designations cannot both
    -- see one used. Removed designations still count: a removal does not hand
    -- the slot back.
    perform pg_advisory_xact_lock(hashtext('order_panic_designations:' || new.designated_month::text));
    select count(*) into v_used from public.order_panic_designations d
     where d.designated_month = new.designated_month;
    if v_used >= 2 then
      raise exception 'PANIC_MODE_MONTH_LIMIT: two Orders have already been designated this month'
        using errcode = 'P0001';
    end if;
    return new;

  elsif tg_op = 'UPDATE' then
    if old.removed_at is not null then
      raise exception 'PANIC_MODE_HISTORY: a removed designation cannot be changed' using errcode = 'P0001';
    end if;
    if new.id is distinct from old.id or new.order_id is distinct from old.order_id
       or new.designated_by is distinct from old.designated_by
       or new.designated_at is distinct from old.designated_at
       or new.designated_month is distinct from old.designated_month
       or new.reason is distinct from old.reason then
      raise exception 'PANIC_MODE_HISTORY: a designation may only be removed, never rewritten'
        using errcode = 'P0001';
    end if;
    if new.removed_at is null then
      return new;
    end if;
    if not public.is_permanent_order_approver(new.removed_by)
       or (auth.uid() is not null and auth.uid() is distinct from new.removed_by) then
      raise exception 'PANIC_MODE_NOT_OWNER: only the owner account may remove PANIC MODE'
        using errcode = '42501';
    end if;
    new.removed_at := now();
    return new;

  else -- DELETE
    -- Only the Order's own deletion (test-data cleanup) may take a row with it.
    if pg_trigger_depth() = 1 then
      raise exception 'PANIC_MODE_HISTORY: a designation is never deleted' using errcode = 'P0001';
    end if;
    return old;
  end if;
end;
$$;
revoke execute on function public.order_panic_designations_guard() from public, anon, authenticated, service_role;
comment on function public.order_panic_designations_guard() is
  'Owner-only authority, the two-per-IST-month limit (removed ones count), stamped time/month, and append-only history for order_panic_designations, for every writer. 20270221000000.';

drop trigger if exists order_panic_designations_guard on public.order_panic_designations;
create trigger order_panic_designations_guard
  before insert or update or delete on public.order_panic_designations
  for each row execute function public.order_panic_designations_guard();

-- ═══ 4. The two write paths ══════════════════════════════════════════════════

create or replace function public.designate_order_panic_mode(p_order_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  uuid := public.assert_order_submission_actor();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_id     uuid;
begin
  if not public.is_orders_panic_owner() then
    raise exception 'PANIC_MODE_NOT_OWNER: only the owner account may designate PANIC MODE'
      using errcode = '42501';
  end if;
  if v_reason is not null and char_length(v_reason) > 200 then
    raise exception 'PANIC_MODE_REASON_TOO_LONG: the reason may be at most 200 characters (this one is %)',
      char_length(v_reason) using errcode = 'P0001';
  end if;
  -- Serialise on the Order so a second press sees the first.
  perform 1 from public.orders o where o.id = p_order_id for update;
  if not found then
    raise exception 'ORDER_NOT_FOUND: That Order no longer exists' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.order_panic_designations d
              where d.order_id = p_order_id and d.removed_at is null) then
    raise exception 'PANIC_MODE_ALREADY_ACTIVE: this Order is already in PANIC MODE' using errcode = 'P0001';
  end if;

  insert into public.order_panic_designations (order_id, designated_by, reason, designated_month)
  values (p_order_id, v_actor, v_reason, date '2000-01-01')  -- month is stamped by the guard
  returning id into v_id;

  return jsonb_build_object('designation_id', v_id, 'order_id', p_order_id);
end;
$$;
revoke execute on function public.designate_order_panic_mode(uuid, text) from public, anon;
grant  execute on function public.designate_order_panic_mode(uuid, text) to authenticated;
comment on function public.designate_order_panic_mode(uuid, text) is
  'Put an open Order in PANIC MODE. Owner only; two per IST calendar month; refuses a closed or already-designated Order. 20270221000000.';

create or replace function public.remove_order_panic_mode(p_designation_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  uuid := public.assert_order_submission_actor();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_order  uuid;
begin
  if not public.is_orders_panic_owner() then
    raise exception 'PANIC_MODE_NOT_OWNER: only the owner account may remove PANIC MODE'
      using errcode = '42501';
  end if;
  if v_reason is not null and char_length(v_reason) > 200 then
    raise exception 'PANIC_MODE_REASON_TOO_LONG: the reason may be at most 200 characters (this one is %)',
      char_length(v_reason) using errcode = 'P0001';
  end if;
  update public.order_panic_designations d
     set removed_by = v_actor, removed_at = now(), removal_reason = v_reason
   where d.id = p_designation_id and d.removed_at is null
  returning d.order_id into v_order;
  if v_order is null then
    raise exception 'PANIC_MODE_NOT_ACTIVE: that designation is not active' using errcode = 'P0001';
  end if;
  return jsonb_build_object('designation_id', p_designation_id, 'order_id', v_order);
end;
$$;
revoke execute on function public.remove_order_panic_mode(uuid, text) from public, anon;
grant  execute on function public.remove_order_panic_mode(uuid, text) to authenticated;
comment on function public.remove_order_panic_mode(uuid, text) is
  'Take an Order out of PANIC MODE, recording who and when. Owner only. The designation stays in history and still counts toward its month. 20270221000000.';

-- ═══ 5. The dashboard read ═══════════════════════════════════════════════════
--
-- ONE ROUND TRIP, ONE STATEMENT. Every list is computed here, over the Orders
-- the caller may open (can_view_order_as_actor), so a count is never a number
-- for records the reader cannot see. Anything that cannot be assessed is
-- COUNTED in `gaps` rather than treated as zero or as "all clear".

create or replace function public.orders_dashboard_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor      uuid := public.assert_order_submission_actor();
  v_today      date := timezone('Asia/Kolkata', now())::date;
  v_month_from date := date_trunc('month', timezone('Asia/Kolkata', now()))::date;
  v_six_from   date := ((timezone('Asia/Kolkata', now())::date - interval '6 months')::date + 1);
  v_year_from  date := date_trunc('year', timezone('Asia/Kolkata', now()))::date;
  v_sees_all   boolean;
  v_panic      boolean := public.can_view_panic_mode();
  v_owner      boolean := public.is_orders_panic_owner();
  v_result     jsonb;
begin
  if not public.module_entry_open('orders') then
    raise exception 'The Orders module is not open to this account' using errcode = '42501';
  end if;

  -- Company-wide revenue is only ever offered to somebody who sees EVERY
  -- Order: an active admin or a holder of orders.view_all. Anybody else would
  -- read a partial sum as the company's figure.
  v_sees_all :=
    exists (select 1 from public.users u
             where u.id = v_actor and u.role = 'admin' and u.is_active
               and coalesce(u.is_deleted, false) = false)
    or coalesce(public.resolve_permission(v_actor, 'orders', 'view_all'), false);

  with open_orders as materialized (
    select o.id, o.display_number, o.client_name, o.status, o.due_date, o.confirm_date,
           o.total_value, o.production_alignment
      from public.orders o
     where coalesce(o.is_test_data, false) = false
       and o.status not in ('dispatched', 'cancelled')
       and public.can_view_order_as_actor(o.id)
  ),
  pos as materialized (
    select d.id as order_id, public.order_advance_position(d.id) as pos
      from open_orders d
  ),
  advance as (
    -- Verified advance below 40%: the gate's own shortfall > 0.
    select coalesce(jsonb_agg(x order by (x ->> 'shortfall')::numeric desc, x ->> 'display_number'), '[]'::jsonb) j
    from (
      select jsonb_build_object(
               'order_id', d.id, 'display_number', d.display_number, 'client_name', d.client_name,
               'status', d.status, 'order_value', d.total_value,
               'verified', p.pos -> 'verified',
               -- Truncated, never rounded up: 39.996% must not read "40.00%"
               -- beside a shortfall.
               'percent', trunc(100 * (p.pos ->> 'verified')::numeric / d.total_value, 2),
               'shortfall', p.pos -> 'shortfall',
               'exception_approved', (jsonb_typeof(p.pos -> 'exception') = 'object'),
               'held', (jsonb_typeof(p.pos -> 'hold') = 'object')) as x
        from open_orders d join pos p on p.order_id = d.id
       where coalesce((p.pos ->> 'value_known')::boolean, false)
         and coalesce((p.pos ->> 'shortfall')::numeric, 0) > 0
    ) s
  ),
  overdue as (
    select coalesce(jsonb_agg(x order by (x ->> 'days_overdue')::int desc, x ->> 'display_number'), '[]'::jsonb) j
    from (
      select jsonb_build_object(
               'order_id', d.id, 'display_number', d.display_number, 'client_name', d.client_name,
               'status', d.status, 'due_date', d.due_date,
               'days_overdue', v_today - d.due_date) as x
        from open_orders d
       where d.due_date is not null and d.due_date < v_today
    ) s
  ),
  fabric as (
    -- Pending = the newest event for the kind is not Fully Approved; no event
    -- at all is Not Approved. MORE THAN 15 days since the confirmation date.
    select coalesce(jsonb_agg(x order by (x ->> 'days_since_confirmation')::int desc, x ->> 'display_number'), '[]'::jsonb) j
    from (
      select jsonb_build_object(
               'order_id', d.id, 'display_number', d.display_number, 'client_name', d.client_name,
               'status', d.status, 'confirm_date', d.confirm_date,
               'days_since_confirmation', v_today - d.confirm_date,
               'pending', (
                 select jsonb_agg(jsonb_build_object('kind', k.kind, 'status', k.status) order by k.kind)
                   from (
                     select kinds.kind,
                            coalesce((select e.status from public.order_approval_events e
                                       where e.order_id = d.id and e.approval_kind = kinds.kind
                                       order by e.created_at desc, e.id desc limit 1),
                                     'not_approved') as status
                       from (values ('fabric'), ('finish')) as kinds(kind)
                   ) k
                  where k.status <> 'fully_approved')) as x
        from open_orders d
       where d.confirm_date is not null
         and (v_today - d.confirm_date) > 15
    ) s
    where jsonb_typeof(x -> 'pending') = 'array'
  ),
  aligned as (
    select coalesce(jsonb_agg(x order by x ->> 'display_number'), '[]'::jsonb) j
    from (
      select jsonb_build_object(
               'order_id', d.id, 'display_number', d.display_number, 'client_name', d.client_name,
               'status', d.status,
               'reason', case
                 when h.status = 'clarification_needed' then 'clarification_needed'
                 when h.status = 'awaiting' and h.assigned_to is null then 'awaiting_unassigned'
                 when h.status = 'awaiting' then 'awaiting_review'
                 when jsonb_typeof(p.pos -> 'hold') = 'object' then 'held_advance'
                 when h.status = 'accepted' then 'accepted_not_aligned'
                 else 'no_handoff' end,
               'detail', case when h.status = 'clarification_needed' then h.clarification_reason end,
               'advance_blocks', not coalesce((p.pos ->> 'ready')::boolean, false)) as x
        from open_orders d
        join pos p on p.order_id = d.id
        left join lateral (
          select oh.status, oh.assigned_to, oh.clarification_reason
            from public.order_operations_handoffs oh
           where oh.order_id = d.id and oh.superseded_at is null
           order by oh.created_at desc limit 1) h on true
       where d.production_alignment is distinct from 'aligned'
    ) s
  ),
  gaps as (
    select jsonb_build_object(
             'open_orders', (select count(*) from open_orders),
             'advance_value_unknown', (select count(*) from pos p
                                        where not coalesce((p.pos ->> 'value_known')::boolean, false)),
             'no_due_date', (select count(*) from open_orders where due_date is null),
             'no_confirm_date', (select count(*) from open_orders where confirm_date is null)) j
  ),
  rev as (
    -- Revenue: each non-cancelled, non-test Order ONCE, at its current product
    -- value. The Order's own figure is the PI's gross; where the PI in force
    -- states a discount and the Order still carries that gross, the PI's
    -- after-discount subtotal is the product value — the meaning every PI and
    -- Order screen already gives the words (orderWorkspace.orderProductValue).
    select o.id, o.confirm_date,
           case
             when o.total_product_value is null or o.total_product_value = 'NaN'::numeric then null
             when coalesce(pi.d, 0) <> 0 and pi.g is not null and o.total_product_value = pi.g and pi.st is not null
               then pi.st
             else o.total_product_value end as pv,
           (coalesce(pi.d, 0) <> 0
             and not (pi.g is not null and o.total_product_value = pi.g and pi.st is not null)) as before_discount
      from public.orders o
      left join lateral (
        select s.gross_product_amount as g, s.discount_amount as d, s.subtotal_after_discount as st
          from public.order_submissions s
         where s.id = coalesce(
                 (select v.submission_id from public.order_pi_versions v
                   where v.order_id = o.id and v.status = 'approved'
                   order by v.version_number desc limit 1),
                 o.source_order_submission_id)) pi on true
     where v_sees_all
       and coalesce(o.is_test_data, false) = false
       and o.status <> 'cancelled'
  ),
  revenue as (
    select jsonb_build_object(
             'currency', 'INR',
             'basis', 'product_value',
             'date_basis', 'confirm_date',
             'current_month', jsonb_build_object('from', v_month_from, 'to', v_today,
               'amount', coalesce(sum(pv) filter (where confirm_date between v_month_from and v_today), 0),
               'orders', count(*) filter (where confirm_date between v_month_from and v_today and pv is not null)),
             'last_six_months', jsonb_build_object('from', v_six_from, 'to', v_today,
               'amount', coalesce(sum(pv) filter (where confirm_date between v_six_from and v_today), 0),
               'orders', count(*) filter (where confirm_date between v_six_from and v_today and pv is not null)),
             'current_year', jsonb_build_object('from', v_year_from, 'to', v_today,
               'amount', coalesce(sum(pv) filter (where confirm_date between v_year_from and v_today), 0),
               'orders', count(*) filter (where confirm_date between v_year_from and v_today and pv is not null)),
             'gaps', jsonb_build_object(
               'no_confirm_date', count(*) filter (where confirm_date is null),
               'future_confirm_date', count(*) filter (where confirm_date > v_today),
               -- In the year but with no product value on record: excluded, and said.
               'no_product_value_in_year', count(*) filter (where confirm_date between v_year_from and v_today and pv is null),
               -- Still the figure BEFORE the PI's discount (amended away from the PI).
               'before_discount_in_year', count(*) filter (where confirm_date between v_year_from and v_today and before_discount))) j
      from rev
    having v_sees_all
  ),
  panic as (
    select jsonb_build_object(
      'active', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'designation_id', d.id, 'order_id', o.id,
                 'display_number', o.display_number, 'client_name', o.client_name,
                 'status', o.status, 'due_date', o.due_date, 'reason', d.reason,
                 'designated_at', d.designated_at,
                 'designated_by_name', u.full_name) order by d.designated_at)
          from public.order_panic_designations d
          join public.orders o on o.id = d.order_id
          left join public.users u on u.id = d.designated_by
         where d.removed_at is null
           and coalesce(o.is_test_data, false) = false
           and o.status not in ('dispatched', 'cancelled')), '[]'::jsonb),
      'month_start', v_month_from,
      'month_used', (select count(*) from public.order_panic_designations d
                      where d.designated_month = v_month_from),
      'month_limit', 2,
      'can_manage', v_owner) j
     where v_panic
  )
  select jsonb_build_object(
    'today', v_today,
    'viewer', jsonb_build_object(
      'sees_all_orders', v_sees_all,
      'can_view_revenue', v_sees_all,
      'can_view_panic', v_panic,
      'can_manage_panic', v_owner),
    'groups', jsonb_build_object(
      'advance_below_40', (select j from advance),
      'overdue', (select j from overdue),
      'fabric_finish_pending', (select j from fabric),
      'not_aligned', (select j from aligned)),
    'gaps', (select j from gaps),
    'revenue', (select j from revenue),
    'panic', (select j from panic))
  into v_result;

  return v_result;
end;
$$;
revoke execute on function public.orders_dashboard_summary() from public, anon;
grant  execute on function public.orders_dashboard_summary() to authenticated;
comment on function public.orders_dashboard_summary() is
  'Everything the Orders dashboard draws, in one read: four action groups over the open Orders the caller may open, what could not be assessed, product-value revenue (callers who see every Order only) and PANIC MODE (callers who may see it only; null otherwise). 20270221000000.';

-- ═══ 6. It took ═════════════════════════════════════════════════════════════

do $$
begin
  if to_regprocedure('public.orders_dashboard_summary()') is null
     or to_regprocedure('public.designate_order_panic_mode(uuid, text)') is null
     or to_regprocedure('public.remove_order_panic_mode(uuid, text)') is null
     or to_regclass('public.order_panic_designations') is null then
    raise exception 'VERIFY: the PANIC MODE objects were not created';
  end if;
  if not exists (
    select 1 from public.module_permission_actions mpa
      join public.permission_modules pm on pm.id = mpa.module_id and pm.module_key = 'orders'
      join public.permission_actions pa on pa.id = mpa.action_id and pa.action_key = 'view_panic_mode'
     where mpa.default_allowed = false) then
    raise exception 'VERIFY: orders.view_panic_mode is not registered with default_allowed = false';
  end if;
  if has_table_privilege('authenticated', 'public.order_panic_designations', 'select')
     or has_table_privilege('anon', 'public.order_panic_designations', 'select') then
    raise exception 'VERIFY: order_panic_designations must not be readable by a client role';
  end if;
end $$;
