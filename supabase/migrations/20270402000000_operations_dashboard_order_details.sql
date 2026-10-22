-- ═══════════════════════════════════════════════════════════════════════════
-- OPERATIONS DASHBOARD: the not-aligned list shows salesperson, due date and value.
--
-- The Not aligned for manufacturing table (owner-approved design, 2026-10-22) has
-- Salesperson, Due and Value columns, which the not-aligned rows of
-- orders_dashboard_summary() do not carry. This adds ONE key, 'order_details', to
-- operations_orders_dashboard(): a line per open order the reader may open, joined
-- on the screen by order id. Nothing else in the answer changes, and no table or
-- permission changes. The function is re-emitted IN FULL from 20270401000000 §6.
--
-- Roll-back: re-emit the function from 20270401000000 §6.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.operations_orders_dashboard()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor      uuid := public.assert_order_submission_actor();
  v_now        timestamptz := now();
  v_ist        date := timezone('Asia/Kolkata', now())::date;
  v_month_from date := date_trunc('month', timezone('Asia/Kolkata', now()))::date;
  v_last_from  date := (date_trunc('month', timezone('Asia/Kolkata', now())) - interval '1 month')::date;
  v_last_to    date := (date_trunc('month', timezone('Asia/Kolkata', now()))::date - 1);
  v_six_from   date := (date_trunc('month', timezone('Asia/Kolkata', now())) - interval '6 months')::date;
  v_is_reviewer boolean;
  v_is_approver boolean;
  v_pending    jsonb;
  v_responses  jsonb;
  v_periods    jsonb;
  v_details    jsonb;
