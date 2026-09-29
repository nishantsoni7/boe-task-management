-- ═══════════════════════════════════════════════════════════════════════════
-- ORDERS DASHBOARD: Factory Focus, what needs intervention, revenue, and who
-- may see whose Orders.
--
-- WHAT THIS MIGRATION ADDS
--   1. order_factory_focus_selections   Factory Focus: the Orders the owner has
--                                       selected, append-only history.
--   2. A guard trigger                  owner-only, two NEW selections per IST
--                                       calendar month, manual removal with a
--                                       reason, no automatic hiding.
--   3. select_order_for_factory_focus / remove_order_factory_focus
--                                       the only write paths. Owner only.
--   4. order_visibility_scopes(+members) and set_order_visibility_scope() /
--      list_order_visibility_scopes()   which sales candidates' Orders a sales
--                                       candidate may see: own / own + selected
--                                       / all sales candidates. Owner only.
--   5. sales_scope_allows_order() + ONE extra SELECT policy on public.orders,
--      can_view_order_as_actor() widened by the same branch, and
--      can_view_order_unscoped() — the rule as it was.
--   6. Finance is held where it was: finance_payment_allocations'
--      order-participant policy, can_read_payment_as_participant() and
--      order_linked_payment_total() now ask can_view_order_unscoped(), so a
--      visibility scope reveals Orders and NEVER a payment record.
--   7. orders_dashboard_summary()       the dashboard's one read.
--
-- ADDITIVE except three deliberate re-emissions (5 and 6), each restating the
-- applied rule with the scope branch added or withheld. A user with the default
-- scope ('own', the state of everybody after this migration) sees exactly what
-- they saw before.
--
-- WHO IS "NISHANT". By employee_code TEST-001, through the existing
-- is_permanent_order_approver(uuid). Never by full_name, never by a uuid.
--
-- WHO SEES FACTORY FOCUS. Everybody with Orders module entry. What a card shows
-- follows Order visibility: a reader who may open the Order sees its client and
-- note and gets a link; anybody else sees only the Order number, the salesperson
-- and the month — no client, no price, no link.
--
-- THE DEFINITIONS THE SUMMARY USES (also stated on the dashboard):
--   open Order            status not in ('dispatched', 'cancelled').
--   test data             orders.is_test_data = true is excluded everywhere.
--   not aligned           orders.production_alignment <> 'aligned', said WITH
--                         WHOSE COURT IT IS IN and SINCE WHEN.
--   verified advance %    order_advance_position(). "Below 40%" is its shortfall
--                         > 0. An approved exception is still listed and said.
--   fabric / finish       each judged on its own: the newest order_approval_events
--                         row per kind; a recorded status other than Fully
--                         Approved is pending; no row is NOT RECORDED, a separate
--                         list, never counted as pending. Flagged when
--                         IST today - orders.confirm_date > 15.
--   revenue               product value of each non-cancelled, non-test Order
--                         ONCE, by orders.confirm_date, IST calendar periods:
--                         this month to today; the six completed months before
--                         this month; 1 January to today.
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
     or to_regprocedure('public.assert_order_submission_actor()') is null
     or to_regprocedure('public.is_eligible_order_assignee(uuid)') is null
     or to_regprocedure('public.can_read_payment_as_participant(uuid)') is null
     or to_regprocedure('public.order_linked_payment_total(uuid)') is null then
    raise exception 'DEPENDENCY MISSING: the Orders access helpers';
  end if;
  if to_regclass('public.order_approval_events') is null then
    raise exception 'DEPENDENCY MISSING: order_approval_events (20261227000000)';
  end if;
  if to_regclass('public.order_operations_handoffs') is null
     or to_regclass('public.order_operations_reviewers') is null then
    raise exception 'DEPENDENCY MISSING: the operations handoff (20261229000000)';
  end if;
end $$;

-- ═══ 1. Who is the owner ═════════════════════════════════════════════════════

-- The owner: employee_code TEST-001, and an active account. The one authority
-- that may select or remove Factory Focus and set visibility scopes.
create or replace function public.is_orders_owner()
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
revoke execute on function public.is_orders_owner() from public, anon;
grant  execute on function public.is_orders_owner() to authenticated;
comment on function public.is_orders_owner() is
  'True only for the owner account (employee_code TEST-001) while active. The one authority for Factory Focus and Order visibility scopes. 20270221000000.';

