-- Client choices (owner, 2026-11-18: "Everything is picked by client only. Either they select from our catalog or they send it from their end",
-- layout 2 = one table with a row per product). PR 1 of 3: the builder records them; nothing client-facing changes yet.
--
-- Each product can carry up to four optional choices: fabric, finish, stone, rope_weave. Each choice is
--   {source: 'catalog' | 'client', name, code, supplier, used_for, note, photo, status: 'to_confirm' | 'confirmed', confirmed_on}
-- where, for source 'client', name is the client's own description and supplier says who supplies it. photo is a picture in
-- quotation-images (same path shape as image_path). No lock, and it never touches a price.
--   1. quotation_lines.client_choices: a JSON object keyed by kind, checked by quotation_line_choices_ok. It sits ON the line, as
--      reference_images does (20270721000000), because quotation_save deletes and re-inserts every line on each save, so a separate
--      table keyed by line id would be orphaned and one keyed by position would follow the wrong product after a move or delete.
--   2. quotation_save stores it; a line sent WITHOUT the key (a browser tab opened before this change) keeps what the line at the
--      same position with the same name had, so an old tab cannot wipe the choices.
--   3. quotation_get returns it untouched (to_jsonb of the line). quotation_client_doc and quotation_public are NOT changed (they
--      list their line fields by name), so the client's copy and every frozen version stay exactly as before.
-- Adds a column (default '{}', no existing row changes): back up first per the owner's rule. Apply BEFORE the code that sends the key.
-- Rollback (by hand): re-create quotation_save from 20270806000100; drop the column, then drop function
-- public.quotation_line_choices_ok(jsonb).

begin;

