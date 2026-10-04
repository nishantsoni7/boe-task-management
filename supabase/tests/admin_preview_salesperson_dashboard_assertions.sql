-- THE ADMIN PREVIEW OF A SALESPERSON'S ORDERS DASHBOARD (20270304000000)
-- ===========================================================================
--   P1  fixtures       one salesperson (A) holding one of everything the dashboard draws; another (B) holding
--                      records A must never show
--   P2  who may ask    active administrators only; a salesperson (for themselves or a colleague), operations,
--                      a view_all manager and a non-assignee are REFUSED with an error; a deactivated
--                      administrator is refused; no session, no answer
--   P3  whom           a salesperson (including one who holds orders.view_all) is previewable; an admin, operations,
--                      a non-assignee, nobody, null, a deactivated or deleted user get { applicable: false } and
--                      no data, plus the preview key naming them
--   P4  PARITY GUARD   the preview of a salesperson equals that salesperson's OWN read, key for key, for five
--                      salespeople — what stops the generated function drifting from the personal one
--   P5  ownership      A's preview holds A's records only, though the administrator can open B's; the
--                      administrator's own read is unchanged
--   P6  read-only      STABLE, SECURITY DEFINER with a pinned search_path, no anon/PUBLIC execute, writes nothing,
--                      and the personal function gained no argument
-- One transaction, ROLLBACK. Synthetic records only.
-- On success prints NOTICE 'ALL ADMIN PREVIEW ASSERTIONS PASSED'.
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


/** The preview, read AS a person (an administrator, or anybody trying). */
create function pg_temp.preview(p_asker uuid, p_target uuid) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.become(p_asker);
  v := public.admin_preview_salesperson_orders_dashboard(p_target);
  perform pg_temp.restore();
  return v;
end $$;

/** True when the preview is REFUSED for this asker (an error, not an empty answer). */
create function pg_temp.refused(p_asker uuid, p_target uuid) returns boolean language plpgsql as $$
declare v jsonb; ok boolean := false;
begin
  begin
    perform pg_temp.become(p_asker);
    v := public.admin_preview_salesperson_orders_dashboard(p_target);
  exception when insufficient_privilege then ok := true;
  end;
  perform pg_temp.restore();
  return ok;
end $$;

/** The answer without the one key the preview adds. */
create function pg_temp.bare(p_dash jsonb) returns jsonb language sql as $$ select p_dash - 'preview' $$;

-- ═══ P1. Fixtures: A holds one of everything the personal dashboard draws; B holds records A must never see ═══
do $$
declare
  t date := pg_temp.today(); a uuid := current_setting('test.a_id')::uuid; b uuid := current_setting('test.b_id')::uuid; o uuid;
begin
  o := pg_temp.mk_order('pa_zero',   'running', t - 1, 1000000, 800000, a);
  o := pg_temp.mk_order('pa_3999',   'running', t - 2, 1000000, 800000, a);  perform pg_temp.pay(o, 399999.99);
  o := pg_temp.mk_order('pa_exact',  'running', t - 3, 1000000, 800000, a);  perform pg_temp.pay(o, 400000.00);
  o := pg_temp.mk_order('pa_null',   'running', t - 4, null, null, a);                             -- no usable value: "advance not checked"
  o := pg_temp.mk_order('pa_ff',     'running', t - 20, 100, 100, a);
    perform pg_temp.fabric(o, 'fabric', 'not_approved', now() - interval '3 days');
    perform pg_temp.fabric(o, 'finish', 'fully_approved', now() - interval '3 days');
  o := pg_temp.mk_order('pa_hist',   'running', t - 60, 100, 100, a);  perform pg_temp.make_historical(o);   -- fabric/finish status UNKNOWN
  o := pg_temp.mk_order('pa_ready',  'ready_for_dispatch', t - 9, 100, 100, a, t + 3);
  o := pg_temp.mk_order('pa_disp',   'dispatched', t - 40, 100, 100, a);
  o := pg_temp.mk_order('pa_cxl',    'cancelled',  t - 11, 100, 100, a);
  o := pg_temp.mk_order('pa_test',   'running', t - 13, 100, 100, a, null, true);
  perform pg_temp.mk_pi('pa_pi_sub',  'submitted', a, interval '2 days');
  perform pg_temp.mk_pi('pa_pi_draft','draft',     a, interval '1 day');
  -- B's records: the administrator can OPEN all of these, and none may appear in A's preview.
  o := pg_temp.mk_order('pb_mine',   'running', t - 1, 1000000, 800000, b);
  o := pg_temp.mk_order('pb_ready',  'ready_for_dispatch', t - 5, 100, 100, b, t + 1);
  perform pg_temp.mk_pi('pb_pi_sub',  'submitted', b, interval '1 day');
end $$;

-- ═══ P2. Who may ask ═════════════════════════════════════════════════════════════════
do $$
declare
  a uuid := current_setting('test.a_id')::uuid; b uuid := current_setting('test.b_id')::uuid; who uuid;
