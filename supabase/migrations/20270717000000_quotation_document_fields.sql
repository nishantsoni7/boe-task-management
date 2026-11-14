-- Premium client quotation document (14 Nov 2026, owner-approved: "Yes need to implement it").
--   1. Four new fields on a quotation: the PROJECT TYPE (hotel, resort, restaurant, cafe, brewery, other; this is the kind of venue,
--      not the client type, which stays architect / interior designer / ...), the SEATS (restaurant, cafe, brewery), and the LEAD TIME in
--      weeks with the REASON when a person changed it (a reason present = a manual override). The weeks are worked out in the browser from
--      the owner's rules (src/lib/quotations/documentPlan.ts) and stored, so the frozen copy a client sees never depends on code.
--   2. quotation_save stores them, and keeps what is already there when a key is not sent (an old browser tab must not wipe them).
--   3. quotation_client_doc (the client's copy, and what a version freezes) carries project type, seats and lead time ONLY when set, so
--      an untouched quotation freezes the same copy as before and "nothing has changed since vN" keeps working. The reason is never in it.
--   4. The salesperson's mobile and e-mail (public.users.phone, .email) are printed on the document (owner, 14 Nov 2026):
--      quotation_public adds salesperson_phone and salesperson_email, quotation_get adds owner_phone and owner_email for the print page.
--      They are live values, not frozen. The CLIENT's phone and e-mail, internal notes, owner id, token and cost are still never returned.
-- Adds columns: take a backup first. Apply BEFORE the code that sends the new keys is merged.
-- Rollback (by hand): re-create quotation_save and quotation_client_doc from 20270714000000, quotation_get from 20270629000000 and
-- quotation_public from 20270623000000; drop the four columns.

alter table public.quotations
  add column project_type     text check (project_type in ('hotel', 'resort', 'restaurant', 'cafe', 'brewery', 'other')),
  add column seats            integer check (seats between 1 and 100000),
  add column lead_time_weeks  smallint check (lead_time_weeks between 1 and 104),
  add column lead_time_reason text check (char_length(lead_time_reason) <= 200),
  add constraint quotations_lead_time_reason_needs_weeks check (lead_time_reason is null or lead_time_weeks is not null);

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
    project_type   = case when h ? 'project_type' then nullif(h->>'project_type', '') else project_type end,
    seats          = case when h ? 'seats' then nullif(h->>'seats', '')::int else seats end,
    lead_time_weeks  = case when h ? 'lead_time_weeks' then nullif(h->>'lead_time_weeks', '')::smallint else lead_time_weeks end,
    lead_time_reason = case when h ? 'lead_time_reason' then nullif(btrim(h->>'lead_time_reason'), '') else lead_time_reason end,
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

-- What the client sees (and what a version freezes): as 20270714000000, plus project type, seats and lead time when set.
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
                                             'dimension_unit', case when q.dimension_unit <> 'in' then q.dimension_unit end,
                                             'project_type', q.project_type, 'seats', q.seats, 'lead_time_weeks', q.lead_time_weeks))
  from public.quotations q where q.id = p_id
$$;
revoke all on function public.quotation_client_doc(uuid) from public, anon, authenticated;

