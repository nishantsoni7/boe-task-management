-- Costing on the client's copy, PR 2 of 3 (owner, 2026-11-23: "Yes, add both"): the client sees the price PER PIECE of the fabric and the packing, and the
-- packing type. NEVER the metres of fabric per piece or the rate per metre.
--
-- 1. quotation_costing_view(choices, costing): the figures the client may see, worked out in the database so that the client link and every
--    version sent from now on freeze the same thing the staff copy shows (math.ts costingViewOf is the twin; quotations_pglite.mjs checks they agree):
--      {"fabric": {"per": 1360} | {"free": true} | {"wait": true}, "packing": {"type": "Carton", "per": 650} | {"type": "Carton", "wait": true}}
--    fabric: rate x metres per piece, to 2 decimals; the client's own fabric with no rate is "free" (no charge); a catalog fabric or a code with no rate,
--    or a rate with no metres, is "wait" (price still to be confirmed). Null when there is nothing to say.
-- 2. quotation_client_doc (what the client link shows and a sent version freezes; last defined in 20270809000000) adds, to each line that has costing,
--    'costing_view'. A line with no costing gets no key, so a quotation without costing produces EXACTLY the document it produced before, and every
--    version already sent is untouched (a frozen copy; the figures reach a client only with the next version sent). The fabric_amount and packing_amount
--    totals were already in the document and are unchanged.
-- Only function bodies: no table or row changes, so no backup is needed first.
--
-- Rollback: re-create quotation_client_doc from 20270809000000, then drop function public.quotation_costing_view(jsonb, jsonb).

begin;

create or replace function public.quotation_costing_view(p_choices jsonb, p_costing jsonb)
returns jsonb language plpgsql immutable set search_path = public, pg_temp
as $$
declare
  fab jsonb := null; pk jsonb := null; in_use boolean;
  metres numeric := (p_costing #>> '{fabric,metres}')::numeric;
  rate numeric := (p_costing #>> '{fabric,rate}')::numeric;
  per_piece numeric := (p_costing #>> '{packing,per_piece}')::numeric;
  ptype text := nullif(btrim(coalesce(p_costing #>> '{packing,type}', '')), '');
begin
  in_use := nullif(btrim(coalesce(p_choices #>> '{fabric,name}', '')), '') is not null
         or nullif(btrim(coalesce(p_choices #>> '{fabric,code}', '')), '') is not null
         or metres is not null or rate is not null;
  if in_use then
    if rate is null then
      fab := case when p_choices #>> '{fabric,source}' = 'client' then jsonb_build_object('free', true) else jsonb_build_object('wait', true) end;
    elsif coalesce(metres, 0) = 0 then
      fab := jsonb_build_object('wait', true);
    else
      fab := jsonb_build_object('per', round(metres * rate, 2));
    end if;
  end if;
  if ptype is not null or per_piece is not null then
    pk := case when per_piece is null then jsonb_build_object('wait', true) else jsonb_build_object('per', per_piece) end
          || case when ptype is not null then jsonb_build_object('type', ptype) else '{}'::jsonb end;
  end if;
  if fab is null and pk is null then return null; end if;
  return jsonb_strip_nulls(jsonb_build_object('fabric', fab, 'packing', pk));
end $$;
revoke all on function public.quotation_costing_view(jsonb, jsonb) from public, anon, authenticated;

-- quotation_client_doc: as 20270809000000, plus costing_view.
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
                       || case when l.costing <> '{}'::jsonb and public.quotation_costing_view(l.client_choices, l.costing) is not null
                               then jsonb_build_object('costing_view', public.quotation_costing_view(l.client_choices, l.costing))
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
declare v jsonb;
begin
  if has_function_privilege('anon', 'public.quotation_client_doc(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.quotation_client_doc(uuid)', 'execute')
     or has_function_privilege('anon', 'public.quotation_costing_view(jsonb, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.quotation_costing_view(jsonb, jsonb)', 'execute') then
    raise exception 'QUOTATION_COSTING_VIEW: the functions must stay closed to anon and authenticated';
  end if;
  v := public.quotation_costing_view('{"fabric":{"source":"catalog","status":"to_confirm","name":"Velvet"}}'::jsonb,
                                     '{"fabric":{"metres":1.6,"rate":850},"packing":{"type":"Carton","per_piece":650}}'::jsonb);
  if v <> '{"fabric":{"per":1360},"packing":{"per":650,"type":"Carton"}}'::jsonb or v::text like '%metres%' or v::text like '%rate%' then
    raise exception 'QUOTATION_COSTING_VIEW: wrong view %', v;
  end if;
  if public.quotation_costing_view('{}'::jsonb, '{}'::jsonb) is not null
     or public.quotation_costing_view('{"fabric":{"source":"client","status":"to_confirm","name":"Own"}}'::jsonb, '{"packing":{"per_piece":0}}'::jsonb) <> '{"fabric":{"free":true},"packing":{"per":0}}'::jsonb
     or public.quotation_costing_view('{"fabric":{"source":"code","status":"to_confirm","code":"F1"}}'::jsonb, '{"packing":{"type":"Crate"}}'::jsonb) <> '{"fabric":{"wait":true},"packing":{"type":"Crate","wait":true}}'::jsonb
     or public.quotation_costing_view('{}'::jsonb, '{"fabric":{"rate":700}}'::jsonb) <> '{"fabric":{"wait":true}}'::jsonb then
    raise exception 'QUOTATION_COSTING_VIEW: a state is wrong';
  end if;
end $$;

commit;