begin
  -- Administrators may.
  perform pg_temp.check((pg_temp.preview(current_setting('test.owner_id')::uuid, a) ->> 'applicable')::boolean, 'the owner (an administrator) can preview a salesperson');
  perform pg_temp.check((pg_temp.preview(current_setting('test.admin2_id')::uuid, a) ->> 'applicable')::boolean, 'so can any other active administrator');

  -- Nobody else may — an ERROR, never an empty answer: a salesperson (even for themselves), a colleague's preview,
  -- operations, a view_all manager, a non-assignee.
  foreach who in array array[a, b, current_setting('test.sv_id')::uuid, current_setting('test.ops_id')::uuid,
                            current_setting('test.viewall_id')::uuid, current_setting('test.n_id')::uuid] loop
    perform pg_temp.check(pg_temp.refused(who, a), format('%s is REFUSED (insufficient_privilege), not given an answer', who));
  end loop;
  perform pg_temp.check(pg_temp.refused(a, b), 'a salesperson asking for a colleague is refused');
  perform pg_temp.check(pg_temp.refused(b, b), 'and for themselves: the personal function is theirs, this one is not');

  -- An administrator who is deactivated is not one.
  update public.users set is_active = false where id = current_setting('test.admin2_id')::uuid;
  perform pg_temp.check(pg_temp.refused(current_setting('test.admin2_id')::uuid, a), 'a deactivated administrator is refused');
  update public.users set is_active = true where id = current_setting('test.admin2_id')::uuid;

  -- No session, no answer.
  begin
    perform set_config('request.jwt.claims', '', true);
    perform public.admin_preview_salesperson_orders_dashboard(a);
    raise exception 'ASSERT FAILED: an unauthenticated call was answered';
  exception when others then
    if sqlerrm like 'ASSERT FAILED%' then raise; end if;
  end;
end $$;

-- ═══ P3. Whom it can preview ════════════════════════════════════════════════════════
do $$
declare
  a uuid := current_setting('test.a_id')::uuid; owner uuid := current_setting('test.owner_id')::uuid; who uuid; s jsonb;
begin
  s := pg_temp.preview(owner, a);
  perform pg_temp.check(s -> 'preview' ->> 'salesperson_id' = a::text and s -> 'preview' ->> 'full_name' = 'SPD Sales A',
    format('the answer says whose dashboard it is: %s', s -> 'preview'));

  -- Anybody with no personal dashboard: { applicable: false } plus the preview key, and NOTHING else.
  foreach who in array array[owner, current_setting('test.admin2_id')::uuid, current_setting('test.ops_id')::uuid,
                            current_setting('test.n_id')::uuid, current_setting('test.viewall_id')::uuid] loop
    s := pg_temp.preview(owner, who);
    perform pg_temp.check(s ->> 'applicable' = 'false' and (s - 'applicable' - 'preview') = '{}'::jsonb,
      format('%s has no personal dashboard: applicable false and no data: %s', who, s));
  end loop;
  -- A salesperson who ALSO holds orders.view_all HAS one (their own orders only).
  s := pg_temp.preview(owner, current_setting('test.sv_id')::uuid);
  perform pg_temp.check((s ->> 'applicable')::boolean, 'a salesperson who also holds orders.view_all is previewable, as they get the personal dashboard');
  -- Unknown, null, deactivated, deleted.
  perform pg_temp.check(pg_temp.preview(owner, gen_random_uuid()) ->> 'applicable' = 'false', 'an id that is nobody: applicable false');
  perform pg_temp.check(pg_temp.preview(owner, null) ->> 'applicable' = 'false', 'a null id: applicable false');
  update public.users set is_active = false where id = current_setting('test.d_id')::uuid;
  perform pg_temp.check(pg_temp.preview(owner, current_setting('test.d_id')::uuid) ->> 'applicable' = 'false', 'a deactivated salesperson has no dashboard to preview');
  update public.users set is_active = true, is_deleted = true where id = current_setting('test.d_id')::uuid;
  perform pg_temp.check(pg_temp.preview(owner, current_setting('test.d_id')::uuid) ->> 'applicable' = 'false', 'nor a deleted one');
  update public.users set is_deleted = false where id = current_setting('test.d_id')::uuid;
end $$;

-- ═══ P4. THE PARITY GUARD: the preview is exactly what the salesperson's own read returns ═══════════════
-- The function is generated from the personal one; this is what stops the two drifting apart. One transaction, so
-- now() is the same in both answers and nothing time-varying needs to be stripped.
do $$
declare
  a uuid := current_setting('test.a_id')::uuid; own jsonb; pre jsonb; who uuid;
