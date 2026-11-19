-- 20270811000000_quotation_lead_link.sql
--
-- Quotations: an optional link from a quotation to the Sales lead it came from (owner approved 2026-11-19: "Yes, build PR 1").
--
-- Why: a quotation and a lead were two pipelines nobody joined. A sent quotation had to be logged by hand on the lead to
-- unlock Negotiation, Confirmed did not mark the lead Converted and Lost did not mark it Dead. The builder now shows a Lead
-- card with ONE button that fits the quotation's status. Nothing is automatic: the buttons call the lead's own functions
-- (add_sales_lead_comment, move_sales_lead) from the browser, so the lead's own permission rules, gates and Undo apply
-- unchanged. No lead function is touched here.
--
--   * quotations.lead_id: nullable, one lead per quotation, many quotations per lead. on delete set null.
--   * quotation_link_lead(quotation, lead | null): the caller must be allowed to EDIT the quotation, and to SEE the lead
--     (Sales module open and sales_lead_visible). Null unlinks, which needs the quotation right only.
--   * quotation_lead_info(quotation): the lead's number, name, stage, holder, follow-up, whether the caller may work it, when
--     this quotation was last logged on it, the latest sent version and its value; plus a suggestion (the lead whose phone is
--     the quotation's contact phone, phones are unique across leads). It shows nothing about a lead the caller cannot see.
--   * Nothing client-facing changes: quotation_public and quotation_client_doc pick their fields one by one, lead_id is not one.
--
-- WRITE: one nullable column and one index on public.quotations (existing rows: lead_id stays null), two new functions.
--   A same-day verified backup first (the migration alters a table).
--
-- ROLLBACK: drop function public.quotation_lead_info(uuid); drop function public.quotation_link_lead(uuid, uuid);
--   drop index public.quotations_lead_idx; alter table public.quotations drop column lead_id;

do $$
begin
  if to_regclass('public.sales_leads') is null
     or to_regprocedure('public.sales_lead_visible(uuid, uuid)') is null
     or to_regprocedure('public.normalize_lead_phone(text)') is null
     or to_regprocedure('public.quotation_actor()') is null then
    raise exception 'DEPENDENCY MISSING: sales_leads, sales_lead_visible, normalize_lead_phone and quotation_actor must exist';
  end if;
end $$;

alter table public.quotations add column lead_id uuid references public.sales_leads (id) on delete set null;
create index quotations_lead_idx on public.quotations (lead_id) where lead_id is not null;

-- ═══ Link or unlink ═════════════════════════════════════════════════════════════════════════════════════════════════════

create or replace function public.quotation_link_lead(p_id uuid, p_lead uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare a record; q public.quotations; l public.sales_leads;
begin
  select * into a from public.quotation_actor();
  select * into q from public.quotations where id = p_id for update;
  if q.id is null or not public.quotation_sees(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_view_all) then
    raise exception 'QUOTATION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not public.quotation_may_edit(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_create, a.p_edit, a.p_view_all) then
    raise exception 'QUOTATIONS_FORBIDDEN: you may not change this quotation' using errcode = '42501';
  end if;
  if p_lead is null then
    update public.quotations set lead_id = null where id = p_id and lead_id is not null;
    return;
  end if;
  if not public.module_entry_open('sales') then
    raise exception 'SALES_FORBIDDEN' using errcode = '42501';
  end if;
  select * into l from public.sales_leads where id = p_lead;
  if l.id is null or not public.sales_lead_visible(l.assigned_to, l.created_by) then
    raise exception 'SALES_NOT_FOUND' using errcode = 'P0002';
  end if;
  update public.quotations set lead_id = p_lead where id = p_id and lead_id is distinct from p_lead;
end $$;

-- ═══ What the Lead card shows ═══════════════════════════════════════════════════════════════════════════════════════════

-- Same rule as sales_lead_for_work (20270525000000): the holder, Admin or `assign`, and the lead must be allotted.
create or replace function public.quotation_lead_info(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  a record; q public.quotations; l public.sales_leads; s public.sales_leads;
  v_sales boolean; v_phone text; v_version integer; v_value bigint; v_lead jsonb; v_suggest jsonb;
begin
  select * into a from public.quotation_actor();
  select * into q from public.quotations where id = p_id;
  if q.id is null or not public.quotation_sees(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_view_all) then
    raise exception 'QUOTATION_NOT_FOUND' using errcode = 'P0002';
  end if;
  v_sales := public.module_entry_open('sales');
  select v.version_no, v.value_before_gst into v_version, v_value
  from public.quotation_versions v where v.quotation_id = p_id order by v.version_no desc limit 1;
  v_value := coalesce(v_value, public.quotation_value_before_gst(p_id));

  if v_sales and q.lead_id is not null then
    select * into l from public.sales_leads where id = q.lead_id;
    if l.id is not null and public.sales_lead_visible(l.assigned_to, l.created_by) then
      v_lead := jsonb_build_object(
        'id', l.id, 'lead_no', l.lead_no, 'name', l.name, 'stage', l.stage, 'dead_reason', l.dead_reason,
        'holder_name', (select u.full_name from public.users u where u.id = l.assigned_to),
        'next_step', l.next_step, 'next_due_on', l.next_due_on,
        'may_work', l.assigned_to is not null and (l.assigned_to = a.p_uid or a.p_admin or public.resolve_permission(a.p_uid, 'sales', 'assign')),
        'last_logged_at', (select max(x.at) from public.sales_lead_activities x
                            where x.lead_id = l.id and x.kind = 'quotation' and x.undone_at is null and x.note like '%' || q.quote_no || '%'));
    end if;
  elsif v_sales and q.lead_id is null then
    v_phone := public.normalize_lead_phone(q.contact_phone);
    if v_phone is not null then
      select * into s from public.sales_leads where phone_e164 = v_phone;
      if s.id is not null and public.sales_lead_visible(s.assigned_to, s.created_by) then
        v_suggest := jsonb_build_object('id', s.id, 'lead_no', s.lead_no, 'name', s.name, 'stage', s.stage,
                                        'holder_name', (select u.full_name from public.users u where u.id = s.assigned_to));
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'sales_open', v_sales,
    'linked', q.lead_id is not null,
    'lead', v_lead,
    'suggest', v_suggest,
    'version_no', v_version,
    'value', v_value
  );
end $$;

-- ═══ Who may call what ══════════════════════════════════════════════════════════════════════════════════════════════════

revoke all on function public.quotation_link_lead(uuid, uuid) from public, anon;
revoke all on function public.quotation_lead_info(uuid) from public, anon;
grant execute on function public.quotation_link_lead(uuid, uuid) to authenticated;
grant execute on function public.quotation_lead_info(uuid) to authenticated;

do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quotations' and column_name = 'lead_id') then
    raise exception 'QUOTATION_LEAD_LINK: quotations.lead_id is missing';
  end if;
  if has_function_privilege('anon', 'public.quotation_link_lead(uuid, uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.quotation_lead_info(uuid)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.quotation_link_lead(uuid, uuid)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.quotation_lead_info(uuid)', 'EXECUTE') then
    raise exception 'QUOTATION_LEAD_LINK: the two functions must be callable by signed-in people only';
  end if;
  -- The table stays closed: still no grant for anon or authenticated (every read and write goes through a function).
  if has_table_privilege('anon', 'public.quotations', 'SELECT') or has_table_privilege('authenticated', 'public.quotations', 'SELECT') then
    raise exception 'QUOTATION_LEAD_LINK: public.quotations is open to a client role';
  end if;
end $$;
