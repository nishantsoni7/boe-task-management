-- 20270628000000_star_seller_focus.sql
--
-- The Star Seller's Super Priority (owner, 2026-11-12): "the sales person with highest sales in last month will
-- get a credit to add an order to the super priority list which will be shown to all sales staff". Decided: one
-- of their OWN open Orders, once a month, in Factory Focus until dispatched.
--
--   * order_factory_focus_selections gains kind ('owner' | 'star_seller') and award_month (the month whose Star
--     Seller award it uses). One Star Seller pick per award month.
--   * scoreboard_star_seller(month): the person announced Star Seller for a frozen month (scoreboard_awards and
--     scoreboard_months, 20270627000000), else null.
--   * order_factory_focus_guard is restated (its last definition is 20270221000000) with ONE added branch for the
--     Star Seller's pick and the owner's two-a-month limit counting only the owner's picks. Every owner rule is
--     word for word as before: the owner selects, removes and is limited exactly as today; only the owner removes,
--     the Star Seller's pick included.
--
-- The pick itself is written by /api/scoreboard/star-seller (service role, actor from the token); this guard
-- refuses anything but the announced Star Seller's own open Order, whatever the writer.
--
-- ROLLBACK: restate order_factory_focus_guard from 20270221000000; drop index order_focus_one_star_pick;
--   alter table order_factory_focus_selections drop constraint order_focus_star_month, drop column award_month,
--   drop column kind; drop function scoreboard_star_seller(date).

do $$
begin
  if to_regclass('public.order_factory_focus_selections') is null
     or to_regclass('public.scoreboard_awards') is null or to_regclass('public.scoreboard_months') is null then
    raise exception 'DEPENDENCY MISSING: Factory Focus (20270221000000) and the monthly review (20270627000000)';
  end if;
end $$;

