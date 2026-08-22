-- ═══════════════════════════════════════════════════════════════════════════
-- PI CORRECTION REQUESTS — behavioural assertions for 20260930000000
-- One transaction, ending in ROLLBACK. Scratch database only.
-- ═══════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
begin;

do $$
declare
  n_pass int := 0; n_fail int := 0;
  failures text[] := '{}'; v_report text;
  u_owner constant uuid := '11111111-1111-1111-1111-111111111111';
  u_other constant uuid := '22222222-2222-2222-2222-222222222222';
  u_admin constant uuid := '66666666-6666-6666-6666-666666666666';
  k_draft    constant uuid := 'd2000000-0000-0000-0000-00000000000d';
  k_approved constant uuid := 'a2000000-0000-0000-0000-00000000000a';
  v_res jsonb; v_req uuid; v_txt text; v_cnt int; v_before jsonb; v_act uuid;
begin
  insert into public.order_submissions (id, status, client_name, created_by, submitted_by, total_before_gst)
  values (k_draft, 'draft', 'Draft Co', u_owner, u_owner, 100000),
         (k_approved, 'approved', 'Approved Co', u_owner, u_owner, 250000);

  -- ═══ A. THE OWNER RAISES ONE ════════════════════════════════════════════
  set local role authenticated;
  perform set_config('test.uid', u_owner::text, true);
  begin
    v_res := public.request_order_submission_correction(
      k_approved, 'client', 'The shipping address is the old warehouse',
      'We moved in July and the PI was written before that');
    v_req := (v_res->>'request_id')::uuid;
    if v_res->>'status' = 'open' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'A1: not open'); n_fail := n_fail + 1; end if;
  exception when others then
    failures := array_append(failures, 'A1: refused -> ' || sqlerrm); n_fail := n_fail + 1;
  end;
  reset role;

  -- ═══ B. IT CHANGES NO PI DATA ═══════════════════════════════════════════
  select to_jsonb(s.*) - 'row_version' - 'updated_at' into v_before
    from public.order_submissions s where id = k_approved;
  set local role authenticated;
  perform set_config('test.uid', u_owner::text, true);
  begin
    perform public.request_order_submission_correction(
      k_approved, 'schedule', 'Due date is wrong', 'Client moved it');
  exception when others then null; end;
  reset role;
  if (select to_jsonb(s.*) - 'row_version' - 'updated_at' from public.order_submissions s
      where id = k_approved) = v_before then n_pass := n_pass + 1;
  else failures := array_append(failures, 'B1: raising a request CHANGED the PI'); n_fail := n_fail + 1; end if;

  -- ═══ C. WHO MAY RAISE ═══════════════════════════════════════════════════
  set local role authenticated;
  perform set_config('test.uid', u_other::text, true);
  begin
    perform public.request_order_submission_correction(k_approved, 'client', 'x', 'y');
    failures := array_append(failures, 'C1: a stranger raised a request'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%NOT_OWNER%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'C1: wrong refusal -> ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;
  reset role;

  -- while still editable, the owner is told to edit instead
  set local role authenticated;
  perform set_config('test.uid', u_owner::text, true);
  begin
    perform public.request_order_submission_correction(k_draft, 'client', 'x', 'y');
    failures := array_append(failures, 'C2: a request was allowed on an editable draft'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%STILL_EDITABLE%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'C2: wrong refusal -> ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;

  -- ═══ D. WHAT IS MANDATORY ═══════════════════════════════════════════════
  begin
    perform public.request_order_submission_correction(k_approved, 'products', 'a change', '   ');
    failures := array_append(failures, 'D1: no reason was accepted'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%NO_REASON%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'D1: wrong refusal -> ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;
  begin
    perform public.request_order_submission_correction(k_approved, 'products', '', 'a reason');
    failures := array_append(failures, 'D2: no requested change was accepted'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%NO_CHANGE_REQUESTED%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'D2: wrong refusal -> ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;
  begin
    perform public.request_order_submission_correction(k_approved, 'nowhere', 'a', 'b');
    failures := array_append(failures, 'D3: an unknown section was accepted'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%BAD_SECTION%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'D3: wrong refusal -> ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;

  -- one open request per section
  begin
    perform public.request_order_submission_correction(k_approved, 'client', 'again', 'again');
    failures := array_append(failures, 'D4: a second open request for the same section'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%ALREADY_OPEN%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'D4: wrong refusal -> ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;
  reset role;

  -- ═══ E. IT APPEARS IN ACTIVITY ══════════════════════════════════════════
  select count(*) into v_cnt from public.order_submission_activity
   where submission_id = k_approved and action = 'correction_requested';
  if v_cnt = 2 then n_pass := n_pass + 1;
  else failures := array_append(failures, format('E1: %s activity rows, wanted 2', v_cnt)); n_fail := n_fail + 1; end if;

  select metadata ->> 'section' into v_txt from public.order_submission_activity
   where submission_id = k_approved and action = 'correction_requested'
   order by created_at limit 1;
  if v_txt = 'client' then n_pass := n_pass + 1;
  else failures := array_append(failures, 'E2: the section was not recorded'); n_fail := n_fail + 1; end if;

  -- ═══ F. ONLY AN ADMIN CLOSES ════════════════════════════════════════════
  set local role authenticated;
  perform set_config('test.uid', u_owner::text, true);
  begin
    perform public.resolve_order_submission_correction(v_req, 'resolved', 'done');
    failures := array_append(failures, 'F1: the OWNER closed their own request'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%NOT_ADMIN%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'F1: wrong refusal -> ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;
  reset role;

  -- a rejection must say why
  set local role authenticated;
  perform set_config('test.uid', u_admin::text, true);
  begin
    perform public.resolve_order_submission_correction(v_req, 'rejected', null);
    failures := array_append(failures, 'F2: a rejection with no note'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%NO_REJECTION_NOTE%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'F2: wrong refusal -> ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;

  -- ═══ G. RESOLVING, LINKED TO THE EDIT THAT ANSWERED IT ══════════════════
  perform public.update_order_submission_client_details(
    k_approved, jsonb_build_object('shipping_address', '9 New Estate'), null,
    'Answering the owner''s correction request');
  select id into v_act from public.order_submission_activity
   where submission_id = k_approved and action = 'client_details_amended_by_admin'
   order by created_at desc limit 1;

  v_res := public.resolve_order_submission_correction(v_req, 'resolved', 'Address corrected', v_act);
  if v_res->>'status' = 'resolved' then n_pass := n_pass + 1;
  else failures := array_append(failures, 'G1: not resolved'); n_fail := n_fail + 1; end if;

  select resolved_edit_activity_id into v_txt from public.order_submission_correction_requests where id = v_req;
  if v_txt = v_act::text then n_pass := n_pass + 1;
  else failures := array_append(failures, 'G2: the edit was not linked'); n_fail := n_fail + 1; end if;

  select resolved_by::text into v_txt from public.order_submission_correction_requests where id = v_req;
  if v_txt = u_admin::text then n_pass := n_pass + 1;
  else failures := array_append(failures, 'G3: the closer was not recorded'); n_fail := n_fail + 1; end if;

  reset role;

  -- a third request, raised by the OWNER (the RPC refuses anybody else, which
  -- is why the earlier draft of this test raised nothing at all here)
  set local role authenticated;
  perform set_config('test.uid', u_owner::text, true);
  perform public.request_order_submission_correction(
    k_approved, 'commercial', 'The freight line is doubled', 'It appears twice');
  reset role;

  set local role authenticated;
  perform set_config('test.uid', u_admin::text, true);

  -- ═══ H. A CLOSED REQUEST STAYS CLOSED, AND SURVIVES ═════════════════════
  begin
    perform public.resolve_order_submission_correction(v_req, 'rejected', 'changed my mind');
    failures := array_append(failures, 'H1: a closed request was re-closed'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%REQUEST_CLOSED%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'H1: wrong refusal -> ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;
  reset role;

  -- EXACTLY three: client (resolved), schedule (open), commercial (open).
  -- A resolved request is not removed — that is the whole point of the table.
  select count(*) into v_cnt from public.order_submission_correction_requests
   where submission_id = k_approved;
  if v_cnt = 3 then n_pass := n_pass + 1;
  else failures := array_append(failures, format('H2: %s requests survive, wanted 3', v_cnt)); n_fail := n_fail + 1; end if;

  select count(*) into v_cnt from public.order_submission_correction_requests
   where submission_id = k_approved and status = 'resolved';
  if v_cnt = 1 then n_pass := n_pass + 1;
  else failures := array_append(failures, 'H2b: the resolved request did not survive'); n_fail := n_fail + 1; end if;

  select count(*) into v_cnt from public.order_submission_activity
   where submission_id = k_approved and action = 'correction_resolved';
  if v_cnt = 1 then n_pass := n_pass + 1;
  else failures := array_append(failures, 'H3: the resolution was not logged'); n_fail := n_fail + 1; end if;

  -- ═══ I. NO CLIENT ROLE WRITES THE TABLE DIRECTLY ════════════════════════
  set local role authenticated;
  perform set_config('test.uid', u_admin::text, true);
  begin
    insert into public.order_submission_correction_requests
      (submission_id, section, requested_change, reason, requested_by)
    values (k_approved, 'other', 'direct', 'direct', u_admin);
    failures := array_append(failures, 'I1: a client role inserted directly'); n_fail := n_fail + 1;
  exception when insufficient_privilege then n_pass := n_pass + 1;
  when others then
    if sqlerrm like '%permission denied%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'I1: unexpected -> ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;
  reset role;

  if n_fail = 0 then
    raise notice 'ALL ASSERTIONS PASSED (% checks)', n_pass;
  else
    foreach v_report in array failures loop raise notice 'FAIL  %', v_report; end loop;
    raise exception '% passed, % FAILED', n_pass, n_fail;
  end if;
end $$;

rollback;
