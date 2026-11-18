-- The quotation a quotation request led to, for the request page in Tasks (owner, 18 Nov 2026: Task Management is the
-- front door, the work happens in Quotations). Read-only: one new function, no table and no row changes.
--
-- quotation_for_request(task) returns the quotation linked through quotations.request_task_id (20270629000000), or null
-- when there is none or the caller may not see it (the same quotation_sees rule as quotation_for_pi): its number,
-- status, value before GST, the latest sent version, when it was sent, when the client last opened the link, and the
-- share token (for the WhatsApp message; quotation_get already gives it to the same people).
--
-- Rollback: drop function public.quotation_for_request(uuid).

begin;

create or replace function public.quotation_for_request(p_task_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare a record; q public.quotations;
begin
  if auth.uid() is null or not public.module_entry_open('quotations') then return null; end if;
  select * into a from public.quotation_actor();
  select * into q from public.quotations where request_task_id = p_task_id;
  if q.id is null or not public.quotation_sees(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_view_all) then return null; end if;
  return jsonb_build_object(
    'id', q.id,
    'quote_no', q.quote_no,
    'status', q.status,
    'value_before_gst', public.quotation_value_before_gst(q.id),
    'version_no', (select max(v.version_no) from public.quotation_versions v where v.quotation_id = q.id),
    'sent_at', q.sent_at,
    'last_opened_at', (select max(e.at) from public.quotation_events e where e.quotation_id = q.id and e.kind = 'opened'),
    'share_token', q.share_token,
    'contact_phone', q.contact_phone);
end $$;
revoke all on function public.quotation_for_request(uuid) from public, anon;
grant execute on function public.quotation_for_request(uuid) to authenticated;

do $$
begin
  if has_function_privilege('anon', 'public.quotation_for_request(uuid)', 'execute') then
    raise exception 'QUOTATION_FOR_REQUEST: anon may call it';
  end if;
  if not has_function_privilege('authenticated', 'public.quotation_for_request(uuid)', 'execute') then
    raise exception 'QUOTATION_FOR_REQUEST: authenticated may not call it';
  end if;
end $$;

commit;
