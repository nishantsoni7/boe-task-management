-- ═══════════════════════════════════════════════════════════════════════════
-- PI CLIENT DETAILS EDITING — behavioural assertions for 20260928000000
--
-- One transaction, ending in ROLLBACK. Needs fixture rows, so run it against a
-- scratch database, never production.
--
-- Usage:  psql "$SCRATCH_URL" -f supabase/tests/order_submission_client_details_assertions.sql
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

  v_res jsonb;
  v_txt text;
  v_cnt int;
  v_ver  int;
  v_ver2 int;
  v_cnt2 int;
begin
  -- ── fixture: the reported case — an approved PI with NO client name ───────
  -- The CHECK constraint forbids a blank client_name once submitted, so the
  -- fixture is built as a draft and moved, which is how the real record got
  -- there before the constraint existed.
  insert into public.order_submissions (id, status, client_name, created_by, submitted_by, total_before_gst)
  values (k_draft, 'draft', null, u_owner, u_owner, 100000);

  insert into public.order_submissions (id, status, client_name, created_by, submitted_by, total_before_gst)
  values (k_approved, 'approved', 'Placeholder Co', u_owner, u_owner, 250000);

  insert into public.orders (id, display_number, client_name, requested_by, confirm_date,
                             source_order_submission_id, status)
  values (k_order, '0001', 'Placeholder Co', u_owner, current_date, k_approved, 'running');

  update public.order_submissions set order_id = k_order where id = k_approved;

  -- ═══ A. THE REPORTED DEAD END ═══════════════════════════════════════════
  -- A PI with no client name, and the owner supplying one in their own draft.
  set local role authenticated;
  perform set_config('test.uid', u_owner::text, true);
  begin
    v_res := public.update_order_submission_client_details(
      k_draft, jsonb_build_object('client_name', 'Marigold Interiors'), null, null);
    if (v_res->>'changed')::boolean then n_pass := n_pass + 1;
    else failures := array_append(failures, 'A1: the owner edit reported no change'); n_fail := n_fail + 1; end if;
  exception when others then
    failures := array_append(failures, 'A1: THE DEAD END PERSISTS -> ' || sqlerrm); n_fail := n_fail + 1;
  end;
  reset role;

  select client_name into v_txt from public.order_submissions where id = k_draft;
  if v_txt = 'Marigold Interiors' then n_pass := n_pass + 1;
  else failures := array_append(failures, format('A2: the PI holds %s', coalesce(v_txt,'null'))); n_fail := n_fail + 1; end if;

  -- and the readiness gate that blocked the payment is now satisfied
  if coalesce(btrim(v_txt), '') <> '' then n_pass := n_pass + 1;
  else failures := array_append(failures, 'A3: a payment would still be refused'); n_fail := n_fail + 1; end if;

  -- ═══ B. ADMIN AMENDMENT AFTER APPROVAL ══════════════════════════════════
  set local role authenticated;
  perform set_config('test.uid', u_admin::text, true);
  begin
    v_res := public.update_order_submission_client_details(
      k_approved,
      jsonb_build_object('client_name', 'Acme Furnishings', 'contact_number', '+91 98765 43210'),
      null, 'Client name was misread from the workbook');
    if (v_res->>'fields')::int = 2 then n_pass := n_pass + 1;
    else failures := array_append(failures, format('B1: %s fields changed, wanted 2', v_res->>'fields')); n_fail := n_fail + 1; end if;
  exception when others then
    failures := array_append(failures, 'B1: admin amendment refused -> ' || sqlerrm); n_fail := n_fail + 1;
  end;
  reset role;

  -- the linked Order carries the corrected name
  select client_name into v_txt from public.orders where id = k_order;
  if v_txt = 'Acme Furnishings' then n_pass := n_pass + 1;
  else failures := array_append(failures, format('B2: the Order holds %s', coalesce(v_txt,'null'))); n_fail := n_fail + 1; end if;

  -- and nothing else about it moved
  select display_number into v_txt from public.orders where id = k_order;
  if v_txt = '0001' then n_pass := n_pass + 1;
  else failures := array_append(failures, 'B3: the Order NUMBER changed'); n_fail := n_fail + 1; end if;

  select source_order_submission_id::text into v_txt from public.orders where id = k_order;
  if v_txt = k_approved::text then n_pass := n_pass + 1;
  else failures := array_append(failures, 'B4: the PI linkage changed'); n_fail := n_fail + 1; end if;

  -- ═══ C. A REASON IS REQUIRED AFTER SUBMISSION ═══════════════════════════
  set local role authenticated;
  perform set_config('test.uid', u_admin::text, true);
  begin
    v_res := public.update_order_submission_client_details(
      k_approved, jsonb_build_object('ship_to_name', 'Site B'), null, null);
    failures := array_append(failures, 'C1: an admin amended an approved PI with NO reason'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%REASON_REQUIRED%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'C1: wrong refusal -> ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;
  reset role;

  -- ═══ D. AUTHORITY ═══════════════════════════════════════════════════════
  -- the owner cannot edit their APPROVED PI
  set local role authenticated;
  perform set_config('test.uid', u_owner::text, true);
  begin
    v_res := public.update_order_submission_client_details(
      k_approved, jsonb_build_object('client_name', 'Mine now'), null, 'because');
    failures := array_append(failures, 'D1: the OWNER amended an approved PI'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%NOT_EDITABLE%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'D1: wrong refusal -> ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;
  reset role;

  -- a non-admin holding orders.approve_order gains nothing
  set local role authenticated;
  perform set_config('test.uid', u_other::text, true);
  begin
    v_res := public.update_order_submission_client_details(
      k_approved, jsonb_build_object('client_name', 'Reviewer edit'), null, 'because');
    failures := array_append(failures, 'D2: an approver amended an approved PI'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%NOT_EDITABLE%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'D2: wrong refusal -> ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;

  -- ...and cannot edit somebody else's DRAFT either
  begin
    v_res := public.update_order_submission_client_details(
      k_draft, jsonb_build_object('client_name', 'Not mine'), null, null);
    failures := array_append(failures, 'D3: a stranger edited another owner''s draft'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%NOT_EDITABLE%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'D3: wrong refusal -> ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;
  reset role;

  -- ═══ E. OPTIMISTIC CONCURRENCY ══════════════════════════════════════════
  select row_version into v_ver from public.order_submissions where id = k_draft;

  set local role authenticated;
  perform set_config('test.uid', u_owner::text, true);
  -- the CORRECT version is accepted
  begin
    v_res := public.update_order_submission_client_details(
      k_draft, jsonb_build_object('bill_to_name', 'Marigold Billing'), v_ver, null);
    if (v_res->>'changed')::boolean then n_pass := n_pass + 1;
    else failures := array_append(failures, 'E1: a fresh version was rejected'); n_fail := n_fail + 1; end if;
  exception when others then
    failures := array_append(failures, 'E1: a fresh version was rejected -> ' || sqlerrm); n_fail := n_fail + 1;
  end;

  -- the SAME (now stale) version is refused
  begin
    v_res := public.update_order_submission_client_details(
      k_draft, jsonb_build_object('bill_to_name', 'Overwrite'), v_ver, null);
    failures := array_append(failures, 'E2: a STALE edit silently overwrote a newer one'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%STALE%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'E2: wrong refusal -> ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;

  -- and the first write survived the refused second one
  select bill_to_name into v_txt from public.order_submissions where id = k_draft;
  if v_txt = 'Marigold Billing' then n_pass := n_pass + 1;
  else failures := array_append(failures, format('E3: the surviving value is %s', coalesce(v_txt,'null'))); n_fail := n_fail + 1; end if;
  reset role;

  -- ═══ F. THE ALLOW-LIST ══════════════════════════════════════════════════
  set local role authenticated;
  perform set_config('test.uid', u_owner::text, true);
  for v_report in select unnest(array['status', 'total_before_gst', 'grand_total',
                                      'billing_percentage', 'order_id', 'created_by',
                                      'source_workbook_path', 'id']) loop
    begin
      v_res := public.update_order_submission_client_details(
        k_draft, jsonb_build_object(v_report, 'x'), null, null);
      failures := array_append(failures, format('F: %s was accepted as an editable field', v_report));
      n_fail := n_fail + 1;
    exception when others then
      if sqlerrm like '%UNKNOWN_FIELD%' then n_pass := n_pass + 1;
      else failures := array_append(failures, format('F: %s -> %s', v_report, sqlerrm)); n_fail := n_fail + 1; end if;
    end;
  end loop;

  -- a non-text value is refused rather than coerced
  begin
    v_res := public.update_order_submission_client_details(
      k_draft, jsonb_build_object('client_name', 42), null, null);
    failures := array_append(failures, 'F9: a number was accepted as a client name'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%BAD_FIELD_TYPE%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'F9: wrong refusal -> ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;

  -- and an over-long value
  begin
    v_res := public.update_order_submission_client_details(
      k_draft, jsonb_build_object('billing_address', repeat('x', 501)), null, null);
    failures := array_append(failures, 'F10: a 501-character value was accepted'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%FIELD_TOO_LONG%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'F10: wrong refusal -> ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;
  reset role;

  -- ═══ G. PARTIAL EDITS, BLANKS AND NO-OPS ════════════════════════════════
  set local role authenticated;
  perform set_config('test.uid', u_owner::text, true);

  -- an ABSENT key leaves its column alone; only the named one moves
  v_res := public.update_order_submission_client_details(
    k_draft, jsonb_build_object('ship_to_name', 'Site A'), null, null);
  select client_name into v_txt from public.order_submissions where id = k_draft;
  if v_txt = 'Marigold Interiors' then n_pass := n_pass + 1;
  else failures := array_append(failures, 'G1: an absent key changed its column'); n_fail := n_fail + 1; end if;

  -- blank becomes NULL, matching the parser
  v_res := public.update_order_submission_client_details(
    k_draft, jsonb_build_object('ship_to_name', '   '), null, null);
  select ship_to_name into v_txt from public.order_submissions where id = k_draft;
  if v_txt is null then n_pass := n_pass + 1;
  else failures := array_append(failures, format('G2: blank stored as %s', quote_nullable(v_txt))); n_fail := n_fail + 1; end if;

  -- AN UNCHANGED SAVE WRITES NOTHING
  select count(*) into v_cnt from public.order_submission_activity where submission_id = k_draft;
  v_res := public.update_order_submission_client_details(
    k_draft, jsonb_build_object('client_name', 'Marigold Interiors'), null, null);
  if (v_res->>'changed')::boolean is false then n_pass := n_pass + 1;
  else failures := array_append(failures, 'G3: an unchanged save reported a change'); n_fail := n_fail + 1; end if;

  -- ...and the trail did not grow. Asserted against the count taken BEFORE the
  -- no-op save, so this cannot pass by accident.
  select count(*) into v_cnt2 from public.order_submission_activity where submission_id = k_draft;
  if v_cnt2 = v_cnt then n_pass := n_pass + 1;
  else failures := array_append(failures,
    format('G3b: an unchanged save wrote %s activity row(s)', v_cnt2 - v_cnt)); n_fail := n_fail + 1; end if;

  -- and the version counter did not move either: nothing changed, so nothing
  -- else holding this row should be told it went stale.
  select row_version into v_ver2 from public.order_submissions where id = k_draft;
  v_res := public.update_order_submission_client_details(
    k_draft, jsonb_build_object('client_name', 'Marigold Interiors'), v_ver2, null);
  select row_version into v_ver from public.order_submissions where id = k_draft;
  if v_ver = v_ver2 then n_pass := n_pass + 1;
  else failures := array_append(failures, 'G3c: an unchanged save bumped the version'); n_fail := n_fail + 1; end if;
  reset role;

  -- a submitted PI may not have its client name cleared
  set local role authenticated;
  perform set_config('test.uid', u_admin::text, true);
  begin
    v_res := public.update_order_submission_client_details(
      k_approved, jsonb_build_object('client_name', ''), null, 'clearing it');
    failures := array_append(failures, 'G4: a submitted PI lost its client name'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%CLIENT_NAME_REQUIRED%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'G4: wrong refusal -> ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;
  reset role;

  -- ═══ H. THE TRAIL ═══════════════════════════════════════════════════════
  -- owner and admin edits are DIFFERENT actions
  select count(*) into v_cnt from public.order_submission_activity
   where submission_id = k_approved and action = 'client_details_amended_by_admin';
  if v_cnt >= 1 then n_pass := n_pass + 1;
  else failures := array_append(failures, 'H1: the admin edit was not logged as an amendment'); n_fail := n_fail + 1; end if;

  select count(*) into v_cnt from public.order_submission_activity
   where submission_id = k_draft and action = 'client_details_updated';
  if v_cnt >= 1 then n_pass := n_pass + 1;
  else failures := array_append(failures, 'H2: the owner edit was not logged'); n_fail := n_fail + 1; end if;

  -- BEFORE AND AFTER are both recorded
  select metadata -> 'changed' -> 'client_name' ->> 'from' into v_txt
    from public.order_submission_activity
   where submission_id = k_approved and action = 'client_details_amended_by_admin'
   order by created_at limit 1;
  if v_txt = 'Placeholder Co' then n_pass := n_pass + 1;
  else failures := array_append(failures, format('H3: previous value recorded as %s', coalesce(v_txt,'null'))); n_fail := n_fail + 1; end if;

  select metadata -> 'changed' -> 'client_name' ->> 'to' into v_txt
    from public.order_submission_activity
   where submission_id = k_approved and action = 'client_details_amended_by_admin'
   order by created_at limit 1;
  if v_txt = 'Acme Furnishings' then n_pass := n_pass + 1;
  else failures := array_append(failures, format('H4: new value recorded as %s', coalesce(v_txt,'null'))); n_fail := n_fail + 1; end if;

  -- the reason is recorded for the admin edit
  select note into v_txt from public.order_submission_activity
   where submission_id = k_approved and action = 'client_details_amended_by_admin'
   order by created_at limit 1;
  if v_txt = 'Client name was misread from the workbook' then n_pass := n_pass + 1;
  else failures := array_append(failures, format('H5: reason recorded as %s', coalesce(v_txt,'null'))); n_fail := n_fail + 1; end if;

  -- ...and NOT demanded of the owner editing their draft
  select note into v_txt from public.order_submission_activity
   where submission_id = k_draft and action = 'client_details_updated'
   order by created_at limit 1;
  if v_txt is null then n_pass := n_pass + 1;
  else failures := array_append(failures, 'H6: an owner draft edit carried a reason'); n_fail := n_fail + 1; end if;

  -- the Order trail records it too
  select count(*) into v_cnt from public.order_activity_log
   where order_id = k_order and event_type = 'order_client_details_amended';
  if v_cnt >= 1 then n_pass := n_pass + 1;
  else failures := array_append(failures, 'H7: no Order-side activity for the amendment'); n_fail := n_fail + 1; end if;

  -- ═══ I. DOCUMENT SUPERSESSION ═══════════════════════════════════════════
  insert into public.order_document_versions
    (order_id, version, status, excel_path, pdf_path, excel_sha256, pdf_sha256, completed_at)
  values (k_order, 1, 'ready',
          public.order_document_attempt_path(k_order, 1, 1, 'xlsx'),
          public.order_document_attempt_path(k_order, 1, 1, 'pdf'),
          repeat('a',64), repeat('b',64), now());

  -- a PRINTED field supersedes
  set local role authenticated;
  perform set_config('test.uid', u_admin::text, true);
  v_res := public.update_order_submission_client_details(
    k_approved, jsonb_build_object('billing_address', '12 New Road'), null, 'corrected address');
  reset role;
  if (v_res->>'superseded_documents')::int = 1 then n_pass := n_pass + 1;
  else failures := array_append(failures, format('I1: superseded %s, wanted 1', v_res->>'superseded_documents')); n_fail := n_fail + 1; end if;

  -- the FILES are untouched and the version stays ready
  select status into v_txt from public.order_document_versions where order_id = k_order and version = 1;
  if v_txt = 'ready' then n_pass := n_pass + 1;
  else failures := array_append(failures, format('I2: status became %s', v_txt)); n_fail := n_fail + 1; end if;

  select excel_path into v_txt from public.order_document_versions where order_id = k_order and version = 1;
  if v_txt = public.order_document_attempt_path(k_order, 1, 1, 'xlsx') then n_pass := n_pass + 1;
  else failures := array_append(failures, 'I3: a generated file path was rewritten'); n_fail := n_fail + 1; end if;

  -- a NON-printed field does NOT supersede (already superseded here, so use a
  -- fresh ready version to test it honestly)
  update public.order_document_versions
     set superseded_at = null, superseded_reason = null
   where order_id = k_order and version = 1;

  set local role authenticated;
  perform set_config('test.uid', u_admin::text, true);
  v_res := public.update_order_submission_client_details(
    k_approved, jsonb_build_object('ship_to_phone', '+91 90000 00000'), null, 'phone correction');
  reset role;
  if (v_res->>'superseded_documents')::int = 0 then n_pass := n_pass + 1;
  else failures := array_append(failures,
    'I4: a field that is not printed superseded the documents — people would regenerate for nothing');
    n_fail := n_fail + 1; end if;

  -- ── report ──────────────────────────────────────────────────────────────
  if n_fail = 0 then
    raise notice 'ALL ASSERTIONS PASSED (% checks)', n_pass;
  else
    foreach v_report in array failures loop raise notice 'FAIL  %', v_report; end loop;
    raise exception '% passed, % FAILED', n_pass, n_fail;
  end if;
end $$;

rollback;
