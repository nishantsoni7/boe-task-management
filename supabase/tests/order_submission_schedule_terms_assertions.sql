-- ═══════════════════════════════════════════════════════════════════════════
-- PI SCHEDULE AND TERMS EDITING — behavioural assertions for 20260929000000
--
-- One transaction, ending in ROLLBACK. Scratch database only.
-- ═══════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
begin;

insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed)
select u, m.id, a.id, true
  from (values ('11111111-1111-1111-1111-111111111111'::uuid),
               ('22222222-2222-2222-2222-222222222222'::uuid)) v(u),
       public.permission_modules m, public.permission_actions a
 where m.module_key = 'orders' and a.action_key in ('view', 'approve_order');

do $$
declare
  n_pass int := 0; n_fail int := 0;
  failures text[] := '{}'; v_report text;

  u_owner constant uuid := '11111111-1111-1111-1111-111111111111';
  u_other constant uuid := '22222222-2222-2222-2222-222222222222';
  u_admin constant uuid := '66666666-6666-6666-6666-666666666666';
  k_draft    constant uuid := 'd1000000-0000-0000-0000-00000000000d';
  k_approved constant uuid := 'a1000000-0000-0000-0000-00000000000a';
  k_order    constant uuid := 'b1000000-0000-0000-0000-00000000000b';

  v_res jsonb; v_txt text; v_cnt int; v_ver int; v_date date;
