-- ═══════════════════════════════════════════════════════════════════════════
-- CHANGE PI — behavioural assertions for 20261003000000
--
-- One transaction, ending in ROLLBACK. Scratch database only. Never run this
-- against production: it inserts submissions, Orders and document versions.
--
-- Two things are under test and they fail differently:
--
--   the AUTHORITY  — assert_order_submission_workbook_editor, which decides who
--                    may replace a workbook and at which stage. A defect here
--                    is a permission hole.
--   the CONSEQUENCE— what replace_order_submission_parse then does once the PI
--                    has left draft. A defect here is a stale verification, a
--                    stale document, or an Order whose identity moved.
-- ═══════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
begin;

do $$
declare
  n_pass int := 0; n_fail int := 0;
  failures text[] := '{}'; v_report text;

  u_owner    constant uuid := '11111111-1111-1111-1111-111111111111';
  u_other    constant uuid := '22222222-2222-2222-2222-222222222222';
  u_approver constant uuid := '33333333-3333-3333-3333-333333333333';
  u_nobody   constant uuid := '44444444-4444-4444-4444-444444444444';
  u_finance  constant uuid := '55555555-5555-5555-5555-555555555555';
  u_admin    constant uuid := '66666666-6666-6666-6666-666666666666';

  k_draft  constant uuid := 'c1000000-0000-0000-0000-00000000000d';
  k_subm   constant uuid := 'c2000000-0000-0000-0000-00000000000e';
  k_appr   constant uuid := 'c3000000-0000-0000-0000-00000000000a';
  o_appr   constant uuid := 'c4000000-0000-0000-0000-00000000000b';
  d_ver    constant uuid := 'c5000000-0000-0000-0000-00000000000c';
  k_exc    constant uuid := 'c6000000-0000-0000-0000-00000000000d';
  a_appr   constant uuid := 'c7000000-0000-0000-0000-00000000000e';
  t_exc    constant uuid := 'aaaaaaa4-0000-0000-0000-000000000004';

  t_draft  constant uuid := 'aaaaaaa1-0000-0000-0000-000000000001';
  t_subm   constant uuid := 'aaaaaaa2-0000-0000-0000-000000000002';
  t_appr   constant uuid := 'aaaaaaa3-0000-0000-0000-000000000003';

  m_orders uuid; a_create uuid; a_approve uuid;
  v_res jsonb; v_txt text; v_num numeric; v_int int; v_ts timestamptz;
  v_uuid uuid; v_uuid2 uuid; v_bool boolean; v_long text; v_orders_before int;
