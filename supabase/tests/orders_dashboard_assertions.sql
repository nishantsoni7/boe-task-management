-- THE ORDERS DASHBOARD: Factory Focus, alignment, advance, fabric/finish, revenue
-- and Order visibility scopes (20270221000000)
-- ===========================================================================
--   1  alignment        every state says WHOSE court it is in and SINCE WHEN; an order
--                       flagged for clarification is never "waiting for the reviewer"
--   2  advance          the 40% line; an approved exception is STILL listed, and said
--   3  fabric / finish  each item on its own; 15 days is not flagged, 16 is; a status
--                       that was never recorded is a SEPARATE list, never "pending"
--   4  no overdue       the overdue group is gone from the read
--   5  revenue          this month to today; the six COMPLETED months before it; the
--                       year; once per Order however many PI versions; after discount
--   6  Factory Focus    owner only; two NEW per IST month (removal refunds nothing);
--                       active selections carry into later months; removal needs a
--                       reason and is manual (a dispatch hides nothing); everybody with
--                       Orders entry sees WHICH orders, and only a reader who may open
--                       one sees its client; the removal reason reaches the salesperson
--   7  visibility       own / selected / all_sales enforced in the database: direct table
--                       reads, the summary's counts and lists, updates, and no Finance
--                       (allocations, payments, payment totals) and no revenue widened
--
-- One transaction, ROLLBACK. Synthetic records only.
-- On success prints NOTICE 'ALL ORDERS DASHBOARD ASSERTIONS PASSED'.

\set ON_ERROR_STOP on

begin;

do $$
begin
  perform set_config('test.owner_id',   '11111111-1111-1111-1111-111111111111', true); -- TEST-001
  perform set_config('test.admin2_id',  'd0000000-0000-4000-8000-00000000d001', true); -- another active admin
  perform set_config('test.viewall_id', 'd0000000-0000-4000-8000-00000000d004', true); -- orders.view_all
  perform set_config('test.rev_id',     'd0000000-0000-4000-8000-00000000d005', true); -- operations reviewer ("Nitish")
  perform set_config('test.s1_id',      'd0000000-0000-4000-8000-00000000d011', true); -- sales candidate 1
  perform set_config('test.s2_id',      'd0000000-0000-4000-8000-00000000d012', true); -- sales candidate 2
  perform set_config('test.s3_id',      'd0000000-0000-4000-8000-00000000d013', true); -- sales candidate 3
  perform set_config('test.n_id',       'd0000000-0000-4000-8000-00000000d014', true); -- NOT a candidate (purchase team)
end $$;

insert into public.users (id, full_name, email, role, team, is_active, employee_code) values
  (current_setting('test.admin2_id')::uuid,  'DASH Admin2',   'd-admin2@example.test',  'admin',  'management', true, 'ASSERT-D1'),
  (current_setting('test.viewall_id')::uuid, 'DASH ViewAll',  'd-viewall@example.test', 'member', 'management', true, 'ASSERT-D4'),
  (current_setting('test.rev_id')::uuid,     'DASH Reviewer', 'd-rev@example.test',     'member', 'operations', true, 'ASSERT-D5'),
  (current_setting('test.s1_id')::uuid,      'DASH Sales One','d-s1@example.test',      'member', 'sales',      true, 'ASSERT-D11'),
  (current_setting('test.s2_id')::uuid,      'DASH Sales Two','d-s2@example.test',      'member', 'sales',      true, 'ASSERT-D12'),
  (current_setting('test.s3_id')::uuid,      'DASH Sales Tri','d-s3@example.test',      'member', 'sales',      true, 'ASSERT-D13'),
  (current_setting('test.n_id')::uuid,       'DASH Purchase', 'd-n@example.test',       'member', 'purchase',   true, 'ASSERT-D14')
on conflict (id) do update set role = excluded.role, team = excluded.team, is_active = true, is_deleted = false;
update public.users set role = 'admin', is_active = true, is_deleted = false
 where id = current_setting('test.owner_id')::uuid;

insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
select g.uid, mpa.module_id, mpa.action_id, true, current_setting('test.owner_id')::uuid
  from (values
    (current_setting('test.admin2_id')::uuid,  'orders', 'view'),
    (current_setting('test.viewall_id')::uuid, 'orders', 'view'),
    (current_setting('test.viewall_id')::uuid, 'orders', 'view_all'),
    (current_setting('test.rev_id')::uuid,     'orders', 'view'),
    (current_setting('test.s1_id')::uuid,      'orders', 'view'),
    (current_setting('test.s2_id')::uuid,      'orders', 'view'),
    (current_setting('test.s3_id')::uuid,      'orders', 'view'),
    (current_setting('test.n_id')::uuid,       'orders', 'view')) g(uid, m, a)
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
/** The Factory Focus card for one fixture Order (matched by its number). */
create function pg_temp.card_of(p_sum jsonb, p_number text) returns jsonb language sql as $$
  select x from jsonb_array_elements(p_sum -> 'factory_focus' -> 'active') x
   where x ->> 'display_number' = p_number limit 1;
$$;
create function pg_temp.number_of(p_tag text) returns text language sql as $$
  select display_number from public.orders where client_name = 'DASH-' || p_tag;
$$;

create function pg_temp.today() returns date language sql as $$
  select timezone('Asia/Kolkata', now())::date;
$$;

/** One Order: status, confirmation date, value, product value, salesperson, test flag. */
create function pg_temp.mk_order(
  p_tag text, p_status text, p_confirm date,
  p_total numeric, p_product numeric,
  p_assigned uuid default null, p_test boolean default false,
  p_requested_by uuid default null
) returns uuid language plpgsql as $$
declare v_id uuid := gen_random_uuid();
begin
  perform set_config('request.jwt.claims', '', true);
  -- The flag is STAMPED at insert from the cleanup phase (stamp_test_data_flag) and is immutable, so a
  -- test-data fixture is inserted while the phase is on, and a real one while it is off.
  update public.test_data_cleanup_settings set enabled = p_test, permanently_disabled = false where id;
  insert into public.orders (id, client_name, status, confirm_date, total_value, total_product_value,
                             created_by, assigned_to, requested_by)
  values (v_id, 'DASH-' || p_tag, p_status, p_confirm, p_total, p_product,
          current_setting('test.owner_id')::uuid, p_assigned, p_requested_by);
  update public.test_data_cleanup_settings set enabled = false where id;
  return v_id;