begin
  insert into public.order_submissions (id, status, client_name, created_by, submitted_by, total_before_gst)
  values (k_draft, 'draft', 'Draft Co', u_owner, u_owner, 100000);
  insert into public.order_submissions (id, status, client_name, created_by, submitted_by, total_before_gst,
                                        order_confirmation_date, due_date)
  values (k_approved, 'approved', 'Approved Co', u_owner, u_owner, 250000,
          date '2026-08-01', date '2026-09-01');
  insert into public.orders (id, display_number, client_name, requested_by, confirm_date, due_date,
                             source_order_submission_id, status)
  values (k_order, '0001', 'Approved Co', u_owner, date '2026-08-01', date '2026-09-01', k_approved, 'running');
  update public.order_submissions set order_id = k_order where id = k_approved;

  -- ═══ A. THE OWNER EDITS THEIR DRAFT ═════════════════════════════════════
  set local role authenticated;
  perform set_config('test.uid', u_owner::text, true);
  begin
    v_res := public.update_order_submission_schedule_terms(
      k_draft,
      jsonb_build_object('order_confirmation_date', '2026-10-05',
                         'payment_terms', '30% advance, 40% production, 30% dispatch'),
      null, null);
    if (v_res->>'fields')::int = 2 then n_pass := n_pass + 1;
    else failures := array_append(failures, format('A1: %s fields', v_res->>'fields')); n_fail := n_fail + 1; end if;
  exception when others then
    failures := array_append(failures, 'A1: owner draft edit refused -> ' || sqlerrm); n_fail := n_fail + 1;
  end;
  reset role;

  select order_confirmation_date into v_date from public.order_submissions where id = k_draft;
  if v_date = date '2026-10-05' then n_pass := n_pass + 1;
  else failures := array_append(failures, 'A2: the date did not land'); n_fail := n_fail + 1; end if;

  -- ═══ B. ADMIN AMENDS AN APPROVED PI, AND THE ORDER FOLLOWS ══════════════
  set local role authenticated;
  perform set_config('test.uid', u_admin::text, true);
  v_res := public.update_order_submission_schedule_terms(
    k_approved, jsonb_build_object('due_date', '2026-09-20'), null, 'Client moved the deadline');
  reset role;

  select due_date into v_date from public.orders where id = k_order;
  if v_date = date '2026-09-20' then n_pass := n_pass + 1;
  else failures := array_append(failures, format('B1: the Order due date is %s', v_date)); n_fail := n_fail + 1; end if;

  -- the confirm date was NOT sent, so it must not have moved
  select confirm_date into v_date from public.orders where id = k_order;
  if v_date = date '2026-08-01' then n_pass := n_pass + 1;
  else failures := array_append(failures, format('B2: an unsent date changed to %s', v_date)); n_fail := n_fail + 1; end if;

  -- nothing else about the Order moved
  select display_number into v_txt from public.orders where id = k_order;
  if v_txt = '0001' then n_pass := n_pass + 1;
  else failures := array_append(failures, 'B3: the Order NUMBER changed'); n_fail := n_fail + 1; end if;

  -- ═══ C. SUPERSESSION FOLLOWS WHAT IS PRINTED ════════════════════════════
  insert into public.order_document_versions
    (order_id, version, status, excel_path, pdf_path, excel_sha256, pdf_sha256, completed_at)
  values (k_order, 1, 'ready',
          public.order_document_attempt_path(k_order, 1, 1, 'xlsx'),
          public.order_document_attempt_path(k_order, 1, 1, 'pdf'),
          repeat('a',64), repeat('b',64), now());

  -- a DATE supersedes
  set local role authenticated;
  perform set_config('test.uid', u_admin::text, true);
  v_res := public.update_order_submission_schedule_terms(
    k_approved, jsonb_build_object('order_confirmation_date', '2026-08-10'), null, 'corrected');
  reset role;
  if (v_res->>'superseded_documents')::int = 1 then n_pass := n_pass + 1;
  else failures := array_append(failures, format('C1: superseded %s, wanted 1', v_res->>'superseded_documents')); n_fail := n_fail + 1; end if;

  -- reset, then prove the NON-printed fields do NOT
  update public.order_document_versions set superseded_at = null, superseded_reason = null
   where order_id = k_order and version = 1;

  set local role authenticated;
  perform set_config('test.uid', u_admin::text, true);
  for v_report in select unnest(array['dispatch_commitment', 'payment_terms', 'billing_terms']) loop
    v_res := public.update_order_submission_schedule_terms(
      k_approved, jsonb_build_object(v_report, 'changed ' || v_report), null, 'r');
    if (v_res->>'superseded_documents')::int = 0 then n_pass := n_pass + 1;
    else failures := array_append(failures,
      format('C2: %s is not printed but superseded the documents', v_report)); n_fail := n_fail + 1; end if;
  end loop;
  reset role;

  -- the version is still ready and its files untouched
  select status into v_txt from public.order_document_versions where order_id = k_order and version = 1;
  if v_txt = 'ready' then n_pass := n_pass + 1;
  else failures := array_append(failures, format('C3: status became %s', v_txt)); n_fail := n_fail + 1; end if;

  -- ═══ D. BILLING PERCENTAGE IS REFUSED, BY NAME ══════════════════════════
  set local role authenticated;
  perform set_config('test.uid', u_admin::text, true);
  begin
    v_res := public.update_order_submission_schedule_terms(
      k_approved, jsonb_build_object('billing_percentage', '60'), null, 'r');
    failures := array_append(failures, 'D1: billing_percentage was accepted here'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%WRONG_EDITOR%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'D1: wrong refusal -> ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;

  -- and so is anything else off the list
  for v_report in select unnest(array['status', 'grand_total', 'client_name', 'order_id']) loop
    begin
      v_res := public.update_order_submission_schedule_terms(
        k_approved, jsonb_build_object(v_report, 'x'), null, 'r');
      failures := array_append(failures, format('D2: %s was accepted', v_report)); n_fail := n_fail + 1;
    exception when others then
      if sqlerrm like '%UNKNOWN_FIELD%' then n_pass := n_pass + 1;
      else failures := array_append(failures, format('D2: %s -> %s', v_report, sqlerrm)); n_fail := n_fail + 1; end if;
    end;
  end loop;
  reset role;

  -- ═══ E. DATES ARE PARSED, NOT TRUSTED ═══════════════════════════════════
  set local role authenticated;
  perform set_config('test.uid', u_owner::text, true);
  -- The last four are PostgreSQL's own relative and infinite date inputs. They
  -- cast without error, so a cast-only check stored them silently; a PI date is
  -- a fact about an agreement, not an expression re-evaluated on write.
  for v_report in select unnest(array['not-a-date', '2026-13-40', '2026-02-30',
                                      'yesterday', 'today', 'infinity', 'epoch']) loop
    begin
      v_res := public.update_order_submission_schedule_terms(
        k_draft, jsonb_build_object('due_date', v_report), null, null);
      failures := array_append(failures, format('E1: %s was accepted as a date', v_report)); n_fail := n_fail + 1;
    exception when others then
      if sqlerrm like '%BAD_DATE%' then n_pass := n_pass + 1;
      else failures := array_append(failures, format('E1: %s -> %s', v_report, sqlerrm)); n_fail := n_fail + 1; end if;
    end;
  end loop;

  -- a date re-spelled differently is NOT a change
  v_res := public.update_order_submission_schedule_terms(
    k_draft, jsonb_build_object('order_confirmation_date', '2026-10-05'), null, null);
  if (v_res->>'changed')::boolean is false then n_pass := n_pass + 1;
  else failures := array_append(failures, 'E2: an identical date read as a change'); n_fail := n_fail + 1; end if;

  -- a date can be CLEARED
  v_res := public.update_order_submission_schedule_terms(
    k_draft, jsonb_build_object('due_date', ''), null, null);
  select due_date into v_date from public.order_submissions where id = k_draft;
  if v_date is null then n_pass := n_pass + 1;
  else failures := array_append(failures, 'E3: a date could not be cleared'); n_fail := n_fail + 1; end if;

  -- an over-long terms string is refused
  begin
    v_res := public.update_order_submission_schedule_terms(
      k_draft, jsonb_build_object('payment_terms', repeat('x', 501)), null, null);
    failures := array_append(failures, 'E4: a 501-character terms string was accepted'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%FIELD_TOO_LONG%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'E4: wrong refusal -> ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;
  reset role;

  -- ═══ F. AUTHORITY ══════════════════════════════════════════════════════
  set local role authenticated;
  perform set_config('test.uid', u_owner::text, true);
  begin
    v_res := public.update_order_submission_schedule_terms(
      k_approved, jsonb_build_object('due_date', '2026-12-01'), null, 'please');
    failures := array_append(failures, 'F1: the OWNER amended an approved PI'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%NOT_EDITABLE%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'F1: wrong refusal -> ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;
  reset role;

  set local role authenticated;
  perform set_config('test.uid', u_other::text, true);
  begin
    v_res := public.update_order_submission_schedule_terms(
      k_approved, jsonb_build_object('due_date', '2026-12-01'), null, 'please');
    failures := array_append(failures, 'F2: a non-admin approver amended an approved PI'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%NOT_EDITABLE%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'F2: wrong refusal -> ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;
  reset role;

  -- an admin with NO reason, after submission
  set local role authenticated;
  perform set_config('test.uid', u_admin::text, true);
  begin
    v_res := public.update_order_submission_schedule_terms(
      k_approved, jsonb_build_object('due_date', '2026-12-01'), null, null);
    failures := array_append(failures, 'F3: an admin amended with no reason'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%REASON_REQUIRED%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'F3: wrong refusal -> ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;
  reset role;

  -- ═══ G. CONCURRENCY AND NO-OPS ═════════════════════════════════════════
  select row_version into v_ver from public.order_submissions where id = k_draft;
  set local role authenticated;
  perform set_config('test.uid', u_owner::text, true);
  v_res := public.update_order_submission_schedule_terms(
    k_draft, jsonb_build_object('billing_terms', '100% before dispatch'), v_ver, null);
  begin
    v_res := public.update_order_submission_schedule_terms(
      k_draft, jsonb_build_object('billing_terms', 'Overwrite'), v_ver, null);
    failures := array_append(failures, 'G1: a STALE edit overwrote a newer one'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%STALE%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'G1: wrong refusal -> ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;
  select billing_terms into v_txt from public.order_submissions where id = k_draft;
  if v_txt = '100% before dispatch' then n_pass := n_pass + 1;
  else failures := array_append(failures, format('G2: surviving value is %s', coalesce(v_txt,'null'))); n_fail := n_fail + 1; end if;

  -- an unchanged save writes nothing and does not bump the version
  select count(*) into v_cnt from public.order_submission_activity where submission_id = k_draft;
  select row_version into v_ver from public.order_submissions where id = k_draft;
  v_res := public.update_order_submission_schedule_terms(
    k_draft, jsonb_build_object('billing_terms', '100% before dispatch'), v_ver, null);
  if (v_res->>'changed')::boolean is false then n_pass := n_pass + 1;
  else failures := array_append(failures, 'G3: an unchanged save reported a change'); n_fail := n_fail + 1; end if;

  select count(*) into v_cnt from public.order_submission_activity where submission_id = k_draft;
  select row_version into v_report from public.order_submissions where id = k_draft;
  if v_report::int = v_ver then n_pass := n_pass + 1;
  else failures := array_append(failures, 'G4: an unchanged save bumped the version'); n_fail := n_fail + 1; end if;
  reset role;

  -- ═══ H. THE TRAIL ══════════════════════════════════════════════════════
  select count(*) into v_cnt from public.order_submission_activity
   where submission_id = k_approved and action = 'schedule_terms_amended_by_admin';
  if v_cnt >= 1 then n_pass := n_pass + 1;
  else failures := array_append(failures, 'H1: the admin edit was not logged as an amendment'); n_fail := n_fail + 1; end if;

  select count(*) into v_cnt from public.order_submission_activity
   where submission_id = k_draft and action = 'schedule_terms_updated';
  if v_cnt >= 1 then n_pass := n_pass + 1;
  else failures := array_append(failures, 'H2: the owner edit was not logged'); n_fail := n_fail + 1; end if;

  select metadata -> 'changed' -> 'due_date' ->> 'from' into v_txt
    from public.order_submission_activity
   where submission_id = k_approved and action = 'schedule_terms_amended_by_admin'
   order by created_at limit 1;
  if v_txt = '2026-09-01' then n_pass := n_pass + 1;
  else failures := array_append(failures, format('H3: previous date recorded as %s', coalesce(v_txt,'null'))); n_fail := n_fail + 1; end if;

  select count(*) into v_cnt from public.order_activity_log
   where order_id = k_order and event_type = 'order_schedule_terms_amended';
  if v_cnt >= 1 then n_pass := n_pass + 1;
  else failures := array_append(failures, 'H4: no Order-side activity'); n_fail := n_fail + 1; end if;

  if n_fail = 0 then
    raise notice 'ALL ASSERTIONS PASSED (% checks)', n_pass;
  else
    foreach v_report in array failures loop raise notice 'FAIL  %', v_report; end loop;
    raise exception '% passed, % FAILED', n_pass, n_fail;
  end if;
end $$;

rollback;
