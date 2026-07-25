-- Order Request Main-PI Excel-only assertions (20260711000000, finalize guard)
-- ===========================================================================
-- Validates the SERVER-SIDE rule that a finalized Order Request's Main PI must
-- be an Excel workbook (.xlsx or .xls), enforced inside finalize_order_request(),
-- and the Storage bucket allow-list contract (both Excel mimes present; the
-- approved reference mimes preserved). Runs in ONE transaction that ends in
-- ROLLBACK.
--
-- PREREQUISITES (controlled environment, migrations already applied):
--   * Run with psql as a role that bypasses RLS (standard Supabase `postgres`)
--     and may SET the `role` GUC to 'authenticated'.
--   * Replace the ONE real user UUID below:
--       test.admin_id -> a public.users row with role = 'admin'
--
-- On success prints NOTICE 'ALL ASSERTIONS PASSED' and rolls back.

\set ON_ERROR_STOP on

begin;

-- ── Config: the ONLY line a tester edits ──────────────────────────────────────
do $$
begin
  perform set_config('test.admin_id', '11111111-1111-1111-1111-111111111111', true); -- REPLACE
  perform set_config('test.d_pdf',          gen_random_uuid()::text, true);
  perform set_config('test.d_xlsx',         gen_random_uuid()::text, true);  -- .xlsx name, NULL mime
  perform set_config('test.d_xlsx_ref',     gen_random_uuid()::text, true);
  perform set_config('test.d_xlsx_pdfmime', gen_random_uuid()::text, true);  -- .xlsx name, conflicting PDF mime
  perform set_config('test.d_xlsx_okmime',  gen_random_uuid()::text, true);  -- .xlsx name, explicit Excel mime
end $$;

-- ── Fixtures (superuser connection; RLS bypassed) ─────────────────────────────
-- Five admin-owned upload-stage drafts. request_number is assigned by trigger.
insert into public.order_requests (id, client_name, requested_by, created_by, assigned_to, status, finalized_at)
values
  (current_setting('test.d_pdf')::uuid,          'ASSERT pdf pi',        current_setting('test.admin_id')::uuid, current_setting('test.admin_id')::uuid, null, 'submitted', null),
  (current_setting('test.d_xlsx')::uuid,         'ASSERT xlsx pi',       current_setting('test.admin_id')::uuid, current_setting('test.admin_id')::uuid, null, 'submitted', null),
  (current_setting('test.d_xlsx_ref')::uuid,     'ASSERT xlsx pi+ref',   current_setting('test.admin_id')::uuid, current_setting('test.admin_id')::uuid, null, 'submitted', null),
  (current_setting('test.d_xlsx_pdfmime')::uuid, 'ASSERT xlsx pdf-mime', current_setting('test.admin_id')::uuid, current_setting('test.admin_id')::uuid, null, 'submitted', null),
  (current_setting('test.d_xlsx_okmime')::uuid,  'ASSERT xlsx ok-mime',  current_setting('test.admin_id')::uuid, current_setting('test.admin_id')::uuid, null, 'submitted', null);

-- mime_type is DELIBERATELY omitted (NULL) on d_pdf/d_xlsx/d_xlsx_ref to exercise
-- the "safely empty mime accepted by extension" path; the two mime-specific
-- fixtures set it explicitly.
insert into public.order_request_attachments (order_request_id, attachment_type, file_name, storage_path, uploaded_by)
values
  -- A PDF wrongly staged as the Main PI (crafted request) — finalize must reject (extension).
  (current_setting('test.d_pdf')::uuid, 'main_pi', 'invoice.pdf',
   current_setting('test.d_pdf') || '/main-pi/' || gen_random_uuid() || '-invoice.pdf', current_setting('test.admin_id')::uuid),
  -- A valid Excel Main PI with NULL mime (safely-empty path).
  (current_setting('test.d_xlsx')::uuid, 'main_pi', 'invoice.xlsx',
   current_setting('test.d_xlsx') || '/main-pi/' || gen_random_uuid() || '-invoice.xlsx', current_setting('test.admin_id')::uuid),
  -- A valid Excel Main PI plus a PDF reference (references are unaffected).
  (current_setting('test.d_xlsx_ref')::uuid, 'main_pi', 'invoice.xlsx',
   current_setting('test.d_xlsx_ref') || '/main-pi/' || gen_random_uuid() || '-invoice.xlsx', current_setting('test.admin_id')::uuid),
  (current_setting('test.d_xlsx_ref')::uuid, 'reference', 'pi-copy.pdf',
   current_setting('test.d_xlsx_ref') || '/references/' || gen_random_uuid() || '-pi-copy.pdf', current_setting('test.admin_id')::uuid);