end $$;

/** Verified money allocated to an Order. Returns the payment id. */
create function pg_temp.pay(p_order uuid, p_amount numeric) returns uuid language plpgsql as $$
declare v_pay uuid := gen_random_uuid();
begin
  perform set_config('request.jwt.claims', '', true);
  insert into public.finance_payment_requests (id, client_name, amount, payment_date, payment_mode, status, submitted_by, received_in)
  values (v_pay, 'DASH-PAY', p_amount, current_date, 'hdfc', 'approved_unlinked', current_setting('test.owner_id')::uuid, null);
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

/** A PI version in force for an Order — which makes the REAL trigger record the handoff. */
create function pg_temp.mk_version(p_order uuid) returns uuid language plpgsql as $$
declare v_sub uuid := gen_random_uuid(); v_ver uuid := gen_random_uuid();
begin
  perform set_config('request.jwt.claims', '', true);
  insert into public.order_submissions (id, status, submitted_by, created_by, client_name, gross_product_amount, discount_amount, subtotal_after_discount, grand_total)
  values (v_sub, 'draft', current_setting('test.owner_id')::uuid, current_setting('test.owner_id')::uuid, 'DASH-v', 100, 0, 100, 118);
  alter table public.order_pi_versions disable trigger order_pi_versions_guard;
  insert into public.order_pi_versions (id, order_id, submission_id, version_number, status, decided_by, decided_at, pdf_order_number)
  values (v_ver, p_order, v_sub, 1, 'approved', current_setting('test.owner_id')::uuid, now(), 'DASH-1');
  alter table public.order_pi_versions enable trigger order_pi_versions_guard;
  return v_ver;
end $$;

-- ═══ 0. Baseline, so revenue deltas are exact ═════════════════════════════════
create temporary table base_rev on commit drop as
  select pg_temp.summary(current_setting('test.owner_id')::uuid) -> 'revenue' as r;

-- ═══ 1–4. Alignment, advance, fabric/finish, no overdue ══════════════════════
do $$
declare
  t date := pg_temp.today();
  o uuid; v uuid; s jsonb; r jsonb;
