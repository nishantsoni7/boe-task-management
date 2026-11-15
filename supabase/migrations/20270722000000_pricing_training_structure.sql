-- Pricing > Training: the wooden structure is priced as ONE row (owner, 2026-11-15, after the first real case).
-- A chair's frame, arms and legs are made in one go and quoted as one structure price, not per cubic foot.
-- The person may also say how much of that price is the wood; the rest is labour and hardware. That split is
-- optional, and it is what lets a price be worked out for another wood later.
--
-- Adds: kind 'structure' on pricing_training_lines, and the nullable column wood_amount (never more than the
-- amount). pricing_training_save is re-created only to store wood_amount; nothing else in it changes.
-- pricing_training_get already returns every column of a line.
--
-- Rollback: re-create pricing_training_save from 20270720000000, then
--   alter table public.pricing_training_lines drop column wood_amount;
--   update public.pricing_training_lines set kind = 'material' where kind = 'structure';
--   and restore the kind check without 'structure'.

begin;

alter table public.pricing_training_lines drop constraint pricing_training_lines_kind_check;
alter table public.pricing_training_lines add constraint pricing_training_lines_kind_check
  check (kind in ('structure', 'material', 'labour', 'overhead', 'margin', 'other'));
alter table public.pricing_training_lines add column wood_amount numeric(12,2)
  check (wood_amount is null or (wood_amount >= 0 and wood_amount <= amount));

create or replace function public.pricing_training_save(p_id uuid, p_doc jsonb)
returns uuid language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare a record; v_id uuid := p_id; v_status text; v_owner uuid; l jsonb; n int := 0;
begin
  select * into a from public.pricing_training_actor();
  if not a.p_create then
    raise exception 'PRICING_TRAINING_FORBIDDEN: you may not teach cases' using errcode = '42501';
  end if;
  if jsonb_typeof(coalesce(p_doc->'lines', '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_doc->'lines', '[]'::jsonb)) > 60 then
    raise exception 'PRICING_TRAINING_INVALID: at most 60 elements' using errcode = '22023';
  end if;
  begin
    if v_id is null then
      insert into public.pricing_training_cases (created_by, name, variant, width_in, depth_in, height_in, image_path, ai_reading, sold_price, notes)
      values (a.p_uid, btrim(coalesce(p_doc->>'name', '')), nullif(btrim(coalesce(p_doc->>'variant', '')), ''),
              nullif(p_doc->>'width_in', '')::numeric, nullif(p_doc->>'depth_in', '')::numeric, nullif(p_doc->>'height_in', '')::numeric,
              nullif(p_doc->>'image_path', ''), case when jsonb_typeof(p_doc->'ai_reading') = 'object' then p_doc->'ai_reading' end,
              nullif(p_doc->>'sold_price', '')::numeric, nullif(btrim(coalesce(p_doc->>'notes', '')), ''))
      returning id into v_id;
    else
      select status, created_by into v_status, v_owner from public.pricing_training_cases where id = v_id for update;
      if not found then
        raise exception 'PRICING_TRAINING_NOT_FOUND: this case does not exist' using errcode = 'P0002';
      end if;
      if v_owner <> a.p_uid or v_status not in ('draft', 'sent_back') then
        raise exception 'PRICING_TRAINING_LOCKED: only its maker can change a case, and only before it is sent or after it is sent back' using errcode = '42501';
      end if;
      update public.pricing_training_cases set
        name = btrim(coalesce(p_doc->>'name', '')), variant = nullif(btrim(coalesce(p_doc->>'variant', '')), ''),
        width_in = nullif(p_doc->>'width_in', '')::numeric, depth_in = nullif(p_doc->>'depth_in', '')::numeric, height_in = nullif(p_doc->>'height_in', '')::numeric,
        image_path = nullif(p_doc->>'image_path', ''),
        ai_reading = case when jsonb_typeof(p_doc->'ai_reading') = 'object' then p_doc->'ai_reading' end,
        sold_price = nullif(p_doc->>'sold_price', '')::numeric, notes = nullif(btrim(coalesce(p_doc->>'notes', '')), ''),
        updated_at = now()
      where id = v_id;
      delete from public.pricing_training_lines where case_id = v_id;
    end if;
    for l in select * from jsonb_array_elements(coalesce(p_doc->'lines', '[]'::jsonb)) loop
      n := n + 1;
      insert into public.pricing_training_lines (case_id, position, element, kind, material, quantity, unit, rate, amount, reasoning, from_ai, wood_amount)
      values (v_id, n, btrim(coalesce(l->>'element', '')), coalesce(nullif(l->>'kind', ''), 'material'),
              nullif(btrim(coalesce(l->>'material', '')), ''), nullif(l->>'quantity', '')::numeric, nullif(btrim(coalesce(l->>'unit', '')), ''),
              nullif(l->>'rate', '')::numeric, coalesce(nullif(l->>'amount', '')::numeric, 0),
              nullif(btrim(coalesce(l->>'reasoning', '')), ''), coalesce((l->>'from_ai')::boolean, false), nullif(l->>'wood_amount', '')::numeric);
    end loop;
  exception when check_violation or numeric_value_out_of_range or string_data_right_truncation or invalid_text_representation or not_null_violation then
    raise exception 'PRICING_TRAINING_INVALID: check the case (%)', sqlerrm using errcode = '22023';
  end;
  return v_id;
end $$;
revoke all on function public.pricing_training_save(uuid, jsonb) from public, anon;
grant execute on function public.pricing_training_save(uuid, jsonb) to authenticated;

do $$
begin
  if has_table_privilege('authenticated', 'public.pricing_training_lines', 'select') or has_table_privilege('anon', 'public.pricing_training_lines', 'select') then
    raise exception 'pricing_training_structure: the lines table must stay closed';
  end if;
  if has_function_privilege('anon', 'public.pricing_training_save(uuid, jsonb)', 'execute') then
    raise exception 'pricing_training_structure: save must not be open to anon';
  end if;
end $$;

commit;