-- ═══ 2. Factory Focus ════════════════════════════════════════════════════════

create table if not exists public.order_factory_focus_selections (
  id               uuid        primary key default gen_random_uuid(),
  order_id         uuid        not null references public.orders(id) on delete cascade,
  selected_by      uuid        not null references public.users(id),
  selected_at      timestamptz not null default now(),
  -- First day of the IST calendar month of selected_at. Stamped by the guard.
  selected_month   date        not null,
  -- The salesperson the Order belongs to AT SELECTION (orders.assigned_to).
  -- Stamped by the guard: the recognition is theirs, whoever holds the Order later.
  salesperson_id   uuid        not null references public.users(id),
  note             text,
  removed_by       uuid        references public.users(id),
  removed_at       timestamptz,
  removal_reason   text,
  constraint order_focus_note_length
    check (note is null or char_length(btrim(note)) between 1 and 200),
  constraint order_focus_removal_reason_length
    check (removal_reason is null or char_length(btrim(removal_reason)) between 1 and 300),
  -- A removal always says why, and only a removal has a reason.
  constraint order_focus_removal_consistency
    check ((removed_by is null) = (removed_at is null)
           and (removed_at is null) = (removal_reason is null)
           and (removed_at is null or removed_at >= selected_at)),
  constraint order_focus_month_is_first_of_month
    check (selected_month = date_trunc('month', selected_month)::date)
);

comment on table public.order_factory_focus_selections is
  'Factory Focus selections, one row each, kept for ever. Active = removed_at is null. Two NEW selections per IST calendar month (a removal does not refund the month''s selection); active selections carry into later months. Removal is manual and needs a reason; nothing removes or hides a selection automatically — not the calendar, not a dispatch, not a cancellation. Written only through select_order_for_factory_focus() / remove_order_factory_focus(), guarded again by the trigger: owner only, append-only. 20270221000000.';

create unique index if not exists order_focus_one_active_per_order
  on public.order_factory_focus_selections (order_id) where removed_at is null;
create index if not exists order_focus_by_month
  on public.order_factory_focus_selections (selected_month);
create index if not exists order_focus_by_salesperson
  on public.order_factory_focus_selections (salesperson_id);

alter table public.order_factory_focus_selections enable row level security;
revoke all on table public.order_factory_focus_selections from public, anon, authenticated;
-- No policy and no grant: nothing reads or writes this table except the
-- definer functions below.

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
  if tg_op = 'INSERT' then
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
     where d.selected_month = new.selected_month;
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
       or new.note is distinct from old.note then
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
revoke execute on function public.order_factory_focus_guard() from public, anon, authenticated, service_role;
comment on function public.order_factory_focus_guard() is
  'Owner-only authority, the two-new-per-IST-month limit (removed ones count), stamped time/month/salesperson, a required removal reason, and append-only history for order_factory_focus_selections, for every writer. 20270221000000.';

drop trigger if exists order_factory_focus_guard on public.order_factory_focus_selections;
create trigger order_factory_focus_guard
  before insert or update or delete on public.order_factory_focus_selections
  for each row execute function public.order_factory_focus_guard();

create or replace function public.select_order_for_factory_focus(p_order_id uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.assert_order_submission_actor();
  v_note  text := nullif(btrim(coalesce(p_note, '')), '');
  v_id    uuid;
begin
  if not public.is_orders_owner() then
    raise exception 'FACTORY_FOCUS_NOT_OWNER: only the owner account may select Factory Focus'
      using errcode = '42501';
  end if;
  if v_note is not null and char_length(v_note) > 200 then
    raise exception 'FACTORY_FOCUS_NOTE_TOO_LONG: the note may be at most 200 characters (this one is %)',
      char_length(v_note) using errcode = 'P0001';
  end if;
  -- Serialise on the Order so a second press sees the first.
  perform 1 from public.orders o where o.id = p_order_id for update;
  if not found then
    raise exception 'ORDER_NOT_FOUND: That Order no longer exists' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.order_factory_focus_selections d
              where d.order_id = p_order_id and d.removed_at is null) then
    raise exception 'FACTORY_FOCUS_ALREADY_ACTIVE: this Order is already in Factory Focus' using errcode = 'P0001';
  end if;

  -- salesperson_id and selected_month are stamped by the guard.
  insert into public.order_factory_focus_selections (order_id, selected_by, note, selected_month, salesperson_id)
  values (p_order_id, v_actor, v_note, date '2000-01-01', v_actor)
  returning id into v_id;

  return jsonb_build_object('selection_id', v_id, 'order_id', p_order_id);
