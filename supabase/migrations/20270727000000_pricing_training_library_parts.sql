-- Pricing > Training, step 3 (owner, 2026-11-16: "Defaults are fine"): on a quotation line a picked taught product
-- can be told "this one is different": leave out an element, or add one taught on another case.
--
-- Changes: pricing_training_library() is re-created, the same as in 20270726000000, with one more key on every case:
-- parts = its material, labour and other elements with their amounts. The wooden structure, overhead and margin are
-- never in parts (they cannot be left out), and stay in lines, which only people who may open Pricing receive.
-- No table changes.
--
-- Rollback: run the function from 20270726000000_pricing_training_library.sql again.

begin;

create or replace function public.pricing_training_library()
returns jsonb language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare v_uid uuid := auth.uid(); v_admin boolean; v_sees boolean;
begin
  if v_uid is not null then
    select (u.role = 'admin') into v_admin from public.users u
    where u.id = v_uid and u.is_active and not coalesce(u.is_deleted, false);
  end if;
  if v_admin is null or not (public.module_entry_open('quotations') or public.module_entry_open('pricing')) then
    raise exception 'PRICING_FORBIDDEN: neither Quotations nor Pricing is open to you' using errcode = '42501';
  end if;
  v_sees := public.module_entry_open('pricing') and (v_admin or public.resolve_permission(v_uid, 'pricing', 'view'));

  return jsonb_build_object(
    'woods', coalesce((select jsonb_agg(w.name order by lower(w.name)) from public.pricing_woods w), '[]'::jsonb),
    'cases', coalesce((
      select jsonb_agg(
        jsonb_build_object('id', c.id, 'case_no', c.case_no, 'name', c.name, 'variant', c.variant, 'image_path', c.image_path,
          'total', t.total, 'wood', s.material, 'wood_amount', s.wood_amount,
          'in_wood', coalesce((
            select jsonb_object_agg(lower(btrim(w.name)), round(t.total - s.wood_amount + s.wood_amount * w.rate / own.rate))
            from public.pricing_woods own, public.pricing_woods w
            where lower(btrim(own.name)) = lower(btrim(s.material)) and own.rate is not null and s.wood_amount is not null
              and w.rate is not null and w.id <> own.id), '{}'::jsonb))
        -- The elements a line may leave out or borrow: never the structure, overhead or margin. Their amounts go to
        -- everyone who can quote, because leaving one out changes the price by exactly that amount anyway.
        || jsonb_build_object('parts', coalesce((
             select jsonb_agg(jsonb_build_object('element', l.element, 'kind', l.kind, 'amount', l.amount) order by l.position)
             from public.pricing_training_lines l where l.case_id = c.id and l.kind in ('material', 'labour', 'other')), '[]'::jsonb))
        || case when v_sees then jsonb_build_object('lines', (
             select jsonb_agg(jsonb_build_object('element', l.element, 'kind', l.kind, 'amount', l.amount, 'material', l.material) order by l.position)
             from public.pricing_training_lines l where l.case_id = c.id)) else '{}'::jsonb end
        order by c.case_no desc)
      from public.pricing_training_cases c
      cross join lateral (select coalesce(sum(l.amount), 0) as total from public.pricing_training_lines l where l.case_id = c.id) t
      -- The first structure row that names a wood: that is the wood the case was priced in.
      left join lateral (select l.material, l.wood_amount from public.pricing_training_lines l
                         where l.case_id = c.id and l.kind = 'structure' and btrim(coalesce(l.material, '')) <> ''
                         order by l.position limit 1) s on true
      where c.status = 'submitted'), '[]'::jsonb));
end $$;
revoke all on function public.pricing_training_library() from public, anon;
grant execute on function public.pricing_training_library() to authenticated;

do $$
begin
  if has_function_privilege('anon', 'public.pricing_training_library()', 'execute') then
    raise exception 'pricing_training_library: must not be open to anon';
  end if;
end $$;

commit;