begin
  foreach who in array array[a, current_setting('test.b_id')::uuid, current_setting('test.c_id')::uuid,
                            current_setting('test.sv_id')::uuid, current_setting('test.e_id')::uuid] loop
    own := pg_temp.dash(who);
    pre := pg_temp.preview(current_setting('test.owner_id')::uuid, who);
    perform pg_temp.check(pg_temp.bare(pre) = own,
      format('the preview of %s equals their own read, key for key.%s   own:     %s%s   preview: %s', who, E'\n', left(own::text, 600), E'\n', left(pg_temp.bare(pre)::text, 600)));
  end loop;
  -- ...and the comparison is not vacuous: A's answer is a real one with rows in every list.
  own := pg_temp.dash(a);
  perform pg_temp.check((own ->> 'total_orders')::int >= 6 and jsonb_array_length(own -> 'advance') >= 1 and jsonb_array_length(own -> 'advance_unchecked') >= 1
                        and jsonb_array_length(own -> 'pending') = 1 and jsonb_array_length(own -> 'fabric_finish') >= 1
                        and jsonb_array_length(own -> 'fabric_finish_unknown') = 1 and jsonb_array_length(own -> 'ready_for_dispatch') = 1,
    format('A holds a real, varied dashboard (so parity means something): %s', left(own::text, 400)));
end $$;

-- ═══ P5. Ownership: the preview shows the previewed salesperson's records, never the administrator's view of everything ═══
do $$
declare
  a uuid := current_setting('test.a_id')::uuid; s jsonb; owner uuid := current_setting('test.owner_id')::uuid;
begin
  s := pg_temp.preview(owner, a);
  perform pg_temp.check(s::text !~ 'SPD-pb_', 'none of B''s orders or PIs is in A''s preview, though the administrator can open all of them');
  perform pg_temp.check(pg_temp.tags(s, 'pending') = array['pa_pi_sub'], format('only A''s submitted PI is pending: %s', pg_temp.tags(s, 'pending')));
  perform pg_temp.check(not (pg_temp.tags(s, 'advance') && array['pa_exact', 'pa_null', 'pa_disp', 'pa_cxl', 'pa_test']),
    format('advance list holds only A''s open orders below 40%%: %s', pg_temp.tags(s, 'advance')));
  perform pg_temp.check(pg_temp.tags(s, 'advance_unchecked') @> array['pa_null'], 'an order with no usable value is LISTED as not checked, in the preview as for A');
  perform pg_temp.check(pg_temp.tags(s, 'fabric_finish_unknown') = array['pa_hist'], 'the unknown fabric/finish status is shown as unknown');
  perform pg_temp.check(pg_temp.tags(s, 'ready_for_dispatch') = array['pa_ready'], 'ready for dispatch is A''s own');
  -- The administrator's OWN dashboard is untouched by previewing.
  perform pg_temp.check(pg_temp.dash(owner) = '{"applicable": false}'::jsonb, 'previewing does not change the administrator''s own personal read (still not applicable)');
  -- Previewing B afterwards shows B's, not A's.
  s := pg_temp.preview(owner, current_setting('test.b_id')::uuid);
  perform pg_temp.check(s::text ~ 'SPD-pb_' and s::text !~ 'SPD-pa_', format('and previewing B shows B''s records and none of A''s: %s', left(s::text, 700)));
end $$;

-- ═══ P6. Read-only, and the grants ═══════════════════════════════════════════════════════
do $$
declare p record; before_orders bigint; after_orders bigint;
begin
  select provolatile, prosecdef, proconfig into p from pg_proc where oid = 'public.admin_preview_salesperson_orders_dashboard(uuid)'::regprocedure;
  perform pg_temp.check(p.provolatile = 's', 'declared STABLE: it cannot write');
  perform pg_temp.check(p.prosecdef, 'SECURITY DEFINER (it reads the previewed person''s rows, which the administrator''s own policies would not scope that way)');
  perform pg_temp.check(p.proconfig::text like '%search_path=public, pg_temp%', format('search_path pinned: %s', p.proconfig));
  perform pg_temp.check(not has_function_privilege('anon', 'public.admin_preview_salesperson_orders_dashboard(uuid)', 'execute'), 'anon cannot execute it');
  perform pg_temp.check(has_function_privilege('authenticated', 'public.admin_preview_salesperson_orders_dashboard(uuid)', 'execute'), 'authenticated can (the function itself refuses non-administrators)');
  perform pg_temp.check(not exists (select 1 from information_schema.routine_privileges
                                     where specific_schema = 'public' and routine_name = 'admin_preview_salesperson_orders_dashboard' and grantee = 'PUBLIC'),
                        'PUBLIC has no execute');
  select count(*) into before_orders from public.orders;
  perform pg_temp.preview(current_setting('test.owner_id')::uuid, current_setting('test.a_id')::uuid);
  select count(*) into after_orders from public.orders;
  perform pg_temp.check(before_orders = after_orders, 'a preview leaves the orders as they were');
  -- The personal function is unchanged: still scoped to its caller, still no argument.
  perform pg_temp.check(to_regprocedure('public.salesperson_orders_dashboard()') is not null
                        and to_regprocedure('public.salesperson_orders_dashboard(uuid)') is null, 'the personal dashboard function is untouched (no argument was added to it)');
end $$;

do $$ begin raise notice 'ALL ADMIN PREVIEW ASSERTIONS PASSED'; end $$;
rollback;