end;
$$;
revoke execute on function public.select_order_for_factory_focus(uuid, text) from public, anon;
grant  execute on function public.select_order_for_factory_focus(uuid, text) to authenticated;
comment on function public.select_order_for_factory_focus(uuid, text) is
  'Select an open Order for Factory Focus. Owner only; two NEW selections per IST calendar month; refuses a closed, already-selected or salesperson-less Order. 20270221000000.';

create or replace function public.remove_order_factory_focus(p_selection_id uuid, p_reason text)
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
  if not public.is_orders_owner() then
    raise exception 'FACTORY_FOCUS_NOT_OWNER: only the owner account may remove Factory Focus'
      using errcode = '42501';
  end if;
  if v_reason is null then
    raise exception 'FACTORY_FOCUS_REASON_REQUIRED: say why Factory Focus is being removed'
      using errcode = 'P0001';
  end if;
  if char_length(v_reason) > 300 then
    raise exception 'FACTORY_FOCUS_REASON_TOO_LONG: the reason may be at most 300 characters (this one is %)',
      char_length(v_reason) using errcode = 'P0001';
  end if;
  update public.order_factory_focus_selections d
     set removed_by = v_actor, removed_at = now(), removal_reason = v_reason
   where d.id = p_selection_id and d.removed_at is null
  returning d.order_id into v_order;
  if v_order is null then
    raise exception 'FACTORY_FOCUS_NOT_ACTIVE: that selection is not active' using errcode = 'P0001';
  end if;
  return jsonb_build_object('selection_id', p_selection_id, 'order_id', v_order);
end;
$$;
revoke execute on function public.remove_order_factory_focus(uuid, text) from public, anon;
grant  execute on function public.remove_order_factory_focus(uuid, text) to authenticated;
comment on function public.remove_order_factory_focus(uuid, text) is
  'Take an Order out of Factory Focus, recording who, when and why. Owner only; the reason is required and is shown to the Order''s salesperson. The selection stays in history and still counts toward its month. 20270221000000.';

-- ═══ 3. Order visibility scopes ══════════════════════════════════════════════
--
-- Per sales CANDIDATE (is_eligible_order_assignee: the sales team, or a holder
-- of orders.can_be_order_assignee), one of:
--   own          only Orders they are on (the rule everybody has today)
--   selected     their own plus Orders of the selected sales candidates
--   all_sales    their own plus Orders of every sales candidate
-- An Order "belongs" to a candidate when assigned_to or requested_by is them.

create table if not exists public.order_visibility_scopes (
  user_id uuid primary key references public.users(id) on delete cascade,
  mode    text not null default 'own' check (mode in ('own', 'selected', 'all_sales')),
  set_by  uuid references public.users(id),
  set_at  timestamptz not null default now()
);
create table if not exists public.order_visibility_scope_members (
  user_id   uuid not null references public.order_visibility_scopes(user_id) on delete cascade,
  member_id uuid not null references public.users(id) on delete cascade,
  primary key (user_id, member_id),
  constraint order_scope_not_self check (user_id <> member_id)
);
comment on table public.order_visibility_scopes is
  'Which sales candidates'' Orders a sales candidate may see, beyond their own. Written only by set_order_visibility_scope() (owner only). Absence of a row means own. 20270221000000.';

alter table public.order_visibility_scopes enable row level security;
alter table public.order_visibility_scope_members enable row level security;
revoke all on table public.order_visibility_scopes from public, anon, authenticated;
revoke all on table public.order_visibility_scope_members from public, anon, authenticated;

