-- 20270619000000_pricing_price_book.sql
--
-- Pricing module, phase 7A: the price book and the suggested price. Approved by the owner on 2026-11-12 ("A: price
-- book + suggestion first"; the cost estimator comes later). Read-only: no table, no write to any business data.
--
-- PRICE POINTS. Every price BOE has given for a product, from what is already recorded:
--   order  an APPROVED PI line (order_submission_items, last three years)
--   won    a line on a CONFIRMED quotation          lost   a line on a LOST quotation
--   quote  a line on a sent or negotiating quotation
-- Products are matched by the words of their names (quotation_name_words, 20270617000000). The suggestion itself is
-- worked out on the screen from these points (src/lib/pricing/suggest.ts), so it changes by itself with every new
-- approved PI and every quotation won or lost: nothing is stored that could go stale.
--
-- WHO: the price book (pricing_price_book) opens for Admin and people granted Pricing (module_entry_open). Points for
-- the names on a quotation come with the price hints (quotation_price_hints, re-created here), which everyone who may
-- open Quotations already sees (owner, 2026-11-12). Prices and quantities only, never client names.
--
-- ROLLBACK: drop pricing_price_book and pricing_points_for; re-create quotation_price_hints from 20270617000000;
-- set the pricing description back to 'Pricing module. Coming soon.' in app_modules and permission_modules.

update public.app_modules set description = 'Pricing: the price book and suggested prices, learned from approved PIs and quotations.' where module_key = 'pricing';
update public.permission_modules set description = 'Pricing: the price book and suggested prices, learned from approved PIs and quotations.' where module_key = 'pricing';

-- Every price point, with the words of its product name (internal).
create or replace function public.pricing_all_points(p_exclude uuid)
returns table (name text, w text[], p numeric, at timestamptz, k text, q numeric)
language sql stable security definer set search_path = public, pg_temp
as $$
  select i.product_name, public.quotation_name_words(i.product_name), i.cost_per_piece::numeric, s.approved_at, 'order', i.quantity::numeric
  from public.order_submission_items i join public.order_submissions s on s.id = i.submission_id
  where s.status = 'approved' and s.approved_at > now() - interval '3 years' and i.product_name is not null
  union all
  select l.name, public.quotation_name_words(l.name), l.unit_price::numeric, q.updated_at,
         case q.status when 'confirmed' then 'won' when 'lost' then 'lost' else 'quote' end,
         coalesce(l.qty_fixed, l.qty_per_unit * coalesce(ar.multiplier, 1))
  from public.quotation_lines l join public.quotations q on q.id = l.quotation_id
  left join public.quotation_areas ar on ar.id = l.area_id
  where q.status in ('sent', 'negotiating', 'confirmed', 'lost') and l.unit_price > 0 and not l.is_optional
    and q.id is distinct from p_exclude
$$;
revoke all on function public.pricing_all_points(uuid) from public, anon, authenticated;

-- The newest 30 points for each asked name (same matching as the hints: every word, at most three more) (internal).
create or replace function public.pricing_points_for(p_names text[], p_exclude uuid)
returns table (name text, points jsonb)
language sql stable security definer set search_path = public, pg_temp
as $$
  with asked as (
    select distinct n as name, public.quotation_name_words(n) as w from unnest(p_names) n where n is not null and btrim(n) <> ''
  ), pts as (select * from public.pricing_all_points(p_exclude))
  select a.name, coalesce((
    select jsonb_agg(jsonb_build_object('p', x.p, 'at', x.at, 'k', x.k, 'q', x.q) order by x.at desc)
    from (select pt.* from pts pt where cardinality(a.w) > 0 and pt.w @> a.w and cardinality(pt.w) <= cardinality(a.w) + 3
          order by pt.at desc limit 30) x), '[]'::jsonb)
  from asked a
$$;
revoke all on function public.pricing_points_for(text[], uuid) from public, anon, authenticated;

-- The hints of 20270617000000, now carrying the points the suggestion is worked out from.
create or replace function public.quotation_price_hints(p_names text[], p_exclude uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare a record;
begin
  select * into a from public.quotation_actor();
  if coalesce(array_length(p_names, 1), 0) > 80 then raise exception 'QUOTATION_INVALID: too many names' using errcode = '22023'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('name', h.name, 'ordered', h.ordered, 'quoted', h.quoted, 'points', pf.points))
                   from public.quotation_price_history(p_names, p_exclude) h
                   left join public.pricing_points_for(p_names, p_exclude) pf on pf.name = h.name), '[]'::jsonb);
end $$;
revoke all on function public.quotation_price_hints(text[], uuid) from public, anon;
grant execute on function public.quotation_price_hints(text[], uuid) to authenticated;

-- The price book: one row per product family (the same name words), newest activity first. p_search keeps families
-- whose words include every word searched for.
create or replace function public.pricing_price_book(p_search text default null, p_limit integer default 200)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v_words text[] := public.quotation_name_words(p_search);
begin
  if auth.uid() is null or not public.module_entry_open('pricing') then
    raise exception 'PRICING_FORBIDDEN: the Pricing module is not open to you' using errcode = '42501';
  end if;
  return coalesce((
    with pts as (select * from public.pricing_all_points(null) where cardinality(w) > 0),
    fam as (
      select array_to_string(w, ' ') as key, w,
             mode() within group (order by name) as name, count(distinct lower(btrim(name))) as variants,
             count(*) filter (where k = 'order') as orders, count(*) filter (where k = 'won') as won,
             count(*) filter (where k = 'lost') as lost, count(*) filter (where k = 'quote') as open_quotes,
             max(at) as last_at,
             (select jsonb_agg(jsonb_build_object('p', x.p, 'at', x.at, 'k', x.k, 'q', x.q) order by x.at desc)
                from (select p2.p, p2.at, p2.k, p2.q from pts p2 where p2.w = pts.w order by p2.at desc limit 30) x) as points
      from pts
      where coalesce(cardinality(v_words), 0) = 0 or w @> v_words
      group by w
    )
    select jsonb_agg(jsonb_build_object('key', key, 'name', name, 'variants', variants, 'orders', orders, 'won', won, 'lost', lost,
                                        'open_quotes', open_quotes, 'last_at', last_at, 'points', points) order by last_at desc)
    from (select * from fam order by last_at desc limit least(greatest(coalesce(p_limit, 200), 1), 500)) f
  ), '[]'::jsonb);
end $$;
revoke all on function public.pricing_price_book(text, integer) from public, anon;
grant execute on function public.pricing_price_book(text, integer) to authenticated;

do $$
begin
  if has_function_privilege('authenticated', 'public.pricing_all_points(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.pricing_points_for(text[], uuid)', 'execute')
     or has_function_privilege('anon', 'public.pricing_price_book(text, integer)', 'execute') then
    raise exception 'PRICING_PRICE_BOOK: internal functions must stay closed';
  end if;
  if (select description from public.app_modules where module_key = 'pricing') is distinct from
     (select description from public.permission_modules where module_key = 'pricing') then
    raise exception 'PRICING_PRICE_BOOK: the two descriptions must agree';
  end if;
end $$;