create or replace function public.quotation_line_choices_ok(p jsonb)
returns boolean language sql immutable set search_path = public, pg_temp
as $$
  select p is null or (
    jsonb_typeof(p) = 'object'
    and not exists (select 1 from jsonb_object_keys(p) k where k not in ('fabric', 'finish', 'stone', 'rope_weave'))
    and not exists (
      select 1 from jsonb_each(p) e(k, v)
      where jsonb_typeof(e.v) <> 'object'
         or coalesce(e.v->>'source', '') not in ('catalog', 'client')
         or coalesce(e.v->>'status', '') not in ('to_confirm', 'confirmed')
         or exists (select 1 from jsonb_object_keys(e.v) kk where kk not in ('source', 'name', 'code', 'supplier', 'used_for', 'note', 'photo', 'status', 'confirmed_on'))
         or exists (select 1 from jsonb_each(e.v) f(fk, fv) where jsonb_typeof(f.fv) not in ('string', 'null'))
         or char_length(coalesce(e.v->>'name', '')) > 200
         or char_length(coalesce(e.v->>'code', '')) > 80
         or char_length(coalesce(e.v->>'supplier', '')) > 120
         or char_length(coalesce(e.v->>'used_for', '')) > 160
         or char_length(coalesce(e.v->>'note', '')) > 400
         or (coalesce(e.v->>'photo', '') <> '' and e.v->>'photo' !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.jpg$')
         or (coalesce(e.v->>'confirmed_on', '') <> '' and (e.v->>'confirmed_on' !~ '^\d{4}-\d{2}-\d{2}$' or e.v->>'status' <> 'confirmed'))))
$$;
-- Only the column check calls it, from inside quotation_save (security definer), so nobody needs execute.
revoke all on function public.quotation_line_choices_ok(jsonb) from public, anon, authenticated;

alter table public.quotation_lines
  add column client_choices jsonb not null default '{}'::jsonb
    constraint quotation_lines_client_choices_check check (public.quotation_line_choices_ok(client_choices));

-- quotation_save: as 20270806000100, plus client_choices.
create or replace function public.quotation_save(p_id uuid, p_doc jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare
  a record; q public.quotations; h jsonb := coalesce(p_doc->'header', '{}'::jsonb);
  v jsonb; ord bigint; v_area uuid; keys jsonb := '{}'::jsonb; n_areas int := 0; n_lines int := 0;
  old_refs jsonb; old_choices jsonb;
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
    project_type   = case when h ? 'project_type' then nullif(h->>'project_type', '') else project_type end,
    seats          = case when h ? 'seats' then nullif(h->>'seats', '')::int else seats end,
    lead_time_weeks  = case when h ? 'lead_time_weeks' then nullif(h->>'lead_time_weeks', '')::smallint else lead_time_weeks end,
    lead_time_reason = case when h ? 'lead_time_reason' then nullif(btrim(h->>'lead_time_reason'), '') else lead_time_reason end,
    client_type    = nullif(h->>'client_type', ''),
    supply_state   = nullif(btrim(h->>'supply_state'), ''),
    delivery_city  = case when h ? 'delivery_city' then nullif(btrim(h->>'delivery_city'), '') else delivery_city end,
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

  -- What each line had, by position and name, for a line sent without reference_images (an old browser tab).
  select coalesce(jsonb_object_agg(l.position::text || '|' || l.name, l.reference_images), '{}'::jsonb) into old_refs
    from public.quotation_lines l where l.quotation_id = p_id and l.reference_images <> '[]'::jsonb;

  -- Likewise for the client's choices (20270808000000).
  select coalesce(jsonb_object_agg(l.position::text || '|' || l.name, l.client_choices), '{}'::jsonb) into old_choices
    from public.quotation_lines l where l.quotation_id = p_id and l.client_choices <> '{}'::jsonb;

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
      qty_per_unit, qty_fixed, unit_price, tax_rate, image_path, is_optional, client_note, internal_note, reference_images, client_choices)
    values (p_id, v_area, ord - 1, btrim(v->>'name'), nullif(btrim(v->>'size_text'), ''), nullif(btrim(v->>'spec'), ''),
      nullif(btrim(v->>'material'), ''), nullif(btrim(v->>'finish'), ''), nullif(btrim(v->>'category'), ''),
      (v->>'qty_per_unit')::numeric, (v->>'qty_fixed')::numeric, (v->>'unit_price')::bigint,
      coalesce((v->>'tax_rate')::numeric, 18), nullif(v->>'image_path', ''), coalesce((v->>'is_optional')::boolean, false),
      nullif(btrim(v->>'client_note'), ''), nullif(btrim(v->>'internal_note'), ''),
      case when v ? 'reference_images' then coalesce(nullif(v->'reference_images', 'null'::jsonb), '[]'::jsonb)
           else coalesce(old_refs->((ord - 1)::text || '|' || btrim(v->>'name')), '[]'::jsonb) end,
      case when v ? 'client_choices' then coalesce(nullif(v->'client_choices', 'null'::jsonb), '{}'::jsonb)
           else coalesce(old_choices->((ord - 1)::text || '|' || btrim(v->>'name')), '{}'::jsonb) end);
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

do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quotation_lines' and column_name = 'client_choices') then
    raise exception 'QUOTATION_CLIENT_CHOICES: the column is missing';
  end if;
  if has_function_privilege('anon', 'public.quotation_line_choices_ok(jsonb)', 'execute') then
    raise exception 'QUOTATION_CLIENT_CHOICES: the checker must not be open to anon';
  end if;
  if not public.quotation_line_choices_ok('{"fabric":{"source":"catalog","status":"to_confirm","name":"Berlin velvet"}}'::jsonb)
     or public.quotation_line_choices_ok('{"leather":{"source":"catalog","status":"to_confirm"}}'::jsonb)
     or public.quotation_line_choices_ok('{"fabric":{"source":"x","status":"to_confirm"}}'::jsonb)
     or public.quotation_line_choices_ok('{"fabric":{"source":"client","status":"to_confirm","confirmed_on":"2026-11-18"}}'::jsonb) then
    raise exception 'QUOTATION_CLIENT_CHOICES: the checker is wrong';
  end if;
end $$;

commit;
