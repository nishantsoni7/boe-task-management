-- 20270615000000_quotation_pi_link.sql
--
-- Quotations, phase 2: Confirm → PI draft. Approved by the owner on 2026-11-12.
--
-- HOW IT WORKS. The browser turns the saved quotation into a PI workbook (src/lib/quotations/piWorkbook.ts) and
-- sends it through the SAME Upload PI path as every PI, as the person pressing Confirm: create_order_submission,
-- the workbook into order-files, POST /api/orders/import/process-draft (the server re-reads it with the PI
-- parser and refuses anything it would refuse from an uploaded workbook). Then quotation_link_pi (below)
-- records which PI draft the quotation became and marks the quotation Confirmed. Nothing here writes to an
-- Orders table: they are only referenced, so every Orders rule, guard and test stays as it is.
--
-- WHY THE PERSON WHO CONFIRMS MUST HAVE MADE THE DRAFT. Orders shows a PI draft only to the person who made it
-- (order_submissions_select), so the link is accepted only for a draft the caller made themselves, still in
-- 'draft'. A draft that is later discarded or deleted clears the link (on delete set null).
--
-- Leads are NOT touched (owner decision 2026-11-12: Lead Board rule 8 of 2026-11-03 stands, "Converted is a
-- record only, no link to Orders").
--
-- ROLLBACK: drop function quotation_link_pi; re-create quotation_get from 20270614000000; drop the two columns
-- and the index; restore quotation_events_kind_check without 'converted' (only after deleting 'converted'
-- events, which the append-only trigger refuses: disable it for that statement).

alter table public.quotations
  add column pi_submission_id uuid references public.order_submissions(id) on delete set null,
  add column pi_linked_at timestamptz;

-- One quotation per PI draft.
create unique index quotations_pi_submission_key on public.quotations (pi_submission_id) where pi_submission_id is not null;

alter table public.quotation_events drop constraint quotation_events_kind_check;
alter table public.quotation_events add constraint quotation_events_kind_check
  check (kind in ('created', 'saved', 'status', 'shared', 'unshared', 'opened', 'converted'));

-- quotation_get, as in 20270614000000, plus 'pi': the linked PI draft's id, reference and status (null when none).
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
    'areas', coalesce((select jsonb_agg(to_jsonb(x) order by x.position) from public.quotation_areas x where x.quotation_id = p_id), '[]'::jsonb),
    'lines', coalesce((select jsonb_agg(to_jsonb(l) order by l.position) from public.quotation_lines l where l.quotation_id = p_id), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(e order by e.at desc) from (
        select ev.kind, ev.detail, ev.at, (select u.full_name from public.users u where u.id = ev.actor_id) as actor_name
        from public.quotation_events ev where ev.quotation_id = p_id order by ev.at desc limit 30) e), '[]'::jsonb)
  );
end $$;
revoke all on function public.quotation_get(uuid) from public, anon;
grant execute on function public.quotation_get(uuid) to authenticated;

-- Record that a Sent or Negotiating quotation became the caller's new PI draft, and mark it Confirmed.
-- Returns {status, pi_submission_id, draft_reference}. Calling it again with the same draft returns the same.
create or replace function public.quotation_link_pi(p_id uuid, p_submission_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare a record; q public.quotations; s record;
begin
  select * into a from public.quotation_actor();
  select * into q from public.quotations where id = p_id for update;
  if q.id is null or not public.quotation_sees(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_view_all) then
    raise exception 'QUOTATION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not public.quotation_may_edit(q.owner_id, q.created_by, a.p_uid, a.p_admin, a.p_create, a.p_edit, a.p_view_all) then
    raise exception 'QUOTATIONS_FORBIDDEN: you may not confirm this quotation' using errcode = '42501';
  end if;
  select os.id, os.created_by, os.status, os.draft_reference into s
    from public.order_submissions os where os.id = p_submission_id for update;
  if s.id is null or s.created_by is distinct from a.p_uid then
    raise exception 'QUOTATION_INVALID: that PI draft is not yours' using errcode = '22023';
  end if;
  if q.pi_submission_id = p_submission_id then
    return jsonb_build_object('status', q.status, 'pi_submission_id', p_submission_id, 'draft_reference', s.draft_reference);
  end if;
  if q.pi_submission_id is not null then
    raise exception 'QUOTATION_LOCKED: this quotation is already linked to a PI' using errcode = '55000';
  end if;
  if exists (select 1 from public.quotations o where o.pi_submission_id = p_submission_id) then
    raise exception 'QUOTATION_INVALID: that PI draft already belongs to another quotation' using errcode = '22023';
  end if;
  if q.status not in ('sent', 'negotiating') then
    raise exception 'QUOTATION_LOCKED: only a Sent or Negotiating quotation can be confirmed into a PI' using errcode = '55000';
  end if;
  if s.status <> 'draft' then
    raise exception 'QUOTATION_INVALID: that PI is no longer a draft' using errcode = '22023';
  end if;
  update public.quotations set status = 'confirmed', pi_submission_id = p_submission_id, pi_linked_at = now() where id = p_id;
  insert into public.quotation_events (quotation_id, actor_id, kind, detail)
  values (p_id, a.p_uid, 'converted', jsonb_build_object('from', q.status, 'pi_submission_id', p_submission_id, 'draft_reference', s.draft_reference));
  return jsonb_build_object('status', 'confirmed', 'pi_submission_id', p_submission_id, 'draft_reference', s.draft_reference);
end $$;
revoke all on function public.quotation_link_pi(uuid, uuid) from public, anon;
grant execute on function public.quotation_link_pi(uuid, uuid) to authenticated;

-- Self-check.
do $$
begin
  if has_function_privilege('anon', 'public.quotation_link_pi(uuid, uuid)', 'execute') then
    raise exception 'QUOTATION_PI_LINK: quotation_link_pi must not be open to anon';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quotations' and column_name = 'pi_submission_id') then
    raise exception 'QUOTATION_PI_LINK: quotations.pi_submission_id is missing';
  end if;
  if has_table_privilege('authenticated', 'public.quotations', 'select') then
    raise exception 'QUOTATION_PI_LINK: the quotations table must stay closed to client roles';
  end if;
end $$;
