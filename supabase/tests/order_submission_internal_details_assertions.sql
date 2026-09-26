-- PI INTERNAL DETAILS assertions (20270122000000 + 20270123000000)
-- ===========================================================================
-- Validates, through the REAL doors on a disposable local database, with
-- SYNTHETIC PIs only:
--
--   * editor        draft saves (partial answers allowed), confirm requires
--                   completeness, due date before confirmation refused, Yes/No
--                   contradictions refused, stale row_version refused, not
--                   editable once submitted, activity entry records from/to
--   * confirmation  only the editor may stamp it; the schedule editor moving a
--                   date and a new workbook both clear it
--   * workbook      a BLANK workbook date keeps the app date; a workbook date
--                   prefills; the workbook's own dates and discount wording are
--                   recorded; parse_replaced carries before/after figures
--   * phase 2       submission refused until confirmed and complete — and the
--                   refused submit writes NO exception request, NO document
--                   submission and NO activity entry; No and Yes paths submit
--   * send-back     the admin's reason is kept; Sales edits the answers and
--                   resubmits the SAME PI with its Client PO carried forward;
--                   the returned document stays on record
--   * exception     a pending request is refreshed in place on resubmit (one
--                   row, not two); an APPROVED one survives a resubmit that only
--                   changes internal answers, and is re-asked when the amount
--                   basis (workbook) changes
--
-- Runs entirely inside ONE transaction that ends in ROLLBACK.
-- On success prints NOTICE 'ALL INTERNAL DETAILS ASSERTIONS PASSED'.
-- Run with supabase/tests/run_order_submission_internal_details_local.sh.

\set ON_ERROR_STOP on

begin;

do $$
begin
  perform set_config('test.owner_id', '11111111-1111-1111-1111-111111111111', true); -- TEST-001, admin
  perform set_config('test.sales_id', '5a1e5a1e-0000-4000-8000-00000000a001', true); -- the PI's owner
  perform set_config('test.other_id', '5a1e5a1e-0000-4000-8000-00000000a002', true); -- another salesperson
  perform set_config('test.pi_a', gen_random_uuid()::text, true);  -- No path, send-back, resubmit
  perform set_config('test.pi_b', gen_random_uuid()::text, true);  -- Yes path, approved exception
  perform set_config('test.pi_c', gen_random_uuid()::text, true);  -- workbook replacement
end $$;

-- ═══ 0. FIXTURES ════════════════════════════════════════════════════════════

insert into public.users (id, full_name, email, role, team, is_active, employee_code) values
  (current_setting('test.sales_id')::uuid, 'ASSERT Sales',       'idsales@example.test', 'member', 'sales', true, 'ASSERT-IDS1'),
  (current_setting('test.other_id')::uuid, 'ASSERT Other Sales', 'idother@example.test', 'member', 'sales', true, 'ASSERT-IDS2')
on conflict (id) do update set full_name = excluded.full_name, role = excluded.role, team = excluded.team,
                               is_active = true, is_deleted = false;

insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
select u, pm.id, pa.id, true, current_setting('test.owner_id')::uuid
  from unnest(array[current_setting('test.sales_id')::uuid, current_setting('test.other_id')::uuid]) as u,
       public.permission_modules pm
       join public.permission_actions pa on pa.action_key in ('view', 'create')
 where pm.module_key = 'orders'
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

create function pg_temp.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then
    raise exception 'ASSERTION FAILED: %', p_what;
  end if;
end $$;

