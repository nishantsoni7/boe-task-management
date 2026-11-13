-- Quotation builder redesign (13 Nov 2026, owner-approved).
--   1. Four new fields on a quotation: the client's email (internal only, never printed), the client's company name and GSTIN
--      (printed under "Prepared for" when filled), and ONE dimensions unit for the whole quotation ('in' or 'cm', default 'in').
--   2. "Note for the client" leaves the builder: every line's note is copied once to the end of its Remarks text
--      (quotation_lines.spec) and the note column is cleared. Remarks may now be up to 1,600 characters
--      (1,000 + a line break + the 500-character note always fits). Nothing is deleted: old versions the client already
--      has keep their note inside their frozen copy.
--   3. quotation_save stores the new fields, and keeps what is already there when a field is not sent (a browser tab left
--      open before this migration must not wipe an email or a unit it never knew about).
--      quotation_client_doc (what the client sees, and what a version freezes) carries company name, GSTIN and the unit
--      only when they are set, so a frozen older copy compares equal to a new one and a missing unit reads as inches.
--      quotation_public needs no change: it returns that copy.
-- Adds columns and changes data: take a backup first. Apply BEFORE the code that sends the new fields is merged.
-- Rollback (by hand): re-create quotation_save from 20270614000000 and quotation_client_doc from 20270623000000; drop the four columns;
-- the copied note text stays at the end of Remarks (it cannot be separated again), and the spec limit may only go back to 1,000
-- if no Remarks text is longer.

alter table public.quotations
  add column client_email   text check (char_length(client_email) <= 160),
  add column company_name   text check (char_length(company_name) <= 160),
  add column client_gstin   text check (char_length(client_gstin) <= 20),
  add column dimension_unit text not null default 'in' check (dimension_unit in ('in', 'cm'));

alter table public.quotation_lines drop constraint if exists quotation_lines_spec_check;
alter table public.quotation_lines add constraint quotation_lines_spec_check check (char_length(spec) <= 1600);

-- One-time copy: the note goes under the Remarks text (or becomes the Remarks text when there was none).
update public.quotation_lines
set spec = case when nullif(btrim(coalesce(spec, '')), '') is null then btrim(client_note)
                else btrim(spec) || E'\n' || btrim(client_note) end,
    client_note = null
where nullif(btrim(coalesce(client_note, '')), '') is not null;

