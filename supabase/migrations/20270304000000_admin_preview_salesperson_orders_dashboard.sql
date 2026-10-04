-- ═══════════════════════════════════════════════════════════════════════════
-- 20270304000000  ADMIN PREVIEW OF A SALESPERSON'S ORDERS DASHBOARD — one read, administrators only
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS IS
-- ------------
-- public.admin_preview_salesperson_orders_dashboard(p_salesperson_id) returns EXACTLY what
-- public.salesperson_orders_dashboard() (20270228000000) returns to that salesperson — the same three figures and
-- four complete lists — for an ADMINISTRATOR who is looking at the dashboard through "View As". It adds one key,
-- 'preview' ({salesperson_id, full_name}), so the page can say whose dashboard it is drawing.
--
-- WHY A NEW FUNCTION, AND NOT A PARAMETER ON THE LIVE ONE
-- -------------------------------------------------------
-- salesperson_orders_dashboard() takes no argument and is scoped to auth.uid() by construction; that is the
-- property that makes it safe to hand to every salesperson. It is not touched. This function is generated from
-- its text (only the owner of the records changes: the previewed salesperson instead of the caller) and is
-- pinned to it by supabase/tests/admin_preview_salesperson_dashboard_assertions.sql, which compares the two
-- answers for the same salesperson, row by row.
--
-- WHO MAY CALL IT
-- ---------------
-- An active administrator, nobody else: any other caller (a salesperson asking for a colleague, a manager, an
-- operations user) gets an error, not an empty answer. The previewed person must be someone who HAS a personal
-- dashboard (an eligible order assignee who is not an admin and not on the operations team); for anybody else
-- the answer is { applicable: false, preview } and the page keeps showing the dashboard that person has.
--
-- WHAT IT DOES NOT DO
-- -------------------
-- It writes nothing and grants nothing. The pending-PI links ('can_open') are the ADMINISTRATOR's own ability to
-- open that PI, because the administrator is the one who will click them. Execute is granted to authenticated
-- (the function refuses everybody who is not an administrator); not to anon.

-- DEPENDS ON 20270228000000 (the personal dashboard) and, through it, 20270227000000 (the advance base).
do $$
begin
  if to_regprocedure('public.salesperson_orders_dashboard()') is null then
    raise exception 'DEPENDENCY MISSING: 20270228000000_salesperson_orders_dashboard (PR #279) must be applied before this migration';
  end if;
end $$;

create or replace function public.admin_preview_salesperson_orders_dashboard(p_salesperson_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor      uuid := public.assert_order_submission_actor();   -- the ADMINISTRATOR asking
  v_target     uuid := p_salesperson_id;                          -- the salesperson being previewed
  v_name       text;
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

  -- ONLY AN ADMINISTRATOR. Everybody else is refused outright (not given an empty answer): this function
  -- answers with another person's orders, so it must never be a way around who may see what.
  if not exists (select 1 from public.users u
                  where u.id = v_actor and u.role = 'admin' and u.is_active and not coalesce(u.is_deleted, false)) then
    raise exception 'Only an administrator can preview a salesperson''s dashboard' using errcode = '42501';
  end if;

  select u.full_name into v_name from public.users u where u.id = v_target and not coalesce(u.is_deleted, false);

  -- THE SAME TEST the personal dashboard applies to its caller, applied to the person being previewed: an
  -- eligible order assignee who is not an admin and not on the operations team. Anybody else has no personal
  -- dashboard to preview — the answer says so, and the page keeps showing the dashboard they have.
  if v_target is null or not (
    exists (select 1 from public.users u where u.id = v_target and u.is_active and not coalesce(u.is_deleted, false))
    and public.is_eligible_order_assignee(v_target)
    and not exists (select 1 from public.users u
                     where u.id = v_target and (u.role = 'admin' or u.team = 'operations'))
  ) then
    return jsonb_build_object('applicable', false,
             'preview', jsonb_build_object('salesperson_id', v_target, 'full_name', v_name));
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
     where o.assigned_to = v_target
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
     where s.salesperson_id = v_target
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
    -- recoverable total before GST has no percentage: it is counted, never given a fabricated one.
    select c.id, c.display_number, c.client_name, c.status, c.confirm_date,
           (p.pos ->> 'verified')::numeric as verified,
           -- The helper's OWN truncated percentage (verified ÷ total BEFORE GST, #281 / 20270226000000): this
           -- list divides by nothing, so the rule has exactly one definition.
           (p.pos ->> 'percent')::numeric as percent,
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
    'preview', jsonb_build_object('salesperson_id', v_target, 'full_name', v_name),
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
               'status', r.status, 'planned_dispatch_date', r.due_date)
             order by r.due_date asc nulls last, r.display_number)
        from ready r), '[]'::jsonb))
  into v_result;

  return v_result;
end;
$$;

revoke execute on function public.admin_preview_salesperson_orders_dashboard(uuid) from public, anon;
grant  execute on function public.admin_preview_salesperson_orders_dashboard(uuid) to authenticated;
comment on function public.admin_preview_salesperson_orders_dashboard(uuid) is
  'An administrator''s read of what one salesperson sees on the Orders dashboard: the same answer as salesperson_orders_dashboard(), for the named salesperson, plus a preview key naming them. Refuses every caller who is not an active administrator. { applicable: false, preview } when the named person has no personal dashboard. Read-only.';

do $$
begin
  if to_regprocedure('public.admin_preview_salesperson_orders_dashboard(uuid)') is null then
    raise exception 'VERIFY: admin_preview_salesperson_orders_dashboard(uuid) was not created';
  end if;
  if has_function_privilege('anon', 'public.admin_preview_salesperson_orders_dashboard(uuid)', 'execute') then
    raise exception 'VERIFY: admin_preview_salesperson_orders_dashboard(uuid) must not be callable by anon';
  end if;
end $$;
