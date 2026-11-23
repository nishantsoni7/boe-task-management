-- Pricing: engine v3's inputs (Price Brain v2, phase 3C; owner approved 23 Nov 2026). The price model learns from the
-- photo facts (20270825000000) and from the submitted Training cases, next to today's prices. Engine v3 leads a product
-- type only where it beats today's model on the blind test; that choice is made in the browser (src/lib/pricing/exam.ts).
--
-- Changes (no table, column or row changes, so no backup is needed):
--   re-created pricing_pool(text[], uuid): the same as 20270824000000, plus
--     * "f": the photo facts of each price's product photo, when it has been read (without the reader's note);
--     * the submitted Training cases as prices of kind 'taught': a case priced as a selling price ("price_level"
--       selling), per piece (no "per_set"), its price the sum of its elements, its size its width x depth x height,
--       its material the wood of its first structure row. Engine v3 learns from them; today's model ignores them.
--   new pricing_photo_facts_for(keys text[]): the facts of up to 200 photos, so a quotation line with a read photo is
--     priced for what it shows. Open to whoever may open Quotations or Pricing (the same door as pricing_pool); it
--     answers facts only, never a price, a name or a file.
--
-- Rollback: run pricing_pool from 20270824000000_pricing_echo_guard.sql again, then
--   drop function public.pricing_photo_facts_for(text[]);

begin;

create or replace function public.pricing_pool(p_words text[], p_exclude uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not (public.module_entry_open('quotations') or public.module_entry_open('pricing')) then
    raise exception 'PRICING_FORBIDDEN: neither Quotations nor Pricing is open to you' using errcode = '42501';
  end if;
  if coalesce(array_length(p_words, 1), 0) = 0 or array_length(p_words, 1) > 40 then
    raise exception 'PRICING_INVALID: ask for 1 to 40 words' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('name', x.name, 'p', x.p, 'at', x.at, 'k', x.k, 'q', x.q, 'dims', x.dims,
                                        'material', x.material, 'finish', x.finish, 'client_type', x.client_type)
                     || case when x.f is null then '{}'::jsonb else jsonb_build_object('f', x.f - 'note' - 'confidence') end
                     order by x.at desc)
    from (
      select * from (
        select i.product_name as name, i.cost_per_piece::numeric as p, s.approved_at as at, 'order' as k, i.quantity::numeric as q,
               i.dimensions as dims, i.material, i.customization as finish, null::text as client_type, pf.facts as f
        from public.order_submission_items i join public.order_submissions s on s.id = i.submission_id
        left join public.pricing_photo_facts pf on pf.image_key = 'order-files/' || i.image_storage_path
        where s.status = 'approved' and s.approved_at > now() - interval '3 years' and i.product_name is not null
          and public.quotation_name_words(i.product_name) && p_words
        union all
        select l.name, l.unit_price::numeric, p.pi_date::timestamptz, 'order', l.qty::numeric, l.size_text, l.material, l.customization, p.client_type, null::jsonb
        from public.pricing_learning_lines l join public.pricing_learning_pis p on p.id = l.pi_id
        where not l.left_out and not p.left_out and p.pi_date > (now() - interval '3 years')::date
          and public.quotation_name_words(l.name) && p_words
        union all
        select l.name, l.unit_price::numeric, q.updated_at,
               case when q.status = 'confirmed' then 'won' when q.status = 'lost' then 'lost'
                    when exists (select 1 from public.quotation_price_reviews r where r.quotation_id = q.id and r.decision = 'approved')
                         and public.quotation_price_state(q.id)->>'state' = 'approved' then 'approved'
                    else 'quote' end,
               coalesce(l.qty_fixed, l.qty_per_unit * coalesce(ar.multiplier, 1)),
               l.size_text, l.material, concat_ws(' ', l.finish, l.spec), q.client_type, pf.facts
        from public.quotation_lines l join public.quotations q on q.id = l.quotation_id
        left join public.quotation_areas ar on ar.id = l.area_id
        left join public.pricing_photo_facts pf on pf.image_key = 'quotation-images/' || l.image_path
        where q.status in ('sent', 'negotiating', 'confirmed', 'lost') and l.unit_price > 0 and not l.is_optional
          and q.id is distinct from p_exclude and public.quotation_name_words(l.name) && p_words
          and not public.pricing_used_suggestion(l.internal_note, l.unit_price)
        union all
        select c.name, t.total, coalesce(c.submitted_at, c.updated_at), 'taught', 1::numeric,
               nullif(concat_ws(' x ', trim_scale(c.width_in), trim_scale(c.depth_in), trim_scale(c.height_in)), ''),
               w.material, null::text, null::text, pf.facts
        from public.pricing_training_cases c
        cross join lateral (select coalesce(sum(l.amount), 0) as total from public.pricing_training_lines l where l.case_id = c.id) t
        -- The first structure row that names a wood: the wood the case was priced in (as in pricing_training_library).
        left join lateral (select l.material from public.pricing_training_lines l
                           where l.case_id = c.id and l.kind = 'structure' and btrim(coalesce(l.material, '')) <> ''
                           order by l.position limit 1) w on true
        left join public.pricing_photo_facts pf on pf.image_key = 'pricing-training/' || c.image_path
        where c.status = 'submitted' and c.price_level = 'selling' and c.per_set is null and t.total > 0
          and public.quotation_name_words(c.name) && p_words
      ) u order by u.at desc limit 2500
    ) x), '[]'::jsonb);
end $$;
revoke all on function public.pricing_pool(text[], uuid) from public, anon;
grant execute on function public.pricing_pool(text[], uuid) to authenticated;

create or replace function public.pricing_photo_facts_for(p_keys text[])
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not (public.module_entry_open('quotations') or public.module_entry_open('pricing')) then
    raise exception 'PRICING_FORBIDDEN: neither Quotations nor Pricing is open to you' using errcode = '42501';
  end if;
  if coalesce(array_length(p_keys, 1), 0) > 200 then
    raise exception 'PRICING_INVALID: ask for at most 200 photos' using errcode = '22023';
  end if;
  return coalesce((select jsonb_object_agg(f.image_key, f.facts - 'note' - 'confidence')
                   from public.pricing_photo_facts f where f.image_key = any(p_keys)), '{}'::jsonb);
end $$;
revoke all on function public.pricing_photo_facts_for(text[]) from public, anon;
grant execute on function public.pricing_photo_facts_for(text[]) to authenticated;

do $$
begin
  if has_function_privilege('anon', 'public.pricing_pool(text[], uuid)', 'execute')
     or has_function_privilege('anon', 'public.pricing_photo_facts_for(text[])', 'execute')
     or not has_function_privilege('authenticated', 'public.pricing_photo_facts_for(text[])', 'execute') then
    raise exception 'pricing engine v3: a function is open to a role it must not be open to, or closed to one it must be open to';
  end if;
end $$;

commit;
