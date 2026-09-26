-- ═══════════════════════════════════════════════════════════════════════════
-- ADMIN AMENDMENT — behavioural assertions for 20260927000000, as the chain
-- through 20270116000000 leaves it
--
-- One transaction, ending in ROLLBACK. Needs fixture rows, so run it against a
-- scratch database, never production. (The read-only posture checks are the
-- ones that are safe anywhere.)
--
-- WHAT CHANGED SINCE THIS SUITE WAS WRITTEN (repaired in the #209 review):
--   * FIXTURES. It named people it never created, impersonated them through a
--     test.uid GUC that auth.uid() does not read, and granted permissions
--     without granted_by (NOT NULL since 20260660) — so it failed before its
--     first assertion everywhere. It now creates its own people (ids 0ad0…),
--     acts as them through request.jwt.claims, and grants with granted_by.
--   * THE RULE. 20270115000000 made a PI that is APPROVED AND IN FORCE ON AN
--     ORDER change only as a new version (Edit PI → an Admin approves it).
--     The billing door therefore refuses an approved PI for everybody, admin
--     included (ORDER_PI_APPROVED_EDIT_REQUIRES_REVISION), and changes
--     nothing. The admin amendment this suite was written for still exists
--     where it still applies: a PI UNDER REVIEW, with a reason.
--
-- Usage:  psql "$SCRATCH_URL" -f supabase/tests/order_submission_admin_amendment_assertions.sql
-- ═══════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
begin;

-- ── People: this suite's own, whatever else the database holds ──────────────
insert into public.users (id, full_name, email, role, team, is_active, employee_code) values
  ('0ad00000-0000-4000-8000-000000000001', 'ASSERT AA Owner', 'aa-owner@suite.test', 'member', 'sales',      true, 'AA-OWN'),
  ('0ad00000-0000-4000-8000-000000000002', 'ASSERT AA Other', 'aa-other@suite.test', 'member', 'management', true, 'AA-OTH'),
  ('0ad00000-0000-4000-8000-000000000003', 'ASSERT AA Admin', 'aa-admin@suite.test', 'admin',  'management', true, 'AA-ADM')
on conflict (id) do update set role = excluded.role, team = excluded.team, is_active = true;

insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
select v.u, mpa.module_id, mpa.action_id, true, '0ad00000-0000-4000-8000-000000000003'::uuid
  from (values ('0ad00000-0000-4000-8000-000000000001'::uuid, 'view'), ('0ad00000-0000-4000-8000-000000000001'::uuid, 'create'),
               ('0ad00000-0000-4000-8000-000000000002'::uuid, 'view'), ('0ad00000-0000-4000-8000-000000000002'::uuid, 'approve_order'),
               ('0ad00000-0000-4000-8000-000000000001'::uuid, 'can_be_order_assignee'),
               ('0ad00000-0000-4000-8000-000000000003'::uuid, 'view'), ('0ad00000-0000-4000-8000-000000000003'::uuid, 'approve_order'),
               ('0ad00000-0000-4000-8000-000000000003'::uuid, 'can_be_order_assignee')) v(u, a)
  join public.permission_modules m on m.module_key = 'orders'
  join public.permission_actions pa on pa.action_key = v.a
  join public.module_permission_actions mpa on mpa.module_id = m.id and mpa.action_id = pa.id
on conflict do nothing;

-- Acts as p_user for what follows (auth.uid() reads request.jwt.claims).
create function pg_temp.act(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;

-- A complete PI of the owner's, 40% paid, as the real doors leave it:
-- 'draft', or 'submitted' (through submit_pi_for_review), or 'approved' and
-- converted into an Order (approve_pi_review + approve_order_submission).
create function pg_temp.pi(p_id uuid, p_client text, p_total numeric, p_to text) returns uuid language plpgsql as $$
declare
  v_owner uuid := '0ad00000-0000-4000-8000-000000000001';
  v_admin uuid := '0ad00000-0000-4000-8000-000000000003';
  v_wb    text := 'submissions/' || p_id || '/original/' || gen_random_uuid() || '.xlsx';
  v_pay   uuid := gen_random_uuid();
  v_res   jsonb;
begin
  insert into public.order_submissions (id, status, submitted_by, created_by, parse_warnings, parse_blocking_issues)
  values (p_id, 'draft', v_owner, v_owner, '[]', '[]');
  update public.order_submissions
     set client_name = p_client, gross_product_amount = p_total, discount_amount = 0, total_before_gst = p_total,
         grand_total = p_total, source_workbook_path = v_wb, source_workbook_sha256 = repeat('b', 64)
   where id = p_id;
  insert into storage.objects (bucket_id, name, metadata) values ('order-files', v_wb,
    jsonb_build_object('mimetype', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
  insert into public.order_submission_items (submission_id, source_row, item_sequence, product_name, quantity, cost_per_piece, total_amount, sort_order)
  values (p_id, 32, 'B001', p_client || ' chair', 10, p_total / 10, p_total, 0);
  insert into public.order_submission_item_images (submission_id, item_id, role, position, storage_path, mime_type, sha256, anchor_row)
  select p_id, i.id, 'representative', 0,
         'submissions/' || p_id || '/images/' || i.id || '/representative/0-' || repeat('c', 64) || '.png', 'image/png', repeat('c', 64), 32
    from public.order_submission_items i where i.submission_id = p_id;
  insert into storage.objects (bucket_id, name, metadata)
  select 'order-files', storage_path, jsonb_build_object('mimetype', 'image/png') from public.order_submission_item_images where submission_id = p_id;
  if p_to = 'draft' then return p_id; end if;
  perform set_config('request.jwt.claims', '', true);
  insert into public.finance_payment_requests (id, client_name, amount, payment_date, payment_mode, status, submitted_by, received_in)
  values (v_pay, p_client, p_total * 0.4, current_date, 'hdfc', 'approved_unlinked', v_owner, null);
  insert into public.finance_payment_allocations (payment_request_id, order_submission_id, allocated_amount, origin_target_type, created_by)
  values (v_pay, p_id, p_total * 0.4, 'order_submission', v_owner);
  execute 'set local role authenticated';
  perform pg_temp.act(v_owner);
  perform public.submit_pi_for_review(p_id, null, null, null, null);
  if p_to = 'approved' then
    perform pg_temp.act(v_admin);
    if (select pi_approved_at from public.order_submissions where id = p_id) is null then
      perform public.approve_pi_review(p_id);
    end if;
    v_res := public.approve_order_submission(p_id, v_owner, current_date, current_date + 30, 'reference');
  end if;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  return p_id;
end $$;

do $$
declare
  n_pass int := 0;
  n_fail int := 0;
  failures text[] := '{}';
  v_report text;

  u_owner constant uuid := '0ad00000-0000-4000-8000-000000000001';
  u_other constant uuid := '0ad00000-0000-4000-8000-000000000002';
  u_admin constant uuid := '0ad00000-0000-4000-8000-000000000003';

  k_draft    constant uuid := 'd0000000-0000-4000-8000-0000000000ad';
  k_review   constant uuid := 'e0000000-0000-4000-8000-0000000000ad';
  k_approved constant uuid := 'a0000000-0000-4000-8000-0000000000ad';
  k_order    uuid;

  v_res  jsonb;
  v_cnt  int;
  v_txt  text;
  v_num  numeric;
  v_ts   timestamptz;
begin
  -- ── fixture: through the real doors ────────────────────────────────────────
  perform pg_temp.pi(k_draft,    'ASSERT AA Draft Co',    100000, 'draft');
  perform pg_temp.pi(k_review,   'ASSERT AA Review Co',   150000, 'submitted');
  perform pg_temp.pi(k_approved, 'ASSERT AA Approved Co', 250000, 'approved');
  select order_id into k_order from public.order_submissions where id = k_approved;
  if k_order is null or (select status from public.order_submissions where id = k_review) <> 'submitted' then
    raise exception 'fixture: the PI under review or the approved PI''s Order was not created';
  end if;

  -- ═══ A. AN APPROVED PI IN FORCE ON AN ORDER CHANGES ONLY AS A VERSION ═════
  -- Admin included, reason or not (20270115000000).
  set local role authenticated;
  perform pg_temp.act(u_admin);
  begin
    v_res := public.set_order_submission_billing_percentage(k_approved, 60, 'Client renegotiated the billing split');
    failures := array_append(failures, 'A1: an admin rewrote an approved PI in place'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%ORDER_PI_APPROVED_EDIT_REQUIRES_REVISION%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'A1: wrong refusal -> ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;
  reset role;

  -- ═══ B. NOTHING MOVED ═══════════════════════════════════════════════════
  select billing_percentage into v_num from public.order_submissions where id = k_approved;
  if v_num is null then n_pass := n_pass + 1;
  else failures := array_append(failures, format('B1: the PI holds %s after a refused edit', v_num)); n_fail := n_fail + 1; end if;
  select billing_percentage into v_num from public.orders where id = k_order;
  if v_num is null then n_pass := n_pass + 1;
  else failures := array_append(failures, format('B2: the Order holds %s after a refused edit', v_num)); n_fail := n_fail + 1; end if;
  select source_order_submission_id into v_txt from public.orders where id = k_order;
  if v_txt = k_approved::text then n_pass := n_pass + 1;
  else failures := array_append(failures, 'B3: the PI linkage changed'); n_fail := n_fail + 1; end if;

  -- ═══ A'. THE ADMIN AMENDMENT, WHERE IT STILL APPLIES: A PI UNDER REVIEW ═══
  set local role authenticated;
  perform pg_temp.act(u_admin);
  begin
    v_res := public.set_order_submission_billing_percentage(k_review, 60, 'Client renegotiated the billing split');
    if (v_res->>'changed')::boolean then n_pass := n_pass + 1;
    else failures := array_append(failures, 'A2: the admin write reported no change'); n_fail := n_fail + 1; end if;
  exception when others then
    failures := array_append(failures, 'A2: an admin cannot amend a PI under review -> ' || sqlerrm); n_fail := n_fail + 1;
  end;
  reset role;
  select billing_percentage into v_num from public.order_submissions where id = k_review;
  if v_num = 60 then n_pass := n_pass + 1;
  else failures := array_append(failures, format('A3: the PI holds %s, wanted 60', v_num)); n_fail := n_fail + 1; end if;

  -- ═══ C. A REASON IS REQUIRED AFTER SUBMISSION ═══════════════════════════
  set local role authenticated;
  perform pg_temp.act(u_admin);
  begin
    v_res := public.set_order_submission_billing_percentage(k_review, 70, null);
    failures := array_append(failures, 'C1: an admin amended a submitted PI with NO reason'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%REASON_REQUIRED%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'C1: wrong refusal -> ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;
  begin
    v_res := public.set_order_submission_billing_percentage(k_review, 70);
    failures := array_append(failures, 'C2: the 2-arg delegate bypassed the reason requirement'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%REASON_REQUIRED%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'C2: wrong refusal -> ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;
  reset role;

  -- ═══ D. THE OWNER RULE IS UNCHANGED ═════════════════════════════════════
  set local role authenticated;
  perform pg_temp.act(u_owner);
  begin
    v_res := public.set_order_submission_billing_percentage(k_draft, 45);
    if (v_res->>'changed')::boolean then n_pass := n_pass + 1;
    else failures := array_append(failures, 'D1: the owner draft edit reported no change'); n_fail := n_fail + 1; end if;
  exception when others then
    failures := array_append(failures, 'D1: the owner cannot edit their own draft -> ' || sqlerrm); n_fail := n_fail + 1;
  end;
  begin
    v_res := public.set_order_submission_billing_percentage(k_approved, 80, 'I would like to');
    failures := array_append(failures, 'D2: the OWNER amended an approved PI'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%NOT_EDITABLE%' or sqlerrm like '%ORDER_PI_APPROVED_EDIT_REQUIRES_REVISION%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'D2: wrong refusal -> ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;
  reset role;

  -- ═══ E. NOBODY ELSE ═════════════════════════════════════════════════════
  -- u_other holds orders.view and orders.approve_order but is not an admin and
  -- does not own the PI. Approval authority must not become editing authority.
  set local role authenticated;
  perform pg_temp.act(u_other);
  foreach v_txt in array array[k_review::text, k_approved::text] loop
    begin
      v_res := public.set_order_submission_billing_percentage(v_txt::uuid, 90, 'because');
      failures := array_append(failures, 'E1: a non-admin approver amended ' || v_txt); n_fail := n_fail + 1;
    exception when others then
      if sqlerrm like '%NOT_EDITABLE%' or sqlerrm like '%ORDER_PI_APPROVED_EDIT_REQUIRES_REVISION%' then n_pass := n_pass + 1;
      else failures := array_append(failures, 'E1: wrong refusal -> ' || sqlerrm); n_fail := n_fail + 1; end if;
    end;
  end loop;
  reset role;

  -- ═══ F. RANGE AND PRECISION SURVIVE ═════════════════════════════════════
  set local role authenticated;
  perform pg_temp.act(u_admin);
  for v_num in select unnest(array[34, 101, 0]) loop
    begin
      v_res := public.set_order_submission_billing_percentage(k_review, v_num, 'r');
      failures := array_append(failures, format('F: %s was accepted', v_num)); n_fail := n_fail + 1;
    exception when others then
      if sqlerrm like '%OUT_OF_RANGE%' then n_pass := n_pass + 1;
      else failures := array_append(failures, 'F: wrong refusal -> ' || sqlerrm); n_fail := n_fail + 1; end if;
    end;
  end loop;
  begin
    v_res := public.set_order_submission_billing_percentage(k_review, 60.123, 'r');
    failures := array_append(failures, 'F4: three decimals accepted'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%PRECISION%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'F4: wrong refusal -> ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;
  reset role;

  -- ═══ G. AN UNCHANGED SAVE WRITES NOTHING ════════════════════════════════
  set local role authenticated;
  perform pg_temp.act(u_admin);
  v_res := public.set_order_submission_billing_percentage(k_review, 60, 'no change at all');
  reset role;
  if (v_res->>'changed')::boolean is false then n_pass := n_pass + 1;
  else failures := array_append(failures, 'G1: an unchanged save reported a change'); n_fail := n_fail + 1; end if;
  select count(*) into v_cnt from public.order_submission_activity
   where submission_id = k_review and (metadata->>'new_billing_percentage')::numeric = 60;
  if v_cnt = 1 then n_pass := n_pass + 1;
  else failures := array_append(failures, format('G2: %s activity rows for the same value', v_cnt)); n_fail := n_fail + 1; end if;

  -- ═══ H. OWNER AND ADMIN EDITS ARE DISTINGUISHABLE ═══════════════════════
  select action, note into v_txt, v_report from public.order_submission_activity
   where submission_id = k_review and action like 'billing_percentage%' order by created_at limit 1;
  if v_txt = 'billing_percentage_amended_by_admin' then n_pass := n_pass + 1;
  else failures := array_append(failures, format('H1: the admin edit logged as %s', v_txt)); n_fail := n_fail + 1; end if;
  if v_report = 'Client renegotiated the billing split' then n_pass := n_pass + 1;
  else failures := array_append(failures, format('H3: the reason was not recorded (%s)', coalesce(v_report, 'null'))); n_fail := n_fail + 1; end if;
  select action, note into v_txt, v_report from public.order_submission_activity
   where submission_id = k_draft and action like 'billing_percentage%' order by created_at limit 1;
  if v_txt = 'billing_percentage_set' then n_pass := n_pass + 1;
  else failures := array_append(failures, format('H2: the owner edit logged as %s', v_txt)); n_fail := n_fail + 1; end if;
  if v_report is null then n_pass := n_pass + 1;
  else failures := array_append(failures, 'H4: an owner draft edit demanded a reason'); n_fail := n_fail + 1; end if;

  -- ═══ I. A REFUSED EDIT SUPERSEDES NO DOCUMENT ═══════════════════════════
  -- A ready generated document of the Order stays current: nothing about the
  -- approved PI changed. (A new version supersedes documents when an Admin
  -- approves it — 20270116000000, proved by its own suite.)
  insert into public.order_document_versions
    (order_id, version, status, excel_path, pdf_path, excel_sha256, pdf_sha256, completed_at)
  values (k_order, 1, 'ready',
          public.order_document_attempt_path(k_order, 1, 1, 'xlsx'),
          public.order_document_attempt_path(k_order, 1, 1, 'pdf'),
          repeat('a',64), repeat('b',64), now());
  set local role authenticated;
  perform pg_temp.act(u_admin);
  begin
    perform public.set_order_submission_billing_percentage(k_approved, 75, 'Amended after approval');
  exception when others then null;
  end;
  reset role;
  select superseded_at into v_ts from public.order_document_versions where order_id = k_order and version = 1;
  if v_ts is null then n_pass := n_pass + 1;
  else failures := array_append(failures, 'I1: a refused edit superseded the Order''s documents'); n_fail := n_fail + 1; end if;
  select count(*) into v_cnt from public.order_activity_log
   where order_id = k_order and event_type in ('order_billing_percentage_amended', 'document_generation_superseded');
  if v_cnt = 0 then n_pass := n_pass + 1;
  else failures := array_append(failures, format('I2: %s Order events for a refused edit', v_cnt)); n_fail := n_fail + 1; end if;

  -- ═══ J. NO CLIENT ROLE MAY SUPERSEDE DIRECTLY ═══════════════════════════
  set local role authenticated;
  perform pg_temp.act(u_admin);
  begin
    perform public.supersede_order_documents(k_order, 'pi_data_amended');
    failures := array_append(failures, 'J1: a client role executed supersede_order_documents'); n_fail := n_fail + 1;
  exception when insufficient_privilege then n_pass := n_pass + 1;
  when others then
    if sqlerrm like '%permission denied%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'J1: unexpected -> ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;
  reset role;

  -- ── report ──────────────────────────────────────────────────────────────
  if n_fail = 0 then
    raise notice 'ALL ASSERTIONS PASSED (% checks)', n_pass;
  else
    foreach v_report in array failures loop raise notice 'FAIL  %', v_report; end loop;
    raise exception '% passed, % FAILED', n_pass, n_fail;
  end if;
end $$;

rollback;
