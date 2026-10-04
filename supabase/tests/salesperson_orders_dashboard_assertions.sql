-- THE SALESPERSON'S OWN ORDERS DASHBOARD (20270228000000)
-- ===========================================================================
--   1  who gets it       sales candidates only; admin, operations and a non-assignee get
--                        { applicable: false } and nothing else; a salesperson who ALSO holds
--                        orders.view_all (or a wide visibility scope) still gets the personal
--                        dashboard, counting only their own orders
--   2  ownership         orders.assigned_to (not created_by, not requested_by); submissions
--                        by order_submissions.salesperson_id; salesperson B's records never
--                        move salesperson A's figures
--   3  total orders      confirmed, including dispatched; not cancelled, test, drafts or
--                        pending PIs; one per Order however many PI versions
--   4  revenue           after-discount product value; IST month, inclusive start, exclusive
--                        next month; once per Order; cancelled/test out; equals the admin
--                        dashboard's own figure for the same orders
--   5  pending approval  submitted only; the card number is the list length; oldest first;
--                        drafts, returned, rejected, approved, reserved-for-deletion and
--                        salesperson-less PIs are not in it
--   6  advance           0%, 39.99%, exactly 40%, above 40%, an unverified payment, an approved
--                        exception, an invalid denominator, dispatched/cancelled
--   7  fabric / finish   either pending, both pending, both approved, newest event wins, a fresh
--                        order is listed (no 15-day gate) with the 15-day flag only past 15,
--                        a historical order with no record is listed APART as "unknown"
--   8  ready dispatch    the Order's own status and nothing inferred; earliest date first,
--                        undated last
--   9  completeness      lists of 0, 1, 5, 6 and 25 come back whole (no cap)
--
-- One transaction, ROLLBACK. Synthetic records only.
-- On success prints NOTICE 'ALL SALESPERSON DASHBOARD ASSERTIONS PASSED'.

\set ON_ERROR_STOP on

begin;

do $$
begin
  perform set_config('test.owner_id',   '11111111-1111-1111-1111-111111111111', true); -- TEST-001
  perform set_config('test.admin2_id',  'd0000000-0000-4000-8000-00000000e001', true);
  perform set_config('test.viewall_id', 'd0000000-0000-4000-8000-00000000e004', true);
  perform set_config('test.ops_id',     'd0000000-0000-4000-8000-00000000e005', true);
  perform set_config('test.a_id',       'd0000000-0000-4000-8000-00000000e011', true); -- salesperson A
  perform set_config('test.b_id',       'd0000000-0000-4000-8000-00000000e012', true); -- salesperson B
  perform set_config('test.c_id',       'd0000000-0000-4000-8000-00000000e013', true); -- salesperson C
  perform set_config('test.d_id',       'd0000000-0000-4000-8000-00000000e014', true); -- salesperson D
  perform set_config('test.p_id',       'd0000000-0000-4000-8000-00000000e015', true); -- salesperson P (revenue parity)
  perform set_config('test.n_id',       'd0000000-0000-4000-8000-00000000e016', true); -- NOT assignable (purchase)
  perform set_config('test.sv_id',      'd0000000-0000-4000-8000-00000000e017', true); -- salesperson who ALSO holds orders.view_all
  perform set_config('test.e_id',       'd0000000-0000-4000-8000-00000000e018', true); -- salesperson for the GST-basis cases
end $$;

insert into public.users (id, full_name, email, role, team, is_active, employee_code) values
  (current_setting('test.admin2_id')::uuid,  'SPD Admin2',   'spd-admin2@example.test',  'admin',  'management', true, 'ASSERT-S1'),
  (current_setting('test.viewall_id')::uuid, 'SPD ViewAll',  'spd-viewall@example.test', 'member', 'management', true, 'ASSERT-S4'),
  (current_setting('test.ops_id')::uuid,     'SPD Ops',      'spd-ops@example.test',     'member', 'operations', true, 'ASSERT-S5'),
  (current_setting('test.a_id')::uuid,       'SPD Sales A',  'spd-a@example.test',       'member', 'sales',      true, 'ASSERT-S11'),
  (current_setting('test.b_id')::uuid,       'SPD Sales B',  'spd-b@example.test',       'member', 'sales',      true, 'ASSERT-S12'),
  (current_setting('test.c_id')::uuid,       'SPD Sales C',  'spd-c@example.test',       'member', 'sales',      true, 'ASSERT-S13'),
  (current_setting('test.d_id')::uuid,       'SPD Sales D',  'spd-d@example.test',       'member', 'sales',      true, 'ASSERT-S14'),
  (current_setting('test.p_id')::uuid,       'SPD Sales P',  'spd-p@example.test',       'member', 'sales',      true, 'ASSERT-S15'),
  (current_setting('test.n_id')::uuid,       'SPD Purchase', 'spd-n@example.test',       'member', 'purchase',   true, 'ASSERT-S16'),
  (current_setting('test.sv_id')::uuid,      'SPD SalesViewAll', 'spd-sv@example.test',  'member', 'sales',      true, 'ASSERT-S17'),
  (current_setting('test.e_id')::uuid,       'SPD Sales E',  'spd-e@example.test',       'member', 'sales',      true, 'ASSERT-S18')
on conflict (id) do update set role = excluded.role, team = excluded.team, is_active = true, is_deleted = false;
update public.users set role = 'admin', is_active = true, is_deleted = false
 where id = current_setting('test.owner_id')::uuid;

insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
select g.uid, mpa.module_id, mpa.action_id, true, current_setting('test.owner_id')::uuid
  from (values
    (current_setting('test.admin2_id')::uuid,  'orders', 'view'),
    (current_setting('test.viewall_id')::uuid, 'orders', 'view'),
    (current_setting('test.viewall_id')::uuid, 'orders', 'view_all'),
    (current_setting('test.ops_id')::uuid,     'orders', 'view'),
    (current_setting('test.a_id')::uuid,       'orders', 'view'),
    (current_setting('test.b_id')::uuid,       'orders', 'view'),
    (current_setting('test.c_id')::uuid,       'orders', 'view'),
    (current_setting('test.d_id')::uuid,       'orders', 'view'),
    (current_setting('test.p_id')::uuid,       'orders', 'view'),
    (current_setting('test.n_id')::uuid,       'orders', 'view'),
    (current_setting('test.sv_id')::uuid,      'orders', 'view'),
    (current_setting('test.sv_id')::uuid,      'orders', 'view_all'),
    (current_setting('test.e_id')::uuid,       'orders', 'view')) g(uid, m, a)
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

/** The dashboard, read AS a person. */
create function pg_temp.dash(p_user uuid) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.become(p_user);
  v := public.salesperson_orders_dashboard();
  perform pg_temp.restore();
  return v;
end $$;
create function pg_temp.summary(p_user uuid) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.become(p_user);
  v := public.orders_dashboard_summary();
  perform pg_temp.restore();
  return v;
end $$;

create function pg_temp.today() returns date language sql as $$
  select timezone('Asia/Kolkata', now())::date;
$$;

/** The tags of one list, in order. */
create function pg_temp.tags(p_dash jsonb, p_list text) returns text[] language sql as $$
  select coalesce(array_agg(replace(x ->> 'client_name', 'SPD-', '') order by ord), '{}')
    from jsonb_array_elements(p_dash -> p_list) with ordinality as t(x, ord);
$$;

/** One Order: status, confirmation date, value, product value, salesperson, due date. */
create function pg_temp.mk_order(
  p_tag text, p_status text, p_confirm date, p_total numeric, p_product numeric,
  p_assigned uuid, p_due date default null, p_test boolean default false,
  p_requested_by uuid default null
, p_before numeric default null
) returns uuid language plpgsql as $$
declare v_id uuid := gen_random_uuid(); v_pi uuid;
begin
  perform set_config('request.jwt.claims', '', true);
  update public.test_data_cleanup_settings set enabled = p_test, permanently_disabled = false where id;
  -- THE ADVANCE BASIS (20270226000000): the 40% is a percentage of the total BEFORE GST, which the shared helper
  -- recovers from the PI stating the Order's value. An Order with a value gets a source PI stating it: by default
  -- a GST-free one (before GST = grand total), so every percentage below reads as it was written; p_before makes
  -- a PI with GST. An Order with no value has no PI, and so no basis.
  if p_total is not null then
    v_pi := gen_random_uuid();
    alter table public.order_submissions disable trigger user;
    insert into public.order_submissions (id, status, submitted_by, created_by, client_name, source_workbook_path,
                                          gross_product_amount, discount_amount, subtotal_after_discount,
                                          total_before_gst, gst_amount, grand_total, submitted_at, approved_by, approved_at)
    values (v_pi, 'approved', current_setting('test.owner_id')::uuid, current_setting('test.owner_id')::uuid, 'SPD-src-pi',
            'pi/' || v_pi::text || '.xlsx', 100, 0, 100, coalesce(p_before, p_total), p_total - coalesce(p_before, p_total), p_total, now(),
            current_setting('test.owner_id')::uuid, now());
    alter table public.order_submissions enable trigger user;
  end if;
  insert into public.orders (id, client_name, status, confirm_date, due_date, total_value, total_product_value,
                             created_by, assigned_to, requested_by, source_order_submission_id)
  values (v_id, 'SPD-' || p_tag, p_status, p_confirm, p_due, p_total, p_product,
          current_setting('test.owner_id')::uuid, p_assigned, p_requested_by, v_pi);
  update public.test_data_cleanup_settings set enabled = false where id;
  return v_id;
end $$;

