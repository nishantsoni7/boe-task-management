-- ═══════════════════════════════════════════════════════════════════════════
-- ADMIN AMENDMENT — behavioural assertions for 20260927000000
--
-- One transaction, ending in ROLLBACK. Needs fixture rows, so run it against a
-- scratch database, never production. (The read-only posture checks are the
-- ones that are safe anywhere.)
--
-- Usage:  psql "$SCRATCH_URL" -f supabase/tests/order_submission_admin_amendment_assertions.sql
-- ═══════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
begin;

insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed)
select u, m.id, a.id, true
  from (values ('11111111-1111-1111-1111-111111111111'::uuid),
               ('44444444-4444-4444-4444-444444444444'::uuid)) v(u),
       public.permission_modules m, public.permission_actions a
 where m.module_key = 'orders' and a.action_key in ('view', 'approve_order');

do $$
declare
  n_pass int := 0;
  n_fail int := 0;
  failures text[] := '{}';
  v_report text;

  u_owner constant uuid := '11111111-1111-1111-1111-111111111111';
  u_other constant uuid := '22222222-2222-2222-2222-222222222222';
  u_admin constant uuid := '66666666-6666-6666-6666-666666666666';

  k_draft    constant uuid := 'd0000000-0000-0000-0000-00000000000d';
  k_approved constant uuid := 'a0000000-0000-0000-0000-00000000000a';
  k_order    constant uuid := 'b0000000-0000-0000-0000-00000000000b';

  v_res  jsonb;
  v_cnt  int;
  v_txt  text;
  v_num  numeric;
  v_ts   timestamptz;
