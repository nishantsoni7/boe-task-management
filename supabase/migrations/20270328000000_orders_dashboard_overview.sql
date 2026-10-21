-- ORDERS DASHBOARD OVERVIEW (20270328000000)
--
-- The dashboard told a reader nothing until an Order was already wrong. This adds
-- one more key, `overview`, to the SAME single read (no second round trip, so the
-- startup-shape pin does not move): how many Orders are running, aligned for
-- manufacturing, DELAYED (due date before today, IST), due in the next 7 days, and
-- carrying payments awaiting verification, each with its product value, plus the
-- delayed / due-soon / aligned lists. Nothing existing changes: every other key
-- keeps its meaning. Same visibility rule as before (can_read_order_detail;
-- payment figures only for an Order readable without a visibility scope).

-- orders_dashboard_summary: previous definition 20270227000000_order_submission_advance_on_total_before_gst.sql
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
           o.total_value, o.production_alignment, o.due_date, o.assigned_to,
           -- Product value, excl. GST; NULL or NaN counts as no figure, never as a number.
           case when o.total_product_value is null or o.total_product_value = 'NaN'::numeric
                then null else o.total_product_value end as product_value,
           -- PAYMENT-DERIVED FIGURES (verified %, shortfall, exceptions) are shown only for an
           -- Order the reader may open WITHOUT a visibility scope. A scope widens Orders, not money.
           public.can_view_order_unscoped(o.id) as full_view
      from public.orders o
     where coalesce(o.is_test_data, false) = false
       and o.status not in ('dispatched', 'cancelled')
       and public.can_read_order_detail(o.id)
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
               -- A payment-derived flag: withheld for an Order seen only through a scope.
               'advance_blocks', d.full_view and not coalesce((p.pos ->> 'ready')::boolean, false)) as x
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
               -- 20270227000000: the percentage and the shortfall are of the TOTAL
               -- BEFORE GST (advance_base), not of order_value.
               'advance_base', p.pos -> 'advance_base',
               'verified', p.pos -> 'verified',
               -- Truncated, never rounded up: 39.996% must not read "40.00%"
               -- beside a shortfall.
               'percent', trunc(100 * (p.pos ->> 'verified')::numeric / nullif((p.pos ->> 'advance_base')::numeric, 0), 2),
               'shortfall', p.pos -> 'shortfall',
               'exception_approved', (jsonb_typeof(p.pos -> 'exception') = 'object'),
               'held', (jsonb_typeof(p.pos -> 'hold') = 'object')) as x
        from open_orders d join pos p on p.order_id = d.id
       where d.full_view
         and coalesce((p.pos ->> 'value_known')::boolean, false)
         and coalesce((p.pos ->> 'shortfall')::numeric, 0) > 0
    ) s
  ),
  ff_status as (
    -- Fabric and finish, each on its own, for Orders more than 15 days past the
    -- client confirmation date. A recorded status other than Fully Approved is
    -- PENDING. No record at all is PENDING too for an Order created since tracking
    -- began (approval is required and has not been given: 'no_approval_recorded'),
    -- and NOT RECORDED — ambiguous history — for an older Order.
    select d.id, d.display_number, d.client_name, d.status, d.confirm_date,
           (v_today - d.confirm_date) as days_since,
           k.kind,
           coalesce(k.recorded_status,
                    case when d.created_at >= (select st.fabric_finish_tracking_from from public.orders_dashboard_settings st where st.id)
                         then 'no_approval_recorded' end) as effective_status
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
               'pending', jsonb_agg(jsonb_build_object('kind', f.kind, 'status', f.effective_status) order by f.kind)
                            filter (where f.effective_status is not null and f.effective_status <> 'fully_approved'),
               'not_recorded', coalesce(jsonb_agg(f.kind order by f.kind) filter (where f.effective_status is null), '[]'::jsonb)) as x
        from ff_status f
       group by f.id, f.display_number, f.client_name, f.status, f.confirm_date
      having count(*) filter (where f.effective_status is not null and f.effective_status <> 'fully_approved') > 0
    ) s
  ),
  fabric_unrecorded as (
    select coalesce(jsonb_agg(x order by (x ->> 'days_since_confirmation')::int desc, x ->> 'display_number'), '[]'::jsonb) j
    from (
      select jsonb_build_object(
               'order_id', f.id, 'display_number', f.display_number, 'client_name', f.client_name,
               'status', f.status, 'confirm_date', f.confirm_date,
               'days_since_confirmation', max(f.days_since),
               'not_recorded', jsonb_agg(f.kind order by f.kind) filter (where f.effective_status is null)) as x
        from ff_status f
       group by f.id, f.display_number, f.client_name, f.status, f.confirm_date
      having count(*) filter (where f.effective_status is null) > 0
         and count(*) filter (where f.effective_status is not null and f.effective_status <> 'fully_approved') = 0
    ) s
  ),
  schedule as (
    -- THE SCHEDULE: one row per open Order with its due date read against today (IST).
    -- Overdue is "due before today"; due soon is today through the next seven days.
    select d.id, d.display_number, d.client_name, d.status, d.due_date, d.product_value,
           d.production_alignment, d.full_view,
           sp.full_name as salesperson,
           (d.due_date < v_today) as overdue,
           (d.due_date between v_today and v_today + 7) as soon,
           (v_today - d.due_date) as days_late,
           (d.due_date - v_today) as days_left,
           coalesce((p.pos ->> 'awaiting')::numeric, 0) as awaiting_amount,
           -- Short of the 40% advance, by the gate's own shortfall (the advance list's rule).
           case when coalesce((p.pos ->> 'value_known')::boolean, false)
                then greatest(coalesce((p.pos ->> 'shortfall')::numeric, 0), 0) else 0 end as advance_short
      from open_orders d
      join pos p on p.order_id = d.id
      left join public.users sp on sp.id = d.assigned_to
  ),
  overview as (
    select jsonb_build_object(
      'running', jsonb_build_object(
        'orders', count(*), 'value', coalesce(sum(product_value), 0)),
      'aligned', jsonb_build_object(
        'orders', count(*) filter (where production_alignment = 'aligned'),
        'value', coalesce(sum(product_value) filter (where production_alignment = 'aligned'), 0)),
      'delayed', jsonb_build_object(
        'orders', count(*) filter (where overdue),
        'value', coalesce(sum(product_value) filter (where overdue), 0),
        'max_days_late', coalesce(max(days_late) filter (where overdue), 0)),
      'due_soon', jsonb_build_object(
        'orders', count(*) filter (where soon),
        'value', coalesce(sum(product_value) filter (where soon), 0)),
      'no_due_date', count(*) filter (where due_date is null),
      -- PAYMENT FIGURES follow the same rule as the advance list: only for an Order the
      -- reader may open without a visibility scope.
      'payments_awaiting_verification', jsonb_build_object(
        'orders', count(*) filter (where full_view and awaiting_amount > 0),
        'amount', coalesce(sum(awaiting_amount) filter (where full_view), 0)),
      'advance_short', jsonb_build_object(
        'orders', count(*) filter (where full_view and advance_short > 0),
        'amount', coalesce(sum(advance_short) filter (where full_view), 0)),
      'delayed_list', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'order_id', s.id, 'display_number', s.display_number, 'client_name', s.client_name,
                 'status', s.status, 'salesperson', s.salesperson, 'due_date', s.due_date,
                 'days_late', s.days_late, 'value', s.product_value)
               order by s.days_late desc, s.display_number)
          from schedule s where s.overdue), '[]'::jsonb),
      'due_soon_list', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'order_id', s.id, 'display_number', s.display_number, 'client_name', s.client_name,
                 'status', s.status, 'salesperson', s.salesperson, 'due_date', s.due_date,
                 'days_left', s.days_left, 'value', s.product_value,
                 'aligned', s.production_alignment = 'aligned')
               order by s.due_date, s.display_number)
          from schedule s where s.soon), '[]'::jsonb),
      'aligned_list', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'order_id', s.id, 'display_number', s.display_number, 'client_name', s.client_name,
                 'status', s.status, 'salesperson', s.salesperson, 'due_date', s.due_date,
                 'value', s.product_value)
               order by s.due_date nulls last, s.display_number)
          from schedule s where s.production_alignment = 'aligned'), '[]'::jsonb)) j
      from schedule
  ),
  gaps as (
    select jsonb_build_object(
             'open_orders', (select count(*) from open_orders),
             'advance_value_unknown', (select count(*) from pos p join open_orders d on d.id = p.order_id
                                        where d.full_view and not coalesce((p.pos ->> 'value_known')::boolean, false)),
             'advance_outside_scope', (select count(*) from open_orders where not full_view),
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
          cross join lateral (select public.can_read_order_detail(o.id) as v) can_open
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
    'overview', (select j from overview),
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
  'Everything the Orders dashboard draws, in one read: overview (running, aligned, delayed, due soon, payments awaiting verification, with lists), Factory Focus, not aligned, advance below 40%, fabric/finish pending, gaps and revenue. 20270328000000.';

do $verify$
begin
  if pg_get_functiondef('public.orders_dashboard_summary()'::regprocedure) !~ 'overview' then
    raise exception 'VERIFY: orders_dashboard_summary() does not carry the overview';
  end if;
  if not has_function_privilege('authenticated', 'public.orders_dashboard_summary()', 'execute')
     or has_function_privilege('anon', 'public.orders_dashboard_summary()', 'execute') then
    raise exception 'VERIFY: orders_dashboard_summary() grants are wrong';
  end if;
end $verify$;