begin
  if not public.module_entry_open('orders') then
    raise exception 'The Orders module is not open to this account' using errcode = '42501';
  end if;

  v_is_reviewer := exists (select 1 from public.order_operations_reviewers r
                            where r.duty = 'pi_handoff' and r.user_id = v_actor);
  v_is_approver := coalesce(public.actor_can_approve_order(), false)
                   or exists (select 1 from public.users u where u.id = v_actor and u.role = 'admin'
                                 and u.is_active and coalesce(u.is_deleted, false) = false);

  -- Waiting for THIS reader's answer.
  select coalesce(jsonb_agg(x order by x ->> 'approved_at'), '[]'::jsonb) into v_pending
    from (
      select jsonb_build_object(
               'handoff_id', h.id, 'order_id', o.id, 'display_number', o.display_number,
               'client_name', o.client_name, 'version_number', h.version_number,
               'approved_at', h.approved_at,
               'approved_by_name', (select nullif(btrim(u.full_name), '') from public.users u where u.id = h.approved_by),
               'revision_reason', (select v.revision_reason from public.order_pi_versions v where v.id = h.pi_version_id),
               'changes', public.order_handoff_change_lines(h.id)) as x
        from public.order_operations_handoffs h
        join public.orders o on o.id = h.order_id
       where v_is_reviewer
         and h.assigned_to = v_actor
         and h.status = 'awaiting'
         and h.superseded_at is null
         and h.version_number >= 2
         and h.production_alignment_at_approval = 'aligned'
         and o.status not in ('cancelled', 'dispatched')
         and coalesce(o.is_test_data, false) = false
         and public.can_read_order_detail(o.id)
    ) s;

  -- Answers already given, last 45 days: for the reviewer who gave them and
  -- for whoever approves Orders.
  select coalesce(jsonb_agg(x order by x ->> 'answered_at' desc), '[]'::jsonb) into v_responses
    from (
      select jsonb_build_object(
               'handoff_id', h.id, 'order_id', o.id, 'display_number', o.display_number,
               'client_name', o.client_name, 'version_number', h.version_number,
               'still_current', h.superseded_at is null,
               'answered_at', g.answered_at,
               'answered_by_name', (select nullif(btrim(u.full_name), '') from public.users u where u.id = g.answered_by),
               'can_do', g.can_do, 'cannot_do', g.cannot_do, 'discuss', g.discuss,
               'lines', coalesce((select jsonb_agg(jsonb_build_object(
                                    'key', a.line_key, 'title', a.line_title,
                                    'decision', a.decision, 'note', a.note) order by a.line_title)
                                    from public.order_pi_change_answers a where a.handoff_id = h.id), '[]'::jsonb)) as x
        from (select a.handoff_id, max(a.answered_at) as answered_at, max(a.answered_by::text)::uuid as answered_by,
                     count(*) filter (where a.decision = 'can_do') as can_do,
                     count(*) filter (where a.decision = 'cannot_do') as cannot_do,
                     count(*) filter (where a.decision = 'discuss') as discuss
                from public.order_pi_change_answers a group by a.handoff_id) g
        join public.order_operations_handoffs h on h.id = g.handoff_id
        join public.orders o on o.id = h.order_id
       where g.answered_at >= v_now - interval '45 days'
         and (v_is_approver or g.answered_by = v_actor)
         and coalesce(o.is_test_data, false) = false
         and public.can_read_order_detail(o.id)
       order by g.answered_at desc
       limit 30
    ) s;

  -- One line per OPEN order the reader may open: who the salesperson is, when it is due, what it is
  -- worth. The screen joins these to the not-aligned list by order id; it computes nothing from them.
  -- Value is the same product value the Orders list shows (the PI's after-discount subtotal while it
  -- still matches the order, else the order's own figure); null when none is on record.
  select coalesce(jsonb_agg(jsonb_build_object(
           'order_id', o.id, 'salesperson', sp.full_name, 'due_date', o.due_date,
           'value', case
             when o.total_product_value is null or o.total_product_value = 'NaN'::numeric then null
             when coalesce(pi.d, 0) <> 0 and pi.g is not null and o.total_product_value = pi.g and pi.st is not null
               then pi.st
             else o.total_product_value end)), '[]'::jsonb)
    into v_details
    from public.orders o
    left join public.users sp on sp.id = o.assigned_to
    left join lateral (
      select s.gross_product_amount as g, s.discount_amount as d, s.subtotal_after_discount as st
        from public.order_submissions s
       where s.id = coalesce(
               (select v.submission_id from public.order_pi_versions v
                 where v.order_id = o.id and v.status = 'approved'
                 order by v.version_number desc limit 1),
               o.source_order_submission_id)) pi on true
   where coalesce(o.is_test_data, false) = false
     and o.status not in ('dispatched', 'cancelled')
     and public.can_read_order_detail(o.id);

  -- Orders and Dispatches. Orders: confirmed in the period. Dispatches: moved
  -- to dispatched in the period (date read from the status-change entry).
  with base as (
    select o.id, o.status, o.confirm_date,
           case
             when o.total_product_value is null or o.total_product_value = 'NaN'::numeric then null
             when coalesce(pi.d, 0) <> 0 and pi.g is not null and o.total_product_value = pi.g and pi.st is not null
               then pi.st
             else o.total_product_value end as pv,
           (select min((a.created_at at time zone 'Asia/Kolkata')::date)
              from public.order_activity_log a
             where a.order_id = o.id and a.event_type = 'status_changed'
               and a.payload ->> 'to' = 'dispatched') as dispatched_on
      from public.orders o
      left join lateral (
        select s.gross_product_amount as g, s.discount_amount as d, s.subtotal_after_discount as st
          from public.order_submissions s
         where s.id = coalesce(
                 (select v.submission_id from public.order_pi_versions v
                   where v.order_id = o.id and v.status = 'approved'
                   order by v.version_number desc limit 1),
                 o.source_order_submission_id)) pi on true
     where coalesce(o.is_test_data, false) = false
       and o.status <> 'cancelled'
       and public.can_read_order_detail(o.id)
  )
  select jsonb_build_object(
           'last_month', jsonb_build_object('from', v_last_from, 'to', v_last_to,
             'orders', jsonb_build_object(
               'count', count(*) filter (where confirm_date between v_last_from and v_last_to),
               'value', coalesce(sum(pv) filter (where confirm_date between v_last_from and v_last_to), 0)),
             'dispatches', jsonb_build_object(
               'count', count(*) filter (where status = 'dispatched' and dispatched_on between v_last_from and v_last_to),
               'value', coalesce(sum(pv) filter (where status = 'dispatched' and dispatched_on between v_last_from and v_last_to), 0))),
           'last_six_months', jsonb_build_object('from', v_six_from, 'to', v_last_to,
             'orders', jsonb_build_object(
               'count', count(*) filter (where confirm_date between v_six_from and v_last_to),
               'value', coalesce(sum(pv) filter (where confirm_date between v_six_from and v_last_to), 0)),
             'dispatches', jsonb_build_object(
               'count', count(*) filter (where status = 'dispatched' and dispatched_on between v_six_from and v_last_to),
               'value', coalesce(sum(pv) filter (where status = 'dispatched' and dispatched_on between v_six_from and v_last_to), 0))),
           'gaps', jsonb_build_object(
             'dispatched_without_date', count(*) filter (where status = 'dispatched' and dispatched_on is null),
             'orders_without_value', count(*) filter (where confirm_date between v_six_from and v_last_to and pv is null),
             'no_confirm_date', count(*) filter (where confirm_date is null)))
    into v_periods
    from base;

  return jsonb_build_object(
    'today', v_ist,
    'viewer', jsonb_build_object('is_reviewer', v_is_reviewer, 'is_approver', v_is_approver),
    'pending_changes', v_pending,
    'responses', v_responses,
    'order_details', v_details,
    'periods', v_periods);
end;
$$;

comment on function public.operations_orders_dashboard() is
  'The Operations dashboard''s own read: revised-PI changes waiting for the calling reviewer to answer, the answers already given (to that reviewer and to whoever approves Orders), Orders / Dispatches for last month and the last six completed months, and order_details (salesperson, due date, value) for every open order the caller may open. 20270401000000, 20270402000000.';

revoke execute on function public.operations_orders_dashboard() from public, anon;
grant  execute on function public.operations_orders_dashboard() to authenticated;

do $$
begin
  if has_function_privilege('anon', 'public.operations_orders_dashboard()', 'EXECUTE') then
    raise exception 'operations dashboard proof: anon must not call the read';
  end if;
  if not has_function_privilege('authenticated', 'public.operations_orders_dashboard()', 'EXECUTE') then
    raise exception 'operations dashboard proof: signed-in users must be able to call the read';
  end if;
end;
$$;
