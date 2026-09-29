-- THE ORDERS DASHBOARD: what it counts, who sees revenue, and PANIC MODE
-- (20270221000000)
-- ===========================================================================
--   1  the 40% line        39.99 short, exactly 40.00 not, no value = unassessable
--   2  overdue             due today is not overdue; yesterday is 1 day
--   3  fabric / finish     15 days is NOT flagged, 16 is; the item named; the newest
--                          event wins; no confirm date is counted, not flagged
--   4  not aligned         the reason from the handoff; aligned Orders absent
--   5  exclusions          dispatched, cancelled and test-data Orders are in NO group
--   6  overlap             one Order may sit in several groups
--   7  revenue             boundaries of the three periods, once per Order however
--                          many PI versions, after-discount product value,
--                          cancelled/test excluded, gaps counted
--   8  who sees what       a salesperson: own Orders only, no revenue, no panic key
--   9  PANIC MODE          owner only, two per IST month (removal does not refund),
--                          a new month allows two more, closed Orders drop out of the
--                          alert but stay in history, no direct table access, history
--                          is append-only, visibility needs the protected grant
--
-- One transaction, ROLLBACK. Synthetic records only.
-- On success prints NOTICE 'ALL ORDERS DASHBOARD ASSERTIONS PASSED'.

\set ON_ERROR_STOP on

begin;

do $$
begin
  perform set_config('test.owner_id', '11111111-1111-1111-1111-111111111111', true); -- TEST-001
  perform set_config('test.admin2_id', 'd0000000-0000-4000-8000-00000000d001', true); -- another active admin, no grant
  perform set_config('test.viewer_id', 'd0000000-0000-4000-8000-00000000d002', true); -- orders.view_all + view_panic_mode
  perform set_config('test.sales_id',  'd0000000-0000-4000-8000-00000000d003', true); -- salesperson, own Orders only
  perform set_config('test.viewall_id','d0000000-0000-4000-8000-00000000d004', true); -- orders.view_all, no panic grant
end $$;

insert into public.users (id, full_name, email, role, team, is_active, employee_code) values
  (current_setting('test.admin2_id')::uuid,  'DASH Admin2',  'd-admin2@example.test',  'admin',  'management', true, 'ASSERT-D1'),
  (current_setting('test.viewer_id')::uuid,  'DASH Viewer',  'd-viewer@example.test',  'member', 'sales',      true, 'ASSERT-D2'),
  (current_setting('test.sales_id')::uuid,   'DASH Sales',   'd-sales@example.test',   'member', 'sales',      true, 'ASSERT-D3'),
  (current_setting('test.viewall_id')::uuid, 'DASH ViewAll', 'd-viewall@example.test', 'member', 'sales',      true, 'ASSERT-D4')
on conflict (id) do update set role = excluded.role, team = excluded.team, is_active = true, is_deleted = false;
update public.users set role = 'admin', is_active = true, is_deleted = false
 where id = current_setting('test.owner_id')::uuid;

insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
select g.uid, mpa.module_id, mpa.action_id, true, current_setting('test.owner_id')::uuid
  from (values
    (current_setting('test.viewer_id')::uuid,   'orders', 'view'),
    (current_setting('test.viewer_id')::uuid,   'orders', 'view_all'),
    (current_setting('test.viewer_id')::uuid,   'orders', 'view_panic_mode'),
    (current_setting('test.sales_id')::uuid,    'orders', 'view'),
    (current_setting('test.viewall_id')::uuid,  'orders', 'view'),
    (current_setting('test.viewall_id')::uuid,  'orders', 'view_all'),
    (current_setting('test.admin2_id')::uuid,   'orders', 'view')) g(uid, m, a)
  join public.permission_modules pm on pm.module_key = g.m
  join public.permission_actions pa on pa.action_key = g.a
  join public.module_permission_actions mpa on mpa.module_id = pm.id and mpa.action_id = pa.id
on conflict do nothing;