begin
  -- The configured operations reviewer.
  delete from public.order_operations_reviewers where duty = 'pi_handoff';
  insert into public.order_operations_reviewers (duty, user_id, assigned_by)
  values ('pi_handoff', current_setting('test.rev_id')::uuid, current_setting('test.owner_id')::uuid);

  -- ── alignment states ──
  o := pg_temp.mk_order('al_wait', 'running', t, 100, 100);                 v := pg_temp.mk_version(o);
  perform set_config('request.jwt.claims', '', true);
  alter table public.order_operations_handoffs disable trigger order_operations_handoffs_guard;
  update public.order_operations_handoffs set approved_at = now() - interval '3 days 4 hours' where order_id = o;

  o := pg_temp.mk_order('al_flag', 'running', t, 100, 100);                 v := pg_temp.mk_version(o);
  update public.order_operations_handoffs
     set status = 'clarification_needed', clarification_by = current_setting('test.rev_id')::uuid,
         clarification_at = now() - interval '2 days', clarification_reason = 'Sofa fabric not stocked',
         approved_at = now() - interval '9 days'
   where order_id = o;

  -- No reviewer configured at the moment of approval → recorded unassigned.
  update public.order_operations_reviewers set user_id = null where duty = 'pi_handoff';
  o := pg_temp.mk_order('al_unassigned', 'running', t, 100, 100);           v := pg_temp.mk_version(o);
  update public.order_operations_handoffs set approved_at = now() - interval '5 days' where order_id = o;
  update public.order_operations_reviewers set user_id = current_setting('test.rev_id')::uuid where duty = 'pi_handoff';
  alter table public.order_operations_handoffs enable trigger order_operations_handoffs_guard;

  o := pg_temp.mk_order('al_none', 'running', t, 100, 100);                 -- legacy: no handoff at all
  o := pg_temp.mk_order('al_held', 'running', t, 100, 100);
  insert into public.order_advance_holds (order_id, cause, order_value, value_epoch, verified, held_at)
  values (o, 'value_changed', 100, 0, 0, now() - interval '6 days');
  o := pg_temp.mk_order('al_done', 'running', t, 100, 100);                 -- aligned: must not appear
  perform pg_temp.pay(o, 40);
  perform set_config('boe.production_alignment_context', 'production_alignment', true);
  update public.orders set production_alignment = 'aligned' where id = o;
  perform set_config('boe.production_alignment_context', '', true);

  -- ── advance ──
  o := pg_temp.mk_order('adv_short',  'running', t, 1000000, 800000);  perform pg_temp.pay(o, 399999.99);
  o := pg_temp.mk_order('adv_exact',  'running', t, 1000000, 800000);  perform pg_temp.pay(o, 400000.00);
  o := pg_temp.mk_order('adv_zero',   'running', t, 1000000, 800000);
  o := pg_temp.mk_order('adv_noval',  'running', t, null,    null);
  o := pg_temp.mk_order('adv_disp',   'dispatched', t, 1000000, 800000);
  -- An approved reduced-advance exception for THIS value basis and version.
  o := pg_temp.mk_order('adv_exc',    'running', t, 1000000, 800000);  perform pg_temp.pay(o, 100000);
  v := pg_temp.mk_version(o);
  insert into public.order_advance_exceptions (order_id, order_value, value_epoch, pi_version_id, verified_at_grant, shortfall_at_grant, reason, approved_by)
  select o, total_value, value_epoch, v, 100000, 300000, 'Approved: repeat client, pays on delivery', current_setting('test.owner_id')::uuid
    from public.orders where id = o;

  -- ── fabric / finish ──
  o := pg_temp.mk_order('ff_15',  'running', t - 15, 100, 100);
  o := pg_temp.mk_order('ff_16',  'running', t - 16, 100, 100);
    perform pg_temp.fabric(o, 'fabric', 'not_approved', now() - interval '16 days');
    perform pg_temp.fabric(o, 'finish', 'not_approved', now() - interval '16 days');
  o := pg_temp.mk_order('ff_fab_done', 'running', t - 16, 100, 100);
    perform pg_temp.fabric(o, 'fabric', 'fully_approved', now() - interval '3 days');
    perform pg_temp.fabric(o, 'finish', 'partially_approved', now() - interval '3 days');
  o := pg_temp.mk_order('ff_both_done', 'running', t - 20, 100, 100);
    perform pg_temp.fabric(o, 'fabric', 'fully_approved', now() - interval '3 days');
    perform pg_temp.fabric(o, 'finish', 'fully_approved', now() - interval '2 days');
  o := pg_temp.mk_order('ff_reverted', 'running', t - 20, 100, 100);
    perform pg_temp.fabric(o, 'fabric', 'fully_approved', now() - interval '5 days');
    perform pg_temp.fabric(o, 'fabric', 'not_approved', now() - interval '1 day');       -- newest wins
    perform pg_temp.fabric(o, 'finish', 'fully_approved', now() - interval '2 days');
  -- NEVER RECORDED (a historical order): its own list, not "pending".
  o := pg_temp.mk_order('ff_history', 'running', t - 60, 100, 100);
  -- One item recorded pending, the other never recorded: judged independently.
  o := pg_temp.mk_order('ff_mixed', 'running', t - 30, 100, 100);
    perform pg_temp.fabric(o, 'fabric', 'partially_approved', now() - interval '2 days');
  o := pg_temp.mk_order('ff_nodate', 'running', null, 100, 100);
  o := pg_temp.mk_order('ff_old_dispatched', 'dispatched', t - 90, 100, 100);

  s := pg_temp.summary(current_setting('test.owner_id')::uuid);

  -- ── 1. alignment ──
  perform pg_temp.check(pg_temp.row_of(s, 'not_aligned', 'al_done') is null, 'an aligned Order is not listed');
  r := pg_temp.row_of(s, 'not_aligned', 'al_wait');
  perform pg_temp.check(r ->> 'state' = 'awaiting_reviewer' and r ->> 'waiting_on' = 'reviewer', 'awaiting the reviewer says so');
  perform pg_temp.check((r ->> 'waiting_seconds')::numeric between 3*86400 + 4*3600 and 3*86400 + 4*3600 + 120, 'and its waiting time is 3 days 4 hours');
  perform pg_temp.check((r ->> 'since')::timestamptz between now() - interval '3 days 4 hours 2 minutes' and now() - interval '3 days 3 hours 58 minutes', 'and its start timestamp is the handoff time');
  r := pg_temp.row_of(s, 'not_aligned', 'al_flag');
  perform pg_temp.check(r ->> 'state' = 'clarification_needed' and r ->> 'waiting_on' = 'approver', 'a FLAGGED order is waiting on the approver, NOT on the reviewer');
  perform pg_temp.check(r ->> 'detail' = 'Sofa fabric not stocked', 'and carries the reviewer''s own words');
  perform pg_temp.check((r ->> 'waiting_seconds')::numeric between 2*86400 and 2*86400 + 120, 'and its clock starts when it was flagged (2 days), not when it was approved (9)');
  r := pg_temp.row_of(s, 'not_aligned', 'al_unassigned');
  perform pg_temp.check(r ->> 'state' = 'awaiting_unassigned' and r ->> 'waiting_on' = 'administrator', 'no reviewer assigned: waiting on an administrator');
  r := pg_temp.row_of(s, 'not_aligned', 'al_held');
  perform pg_temp.check(r ->> 'state' = 'held_advance' and r ->> 'waiting_on' = 'payment', 'held for advance: waiting on the money');
  perform pg_temp.check((r ->> 'waiting_seconds')::numeric between 6*86400 and 6*86400 + 120, 'since the hold began');
  r := pg_temp.row_of(s, 'not_aligned', 'al_none');
  perform pg_temp.check(r ->> 'state' = 'no_handoff' and r ->> 'waiting_on' = 'legacy', 'an Order with no handoff is said to be exactly that, and invented no reviewer');
  perform pg_temp.check((s -> 'alignment_reviewer' ->> 'name') = 'DASH Reviewer', 'the reviewer is named');
  perform pg_temp.check((s -> 'groups' -> 'not_aligned' -> 0 ->> 'state') = 'awaiting_reviewer', 'orders waiting on the reviewer come first');

  -- ── 2. advance ──
  r := pg_temp.row_of(s, 'advance_below_40', 'adv_short');
  perform pg_temp.check(r is not null and (r ->> 'shortfall')::numeric = 0.01 and (r ->> 'percent')::numeric = 39.99, 'one paisa short: listed, 0.01 short, 39.99% (truncated)');
  perform pg_temp.check(pg_temp.row_of(s, 'advance_below_40', 'adv_exact') is null, 'exactly 40.00% is not listed');
  r := pg_temp.row_of(s, 'advance_below_40', 'adv_zero');
  perform pg_temp.check(r is not null and (r ->> 'percent')::numeric = 0 and (r ->> 'shortfall')::numeric = 400000, 'nothing verified: 0% and the full 40% short');
  perform pg_temp.check(pg_temp.row_of(s, 'advance_below_40', 'adv_noval') is null, 'no value is not called "below 40%"');
  perform pg_temp.check((s -> 'gaps' ->> 'advance_value_unknown')::int >= 1, 'and is COUNTED as unassessable');
  perform pg_temp.check(pg_temp.row_of(s, 'advance_below_40', 'adv_disp') is null, 'a dispatched Order is not listed');
  r := pg_temp.row_of(s, 'advance_below_40', 'adv_exc');
  perform pg_temp.check(r is not null, 'an order WITH an approved exception is STILL listed');
  perform pg_temp.check((r ->> 'exception_approved')::boolean and (r ->> 'percent')::numeric = 10 and (r ->> 'shortfall')::numeric = 300000,
                        'with its percentage, its shortfall and the exception flag');

  -- ── 3. fabric / finish ──
  perform pg_temp.check(pg_temp.row_of(s, 'fabric_finish_pending', 'ff_15') is null
                        and pg_temp.row_of(s, 'fabric_finish_unrecorded', 'ff_15') is null, 'exactly 15 days is NOT more than 15, in either list');
  r := pg_temp.row_of(s, 'fabric_finish_pending', 'ff_16');
  perform pg_temp.check(r is not null and (r ->> 'days_since_confirmation')::int = 16 and jsonb_array_length(r -> 'pending') = 2, '16 days: flagged, both items named');
  r := pg_temp.row_of(s, 'fabric_finish_pending', 'ff_fab_done');
  perform pg_temp.check(jsonb_array_length(r -> 'pending') = 1 and r -> 'pending' -> 0 ->> 'kind' = 'finish'
                        and r -> 'pending' -> 0 ->> 'status' = 'partially_approved', 'fabric done, finish partial: only FINISH is named');
  perform pg_temp.check(pg_temp.row_of(s, 'fabric_finish_pending', 'ff_both_done') is null, 'both fully approved: not listed');
  r := pg_temp.row_of(s, 'fabric_finish_pending', 'ff_reverted');
  perform pg_temp.check(r -> 'pending' -> 0 ->> 'kind' = 'fabric', 'the NEWEST event wins: a reverted fabric is pending again');
  perform pg_temp.check(pg_temp.row_of(s, 'fabric_finish_pending', 'ff_history') is null, 'a status never recorded is NOT confirmed pending');
  r := pg_temp.row_of(s, 'fabric_finish_unrecorded', 'ff_history');
  perform pg_temp.check(r is not null and r -> 'not_recorded' = '["fabric","finish"]'::jsonb, 'it is in its own list, both items named');
  r := pg_temp.row_of(s, 'fabric_finish_pending', 'ff_mixed');
  perform pg_temp.check(r is not null and r -> 'pending' -> 0 ->> 'kind' = 'fabric' and r -> 'not_recorded' = '["finish"]'::jsonb,
                        'fabric recorded pending, finish never recorded: judged independently, the gap said on the row');
  perform pg_temp.check(pg_temp.row_of(s, 'fabric_finish_unrecorded', 'ff_mixed') is null, 'and not duplicated into the unrecorded list');
  perform pg_temp.check(pg_temp.row_of(s, 'fabric_finish_pending', 'ff_nodate') is null
                        and pg_temp.row_of(s, 'fabric_finish_unrecorded', 'ff_nodate') is null, 'no confirmation date is not flagged');
  perform pg_temp.check((s -> 'gaps' ->> 'no_confirm_date')::int >= 1, 'and is COUNTED');
  perform pg_temp.check(pg_temp.row_of(s, 'fabric_finish_pending', 'ff_old_dispatched') is null, 'dispatched is excluded');

  -- ── 4. no overdue ──
  perform pg_temp.check(not (s -> 'groups' ? 'overdue') and not (s -> 'gaps' ? 'no_due_date'), 'the overdue group is gone from the read');

  -- ── overlap: nothing de-duplicated ──
  perform pg_temp.check(pg_temp.row_of(s, 'not_aligned', 'adv_short') is not null and pg_temp.row_of(s, 'advance_below_40', 'adv_short') is not null,
                        'an Order may sit in several groups');
