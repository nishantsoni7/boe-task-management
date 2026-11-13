-- 20270629000000_quotation_links.sql
--
-- Quotations: links back (owner approved 2026-11-13).
--
-- 1. QUOTATION REQUEST → QUOTATION. A quotation request is a Task Management task (task_type 'quotation_request'),
--    raised by a salesperson and assigned to the quotation team. quotation_create_from_request starts a quotation
--    filled from the request (client, contact, project; the requirement as an internal note), linked both ways
--    through quotations.request_task_id, and OWNED BY THE SALESPERSON WHO ASKED (owner decision 2026-11-13); the
--    quotation team member who builds it is its creator and may edit it. "Send to sales" then completes the request
--    in the browser the same way today's Send does (a quotation_sent update, then change_task_status): this
--    migration writes nothing to any Tasks table.
-- 2. PI DRAFT → QUOTATION. quotation_for_pi(submission) tells the PI page which quotation it came from (number and
--    latest sent version), only to people who may see that quotation.
-- 3. REPORTS. quotation_report_revisions(from, to, scope): how many versions confirmed quotations took.
--
-- ROLLBACK: drop functions quotation_create_from_request, quotation_for_pi, quotation_report_revisions; re-create
-- quotation_get from 20270617000000; drop index quotations_request_task_key and column quotations.request_task_id.

alter table public.quotations add column request_task_id uuid references public.tasks(id) on delete set null;
create unique index quotations_request_task_key on public.quotations (request_task_id) where request_task_id is not null;

-- Start (or reopen) the quotation for a quotation request. Returns the quotation id.
create or replace function public.quotation_create_from_request(p_task_id uuid)
returns uuid language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare a record; t record; v_id uuid; v_no text;
begin
  select * into a from public.quotation_actor();
  if not (a.p_create or a.p_edit or a.p_admin) then
    raise exception 'QUOTATIONS_FORBIDDEN: you may not start quotations' using errcode = '42501';
  end if;
  select tk.id, tk.title, tk.note, tk.created_by, tk.assigned_to, tk.status, tk.customer_name, tk.contact_number,
         tk.company_name, tk.city_project
    into t from public.tasks tk where tk.id = p_task_id and tk.task_type = 'quotation_request';
  if t.id is null then raise exception 'QUOTATION_NOT_FOUND: that quotation request does not exist' using errcode = 'P0002'; end if;
  if not (a.p_admin or t.assigned_to = a.p_uid) then
    raise exception 'QUOTATIONS_FORBIDDEN: only the person the request is assigned to may make its quotation' using errcode = '42501';
  end if;
  select q.id into v_id from public.quotations q where q.request_task_id = p_task_id;
  if v_id is not null then return v_id; end if;
  if t.status in ('completed', 'cancelled') then
    raise exception 'QUOTATION_LOCKED: this request is already %', t.status using errcode = '55000';
  end if;
  v_no := 'QT-' || public.quotation_initials(coalesce(t.created_by, a.p_uid)) || '-' || lpad(nextval('public.quotation_no_seq')::text, 5, '0');
  insert into public.quotations (quote_no, client_name, project_name, contact_name, contact_phone, gst_mode, internal_notes,
                                 source, owner_id, created_by, request_task_id)
  values (v_no,
          left(coalesce(nullif(btrim(t.company_name), ''), nullif(btrim(t.customer_name), ''), nullif(btrim(t.title), ''), 'Client'), 160),
          left(nullif(btrim(t.city_project), ''), 160), left(nullif(btrim(t.customer_name), ''), 120), left(nullif(btrim(t.contact_number), ''), 20),
          'igst', left(nullif(concat_ws(E'\n', 'From the quotation request: ' || t.title, t.note), ''), 4000),
          'Quotation request', coalesce(t.created_by, a.p_uid), a.p_uid, p_task_id)
  returning id into v_id;
  insert into public.quotation_events (quotation_id, actor_id, kind, detail)
  values (v_id, a.p_uid, 'created', jsonb_build_object('quote_no', v_no, 'from_request', p_task_id));
  return v_id;
end $$;
revoke all on function public.quotation_create_from_request(uuid) from public, anon;
grant execute on function public.quotation_create_from_request(uuid) to authenticated;

-- quotation_get as in 20270617000000, plus 'request': the request this quotation answers (id, title, status, who asked).
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

-- The quotation a PI draft came from, for the PI page; null when there is none or the viewer may not see it.
create or replace function public.quotation_for_pi(p_submission_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare a record; q public.quotations;
begin
  if auth.uid() is null or not public.module_entry_open('quotations') then return null; end if;
  select * into a from public.quotation_actor();
  select * into q from public.quotations where pi_submission_id = p_submission_id;
  if q.id is null or not public.quotation_sees(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_view_all) then return null; end if;
  return jsonb_build_object('id', q.id, 'quote_no', q.quote_no,
    'version_no', (select max(v.version_no) from public.quotation_versions v where v.quotation_id = q.id));
end $$;
revoke all on function public.quotation_for_pi(uuid) from public, anon;
grant execute on function public.quotation_for_pi(uuid) to authenticated;

-- Revisions to win: for quotations started in the period and confirmed, how many versions each was sent in.
-- Scope as quotation_report: Admin and see-all may ask for 'all'; everyone else gets their own.
create or replace function public.quotation_report_revisions(p_from date, p_to date, p_scope text default 'mine')
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare a record; v_all boolean;
begin
  select * into a from public.quotation_actor();
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 800 then
    raise exception 'QUOTATION_INVALID: choose a period of up to two years' using errcode = '22023';
  end if;
  v_all := p_scope = 'all' and (a.p_admin or a.p_view_all);
  return (
    with won as (
      select q.id, greatest(1, (select count(*) from public.quotation_versions v where v.quotation_id = q.id)) as versions
      from public.quotations q
      where q.status = 'confirmed' and (v_all or q.owner_id = a.p_uid or q.created_by = a.p_uid)
        and (q.created_at at time zone 'Asia/Kolkata')::date between p_from and p_to
    )
    select jsonb_build_object(
      'confirmed', (select count(*) from won),
      'average', (select round(avg(versions)::numeric, 1) from won),
      'buckets', (select jsonb_agg(jsonb_build_object('label', b.label, 'n', (select count(*) from won w where case when b.ord = 4 then w.versions >= 4 else w.versions = b.ord end)) order by b.ord)
                  from (values (1, 'first version'), (2, '2 versions'), (3, '3 versions'), (4, '4 or more')) b(ord, label)))
  );
end $$;
revoke all on function public.quotation_report_revisions(date, date, text) from public, anon;
grant execute on function public.quotation_report_revisions(date, date, text) to authenticated;

do $$
begin
  if has_function_privilege('anon', 'public.quotation_create_from_request(uuid)', 'execute')
     or has_function_privilege('anon', 'public.quotation_for_pi(uuid)', 'execute')
     or has_function_privilege('anon', 'public.quotation_report_revisions(date, date, text)', 'execute') then
    raise exception 'QUOTATION_LINKS: the new functions must not be open to anon';
  end if;
end $$;