create function pg_temp.become(p_user uuid) returns void language plpgsql as $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;
create function pg_temp.restore() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end $$;
create function pg_temp.check(p_ok boolean, p_label text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'ASSERT FAILED: %', p_label; end if;
end $$;
create function pg_temp.expect_error(p_sql text, p_code text, p_what text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    perform pg_temp.restore();
    if position(p_code in sqlerrm) = 0 then
      raise exception 'ASSERT FAILED: % — expected %, got: %', p_what, p_code, sqlerrm;
    end if;
    return;
  end;
  perform pg_temp.restore();
  raise exception 'ASSERT FAILED: % — expected %, but it succeeded', p_what, p_code;
end $$;

/** expect_error as a given user (null = the table owner / no JWT). expect_error restores the role
 *  in its handler, so every call names its own user. */
create function pg_temp.expect_error_as(p_user uuid, p_sql text, p_code text, p_what text) returns void language plpgsql as $$
begin
  if p_user is null then perform pg_temp.restore(); else perform pg_temp.become(p_user); end if;
  perform pg_temp.expect_error(p_sql, p_code, p_what);
end $$;

create function pg_temp.summary(p_user uuid) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.become(p_user);
  v := public.orders_dashboard_summary();
  perform pg_temp.restore();
  return v;
end $$;

/** The row of one group for one fixture Order (matched by client_name), or null. */
create function pg_temp.row_of(p_sum jsonb, p_group text, p_tag text) returns jsonb language sql as $$
  select x from jsonb_array_elements(p_sum -> 'groups' -> p_group) x
   where x ->> 'client_name' = 'DASH-' || p_tag limit 1;
$$;

create function pg_temp.today() returns date language sql as $$
  select timezone('Asia/Kolkata', now())::date;
$$;

/** One Order, one round: status, dates, value, product value, alignment, test flag. */
create function pg_temp.mk_order(
  p_tag text, p_status text, p_due date, p_confirm date,
  p_total numeric, p_product numeric,
  p_aligned text default 'not_aligned', p_test boolean default false,
  p_requested_by uuid default null
) returns uuid language plpgsql as $$
declare v_id uuid := gen_random_uuid();
begin
  perform set_config('request.jwt.claims', '', true);
  -- The flag is STAMPED at insert from the cleanup phase (stamp_test_data_flag) and is immutable, so a
  -- test-data fixture is inserted while the phase is on, and a real one while it is off.
  update public.test_data_cleanup_settings set enabled = p_test, permanently_disabled = false where id;
  insert into public.orders (id, client_name, status, due_date, confirm_date, total_value, total_product_value,
                             created_by, requested_by)
  values (v_id, 'DASH-' || p_tag, p_status, p_due, p_confirm, p_total, p_product,
          current_setting('test.owner_id')::uuid, p_requested_by);
  update public.test_data_cleanup_settings set enabled = false where id;
  if p_aligned <> 'not_aligned' then
    perform set_config('boe.production_alignment_context', 'production_alignment', true);
    update public.orders set production_alignment = p_aligned where id = v_id;
    perform set_config('boe.production_alignment_context', '', true);
  end if;
  return v_id;
end $$;

/** Verified money allocated to an Order. */
create function pg_temp.pay(p_order uuid, p_amount numeric) returns void language plpgsql as $$
declare v_pay uuid := gen_random_uuid();
begin
  perform set_config('request.jwt.claims', '', true);
  insert into public.finance_payment_requests (id, client_name, amount, payment_date, payment_mode, status, submitted_by, received_in)
  values (v_pay, 'DASH-PAY', p_amount, current_date, 'hdfc', 'approved_unlinked', current_setting('test.owner_id')::uuid, null);
  insert into public.finance_payment_allocations (payment_request_id, order_id, allocated_amount, origin_target_type, created_by)
  values (v_pay, p_order, p_amount, 'confirmed_order', current_setting('test.owner_id')::uuid);
end $$;

create function pg_temp.fabric(p_order uuid, p_kind text, p_status text, p_at timestamptz) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  insert into public.order_approval_events (order_id, approval_kind, status, evidence_path, actor_id, created_at)
  values (p_order, p_kind, p_status,
          case when p_status = 'not_approved' then null
               else 'orders/' || p_order::text || '/' || p_kind || '/' || gen_random_uuid()::text || '.png' end,
          current_setting('test.owner_id')::uuid, p_at);
end $$;

-- ═══ 0. Baseline: what production-shaped data already says, so deltas are exact ═══
create temporary table base_rev on commit drop as
  select pg_temp.summary(current_setting('test.owner_id')::uuid) -> 'revenue' as r;

-- ═══ 1–6. The four groups ══════════════════════════════════════════════════════
do $$
declare
  t date := pg_temp.today();
  o uuid; s jsonb; r jsonb;
begin
  -- 1. The 40% line, on a 1,000,000 Order.
  o := pg_temp.mk_order('adv_short',  'running', null, t, 1000000, 800000);  perform pg_temp.pay(o, 399999.99);
  o := pg_temp.mk_order('adv_exact',  'running', null, t, 1000000, 800000);  perform pg_temp.pay(o, 400000.00);
  o := pg_temp.mk_order('adv_zero',   'running', null, t, 1000000, 800000);
  o := pg_temp.mk_order('adv_noval',  'running', null, t, null,    null);
  o := pg_temp.mk_order('adv_disp',   'dispatched', null, t, 1000000, 800000);

  -- 2. Overdue.
  perform pg_temp.mk_order('due_today',  'running', t,      t, 100, 100);
  perform pg_temp.mk_order('due_yest',   'running', t - 1,  t, 100, 100);
  perform pg_temp.mk_order('due_30',     'on_hold', t - 30, t, 100, 100);
  perform pg_temp.mk_order('due_none',   'running', null,   t, 100, 100);
  perform pg_temp.mk_order('due_closed', 'dispatched', t - 5, t, 100, 100);
  perform pg_temp.mk_order('due_cancel', 'cancelled',  t - 5, t, 100, 100);
  perform pg_temp.mk_order('due_test',   'running', t - 5,  t, 100, 100, 'not_aligned', true);

  -- 3. Fabric / finish and the 15-day line.
  o := pg_temp.mk_order('ff_15',  'running', null, t - 15, 100, 100);
  o := pg_temp.mk_order('ff_16',  'running', null, t - 16, 100, 100);
  o := pg_temp.mk_order('ff_16_fabric_done', 'running', null, t - 16, 100, 100);
    perform pg_temp.fabric(o, 'fabric', 'fully_approved', now() - interval '3 days');
  o := pg_temp.mk_order('ff_20_both_done', 'running', null, t - 20, 100, 100);
    perform pg_temp.fabric(o, 'fabric', 'fully_approved', now() - interval '3 days');
    perform pg_temp.fabric(o, 'finish', 'fully_approved', now() - interval '2 days');
  o := pg_temp.mk_order('ff_20_partial', 'running', null, t - 20, 100, 100);
    perform pg_temp.fabric(o, 'fabric', 'fully_approved', now() - interval '5 days');
    perform pg_temp.fabric(o, 'finish', 'partially_approved', now() - interval '4 days');
  o := pg_temp.mk_order('ff_20_reverted', 'running', null, t - 20, 100, 100);
    perform pg_temp.fabric(o, 'fabric', 'fully_approved', now() - interval '5 days');
    perform pg_temp.fabric(o, 'fabric', 'not_approved', now() - interval '1 day');  -- newest wins
    perform pg_temp.fabric(o, 'finish', 'fully_approved', now() - interval '2 days');
  perform pg_temp.mk_order('ff_nodate', 'running', null, null, 100, 100);
  perform pg_temp.mk_order('ff_old_dispatched', 'dispatched', null, t - 90, 100, 100);

  -- 4. Alignment.
  -- Alignment is refused below 40%, so the aligned fixture is paid its 40 first.
  o := pg_temp.mk_order('al_aligned', 'running', null, t, 100, 100);
  perform pg_temp.pay(o, 40);
  perform set_config('boe.production_alignment_context', 'production_alignment', true);
  update public.orders set production_alignment = 'aligned' where id = o;
  perform set_config('boe.production_alignment_context', '', true);
  perform pg_temp.mk_order('al_not',     'running', null, t, 100, 100);

  s := pg_temp.summary(current_setting('test.owner_id')::uuid);

  -- ── 1 ──
  r := pg_temp.row_of(s, 'advance_below_40', 'adv_short');
  perform pg_temp.check(r is not null, 'ONE paisa-ish short of 40% is listed');
  perform pg_temp.check((r ->> 'shortfall')::numeric = 0.01, 'shortfall is the smallest real payment, 0.01');
  perform pg_temp.check((r ->> 'percent')::numeric = 39.99, 'percent is TRUNCATED to 39.99, never rounded up to 40.00');
  perform pg_temp.check(pg_temp.row_of(s, 'advance_below_40', 'adv_exact') is null, 'exactly 40.00% is not listed');
  r := pg_temp.row_of(s, 'advance_below_40', 'adv_zero');
  perform pg_temp.check(r is not null and (r ->> 'percent')::numeric = 0 and (r ->> 'shortfall')::numeric = 400000, 'nothing verified: 0% and the full 40% short');
  perform pg_temp.check(pg_temp.row_of(s, 'advance_below_40', 'adv_noval') is null, 'an Order with no value is not called "below 40%"');
  perform pg_temp.check((s -> 'gaps' ->> 'advance_value_unknown')::int >= 1, 'the no-value Order is COUNTED as unassessable');
  perform pg_temp.check(pg_temp.row_of(s, 'advance_below_40', 'adv_disp') is null, 'a dispatched Order is not listed');

  -- ── 2 ──
  perform pg_temp.check(pg_temp.row_of(s, 'overdue', 'due_today') is null, 'due today is not overdue');
  perform pg_temp.check((pg_temp.row_of(s, 'overdue', 'due_yest') ->> 'days_overdue')::int = 1, 'due yesterday is 1 day overdue');
  perform pg_temp.check((pg_temp.row_of(s, 'overdue', 'due_30') ->> 'days_overdue')::int = 30, 'an on-hold Order is still counted: 30 days');
  perform pg_temp.check(pg_temp.row_of(s, 'overdue', 'due_none') is null, 'no due date is not overdue');
  perform pg_temp.check((s -> 'gaps' ->> 'no_due_date')::int >= 1, 'no due date is COUNTED');
  perform pg_temp.check(pg_temp.row_of(s, 'overdue', 'due_closed') is null, 'dispatched is excluded');
  perform pg_temp.check(pg_temp.row_of(s, 'overdue', 'due_cancel') is null, 'cancelled is excluded');
  perform pg_temp.check(pg_temp.row_of(s, 'overdue', 'due_test') is null, 'test data is excluded');

  -- ── 3 ──
  perform pg_temp.check(pg_temp.row_of(s, 'fabric_finish_pending', 'ff_15') is null, 'exactly 15 days is NOT more than 15');
  r := pg_temp.row_of(s, 'fabric_finish_pending', 'ff_16');
  perform pg_temp.check(r is not null and (r ->> 'days_since_confirmation')::int = 16, '16 days is flagged, with 16 elapsed');
  perform pg_temp.check(jsonb_array_length(r -> 'pending') = 2, 'both items are named when both are pending');
  r := pg_temp.row_of(s, 'fabric_finish_pending', 'ff_16_fabric_done');
  perform pg_temp.check(jsonb_array_length(r -> 'pending') = 1 and r -> 'pending' -> 0 ->> 'kind' = 'finish', 'only FINISH is named when fabric is done');
  perform pg_temp.check(pg_temp.row_of(s, 'fabric_finish_pending', 'ff_20_both_done') is null, 'both fully approved: not listed');
  r := pg_temp.row_of(s, 'fabric_finish_pending', 'ff_20_partial');
  perform pg_temp.check(r -> 'pending' -> 0 ->> 'kind' = 'finish' and r -> 'pending' -> 0 ->> 'status' = 'partially_approved', 'partially approved still counts as pending');
  r := pg_temp.row_of(s, 'fabric_finish_pending', 'ff_20_reverted');
  perform pg_temp.check(r -> 'pending' -> 0 ->> 'kind' = 'fabric', 'the NEWEST event wins: a reverted fabric is pending again');
  perform pg_temp.check(pg_temp.row_of(s, 'fabric_finish_pending', 'ff_nodate') is null, 'no confirmation date is not flagged');
  perform pg_temp.check((s -> 'gaps' ->> 'no_confirm_date')::int >= 1, 'no confirmation date is COUNTED');
  perform pg_temp.check(pg_temp.row_of(s, 'fabric_finish_pending', 'ff_old_dispatched') is null, 'dispatched is excluded');

  -- ── 4 ──
  perform pg_temp.check(pg_temp.row_of(s, 'not_aligned', 'al_aligned') is null, 'an aligned Order is not listed');
  r := pg_temp.row_of(s, 'not_aligned', 'al_not');
  perform pg_temp.check(r ->> 'reason' = 'no_handoff', 'an Order with no handoff says so, and is not invented a reason');

  -- ── 5 ──
  perform pg_temp.check(pg_temp.row_of(s, 'not_aligned', 'due_cancel') is null and pg_temp.row_of(s, 'not_aligned', 'due_closed') is null
                        and pg_temp.row_of(s, 'not_aligned', 'due_test') is null, 'closed and test Orders are in no group');

  -- ── 6. one Order, several groups ──
  perform pg_temp.check(pg_temp.row_of(s, 'advance_below_40', 'due_30') is not null
                        and pg_temp.row_of(s, 'overdue', 'due_30') is not null
                        and pg_temp.row_of(s, 'not_aligned', 'due_30') is not null,
                        'an Order may appear in several groups; nothing is de-duplicated');
end $$;

-- The fixtures above are Orders too and carry product values: measure revenue from HERE.
create temporary table base_rev2 on commit drop as
  select pg_temp.summary(current_setting('test.owner_id')::uuid) -> 'revenue' as r;

-- ═══ 7. Revenue ═══════════════════════════════════════════════════════════════
do $$
declare
  t date := pg_temp.today();
  m date := date_trunc('month', t)::date;
  six date := ((t - interval '6 months')::date + 1);
  y date := date_trunc('year', t)::date;
  base jsonb := (select r from base_rev2);
  o uuid; s jsonb; sub uuid := gen_random_uuid(); sub2 uuid := gen_random_uuid();
  d_cur numeric; d_six numeric; d_year numeric; e_cur numeric; e_six numeric; e_year numeric;
  sub3 uuid := gen_random_uuid();
begin
  -- Product values 1,10,100,... so every period's delta names exactly which Orders it holds.
  perform pg_temp.mk_order('rev_today',     'running',    null, t,         null, 1);
  perform pg_temp.mk_order('rev_monthstart','dispatched', null, m,         null, 10);
  perform pg_temp.mk_order('rev_prevmonth', 'running',    null, m - 1,     null, 100);       -- last day of previous month
  perform pg_temp.mk_order('rev_six_edge',  'running',    null, six,       null, 1000);      -- first day of the rolling window
  perform pg_temp.mk_order('rev_six_out',   'running',    null, six - 1,   null, 10000);     -- one day before it
  perform pg_temp.mk_order('rev_jan1',      'running',    null, y,         null, 100000);
  perform pg_temp.mk_order('rev_lastyear',  'running',    null, y - 1,     null, 1000000);
  perform pg_temp.mk_order('rev_future',    'running',    null, t + 1,     null, 10000000);
  perform pg_temp.mk_order('rev_cancelled', 'cancelled',  null, t,         null, 100000000);
  perform pg_temp.mk_order('rev_test',      'running',    null, t,         null, 1000000000, 'not_aligned', true);
  perform pg_temp.mk_order('rev_nodate',    'running',    null, null,      null, 5);
  perform pg_temp.mk_order('rev_noproduct', 'running',    null, t,         null, null);

  -- ONE Order, three PI versions (V1 superseded, V2 in force with a 500 discount, V3 rejected):
  -- counted ONCE, at the version IN FORCE's after-discount product value (8,000 - 500 = 7,500).
  o := pg_temp.mk_order('rev_versions', 'running', null, t, null, 8000);
  perform set_config('request.jwt.claims', '', true);
  insert into public.order_submissions (id, status, submitted_by, created_by, client_name, gross_product_amount, discount_amount, subtotal_after_discount, grand_total) values
    (sub,  'draft', current_setting('test.owner_id')::uuid, current_setting('test.owner_id')::uuid, 'DASH-v1', 6000, 0,   6000, 7080),
    (sub2, 'draft', current_setting('test.owner_id')::uuid, current_setting('test.owner_id')::uuid, 'DASH-v2', 8000, 500, 7500, 8850),
    (sub3, 'draft', current_setting('test.owner_id')::uuid, current_setting('test.owner_id')::uuid, 'DASH-v3', 9000, 0,   9000, 10620);
  -- Versions are only ever created through the approval doors; a fixture needs history in three
  -- states, so the guard is off for exactly this insert (this transaction rolls back).
  alter table public.order_pi_versions disable trigger order_pi_versions_guard;
  insert into public.order_pi_versions (order_id, submission_id, version_number, status, decided_by, decided_at, decision_reason, superseded_at, revision_reason, pdf_order_number) values
    (o, sub,  1, 'superseded', current_setting('test.owner_id')::uuid, now(), null, now(), null, 'DASH-1'),
    (o, sub2, 2, 'approved',   current_setting('test.owner_id')::uuid, now(), null, null,  'client change', 'DASH-1'),
    (o, sub3, 3, 'rejected',   current_setting('test.owner_id')::uuid, now(), 'not needed', null, 'another change', 'DASH-1');
  alter table public.order_pi_versions enable trigger order_pi_versions_guard;

  s := pg_temp.summary(current_setting('test.owner_id')::uuid);
  d_cur  := (s -> 'revenue' -> 'current_month'    ->> 'amount')::numeric - (base -> 'current_month'    ->> 'amount')::numeric;
  d_six  := (s -> 'revenue' -> 'last_six_months'  ->> 'amount')::numeric - (base -> 'last_six_months'  ->> 'amount')::numeric;
  d_year := (s -> 'revenue' -> 'current_year'     ->> 'amount')::numeric - (base -> 'current_year'     ->> 'amount')::numeric;

  -- What each period MUST hold, from the fixtures' own dates — so the check is right on any day
  -- of the year, including 1 January and the 1st of a month, where windows coincide.
  -- (date, product value) of every fixture that may count: cancelled, test, undated, future, and
  -- last year's are deliberately absent.
  select coalesce(sum(v) filter (where d between m and t), 0),
         coalesce(sum(v) filter (where d between six and t), 0),
         coalesce(sum(v) filter (where d between y and t), 0)
    into e_cur, e_six, e_year
    from (values (t, 1::numeric), (m, 10), (m - 1, 100), (six, 1000), (six - 1, 10000), (y, 100000),
                 (y - 1, 1000000), (t + 1, 10000000), (t, 7500)) f(d, v);
  perform pg_temp.check(d_cur  = e_cur,  format('current month: expected %s, got %s', e_cur,  d_cur));
  perform pg_temp.check(d_six  = e_six,  format('rolling six months: expected %s, got %s', e_six,  d_six));
  perform pg_temp.check(d_year = e_year, format('current year: expected %s, got %s', e_year, d_year));
  -- Named boundaries, so a regression names itself (true on any day these dates differ):
  perform pg_temp.check(m - 1 < m and six - 1 < six and y - 1 < y, 'boundary fixtures are distinct days');
  perform pg_temp.check((s -> 'revenue' -> 'gaps' ->> 'no_confirm_date')::int
                        - (base -> 'gaps' ->> 'no_confirm_date')::int = 1, 'the undated Order is COUNTED, not summed');
  perform pg_temp.check((s -> 'revenue' -> 'gaps' ->> 'future_confirm_date')::int
                        - (base -> 'gaps' ->> 'future_confirm_date')::int = 1, 'the future-dated Order is COUNTED, not summed');
  perform pg_temp.check((s -> 'revenue' -> 'gaps' ->> 'no_product_value_in_year')::int
                        - (base -> 'gaps' ->> 'no_product_value_in_year')::int = 1, 'an Order with no product value is COUNTED, not summed as zero');
  perform pg_temp.check((s -> 'revenue' -> 'current_month' ->> 'from')::date = m and (s -> 'revenue' -> 'current_month' ->> 'to')::date = t, 'current month is 1st to today');
  perform pg_temp.check((s -> 'revenue' -> 'last_six_months' ->> 'from')::date = six, 'six-month window starts at today minus six months plus one day');
  perform pg_temp.check((s -> 'revenue' -> 'current_year' ->> 'from')::date = y, 'year starts on 1 January');
  perform pg_temp.check(s -> 'revenue' ->> 'basis' = 'product_value' and s -> 'revenue' ->> 'date_basis' = 'confirm_date', 'the basis is named in the payload');
end $$;

-- After-discount product value: an Order that still carries its PI's gross reports the PI's subtotal.
do $$
declare
  t date := pg_temp.today();
  base jsonb := (select r from base_rev2);
  o uuid; sub uuid := gen_random_uuid(); s jsonb;
begin
  perform set_config('request.jwt.claims', '', true);
  o := pg_temp.mk_order('rev_discounted', 'running', null, t, null, 500000);
  insert into public.order_submissions (id, status, submitted_by, created_by, client_name, gross_product_amount, discount_amount, subtotal_after_discount, grand_total)
  values (sub, 'draft', current_setting('test.owner_id')::uuid, current_setting('test.owner_id')::uuid, 'DASH-sub', 500000, 25000, 475000, 560500);
  update public.orders set source_order_submission_id = sub where id = o;
  s := pg_temp.summary(current_setting('test.owner_id')::uuid);
  perform pg_temp.check(
    ((s -> 'revenue' -> 'current_month' ->> 'amount')::numeric - (base -> 'current_month' ->> 'amount')::numeric) - 7500 - 1 - 10 = 475000,
    'a discounted PI: product value is the AFTER-discount 475,000, not the gross 500,000');
end $$;

-- ═══ 8. Who sees what ═════════════════════════════════════════════════════════
do $$
declare
  t date := pg_temp.today();
  o uuid; s jsonb;
begin
  o := pg_temp.mk_order('sales_own',   'running', t - 3, t, 100, 100, 'not_aligned', false, current_setting('test.sales_id')::uuid);
  s := pg_temp.summary(current_setting('test.sales_id')::uuid);
  perform pg_temp.check(pg_temp.row_of(s, 'overdue', 'sales_own') is not null, 'a salesperson sees their own Order');
  perform pg_temp.check(pg_temp.row_of(s, 'overdue', 'due_30') is null, 'and NOT somebody else''s');
  perform pg_temp.check(s -> 'revenue' = 'null'::jsonb, 'a salesperson receives no revenue at all');
  perform pg_temp.check(s -> 'panic' = 'null'::jsonb and not (s -> 'viewer' ->> 'can_view_panic')::boolean, 'a salesperson receives no panic data');

  s := pg_temp.summary(current_setting('test.viewall_id')::uuid);
  perform pg_temp.check(s -> 'revenue' <> 'null'::jsonb, 'orders.view_all sees the company revenue');
  perform pg_temp.check(s -> 'panic' = 'null'::jsonb, 'view_all alone does NOT see PANIC MODE');
  s := pg_temp.summary(current_setting('test.admin2_id')::uuid);
  perform pg_temp.check(s -> 'panic' = 'null'::jsonb, 'an administrator WITHOUT the grant does not see PANIC MODE');
  perform pg_temp.check(s -> 'revenue' <> 'null'::jsonb, 'an administrator sees revenue');
end $$;

-- ═══ 9. PANIC MODE ════════════════════════════════════════════════════════════
-- The month's two slots are a property of the DATABASE, so start from an empty table: whatever a
-- previous run or a local session left there is removed INSIDE this transaction (which rolls back).
alter table public.order_panic_designations disable trigger order_panic_designations_guard;
delete from public.order_panic_designations;
alter table public.order_panic_designations enable trigger order_panic_designations_guard;

do $$
declare
  t date := pg_temp.today();
  a uuid; b uuid; c uuid; d uuid; e uuid; f uuid; des1 uuid; des2 uuid;
  s jsonb; r jsonb;
  m date := date_trunc('month', timezone('Asia/Kolkata', now()))::date;
begin
  a := pg_temp.mk_order('pan_a', 'running', t + 5, t, 100, 100);
  b := pg_temp.mk_order('pan_b', 'running', t + 5, t, 100, 100);
  c := pg_temp.mk_order('pan_c', 'running', t + 5, t, 100, 100);
  d := pg_temp.mk_order('pan_d', 'dispatched', null, t, 100, 100);

  -- Nobody but the owner may designate.
  perform pg_temp.become(current_setting('test.admin2_id')::uuid);
  perform pg_temp.expect_error_as(current_setting('test.admin2_id')::uuid, format('select public.designate_order_panic_mode(%L)', a), 'PANIC_MODE_NOT_OWNER', 'another administrator');
  perform pg_temp.become(current_setting('test.viewer_id')::uuid);
  perform pg_temp.expect_error_as(current_setting('test.viewer_id')::uuid, format('select public.designate_order_panic_mode(%L)', a), 'PANIC_MODE_NOT_OWNER', 'a holder of the VIEW grant');
  perform pg_temp.become(current_setting('test.sales_id')::uuid);
  perform pg_temp.expect_error_as(current_setting('test.sales_id')::uuid, format('select public.designate_order_panic_mode(%L)', a), 'PANIC_MODE_NOT_OWNER', 'a salesperson');
  perform pg_temp.restore();

  -- No direct table access for any client role, and a service-role style insert must still name the owner.
  perform pg_temp.become(current_setting('test.owner_id')::uuid);
  perform pg_temp.expect_error_as(current_setting('test.owner_id')::uuid, format('insert into public.order_panic_designations (order_id, designated_by, designated_month) values (%L, %L, date ''2000-01-01'')', a, current_setting('test.owner_id')), 'permission denied', 'the OWNER writing the table directly');
  perform pg_temp.become(current_setting('test.owner_id')::uuid);  -- expect_error restores the role
  perform pg_temp.expect_error_as(current_setting('test.owner_id')::uuid, 'select 1 from public.order_panic_designations', 'permission denied', 'the OWNER reading the table directly');
  perform pg_temp.restore();
  perform pg_temp.expect_error_as(null, format('insert into public.order_panic_designations (order_id, designated_by, designated_month) values (%L, %L, date ''2000-01-01'')', a, current_setting('test.admin2_id')), 'PANIC_MODE_NOT_OWNER', 'a direct insert naming somebody else');

  -- The owner designates two; the third is refused; a closed Order is refused.
  perform pg_temp.become(current_setting('test.owner_id')::uuid);
  des1 := (public.designate_order_panic_mode(a, 'Client escalation') ->> 'designation_id')::uuid;
  des2 := (public.designate_order_panic_mode(b, null) ->> 'designation_id')::uuid;
  perform pg_temp.expect_error_as(current_setting('test.owner_id')::uuid, format('select public.designate_order_panic_mode(%L)', c), 'PANIC_MODE_MONTH_LIMIT', 'a THIRD in one month');
  perform pg_temp.expect_error_as(current_setting('test.owner_id')::uuid, format('select public.designate_order_panic_mode(%L)', a), 'PANIC_MODE_ALREADY_ACTIVE', 'the same Order twice');
  perform pg_temp.expect_error_as(current_setting('test.owner_id')::uuid, format('select public.designate_order_panic_mode(%L)', d), 'PANIC_MODE_ORDER_CLOSED', 'a dispatched Order');
  perform pg_temp.expect_error_as(current_setting('test.owner_id')::uuid, format('select public.designate_order_panic_mode(%L, %L)', c, repeat('x', 201)), 'PANIC_MODE_REASON_TOO_LONG', 'an over-long reason');
  perform pg_temp.restore();

  -- Removal is recorded, and does NOT hand the slot back.
  perform pg_temp.become(current_setting('test.viewer_id')::uuid);
  perform pg_temp.expect_error_as(current_setting('test.viewer_id')::uuid, format('select public.remove_order_panic_mode(%L)', des1), 'PANIC_MODE_NOT_OWNER', 'a viewer removing');
  perform pg_temp.become(current_setting('test.owner_id')::uuid);
  perform public.remove_order_panic_mode(des2, 'Resolved with the client');
  perform pg_temp.expect_error_as(current_setting('test.owner_id')::uuid, format('select public.remove_order_panic_mode(%L)', des2), 'PANIC_MODE_NOT_ACTIVE', 'removing twice');
  perform pg_temp.expect_error_as(current_setting('test.owner_id')::uuid, format('select public.designate_order_panic_mode(%L)', c), 'PANIC_MODE_MONTH_LIMIT', 'a slot freed by removal');
  perform pg_temp.restore();
  perform pg_temp.check((select removed_by = current_setting('test.owner_id')::uuid and removed_at is not null and removal_reason = 'Resolved with the client'
                           from public.order_panic_designations where id = des2), 'removal records who, when and why');

  -- History is append-only, even for the table's own owner-level writers.
  perform pg_temp.expect_error_as(null, format('update public.order_panic_designations set reason = ''x'' where id = %L', des1), 'PANIC_MODE_HISTORY', 'rewriting a designation');
  perform pg_temp.expect_error_as(null, format('update public.order_panic_designations set removed_by = null, removed_at = null where id = %L', des2), 'PANIC_MODE_HISTORY', 'reviving a removed designation');
  perform pg_temp.expect_error_as(null, format('delete from public.order_panic_designations where id = %L', des1), 'PANIC_MODE_HISTORY', 'deleting history');

  -- Who sees the alert.
  s := pg_temp.summary(current_setting('test.owner_id')::uuid);
  perform pg_temp.check(jsonb_array_length(s -> 'panic' -> 'active') = 1 and s -> 'panic' -> 'active' -> 0 ->> 'display_number' is not null, 'the owner sees exactly the one active designation');
  perform pg_temp.check((s -> 'panic' ->> 'month_used')::int = 2 and (s -> 'panic' ->> 'month_limit')::int = 2 and (s -> 'panic' ->> 'can_manage')::boolean, 'the owner sees 2 of 2 used, and may manage');
  perform pg_temp.check(s -> 'panic' -> 'active' -> 0 ->> 'reason' = 'Client escalation' and s -> 'panic' -> 'active' -> 0 ->> 'designated_by_name' is not null, 'reason, and who designated it, are returned');
  s := pg_temp.summary(current_setting('test.viewer_id')::uuid);
  perform pg_temp.check(jsonb_array_length(s -> 'panic' -> 'active') = 1 and not (s -> 'panic' ->> 'can_manage')::boolean, 'a holder of the grant sees it READ-ONLY');

  -- A closed Order drops out of the alert; the designation stays in history.
  perform pg_temp.become(current_setting('test.owner_id')::uuid);
  perform pg_temp.restore();
  update public.orders set status = 'ready_for_dispatch' where id = a;  -- still open: stays in the alert
  s := pg_temp.summary(current_setting('test.owner_id')::uuid);
  perform pg_temp.check(jsonb_array_length(s -> 'panic' -> 'active') = 1, 'a ready-for-dispatch Order is still open, so still alerts');
  update public.orders set status = 'dispatched' where id = a;
  s := pg_temp.summary(current_setting('test.owner_id')::uuid);
  perform pg_temp.check(jsonb_array_length(s -> 'panic' -> 'active') = 0, 'a dispatched Order leaves the active alert');
  perform pg_temp.check(exists (select 1 from public.order_panic_designations where id = des1 and removed_at is null), '…but its designation is NOT silently cleared: it stays in history');

  -- A new month allows two new designations: backdate this month's rows (trigger off, test only).
  alter table public.order_panic_designations disable trigger order_panic_designations_guard;
  update public.order_panic_designations set designated_month = (m - interval '1 month')::date
   where id in (des1, des2);
  alter table public.order_panic_designations enable trigger order_panic_designations_guard;
  e := pg_temp.mk_order('pan_e', 'running', t + 5, t, 100, 100);
  f := pg_temp.mk_order('pan_f', 'running', t + 5, t, 100, 100);
  perform pg_temp.become(current_setting('test.owner_id')::uuid);
  perform public.designate_order_panic_mode(c, 'new month one');
  perform public.designate_order_panic_mode(e, 'new month two');
  perform pg_temp.expect_error_as(current_setting('test.owner_id')::uuid, format('select public.designate_order_panic_mode(%L)', f), 'PANIC_MODE_MONTH_LIMIT', 'a third in the new month');
  perform pg_temp.restore();
  perform pg_temp.check((select count(*) from public.order_panic_designations where designated_month = m) = 2, 'the new month holds exactly its own two');
end $$;

do $$ begin raise notice 'ALL ORDERS DASHBOARD ASSERTIONS PASSED'; end $$;

rollback;