create function pg_temp.make_historical(p_order uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  alter table public.orders disable trigger orders_guard_amendable_columns;
  update public.orders
     set created_at = (select fabric_finish_tracking_from from public.orders_dashboard_settings) - interval '30 days'
   where id = p_order;
  alter table public.orders enable trigger orders_guard_amendable_columns;
end $$;

/** Money allocated to an Order; p_status decides whether Finance has verified it. */
create function pg_temp.pay(p_order uuid, p_amount numeric, p_status text default 'approved_unlinked') returns uuid language plpgsql as $$
declare v_pay uuid := gen_random_uuid();
begin
  perform set_config('request.jwt.claims', '', true);
  insert into public.finance_payment_requests (id, client_name, amount, payment_date, payment_mode, status, submitted_by, received_in)
  values (v_pay, 'SPD-PAY', p_amount, current_date, 'hdfc', p_status, current_setting('test.owner_id')::uuid, null);
  insert into public.finance_payment_allocations (payment_request_id, order_id, allocated_amount, origin_target_type, created_by)
  values (v_pay, p_order, p_amount, 'confirmed_order', current_setting('test.owner_id')::uuid);
  return v_pay;
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

/** A PI version in force for an Order, from a submission with the given gross and discount. */
create function pg_temp.mk_version(p_order uuid, p_gross numeric, p_discount numeric, p_n int default 1, p_status text default 'approved') returns uuid language plpgsql as $$
declare v_sub uuid := gen_random_uuid(); v_ver uuid := gen_random_uuid();
begin
  perform set_config('request.jwt.claims', '', true);
  insert into public.order_submissions (id, status, submitted_by, created_by, client_name, gross_product_amount, discount_amount, subtotal_after_discount, grand_total)
  values (v_sub, 'draft', current_setting('test.owner_id')::uuid, current_setting('test.owner_id')::uuid, 'SPD-v', p_gross, p_discount, p_gross - p_discount, (p_gross - p_discount) * 1.18);
  alter table public.order_pi_versions disable trigger order_pi_versions_guard;
  insert into public.order_pi_versions (id, order_id, submission_id, version_number, status, decided_by, decided_at, decision_reason, superseded_at, revision_reason, pdf_order_number)
  values (v_ver, p_order, v_sub, p_n, p_status, current_setting('test.owner_id')::uuid, now(),
          case when p_status = 'rejected' then 'not needed' end,
          case when p_status = 'superseded' then now() end,
          case when p_n > 1 then 'client change' end, 'SPD-1');
  alter table public.order_pi_versions enable trigger order_pi_versions_guard;
  return v_ver;
end $$;

/** One PI submission: any status, any salesperson, submitted p_ago before now. */
create function pg_temp.mk_pi(p_tag text, p_status text, p_salesperson uuid, p_ago interval default interval '0', p_submitter uuid default null) returns uuid language plpgsql as $$
declare v_id uuid := gen_random_uuid();
begin
  perform set_config('request.jwt.claims', '', true);
  alter table public.order_submissions disable trigger user;
  insert into public.order_submissions (id, status, submitted_by, created_by, salesperson_id, client_name, source_workbook_path,
                                        gross_product_amount, discount_amount, subtotal_after_discount, grand_total, submitted_at,
                                        approved_by, approved_at, rejected_by, rejected_at)
  values (v_id, p_status, coalesce(p_submitter, p_salesperson, current_setting('test.owner_id')::uuid), coalesce(p_submitter, current_setting('test.owner_id')::uuid),
          p_salesperson, 'SPD-' || p_tag, 'pi/' || v_id::text || '.xlsx', 100, 0, 100, 118,
          case when p_status = 'draft' then null else now() - p_ago end,
          case when p_status = 'approved' then current_setting('test.owner_id')::uuid end,
          case when p_status = 'approved' then now() end,
          case when p_status = 'rejected' then current_setting('test.owner_id')::uuid end,
          case when p_status = 'rejected' then now() end);
  alter table public.order_submissions enable trigger user;
  return v_id;
end $$;

create function pg_temp.field(p_dash jsonb, p_list text, p_tag text, p_field text) returns text language sql as $$
  select x ->> p_field from jsonb_array_elements(p_dash -> p_list) x where x ->> 'client_name' = 'SPD-' || p_tag limit 1;
$$;

-- ═══ 0. Baseline: whatever the database already holds for these people is nothing ═══
do $$
declare s jsonb;
begin
  s := pg_temp.dash(current_setting('test.a_id')::uuid);
  perform pg_temp.check((s ->> 'applicable')::boolean, 'a sales candidate is offered the dashboard');
  perform pg_temp.check((s ->> 'total_orders')::int = 0 and jsonb_array_length(s -> 'pending') = 0
                        and jsonb_array_length(s -> 'ready_for_dispatch') = 0, 'a salesperson with no records sees zeros from a real, successful read');
end $$;

-- ═══ 1. Who gets it ═══════════════════════════════════════════════════════════
do $$
declare
  who uuid; s jsonb;
begin
  foreach who in array array[
    current_setting('test.owner_id')::uuid, current_setting('test.admin2_id')::uuid,
    current_setting('test.viewall_id')::uuid, current_setting('test.ops_id')::uuid,
    current_setting('test.n_id')::uuid] loop
    s := pg_temp.dash(who);
    perform pg_temp.check(s = '{"applicable": false}'::jsonb, format('%s gets { applicable: false } and no data: %s', who, s));
  end loop;

  -- A salesperson with the widest visibility scope still gets THEIR OWN dashboard.
  insert into public.order_visibility_scopes (user_id, mode) values (current_setting('test.a_id')::uuid, 'all_sales')
  on conflict (user_id) do update set mode = 'all_sales';
  perform pg_temp.mk_order('own_mine',  'running', pg_temp.today(), 100, 100, current_setting('test.a_id')::uuid);
  perform pg_temp.mk_order('own_other', 'running', pg_temp.today(), 100, 100, current_setting('test.b_id')::uuid);
  s := pg_temp.dash(current_setting('test.a_id')::uuid);
  perform pg_temp.check((s ->> 'total_orders')::int = 1, 'an all_sales scope does not widen the personal dashboard: A counts only A');
  s := pg_temp.dash(current_setting('test.b_id')::uuid);
  perform pg_temp.check((s ->> 'total_orders')::int = 1, 'and B counts only B');
  delete from public.order_visibility_scopes where user_id = current_setting('test.a_id')::uuid;

  -- A salesperson who ALSO holds orders.view_all: the personal dashboard, own orders only.
  perform pg_temp.mk_order('sv_mine',  'running', pg_temp.today(), 100, 100, current_setting('test.sv_id')::uuid);
  perform pg_temp.mk_order('sv_theirs','running', pg_temp.today(), 100, 100, current_setting('test.d_id')::uuid);
  perform pg_temp.mk_pi('sv_pi_other', 'submitted', current_setting('test.b_id')::uuid, interval '1 day');
  s := pg_temp.dash(current_setting('test.sv_id')::uuid);
  perform pg_temp.check((s ->> 'applicable')::boolean, 'a salesperson who holds orders.view_all is STILL offered the personal dashboard');
  perform pg_temp.check((s ->> 'total_orders')::int = 1 and not (s::text like '%sv_theirs%') and not (s::text like '%sv_pi_other%'),
    'and view_all does not broaden it: only their own order, none of D''s order or B''s PI');
  perform pg_temp.become(current_setting('test.sv_id')::uuid);
  perform pg_temp.check((select count(*) from public.orders where client_name = 'SPD-sv_theirs') = 1, 'while the broader read they hold elsewhere is untouched: they can still open D''s order');
  perform pg_temp.restore();

  -- Not by created_by, not by requested_by.
  perform pg_temp.mk_order('own_requested', 'running', pg_temp.today(), 100, 100, current_setting('test.b_id')::uuid, null, false, current_setting('test.a_id')::uuid);
  perform pg_temp.mk_order('own_unassigned', 'running', pg_temp.today(), 100, 100, null, null, false, current_setting('test.a_id')::uuid);
  s := pg_temp.dash(current_setting('test.a_id')::uuid);
  perform pg_temp.check((s ->> 'total_orders')::int = 1, 'an order A merely REQUESTED (assigned to B or nobody) is not A''s');
  perform pg_temp.check((pg_temp.dash(current_setting('test.b_id')::uuid) ->> 'total_orders')::int = 2, 'B owns two: the assigned one and the one requested by A');
end $$;

-- ═══ 3–4. Total orders and revenue ════════════════════════════════════════════
do $$
declare
  t  date := pg_temp.today();
  m  date := date_trunc('month', timezone('Asia/Kolkata', now()))::date;
  nm date := (date_trunc('month', timezone('Asia/Kolkata', now())) + interval '1 month')::date;
  c  uuid := current_setting('test.c_id')::uuid;
  o uuid; s jsonb; base_total int; base_rev numeric;
begin
  base_total := (pg_temp.dash(c) ->> 'total_orders')::int;
  base_rev   := (pg_temp.dash(c) -> 'revenue' ->> 'amount')::numeric;

  -- Product values 1,10,100,… name exactly which Orders the month holds.
  perform pg_temp.mk_order('rev_today',     'running',    t,      null, 1,       c);
  perform pg_temp.mk_order('rev_monthstart','dispatched', m,      null, 10,      c);   -- dispatched: confirmed, counted
  perform pg_temp.mk_order('rev_prevlast',  'running',    m - 1,  null, 100,     c);   -- last day of last month: OUT
  perform pg_temp.mk_order('rev_nextfirst', 'running',    nm,     null, 1000,    c);   -- first day of next month: OUT (exclusive)
  perform pg_temp.mk_order('rev_cancelled', 'cancelled',  t,      null, 10000,   c);
  perform pg_temp.mk_order('rev_test',      'running',    t,      null, 100000,  c, null, true);
  perform pg_temp.mk_order('rev_nodate',    'running',    null,   null, 1000000, c);
  perform pg_temp.mk_order('rev_noproduct', 'running',    t,      null, null,    c);
  -- ONE Order, three PI versions (V1 superseded, V2 in force with a 500 discount, V3 rejected):
  -- counted once, at V2's after-discount value (8,000 - 500 = 7,500).
  o := pg_temp.mk_order('rev_versions', 'running', t, null, 8000, c);
  perform pg_temp.mk_version(o, 6000, 0,   1, 'superseded');
  perform pg_temp.mk_version(o, 8000, 500, 2, 'approved');
  perform pg_temp.mk_version(o, 9000, 0,   3, 'rejected');
  -- A payment row beside an Order must not repeat it.
  perform pg_temp.pay(o, 100); perform pg_temp.pay(o, 200);

  s := pg_temp.dash(c);
  perform pg_temp.check((s -> 'revenue' ->> 'amount')::numeric - base_rev = 1 + 10 + 7500,
    format('revenue = after-discount product value of this month''s confirmed orders, once each: got %s', (s -> 'revenue' ->> 'amount')::numeric - base_rev));
  perform pg_temp.check((s -> 'revenue' ->> 'orders')::int = 3, 'three orders in the month have a product value');
  perform pg_temp.check((s -> 'revenue' ->> 'no_product_value')::int = 1, 'the unvalued order is COUNTED, not summed as zero');
  perform pg_temp.check((s ->> 'month_from')::date = m, 'the card is for the IST month starting m');
  -- Total orders: today, monthstart(dispatched), prevlast, nextfirst, nodate, noproduct, versions = 7; cancelled and test out.
  perform pg_temp.check((s ->> 'total_orders')::int - base_total = 7, format('total orders counts confirmed incl. dispatched, not cancelled/test: got %s', (s ->> 'total_orders')::int - base_total));
end $$;

-- Revenue parity with the admin dashboard for the same orders (all confirmed today, so inside its window).
do $$
declare
  t date := pg_temp.today(); p uuid := current_setting('test.p_id')::uuid; o uuid;
  base numeric; s jsonb;
begin
  base := (pg_temp.summary(current_setting('test.admin2_id')::uuid) -> 'revenue' -> 'current_month' ->> 'amount')::numeric;
  perform pg_temp.mk_order('par_plain', 'running', t, null, 2, p);
  o := pg_temp.mk_order('par_disc', 'running', t, null, 5000, p);
  perform pg_temp.mk_version(o, 5000, 700, 1, 'approved');
  perform pg_temp.mk_order('par_dispatched', 'dispatched', t, null, 30, p);
  s := pg_temp.dash(p);
  perform pg_temp.check((s -> 'revenue' ->> 'amount')::numeric = 2 + 4300 + 30, 'after-discount: 5000 gross with a 700 discount is 4300');
  perform pg_temp.check((pg_temp.summary(current_setting('test.admin2_id')::uuid) -> 'revenue' -> 'current_month' ->> 'amount')::numeric - base = (s -> 'revenue' ->> 'amount')::numeric,
    'PARITY: the personal figure is exactly what the admin dashboard adds for the same orders');
end $$;

-- ═══ 5. Pending approval ══════════════════════════════════════════════════════
do $$
declare
  b uuid := current_setting('test.b_id')::uuid; d uuid := current_setting('test.d_id')::uuid;
  s jsonb; base int; claimed uuid;
begin
  base := (pg_temp.dash(d) ->> 'pending_total')::int;
  perform pg_temp.mk_pi('pi_old',   'submitted',     d, interval '5 days');
  perform pg_temp.mk_pi('pi_new',   'submitted',     d, interval '2 hours');
  perform pg_temp.mk_pi('pi_draft', 'draft',         d);
  perform pg_temp.mk_pi('pi_back',  'needs_changes', d, interval '1 day');
  perform pg_temp.mk_pi('pi_rej',   'rejected',      d, interval '1 day');
  perform pg_temp.mk_pi('pi_appr',  'approved',      d, interval '1 day');
  perform pg_temp.mk_pi('pi_none',  'submitted',     null, interval '1 day');     -- no salesperson: nobody's
  perform pg_temp.mk_pi('pi_by_other', 'submitted',  d, interval '10 days', current_setting('test.owner_id')::uuid);  -- assigned to D, filed by somebody else
  perform pg_temp.mk_pi('pi_other', 'submitted',     b, interval '1 day');        -- someone else's
  claimed := pg_temp.mk_pi('pi_reserved', 'submitted', d, interval '1 day');
  perform set_config('request.jwt.claims', '', true);
  alter table public.order_submissions disable trigger user;
  update public.order_submissions set deletion_claim_token = gen_random_uuid(), deletion_claimed_at = now(), deletion_claimed_by = current_setting('test.owner_id')::uuid where id = claimed;
  alter table public.order_submissions enable trigger user;

  s := pg_temp.dash(d);
  perform pg_temp.check((s ->> 'pending_total')::int - base = 3, format('only SUBMITTED, owned, not-reserved PIs: got %s', (s ->> 'pending_total')::int - base));
  perform pg_temp.check(pg_temp.tags(s, 'pending') = array['pi_by_other', 'pi_old', 'pi_new'], format('longest waiting first: %s', pg_temp.tags(s, 'pending')));
  perform pg_temp.check((s ->> 'pending_total')::int = jsonb_array_length(s -> 'pending'), 'the card and the panel are one number');
  perform pg_temp.check((s -> 'pending' -> 0 ->> 'waiting_seconds')::numeric between 10 * 86400 and 10 * 86400 + 600, 'waiting time runs from the submission');
  perform pg_temp.check(not (s::text like '%pi_other%') and not (s::text like '%pi_none%'), 'B''s PI and the salesperson-less PI are not in D''s answer');
  perform pg_temp.check(s -> 'pending' -> 0 ? 'reference', 'a pending PI carries its PI reference (no order number exists yet)');
  perform pg_temp.check(not (s -> 'pending' -> 0 ? 'display_number'), 'and no invented order number');
  perform pg_temp.check((select (x ->> 'can_open')::boolean from jsonb_array_elements(s -> 'pending') x where x ->> 'client_name' = 'SPD-pi_old'), 'a PI the salesperson filed themselves can be opened by them');
  perform pg_temp.check(not (select (x ->> 'can_open')::boolean from jsonb_array_elements(s -> 'pending') x where x ->> 'client_name' = 'SPD-pi_by_other'),
    'a PI assigned to them but filed by somebody else is listed, and flagged as NOT openable under the existing PI rules');
  perform pg_temp.become(d);
  perform pg_temp.check(public.can_view_order_submission((select id from public.order_submissions where client_name = 'SPD-pi_old')), 'the existing rule agrees: filed by D, D may open it');
  perform pg_temp.check(not public.can_view_order_submission((select id from public.order_submissions where client_name = 'SPD-pi_by_other')), 'the existing rule agrees: filed by someone else, D may not (this PR does not change it)');
  perform pg_temp.restore();
end $$;

-- ═══ 6. Advance below 40% ═════════════════════════════════════════════════════
do $$
declare
  t date := pg_temp.today(); b uuid := current_setting('test.b_id')::uuid; o uuid; v uuid; s jsonb;
begin
  -- B already holds orders from section 1 (own_other, own_requested at 100 value, unpaid): ignore them by tag.
  o := pg_temp.mk_order('adv_zero',   'running', t - 1, 1000000, 800000, b);
  o := pg_temp.mk_order('adv_3999',   'running', t - 2, 1000000, 800000, b);  perform pg_temp.pay(o, 399999.99);
  o := pg_temp.mk_order('adv_exact',  'running', t - 3, 1000000, 800000, b);  perform pg_temp.pay(o, 400000.00);
  o := pg_temp.mk_order('adv_above',  'running', t - 4, 1000000, 800000, b);  perform pg_temp.pay(o, 650000);
  o := pg_temp.mk_order('adv_unver',  'running', t - 5, 1000000, 800000, b);  perform pg_temp.pay(o, 900000, 'pending_approval');
  o := pg_temp.mk_order('adv_mixed',  'running', t - 6, 1000000, 800000, b);  perform pg_temp.pay(o, 100000); perform pg_temp.pay(o, 500000, 'pending_approval');
  o := pg_temp.mk_order('adv_exc',    'running', t - 7, 1000000, 800000, b);  perform pg_temp.pay(o, 100000);
  v := pg_temp.mk_version(o, 800000, 0, 1, 'approved');
  insert into public.order_advance_exceptions (order_id, order_value, value_epoch, pi_version_id, verified_at_grant, shortfall_at_grant, reason, approved_by)
  select o, total_value, value_epoch, v, 100000, 300000, 'Approved: repeat client', current_setting('test.owner_id')::uuid from public.orders where id = o;
  o := pg_temp.mk_order('adv_null',   'running', t - 8, null, null, b);
  o := pg_temp.mk_order('adv_zeroval','running', t - 9, 0, 0, b);
  o := pg_temp.mk_order('adv_disp',   'dispatched', t - 10, 1000000, 800000, b);
  o := pg_temp.mk_order('adv_cxl',    'cancelled',  t - 11, 1000000, 800000, b);
  o := pg_temp.mk_order('adv_hold',   'on_hold', t - 12, 1000000, 800000, b);   -- active: listed
  o := pg_temp.mk_order('adv_test',   'running', t - 13, 1000000, 800000, b, null, true);
  o := pg_temp.mk_order('adv_other',  'running', t - 14, 1000000, 800000, current_setting('test.a_id')::uuid);

  s := pg_temp.dash(b);
  perform pg_temp.check(pg_temp.tags(s, 'advance') @> array['adv_zero', 'adv_3999', 'adv_unver', 'adv_mixed', 'adv_exc', 'adv_hold'], format('listed: %s', pg_temp.tags(s, 'advance')));
  perform pg_temp.check(not (pg_temp.tags(s, 'advance') && array['adv_exact', 'adv_above', 'adv_null', 'adv_zeroval', 'adv_disp', 'adv_cxl', 'adv_test', 'adv_other']),
    format('NOT listed: exactly 40%%, above 40%%, no value, dispatched, cancelled, test, someone else''s: %s', pg_temp.tags(s, 'advance')));
  perform pg_temp.check((pg_temp.field(s, 'advance', 'adv_zero', 'percent'))::numeric = 0, 'zero advance is 0%');
  perform pg_temp.check((pg_temp.field(s, 'advance', 'adv_3999', 'percent'))::numeric = 39.99, '399,999.99 of 1,000,000 is 39.99% (truncated, never rounded up to 40)');
  perform pg_temp.check((pg_temp.field(s, 'advance', 'adv_unver', 'percent'))::numeric = 0, 'an unverified payment adds nothing');
  perform pg_temp.check((pg_temp.field(s, 'advance', 'adv_mixed', 'percent'))::numeric = 10, 'only the verified 100,000 counts, not the unverified 500,000');
  perform pg_temp.check((pg_temp.field(s, 'advance', 'adv_exc', 'exception_approved'))::boolean and (pg_temp.field(s, 'advance', 'adv_exc', 'percent'))::numeric = 10,
    'an approved exception does not remove the order, and the ACTUAL verified percent is shown');
  perform pg_temp.check((select bool_and((x ->> 'percent')::numeric >= lag_p) from (
      select x, coalesce(lag((x ->> 'percent')::numeric) over (order by ord), 0) as lag_p
        from jsonb_array_elements(s -> 'advance') with ordinality t(x, ord)) q), 'lowest percentage first');
  perform pg_temp.check(jsonb_array_length(s -> 'advance_unchecked') = 2 and pg_temp.tags(s, 'advance_unchecked') @> array['adv_null', 'adv_zeroval'],
    format('the orders with no usable value are LISTED (not just counted) and given no percentage: %s', pg_temp.tags(s, 'advance_unchecked')));
  perform pg_temp.check(not (pg_temp.tags(s, 'advance') && pg_temp.tags(s, 'advance_unchecked')), 'and an order is never in both lists');
  perform pg_temp.check(not (s::text ~* '(nan|infinity)'), 'no NaN or Infinity anywhere in the answer');
end $$;

-- ═══ 6b. The advance is a percentage of the total BEFORE GST (20270226000000) ═══
-- Orders whose grand total includes 18% GST: ₹1,18,000 grand total, ₹1,00,000 before GST. The list divides by
-- nothing of its own — it carries the shared helper's percentage — so it follows the helper exactly.
do $$
declare
  t date := pg_temp.today(); e uuid := current_setting('test.e_id')::uuid; o uuid; s jsonb;
begin
  o := pg_temp.mk_order('gst_exact', 'running', t - 1, 118000, 100000, e, t + 5, false, null, 100000);
  perform pg_temp.pay(o, 40000);
  o := pg_temp.mk_order('gst_3999', 'running', t - 2, 118000, 100000, e, t + 5, false, null, 100000);
  perform pg_temp.pay(o, 39990);
  o := pg_temp.mk_order('gst_3999paise', 'running', t - 3, 118000, 100000, e, t + 5, false, null, 100000);
  perform pg_temp.pay(o, 39999.99);
  o := pg_temp.mk_order('gst_unver', 'running', t - 4, 118000, 100000, e, t + 5, false, null, 100000);
  perform pg_temp.pay(o, 90000, 'pending_approval');
  o := pg_temp.mk_order('gst_old_basis', 'running', t - 5, 118000, 100000, e, t + 5, false, null, 100000);
  perform pg_temp.pay(o, 45000);                       -- 33.9% of the grand total, 45% of the total before GST: NOT listed
  o := pg_temp.mk_order('gst_nobasis', 'running', t - 6, 118000, 100000, e, t + 5, false, null, 100000);
  perform pg_temp.restore();
  alter table public.orders disable trigger orders_guard_amendable_columns;
  update public.orders set total_value = 125000 where id = o;   -- value amended away from its PI: no recoverable basis
  alter table public.orders enable trigger orders_guard_amendable_columns;
  perform pg_temp.pay(o, 50000);

  s := pg_temp.dash(e);
  perform pg_temp.check(pg_temp.tags(s, 'advance') = array['gst_unver', 'gst_3999paise', 'gst_3999'],
    format('on the total before GST: exactly 40%% and 45%% are not listed; 0%%, 39.99%% and 39.99%% are: %s', pg_temp.tags(s, 'advance')));
  perform pg_temp.check((pg_temp.field(s, 'advance', 'gst_3999', 'percent'))::numeric = 39.99 and (pg_temp.field(s, 'advance', 'gst_3999paise', 'percent'))::numeric = 39.99,
    '₹39,990 and ₹39,999.99 both read 39.99%, never 40');
  perform pg_temp.check((pg_temp.field(s, 'advance', 'gst_unver', 'percent'))::numeric = 0, 'an unverified payment adds nothing');
  perform pg_temp.check(pg_temp.tags(s, 'advance_unchecked') = array['gst_nobasis'], 'the order whose value was amended away from its PI has no basis: LISTED as not checked, never given a percentage');
  perform pg_temp.check(not (s::text ~* '(nan|infinity)'), 'no NaN or Infinity anywhere');
end $$;

-- ═══ 7. Fabric / finish ═══════════════════════════════════════════════════════
do $$
declare
  t date := pg_temp.today(); c uuid := current_setting('test.c_id')::uuid; o uuid; s jsonb; j jsonb;
begin
  o := pg_temp.mk_order('ff_fresh', 'running', t, 100, 100, c);                       -- today, no events, new order: pending (both), NOT gated by 15 days
  o := pg_temp.mk_order('ff_16',    'running', t - 16, 100, 100, c);
    perform pg_temp.fabric(o, 'fabric', 'not_approved', now() - interval '16 days');
    perform pg_temp.fabric(o, 'finish', 'not_approved', now() - interval '16 days');
  o := pg_temp.mk_order('ff_15',    'running', t - 15, 100, 100, c);
    perform pg_temp.fabric(o, 'fabric', 'fully_approved', now() - interval '2 days');
    perform pg_temp.fabric(o, 'finish', 'not_approved', now() - interval '2 days');
  o := pg_temp.mk_order('ff_fab_only', 'running', t - 20, 100, 100, c);
    perform pg_temp.fabric(o, 'fabric', 'partially_approved', now() - interval '3 days');   -- partial is NOT approved
    perform pg_temp.fabric(o, 'finish', 'fully_approved', now() - interval '3 days');
  o := pg_temp.mk_order('ff_done',  'running', t - 30, 100, 100, c);
    perform pg_temp.fabric(o, 'fabric', 'fully_approved', now() - interval '3 days');
    perform pg_temp.fabric(o, 'finish', 'fully_approved', now() - interval '2 days');
  o := pg_temp.mk_order('ff_reverted', 'running', t - 25, 100, 100, c);
    perform pg_temp.fabric(o, 'fabric', 'fully_approved', now() - interval '5 days');
    perform pg_temp.fabric(o, 'fabric', 'not_approved', now() - interval '1 day');          -- newest wins
    perform pg_temp.fabric(o, 'finish', 'fully_approved', now() - interval '2 days');
  o := pg_temp.mk_order('ff_history', 'running', t - 60, 100, 100, c);  perform pg_temp.make_historical(o);   -- ambiguous: counted, not listed
  o := pg_temp.mk_order('ff_disp', 'dispatched', t - 40, 100, 100, c);
  o := pg_temp.mk_order('ff_other', 'running', t - 40, 100, 100, current_setting('test.a_id')::uuid);
  o := pg_temp.mk_order('ff_nodate', 'running', null, 100, 100, c);

  s := pg_temp.dash(c);
  perform pg_temp.check(pg_temp.tags(s, 'fabric_finish') @> array['ff_fresh', 'ff_16', 'ff_15', 'ff_fab_only', 'ff_reverted', 'ff_nodate'], format('listed: %s', pg_temp.tags(s, 'fabric_finish')));
  perform pg_temp.check(not (pg_temp.tags(s, 'fabric_finish') && array['ff_done', 'ff_history', 'ff_disp', 'ff_other']), format('not listed: %s', pg_temp.tags(s, 'fabric_finish')));
  j := (select x from jsonb_array_elements(s -> 'fabric_finish') x where x ->> 'client_name' = 'SPD-ff_fresh');
  perform pg_temp.check(jsonb_array_length(j -> 'pending') = 2 and not (j ->> 'over_15_days')::boolean, 'a fresh order with both pending is listed at once, with no 15-day flag');
  perform pg_temp.check((pg_temp.field(s, 'fabric_finish', 'ff_16', 'over_15_days'))::boolean, '16 days carries the urgency flag');
  perform pg_temp.check(not (pg_temp.field(s, 'fabric_finish', 'ff_15', 'over_15_days'))::boolean, '15 days does not');
  perform pg_temp.check(jsonb_array_length((select x -> 'pending' from jsonb_array_elements(s -> 'fabric_finish') x where x ->> 'client_name' = 'SPD-ff_15')) = 1, 'fabric approved, finish pending: listed once, for finish only');
  perform pg_temp.check((select x -> 'pending' -> 0 ->> 'kind' from jsonb_array_elements(s -> 'fabric_finish') x where x ->> 'client_name' = 'SPD-ff_fab_only') = 'fabric', 'partially approved fabric is pending; the approved finish is not');
  perform pg_temp.check(pg_temp.tags(s, 'fabric_finish_unknown') @> array['ff_history'], 'the historical order with no record is listed as UNKNOWN, not omitted');
  perform pg_temp.check(not (pg_temp.tags(s, 'fabric_finish') && array['ff_history']), 'and it is not mixed into the known-pending list');
  perform pg_temp.check((select x -> 'unknown' from jsonb_array_elements(s -> 'fabric_finish_unknown') x where x ->> 'client_name' = 'SPD-ff_history') = '["fabric", "finish"]'::jsonb, 'unknown says WHICH items have no record');
  perform pg_temp.check(not (pg_temp.tags(s, 'fabric_finish_unknown') && array['ff_done', 'ff_fresh', 'ff_16', 'ff_disp', 'ff_other']), 'approved, pending, dispatched and others'' orders are not unknown');
  o := pg_temp.mk_order('ff_hist_mixed', 'running', t - 70, 100, 100, c); perform pg_temp.make_historical(o);
    perform pg_temp.fabric(o, 'fabric', 'not_approved', now() - interval '60 days');
  s := pg_temp.dash(c);
  perform pg_temp.check((select x -> 'unknown' from jsonb_array_elements(s -> 'fabric_finish') x where x ->> 'client_name' = 'SPD-ff_hist_mixed') = '["finish"]'::jsonb
                        and not (pg_temp.tags(s, 'fabric_finish_unknown') && array['ff_hist_mixed']), 'a known pending item plus an unknown one: one row, in pending, naming the unknown item');
  perform pg_temp.check(not (s::text ~ 'fabric_finish_unrecorded'), 'the old count is gone');
  perform pg_temp.check((select count(*) from jsonb_array_elements(s -> 'fabric_finish') x where x ->> 'client_name' = 'SPD-ff_16') = 1, 'an order with both pending appears once');
  perform pg_temp.check((pg_temp.tags(s, 'fabric_finish'))[array_length(pg_temp.tags(s, 'fabric_finish'), 1)] = 'ff_nodate' , 'oldest confirmation first, no confirmation date last');
end $$;

-- ═══ 8. Ready for dispatch ════════════════════════════════════════════════════
do $$
declare
  t date := pg_temp.today(); d uuid := current_setting('test.d_id')::uuid; o uuid; s jsonb;
begin
  perform pg_temp.mk_order('rd_late',  'ready_for_dispatch', t - 5, 100, 100, d, t + 9);
  perform pg_temp.mk_order('rd_soon',  'ready_for_dispatch', t - 5, 100, 100, d, t + 1);
  perform pg_temp.mk_order('rd_undated','ready_for_dispatch', t - 5, 100, 100, d, null);
  -- Everything that LOOKS ready but is not: fully paid, both approvals complete, past its date, running.
  o := pg_temp.mk_order('rd_looks_ready', 'running', t - 30, 100, 100, d, t - 3);
  perform pg_temp.pay(o, 100);
  perform pg_temp.fabric(o, 'fabric', 'fully_approved', now() - interval '3 days');
  perform pg_temp.fabric(o, 'finish', 'fully_approved', now() - interval '3 days');
  perform pg_temp.mk_order('rd_disp', 'dispatched', t - 5, 100, 100, d, t - 1);
  perform pg_temp.mk_order('rd_cxl',  'cancelled',  t - 5, 100, 100, d, t - 1);
  perform pg_temp.mk_order('rd_hold', 'on_hold',    t - 5, 100, 100, d, t - 1);
  perform pg_temp.mk_order('rd_other','ready_for_dispatch', t - 5, 100, 100, current_setting('test.a_id')::uuid, t);
  perform pg_temp.mk_order('rd_test', 'ready_for_dispatch', t - 5, 100, 100, d, t, true);

  s := pg_temp.dash(d);
  perform pg_temp.check(pg_temp.tags(s, 'ready_for_dispatch') = array['rd_soon', 'rd_late', 'rd_undated'], format('only the explicit status, earliest date first, undated last: %s', pg_temp.tags(s, 'ready_for_dispatch')));
  perform pg_temp.check(pg_temp.field(s, 'ready_for_dispatch', 'rd_soon', 'planned_dispatch_date')::date = t + 1, 'the existing planned (due) date is carried');
  perform pg_temp.check(pg_temp.field(s, 'ready_for_dispatch', 'rd_undated', 'planned_dispatch_date') is null, 'and an undated order says so with null, never a guess');
end $$;

-- ═══ 9. Completeness: 0, 1, 5, 6 and 25 rows come back whole ═══════════════════
do $$
declare
  t date := pg_temp.today(); a uuid := current_setting('test.a_id')::uuid; b uuid := current_setting('test.b_id')::uuid;
  c uuid := current_setting('test.c_id')::uuid; d uuid := current_setting('test.d_id')::uuid;
  i int; s jsonb; base_a int; base_b int; base_c int; base_d int; base_pa int;
begin
  base_a := jsonb_array_length(pg_temp.dash(a) -> 'ready_for_dispatch');
  base_b := jsonb_array_length(pg_temp.dash(b) -> 'advance');
  base_c := jsonb_array_length(pg_temp.dash(c) -> 'fabric_finish');
  base_d := jsonb_array_length(pg_temp.dash(d) -> 'pending');
  for i in 1..25 loop perform pg_temp.mk_order('c25_' || i, 'ready_for_dispatch', t, 100, 100, a, t + i); end loop;
  for i in 1..6  loop perform pg_temp.mk_order('c6_'  || i, 'running', t - i, 1000, 1000, b); end loop;
  for i in 1..5  loop perform pg_temp.mk_order('c5_'  || i, 'running', t - i, 100, 100, c); end loop;
  perform pg_temp.mk_pi('c1_pi', 'submitted', d, interval '1 hour');

  s := pg_temp.dash(a);
  perform pg_temp.check(jsonb_array_length(s -> 'ready_for_dispatch') - base_a = 25, '25 ready orders: all 25 rows');
  s := pg_temp.dash(b);
  perform pg_temp.check(jsonb_array_length(s -> 'advance') - base_b = 6, '6 advance orders: all 6 rows');
  s := pg_temp.dash(c);
  perform pg_temp.check(jsonb_array_length(s -> 'fabric_finish') - base_c = 5, '5 fabric/finish orders: all 5 rows');
  s := pg_temp.dash(d);
  perform pg_temp.check(jsonb_array_length(s -> 'pending') - base_d = 1 and (s ->> 'pending_total')::int = jsonb_array_length(s -> 'pending'), '1 pending PI: 1 row, card = panel');
  -- Zero lists are empty arrays, never null and never an error.
  s := pg_temp.dash(current_setting('test.p_id')::uuid);
  perform pg_temp.check(jsonb_typeof(s -> 'pending') = 'array' and jsonb_array_length(s -> 'ready_for_dispatch') = 0, 'an empty list is an empty array');
end $$;

-- ═══ 10. The grants ═══════════════════════════════════════════════════════════
do $$
begin
  perform pg_temp.restore();
  perform pg_temp.check(not has_function_privilege('anon', 'public.salesperson_orders_dashboard()', 'execute'), 'anon cannot execute it');
  perform pg_temp.check(has_function_privilege('authenticated', 'public.salesperson_orders_dashboard()', 'execute'), 'signed-in users can');
  perform pg_temp.check((select pronargs = 0 and prosecdef and exists (select 1 from unnest(proconfig) c where c like 'search_path=%pg_temp%')
                           from pg_proc where oid = 'public.salesperson_orders_dashboard()'::regprocedure),
    'no arguments (so no way to name another salesperson), SECURITY DEFINER, search_path pinned with pg_temp last');
  perform pg_temp.check(not has_function_privilege('public', 'public.salesperson_orders_dashboard()', 'execute'), 'PUBLIC cannot execute it');
  begin
    execute 'set local role anon';
    perform public.salesperson_orders_dashboard();
    raise exception 'ASSERT FAILED: anon must be refused';
  exception when others then
    perform pg_temp.restore();
    if sqlerrm not like '%permission denied%' then raise; end if;
  end;
  begin
    perform public.salesperson_orders_dashboard();   -- no JWT: refused, not an empty dashboard
    raise exception 'ASSERT FAILED: an unauthenticated call must be refused';
  exception when others then
    if sqlerrm not like '%Authentication required%' then raise; end if;
  end;
end $$;

do $$ begin raise notice 'ALL SALESPERSON DASHBOARD ASSERTIONS PASSED'; end $$;
rollback;