end $$;

-- The fixtures above are Orders too and carry product values: measure revenue from HERE.
create temporary table base_rev2 on commit drop as
  select pg_temp.summary(current_setting('test.owner_id')::uuid) -> 'revenue' as r;

-- ═══ 5. Revenue ═══════════════════════════════════════════════════════════════
do $$
declare
  t date := pg_temp.today();
  m date := date_trunc('month', t)::date;
  six_from date := (m - interval '6 months')::date;
  six_to   date := m - 1;
  y date := date_trunc('year', t)::date;
  base jsonb := (select r from base_rev2);
  o uuid; s jsonb; sub uuid := gen_random_uuid(); sub2 uuid := gen_random_uuid(); sub3 uuid := gen_random_uuid();
  d_cur numeric; d_six numeric; d_year numeric; e_cur numeric; e_six numeric; e_year numeric;
begin
  -- Product values 1,10,100,... so every period's delta names exactly which Orders it holds.
  perform pg_temp.mk_order('rev_today',       'running',    t,          null, 1);
  perform pg_temp.mk_order('rev_monthstart',  'dispatched', m,          null, 10);
  perform pg_temp.mk_order('rev_prev_last',   'running',    m - 1,      null, 100);       -- last day of last month: IN the six months
  perform pg_temp.mk_order('rev_six_first',   'running',    six_from,   null, 1000);      -- first day of the six months: IN
  perform pg_temp.mk_order('rev_six_before',  'running',    six_from - 1, null, 10000);   -- day before: OUT
  perform pg_temp.mk_order('rev_jan1',        'running',    y,          null, 100000);
  perform pg_temp.mk_order('rev_lastyear',    'running',    y - 1,      null, 1000000);
  perform pg_temp.mk_order('rev_future',      'running',    t + 1,      null, 10000000);
  perform pg_temp.mk_order('rev_cancelled',   'cancelled',  t,          null, 100000000);
  perform pg_temp.mk_order('rev_test',        'running',    t,          null, 1000000000, null, true);
  perform pg_temp.mk_order('rev_nodate',      'running',    null,       null, 5);
  perform pg_temp.mk_order('rev_noproduct',   'running',    t,          null, null);

  -- ONE Order, three PI versions (V1 superseded, V2 in force with a 500 discount, V3 rejected):
  -- counted ONCE, at the version IN FORCE's after-discount product value (8,000 - 500 = 7,500).
  o := pg_temp.mk_order('rev_versions', 'running', t, null, 8000);
  perform set_config('request.jwt.claims', '', true);
  insert into public.order_submissions (id, status, submitted_by, created_by, client_name, gross_product_amount, discount_amount, subtotal_after_discount, grand_total) values
    (sub,  'draft', current_setting('test.owner_id')::uuid, current_setting('test.owner_id')::uuid, 'DASH-v1', 6000, 0,   6000, 7080),
    (sub2, 'draft', current_setting('test.owner_id')::uuid, current_setting('test.owner_id')::uuid, 'DASH-v2', 8000, 500, 7500, 8850),
    (sub3, 'draft', current_setting('test.owner_id')::uuid, current_setting('test.owner_id')::uuid, 'DASH-v3', 9000, 0,   9000, 10620);
  alter table public.order_pi_versions disable trigger order_pi_versions_guard;
  insert into public.order_pi_versions (order_id, submission_id, version_number, status, decided_by, decided_at, decision_reason, superseded_at, revision_reason, pdf_order_number) values
    (o, sub,  1, 'superseded', current_setting('test.owner_id')::uuid, now(), null, now(), null, 'DASH-1'),
    (o, sub2, 2, 'approved',   current_setting('test.owner_id')::uuid, now(), null, null,  'client change', 'DASH-1'),
    (o, sub3, 3, 'rejected',   current_setting('test.owner_id')::uuid, now(), 'not needed', null, 'another change', 'DASH-1');
  alter table public.order_pi_versions enable trigger order_pi_versions_guard;

  s := pg_temp.summary(current_setting('test.owner_id')::uuid);
  d_cur  := (s -> 'revenue' -> 'current_month'   ->> 'amount')::numeric - (base -> 'current_month'   ->> 'amount')::numeric;
  d_six  := (s -> 'revenue' -> 'last_six_months' ->> 'amount')::numeric - (base -> 'last_six_months' ->> 'amount')::numeric;
  d_year := (s -> 'revenue' -> 'current_year'    ->> 'amount')::numeric - (base -> 'current_year'    ->> 'amount')::numeric;

  -- What each period MUST hold, from the fixtures' own dates — right on any day of the year.
  -- Cancelled, test, undated and unvalued Orders are deliberately absent.
  select coalesce(sum(v) filter (where d between m and t), 0),
         coalesce(sum(v) filter (where d between six_from and six_to), 0),
         coalesce(sum(v) filter (where d between y and t), 0)
    into e_cur, e_six, e_year
    from (values (t, 1::numeric), (m, 10), (m - 1, 100), (six_from, 1000), (six_from - 1, 10000), (y, 100000),
                 (y - 1, 1000000), (t + 1, 10000000), (t, 7500)) f(d, v);
  perform pg_temp.check(d_cur  = e_cur,  format('current month: expected %s, got %s', e_cur,  d_cur));
  perform pg_temp.check(d_six  = e_six,  format('the six completed months: expected %s, got %s', e_six,  d_six));
  perform pg_temp.check(d_year = e_year, format('current year: expected %s, got %s', e_year, d_year));
  perform pg_temp.check(e_six >= 1100, 'the fixtures put last month and the first day of the window inside the six months');
  perform pg_temp.check((s -> 'revenue' -> 'last_six_months' ->> 'from')::date = six_from
                        and (s -> 'revenue' -> 'last_six_months' ->> 'to')::date = six_to, 'the six months run from the 1st six months back to the LAST DAY of last month');
  perform pg_temp.check((s -> 'revenue' -> 'last_six_months' ->> 'to')::date < m, 'and never include the current month');
  perform pg_temp.check((s -> 'revenue' -> 'current_month' ->> 'from')::date = m and (s -> 'revenue' -> 'current_month' ->> 'to')::date = t, 'current month is 1st to today');
  perform pg_temp.check((s -> 'revenue' -> 'current_year' ->> 'from')::date = y, 'year starts on 1 January');
  perform pg_temp.check((s -> 'revenue' -> 'gaps' ->> 'no_confirm_date')::int - (base -> 'gaps' ->> 'no_confirm_date')::int = 1, 'the undated Order is COUNTED, not summed');
  perform pg_temp.check((s -> 'revenue' -> 'gaps' ->> 'future_confirm_date')::int - (base -> 'gaps' ->> 'future_confirm_date')::int = 1, 'the future-dated Order is COUNTED, not summed');
  perform pg_temp.check((s -> 'revenue' -> 'gaps' ->> 'no_product_value_in_year')::int - (base -> 'gaps' ->> 'no_product_value_in_year')::int = 1, 'an Order with no product value is COUNTED, not summed as zero');
  perform pg_temp.check(s -> 'revenue' ->> 'basis' = 'product_value' and s -> 'revenue' ->> 'date_basis' = 'confirm_date', 'the basis is named in the payload');