begin
  select id into m_orders  from public.permission_modules where module_key = 'orders';
  select id into a_create  from public.permission_actions where action_key = 'create';
  select id into a_approve from public.permission_actions where action_key = 'approve_order';

  insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed)
  values (u_owner, m_orders, a_create, true),
         (u_other, m_orders, a_create, true),
         (u_approver, m_orders, a_approve, true);

  -- ── Three PIs, one at each stage that matters ──
  insert into public.order_submissions
    (id, status, client_name, created_by, submitted_by, order_id,
     processing_token, grand_total, gross_product_amount, total_before_gst,
     billing_percentage, order_confirmation_date, due_date)
  values
    (k_draft, 'draft',     'Draft Co',     u_owner, u_owner, null, t_draft,
     295000, 250000, 250000, null, null, null),
    (k_subm,  'submitted', 'Submitted Co', u_owner, u_owner, null, t_subm,
     295000, 250000, 250000, 40, '2026-05-01', '2026-07-01'),
    (k_appr,  'approved',  'Approved Co',  u_owner, u_owner, null, t_appr,
     295000, 250000, 250000, 40, '2026-05-01', '2026-07-01'),
    -- A submitted PI carrying an APPROVED reduced-payment exception, so §J can
    -- ask the real derivation whether the decision is still current.
    (k_exc,   'submitted', 'Exception Co', u_owner, u_owner, null, t_exc,
     295000, 250000, 250000, 40, '2026-05-01', '2026-07-01');

  update public.order_submissions
     set source_workbook_sha256  = repeat('9', 64),
         payment_terms           = '50% advance, balance before dispatch',
         billing_terms           = 'GST invoice on dispatch',
         advance_declared_amount = 118000
   where id = k_exc;

  update public.order_submissions
     set finance_verified_by = u_approver,
         finance_verified_at = now(),
         finance_verified_submission_at = now()
   where id in (k_subm, k_appr);

  -- The approved one carries an Order, with a ready document pair.
  insert into public.orders (id, display_number, client_name, created_by, requested_by,
                             confirm_date, due_date, total_value, total_product_value,
                             billing_percentage, status, source_order_submission_id)
  values (o_appr, '0001', 'Approved Co', u_owner, u_owner,
          '2026-05-01', '2026-07-01', 295000, 250000, 40, 'running', k_appr);
  update public.order_submissions set order_id = o_appr where id = k_appr;

  -- Money that has already arrived against the Order. §K proves not one rupee
  -- of it moves.
  insert into public.finance_payment_allocations
    (id, order_id, order_submission_id, allocated_amount, status)
  values (a_appr, o_appr, null, 120000, 'active');

  insert into public.order_document_versions (id, order_id, version, status,
    excel_path, pdf_path, excel_sha256, pdf_sha256, excel_bytes, pdf_bytes, completed_at)
  values (d_ver, o_appr, 1, 'ready',
          public.order_document_version_prefix(o_appr, 1) || '/order.xlsx',
          public.order_document_version_prefix(o_appr, 1) || '/order.pdf',
          repeat('a', 64), repeat('b', 64), 1000, 2000, now());


  -- ═══ A. THE AUTHORITY, ARGUMENT BY ARGUMENT ════════════════════════════

  begin
    v_res := public.assert_order_submission_workbook_editor(k_draft, null, null);
    failures := array_append(failures, 'A1: a null actor was accepted'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%ACTOR_REQUIRED%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'A1: ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;

  update public.users set is_active = false where id = u_other;
  begin
    v_res := public.assert_order_submission_workbook_editor(k_draft, u_other, null);
    failures := array_append(failures, 'A2: an inactive employee was accepted'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%ACTOR_INVALID%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'A2: ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;
  update public.users set is_active = true where id = u_other;

  update public.users set is_deleted = true where id = u_other;
  begin
    v_res := public.assert_order_submission_workbook_editor(k_draft, u_other, null);
    failures := array_append(failures, 'A3: a deleted employee was accepted'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%ACTOR_INVALID%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'A3: ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;
  update public.users set is_deleted = false where id = u_other;

  -- Active, but holds nothing.
  begin
    v_res := public.assert_order_submission_workbook_editor(k_draft, u_nobody, null);
    failures := array_append(failures, 'A4: an employee without orders.create was accepted'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%FORBIDDEN%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'A4: ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;

  begin
    v_res := public.assert_order_submission_workbook_editor(
      '00000000-0000-0000-0000-0000000000ff', u_admin, 'x');
    failures := array_append(failures, 'A5: a missing submission was accepted'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%not found%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'A5: ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;


  -- ═══ B. WHILE THE PI IS STILL THE OWNER'S ══════════════════════════════
  --
  -- Nothing about the ordinary import path may have moved.

  begin
    v_res := public.assert_order_submission_workbook_editor(k_draft, u_owner, null);
    if (v_res ->> 'after_submission')::boolean = false
       and (v_res ->> 'is_admin_amendment')::boolean = false
       and v_res ->> 'reason' is null then n_pass := n_pass + 1;
    else failures := array_append(failures, 'B1: ' || v_res::text); n_fail := n_fail + 1; end if;
  exception when others then
    failures := array_append(failures, 'B1: the owner was refused their own draft -> ' || sqlerrm);
    n_fail := n_fail + 1;
  end;

  -- A colleague who holds orders.create but does not own this draft.
  begin
    v_res := public.assert_order_submission_workbook_editor(k_draft, u_other, null);
    failures := array_append(failures, 'B2: a non-owner replaced a draft'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%NOT_OWNED%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'B2: ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;

  -- An admin may act on a draft, and it is NOT an amendment: no reason is asked
  -- for, because nobody else is depending on the figures yet.
  begin
    v_res := public.assert_order_submission_workbook_editor(k_draft, u_admin, null);
    if (v_res ->> 'after_submission')::boolean = false
       and (v_res ->> 'is_admin_amendment')::boolean = false then n_pass := n_pass + 1;
    else failures := array_append(failures, 'B3: ' || v_res::text); n_fail := n_fail + 1; end if;
  exception when others then
    failures := array_append(failures, 'B3: an admin was refused a draft -> ' || sqlerrm);
    n_fail := n_fail + 1;
  end;

  update public.order_submissions set status = 'needs_changes' where id = k_draft;
  begin
    v_res := public.assert_order_submission_workbook_editor(k_draft, u_owner, null);
    if (v_res ->> 'after_submission')::boolean = false then n_pass := n_pass + 1;
    else failures := array_append(failures, 'B4: a returned PI was treated as post-submission'); n_fail := n_fail + 1; end if;
  exception when others then
    failures := array_append(failures, 'B4: the owner was refused a returned PI -> ' || sqlerrm);
    n_fail := n_fail + 1;
  end;
  update public.order_submissions set status = 'draft' where id = k_draft;


  -- ═══ C. ONCE IT HAS LEFT DRAFT — ADMIN ONLY ════════════════════════════
  --
  -- THE RULE THIS MIGRATION EXISTS FOR. Owning it is not enough, and holding
  -- orders.approve_order is not enough.

  begin
    v_res := public.assert_order_submission_workbook_editor(k_subm, u_owner, 'I made a mistake');
    failures := array_append(failures, 'C1: the OWNER replaced a submitted PI'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%NOT_EDITABLE%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'C1: ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;

  begin
    v_res := public.assert_order_submission_workbook_editor(k_subm, u_approver, 'approving it');
    failures := array_append(failures, 'C2: orders.approve_order granted workbook replacement'); n_fail := n_fail + 1;
  exception when others then
    -- FORBIDDEN would also be a refusal, but the approver holds no orders.create
    -- either, so accept whichever gate fires first; what must never happen is
    -- a pass.
    if sqlerrm like '%NOT_EDITABLE%' or sqlerrm like '%FORBIDDEN%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'C2: ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;

  -- FINANCE VERIFICATION IS NOT EDITING AUTHORITY, and it is asked here through
  -- can_verify_pi_finance() itself rather than by asserting that the predicate
  -- is absent from the workbook editor's body. The verifier is a REAL one: the
  -- permission override below is what that function resolves.
  -- BOTH halves the predicate needs: finance.approve, and the module entry
  -- (finance.view) that module_entry_open resolves. Granting only the first
  -- would make the verifier fail for the wrong reason and the refusal below
  -- would prove nothing.
  insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed)
  select u_finance, m.id, a.id, true
  from public.permission_modules m, public.permission_actions a
  where m.module_key = 'finance' and a.action_key in ('approve', 'view');

  set local role authenticated;
  perform set_config('test.uid', u_finance::text, true);
  v_bool := public.can_verify_pi_finance();
  reset role;
  if v_bool then n_pass := n_pass + 1;
  else failures := array_append(failures, 'C2b: the fixture verifier cannot verify — the test proves nothing'); n_fail := n_fail + 1; end if;

  begin
    v_res := public.assert_order_submission_workbook_editor(k_subm, u_finance, 'the figures need correcting');
    failures := array_append(failures, 'C2c: the finance verifier replaced a submitted PI'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%NOT_EDITABLE%' or sqlerrm like '%FORBIDDEN%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'C2c: ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;

  begin
    v_res := public.assert_order_submission_workbook_editor(k_subm, u_admin, null);
    failures := array_append(failures, 'C3: an admin amended without a reason'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%REASON_REQUIRED%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'C3: ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;

  begin
    v_res := public.assert_order_submission_workbook_editor(k_subm, u_admin, '     ');
    failures := array_append(failures, 'C4: whitespace passed as a reason'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%REASON_REQUIRED%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'C4: ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;

  v_long := repeat('x', 501);
  begin
    v_res := public.assert_order_submission_workbook_editor(k_subm, u_admin, v_long);
    failures := array_append(failures, 'C5: a 501-character reason was accepted'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%REASON_TOO_LONG%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'C5: ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;

  begin
    v_res := public.assert_order_submission_workbook_editor(
      k_subm, u_admin, '  Rate corrected on line 3  ');
    if (v_res ->> 'after_submission')::boolean = true
       and (v_res ->> 'is_admin_amendment')::boolean = true
       and v_res ->> 'reason' = 'Rate corrected on line 3' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'C6: ' || v_res::text); n_fail := n_fail + 1; end if;
  exception when others then
    failures := array_append(failures, 'C6: an admin was refused -> ' || sqlerrm); n_fail := n_fail + 1;
  end;

  -- An approved PI carrying an Order is the furthest stage, and the answer is
  -- the same one.
  begin
    v_res := public.assert_order_submission_workbook_editor(k_appr, u_admin, 'Wrong rate approved');
    if (v_res ->> 'after_submission')::boolean = true
       and (v_res ->> 'order_id')::uuid = o_appr then n_pass := n_pass + 1;
    else failures := array_append(failures, 'C7: ' || v_res::text); n_fail := n_fail + 1; end if;
  exception when others then
    failures := array_append(failures, 'C7: an admin was refused an approved PI -> ' || sqlerrm);
    n_fail := n_fail + 1;
  end;

  -- ── THE CONTRAST THAT PROVES NOTHING WAS WIDENED ──
  --
  -- The predicate this migration did NOT touch must still refuse the same admin
  -- on the same submitted PI. If this ever starts passing, the new rule was
  -- written into the old function instead of beside it.
  begin
    perform public.assert_order_submission_editor(k_subm, u_admin);
    failures := array_append(failures, 'C8: assert_order_submission_editor was widened'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%NOT_EDITABLE%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'C8: ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;


  -- ═══ D. A DRAFT REPLACEMENT DOES NONE OF THE AMENDMENT WORK ════════════

  v_res := public.replace_order_submission_parse(k_draft, u_owner, jsonb_build_object(
    'processing_token', t_draft::text,
    'fingerprint', 'fp-draft-1',
    'header', jsonb_build_object('client_name', 'Draft Co Revised'),
    'source', jsonb_build_object('workbook_path', 'pi/draft/v2.xlsx',
                                 'workbook_sha256', repeat('c', 64)),
    'commercial', jsonb_build_object('grand_total', '300000',
                                     'gross_product_amount', '260000'),
    'items', '[]'::jsonb, 'item_images', '[]'::jsonb));

  if (v_res ->> 'after_submission')::boolean = false
     and (v_res ->> 'finance_verification_cleared')::boolean = false
     and (v_res ->> 'superseded_documents')::int = 0 then n_pass := n_pass + 1;
  else failures := array_append(failures, 'D1: ' || v_res::text); n_fail := n_fail + 1; end if;

  select count(*) into v_int from public.order_submission_activity
   where submission_id = k_draft and action = 'workbook_replaced_by_admin';
  if v_int = 0 then n_pass := n_pass + 1;
  else failures := array_append(failures, 'D2: a draft re-upload was recorded as an amendment'); n_fail := n_fail + 1; end if;

  select count(*) into v_int from public.order_submission_activity
   where submission_id = k_draft and action = 'parse_replaced';
  if v_int = 1 then n_pass := n_pass + 1;
  else failures := array_append(failures, format('D3: %s parse_replaced entries', v_int)); n_fail := n_fail + 1; end if;


  -- ═══ E. A REPLACEMENT AFTER SUBMISSION ═════════════════════════════════

  v_res := public.replace_order_submission_parse(k_subm, u_admin, jsonb_build_object(
    'processing_token', t_subm::text,
    'fingerprint', 'fp-subm-2',
    'change_reason', 'Rate corrected on line 3',
    'header', jsonb_build_object('client_name', 'Submitted Co'),
    'source', jsonb_build_object('workbook_path', 'pi/subm/v2.xlsx',
                                 'workbook_sha256', repeat('d', 64)),
    'commercial', jsonb_build_object('grand_total', '310000',
                                     'gross_product_amount', '265000'),
    'items', '[]'::jsonb, 'item_images', '[]'::jsonb));

  if (v_res ->> 'after_submission')::boolean = true then n_pass := n_pass + 1;
  else failures := array_append(failures, 'E1: not reported as an amendment'); n_fail := n_fail + 1; end if;

  -- THE GAP THIS CLOSES. 20260915000000's trigger clears a verification only on
  -- a STATUS CHANGE, and a replacement is not one — a submitted PI stays
  -- submitted. Without the block in section 2 a finance sign-off made against
  -- the old figures would still be standing against the new ones.
  select finance_verified_at into v_ts from public.order_submissions where id = k_subm;
  if v_ts is null then n_pass := n_pass + 1;
  else failures := array_append(failures, 'E2: the finance verification survived a new workbook'); n_fail := n_fail + 1; end if;

  select finance_verified_by into v_uuid from public.order_submissions where id = k_subm;
  if v_uuid is null then n_pass := n_pass + 1;
  else failures := array_append(failures, 'E3: the verifier survived'); n_fail := n_fail + 1; end if;

  if (v_res ->> 'finance_verification_cleared')::boolean = true then n_pass := n_pass + 1;
  else failures := array_append(failures, 'E4: the clearing was not reported'); n_fail := n_fail + 1; end if;

  select count(*) into v_int from public.order_submission_activity
   where submission_id = k_subm and action = 'workbook_replaced_by_admin';
  if v_int = 1 then n_pass := n_pass + 1;
  else failures := array_append(failures, format('E5: %s amendment entries', v_int)); n_fail := n_fail + 1; end if;

  select note into v_txt from public.order_submission_activity
   where submission_id = k_subm and action = 'workbook_replaced_by_admin';
  if v_txt = 'Rate corrected on line 3' then n_pass := n_pass + 1;
  else failures := array_append(failures, 'E6: the reason was not recorded: ' || coalesce(v_txt, 'null')); n_fail := n_fail + 1; end if;

  -- The billing percentage is not part of the workbook write and must survive.
  select billing_percentage into v_num from public.order_submissions where id = k_subm;
  if v_num = 40 then n_pass := n_pass + 1;
  else failures := array_append(failures, 'E7: the billing percentage was lost'); n_fail := n_fail + 1; end if;

  -- No Order exists for this one, so nothing may have been superseded.
  if (v_res ->> 'superseded_documents')::int = 0 then n_pass := n_pass + 1;
  else failures := array_append(failures, 'E8: documents were superseded for a PI with no Order'); n_fail := n_fail + 1; end if;


  -- ═══ F. A REPLACEMENT ONCE THE ORDER EXISTS ════════════════════════════

  select count(*) into v_orders_before from public.orders;
  v_res := public.replace_order_submission_parse(k_appr, u_admin, jsonb_build_object(
    'processing_token', t_appr::text,
    'fingerprint', 'fp-appr-2',
    'change_reason', 'Fabric cost was omitted',
    'header', jsonb_build_object('client_name', 'Approved Co Ltd',
                                 'order_confirmation_date', '2026-05-02',
                                 'due_date', '2026-07-15'),
    'source', jsonb_build_object('workbook_path', 'pi/appr/v2.xlsx',
                                 'workbook_sha256', repeat('e', 64)),
    'commercial', jsonb_build_object('grand_total', '350000',
                                     'gross_product_amount', '290000'),
    'items', '[]'::jsonb, 'item_images', '[]'::jsonb));

  -- ── THE ORDER'S IDENTITY DID NOT MOVE ──
  select display_number into v_txt from public.orders where id = o_appr;
  if v_txt = '0001' then n_pass := n_pass + 1;
  else failures := array_append(failures, 'F1: the confirmed Order number changed'); n_fail := n_fail + 1; end if;

  select source_order_submission_id into v_uuid from public.orders where id = o_appr;
  if v_uuid = k_appr then n_pass := n_pass + 1;
  else failures := array_append(failures, 'F2: the PI linkage moved'); n_fail := n_fail + 1; end if;

  select status into v_txt from public.orders where id = o_appr;
  if v_txt = 'running' then n_pass := n_pass + 1;
  else failures := array_append(failures, 'F3: the Order status changed'); n_fail := n_fail + 1; end if;

  select count(*) into v_int from public.orders;
  if v_int = v_orders_before then n_pass := n_pass + 1;
  else failures := array_append(failures, 'F4: a SECOND Order was created'); n_fail := n_fail + 1; end if;

  select order_id into v_uuid from public.order_submissions where id = k_appr;
  if v_uuid = o_appr then n_pass := n_pass + 1;
  else failures := array_append(failures, 'F5: the PI stopped naming its Order'); n_fail := n_fail + 1; end if;

  -- ── THE MIRRORED VALUES FOLLOWED ──
  select client_name into v_txt from public.orders where id = o_appr;
  if v_txt = 'Approved Co Ltd' then n_pass := n_pass + 1;
  else failures := array_append(failures, 'F6: the Order still names the old client: ' || coalesce(v_txt,'null')); n_fail := n_fail + 1; end if;

  select total_value into v_num from public.orders where id = o_appr;
  if v_num = 350000 then n_pass := n_pass + 1;
  else failures := array_append(failures, format('F7: total_value is %s', v_num)); n_fail := n_fail + 1; end if;

  select total_product_value into v_num from public.orders where id = o_appr;
  if v_num = 290000 then n_pass := n_pass + 1;
  else failures := array_append(failures, format('F8: total_product_value is %s', v_num)); n_fail := n_fail + 1; end if;

  select due_date::text into v_txt from public.orders where id = o_appr;
  if v_txt = '2026-07-15' then n_pass := n_pass + 1;
  else failures := array_append(failures, 'F9: the due date did not follow: ' || coalesce(v_txt,'null')); n_fail := n_fail + 1; end if;

  select confirm_date::text into v_txt from public.orders where id = o_appr;
  if v_txt = '2026-05-02' then n_pass := n_pass + 1;
  else failures := array_append(failures, 'F10: the confirm date did not follow'); n_fail := n_fail + 1; end if;

  -- ── THE READY DOCUMENTS ARE NO LONGER CURRENT, AND STILL EXIST ──
  select superseded_at, superseded_reason, excel_path
    into v_ts, v_txt, v_long
  from public.order_document_versions where id = d_ver;
  if v_ts is not null then n_pass := n_pass + 1;
  else failures := array_append(failures, 'F11: the ready documents were left current'); n_fail := n_fail + 1; end if;
  if v_txt = 'pi_data_amended' then n_pass := n_pass + 1;
  else failures := array_append(failures, 'F12: reason ' || coalesce(v_txt,'null')); n_fail := n_fail + 1; end if;
  if v_long = public.order_document_version_prefix(o_appr, 1) || '/order.xlsx' then n_pass := n_pass + 1;
  else failures := array_append(failures, 'F13: the generated file was rewritten or removed'); n_fail := n_fail + 1; end if;

  select status into v_txt from public.order_document_versions where id = d_ver;
  if v_txt = 'ready' then n_pass := n_pass + 1;
  else failures := array_append(failures, 'F14: a superseded version stopped being ready'); n_fail := n_fail + 1; end if;

  if (v_res ->> 'superseded_documents')::int = 1 then n_pass := n_pass + 1;
  else failures := array_append(failures, 'F15: the impact was misreported'); n_fail := n_fail + 1; end if;

  -- ── BOTH HISTORIES RECORD IT ──
  select count(*) into v_int from public.order_activity_log
   where order_id = o_appr and event_type = 'order_workbook_replaced';
  if v_int = 1 then n_pass := n_pass + 1;
  else failures := array_append(failures, format('F16: %s Order events', v_int)); n_fail := n_fail + 1; end if;

  select payload ->> 'reason' into v_txt from public.order_activity_log
   where order_id = o_appr and event_type = 'order_workbook_replaced';
  if v_txt = 'Fabric cost was omitted' then n_pass := n_pass + 1;
  else failures := array_append(failures, 'F17: the Order history lost the reason'); n_fail := n_fail + 1; end if;

  select count(*) into v_int from public.order_submission_activity
   where submission_id = k_appr and action = 'workbook_replaced_by_admin';
  if v_int = 1 then n_pass := n_pass + 1;
  else failures := array_append(failures, 'F18: the PI history lost the amendment'); n_fail := n_fail + 1; end if;


  -- ═══ G. WHAT A REPLACEMENT MUST NOT DO ═════════════════════════════════

  -- A REPLAY IS NOT AN AMENDMENT. Same fingerprint, same file: pressing Retry
  -- after a timeout must not supersede a second time, clear anything, or write
  -- a second entry.
  update public.order_submissions
     set finance_verified_by = u_approver, finance_verified_at = now()
   where id = k_appr;

  v_res := public.replace_order_submission_parse(k_appr, u_admin, jsonb_build_object(
    'processing_token', t_appr::text,
    'fingerprint', 'fp-appr-2',
    'change_reason', 'Fabric cost was omitted',
    'header', jsonb_build_object('client_name', 'Approved Co Ltd'),
    'source', jsonb_build_object('workbook_path', 'pi/appr/v2.xlsx'),
    'commercial', jsonb_build_object('grand_total', '350000'),
    'items', '[]'::jsonb, 'item_images', '[]'::jsonb));

  if (v_res ->> 'unchanged')::boolean = true then n_pass := n_pass + 1;
  else failures := array_append(failures, 'G1: a replay was not recognised'); n_fail := n_fail + 1; end if;

  select finance_verified_at into v_ts from public.order_submissions where id = k_appr;
  if v_ts is not null then n_pass := n_pass + 1;
  else failures := array_append(failures, 'G2: a replay cleared a verification'); n_fail := n_fail + 1; end if;

  select count(*) into v_int from public.order_submission_activity
   where submission_id = k_appr and action = 'workbook_replaced_by_admin';
  if v_int = 1 then n_pass := n_pass + 1;
  else failures := array_append(failures, format('G3: a replay logged again (%s)', v_int)); n_fail := n_fail + 1; end if;

  -- THE LEASE STILL GOVERNS. An admin reason is not a way past it.
  begin
    v_res := public.replace_order_submission_parse(k_subm, u_admin, jsonb_build_object(
      'processing_token', '99999999-9999-9999-9999-999999999999',
      'change_reason', 'trying it on',
      'header', '{}'::jsonb, 'source', '{}'::jsonb, 'commercial', '{}'::jsonb,
      'items', '[]'::jsonb, 'item_images', '[]'::jsonb));
    failures := array_append(failures, 'G4: a replacement ran without the lease'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%PROCESSING_NOT_HELD%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'G4: ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;

  -- No payment or allocation may have been touched by any of the above. The
  -- fixture deliberately carries ONE, so "nothing appeared" and "nothing was
  -- removed" are both real claims here rather than a count of zero that would
  -- pass however the money was handled. Section K then reads the row itself.
  select count(*) into v_int from public.finance_payment_allocations;
  if v_int = 1 then n_pass := n_pass + 1;
  else failures := array_append(failures, format('G5: %s allocations exist, expected the one the fixture made', v_int)); n_fail := n_fail + 1; end if;


  -- ═══ H. THE LEASE IS THE GATE BEFORE THE GATE ══════════════════════════
  --
  -- begin_order_submission_processing asked the OLD predicate, so an admin
  -- correcting a submitted PI would have been refused a lease and never reached
  -- the replacement at all. These prove the lease now agrees with it — and that
  -- it did not become a way past it.

  update public.order_submissions set processing_token = null, processing_started_at = null
   where id in (k_subm, k_appr, k_draft);

  begin
    v_res := public.begin_order_submission_processing(k_subm, u_owner, gen_random_uuid());
    failures := array_append(failures, 'H1: the owner took a lease on a submitted PI'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%NOT_EDITABLE%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'H1: ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;

  -- The admin gets one WITHOUT a reason: a lease grants nothing on its own, and
  -- the replacement asks again with the reason required.
  begin
    v_res := public.begin_order_submission_processing(k_subm, u_admin, t_subm);
    if (v_res ->> 'acquired')::boolean then n_pass := n_pass + 1;
    else failures := array_append(failures, 'H2: ' || v_res::text); n_fail := n_fail + 1; end if;
  exception when others then
    failures := array_append(failures, 'H2: an admin was refused a lease -> ' || sqlerrm); n_fail := n_fail + 1;
  end;

  -- Holding the lease is still not permission to replace without a reason.
  begin
    v_res := public.replace_order_submission_parse(k_subm, u_admin, jsonb_build_object(
      'processing_token', t_subm::text,
      'header', '{}'::jsonb, 'source', '{}'::jsonb, 'commercial', '{}'::jsonb,
      'items', '[]'::jsonb, 'item_images', '[]'::jsonb));
    failures := array_append(failures, 'H3: the lease was accepted in place of a reason'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%REASON_REQUIRED%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'H3: ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;

  -- And the busy signal still works, unchanged.
  begin
    v_res := public.begin_order_submission_processing(k_subm, u_admin, gen_random_uuid());
    failures := array_append(failures, 'H4: a second lease was granted'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%PROCESSING_BUSY%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'H4: ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;

  -- The owner still takes one on their own draft: the ordinary import path is
  -- untouched.
  begin
    v_res := public.begin_order_submission_processing(k_draft, u_owner, t_draft);
    if (v_res ->> 'acquired')::boolean then n_pass := n_pass + 1;
    else failures := array_append(failures, 'H5: ' || v_res::text); n_fail := n_fail + 1; end if;
  exception when others then
    failures := array_append(failures, 'H5: the owner lost their own draft -> ' || sqlerrm); n_fail := n_fail + 1;
  end;

  -- A colleague who does not own the draft still cannot.
  begin
    update public.order_submissions set processing_token = null where id = k_draft;
    v_res := public.begin_order_submission_processing(k_draft, u_other, gen_random_uuid());
    failures := array_append(failures, 'H6: a non-owner took a lease on a draft'); n_fail := n_fail + 1;
  exception when others then
    if sqlerrm like '%NOT_OWNED%' then n_pass := n_pass + 1;
    else failures := array_append(failures, 'H6: ' || sqlerrm); n_fail := n_fail + 1; end if;
  end;


  -- ═══ J. AN APPROVED EXCEPTION GOES STALE BY ITSELF ═════════════════════
  --
  -- 20261003000000 writes NO invalidation for the reduced-payment exception,
  -- and that omission is the design rather than a gap:
  -- order_submission_exception_current() DERIVES currency by comparing the
  -- decision's recorded basis against the live grand total, workbook hash and
  -- both terms. A replacement moves all of them, so the decision stops being
  -- current on its own — and a second stored answer would be a second thing to
  -- keep in step with the first.
  --
  -- Asked through the REAL function, verbatim from 20260921000000, so this is a
  -- claim about what runs rather than about a re-implementation.

  update public.order_submissions
     set advance_exception_status                   = 'approved',
         advance_exception_decided_grand_total      = grand_total,
         advance_exception_decided_workbook_sha256  = source_workbook_sha256,
         advance_exception_decided_payment_terms    = payment_terms,
         advance_exception_decided_billing_terms    = billing_terms
   where id = k_exc;

  select public.order_submission_exception_current(
           advance_exception_status,
           advance_exception_decided_grand_total, grand_total,
           advance_exception_decided_workbook_sha256, source_workbook_sha256,
           advance_exception_decided_payment_terms, payment_terms,
           advance_exception_decided_billing_terms, billing_terms)
    into v_bool
  from public.order_submissions where id = k_exc;
  if v_bool then n_pass := n_pass + 1;
  else failures := array_append(failures, 'J1: the exception was not current to begin with — the test proves nothing'); n_fail := n_fail + 1; end if;

  v_res := public.replace_order_submission_parse(k_exc, u_admin, jsonb_build_object(
    'processing_token', t_exc::text,
    'fingerprint', 'fp-exc-2',
    'change_reason', 'Rate corrected after the exception was approved',
    'header', jsonb_build_object('client_name', 'Exception Co'),
    'source', jsonb_build_object('workbook_path', 'pi/exc/v2.xlsx',
                                 'workbook_sha256', repeat('f', 64)),
    'commercial', jsonb_build_object('grand_total', '420000'),
    'items', '[]'::jsonb, 'item_images', '[]'::jsonb));

  select public.order_submission_exception_current(
           advance_exception_status,
           advance_exception_decided_grand_total, grand_total,
           advance_exception_decided_workbook_sha256, source_workbook_sha256,
           advance_exception_decided_payment_terms, payment_terms,
           advance_exception_decided_billing_terms, billing_terms)
    into v_bool
  from public.order_submissions where id = k_exc;
  if not v_bool then n_pass := n_pass + 1;
  else failures := array_append(failures, 'J2: the exception is STILL current after the workbook moved'); n_fail := n_fail + 1; end if;

  -- The decision itself is untouched: it is history, and it still says what was
  -- approved and on what basis. What changed is that the basis is no longer the
  -- PI's.
  select advance_exception_status into v_txt from public.order_submissions where id = k_exc;
  if v_txt = 'approved' then n_pass := n_pass + 1;
  else failures := array_append(failures, 'J3: the decision was rewritten'); n_fail := n_fail + 1; end if;

  select advance_exception_decided_grand_total into v_num from public.order_submissions where id = k_exc;
  if v_num = 295000 then n_pass := n_pass + 1;
  else failures := array_append(failures, format('J4: the recorded basis moved to %s', v_num)); n_fail := n_fail + 1; end if;

  -- 20260917000000's trigger, still doing its own job: a declared advance
  -- cannot survive the total it was measured against.
  select advance_declared_amount into v_num from public.order_submissions where id = k_exc;
  if v_num is null then n_pass := n_pass + 1;
  else failures := array_append(failures, 'J5: a declared advance survived a new grand total'); n_fail := n_fail + 1; end if;


  -- ═══ K. THE MONEY IS NOT TOUCHED ═══════════════════════════════════════
  --
  -- An allocation is the record of where a payment went. A replacement may move
  -- what the Order is WORTH; it may not move one rupee of what has been paid,
  -- nor re-point an allocation, nor create a second one.

  select count(*), coalesce(sum(allocated_amount), 0)
    into v_int, v_num
  from public.finance_payment_allocations where order_id = o_appr and status = 'active';
  if v_int = 1 and v_num = 120000 then n_pass := n_pass + 1;
  else failures := array_append(failures, format('K1: %s active allocations totalling %s', v_int, v_num)); n_fail := n_fail + 1; end if;

  select id, allocated_amount, status, order_submission_id
    into v_uuid, v_num, v_txt, v_uuid2
  from public.finance_payment_allocations where id = a_appr;
  if v_uuid = a_appr and v_num = 120000 and v_txt = 'active' and v_uuid2 is null
  then n_pass := n_pass + 1;
  else failures := array_append(failures, 'K2: the allocation row was rewritten'); n_fail := n_fail + 1; end if;

  select count(*) into v_int from public.finance_payment_allocations;
  if v_int = 1 then n_pass := n_pass + 1;
  else failures := array_append(failures, format('K3: %s allocation rows exist', v_int)); n_fail := n_fail + 1; end if;


  -- ═══ L. EVERY DECLARED ACTION IS ACCEPTED ══════════════════════════════
  --
  -- 20261001000000 restates a CLOSED constraint. Its own self-check reads the
  -- constraint's TEXT and writes one probe row; this writes all twenty-four,
  -- because a constraint that reads correctly and refuses in practice is the
  -- exact failure that migration exists to close — 20260923000000 is applied to
  -- production and logs an action it never declared.

  v_int := 0;
  foreach v_txt in array array[
    'submission_created', 'parse_replaced', 'submitted', 'changes_requested',
    'rejected', 'advance_exception_requested', 'advance_exception_approved',
    'advance_exception_rejected', 'finance_verified', 'approved',
    'payment_recorded', 'payment_allocations_moved',
    'billing_percentage_set', 'billing_percentage_amended_by_admin',
    'client_details_updated', 'client_details_amended_by_admin',
    'schedule_terms_updated', 'schedule_terms_amended_by_admin',
    'correction_requested', 'correction_resolved', 'correction_rejected',
    'product_details_updated', 'product_details_amended_by_admin',
    'workbook_replaced_by_admin'
  ] loop
    begin
      insert into public.order_submission_activity (submission_id, action)
      values (k_draft, v_txt);
      v_int := v_int + 1;
    exception when others then
      failures := array_append(failures, format('L1: %s was REFUSED: %s', v_txt, sqlerrm));
      n_fail := n_fail + 1;
    end;
  end loop;
  if v_int = 24 then n_pass := n_pass + 1;
  else failures := array_append(failures, format('L2: %s of 24 actions accepted', v_int)); n_fail := n_fail + 1; end if;

  -- AND THE SET IS STILL CLOSED. A constraint that accepted everything would
  -- pass the loop above and prove nothing.
  begin
    insert into public.order_submission_activity (submission_id, action)
    values (k_draft, 'something_nobody_declared');
    failures := array_append(failures, 'L3: the action set is not closed'); n_fail := n_fail + 1;
  exception when others then
    n_pass := n_pass + 1;
  end;

  delete from public.order_submission_activity
   where submission_id = k_draft and action <> 'parse_replaced';


  -- ═══ M. THE BILLING PERCENTAGE RECORDS WHAT IT DID ═════════════════════
  --
  -- The defect this closes was invisible in production: the authority bug
  -- refused the write before it could reach the logging bug behind it. Fixing
  -- the authority alone would have exposed a CHECK violation to the next person
  -- who pressed Save. Both halves are exercised here, in that order.

  set local role authenticated;
  perform set_config('test.uid', u_admin::text, true);
  begin
    v_res := public.set_order_submission_billing_percentage(
      k_appr, 55, 'Corrected after approval');
    if (v_res ->> 'changed')::boolean then n_pass := n_pass + 1;
    else failures := array_append(failures, 'M1: ' || v_res::text); n_fail := n_fail + 1; end if;
  exception when others then
    failures := array_append(failures, 'M1: the billing write failed -> ' || sqlerrm);
    n_fail := n_fail + 1;
  end;
  reset role;

  select count(*) into v_int from public.order_submission_activity
   where submission_id = k_appr and action = 'billing_percentage_amended_by_admin';
  if v_int = 1 then n_pass := n_pass + 1;
  else failures := array_append(failures, format('M2: %s activity rows recorded', v_int)); n_fail := n_fail + 1; end if;

  select billing_percentage into v_num from public.orders where id = o_appr;
  if v_num = 55 then n_pass := n_pass + 1;
  else failures := array_append(failures, format('M3: the Order says %s', v_num)); n_fail := n_fail + 1; end if;


  -- ═══ I. PRIVILEGES ═════════════════════════════════════════════════════

  if not has_function_privilege('authenticated',
       'public.assert_order_submission_workbook_editor(uuid, uuid, text, boolean)', 'execute')
  then n_pass := n_pass + 1;
  else failures := array_append(failures, 'I1: a browser role can call the workbook editor'); n_fail := n_fail + 1; end if;

  if not has_function_privilege('authenticated',
       'public.replace_order_submission_parse(uuid, uuid, jsonb)', 'execute')
  then n_pass := n_pass + 1;
  else failures := array_append(failures, 'I2: a browser role can replace a parse'); n_fail := n_fail + 1; end if;

  if has_function_privilege('service_role',
       'public.replace_order_submission_parse(uuid, uuid, jsonb)', 'execute')
  then n_pass := n_pass + 1;
  else failures := array_append(failures, 'I3: the import worker lost its grant'); n_fail := n_fail + 1; end if;

  if not has_function_privilege('authenticated',
       'public.begin_order_submission_processing(uuid, uuid, uuid)', 'execute')
  then n_pass := n_pass + 1;
  else failures := array_append(failures, 'I4: a browser role can take a lease'); n_fail := n_fail + 1; end if;

  select prosecdef into v_bool from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'assert_order_submission_workbook_editor';
  if v_bool then n_pass := n_pass + 1;
  else failures := array_append(failures, 'I5: the workbook editor is not SECURITY DEFINER'); n_fail := n_fail + 1; end if;


  if n_fail = 0 then
    raise notice 'ALL ASSERTIONS PASSED (% checks)', n_pass;
  else
    foreach v_report in array failures loop raise notice 'FAIL  %', v_report; end loop;
    raise exception '% passed, % FAILED', n_pass, n_fail;
  end if;
end $$;

rollback;
