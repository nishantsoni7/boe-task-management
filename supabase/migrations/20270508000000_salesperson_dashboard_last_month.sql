-- ═══════════════════════════════════════════════════════════════════════════
-- 20270508000000  SALESPERSON DASHBOARD — LAST MONTH'S SALES, ₹ SHORT OF 40%, READY SINCE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Owner, 2026-10-30: the sales team's Orders dashboard shows this month's and
-- last month's sales, PIs waiting for approval, orders ready for dispatch and
-- orders below 40% advance. This restates salesperson_orders_dashboard()
-- (20270328000200) UNCHANGED except for:
--
--   revenue_last_month   the previous calendar month (India time), by the SAME
--                        rule as `revenue`: product value after discount, excl.
--                        GST, each confirmed Order once by its confirm_date.
--                        { month_from, amount, orders, no_product_value,
--                        before_discount }.
--   advance[].shortfall  the rupees still needed to reach 40% — the advance
--                        rule's OWN figure (order_advance_position ->
--                        'shortfall', rounded up to the paisa). Nothing new is
--                        computed here.
--   ready_for_dispatch[].ready_since / ready_days
--                        when the Order last moved to ready_for_dispatch, from
--                        the status_changed entry the Order page writes in
--                        order_activity_log (payload.to). An Order with no such
--                        entry says null — never a guessed date.
--   returned             now read from order_submissions_returned_to()
--                        (20270507000000), the one definition the Modules card
--                        also reads. Same rows, same fields as before.
--
-- Everything else in the payload (total_orders, pending, rejected, fabric /
-- finish, advance_unchecked) is returned exactly as before, even where the new
-- screen does not draw it, so a later change can bring it back without SQL.
--
-- DEPENDS ON 20270507000000 (order_submissions_returned_to); refuses to run without it.
--
-- Roll-back: run the create-or-replace of 20270328000200 again (the previous
-- body, unchanged since). The screen reads the new fields as optional.

do $$
begin
  if to_regprocedure('public.order_submissions_returned_to(uuid)') is null then
    raise exception 'DEPENDENCY MISSING: 20270507000000_returned_pis_for_sales must be applied before this migration';
  end if;
end $$;

-- DEPENDS ON 20270227000000_order_submission_advance_on_total_before_gst (PR #281): the advance percentage is a
-- percentage of the total BEFORE GST, derived by order_advance_base() and reported by order_advance_position() as
-- 'advance_base' with a TRUNCATED 'percent'. The advance list below takes the helper's OWN percentage and shortfall;
-- it computes no denominator of its own. Applied before that migration it would list percentages on the wrong
-- basis (and read a rounded percent), so it refuses to run.
do $$
begin
  if to_regprocedure('public.order_advance_base(uuid)') is null
     or pg_get_functiondef('public.order_advance_position(uuid)'::regprocedure) !~ 'advance_base' then
    raise exception 'DEPENDENCY MISSING: 20270227000000_order_submission_advance_on_total_before_gst (PR #281) must be applied before this migration';
  end if;
end $$;

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
  -- The previous calendar month, inclusive start; it ends where this month starts.
  v_prev_from  date := (date_trunc('month', timezone('Asia/Kolkata', now())) - interval '1 month')::date;
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
    -- 20270508000000: this month AND last month, told apart by `this_month`.
    select c.id,
           (c.confirm_date >= v_month_from) as this_month,
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
     where c.confirm_date >= v_prev_from and c.confirm_date < v_month_to
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
  returned as (
    -- THE ONE DEFINITION (20270507000000), also read by the Modules card.
    select t.submission_id as id, t.reference as draft_reference, t.client_name, t.review_note,
           t.returned_at as since, t.returned_by as by_id,
           public.can_view_order_submission(t.submission_id) as can_open
      from public.order_submissions_returned_to(v_actor) t
  ),
  rejected as (
    select s.id, s.draft_reference, s.client_name, s.review_note,
           s.rejected_at as since, s.rejected_by as by_id,
           public.can_view_order_submission(s.id) as can_open
      from public.order_submissions s
     where (s.salesperson_id = v_actor or s.submitted_by = v_actor or s.created_by = v_actor)
       and s.status = 'rejected'
       and s.rejected_at >= v_now - interval '7 days'
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
    -- recoverable total before GST has no percentage: it is counted, never given a fabricated one.
    select c.id, c.display_number, c.client_name, c.status, c.confirm_date,
           (p.pos ->> 'verified')::numeric as verified,
           -- The helper's OWN truncated percentage (verified ÷ total BEFORE GST, #281 / 20270226000000): this
           -- list divides by nothing, so the rule has exactly one definition.
           (p.pos ->> 'percent')::numeric as percent,
           -- 20270508000000: the rupees still needed to reach 40%, the helper's own figure.
           (p.pos ->> 'shortfall')::numeric as shortfall,
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
    -- 20270508000000: when it last moved to ready_for_dispatch, from the
    -- status_changed entry the Order page writes; null when there is none.
    select c.id, c.display_number, c.client_name, c.status, c.due_date,
           (select max(a.created_at)
              from public.order_activity_log a
             where a.order_id = c.id and a.event_type = 'status_changed'
               and a.payload ->> 'to' = 'ready_for_dispatch') as ready_since
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
      'amount', coalesce((select sum(pv) from rev where this_month), 0),
      'orders', (select count(*) from rev where this_month and pv is not null),
      'no_product_value', (select count(*) from rev where this_month and pv is null),
      'before_discount', (select count(*) from rev where this_month and before_discount)),
    -- 20270508000000: the previous calendar month, by the same rule.
    'revenue_last_month', jsonb_build_object(
      'month_from', v_prev_from,
      'amount', coalesce((select sum(pv) from rev where not this_month), 0),
      'orders', (select count(*) from rev where not this_month and pv is not null),
      'no_product_value', (select count(*) from rev where not this_month and pv is null),
      'before_discount', (select count(*) from rev where not this_month and before_discount)),
    'pending_total', (select count(*) from pending),
    'pending', coalesce((
      select jsonb_agg(jsonb_build_object(
               'submission_id', p.id, 'reference', p.draft_reference, 'client_name', p.client_name,
               'since', p.since, 'waiting_seconds', greatest(extract(epoch from (v_now - p.since)), 0),
               'can_open', p.can_open)
             order by p.since asc, p.id)
        from pending p), '[]'::jsonb),
    'returned_total', (select count(*) from returned),
    'returned', coalesce((
      select jsonb_agg(jsonb_build_object(
               'submission_id', r.id, 'reference', r.draft_reference, 'client_name', r.client_name,
               'note', r.review_note, 'by_name', u.full_name, 'since', r.since,
               'waiting_seconds', greatest(extract(epoch from (v_now - coalesce(r.since, v_now))), 0),
               'can_open', r.can_open)
             order by r.since asc nulls last, r.id)
        from returned r left join public.users u on u.id = r.by_id), '[]'::jsonb),
    'rejected_total', (select count(*) from rejected),
    'rejected', coalesce((
      select jsonb_agg(jsonb_build_object(
               'submission_id', r.id, 'reference', r.draft_reference, 'client_name', r.client_name,
               'note', r.review_note, 'by_name', u.full_name, 'since', r.since,
               'waiting_seconds', greatest(extract(epoch from (v_now - r.since)), 0),
               'can_open', r.can_open)
             order by r.since desc, r.id)
        from rejected r left join public.users u on u.id = r.by_id), '[]'::jsonb),
    'advance', coalesce((
      select jsonb_agg(jsonb_build_object(
               'order_id', a.id, 'display_number', a.display_number, 'client_name', a.client_name,
               'status', a.status, 'verified', a.verified, 'percent', a.percent, 'shortfall', a.shortfall,
               'exception_approved', a.exception_approved, 'confirm_date', a.confirm_date,
               'days_since_confirmation', case when a.confirm_date is null then null else v_today - a.confirm_date end)
             order by a.percent asc, a.confirm_date asc nulls last, a.display_number)
        from advance a), '[]'::jsonb),
    -- ORDERS WHOSE ADVANCE CANNOT BE CHECKED (no total before GST is recoverable): LISTED, not merely counted, so they
    -- never read as cleared and never vanish behind a number. Oldest confirmation first, like the lists beside it.
    'advance_unchecked', coalesce((
      select jsonb_agg(jsonb_build_object(
               'order_id', c.id, 'display_number', c.display_number, 'client_name', c.client_name,
               'status', c.status, 'confirm_date', c.confirm_date)
             order by c.confirm_date asc nulls last, c.display_number)
        from open_orders c join pos p on p.order_id = c.id
       where not coalesce((p.pos ->> 'value_known')::boolean, false)), '[]'::jsonb),
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
               'status', r.status, 'planned_dispatch_date', r.due_date,
               'ready_since', r.ready_since,
               'ready_days', case when r.ready_since is null then null
                                  else v_today - timezone('Asia/Kolkata', r.ready_since)::date end)
             order by r.due_date asc nulls last, r.display_number)
        from ready r), '[]'::jsonb))
  into v_result;

  return v_result;
