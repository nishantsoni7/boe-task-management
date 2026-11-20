-- 20270814000100_quotation_lead_required.sql
--
-- Quotations: no quotation without a Sales lead (owner, 20 Nov 2026, the "very important condition"). 20270814000000 added
-- quotation_start (a quotation made FROM a lead, details copied from it). This file closes the old door: quotation_create is
-- replaced so that it needs data.lead_id and hands the work to quotation_start. A call without a lead is refused with
-- QUOTATION_LEAD_REQUIRED (a person with no Quotations access still gets QUOTATIONS_FORBIDDEN first).
--
-- APPLY ONLY AFTER the code that calls quotation_start is live (the old screens call quotation_create without a lead and would
-- be refused). Quotations that already exist are untouched (no lead is forced on them; the Lead card on each still offers the
-- phone match). quotation_create_from_request (the old Tasks request path) is untouched.
--
-- ROLLBACK: create or replace function public.quotation_create(p_data jsonb) with the body from 20270614000000_quotations_module.sql.

do $$
begin
  if to_regprocedure('public.quotation_start(uuid, jsonb)') is null then
    raise exception 'DEPENDENCY MISSING: quotation_start (20270814000000) must be applied first';
  end if;
end $$;

create or replace function public.quotation_create(p_data jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare v_lead text := nullif(btrim(coalesce(p_data->>'lead_id', '')), '');
begin
  perform public.quotation_actor();
  if v_lead is null then
    raise exception 'QUOTATION_LEAD_REQUIRED: a quotation starts from a Sales lead; choose the lead first' using errcode = '22023';
  end if;
  return public.quotation_start(v_lead::uuid, p_data);
exception
  when invalid_text_representation then
    raise exception 'QUOTATION_INVALID: %', sqlerrm using errcode = '22023';
end $$;
revoke all on function public.quotation_create(jsonb) from public, anon;
grant execute on function public.quotation_create(jsonb) to authenticated;

do $$
begin
  if has_function_privilege('anon', 'public.quotation_create(jsonb)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.quotation_create(jsonb)', 'EXECUTE') then
    raise exception 'QUOTATION_LEAD_REQUIRED: quotation_create must be callable by signed-in people only';
  end if;
end $$;