-- May the CALLER see an Order that belongs to (assigned_to, requested_by),
-- through their scope? Definer, so it reads the scope tables that no client can.
create or replace function public.sales_scope_allows_order(p_assigned_to uuid, p_requested_by uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    auth.uid() is not null
    and exists (
      select 1 from public.order_visibility_scopes s
       where s.user_id = auth.uid()
         and s.mode <> 'own'
         and public.is_eligible_order_assignee(auth.uid())
         and (
           (s.mode = 'all_sales'
             and ((p_assigned_to is not null  and public.is_eligible_order_assignee(p_assigned_to))
               or (p_requested_by is not null and public.is_eligible_order_assignee(p_requested_by))))
           or
           (s.mode = 'selected'
             and exists (select 1 from public.order_visibility_scope_members m
                          where m.user_id = s.user_id
                            and (m.member_id = p_assigned_to or m.member_id = p_requested_by)))
         )),
    false);
$$;
revoke execute on function public.sales_scope_allows_order(uuid, uuid) from public, anon;
grant  execute on function public.sales_scope_allows_order(uuid, uuid) to authenticated;
comment on function public.sales_scope_allows_order(uuid, uuid) is
  'Whether the caller''s Order visibility scope (own / selected / all_sales) covers an Order belonging to these people. False for everybody with the default scope. 20270221000000.';

-- The scope is an ORDERS grant: one more permissive SELECT policy. Update and
-- delete policies are untouched, so seeing an Order confers no edit.
drop policy if exists orders_sales_scope_select on public.orders;
create policy orders_sales_scope_select on public.orders
  for select to authenticated
  using (public.sales_scope_allows_order(assigned_to, requested_by));

-- The rule as it stood (20261006000000), under a name that says what it is, so
-- Finance can keep asking it.
create or replace function public.can_view_order_unscoped(p_order_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.orders o
     where o.id = p_order_id
       and public.module_entry_open('orders')
       and (
         exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin')
         or exists (select 1 from public.users u where u.id = auth.uid() and u.team = 'operations')
         or o.requested_by = auth.uid()
         or o.assigned_to  = auth.uid()
         or public.resolve_permission(auth.uid(), 'orders', 'view_all')
       )
  );
$$;
revoke all on function public.can_view_order_unscoped(uuid) from public, anon, service_role;
grant execute on function public.can_view_order_unscoped(uuid) to authenticated;
comment on function public.can_view_order_unscoped(uuid) is
  'May the caller see this Order WITHOUT any visibility scope: admin, operations, their own, or orders.view_all. What Finance asks, so a scope reveals Orders and never a payment. 20270221000000.';