end $$;

-- ═══ 6. Factory Focus ═════════════════════════════════════════════════════════
-- The month's slots are a property of the DATABASE, so start from an empty table: whatever a previous
-- run or a local session left there is removed INSIDE this transaction (which rolls back).
alter table public.order_factory_focus_selections disable trigger order_factory_focus_guard;
delete from public.order_factory_focus_selections;
alter table public.order_factory_focus_selections enable trigger order_factory_focus_guard;

do $$
declare
  t date := pg_temp.today();
  m date := date_trunc('month', timezone('Asia/Kolkata', now()))::date;
  a uuid; b uuid; c uuid; d uuid; e uuid; f uuid; g uuid;
  sel1 uuid; sel2 uuid; s jsonb; k jsonb;
begin
  a := pg_temp.mk_order('fo_a', 'running', t, 100, 100, current_setting('test.s1_id')::uuid);
  b := pg_temp.mk_order('fo_b', 'running', t, 100, 100, current_setting('test.s2_id')::uuid);
  c := pg_temp.mk_order('fo_c', 'running', t, 100, 100, current_setting('test.s3_id')::uuid);
  d := pg_temp.mk_order('fo_d', 'dispatched', t, 100, 100, current_setting('test.s1_id')::uuid);
  e := pg_temp.mk_order('fo_e', 'running', t, 100, 100, current_setting('test.s2_id')::uuid);
  f := pg_temp.mk_order('fo_f', 'running', t, 100, 100, current_setting('test.s3_id')::uuid);
  g := pg_temp.mk_order('fo_g', 'running', t, 100, 100, null);            -- no salesperson recorded

  -- Nobody but the owner may select.
  perform pg_temp.expect_error_as(current_setting('test.admin2_id')::uuid, format('select public.select_order_for_factory_focus(%L)', a), 'FACTORY_FOCUS_NOT_OWNER', 'another administrator');
  perform pg_temp.expect_error_as(current_setting('test.viewall_id')::uuid, format('select public.select_order_for_factory_focus(%L)', a), 'FACTORY_FOCUS_NOT_OWNER', 'a holder of view_all');
  perform pg_temp.expect_error_as(current_setting('test.s1_id')::uuid, format('select public.select_order_for_factory_focus(%L)', a), 'FACTORY_FOCUS_NOT_OWNER', 'the salesperson themself');

  -- No direct table access for any client role; a service-role insert must still name the owner.
  perform pg_temp.expect_error_as(current_setting('test.owner_id')::uuid, format('insert into public.order_factory_focus_selections (order_id, selected_by, selected_month, salesperson_id) values (%L, %L, date ''2000-01-01'', %L)', a, current_setting('test.owner_id'), current_setting('test.s1_id')), 'permission denied', 'the OWNER writing the table directly');
  perform pg_temp.expect_error_as(current_setting('test.owner_id')::uuid, 'select 1 from public.order_factory_focus_selections', 'permission denied', 'the OWNER reading the table directly');
  perform pg_temp.expect_error_as(null, format('insert into public.order_factory_focus_selections (order_id, selected_by, selected_month, salesperson_id) values (%L, %L, date ''2000-01-01'', %L)', a, current_setting('test.admin2_id'), current_setting('test.s1_id')), 'FACTORY_FOCUS_NOT_OWNER', 'a direct insert naming somebody else');

  -- The owner selects two; the third is refused; a closed, salesperson-less or duplicate Order is refused.
  perform pg_temp.become(current_setting('test.owner_id')::uuid);
  sel1 := (public.select_order_for_factory_focus(a, 'Landed the client from scratch') ->> 'selection_id')::uuid;
  sel2 := (public.select_order_for_factory_focus(b, null) ->> 'selection_id')::uuid;
  perform pg_temp.restore();
  perform pg_temp.expect_error_as(current_setting('test.owner_id')::uuid, format('select public.select_order_for_factory_focus(%L)', c), 'FACTORY_FOCUS_MONTH_LIMIT', 'a THIRD new selection in one month');
  perform pg_temp.expect_error_as(current_setting('test.owner_id')::uuid, format('select public.select_order_for_factory_focus(%L)', a), 'FACTORY_FOCUS_ALREADY_ACTIVE', 'the same Order twice');
  perform pg_temp.expect_error_as(current_setting('test.owner_id')::uuid, format('select public.select_order_for_factory_focus(%L)', d), 'FACTORY_FOCUS_ORDER_CLOSED', 'a dispatched Order');
  perform pg_temp.expect_error_as(current_setting('test.owner_id')::uuid, format('select public.select_order_for_factory_focus(%L)', g), 'FACTORY_FOCUS_NO_SALESPERSON', 'an Order with no salesperson');
  perform pg_temp.expect_error_as(current_setting('test.owner_id')::uuid, format('select public.select_order_for_factory_focus(%L, %L)', c, repeat('x', 201)), 'FACTORY_FOCUS_NOTE_TOO_LONG', 'an over-long note');
  perform pg_temp.check((select salesperson_id = current_setting('test.s1_id')::uuid and selected_month = m and selected_by = current_setting('test.owner_id')::uuid
                           from public.order_factory_focus_selections where id = sel1), 'the selection records who chose it, the salesperson it belongs to, and the month');

  -- Removal: owner only, a reason is REQUIRED, and it does NOT hand the slot back.
  perform pg_temp.expect_error_as(current_setting('test.s2_id')::uuid, format('select public.remove_order_factory_focus(%L, %L)', sel2, 'no'), 'FACTORY_FOCUS_NOT_OWNER', 'the salesperson removing their own');
  perform pg_temp.expect_error_as(current_setting('test.owner_id')::uuid, format('select public.remove_order_factory_focus(%L, null)', sel2), 'FACTORY_FOCUS_REASON_REQUIRED', 'removing with no reason');
  perform pg_temp.expect_error_as(current_setting('test.owner_id')::uuid, format('select public.remove_order_factory_focus(%L, %L)', sel2, '   '), 'FACTORY_FOCUS_REASON_REQUIRED', 'removing with a blank reason');
  perform pg_temp.become(current_setting('test.owner_id')::uuid);
  perform public.remove_order_factory_focus(sel2, 'Client cancelled the second phase');
  perform pg_temp.restore();
  perform pg_temp.expect_error_as(current_setting('test.owner_id')::uuid, format('select public.remove_order_factory_focus(%L, %L)', sel2, 'again'), 'FACTORY_FOCUS_NOT_ACTIVE', 'removing twice');
  perform pg_temp.expect_error_as(current_setting('test.owner_id')::uuid, format('select public.select_order_for_factory_focus(%L)', c), 'FACTORY_FOCUS_MONTH_LIMIT', 'a slot freed by removal');
  perform pg_temp.check((select removed_by = current_setting('test.owner_id')::uuid and removed_at is not null and removal_reason = 'Client cancelled the second phase'
                           from public.order_factory_focus_selections where id = sel2), 'removal records who, when and why');

  -- History is append-only.
  perform pg_temp.expect_error_as(null, format('update public.order_factory_focus_selections set note = ''x'' where id = %L', sel1), 'FACTORY_FOCUS_HISTORY', 'rewriting a selection');
  perform pg_temp.expect_error_as(null, format('update public.order_factory_focus_selections set removed_by = null, removed_at = null, removal_reason = null where id = %L', sel2), 'FACTORY_FOCUS_HISTORY', 'reviving a removed selection');
  perform pg_temp.expect_error_as(null, format('delete from public.order_factory_focus_selections where id = %L', sel1), 'FACTORY_FOCUS_HISTORY', 'deleting history');
  perform pg_temp.expect_error_as(null, format('update public.order_factory_focus_selections set removed_by = %L, removed_at = now(), removal_reason = null where id = %L', current_setting('test.owner_id'), sel1), 'FACTORY_FOCUS_REASON_REQUIRED', 'a direct removal with no reason');

  -- Who sees what. The salesperson S1 owns order a; S1 has the default scope (own).
  s := pg_temp.summary(current_setting('test.s1_id')::uuid);
  k := pg_temp.card_of(s, pg_temp.number_of('fo_a'));
  perform pg_temp.check(k is not null and (k ->> 'can_open')::boolean and k ->> 'client_name' = 'DASH-fo_a' and k ->> 'note' = 'Landed the client from scratch',
                        'the salesperson sees their own selected order in full');
  perform pg_temp.check(k ->> 'salesperson_name' = 'DASH Sales One' and (k ->> 'selected_month')::date = m, 'with the salesperson and the month');
  perform pg_temp.check(not (s -> 'factory_focus' ->> 'can_manage')::boolean and s -> 'factory_focus' -> 'month_used' = 'null'::jsonb, 'and no controls and no slot counts');

  -- A reader who cannot open the Order sees WHICH order and WHOSE, and nothing else.
  s := pg_temp.summary(current_setting('test.n_id')::uuid);
  k := pg_temp.card_of(s, pg_temp.number_of('fo_a'));
  perform pg_temp.check(k is not null, 'everybody with Orders entry sees the active selection');
  perform pg_temp.check(not (k ->> 'can_open')::boolean and k -> 'order_id' = 'null'::jsonb and k -> 'client_name' = 'null'::jsonb
                        and k -> 'note' = 'null'::jsonb and k -> 'status' = 'null'::jsonb,
                        'but with no client, no note, no status and no link when they cannot open the Order');
  perform pg_temp.check(k ->> 'display_number' is not null and k ->> 'salesperson_name' = 'DASH Sales One' and (k ->> 'selected_month')::date = m,
                        'only its number, its salesperson and its month');
  perform pg_temp.check(strpos(s::text, 'Landed the client') = 0 and strpos(s::text, 'DASH-fo_a') = 0, 'the note and the client name appear NOWHERE in that reader''s payload');
  s := pg_temp.summary(current_setting('test.s3_id')::uuid);
  perform pg_temp.check(not (pg_temp.card_of(s, pg_temp.number_of('fo_a')) ->> 'can_open')::boolean, 'a colleague with the own-only scope cannot open it either');

  -- The removal reason goes to the order's salesperson — and only to them.
  s := pg_temp.summary(current_setting('test.s2_id')::uuid);
  perform pg_temp.check(jsonb_array_length(s -> 'factory_focus' -> 'removed_for_you') = 1
                        and s -> 'factory_focus' -> 'removed_for_you' -> 0 ->> 'removal_reason' = 'Client cancelled the second phase',
                        'the salesperson is shown why it was removed');
  perform pg_temp.check(jsonb_array_length(pg_temp.summary(current_setting('test.s1_id')::uuid) -> 'factory_focus' -> 'removed_for_you') = 0
                        and jsonb_array_length(pg_temp.summary(current_setting('test.owner_id')::uuid) -> 'factory_focus' -> 'removed_for_you') = 0,
                        'and nobody else');

  -- A dispatch hides NOTHING: removal is manual.
  perform pg_temp.check(pg_temp.card_of(pg_temp.summary(current_setting('test.owner_id')::uuid), pg_temp.number_of('fo_a')) is not null, 'the order is active before it moves');
  update public.orders set status = 'ready_for_dispatch' where id = a;
  update public.orders set status = 'dispatched' where id = a;
  s := pg_temp.summary(current_setting('test.owner_id')::uuid);
  perform pg_temp.check(pg_temp.card_of(s, pg_temp.number_of('fo_a')) is not null, 'a DISPATCHED order stays in Factory Focus until the owner removes it');
  perform pg_temp.check(exists (select 1 from public.order_factory_focus_selections where id = sel1 and removed_at is null), 'its selection is not cleared by the dispatch');

  -- Active selections carry into later months: backdate this month's two, then select two NEW ones.
  alter table public.order_factory_focus_selections disable trigger order_factory_focus_guard;
  update public.order_factory_focus_selections set selected_month = (m - interval '1 month')::date where selected_month = m;
  alter table public.order_factory_focus_selections enable trigger order_factory_focus_guard;
  perform pg_temp.become(current_setting('test.owner_id')::uuid);
  perform public.select_order_for_factory_focus(c, 'new month one');
  perform public.select_order_for_factory_focus(e, 'new month two');
  perform pg_temp.restore();
  perform pg_temp.expect_error_as(current_setting('test.owner_id')::uuid, format('select public.select_order_for_factory_focus(%L)', f), 'FACTORY_FOCUS_MONTH_LIMIT', 'a third in the new month');
  s := pg_temp.summary(current_setting('test.owner_id')::uuid);
  perform pg_temp.check(jsonb_array_length(s -> 'factory_focus' -> 'active') = 3, 'the still-active selection from last month AND the two new ones are visible: more than two at once');
  perform pg_temp.check((s -> 'factory_focus' ->> 'month_used')::int = 2 and (s -> 'factory_focus' ->> 'can_manage')::boolean, 'the owner sees 2 of 2 used this month, and may manage');
