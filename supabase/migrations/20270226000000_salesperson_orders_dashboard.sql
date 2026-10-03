-- ═══════════════════════════════════════════════════════════════════════════
-- 20270226000000  THE SALESPERSON'S OWN ORDERS DASHBOARD — one read
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS IS
-- ------------
-- public.salesperson_orders_dashboard() returns everything the personal Orders
-- dashboard draws, in one round trip, for THE CALLER ONLY: three figures (all-time
-- confirmed orders, current-month revenue, orders pending approval) and four
-- complete lists (pending approval, advance below 40%, fabric/finish pending,
-- ready for dispatch).
--
-- WHY A NEW FUNCTION, NOT orders_dashboard_summary()
-- --------------------------------------------------
-- orders_dashboard_summary() answers a different question: the orders THIS READER
-- MAY OPEN (including any visibility scope), for intervention by management. The
-- personal dashboard is the orders THIS READER OWNS, whatever else they can open,
-- and it lists records that function leaves out (pending submissions, ready for
-- dispatch) and applies no 15-day filter. That function is NOT changed; the
-- Admin / Finance / operations dashboard keeps reading it.
--
-- OWNERSHIP
-- ---------
--   confirmed Order   orders.assigned_to      — "the salesperson the Order belongs to"
--                     (what Factory Focus and approve_order_submission call it;
--                     NOT created_by, NOT requested_by)
--   pending PI        order_submissions.salesperson_id (20270211000000), chosen by
--                     Sales on the draft. NOT assigned_to (that is the PI's reviewer).
--                     A submitted PI with no salesperson_id has no owner to show it
--                     to and is in nobody's dashboard.
--
-- WHO GETS IT
-- -----------
-- "Salesperson" is not a role. The caller is offered this dashboard when they are
-- an eligible order assignee (is_eligible_order_assignee: the sales team, or
-- orders.can_be_order_assignee) and are NOT an admin and NOT on the operations
-- team — those readers keep the dashboard they have. orders.view_all does NOT
-- take the personal dashboard away from a salesperson: it widens what a person may
-- OPEN elsewhere, never what THIS dashboard counts, which is their own orders
-- only (assigned_to / salesperson_id = the caller, whatever else they can see).
-- Everybody else gets { "applicable": false } and nothing else. A visibility scope
-- (own / selected / all_sales) likewise never matters here.
--
-- NO ROW CAP: the lists are one jsonb value, so no PostgREST row limit applies.
-- READ-ONLY, one statement, no writes, no new table, no new grant beyond execute.

create or replace function public.salesperson_orders_dashboard()
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
  -- Inclusive month start, exclusive next-month start, in the business timezone.
  v_month_from date := date_trunc('month', timezone('Asia/Kolkata', now()))::date;
  v_month_to   date := (date_trunc('month', timezone('Asia/Kolkata', now())) + interval '1 month')::date;
  v_result     jsonb;
begin
  if not public.module_entry_open('orders') then
    raise exception 'The Orders module is not open to this account' using errcode = '42501';
  end if;

  if not (
    public.is_eligible_order_assignee(v_actor)
    and not exists (select 1 from public.users u
                     where u.id = v_actor and (u.role = 'admin' or u.team = 'operations'))
  ) then
    return jsonb_build_object('applicable', false);
  end if;

  with confirmed as materialized (
    -- THE CONFIRMED-ORDER DEFINITION every Orders surface uses: a row in
    -- public.orders (it exists only once the PI was approved), not test data, not
    -- cancelled. Dispatched Orders are confirmed Orders and stay in the total.
    -- Orders cannot be deleted (orders_prevent_delete). One row per Order by
    -- construction: no PI version or payment row is joined here.
    select o.id, o.display_number, o.client_name, o.status, o.confirm_date, o.due_date,
           o.created_at, o.total_value, o.total_product_value
      from public.orders o
     where o.assigned_to = v_actor
       and coalesce(o.is_test_data, false) = false
       and o.status <> 'cancelled'
  ),
  open_orders as materialized (
    select c.* from confirmed c where c.status <> 'dispatched'
  ),
  rev as (
    -- PRODUCT VALUE AFTER DISCOUNT, excl. GST and other charges — the same
    -- derivation as `rev` in orders_dashboard_summary() (20270221000000): the
    -- Order's own figure is the PI's gross; where the PI in force states a
    -- discount and the Order still carries that gross, the PI's after-discount
    -- subtotal is the product value. Each Order once, by its confirm_date.
    select c.id,
           case
             when c.total_product_value is null or c.total_product_value = 'NaN'::numeric then null
             when coalesce(pi.d, 0) <> 0 and pi.g is not null and c.total_product_value = pi.g and pi.st is not null
               then pi.st
             else c.total_product_value end as pv,
           (coalesce(pi.d, 0) <> 0
             and not (pi.g is not null and c.total_product_value = pi.g and pi.st is not null)) as before_discount
      from confirmed c
      left join lateral (
        select s.gross_product_amount as g, s.discount_amount as d, s.subtotal_after_discount as st
          from public.order_submissions s
         where s.id = coalesce(
                 (select v.submission_id from public.order_pi_versions v
                   where v.order_id = c.id and v.status = 'approved'
                   order by v.version_number desc limit 1),
                 (select o2.source_order_submission_id from public.orders o2 where o2.id = c.id))) pi on true
     where c.confirm_date >= v_month_from and c.confirm_date < v_month_to
  ),
  pending as (
    -- Submitted, awaiting the existing final order approval (status 'submitted';
    -- it becomes 'approved' with an Order at approval). Drafts, returned and
    -- rejected PIs are other statuses. A PI reserved for deletion is excluded.
    -- PI revisions of an existing Order, payment verification and advance
    -- exceptions are separate records and are not here.
    select s.id, s.draft_reference, s.client_name,
           coalesce(s.submitted_at, s.updated_at) as since,
           public.can_view_order_submission(s.id) as can_open
      from public.order_submissions s
     where s.salesperson_id = v_actor
       and s.status = 'submitted'
       and s.deletion_claim_token is null
  ),
  pos as materialized (
    select c.id as order_id, public.order_advance_position(c.id) as pos
      from open_orders c
  ),
  advance as (
    -- The gate's own measure: verified advance short of 40% of the CURRENT Order
    -- value (shortfall > 0). Exactly 40% has no shortfall. Unverified, rejected
    -- and reversed payments are not in `verified`. An approved exception does NOT
    -- remove the Order: the actual verified figure decides. An Order with no
    -- usable value has no percentage: it is counted, never given a fabricated one.
    select c.id, c.display_number, c.client_name, c.status, c.confirm_date,
           (p.pos ->> 'verified')::numeric as verified,
           -- The helper's OWN order value (its denominator), so a change to the rule
           -- in order_advance_position() reaches this list with no edit here.
           trunc(100 * (p.pos ->> 'verified')::numeric / (p.pos ->> 'order_value')::numeric, 2) as percent,
           (jsonb_typeof(p.pos -> 'exception') = 'object') as exception_approved
      from open_orders c join pos p on p.order_id = c.id
     where coalesce((p.pos ->> 'value_known')::boolean, false)
       and coalesce((p.pos ->> 'shortfall')::numeric, 0) > 0
  ),
  ff as (
    -- Fabric and finish, each on its own: the newest recorded event, or — for an
    -- Order created since tracking began — "no approval recorded" (required, not
    -- given). Only 'fully_approved' is complete; an uploaded screenshot is not.
    -- An Order older than tracking with NO record is ambiguous history, not a
    -- confirmed pending: it is counted separately and never listed as pending.
    -- (There is no explicit "not applicable" state in the approval log.)
    select c.id, c.display_number, c.client_name, c.status, c.confirm_date,
           case when c.confirm_date is null then null else v_today - c.confirm_date end as days_since,
           k.kind,
           coalesce(k.recorded_status,
                    case when c.created_at >= (select st.fabric_finish_tracking_from
                                                 from public.orders_dashboard_settings st where st.id)
                         then 'no_approval_recorded' end) as effective_status
      from open_orders c
     cross join lateral (
       select kinds.kind,
              (select e.status from public.order_approval_events e
                where e.order_id = c.id and e.approval_kind = kinds.kind
                order by e.created_at desc, e.id desc limit 1) as recorded_status
         from (values ('fabric'), ('finish')) as kinds(kind)) k
  ),
  ff_orders as (
    select f.id, f.display_number, f.client_name, f.status, f.confirm_date, max(f.days_since) as days_since,
           jsonb_agg(f.kind order by f.kind)
             filter (where f.effective_status is not null and f.effective_status <> 'fully_approved') as pending_kinds,
           jsonb_agg(jsonb_build_object('kind', f.kind, 'status', f.effective_status) order by f.kind)
             filter (where f.effective_status is not null and f.effective_status <> 'fully_approved') as pending_items,
           -- NO RECORD AT ALL on an order that predates tracking: the status is UNKNOWN. It is not
           -- approved and it is not "not applicable"; it is said, and listed apart from the pending.
           coalesce(jsonb_agg(f.kind order by f.kind) filter (where f.effective_status is null), '[]'::jsonb) as unknown_kinds
      from ff f
     group by f.id, f.display_number, f.client_name, f.status, f.confirm_date
  ),
  ready as (
    -- The Order's own status, set by the existing workflow (running →
    -- ready_for_dispatch, by Operations or an admin). Nothing is inferred.
    select c.id, c.display_number, c.client_name, c.status, c.due_date
      from open_orders c
     where c.status = 'ready_for_dispatch'
  )
  select jsonb_build_object(
    'applicable', true,
    'today', v_today,
    'now', v_now,
    'month_from', v_month_from,
    'total_orders', (select count(*) from confirmed),
    'revenue', jsonb_build_object(
      'amount', coalesce((select sum(pv) from rev), 0),
      'orders', (select count(*) from rev where pv is not null),
      'no_product_value', (select count(*) from rev where pv is null),
      'before_discount', (select count(*) from rev where before_discount)),
    'pending_total', (select count(*) from pending),
    'pending', coalesce((
      select jsonb_agg(jsonb_build_object(
               'submission_id', p.id, 'reference', p.draft_reference, 'client_name', p.client_name,
               'since', p.since, 'waiting_seconds', greatest(extract(epoch from (v_now - p.since)), 0),
               'can_open', p.can_open)
             order by p.since asc, p.id)
        from pending p), '[]'::jsonb),
    'advance', coalesce((
      select jsonb_agg(jsonb_build_object(
               'order_id', a.id, 'display_number', a.display_number, 'client_name', a.client_name,
               'status', a.status, 'verified', a.verified, 'percent', a.percent,
               'exception_approved', a.exception_approved, 'confirm_date', a.confirm_date)
             order by a.percent asc, a.confirm_date asc nulls last, a.display_number)
        from advance a), '[]'::jsonb),
    'advance_unchecked', (select count(*) from pos p
                           where not coalesce((p.pos ->> 'value_known')::boolean, false)),
    'fabric_finish', coalesce((
      select jsonb_agg(jsonb_build_object(
               'order_id', f.id, 'display_number', f.display_number, 'client_name', f.client_name,
               'status', f.status, 'confirm_date', f.confirm_date,
               'days_since_confirmation', f.days_since, 'over_15_days', coalesce(f.days_since > 15, false),
               'pending', f.pending_items, 'unknown', f.unknown_kinds)
             order by f.confirm_date asc nulls last, f.display_number)
        from ff_orders f where f.pending_kinds is not null), '[]'::jsonb),
    'fabric_finish_unknown', coalesce((
      select jsonb_agg(jsonb_build_object(
               'order_id', f.id, 'display_number', f.display_number, 'client_name', f.client_name,
               'status', f.status, 'confirm_date', f.confirm_date,
               'days_since_confirmation', f.days_since, 'unknown', f.unknown_kinds)
             order by f.confirm_date asc nulls last, f.display_number)
        from ff_orders f where f.pending_kinds is null and jsonb_array_length(f.unknown_kinds) > 0), '[]'::jsonb),
    'ready_for_dispatch', coalesce((
      select jsonb_agg(jsonb_build_object(
               'order_id', r.id, 'display_number', r.display_number, 'client_name', r.client_name,
               'status', r.status, 'planned_dispatch_date', r.due_date)
             order by r.due_date asc nulls last, r.display_number)
        from ready r), '[]'::jsonb))
  into v_result;

  return v_result;
end;
$$;

revoke execute on function public.salesperson_orders_dashboard() from public, anon;
grant  execute on function public.salesperson_orders_dashboard() to authenticated;
comment on function public.salesperson_orders_dashboard() is
  'The caller''s own Orders dashboard in one read: confirmed-order total, current-month product-value revenue (IST month, confirm_date), submitted PIs pending approval, and the complete advance-below-40%, fabric/finish-pending and ready-for-dispatch lists. Scoped to orders.assigned_to / order_submissions.salesperson_id = the caller (orders.view_all does not widen it); { applicable: false } for admins, operations and non-assignees. Read-only, no row cap. 20270226000000.';

do $$
begin
  if to_regprocedure('public.salesperson_orders_dashboard()') is null then
    raise exception 'VERIFY: salesperson_orders_dashboard() was not created';
  end if;
  if has_function_privilege('anon', 'public.salesperson_orders_dashboard()', 'execute') then
    raise exception 'VERIFY: salesperson_orders_dashboard() must not be callable by anon';
  end if;
end $$;
