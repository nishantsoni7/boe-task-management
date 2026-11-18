-- Client choices, PR 2 of 3 (owner, 2026-11-18: layout 2, "print both confirmed and to-confirm rows"): the client's copy carries them.
--
-- quotation_client_doc (what the client link shows and what a sent version freezes; last defined in 20270717000000) now adds, to each
-- line that has any, 'client_choices': {fabric|finish|stone|rope_weave: {source, name, code, supplier, used_for, photo, status,
-- confirmed_on}}. The choice's NOTE is left out: the builder labels it "Anything the factory should know", so it stays internal.
-- A line with no choices gets no key at all, so a quotation without choices produces EXACTLY the document it produced before, and
-- every version already sent is untouched (they are frozen copies; a choice reaches a client only with the next version sent).
-- Only a function body is replaced: no table or row changes, so no backup is needed first.
--
-- Rollback: re-create quotation_client_doc from 20270717000000.

begin;

create or replace function public.quotation_client_doc(p_id uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'client_name', q.client_name, 'project_name', q.project_name, 'contact_name', q.contact_name, 'gst_mode', q.gst_mode,
    'discount_pct', q.discount_pct, 'fabric_amount', q.fabric_amount, 'packing_amount', q.packing_amount,
    'transport_note', q.transport_note, 'valid_days', q.valid_days, 'notes', q.notes,
    'areas', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'style', x.style, 'multiplier', x.multiplier, 'unit_label', x.unit_label) order by x.position)
                       from public.quotation_areas x where x.quotation_id = q.id), '[]'::jsonb),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('area_id', l.area_id, 'name', l.name, 'size_text', l.size_text, 'spec', l.spec,
                         'material', l.material, 'finish', l.finish, 'qty_per_unit', l.qty_per_unit, 'qty_fixed', l.qty_fixed,
                         'unit_price', l.unit_price, 'tax_rate', l.tax_rate, 'image_path', l.image_path, 'is_optional', l.is_optional,
                         'client_note', l.client_note)
                       || case when l.client_choices <> '{}'::jsonb
                               then jsonb_build_object('client_choices', (select jsonb_object_agg(e.k, e.v - 'note') from jsonb_each(l.client_choices) e(k, v)))
                               else '{}'::jsonb end
                       order by l.position)
                       from public.quotation_lines l where l.quotation_id = q.id), '[]'::jsonb))
    || jsonb_strip_nulls(jsonb_build_object('company_name', q.company_name, 'client_gstin', q.client_gstin,
                                             'dimension_unit', case when q.dimension_unit <> 'in' then q.dimension_unit end,
                                             'project_type', q.project_type, 'seats', q.seats, 'lead_time_weeks', q.lead_time_weeks))
  from public.quotations q where q.id = p_id
$$;
revoke all on function public.quotation_client_doc(uuid) from public, anon, authenticated;

do $$
begin
  if has_function_privilege('anon', 'public.quotation_client_doc(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.quotation_client_doc(uuid)', 'execute') then
    raise exception 'quotation_client_doc must stay closed to anon and authenticated';
  end if;
end $$;

commit;