-- An .xlsx NAME but a conflicting stored PDF mime — finalize must reject on mime.
insert into public.order_request_attachments (order_request_id, attachment_type, file_name, storage_path, mime_type, uploaded_by)
values
  (current_setting('test.d_xlsx_pdfmime')::uuid, 'main_pi', 'invoice.xlsx',
   current_setting('test.d_xlsx_pdfmime') || '/main-pi/' || gen_random_uuid() || '-invoice.xlsx',
   'application/pdf', current_setting('test.admin_id')::uuid),
  -- An .xlsx name WITH the canonical Excel mime (a real client upload) — accepted.
  (current_setting('test.d_xlsx_okmime')::uuid, 'main_pi', 'invoice.xlsx',
   current_setting('test.d_xlsx_okmime') || '/main-pi/' || gen_random_uuid() || '-invoice.xlsx',
   'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', current_setting('test.admin_id')::uuid);

-- ── SERVER VALIDATION: finalize enforces Excel-only Main PI ───────────────────
do $$
declare
  v_res jsonb;
  v_msg text;
  v_rejected boolean := false;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', current_setting('test.admin_id'), true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('test.admin_id'), 'role', 'authenticated')::text, true);

  -- A PDF Main PI must be REJECTED by finalize (server-side guard), regardless of
  -- the client. If finalize succeeds (no exception) v_rejected stays false.
  begin
    perform public.finalize_order_request(current_setting('test.d_pdf')::uuid);
  exception when raise_exception then
    get stacked diagnostics v_msg = message_text;
    v_rejected := (v_msg like 'MAIN_PI_NOT_EXCEL%');
  end;
  assert v_rejected, 'finalize must reject a non-Excel (PDF) Main PI with MAIN_PI_NOT_EXCEL';

  -- The PDF draft is still an unfinalized draft afterwards (nothing changed).
  assert (select finalized_at is null from public.order_requests where id = current_setting('test.d_pdf')::uuid),
    'a rejected finalize must leave the request an upload-stage draft';

  -- A valid Excel Main PI with NULL mime finalizes (safely-empty mime path).
  v_res := public.finalize_order_request(current_setting('test.d_xlsx')::uuid);
  assert (v_res->>'finalized_now') = 'true', 'an .xlsx Main PI (null mime) should finalize';

  -- A valid Excel Main PI with a PDF reference finalizes; the reference counts
  -- (proves reference types were NOT restricted to Excel).
  v_res := public.finalize_order_request(current_setting('test.d_xlsx_ref')::uuid);
  assert (v_res->>'finalized_now') = 'true', 'an .xlsx Main PI with a PDF reference should finalize';
  assert (v_res->>'reference_count') = '1', 'the PDF reference must be counted (references unaffected)';

  -- An .xlsx NAME but a conflicting stored PDF mime must be REJECTED on mime.
  v_rejected := false;
  begin
    perform public.finalize_order_request(current_setting('test.d_xlsx_pdfmime')::uuid);
  exception when raise_exception then
    get stacked diagnostics v_msg = message_text;
    v_rejected := (v_msg like 'MAIN_PI_NOT_EXCEL%');
  end;
  assert v_rejected, 'finalize must reject an .xlsx Main PI whose stored mime clearly conflicts (application/pdf)';

  -- An .xlsx name WITH the canonical Excel mime finalizes.
  v_res := public.finalize_order_request(current_setting('test.d_xlsx_okmime')::uuid);
  assert (v_res->>'finalized_now') = 'true', 'an .xlsx Main PI with an Excel mime should finalize';
end $$;

-- ── STORAGE CONTRACT: bucket allow-list (superuser) ───────────────────────────
reset role;
do $$
declare v_types text[];
begin
  select allowed_mime_types into v_types from storage.buckets where id = 'order-request-attachments';
  assert v_types is not null, 'the order-request-attachments bucket must exist';

  -- Both Excel mime types are present (so Excel uploads pass the storage gate).
  assert v_types @> array[
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel'
  ], 'bucket allow-list must include both Excel mime types';

  -- The approved reference mime types remain present (PDF + image kept, so a PI
  -- PDF and reference images still upload).
  assert v_types @> array[
    'application/pdf',
    'image/jpeg', 'image/png', 'image/webp',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain', 'text/csv'
  ], 'bucket allow-list must still include the approved reference mime types';

  assert (select file_size_limit from storage.buckets where id = 'order-request-attachments') = 10485760,
    'bucket size limit must remain 10 MB';
end $$;

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;

rollback;
