-- FIXTURE, NOT A SUITE — COMMITS. Run on a DISPOSABLE stack AFTER
-- 20270201000000 and BEFORE 20270202000000
-- (run_order_pi_version_pdf_order_number_switch_local.sh does it in order,
-- with _order_pi_version_pdf_order_number_helpers.sql prepended).
--
-- The release window between the two migrations: the old PDF route may still
-- be live, then the new one. Versions created here must be stamped with what
-- both print — the old form — and keep it after the switch:
--
--   Order "between E"  V1 approved · V2 pending (Edit PI), decided after the switch

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'order_pi_versions' and column_name = 'pdf_order_number') then
    raise exception 'refusing: 20270201000000 is not applied — this fixture runs between the two migrations';
  end if;
  if (select prosrc from pg_proc where oid = 'public.order_pi_versions_pdf_order_number()'::regprocedure)
       not like '%order_operational_number%' then
    raise exception 'refusing: 20270202000000 is already applied — this fixture runs before it';
  end if;
end $$;

do $$
declare
  e uuid; v uuid;
begin
  e := pg_temp.new_order('between E');
  v := pg_temp.propose_edit(e, 11000, 'ASSERT between E: V2 rate');
end $$;

select o.client_name, o.display_number, v.version_number, v.status, v.pdf_order_number
  from public.order_pi_versions v join public.orders o on o.id = v.order_id
 where o.client_name = 'ASSERT pdfnum between E'
 order by v.version_number;