-- The Orders-side predicate: the same, plus the caller's scope.
create or replace function public.can_view_order_as_actor(p_order_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.can_view_order_unscoped(p_order_id)
      or exists (
        select 1 from public.orders o
         where o.id = p_order_id
           and public.module_entry_open('orders')
           and public.sales_scope_allows_order(o.assigned_to, o.requested_by));
$$;

-- FINANCE STAYS WHERE IT WAS. Both were 20261006000000's bodies asking
-- can_view_order_as_actor; they now ask the unscoped rule.
create or replace function public.can_read_payment_as_participant(p_payment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.finance_payment_allocations a
    where a.payment_request_id = p_payment_id
      and (
        (a.order_submission_id is not null
         and public.module_entry_open('orders')
         and public.can_view_order_submission(a.order_submission_id))
        or
        (a.order_id is not null
         and public.can_view_order_unscoped(a.order_id))
      )
  );
$$;

create or replace function public.order_linked_payment_total(p_order_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when public.can_view_order_unscoped(p_order_id) or auth.uid() is null
    then coalesce((
      select sum(a.allocated_amount)
        from public.finance_payment_allocations a
        join public.finance_payment_requests f on f.id = a.payment_request_id
       where a.order_id = p_order_id
         and a.status = 'active'
         and public.finance_payment_status_is_verified(f.status)
    ), 0)
  end;
$$;

-- The one Finance policy that read public.orders under the CALLER's row
-- security, and so would have followed the new policy.
drop policy if exists finance_payment_allocations_order_participant_select on public.finance_payment_allocations;
create policy finance_payment_allocations_order_participant_select
  on public.finance_payment_allocations
  for select to authenticated
  using (order_id is not null and public.can_view_order_unscoped(order_id));

create or replace function public.set_order_visibility_scope(
  p_user_id    uuid,
  p_mode       text,
  p_member_ids uuid[] default '{}'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor   uuid := public.assert_order_submission_actor();
  v_members uuid[] := coalesce((select array_agg(distinct m) from unnest(coalesce(p_member_ids, '{}')) m), '{}');
  v_m       uuid;
begin
  if not public.is_orders_owner() then
    raise exception 'ORDER_SCOPE_NOT_OWNER: only the owner account may set Order visibility'
      using errcode = '42501';
  end if;
  if p_mode is null or p_mode not in ('own', 'selected', 'all_sales') then
    raise exception 'ORDER_SCOPE_MODE_UNKNOWN: choose own, selected or all_sales' using errcode = 'P0001';
  end if;
  if not public.is_eligible_order_assignee(p_user_id) then
    raise exception 'ORDER_SCOPE_NOT_A_CANDIDATE: only a sales candidate has an Order visibility scope'
      using errcode = 'P0001';
  end if;
  if p_mode = 'selected' then
    if coalesce(array_length(v_members, 1), 0) = 0 then
      raise exception 'ORDER_SCOPE_MEMBERS_REQUIRED: choose at least one sales candidate' using errcode = 'P0001';
    end if;
    foreach v_m in array v_members loop
      if v_m = p_user_id then
        raise exception 'ORDER_SCOPE_SELF: a person''s own Orders are always included' using errcode = 'P0001';
      end if;
      if not public.is_eligible_order_assignee(v_m) then
        raise exception 'ORDER_SCOPE_NOT_A_CANDIDATE: % is not a sales candidate', v_m using errcode = 'P0001';
      end if;
    end loop;
  else
    v_members := '{}';
  end if;

  insert into public.order_visibility_scopes as s (user_id, mode, set_by, set_at)
  values (p_user_id, p_mode, v_actor, now())
  on conflict (user_id) do update set mode = excluded.mode, set_by = excluded.set_by, set_at = excluded.set_at;

  delete from public.order_visibility_scope_members where user_id = p_user_id;
  if coalesce(array_length(v_members, 1), 0) > 0 then
    insert into public.order_visibility_scope_members (user_id, member_id)
    select p_user_id, m from unnest(v_members) m;
  end if;

  return jsonb_build_object('user_id', p_user_id, 'mode', p_mode, 'member_ids', to_jsonb(v_members));
end;
$$;
revoke execute on function public.set_order_visibility_scope(uuid, text, uuid[]) from public, anon;
grant  execute on function public.set_order_visibility_scope(uuid, text, uuid[]) to authenticated;
comment on function public.set_order_visibility_scope(uuid, text, uuid[]) is
  'Set one sales candidate''s Order visibility: own, selected (with members) or all_sales. Owner only. 20270221000000.';

create or replace function public.list_order_visibility_scopes()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.assert_order_submission_actor();
  if not public.is_orders_owner() then
    raise exception 'ORDER_SCOPE_NOT_OWNER: only the owner account may see Order visibility settings'
      using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'user_id', u.id, 'full_name', u.full_name,
             'mode', coalesce(s.mode, 'own'),
             'member_ids', coalesce((select jsonb_agg(m.member_id) from public.order_visibility_scope_members m where m.user_id = u.id), '[]'::jsonb))
           order by u.full_name)
      from public.users u
      left join public.order_visibility_scopes s on s.user_id = u.id
     where public.is_eligible_order_assignee(u.id)), '[]'::jsonb);
end;
$$;
revoke execute on function public.list_order_visibility_scopes() from public, anon;
grant  execute on function public.list_order_visibility_scopes() to authenticated;
comment on function public.list_order_visibility_scopes() is
  'Every sales candidate with their Order visibility scope. Owner only. 20270221000000.';

-- ═══ 4. The dashboard read ═══════════════════════════════════════════════════
--
-- ONE ROUND TRIP, ONE STATEMENT, over the Orders the caller may open
-- (can_view_order_as_actor — scope included), so a count is never a number for
-- records the reader cannot see. Anything that cannot be assessed is COUNTED in
-- `gaps` rather than treated as zero or as "all clear".

create or replace function public.orders_dashboard_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor      uuid := public.assert_order_submission_actor();
  v_now        timestamptz := now();
  v_today      date := timezone('Asia/Kolkata', now())::date;
  v_month_from date := date_trunc('month', timezone('Asia/Kolkata', now()))::date;
  -- The six COMPLETED calendar months before this one.
  v_six_from   date := (date_trunc('month', timezone('Asia/Kolkata', now())) - interval '6 months')::date;
  v_six_to     date := (date_trunc('month', timezone('Asia/Kolkata', now()))::date - 1);
  v_year_from  date := date_trunc('year', timezone('Asia/Kolkata', now()))::date;
  v_sees_all   boolean;
  v_owner      boolean := public.is_orders_owner();
  v_result     jsonb;