alter table public.order_factory_focus_selections
  add column if not exists kind text not null default 'owner',
  add column if not exists award_month date;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'order_focus_kind') then
    alter table public.order_factory_focus_selections
      add constraint order_focus_kind check (kind in ('owner', 'star_seller'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'order_focus_star_month') then
    alter table public.order_factory_focus_selections
      add constraint order_focus_star_month check ((kind = 'star_seller') = (award_month is not null));
  end if;
end $$;

create unique index if not exists order_focus_one_star_pick
  on public.order_factory_focus_selections (award_month) where kind = 'star_seller';

create or replace function public.scoreboard_star_seller(p_month date)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select a.employee_id
  from public.scoreboard_awards a
  join public.scoreboard_months m on m.month = a.month
  where a.month = p_month and a.award = 'star_seller'
  limit 1;
$$;
revoke all on function public.scoreboard_star_seller(date) from public, anon, authenticated;

create or replace function public.order_factory_focus_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status      text;
  v_salesperson uuid;
  v_used        integer;
begin
  if tg_op = 'INSERT' and new.kind = 'star_seller' then
    -- THE STAR SELLER'S PICK (20270628000000): last month's announced Star Seller, once for that award, one of
    -- their OWN open Orders. Not counted in the owner's two a month. Removal stays the owner's (below).
    if new.award_month is null or public.scoreboard_star_seller(new.award_month) is distinct from new.selected_by then
      raise exception 'FACTORY_FOCUS_NOT_STAR_SELLER: only the announced Star Seller makes this pick'
        using errcode = '42501';
    end if;
    if auth.uid() is not null and auth.uid() is distinct from new.selected_by then
      raise exception 'FACTORY_FOCUS_NOT_STAR_SELLER: a selection is recorded as the person making it'
        using errcode = '42501';
    end if;
    new.selected_at    := now();
    new.selected_month := date_trunc('month', timezone('Asia/Kolkata', new.selected_at))::date;
    new.removed_by := null; new.removed_at := null; new.removal_reason := null;
    select o.status, o.assigned_to into v_status, v_salesperson
      from public.orders o where o.id = new.order_id;
    if not found then
      raise exception 'ORDER_NOT_FOUND: That Order no longer exists' using errcode = 'P0002';
    end if;
    if v_status in ('dispatched', 'cancelled') then
      raise exception 'FACTORY_FOCUS_ORDER_CLOSED: a % Order cannot be selected', v_status
        using errcode = 'P0001';
    end if;
    if v_salesperson is distinct from new.selected_by then
      raise exception 'FACTORY_FOCUS_NOT_YOUR_ORDER: the Star Seller picks one of their own Orders'
        using errcode = '42501';
    end if;
    new.salesperson_id := v_salesperson;
    return new;

  elsif tg_op = 'INSERT' then
    -- The owner, and only the owner. auth.uid() is null for a service-role
    -- writer, so the row itself must still NAME the owner.
    if not public.is_permanent_order_approver(new.selected_by) then
      raise exception 'FACTORY_FOCUS_NOT_OWNER: only the owner account may select Factory Focus'
        using errcode = '42501';
    end if;
    if auth.uid() is not null and auth.uid() is distinct from new.selected_by then
      raise exception 'FACTORY_FOCUS_NOT_OWNER: a selection is recorded as the person making it'
        using errcode = '42501';
    end if;

    -- Stamped here, never trusted from the writer.
    new.selected_at    := now();
    new.selected_month := date_trunc('month', timezone('Asia/Kolkata', new.selected_at))::date;
    new.removed_by := null; new.removed_at := null; new.removal_reason := null;

    select o.status, o.assigned_to into v_status, v_salesperson
      from public.orders o where o.id = new.order_id;
    if not found then
      raise exception 'ORDER_NOT_FOUND: That Order no longer exists' using errcode = 'P0002';
    end if;
    if v_status in ('dispatched', 'cancelled') then
      raise exception 'FACTORY_FOCUS_ORDER_CLOSED: a % Order cannot be selected', v_status
        using errcode = 'P0001';
    end if;
    -- Factory Focus recognises a salesperson; an Order with none has nobody to
    -- recognise, and its history would name nobody.
    if v_salesperson is null then
      raise exception 'FACTORY_FOCUS_NO_SALESPERSON: this Order has no salesperson recorded'
        using errcode = 'P0001';
    end if;
    new.salesperson_id := v_salesperson;

    -- THE LIMIT, serialised per month so two racing selections cannot both see
    -- one used. Removed selections still count: a removal does not refund it.
    perform pg_advisory_xact_lock(hashtext('order_factory_focus:' || new.selected_month::text));
    select count(*) into v_used from public.order_factory_focus_selections d
     where d.selected_month = new.selected_month and d.kind = 'owner';
    if v_used >= 2 then
      raise exception 'FACTORY_FOCUS_MONTH_LIMIT: two Orders have already been selected this month'
        using errcode = 'P0001';
    end if;
    return new;

  elsif tg_op = 'UPDATE' then
    if old.removed_at is not null then
      raise exception 'FACTORY_FOCUS_HISTORY: a removed selection cannot be changed' using errcode = 'P0001';
    end if;
    if new.id is distinct from old.id or new.order_id is distinct from old.order_id
       or new.selected_by is distinct from old.selected_by
       or new.selected_at is distinct from old.selected_at
       or new.selected_month is distinct from old.selected_month
       or new.salesperson_id is distinct from old.salesperson_id
       or new.note is distinct from old.note
       or new.kind is distinct from old.kind or new.award_month is distinct from old.award_month then
      raise exception 'FACTORY_FOCUS_HISTORY: a selection may only be removed, never rewritten'
        using errcode = 'P0001';
    end if;
    if new.removed_at is null then
      return new;
    end if;
    if new.removal_reason is null or btrim(new.removal_reason) = '' then
      raise exception 'FACTORY_FOCUS_REASON_REQUIRED: say why Factory Focus is being removed'
        using errcode = 'P0001';
    end if;
    if not public.is_permanent_order_approver(new.removed_by)
       or (auth.uid() is not null and auth.uid() is distinct from new.removed_by) then
      raise exception 'FACTORY_FOCUS_NOT_OWNER: only the owner account may remove Factory Focus'
        using errcode = '42501';
    end if;
    new.removed_at := now();
    return new;

  else -- DELETE
    -- Only the Order's own deletion (test-data cleanup) may take a row with it.
    if pg_trigger_depth() = 1 then
      raise exception 'FACTORY_FOCUS_HISTORY: a selection is never deleted' using errcode = 'P0001';
    end if;
    return old;
  end if;
end;
$$;

do $$
begin
  if to_regprocedure('public.scoreboard_star_seller(date)') is null then
    raise exception 'scoreboard_star_seller must exist';
  end if;
end $$;
