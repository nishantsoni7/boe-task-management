-- FIXTURE, NOT A SUITE — COMMITS. Run on a DISPOSABLE stack BEFORE
-- 20270201000000 is applied (run_order_pi_version_pdf_order_number_local.sh
-- does both, in order, with _order_pi_version_pdf_order_number_helpers.sql
-- prepended).
--
-- It leaves PI versions in every status a PDF can be opened for, made through
-- the real doors on the schema BEFORE the new column exists, so the migration
-- has real history to backfill:
--
--   Order "prior A"  V1 superseded · V2 approved (Edit PI) · V3 rejected (Edit PI)
--                    · V4 pending (revised workbook)
--   Order "prior B"  V1 approved · V2 pending (Edit PI)
--   Order "prior C"  V1 approved · V2 rejected (revised workbook)

do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'order_pi_versions' and column_name = 'pdf_order_number') then
    raise exception 'refusing: 20270201000000 is already applied — this fixture must run before it';
  end if;
end $$;

do $$
declare
  a uuid; b uuid; c uuid; v uuid;
begin
  a := pg_temp.new_order('prior A');
  v := pg_temp.propose_edit(a, 11000, 'ASSERT prior A: V2 rate');
  perform pg_temp.approve(v);
  v := pg_temp.propose_edit(a, 12000, 'ASSERT prior A: V3 rate');
  perform pg_temp.reject(v, 'ASSERT prior A: V3 not agreed');
  v := pg_temp.propose_workbook(a, 'ASSERT prior A: V4 workbook');

  b := pg_temp.new_order('prior B');
  v := pg_temp.propose_edit(b, 13000, 'ASSERT prior B: V2 rate');

  c := pg_temp.new_order('prior C');
  v := pg_temp.propose_workbook(c, 'ASSERT prior C: V2 workbook');
  perform pg_temp.reject(v, 'ASSERT prior C: V2 not agreed');
end $$;

select o.client_name, o.display_number, v.version_number, v.status
  from public.order_pi_versions v join public.orders o on o.id = v.order_id
 where o.client_name like 'ASSERT pdfnum prior%'
 order by o.client_name, v.version_number;
