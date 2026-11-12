-- 20270621000000_pricing_model_v2.sql
--
-- Pricing model v2 (owner approved 2026-11-12). Read-only: one function, no table, no write.
--
-- pricing_pool(words, exclude) returns every recorded price whose product name shares a word with the asked words
-- (the screen asks for a product TYPE's words, e.g. bed / cot / divan), WITH the parameters the model learns from:
--   order     an APPROVED PI line (last three years): dimensions, material, customization (as finish)
--   won       a line of a CONFIRMED quotation; lost: of a LOST one (the model does not fit lost prices)
--   approved  a line of an open quotation whose current prices the pricing desk approved
--   quote     a line of any other sent or negotiating quotation
-- plus the quotation's client type. The model itself (src/lib/pricing/model.ts) fits these on the screen every time,
-- so every new order, outcome and desk approval changes it. Prices, sizes and materials only; never client names.
--
-- WHO: anyone who may open Quotations (they see the suggestion and its reasons, owner 2026-11-12) or Pricing.
--
-- ROLLBACK: drop function public.pricing_pool(text[], uuid).

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
                                        'material', x.material, 'finish', x.finish, 'client_type', x.client_type) order by x.at desc)
    from (
      select * from (
        select i.product_name as name, i.cost_per_piece::numeric as p, s.approved_at as at, 'order' as k, i.quantity::numeric as q,
               i.dimensions as dims, i.material, i.customization as finish, null::text as client_type
        from public.order_submission_items i join public.order_submissions s on s.id = i.submission_id
        where s.status = 'approved' and s.approved_at > now() - interval '3 years' and i.product_name is not null
          and public.quotation_name_words(i.product_name) && p_words
        union all
        select l.name, l.unit_price::numeric, q.updated_at,
               case when q.status = 'confirmed' then 'won' when q.status = 'lost' then 'lost'
                    when exists (select 1 from public.quotation_price_reviews r where r.quotation_id = q.id and r.decision = 'approved')
                         and public.quotation_price_state(q.id)->>'state' = 'approved' then 'approved'
                    else 'quote' end,
               coalesce(l.qty_fixed, l.qty_per_unit * coalesce(ar.multiplier, 1)),
               l.size_text, l.material, concat_ws(' ', l.finish, l.spec), q.client_type
        from public.quotation_lines l join public.quotations q on q.id = l.quotation_id
        left join public.quotation_areas ar on ar.id = l.area_id
        where q.status in ('sent', 'negotiating', 'confirmed', 'lost') and l.unit_price > 0 and not l.is_optional
          and q.id is distinct from p_exclude and public.quotation_name_words(l.name) && p_words
      ) u order by u.at desc limit 800
    ) x), '[]'::jsonb);
end $$;
revoke all on function public.pricing_pool(text[], uuid) from public, anon;
grant execute on function public.pricing_pool(text[], uuid) to authenticated;

do $$
begin
  if has_function_privilege('anon', 'public.pricing_pool(text[], uuid)', 'execute') then
    raise exception 'PRICING_MODEL_V2: pricing_pool must not be open to anon';
  end if;
end $$;
