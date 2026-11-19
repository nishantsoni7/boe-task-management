-- 20270812000000_quotation_for_lead.sql
--
-- Quotations: the quotations linked to a Sales lead, for the lead popup (owner approved 2026-11-19: "The lead popup lists its
-- quotations and offers Make quotation", the second of three pieces after 20270811000000).
--
--   quotation_for_lead(lead) -> { open, may_create, quotations: [{ id, quote_no, status, updated_at, owner_name, version_no, value }] }
--     * open        false when the caller has no Quotations access at all (the popup then shows nothing).
--     * may_create  Quotations create or Admin (the popup then offers "Make quotation").
--     * quotations  those linked to the lead (quotations.lead_id) that the caller may see (owner, creator, view_all or Admin),
--                   newest first, at most 20; empty for a lead the caller cannot see. version_no and value are the latest SENT
--                   version's (the saved value before any version is sent), the same numbers the Lead card on the quotation shows.
--
-- READ-ONLY: one new function; no table, column, policy, grant on a table or data changes. No backup is needed (a same-day one
--   stands anyway). The popup hides the section when the function is missing, so the code and the migration can go out in either order.
--
-- ROLLBACK: drop function public.quotation_for_lead(uuid);

do $$
begin
  if to_regprocedure('public.quotation_actor()') is null
     or to_regprocedure('public.sales_lead_visible(uuid, uuid)') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quotations' and column_name = 'lead_id') then
    raise exception 'DEPENDENCY MISSING: quotation_actor, sales_lead_visible and quotations.lead_id (20270811000000) must exist';
  end if;
end $$;

create or replace function public.quotation_for_lead(p_lead uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare a record; l public.sales_leads;
begin
  begin
    select * into a from public.quotation_actor();
  exception when insufficient_privilege then
    return jsonb_build_object('open', false, 'may_create', false, 'quotations', '[]'::jsonb);
  end;
  select * into l from public.sales_leads where id = p_lead;
  if l.id is null or not public.sales_lead_visible(l.assigned_to, l.created_by) then
    return jsonb_build_object('open', true, 'may_create', false, 'quotations', '[]'::jsonb);
  end if;
  return jsonb_build_object(
    'open', true,
    'may_create', a.p_create,
    'quotations', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.updated_at desc)
      from (
        select q.id, q.quote_no, q.status, q.updated_at,
               (select u.full_name from public.users u where u.id = q.owner_id) as owner_name,
               (select v.version_no from public.quotation_versions v where v.quotation_id = q.id order by v.version_no desc limit 1) as version_no,
               coalesce((select v.value_before_gst from public.quotation_versions v where v.quotation_id = q.id order by v.version_no desc limit 1),
                        public.quotation_value_before_gst(q.id)) as value
        from public.quotations q
        where q.lead_id = p_lead and public.quotation_sees(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_view_all)
        order by q.updated_at desc
        limit 20
      ) x), '[]'::jsonb)
  );
end $$;

revoke all on function public.quotation_for_lead(uuid) from public, anon;
grant execute on function public.quotation_for_lead(uuid) to authenticated;

do $$
begin
  if has_function_privilege('anon', 'public.quotation_for_lead(uuid)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.quotation_for_lead(uuid)', 'EXECUTE') then
    raise exception 'QUOTATION_FOR_LEAD: the function must be callable by signed-in people only';
  end if;
end $$;