begin
  if not public.module_entry_open('orders') then
    raise exception 'The Orders module is not open to this account' using errcode = '42501';
  end if;

  -- Company-wide revenue is only ever offered to somebody who sees EVERY
  -- Order: an active admin or a holder of orders.view_all. A visibility scope
  -- never counts: it widens Orders, not money.
  v_sees_all :=
    exists (select 1 from public.users u
             where u.id = v_actor and u.role = 'admin' and u.is_active
               and coalesce(u.is_deleted, false) = false)
    or coalesce(public.resolve_permission(v_actor, 'orders', 'view_all'), false);

  with open_orders as materialized (
    select o.id, o.display_number, o.client_name, o.status, o.confirm_date, o.created_at,
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
  reviewer as (
    select r.user_id, u.full_name
      from public.order_operations_reviewers r
      left join public.users u on u.id = r.user_id
     where r.duty = 'pi_handoff'
  ),
  aligned as (
    -- WHOSE COURT IT IS IN, and SINCE WHEN. An order flagged for clarification
    -- is waiting on the approver, an order held for advance on the money, an
    -- order with no reviewer on an administrator: none of them is "waiting for
    -- the reviewer", and none is called that.
    select coalesce(jsonb_agg(x order by (x ->> 'rank')::int, (x ->> 'waiting_seconds')::numeric desc, x ->> 'display_number'), '[]'::jsonb) j
    from (
      select jsonb_build_object(
               'order_id', d.id, 'display_number', d.display_number, 'client_name', d.client_name,
               'status', d.status,
               'state', st.state,
               'waiting_on', case st.state
                   when 'awaiting_reviewer'     then 'reviewer'
                   when 'awaiting_unassigned'   then 'administrator'
                   when 'clarification_needed'  then 'approver'
                   when 'held_advance'          then 'payment'
                   when 'accepted_not_aligned'  then 'reviewer'
                   else 'legacy' end,
               'rank', case st.state
                   when 'awaiting_reviewer' then 1 when 'accepted_not_aligned' then 2
                   when 'awaiting_unassigned' then 3 when 'clarification_needed' then 4
                   when 'held_advance' then 5 else 6 end,
               'since', st.since,
               'waiting_seconds', greatest(extract(epoch from (v_now - st.since)), 0),
               'detail', case when st.state = 'clarification_needed' then h.clarification_reason end,
               'advance_blocks', not coalesce((p.pos ->> 'ready')::boolean, false)) as x
        from open_orders d
        join pos p on p.order_id = d.id
        left join lateral (
          select oh.status, oh.assigned_to, oh.approved_at, oh.clarification_reason, oh.clarification_at, oh.accepted_at
            from public.order_operations_handoffs oh
           where oh.order_id = d.id and oh.superseded_at is null
           order by oh.created_at desc limit 1) h on true
        cross join lateral (
          select case
                   when h.status = 'clarification_needed' then 'clarification_needed'
                   when h.status = 'awaiting' and h.assigned_to is null then 'awaiting_unassigned'
                   when h.status = 'awaiting' then 'awaiting_reviewer'
                   when jsonb_typeof(p.pos -> 'hold') = 'object' then 'held_advance'
                   when h.status = 'accepted' then 'accepted_not_aligned'
                   else 'no_handoff' end as state,
                 case
                   when h.status = 'clarification_needed' then coalesce(h.clarification_at, h.approved_at)
                   when h.status = 'awaiting' then h.approved_at
                   when jsonb_typeof(p.pos -> 'hold') = 'object' then (p.pos -> 'hold' ->> 'held_at')::timestamptz
                   when h.status = 'accepted' then h.accepted_at
                   else d.created_at end as since) st
       where d.production_alignment is distinct from 'aligned'
    ) s
  ),
  advance as (
    -- Verified advance below 40%: the gate's own shortfall > 0. An approved
    -- exception does NOT remove an order: it is listed, and said.
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
  ff_status as (
    -- Fabric and finish, each on its own. A recorded status other than Fully
    -- Approved is PENDING; no recorded status at all is NOT RECORDED — a
    -- historical gap, never a confirmed pending. Only orders more than 15 days
    -- past the client confirmation date.
    select d.id, d.display_number, d.client_name, d.status, d.confirm_date,
           (v_today - d.confirm_date) as days_since,
           k.kind, k.recorded_status
      from open_orders d
     cross join lateral (
       select kinds.kind,
              (select e.status from public.order_approval_events e
                where e.order_id = d.id and e.approval_kind = kinds.kind
                order by e.created_at desc, e.id desc limit 1) as recorded_status
         from (values ('fabric'), ('finish')) as kinds(kind)) k
     where d.confirm_date is not null and (v_today - d.confirm_date) > 15
  ),
  fabric_pending as (
    select coalesce(jsonb_agg(x order by (x ->> 'days_since_confirmation')::int desc, x ->> 'display_number'), '[]'::jsonb) j
    from (
      select jsonb_build_object(
               'order_id', f.id, 'display_number', f.display_number, 'client_name', f.client_name,
               'status', f.status, 'confirm_date', f.confirm_date,
               'days_since_confirmation', max(f.days_since),
               'pending', jsonb_agg(jsonb_build_object('kind', f.kind, 'status', f.recorded_status) order by f.kind)
                            filter (where f.recorded_status is not null and f.recorded_status <> 'fully_approved'),
               'not_recorded', coalesce(jsonb_agg(f.kind order by f.kind) filter (where f.recorded_status is null), '[]'::jsonb)) as x
        from ff_status f
       group by f.id, f.display_number, f.client_name, f.status, f.confirm_date
      having count(*) filter (where f.recorded_status is not null and f.recorded_status <> 'fully_approved') > 0
    ) s
  ),
  fabric_unrecorded as (
    select coalesce(jsonb_agg(x order by (x ->> 'days_since_confirmation')::int desc, x ->> 'display_number'), '[]'::jsonb) j
    from (
      select jsonb_build_object(
               'order_id', f.id, 'display_number', f.display_number, 'client_name', f.client_name,
               'status', f.status, 'confirm_date', f.confirm_date,
               'days_since_confirmation', max(f.days_since),
               'not_recorded', jsonb_agg(f.kind order by f.kind) filter (where f.recorded_status is null)) as x
        from ff_status f
       group by f.id, f.display_number, f.client_name, f.status, f.confirm_date
      having count(*) filter (where f.recorded_status is null) > 0
         and count(*) filter (where f.recorded_status is not null and f.recorded_status <> 'fully_approved') = 0
    ) s
  ),
  gaps as (
    select jsonb_build_object(
             'open_orders', (select count(*) from open_orders),
             'advance_value_unknown', (select count(*) from pos p
                                        where not coalesce((p.pos ->> 'value_known')::boolean, false)),
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
             'last_six_months', jsonb_build_object('from', v_six_from, 'to', v_six_to,
               'amount', coalesce(sum(pv) filter (where confirm_date between v_six_from and v_six_to), 0),
               'orders', count(*) filter (where confirm_date between v_six_from and v_six_to and pv is not null)),
             'current_year', jsonb_build_object('from', v_year_from, 'to', v_today,
               'amount', coalesce(sum(pv) filter (where confirm_date between v_year_from and v_today), 0),
               'orders', count(*) filter (where confirm_date between v_year_from and v_today and pv is not null)),
             'gaps', jsonb_build_object(
               'no_confirm_date', count(*) filter (where confirm_date is null),
               'future_confirm_date', count(*) filter (where confirm_date > v_today),
               -- In a period but with no product value on record: excluded, and said.
               'no_product_value_in_year', count(*) filter (where confirm_date between v_year_from and v_today and pv is null),
               -- Still the figure BEFORE the PI's discount (amended away from the PI).
               'before_discount_in_year', count(*) filter (where confirm_date between v_year_from and v_today and before_discount))) j
      from rev
    having v_sees_all
  ),
  focus as (
    -- Factory Focus: everybody with Orders entry sees WHICH Orders; what else
    -- they see follows Order visibility. No client, no note, no link, no status
    -- for an Order the reader cannot open.
    select jsonb_build_object(
      'active', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'selection_id', d.id,
                 'display_number', o.display_number,
                 'selected_month', d.selected_month,
                 'selected_at', d.selected_at,
                 'salesperson_name', sp.full_name,
                 'can_open', can_open.v,
                 'order_id', case when can_open.v then o.id end,
                 'client_name', case when can_open.v then o.client_name end,
                 'status', case when can_open.v then o.status end,
                 'note', case when can_open.v then d.note end) order by d.selected_at)
          from public.order_factory_focus_selections d
          join public.orders o on o.id = d.order_id
          left join public.users sp on sp.id = d.salesperson_id
          cross join lateral (select public.can_view_order_as_actor(o.id) as v) can_open
         where d.removed_at is null
           and coalesce(o.is_test_data, false) = false), '[]'::jsonb),
      -- The removal reason goes to the Order's salesperson, for a month.
      'removed_for_you', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'display_number', o.display_number,
                 'selected_month', d.selected_month,
                 'removed_at', d.removed_at,
                 'removal_reason', d.removal_reason) order by d.removed_at desc)
          from public.order_factory_focus_selections d
          join public.orders o on o.id = d.order_id
         where d.removed_at is not null
           and d.salesperson_id = v_actor
           and d.removed_at > v_now - interval '30 days'), '[]'::jsonb),
      'month_start', v_month_from,
      'month_used', case when v_owner then
          (select count(*) from public.order_factory_focus_selections d where d.selected_month = v_month_from) end,
      'month_limit', 2,
      'can_manage', v_owner) j
  )
  select jsonb_build_object(
    'today', v_today,
    'now', v_now,
    'viewer', jsonb_build_object(
      'sees_all_orders', v_sees_all,
      'can_view_revenue', v_sees_all,
      'can_manage_focus', v_owner),
    'alignment_reviewer', (select jsonb_build_object('user_id', user_id, 'name', full_name) from reviewer),
    'groups', jsonb_build_object(
      'not_aligned', (select j from aligned),
      'advance_below_40', (select j from advance),
      'fabric_finish_pending', (select j from fabric_pending),
      'fabric_finish_unrecorded', (select j from fabric_unrecorded)),
    'gaps', (select j from gaps),
    'revenue', (select j from revenue),
    'factory_focus', (select j from focus))
  into v_result;

  return v_result;