begin
  -- ── fixture ───────────────────────────────────────────────────────────────
  insert into public.order_submissions (id, status, client_name, created_by, submitted_by, total_before_gst)
  values (k_draft, 'draft', 'Draft Co', u_owner, u_owner, 100000);

  insert into public.order_submissions (id, status, client_name, created_by, submitted_by, total_before_gst)
  values (k_approved, 'approved', 'Approved Co', u_owner, u_owner, 250000);

  insert into public.orders (id, display_number, client_name, requested_by, confirm_date,
                             source_order_submission_id, status, billing_percentage)
  values (k_order, '0001', 'Approved Co', u_owner, current_date, k_approved, 'running', null);

  update public.order_submissions set order_id = k_order where id = k_approved;

  -- ═══ A. THE EXACT MANUAL-TEST FAILURE ═══════════════════════════════════
  -- An ACTIVE ADMIN, on the approved PI behind confirmed Order 0001, setting
  -- the billing percentage. This raised
  -- ORDER_SUBMISSION_BILLING_NOT_EDITABLE before 20260927000000.
  set local role authenticated;
  perform set_config('test.uid', u_admin::text, true);
  begin
    v_res := public.set_order_submission_billing_percentage(k_approved, 60, 'Client renegotiated the billing split');
    if (v_res->>'changed')::boolean then
      n_pass := n_pass + 1;
    else
      failures := array_append(failures, 'A1: the admin write reported no change'); n_fail := n_fail + 1;
    end if;
  exception when others then
    failures := array_append(failures, 'A1: THE MANUAL-TEST FAILURE PERSISTS -> ' || sqlerrm);
    n_fail := n_fail + 1;
  end;
  reset role;

  select billing_percentage into v_num from public.order_submissions where id = k_approved;
  if v_num = 60 then n_pass := n_pass + 1;
  else failures := array_append(failures, format('A2: the PI holds %s, wanted 60', v_num)); n_fail := n_fail + 1; end if;

  -- ═══ B. THE LINKED ORDER STAYS CONSISTENT ═══════════════════════════════
  select billing_percentage into v_num from public.orders where id = k_order;
  if v_num = 60 then n_pass := n_pass + 1;
  else failures := array_append(failures, format('B1: the Order holds %s, wanted 60', v_num)); n_fail := n_fail + 1; end if;

  -- and NOTHING else about the Order moved
  select display_number into v_txt from public.orders where id = k_order;
  if v_txt = '0001' then n_pass := n_pass + 1;
  else failures := array_append(failures, 'B2: the Order NUMBER changed'); n_fail := n_fail + 1; end if;

  select source_order_submission_id into v_txt from public.orders where id = k_order;
  if v_txt = k_approved::text then n_pass := n_pass + 1;
  else failures := array_append(failures, 'B3: the PI linkage changed'); n_fail := n_fail + 1; end if;

  -- ═══ C. A REASON IS REQUIRED AFTER SUBMISSION ═══════════════════════════
  set local role authenticated;
  perform set_config('test.uid', u_admin::text, true);
  begin
    v_res := public.set_order_submission_billing_percentage(k_approved, 70, null);
    failures := array_append(failures, 'C1: an admin amended a submitted PI with NO reason');
    n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%REASON_REQUIRED%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'C1: wrong refusal -> ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;

  -- the two-argument form must refuse for the same reason, not slip through
  begin
    v_res := public.set_order_submission_billing_percentage(k_approved, 70);
    failures := array_append(failures, 'C2: the 2-arg delegate bypassed the reason requirement');
    n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%REASON_REQUIRED%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'C2: wrong refusal -> ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;
  reset role;

  -- ═══ D. THE OWNER RULE IS UNCHANGED ═════════════════════════════════════
  -- owner CAN edit their draft, with no reason
  set local role authenticated;
  perform set_config('test.uid', u_owner::text, true);
  begin
    v_res := public.set_order_submission_billing_percentage(k_draft, 45);
    if (v_res->>'changed')::boolean then n_pass := n_pass + 1;
    else failures := array_append(failures, 'D1: the owner draft edit reported no change'); n_fail := n_fail + 1; end if;
  exception when others then
    failures := array_append(failures, 'D1: the owner cannot edit their own draft -> ' || sqlerrm);
    n_fail := n_fail + 1;
  end;

  -- owner CANNOT edit the approved PI, even with a reason
  begin
    v_res := public.set_order_submission_billing_percentage(k_approved, 80, 'I would like to');
    failures := array_append(failures, 'D2: the OWNER amended an approved PI'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%NOT_EDITABLE%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'D2: wrong refusal -> ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;
  reset role;

  -- ═══ E. NOBODY ELSE ═════════════════════════════════════════════════════
  -- u_other holds orders.view and orders.approve_order but is not an admin and
  -- does not own the PI. Approval authority must not become editing authority.
  set local role authenticated;
  perform set_config('test.uid', u_other::text, true);
  begin
    v_res := public.set_order_submission_billing_percentage(k_approved, 90, 'because');
    failures := array_append(failures, 'E1: a non-admin approver amended an approved PI'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%NOT_EDITABLE%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'E1: wrong refusal -> ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;
  reset role;

  -- ═══ F. RANGE AND PRECISION SURVIVE ═════════════════════════════════════
  set local role authenticated;
  perform set_config('test.uid', u_admin::text, true);
  for v_num in select unnest(array[34, 101, 0]) loop
    begin
      v_res := public.set_order_submission_billing_percentage(k_approved, v_num, 'r');
      failures := array_append(failures, format('F: %s was accepted', v_num)); n_fail := n_fail + 1;
    exception when others then
      if sqlerrm like '%OUT_OF_RANGE%' then n_pass := n_pass + 1;
      else failures := array_append(failures, 'F: wrong refusal -> ' || sqlerrm); n_fail := n_fail + 1; end if;
    end;
  end loop;

  begin
    v_res := public.set_order_submission_billing_percentage(k_approved, 60.123, 'r');
    failures := array_append(failures, 'F4: three decimals accepted'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%PRECISION%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'F4: wrong refusal -> ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;
  reset role;

  -- ═══ G. AN UNCHANGED SAVE WRITES NOTHING ════════════════════════════════
  select count(*) into v_cnt from public.order_submission_activity where submission_id = k_approved;
  set local role authenticated;
  perform set_config('test.uid', u_admin::text, true);
  v_res := public.set_order_submission_billing_percentage(k_approved, 60, 'no change at all');
  reset role;
  if (v_res->>'changed')::boolean is false then n_pass := n_pass + 1;
  else failures := array_append(failures, 'G1: an unchanged save reported a change'); n_fail := n_fail + 1; end if;

  select count(*) into v_cnt from public.order_submission_activity
   where submission_id = k_approved and (metadata->>'new_billing_percentage')::numeric = 60;
  if v_cnt = 1 then n_pass := n_pass + 1;
  else failures := array_append(failures, format('G2: %s activity rows for the same value', v_cnt)); n_fail := n_fail + 1; end if;

  -- ═══ H. OWNER AND ADMIN EDITS ARE DISTINGUISHABLE ═══════════════════════
  select action into v_txt from public.order_submission_activity
   where submission_id = k_approved order by created_at limit 1;
  if v_txt = 'billing_percentage_amended_by_admin' then n_pass := n_pass + 1;
  else failures := array_append(failures, format('H1: the admin edit logged as %s', v_txt)); n_fail := n_fail + 1; end if;

  select action into v_txt from public.order_submission_activity
   where submission_id = k_draft order by created_at limit 1;
  if v_txt = 'billing_percentage_set' then n_pass := n_pass + 1;
  else failures := array_append(failures, format('H2: the owner edit logged as %s', v_txt)); n_fail := n_fail + 1; end if;

  -- the reason is recorded, and only for the admin edit
  select note into v_txt from public.order_submission_activity
   where submission_id = k_approved order by created_at limit 1;
  if v_txt = 'Client renegotiated the billing split' then n_pass := n_pass + 1;
  else failures := array_append(failures, format('H3: the reason was not recorded (%s)', coalesce(v_txt,'null'))); n_fail := n_fail + 1; end if;

  select note into v_txt from public.order_submission_activity
   where submission_id = k_draft order by created_at limit 1;
  if v_txt is null then n_pass := n_pass + 1;
  else failures := array_append(failures, 'H4: an owner draft edit demanded a reason'); n_fail := n_fail + 1; end if;

  -- ═══ I. DOCUMENT SUPERSESSION ═══════════════════════════════════════════
  -- a READY version exists, then the billing percentage changes
  insert into public.order_document_versions
    (order_id, version, status, excel_path, pdf_path, excel_sha256, pdf_sha256, completed_at)
  values (k_order, 1, 'ready',
          public.order_document_attempt_path(k_order, 1, 1, 'xlsx'),
          public.order_document_attempt_path(k_order, 1, 1, 'pdf'),
          repeat('a',64), repeat('b',64), now());

  set local role authenticated;
  perform set_config('test.uid', u_admin::text, true);
  v_res := public.set_order_submission_billing_percentage(k_approved, 75, 'Amended after approval');
  reset role;

  if (v_res->>'superseded_documents')::int = 1 then n_pass := n_pass + 1;
  else failures := array_append(failures, format('I1: superseded %s versions, wanted 1',
       v_res->>'superseded_documents')); n_fail := n_fail + 1; end if;

  select superseded_at, superseded_reason into v_ts, v_txt
    from public.order_document_versions where order_id = k_order and version = 1;
  if v_ts is not null then n_pass := n_pass + 1;
  else failures := array_append(failures, 'I2: the ready version was not marked superseded'); n_fail := n_fail + 1; end if;
  if v_txt = 'billing_percentage_changed' then n_pass := n_pass + 1;
  else failures := array_append(failures, format('I3: reason is %s', coalesce(v_txt,'null'))); n_fail := n_fail + 1; end if;

  -- THE FILES ARE UNTOUCHED. Supersession is an opinion about currency, not a
  -- deletion, and the previous version stays downloadable as history.
  select excel_path into v_txt from public.order_document_versions where order_id = k_order and version = 1;
  if v_txt = public.order_document_attempt_path(k_order, 1, 1, 'xlsx') then n_pass := n_pass + 1;
  else failures := array_append(failures, 'I4: the generated file path was altered'); n_fail := n_fail + 1; end if;

  select status into v_txt from public.order_document_versions where order_id = k_order and version = 1;
  if v_txt = 'ready' then n_pass := n_pass + 1;
  else failures := array_append(failures, format('I5: the status became %s', v_txt)); n_fail := n_fail + 1; end if;

  -- SUPERSESSION IS IDEMPOTENT: a second amendment keeps the FIRST timestamp,
  -- because the first thing that invalidated it is the true answer.
  set local role authenticated;
  perform set_config('test.uid', u_admin::text, true);
  v_res := public.set_order_submission_billing_percentage(k_approved, 80, 'Again');
  reset role;
  if (v_res->>'superseded_documents')::int = 0 then n_pass := n_pass + 1;
  else failures := array_append(failures, 'I6: an already-superseded version was superseded again'); n_fail := n_fail + 1; end if;

  select superseded_at into v_ts from public.order_document_versions where order_id = k_order and version = 1;
  if v_ts is not null then n_pass := n_pass + 1;
  else failures := array_append(failures, 'I7: the supersession was cleared'); n_fail := n_fail + 1; end if;

  -- the Order trail records the amendment too
  select count(*) into v_cnt from public.order_activity_log
   where order_id = k_order and event_type = 'order_billing_percentage_amended';
  if v_cnt >= 1 then n_pass := n_pass + 1;
  else failures := array_append(failures, 'I8: no Order-side activity for the amendment'); n_fail := n_fail + 1; end if;

  select count(*) into v_cnt from public.order_activity_log
   where order_id = k_order and event_type = 'document_generation_superseded';
  if v_cnt = 1 then n_pass := n_pass + 1;
  else failures := array_append(failures, format('I9: %s supersession events', v_cnt)); n_fail := n_fail + 1; end if;

  -- ═══ J. NO CLIENT ROLE MAY SUPERSEDE DIRECTLY ═══════════════════════════
  set local role authenticated;
  perform set_config('test.uid', u_admin::text, true);
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