-- The print page's read of one quotation: as 20270629000000, plus the salesperson's mobile and e-mail.
create or replace function public.quotation_get(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare a record; q public.quotations;
begin
  select * into a from public.quotation_actor();
  select * into q from public.quotations where id = p_id;
  if q.id is null or not public.quotation_sees(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_view_all) then
    raise exception 'QUOTATION_NOT_FOUND' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'quotation', to_jsonb(q),
    'owner_name', (select u.full_name from public.users u where u.id = q.owner_id),
    'owner_phone', (select nullif(btrim(u.phone), '') from public.users u where u.id = q.owner_id),
    'owner_email', (select nullif(btrim(u.email), '') from public.users u where u.id = q.owner_id),
    'may_edit', public.quotation_may_edit(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_create, a.p_edit, a.p_view_all),
    'pi', (select jsonb_build_object('id', s.id, 'draft_reference', s.draft_reference, 'status', s.status)
             from public.order_submissions s where s.id = q.pi_submission_id),
    'request', (select jsonb_build_object('id', t.id, 'title', t.title, 'status', t.status, 'created_by', t.created_by, 'assigned_to', t.assigned_to,
                                          'created_at', t.created_at, 'last_update_at', t.last_update_at,
                                          'asked_by', (select u.full_name from public.users u where u.id = t.created_by),
                                          'may_send', t.assigned_to = a.p_uid and t.status not in ('completed', 'cancelled'))
                  from public.tasks t where t.id = q.request_task_id),
    'price', public.quotation_price_state(p_id) || jsonb_build_object('may_decide', a.p_admin or (a.p_edit and a.p_view_all)),
    'areas', coalesce((select jsonb_agg(to_jsonb(x) order by x.position) from public.quotation_areas x where x.quotation_id = p_id), '[]'::jsonb),
    'lines', coalesce((select jsonb_agg(to_jsonb(l) order by l.position) from public.quotation_lines l where l.quotation_id = p_id), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(e order by e.at desc) from (
        select ev.kind, ev.detail, ev.at, (select u.full_name from public.users u where u.id = ev.actor_id) as actor_name
        from public.quotation_events ev where ev.quotation_id = p_id order by ev.at desc limit 30) e), '[]'::jsonb)
  );
end $$;
revoke all on function public.quotation_get(uuid) from public, anon;
grant execute on function public.quotation_get(uuid) to authenticated;

-- The client link: as 20270623000000, plus the salesperson's mobile and e-mail when they have them.
create or replace function public.quotation_public(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare q public.quotations; v record;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{32}$' then return null; end if;
  select * into q from public.quotations where share_token = p_token and status <> 'archived';
  if q.id is null then return null; end if;
  if not exists (select 1 from public.quotation_events e where e.quotation_id = q.id and e.kind = 'opened' and e.at > now() - interval '30 minutes') then
    insert into public.quotation_events (quotation_id, actor_id, kind) values (q.id, auth.uid(), 'opened');
  end if;
  select qv.doc, qv.version_no, qv.created_at into v from public.quotation_versions qv where qv.quotation_id = q.id order by qv.version_no desc limit 1;
  return coalesce(v.doc, public.quotation_client_doc(q.id)) || jsonb_build_object(
    'quote_no', q.quote_no, 'status', q.status,
    'issued_at', coalesce(v.created_at, q.sent_at, q.created_at),
    'version_no', v.version_no,
    'salesperson', (select u.full_name from public.users u where u.id = q.owner_id))
    || jsonb_strip_nulls(jsonb_build_object(
         'salesperson_phone', (select nullif(btrim(u.phone), '') from public.users u where u.id = q.owner_id),
         'salesperson_email', (select nullif(btrim(u.email), '') from public.users u where u.id = q.owner_id)));
end $$;
revoke all on function public.quotation_public(text) from public;
grant execute on function public.quotation_public(text) to anon, authenticated;

do $$
begin
  if has_function_privilege('anon', 'public.quotation_save(uuid, jsonb)', 'execute')
     or has_function_privilege('anon', 'public.quotation_get(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.quotation_client_doc(uuid)', 'execute') then
    raise exception 'QUOTATION_DOCUMENT_FIELDS: function grants are wrong';
  end if;
  if not has_function_privilege('anon', 'public.quotation_public(text)', 'execute') then
    raise exception 'QUOTATION_DOCUMENT_FIELDS: the client link must stay open to anon';
  end if;
  if (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'quotations'
        and column_name in ('project_type', 'seats', 'lead_time_weeks', 'lead_time_reason')) <> 4 then
    raise exception 'QUOTATION_DOCUMENT_FIELDS: a column is missing';
  end if;
end $$;