end;
$$;
revoke execute on function public.orders_dashboard_summary() from public, anon;
grant  execute on function public.orders_dashboard_summary() to authenticated;
comment on function public.orders_dashboard_summary() is
  'Everything the Orders dashboard draws, in one read: Factory Focus (visibility-aware), Orders not aligned for manufacturing with whose court each is in and since when, advance below 40%, fabric/finish pending and not recorded, gaps, and product-value revenue (callers who see every Order only). 20270221000000.';

-- ═══ 5. It took ═════════════════════════════════════════════════════════════

do $$
begin
  if to_regprocedure('public.orders_dashboard_summary()') is null
     or to_regprocedure('public.select_order_for_factory_focus(uuid, text)') is null
     or to_regprocedure('public.remove_order_factory_focus(uuid, text)') is null
     or to_regprocedure('public.set_order_visibility_scope(uuid, text, uuid[])') is null
     or to_regprocedure('public.can_view_order_unscoped(uuid)') is null
     or to_regclass('public.order_factory_focus_selections') is null then
    raise exception 'VERIFY: the Factory Focus / visibility objects were not created';
  end if;
  if has_table_privilege('authenticated', 'public.order_factory_focus_selections', 'select')
     or has_table_privilege('anon', 'public.order_factory_focus_selections', 'select')
     or has_table_privilege('authenticated', 'public.order_visibility_scopes', 'select')
     or has_table_privilege('authenticated', 'public.order_visibility_scope_members', 'select') then
    raise exception 'VERIFY: the Factory Focus and scope tables must not be readable by a client role';
  end if;
  -- The Finance policy must have moved off the scope-aware rule.
  if not exists (select 1 from pg_policies
                  where tablename = 'finance_payment_allocations'
                    and policyname = 'finance_payment_allocations_order_participant_select'
                    and qual like '%can_view_order_unscoped%') then
    raise exception 'VERIFY: the allocation policy still follows the scope-aware rule';
  end if;
end $$;
