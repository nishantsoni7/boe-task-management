-- Pricing: the echo guard (Price Brain v2, phase 3A; owner approved 23 Nov 2026, answer P3: "left out entirely").
-- A quotation line whose price was set with the suggestion's "Use" button, and not changed afterwards, is the model's
-- own guess: learning it back would make the model agree with itself. The builder writes "[Used suggestion N]" into the
-- line's internal note when "Use" sets the price N (never shown to a client, like the taught pick's tag). A line whose
-- price still equals N is left out of the price points; once somebody types another price it counts again.
--
-- Changes (no table, column or row changes, so no backup is needed):
--   new   pricing_used_suggestion(note, price)  immutable, internal (no client may call it)
--   re-created pricing_all_points(uuid) and pricing_pool(text[], uuid): the same as 20270715000000, plus
--         "and not public.pricing_used_suggestion(l.internal_note, l.unit_price)" on the quotation-line branch.
--
-- Rollback: run both functions from 20270715000000_pricing_learning.sql again, then
--   drop function public.pricing_used_suggestion(text, numeric);

begin;

create or replace function public.pricing_used_suggestion(p_note text, p_price numeric)
returns boolean language sql immutable set search_path = public, pg_temp
as $$
  select coalesce((substring(coalesce(p_note, '') from '\[Used suggestion ([0-9]+)\]'))::numeric = p_price, false)
$$;
revoke all on function public.pricing_used_suggestion(text, numeric) from public, anon, authenticated;

create or replace function public.pricing_all_points(p_exclude uuid)
returns table (name text, w text[], p numeric, at timestamptz, k text, q numeric)
language sql stable security definer set search_path = public, pg_temp
as $$
  select i.product_name, public.quotation_name_words(i.product_name), i.cost_per_piece::numeric, s.approved_at, 'order', i.quantity::numeric
  from public.order_submission_items i join public.order_submissions s on s.id = i.submission_id
  where s.status = 'approved' and s.approved_at > now() - interval '3 years' and i.product_name is not null
  union all
  select l.name, public.quotation_name_words(l.name), l.unit_price::numeric, p.pi_date::timestamptz, 'order', l.qty::numeric
  from public.pricing_learning_lines l join public.pricing_learning_pis p on p.id = l.pi_id
  where not l.left_out and not p.left_out and p.pi_date > (now() - interval '3 years')::date
  union all
  select l.name, public.quotation_name_words(l.name), l.unit_price::numeric, q.updated_at,
         case q.status when 'confirmed' then 'won' when 'lost' then 'lost' else 'quote' end,
         coalesce(l.qty_fixed, l.qty_per_unit * coalesce(ar.multiplier, 1))
  from public.quotation_lines l join public.quotations q on q.id = l.quotation_id
  left join public.quotation_areas ar on ar.id = l.area_id
  where q.status in ('sent', 'negotiating', 'confirmed', 'lost') and l.unit_price > 0 and not l.is_optional
    and q.id is distinct from p_exclude
    and not public.pricing_used_suggestion(l.internal_note, l.unit_price)
$$;
revoke all on function public.pricing_all_points(uuid) from public, anon, authenticated;

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
        select l.name, l.unit_price::numeric, p.pi_date::timestamptz, 'order', l.qty::numeric, l.size_text, l.material, l.customization, p.client_type
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
               l.size_text, l.material, concat_ws(' ', l.finish, l.spec), q.client_type
        from public.quotation_lines l join public.quotations q on q.id = l.quotation_id
        left join public.quotation_areas ar on ar.id = l.area_id
        where q.status in ('sent', 'negotiating', 'confirmed', 'lost') and l.unit_price > 0 and not l.is_optional
          and q.id is distinct from p_exclude and public.quotation_name_words(l.name) && p_words
          and not public.pricing_used_suggestion(l.internal_note, l.unit_price)
      ) u order by u.at desc limit 2500
    ) x), '[]'::jsonb);
end $$;
revoke all on function public.pricing_pool(text[], uuid) from public, anon;
grant execute on function public.pricing_pool(text[], uuid) to authenticated;

do $$
begin
  if public.pricing_used_suggestion('Darker [Used suggestion 4790]', 4790) is not true
     or public.pricing_used_suggestion('[Used suggestion 4790]', 5000) is not false
     or public.pricing_used_suggestion(null, 4790) is not false
     or public.pricing_used_suggestion('no tag', 4790) is not false then
    raise exception 'pricing_used_suggestion: the tag is not read as written';
  end if;
  if has_function_privilege('anon', 'public.pricing_pool(text[], uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.pricing_all_points(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.pricing_used_suggestion(text, numeric)', 'execute') then
    raise exception 'pricing echo guard: a function is open to a role it must not be open to';
  end if;
end $$;

commit;