end;
$$;

revoke execute on function public.salesperson_orders_dashboard() from public, anon;
grant  execute on function public.salesperson_orders_dashboard() to authenticated;
comment on function public.salesperson_orders_dashboard() is
  'The caller''s own Orders dashboard in one read: confirmed-order total, current-month product-value revenue (IST month, confirm_date), submitted PIs pending approval, and the complete advance-below-40%, fabric/finish-pending and ready-for-dispatch lists. Also lists PIs sent back for changes (order_submissions_returned_to) and PIs rejected in the last 7 days. Since 20270508000000 also last month''s revenue by the same rule, each below-40% order''s rupee shortfall, and when each ready order became ready. Scoped to orders.assigned_to / order_submissions.salesperson_id = the caller (orders.view_all does not widen it); { applicable: false } for admins, operations and non-assignees. Read-only, no row cap. 20270508000000.';

do $$
declare
  v_def text;
begin
  if to_regprocedure('public.salesperson_orders_dashboard()') is null then
    raise exception 'VERIFY: salesperson_orders_dashboard() was not created';
  end if;
  v_def := pg_get_functiondef('public.salesperson_orders_dashboard()'::regprocedure);
  if v_def !~ 'returned_total' then
    raise exception 'VERIFY: salesperson_orders_dashboard() does not list returned PIs';
  end if;
  if v_def !~ 'order_submissions_returned_to' then
    raise exception 'VERIFY: salesperson_orders_dashboard() does not read the one returned-PI definition';
  end if;
  if v_def !~ 'revenue_last_month' or v_def !~ 'v_prev_from' then
    raise exception 'VERIFY: salesperson_orders_dashboard() does not report last month';
  end if;
  if v_def !~ '''shortfall'', a.shortfall' then
    raise exception 'VERIFY: salesperson_orders_dashboard() does not report the advance shortfall';
  end if;
  if v_def !~ 'ready_since' then
    raise exception 'VERIFY: salesperson_orders_dashboard() does not report when an order became ready';
  end if;
  if has_function_privilege('anon', 'public.salesperson_orders_dashboard()', 'execute') then
    raise exception 'VERIFY: salesperson_orders_dashboard() must not be callable by anon';
  end if;
end $$;