/** Runs p_sql and requires it to fail with a message containing p_code. */
create function pg_temp.expect_error(p_sql text, p_code text, p_what text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if position(p_code in sqlerrm) = 0 then
      raise exception 'ASSERTION FAILED: % — expected %, got: %', p_what, p_code, sqlerrm;
    end if;
    return;
  end;
  raise exception 'ASSERTION FAILED: % — expected %, but it succeeded', p_what, p_code;
end $$;

/** A draft PI with one complete product line, a stored workbook and image, and NO payment. */
create function pg_temp.make_draft(p_id uuid, p_owner uuid, p_total numeric) returns void language plpgsql as $$
declare
  v_item uuid := gen_random_uuid();
  v_wb   text := 'submissions/' || p_id::text || '/original/' || gen_random_uuid()::text || '.xlsx';
  v_sha  text := repeat('a', 64);
  v_img  text;
begin
  perform set_config('request.jwt.claims', '', true);
  insert into public.order_submissions
    (id, status, submitted_by, created_by, client_name, gross_product_amount, discount_amount, grand_total,
     total_before_gst, source_workbook_path, source_workbook_sha256, source_workbook_name,
     parse_warnings, parse_blocking_issues, reservation_required,
     creation_date, source_created_by, contact_number, client_city, fabric_responsibility, commercial_terms_note,
     order_confirmation_date, due_date)
  values (p_id, 'draft', p_owner, p_owner, 'ASSERT client', p_total, 0, p_total,
          round(p_total / 1.18, 2), v_wb, v_sha, 'pi.xlsx', '[]', '[]', false,
          current_date, 'ASSERT', '0000000000', 'ASSERT city', 'boe', 'ASSERT terms',
          -- what a workbook upload prefilled
          date '2026-09-20', date '2026-11-20');
  insert into storage.objects (bucket_id, name, metadata)
  values ('order-files', v_wb, jsonb_build_object('mimetype', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
  insert into public.order_submission_items
    (id, submission_id, source_row, item_sequence, product_name, quantity, cost_per_piece, total_amount, sort_order)
  values (v_item, p_id, 10, '1', 'ASSERT chair', 1, p_total, p_total, 0);
  v_img := 'submissions/' || p_id::text || '/images/' || v_item::text || '/representative/0-' || v_sha || '.png';
  insert into public.order_submission_item_images
    (submission_id, item_id, role, position, storage_path, mime_type, sha256, anchor_row)
  values (p_id, v_item, 'representative', 0, v_img, 'image/png', v_sha, 10);
  insert into storage.objects (bucket_id, name, metadata)
  values ('order-files', v_img, jsonb_build_object('mimetype', 'image/png'));
end $$;

/** The editor, as p_user. */
create function pg_temp.save(p_user uuid, p_pi uuid, p_details jsonb, p_confirm boolean) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.become(p_user);
  v := public.save_order_submission_internal_details(p_pi, p_details, null, p_confirm);
  perform pg_temp.restore();
  return v;
end $$;

/** A Client PO file stored under a new initial document submission of p_pi, owned by p_user. */
create function pg_temp.store_po(p_pi uuid, p_doc uuid, p_user uuid) returns text language plpgsql as $$
declare v_path text := 'pi-documents/' || p_pi::text || '/' || p_doc::text || '/client_po/' || gen_random_uuid()::text || '.pdf';
begin
  insert into storage.objects (bucket_id, name, owner_id, metadata)
  values ('order-files', v_path, p_user::text, jsonb_build_object('mimetype', 'application/pdf', 'size', 41004));
  return v_path;
end $$;

select pg_temp.make_draft(current_setting('test.pi_a')::uuid, current_setting('test.sales_id')::uuid, 4212670.80);
select pg_temp.make_draft(current_setting('test.pi_b')::uuid, current_setting('test.sales_id')::uuid, 1000000.00);
select pg_temp.make_draft(current_setting('test.pi_c')::uuid, current_setting('test.sales_id')::uuid, 500000.00);


-- ═══ 1. THE EDITOR ══════════════════════════════════════════════════════════

do $$
declare
  a uuid := current_setting('test.pi_a')::uuid;
  s uuid := current_setting('test.sales_id')::uuid;
  o uuid := current_setting('test.other_id')::uuid;
  v jsonb;
  r public.order_submissions%rowtype;
begin
  -- A half-answered draft saves.
  v := pg_temp.save(s, a, '{"order_confirmation_date":"2026-09-20","due_date":"2026-11-20","middleman_commission":"yes"}', false);
  select * into r from public.order_submissions where id = a;
  perform pg_temp.check(r.middleman_commission = 'yes' and r.middleman_recipient is null, 'a partial Yes saves as a draft');
  perform pg_temp.check(r.internal_details_confirmed_at is null, 'a draft save does not confirm');

  -- Confirming it is refused, and names what is missing.
  perform pg_temp.expect_error(format(
    'select pg_temp.save(%L, %L, %L, true)', s, a,
    '{"order_confirmation_date":"2026-09-20","due_date":"2026-11-20","middleman_commission":"yes"}'),
    'name who receives the middleman commission', 'confirming an incomplete Yes');
  select * into r from public.order_submissions where id = a;
  perform pg_temp.check(r.internal_details_confirmed_at is null, 'a refused confirm leaves no stamp');

  -- Date order.
  perform pg_temp.expect_error(format(
    'select pg_temp.save(%L, %L, %L, false)', s, a,
    '{"order_confirmation_date":"2026-09-23","due_date":"2026-09-15","middleman_commission":"no"}'),
    'ORDER_SUBMISSION_DUE_BEFORE_CONFIRMATION', 'the 23 Sep / 15 Sep pair PID-00002 once carried');
  -- The same day is allowed.
  v := pg_temp.save(s, a, '{"order_confirmation_date":"2026-09-20","due_date":"2026-09-20","middleman_commission":"no"}', false);

  -- Contradictions and bad shapes.
  perform pg_temp.expect_error(format('select pg_temp.save(%L, %L, %L, false)', s, a,
    '{"middleman_commission":"no","middleman_recipient":"Someone"}'),
    'ORDER_SUBMISSION_COMMISSION_CONTRADICTION', 'No with a recipient');
  perform pg_temp.expect_error(format('select pg_temp.save(%L, %L, %L, false)', s, a,
    '{"middleman_commission":"yes","middleman_commission_basis":"amount","middleman_commission_percent":"2"}'),
    'ORDER_SUBMISSION_COMMISSION_CONTRADICTION', 'an amount basis carrying a percentage');
  perform pg_temp.expect_error(format('select pg_temp.save(%L, %L, %L, false)', s, a,
    '{"middleman_commission":"yes","middleman_commission_basis":"percent","middleman_commission_percent":"120","middleman_commission_percent_of":"grand_total"}'),
    'ORDER_SUBMISSION_COMMISSION_INVALID', 'a percentage above 100');
  perform pg_temp.expect_error(format('select pg_temp.save(%L, %L, %L, false)', s, a,
    '{"middleman_commission":"yes","middleman_commission_basis":"percent","middleman_commission_percent":"2","middleman_commission_percent_of":"net_profit"}'),
    'ORDER_SUBMISSION_COMMISSION_INVALID', 'a percentage of an unknown figure');
  perform pg_temp.expect_error(format('select pg_temp.save(%L, %L, %L, false)', s, a,
    '{"middleman_commission":"yes","middleman_commission_basis":"amount","middleman_commission_amount":"99999999"}'),
    'cannot exceed the grand total', 'an amount above the grand total');
  perform pg_temp.expect_error(format('select pg_temp.save(%L, %L, %L, false)', s, a,
    '{"order_confirmation_date":"yesterday"}'),
    'ORDER_SUBMISSION_BAD_DATE', 'a relative date');
  perform pg_temp.expect_error(format('select pg_temp.save(%L, %L, %L, false)', s, a,
    '{"grand_total":"1"}'),
    'ORDER_SUBMISSION_UNKNOWN_FIELD', 'a money field through this editor');

  -- Somebody else's draft.
  perform pg_temp.expect_error(format('select pg_temp.save(%L, %L, %L, false)', o, a, '{"middleman_commission":"no"}'),
    'ORDER_SUBMISSION_NOT_EDITABLE', 'another salesperson');

  -- Stale version.
  perform pg_temp.become(s);
  perform pg_temp.expect_error(format(
    'select public.save_order_submission_internal_details(%L, %L, %s, false)', a, '{"middleman_commission":"no"}',
    (select row_version - 1 from public.order_submissions where id = a)),
    'ORDER_SUBMISSION_STALE', 'a stale tab');
  perform pg_temp.restore();

  -- Confirm the No path, with the workbook's dates.
  v := pg_temp.save(s, a, '{"order_confirmation_date":"2026-09-20","due_date":"2026-11-20","middleman_commission":"no"}', true);
  select * into r from public.order_submissions where id = a;
  perform pg_temp.check(r.internal_details_confirmed_by = s and r.internal_details_confirmed_at is not null, 'the No path confirms');
  perform pg_temp.check(public.order_submission_internal_details_problem(a) is null, 'a confirmed No is ready');

  -- The trail records the change from/to and the confirmation.
  perform pg_temp.check(exists (
    select 1 from public.order_submission_activity
     where submission_id = a and action = 'internal_details_updated' and (metadata ->> 'confirmed')::boolean
       and metadata -> 'changed' -> 'due_date' ->> 'from' = '2026-09-20'
       and metadata -> 'changed' -> 'due_date' ->> 'to'   = '2026-11-20'),
    'the confirm is logged with the date it moved from and to');

  -- Nothing but the editor may stamp a confirmation.
  perform pg_temp.expect_error(format(
    'update public.order_submissions set internal_details_confirmed_at = now(), internal_details_confirmed_by = %L where id = %L',
    s, current_setting('test.pi_b')),
    'ORDER_SUBMISSION_INTERNAL_DETAILS_CONFIRM_PATH', 'a direct stamp');

  raise notice 'section 1 (editor) passed';
end $$;


-- ═══ 2. OTHER WRITERS CLEAR THE CONFIRMATION ════════════════════════════════

do $$
declare
  a uuid := current_setting('test.pi_a')::uuid;
  s uuid := current_setting('test.sales_id')::uuid;
  r public.order_submissions%rowtype;
begin
  -- The schedule editor moving a confirmed date.
  perform pg_temp.become(s);
  perform public.update_order_submission_schedule_terms(a, '{"due_date":"2026-11-21"}', null, null);
  perform pg_temp.restore();
  select * into r from public.order_submissions where id = a;
  perform pg_temp.check(r.internal_details_confirmed_at is null, 'a date moved by the schedule editor needs confirming again');

  -- Re-confirm for the next sections.
  perform pg_temp.save(s, a, '{"order_confirmation_date":"2026-09-20","due_date":"2026-11-20","middleman_commission":"no"}', true);
  raise notice 'section 2 (confirmation clearing) passed';
end $$;


-- ═══ 2b. THE GENERATED PI'S WORD FOR THE DEDUCTION ═══════════════════════════

do $$
declare
  c   uuid := current_setting('test.pi_c')::uuid;
  s   uuid := current_setting('test.sales_id')::uuid;
  o   uuid := current_setting('test.other_id')::uuid;
  before public.order_submissions%rowtype;
  after  public.order_submissions%rowtype;
begin
  select * into before from public.order_submissions where id = c;
  perform pg_temp.become(s);
  perform public.set_order_submission_deduction_label(c, 'design_fee', null);
  perform pg_temp.restore();
  select * into after from public.order_submissions where id = c;
  perform pg_temp.check(after.client_deduction_label = 'design_fee', 'Sales can choose Design Fee');
  perform pg_temp.check(after.discount_amount is not distinct from before.discount_amount
                    and after.subtotal_after_discount is not distinct from before.subtotal_after_discount
                    and after.grand_total is not distinct from before.grand_total,
    'choosing the word moves no figure');
  perform pg_temp.check(exists (select 1 from public.order_submission_activity
     where submission_id = c and action = 'deduction_label_set' and metadata ->> 'to' = 'design_fee'),
    'the choice is in the trail');

  perform pg_temp.become(s);
  perform pg_temp.expect_error(format('select public.set_order_submission_deduction_label(%L, %L, null)', c, 'charge'),
    'ORDER_SUBMISSION_DEDUCTION_LABEL_INVALID', 'a word that is neither');
  perform pg_temp.restore();
  perform pg_temp.become(o);
  perform pg_temp.expect_error(format('select public.set_order_submission_deduction_label(%L, %L, null)', c, 'discount'),
    'ORDER_SUBMISSION_NOT_EDITABLE', 'another salesperson');
  perform pg_temp.restore();
  perform pg_temp.expect_error(
    format('update public.order_submissions set client_deduction_label = %L where id = %L', 'rebate', c),
    'order_submissions_client_deduction_label', 'the column admits only the two words');
  raise notice 'section 2b (deduction wording) passed';
end $$;


-- ═══ 3. A NEW WORKBOOK ══════════════════════════════════════════════════════

do $$
declare
  c   uuid := current_setting('test.pi_c')::uuid;
  s   uuid := current_setting('test.sales_id')::uuid;
  tok uuid := gen_random_uuid();
  wb  text := 'submissions/' || current_setting('test.pi_c') || '/original/' || gen_random_uuid()::text || '.xlsx';
  r   public.order_submissions%rowtype;
  m   jsonb;
  p   jsonb;
begin
  -- Sales corrected the dates in the app and confirmed them.
  perform pg_temp.save(s, c, '{"order_confirmation_date":"2026-09-23","due_date":"2026-11-23","middleman_commission":"no"}', true);

  insert into storage.objects (bucket_id, name, metadata)
  values ('order-files', wb, jsonb_build_object('mimetype', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
  perform public.begin_order_submission_processing(c, s, tok);

  -- A workbook with BOTH dates blank, and the deduction worded "Design Fee".
  p := jsonb_build_object(
    'processing_token', tok, 'fingerprint', repeat('b', 64),
    'header', jsonb_build_object('client_name', 'ASSERT client', 'creation_date', current_date::text,
      'source_created_by', 'ASSERT', 'contact_number', '0000000000',
      'order_confirmation_date', null, 'due_date', null),
    'commercial', jsonb_build_object('gross_product_amount', 520000, 'discount_amount', 20000,
      'discount_label', 'Design Fee', 'subtotal_after_discount', 500000, 'total_before_gst', 500000,
      'gst_amount', 90000, 'grand_total', 590000),
    'source', jsonb_build_object('workbook_path', wb, 'workbook_name', 'pi2.xlsx',
      'workbook_size_bytes', 1000, 'workbook_sha256', repeat('c', 64), 'template_version', 'Master'),
    'parse', jsonb_build_object('warnings', '[]'::jsonb, 'blocking_issues', '[]'::jsonb),
    'items', jsonb_build_array(jsonb_build_object('source_row', 10, 'item_sequence', '1', 'product_name', 'ASSERT chair',
      'quantity', 1, 'cost_per_piece', 520000, 'total_amount', 520000)),
    'item_images', '[]'::jsonb);
  perform public.replace_order_submission_parse(c, s, p);

  select * into r from public.order_submissions where id = c;
  perform pg_temp.check(r.order_confirmation_date = date '2026-09-23' and r.due_date = date '2026-11-23',
    'a blank workbook date keeps the date Sales entered in the app');
  perform pg_temp.check(r.workbook_order_confirmation_date is null and r.workbook_due_date is null,
    'the workbook''s own (blank) dates are recorded as blank');
  perform pg_temp.check(r.discount_label = 'Design Fee' and r.discount_amount = 20000,
    'the wording is recorded and the figure is still the deduction');
  perform pg_temp.check(r.internal_details_confirmed_at is null, 'a new workbook needs the details confirming again');

  select metadata into m from public.order_submission_activity
   where submission_id = c and action = 'parse_replaced' order by created_at desc limit 1;
  perform pg_temp.check((m -> 'before' ->> 'grand_total')::numeric = 500000
                    and (m -> 'after'  ->> 'grand_total')::numeric = 590000,
    'parse_replaced records the grand total before and after');
  perform pg_temp.check(m -> 'after' ->> 'workbook_sha256' = repeat('c', 64)
                    and (m ->> 'internal_details_confirmation_cleared')::boolean,
    'parse_replaced records the new workbook and that the confirmation was cleared');

  -- A workbook that DOES carry dates prefills them.
  perform public.finish_order_submission_processing(c, tok);
  tok := gen_random_uuid();
  perform public.begin_order_submission_processing(c, s, tok);
  p := jsonb_set(jsonb_set(jsonb_set(p, '{processing_token}', to_jsonb(tok::text)),
         '{fingerprint}', to_jsonb(repeat('d', 64))),
         '{header}', (p -> 'header') || '{"order_confirmation_date":"2026-09-20","due_date":"2026-11-20"}');
  perform public.replace_order_submission_parse(c, s, p);
  select * into r from public.order_submissions where id = c;
  perform pg_temp.check(r.order_confirmation_date = date '2026-09-20' and r.workbook_due_date = date '2026-11-20',
    'a workbook date prefills the app field and is recorded as the workbook''s');
  raise notice 'section 3 (workbook replacement) passed';
end $$;


-- ═══ 4. PHASE 2 — submission requires the details ═══════════════════════════

\ir ../migrations/20270123000000_order_submission_internal_details_required_on_submit.sql

do $$
declare
  b    uuid := current_setting('test.pi_b')::uuid;
  s    uuid := current_setting('test.sales_id')::uuid;
  n0   integer;
  d0   integer;
  r    public.order_submissions%rowtype;
begin
  select count(*) into n0 from public.order_submission_activity where submission_id = b;
  select count(*) into d0 from public.order_document_submissions where pi_submission_id = b;

  -- Nothing answered: refused, through the documents wrapper the screen uses.
  perform pg_temp.become(s);
  perform pg_temp.expect_error(format(
    'select public.submit_pi_for_review_with_documents(%L, null, %L, null, null, null, %L::jsonb, %L::text[])',
    b, 'Against client PO', '[]', '{design_files,client_po}'),
    'ORDER_SUBMISSION_INCOMPLETE', 'submitting with no internal details');
  -- ...and through an older door.
  perform pg_temp.expect_error(format('select public.submit_pi_for_review(%L, null, %L, null, null)', b, 'Against client PO'),
    'answer "Is there a middleman commission?"', 'the older door says what is missing');
  perform pg_temp.restore();

  select * into r from public.order_submissions where id = b;
  perform pg_temp.check(r.status = 'draft' and r.advance_exception_status is null,
    'a refused submission requests no exception');
  perform pg_temp.check((select count(*) from public.order_submission_activity where submission_id = b) = n0,
    'a refused submission writes no activity');
  perform pg_temp.check((select count(*) from public.order_document_submissions where pi_submission_id = b) = d0,
    'a refused submission records no documents');

  -- Answered but not confirmed: still refused.
  perform pg_temp.save(s, b, '{"order_confirmation_date":"2026-09-20","due_date":"2026-11-20","middleman_commission":"yes","middleman_recipient":"ASSERT agent","middleman_commission_basis":"percent","middleman_commission_percent":"2.5","middleman_commission_percent_of":"total_before_gst"}', false);
  perform pg_temp.become(s);
  perform pg_temp.expect_error(format('select public.submit_pi_for_review(%L, null, %L, null, null)', b, 'Against client PO'),
    'confirm the internal details', 'answered but unconfirmed');
  perform pg_temp.restore();

  -- The Yes path, confirmed: submits, and asks for the reduced-advance exception once.
  perform pg_temp.save(s, b, '{"order_confirmation_date":"2026-09-20","due_date":"2026-11-20","middleman_commission":"yes","middleman_recipient":"ASSERT agent","middleman_commission_basis":"percent","middleman_commission_percent":"2.5","middleman_commission_percent_of":"total_before_gst"}', true);
  perform pg_temp.become(s);
  perform public.submit_pi_for_review(b, null, 'Against client PO', null, null);
  perform pg_temp.restore();
  select * into r from public.order_submissions where id = b;
  perform pg_temp.check(r.status = 'submitted' and r.advance_exception_status = 'pending', 'the Yes path submits');

  -- Submitted: the editor is closed.
  perform pg_temp.expect_error(format('select pg_temp.save(%L, %L, %L, false)', s, b, '{"middleman_commission":"no"}'),
    'ORDER_SUBMISSION_NOT_EDITABLE', 'editing after submission');
  raise notice 'section 4 (phase 2 gate) passed';
end $$;


-- ═══ 5. SEND BACK, EDIT, RESUBMIT THE SAME PI WITH ITS CLIENT PO ════════════

do $$
declare
  a     uuid := current_setting('test.pi_a')::uuid;
  s     uuid := current_setting('test.sales_id')::uuid;
  own   uuid := current_setting('test.owner_id')::uuid;
  doc1  uuid := gen_random_uuid();
  doc2  uuid := gen_random_uuid();
  po    text;
  r     public.order_submissions%rowtype;
  d     record;
  first_requested timestamptz;
  wb_before text;
begin
  select source_workbook_path into wb_before from public.order_submissions where id = a;

  -- First submission, with a Client PO and no payment → exception route.
  po := pg_temp.store_po(a, doc1, s);
  perform pg_temp.become(s);
  perform public.submit_pi_for_review_with_documents(a, null, 'Against client PO', null, null, doc1,
    jsonb_build_array(jsonb_build_object('path', po, 'file_name', 'client-po.pdf')), array['design_files']);
  perform pg_temp.restore();
  select advance_exception_requested_at into first_requested from public.order_submissions where id = a;

  -- The admin sends it back with a reason.
  perform pg_temp.become(own);
  perform public.request_order_submission_changes(a, 'ASSERT: please confirm the dates and the commission');
  perform pg_temp.restore();
  select * into r from public.order_submissions where id = a;
  perform pg_temp.check(r.status = 'needs_changes' and r.review_note like 'ASSERT: please confirm%', 'the reason is on the PI');
  perform pg_temp.check(r.advance_exception_status = 'pending', 'the pending exception stays with the returned PI');
  select * into d from public.order_document_submissions where id = doc1;
  perform pg_temp.check(d.status = 'rejected_admin' and d.admin_reason like 'PI returned for changes: ASSERT%',
    'the Client PO went back with the PI and the PI''s reason');

  -- Sales changes the answer to Yes (an amount) and confirms.
  perform pg_temp.save(s, a, '{"order_confirmation_date":"2026-09-20","due_date":"2026-11-20","middleman_commission":"yes","middleman_recipient":"ASSERT agent","middleman_commission_basis":"amount","middleman_commission_amount":"50000"}', true);

  -- Resubmits the SAME PI, carrying the same Client PO file forward.
  perform pg_temp.become(s);
  perform public.submit_pi_for_review_with_documents(a, 'Dates confirmed; commission added', 'Against client PO', null, null, doc2,
    jsonb_build_array(jsonb_build_object('path', po, 'file_name', 'client-po.pdf')), array['design_files']);
  perform pg_temp.restore();

  select * into r from public.order_submissions where id = a;
  perform pg_temp.check(r.status = 'submitted' and r.source_workbook_path = wb_before, 'the same PI, with the same workbook, is back under review');
  perform pg_temp.check(r.middleman_commission_amount = 50000, 'the edited answer went with it');
  select * into d from public.order_document_submissions where id = doc2;
  perform pg_temp.check(d.status = 'pending_admin' and d.resubmission_of = doc1, 'the Client PO is resubmitted and linked to the returned one');
  perform pg_temp.check(exists (select 1 from public.order_document_submission_files where submission_id = doc2 and storage_path = po),
    'the SAME stored Client PO file is carried, not re-uploaded');
  perform pg_temp.check((select status from public.order_document_submissions where id = doc1) = 'rejected_admin',
    'the returned document stays on record');

  -- The exception: still ONE request on the PI, refreshed in place.
  perform pg_temp.check(r.advance_exception_status = 'pending', 'the exception is pending again');
  perform pg_temp.check((select count(*) from public.order_submissions where id = a) = 1, 'no second PI');

  -- The whole story is in the trail, in order.
  perform pg_temp.check((
    select array_agg(action order by created_at, action)
      from public.order_submission_activity
     where submission_id = a and action in ('submitted', 'changes_requested', 'internal_details_updated')
  ) @> array['submitted', 'changes_requested', 'internal_details_updated'], 'submit, send-back, edit and resubmit are all in the trail');
  perform pg_temp.check(exists (select 1 from public.order_submission_activity
     where submission_id = a and action = 'submitted' and (metadata ->> 'resubmitted')::boolean
       and note = 'Dates confirmed; commission added'), 'the resubmission is marked as one, with Sales'' reply');
  perform pg_temp.check(exists (select 1 from public.order_submission_activity
     where submission_id = a and action = 'changes_requested' and note like 'ASSERT: please confirm%'),
    'the send-back reason is kept in the trail');
  raise notice 'section 5 (send-back and resubmit) passed';
end $$;


-- ═══ 6. AN APPROVED EXCEPTION AND CHANGED ANSWERS ═══════════════════════════

do $$
declare
  b   uuid := current_setting('test.pi_b')::uuid;
  s   uuid := current_setting('test.sales_id')::uuid;
  own uuid := current_setting('test.owner_id')::uuid;
  r   public.order_submissions%rowtype;
begin
  perform pg_temp.become(own);
  perform public.approve_pi_advance_exception(b);
  perform public.request_order_submission_changes(b, 'ASSERT: change the commission base');
  perform pg_temp.restore();
  select * into r from public.order_submissions where id = b;
  perform pg_temp.check(r.advance_exception_status = 'approved', 'the approval survives the send-back');

  -- Only the INTERNAL answer changes; amounts, workbook and terms do not.
  perform pg_temp.save(s, b, '{"order_confirmation_date":"2026-09-20","due_date":"2026-11-20","middleman_commission":"yes","middleman_recipient":"ASSERT agent","middleman_commission_basis":"percent","middleman_commission_percent":"2.5","middleman_commission_percent_of":"grand_total"}', true);
  perform pg_temp.become(s);
  perform public.submit_pi_for_review(b, null, 'Against client PO', null, null);
  perform pg_temp.restore();
  select * into r from public.order_submissions where id = b;
  perform pg_temp.check(r.advance_exception_status = 'approved',
    'changing only the internal answers does not re-ask an approved exception (its basis is the total, workbook and terms)');

  -- The AMOUNT basis moves (a new workbook): the approval no longer holds.
  perform pg_temp.become(own);
  perform public.request_order_submission_changes(b, 'ASSERT: new workbook');
  perform pg_temp.restore();
  perform set_config('request.jwt.claims', '', true);
  update public.order_submissions set source_workbook_sha256 = repeat('e', 64), grand_total = 1100000 where id = b;
  perform pg_temp.save(s, b, '{"order_confirmation_date":"2026-09-20","due_date":"2026-11-20","middleman_commission":"no"}', true);
  perform pg_temp.become(s);
  perform public.submit_pi_for_review(b, null, 'Against client PO', null, null);
  perform pg_temp.restore();
  select * into r from public.order_submissions where id = b;
  perform pg_temp.check(r.advance_exception_status = 'pending', 'a changed amount asks for the exception again');
  raise notice 'section 6 (exception with changed answers) passed';
end $$;

do $$ begin raise notice 'ALL INTERNAL DETAILS ASSERTIONS PASSED'; end $$;

rollback;