create or replace function public.quotation_save(p_id uuid, p_doc jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare
  a record; q public.quotations; h jsonb := coalesce(p_doc->'header', '{}'::jsonb);
  v jsonb; ord bigint; v_area uuid; keys jsonb := '{}'::jsonb; n_areas int := 0; n_lines int := 0;
begin
  select * into a from public.quotation_actor();
  select * into q from public.quotations where id = p_id for update;
  if q.id is null or not public.quotation_sees(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_view_all) then raise exception 'QUOTATION_NOT_FOUND' using errcode = 'P0002'; end if;
  if not public.quotation_may_edit(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_create, a.p_edit, a.p_view_all) then raise exception 'QUOTATIONS_FORBIDDEN: you may not change this quotation' using errcode = '42501'; end if;
  if q.status in ('confirmed', 'lost', 'archived') then
    raise exception 'QUOTATION_LOCKED: a % quotation cannot be changed; reopen it first', q.status using errcode = '22023';
  end if;
  if p_doc ? 'expected_updated_at' and q.updated_at <> (p_doc->>'expected_updated_at')::timestamptz then
    raise exception 'QUOTATION_STALE: this quotation was saved by somebody else after you opened it' using errcode = '40001';
  end if;
  if jsonb_typeof(coalesce(p_doc->'areas', '[]'::jsonb)) <> 'array' or jsonb_typeof(coalesce(p_doc->'lines', '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_doc->'areas', '[]'::jsonb)) > 40 or jsonb_array_length(coalesce(p_doc->'lines', '[]'::jsonb)) > 600 then
    raise exception 'QUOTATION_INVALID: at most 40 room types and 600 lines' using errcode = '22023';
  end if;

  update public.quotations set
    client_name    = btrim(coalesce(h->>'client_name', client_name)),
    project_name   = nullif(btrim(h->>'project_name'), ''),
    contact_name   = nullif(btrim(h->>'contact_name'), ''),
    contact_phone  = nullif(btrim(h->>'contact_phone'), ''),
    contact_role   = nullif(btrim(h->>'contact_role'), ''),
    client_email   = case when h ? 'client_email' then nullif(btrim(h->>'client_email'), '') else client_email end,
    company_name   = case when h ? 'company_name' then nullif(btrim(h->>'company_name'), '') else company_name end,
    client_gstin   = case when h ? 'client_gstin' then nullif(upper(btrim(h->>'client_gstin')), '') else client_gstin end,
    dimension_unit = coalesce(nullif(h->>'dimension_unit', ''), dimension_unit),
    client_type    = nullif(h->>'client_type', ''),
    supply_state   = nullif(btrim(h->>'supply_state'), ''),
    gst_mode       = coalesce(nullif(h->>'gst_mode', ''), gst_mode),
    discount_pct   = coalesce((h->>'discount_pct')::numeric, 0),
    fabric_amount  = coalesce((h->>'fabric_amount')::bigint, 0),
    packing_amount = coalesce((h->>'packing_amount')::bigint, 0),
    transport_note = nullif(btrim(h->>'transport_note'), ''),
    valid_days     = coalesce((h->>'valid_days')::int, valid_days),
    notes          = nullif(btrim(h->>'notes'), ''),
    internal_notes = nullif(btrim(h->>'internal_notes'), '')
  where id = p_id
  returning * into q;

  delete from public.quotation_lines where quotation_id = p_id;
  delete from public.quotation_areas where quotation_id = p_id;

  for v, ord in select t.v, t.ord from jsonb_array_elements(coalesce(p_doc->'areas', '[]'::jsonb)) with ordinality as t(v, ord) loop
    insert into public.quotation_areas (quotation_id, position, name, style, multiplier, unit_label)
    values (p_id, ord - 1, btrim(v->>'name'), nullif(btrim(v->>'style'), ''), coalesce((v->>'multiplier')::int, 1),
            coalesce(nullif(btrim(v->>'unit_label'), ''), 'rooms'))
    returning id into v_area;
    if coalesce(v->>'key', '') <> '' then keys := keys || jsonb_build_object(v->>'key', v_area); end if;
    n_areas := n_areas + 1;
  end loop;

  for v, ord in select t.v, t.ord from jsonb_array_elements(coalesce(p_doc->'lines', '[]'::jsonb)) with ordinality as t(v, ord) loop
    v_area := null;
    if coalesce(v->>'area_key', '') <> '' then
      if not keys ? (v->>'area_key') then raise exception 'QUOTATION_INVALID: a line names a room type that is not in the quotation' using errcode = '22023'; end if;
      v_area := (keys->>(v->>'area_key'))::uuid;
    end if;
    insert into public.quotation_lines (quotation_id, area_id, position, name, size_text, spec, material, finish, category,
      qty_per_unit, qty_fixed, unit_price, tax_rate, image_path, is_optional, client_note, internal_note)
    values (p_id, v_area, ord - 1, btrim(v->>'name'), nullif(btrim(v->>'size_text'), ''), nullif(btrim(v->>'spec'), ''),
      nullif(btrim(v->>'material'), ''), nullif(btrim(v->>'finish'), ''), nullif(btrim(v->>'category'), ''),
      (v->>'qty_per_unit')::numeric, (v->>'qty_fixed')::numeric, (v->>'unit_price')::bigint,
      coalesce((v->>'tax_rate')::numeric, 18), nullif(v->>'image_path', ''), coalesce((v->>'is_optional')::boolean, false),
      nullif(btrim(v->>'client_note'), ''), nullif(btrim(v->>'internal_note'), ''));
    n_lines := n_lines + 1;
  end loop;

  insert into public.quotation_events (quotation_id, actor_id, kind, detail)
  values (p_id, a.p_uid, 'saved', jsonb_build_object('areas', n_areas, 'lines', n_lines, 'value_before_gst', public.quotation_value_before_gst(p_id)));
  return jsonb_build_object('updated_at', q.updated_at, 'value_before_gst', public.quotation_value_before_gst(p_id));
exception
  when check_violation or not_null_violation or invalid_text_representation or numeric_value_out_of_range or invalid_datetime_format then
    raise exception 'QUOTATION_INVALID: %', sqlerrm using errcode = '22023';
end $$;
revoke all on function public.quotation_save(uuid, jsonb) from public, anon;
grant execute on function public.quotation_save(uuid, jsonb) to authenticated;

-- What the client sees (and what a version freezes): as 20270623000000, plus company name, GSTIN and the dimensions unit
-- when they are set (the unit only when it is not inches). The email and the phone are never in it.
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
                         'client_note', l.client_note) order by l.position)
                       from public.quotation_lines l where l.quotation_id = q.id), '[]'::jsonb))
    || jsonb_strip_nulls(jsonb_build_object('company_name', q.company_name, 'client_gstin', q.client_gstin,
                                             'dimension_unit', case when q.dimension_unit <> 'in' then q.dimension_unit end))
  from public.quotations q where q.id = p_id
$$;
revoke all on function public.quotation_client_doc(uuid) from public, anon, authenticated;

do $$
begin
  if has_function_privilege('anon', 'public.quotation_save(uuid, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.quotation_client_doc(uuid)', 'execute') then
    raise exception 'QUOTATION_BUILDER_FIELDS: function grants are wrong';
  end if;
  if exists (select 1 from public.quotation_lines where nullif(btrim(coalesce(client_note, '')), '') is not null) then
    raise exception 'QUOTATION_BUILDER_FIELDS: a note was not copied into Remarks';
  end if;
end $$;