end $$;

-- ═══ 7. Order visibility scopes ═══════════════════════════════════════════════
do $$
declare
  t date := pg_temp.today();
  o1 uuid; o2 uuid; o3 uuid; on_ uuid; pay uuid;
  s jsonb; alloc int; cnt int;
  s1 uuid := current_setting('test.s1_id')::uuid; s2 uuid := current_setting('test.s2_id')::uuid;
  own uuid := current_setting('test.owner_id')::uuid;
  n uuid := current_setting('test.n_id')::uuid;
begin
  o1 := pg_temp.mk_order('sc_1', 'running', t, 1000, 1000, s1);
  o2 := pg_temp.mk_order('sc_2', 'running', t, 1000, 1000, s2);
  o3 := pg_temp.mk_order('sc_3', 'running', t, 1000, 1000, current_setting('test.s3_id')::uuid);
  on_ := pg_temp.mk_order('sc_n', 'running', t, 1000, 1000, n);           -- belongs to a NON-candidate
  pay := pg_temp.pay(o2, 700);                                           -- verified money on S2's order

  -- ── who may change it ──
  perform pg_temp.expect_error_as(s1, format('select public.set_order_visibility_scope(%L, ''all_sales'')', s1), 'ORDER_SCOPE_NOT_OWNER', 'a candidate widening their own scope');
  perform pg_temp.expect_error_as(current_setting('test.admin2_id')::uuid, format('select public.set_order_visibility_scope(%L, ''all_sales'')', s1), 'ORDER_SCOPE_NOT_OWNER', 'another administrator');
  perform pg_temp.expect_error_as(s1, 'select public.list_order_visibility_scopes()', 'ORDER_SCOPE_NOT_OWNER', 'a candidate reading everyone''s scopes');
  perform pg_temp.expect_error_as(own, format('select public.set_order_visibility_scope(%L, ''all_sales'')', n), 'ORDER_SCOPE_NOT_A_CANDIDATE', 'a person who is not a sales candidate');
  perform pg_temp.expect_error_as(own, format('select public.set_order_visibility_scope(%L, ''selected'', array[%L]::uuid[])', s1, n), 'ORDER_SCOPE_NOT_A_CANDIDATE', 'selecting a non-candidate');
  perform pg_temp.expect_error_as(own, format('select public.set_order_visibility_scope(%L, ''selected'', array[%L]::uuid[])', s1, s1), 'ORDER_SCOPE_SELF', 'selecting oneself');
  perform pg_temp.expect_error_as(own, format('select public.set_order_visibility_scope(%L, ''selected'', ''{}'')', s1), 'ORDER_SCOPE_MEMBERS_REQUIRED', 'selected with nobody');
  perform pg_temp.expect_error_as(own, format('select public.set_order_visibility_scope(%L, ''everyone'')', s1), 'ORDER_SCOPE_MODE_UNKNOWN', 'an unknown mode');
  perform pg_temp.expect_error_as(own, format('insert into public.order_visibility_scopes (user_id, mode) values (%L, ''all_sales'')', s1), 'permission denied', 'the OWNER writing the scope table directly');
  perform pg_temp.expect_error_as(s1, format('insert into public.order_visibility_scopes (user_id, mode) values (%L, ''all_sales'')', s1), 'permission denied', 'a candidate writing their own scope directly');

  -- ── MODE 1: own (the default) ──
  perform pg_temp.become(s1);
  select count(*) into cnt from public.orders where client_name like 'DASH-sc_%';
  perform pg_temp.check(cnt = 1, format('own: a direct read returns ONLY their order (got %s)', cnt));
  perform pg_temp.check(public.can_view_order_as_actor(o1) and not public.can_view_order_as_actor(o2) and not public.can_view_order_as_actor(o3), 'own: the visibility predicate agrees');
  perform pg_temp.restore();
  s := pg_temp.summary(s1);
  perform pg_temp.check(pg_temp.row_of(s, 'not_aligned', 'sc_1') is not null and pg_temp.row_of(s, 'not_aligned', 'sc_2') is null
                        and pg_temp.row_of(s, 'not_aligned', 'sc_3') is null, 'own: the summary''s lists hold only their order');

  -- ── MODE 2: own + selected candidates ──
  perform pg_temp.become(own);
  perform public.set_order_visibility_scope(s1, 'selected', array[s2]);
  perform pg_temp.restore();
  perform pg_temp.become(s1);
  select count(*) into cnt from public.orders where client_name like 'DASH-sc_%';
  perform pg_temp.check(cnt = 2, format('selected: their own + the selected candidate''s (got %s)', cnt));
  perform pg_temp.check(public.can_view_order_as_actor(o2) and not public.can_view_order_as_actor(o3) and not public.can_view_order_as_actor(on_), 'selected: the predicate agrees, and the unselected candidate and the non-candidate stay hidden');
  select count(*) into cnt from public.orders where id = o3;
  perform pg_temp.check(cnt = 0, 'selected: a direct read of an Order OUTSIDE the scope returns nothing');
  perform pg_temp.restore();
  s := pg_temp.summary(s1);
  perform pg_temp.check(pg_temp.row_of(s, 'not_aligned', 'sc_2') is not null and pg_temp.row_of(s, 'not_aligned', 'sc_3') is null
                        and pg_temp.row_of(s, 'not_aligned', 'sc_n') is null, 'selected: the summary''s lists follow the scope, outside orders absent');
  perform pg_temp.check((select count(*) from jsonb_array_elements(s -> 'groups' -> 'not_aligned') x where x ->> 'client_name' like 'DASH-sc_%') = 2,
                        'selected: and so does the count behind the heading');

  -- ── MODE 3: all sales candidates ──
  perform pg_temp.become(own);
  perform public.set_order_visibility_scope(s1, 'all_sales');
  perform pg_temp.restore();
  perform pg_temp.become(s1);
  select count(*) into cnt from public.orders where client_name like 'DASH-sc_%';
  perform pg_temp.check(cnt = 3, format('all_sales: every sales candidate''s order (got %s)', cnt));
  perform pg_temp.check(not public.can_view_order_as_actor(on_), 'all_sales: but NOT an order that belongs to a non-candidate');
  perform pg_temp.restore();
  s := pg_temp.summary(s1);
  perform pg_temp.check(pg_temp.row_of(s, 'not_aligned', 'sc_3') is not null and pg_temp.row_of(s, 'not_aligned', 'sc_n') is null, 'all_sales: the summary follows');

  -- ── what a scope must NOT reveal or allow ──
  perform pg_temp.become(s1);
  select count(*) into alloc from public.finance_payment_allocations where order_id = o2;
  perform pg_temp.check(alloc = 0, 'FINANCE: the scope reveals NO allocation of a colleague''s order');
  perform pg_temp.check(not public.can_read_payment_as_participant(pay), 'FINANCE: nor the payment itself');
  select count(*) into alloc from public.finance_payment_requests where id = pay;
  perform pg_temp.check(alloc = 0, 'FINANCE: a direct read of the payment returns nothing');
  perform pg_temp.check(public.order_linked_payment_total(o2) is null, 'FINANCE: nor what the order has received');
  update public.orders set status = 'on_hold' where id = o2;
  get diagnostics cnt = row_count;
  perform pg_temp.check(cnt = 0, 'the scope grants sight, never an edit');
  perform pg_temp.restore();
  perform pg_temp.check((select status from public.orders where id = o2) = 'running', '…and the row is unchanged');
  s := pg_temp.summary(s1);
  perform pg_temp.check(s -> 'revenue' = 'null'::jsonb and not (s -> 'viewer' ->> 'can_view_revenue')::boolean, 'REVENUE: a scope never sends company revenue');

  -- the owner's read of the same settings
  perform pg_temp.become(own);
  perform pg_temp.check(exists (select 1 from jsonb_array_elements(public.list_order_visibility_scopes()) x where (x ->> 'user_id')::uuid = s1 and x ->> 'mode' = 'all_sales'), 'the owner sees the setting');
  perform pg_temp.check(not exists (select 1 from jsonb_array_elements(public.list_order_visibility_scopes()) x where (x ->> 'user_id')::uuid = n), 'and only candidates are listed');
  -- back to own
  perform public.set_order_visibility_scope(s1, 'own');
  perform pg_temp.restore();
  perform pg_temp.become(s1);
  select count(*) into cnt from public.orders where client_name like 'DASH-sc_%';
  perform pg_temp.check(cnt = 1, 'own again: the widening is gone at once');
  perform pg_temp.restore();
  perform pg_temp.check((select count(*) from public.order_visibility_scope_members where user_id = s1) = 0, 'and the selected members are cleared');
end $$;

do $$ begin raise notice 'ALL ORDERS DASHBOARD ASSERTIONS PASSED'; end $$;

rollback;
