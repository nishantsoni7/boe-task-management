-- Exhibition Leads: an email address and a photograph of the card / visitor form on the lead.
--
-- ADDITIVE. Two nullable columns, one private bucket, one function, and the
-- lead's JSON gains two keys. create_exhibition_lead() and update_exhibition_lead()
-- are NOT touched: the form still creates the lead exactly as before, and the
-- email / photo are attached to it by set_exhibition_lead_contact() straight
-- after (and edited later from the lead's own sheet). That keeps the idempotent
-- create path — fingerprint, replay, duplicate-number rules — byte for byte as
-- it was.
--
--   public.exhibition_leads.email            lower-cased, one simple address
--   public.exhibition_leads.card_photo_path  '{uploader uuid}/{uuid}.jpg' in the
--                                            private bucket 'exhibition-lead-cards'.
--                                            Never a URL: the screen asks for a
--                                            short-lived signed URL.
--
-- WHO SEES A PHOTOGRAPH: exactly who sees the lead (its owner and Admin), the
-- same rule as the row itself. Before it is attached, only its uploader.
--
-- ROLLBACK: drop the function and the two policies, drop the two columns, empty
-- and delete the bucket through the Storage API, and re-create
-- exhibition_lead_json() from 20270306000000.

alter table public.exhibition_leads
  add column if not exists email text
    check (email is null or (length(email) <= 120 and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')),
  add column if not exists card_photo_path text
    check (card_photo_path is null
           or card_photo_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$');

-- One photograph belongs to one lead.
create unique index if not exists exhibition_leads_card_photo_path_unique
  on public.exhibition_leads (card_photo_path) where card_photo_path is not null;

-- ═══ The lead's JSON carries both ═══════════════════════════════════════════
-- Same function as 20270306000000, two more keys. Still callable by nobody but
-- the other definer functions.
create or replace function public.exhibition_lead_json(p_lead_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', p_lead.id,
    'exhibition_id', p_lead.exhibition_id,
    'exhibition_name', (select e.name from public.exhibitions e where e.id = p_lead.exhibition_id),
    'contact_name', p_lead.contact_name,
    'phone', p_lead.phone_e164,
    'email', p_lead.email,
    'card_photo_path', p_lead.card_photo_path,
    'client_type', p_lead.client_type,
    'client_type_other', p_lead.client_type_other,
    'requirements', to_jsonb(p_lead.requirements),
    'company_name', p_lead.company_name,
    'project_city', p_lead.project_city,
    'buying_timeline', p_lead.buying_timeline,
    'lead_type', p_lead.lead_type,
    'status', p_lead.status,
    'next_follow_up_on', p_lead.next_follow_up_on,
    'initial_note', p_lead.initial_note,
    'collected_by', p_lead.collected_by,
    'collected_by_name', (select u.full_name from public.users u where u.id = p_lead.collected_by),
    'owner_id', p_lead.owner_id,
    'owner_name', (select u.full_name from public.users u where u.id = p_lead.owner_id),
    'created_at', p_lead.created_at,
    'updated_at', p_lead.updated_at,
    'archived_at', p_lead.archived_at,
    'archive_reason', p_lead.archive_reason,
    'latest_note', (
      select e.note from public.exhibition_lead_events e
      where e.lead_id = p_lead.id and e.event_type = 'note'
      order by e.created_at desc, e.id desc limit 1),
    'latest_note_at', (
      select e.created_at from public.exhibition_lead_events e
      where e.lead_id = p_lead.id and e.event_type = 'note'
      order by e.created_at desc, e.id desc limit 1)
  )
  from public.exhibition_leads p_lead where p_lead.id = p_lead_id;
$$;

revoke all on function public.exhibition_lead_json(uuid) from public, anon, authenticated;

-- ═══ The bucket ═════════════════════════════════════════════════════════════
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('exhibition-lead-cards', 'exhibition-lead-cards', false, 3145728, array['image/jpeg'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- The caller may upload only into their own folder, one JPEG named by a uuid —
-- and only while they may use the module at all.
create or replace function public.exhibition_lead_card_can_upload(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select auth.uid() is not null
     and p_name ~ ('^' || auth.uid()::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$')
     and public.exhibition_leads_user_eligible(auth.uid());
$fn$;
revoke all on function public.exhibition_lead_card_can_upload(text) from public, anon;
grant execute on function public.exhibition_lead_card_can_upload(text) to authenticated;

-- Readable by whoever may see the lead it is attached to; before that, by its uploader.
create or replace function public.exhibition_lead_card_readable(p_name text, p_owner_id text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid   uuid := auth.uid();
  v_owner uuid;
begin
  if v_uid is null or p_name is null or not public.exhibition_leads_user_eligible(v_uid) then
    return false;
  end if;
  select l.owner_id into v_owner from public.exhibition_leads l where l.card_photo_path = p_name;
  if found then
    return v_owner = v_uid
        or exists (select 1 from public.users u where u.id = v_uid and u.role = 'admin');
  end if;
  return p_owner_id is not null and p_owner_id = v_uid::text;
end;
$fn$;
revoke all on function public.exhibition_lead_card_readable(text, text) from public, anon;
grant execute on function public.exhibition_lead_card_readable(text, text) to authenticated;

drop policy if exists exhibition_lead_cards_insert on storage.objects;
create policy exhibition_lead_cards_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'exhibition-lead-cards' and public.exhibition_lead_card_can_upload(name));

drop policy if exists exhibition_lead_cards_select on storage.objects;
create policy exhibition_lead_cards_select on storage.objects
  for select to authenticated
  using (bucket_id = 'exhibition-lead-cards' and public.exhibition_lead_card_readable(name, owner_id));

-- A client may remove only its own upload that no lead names: the clean-up of a
-- save that never completed. A photograph on a lead is never deleted by a client.
drop policy if exists exhibition_lead_cards_delete on storage.objects;
create policy exhibition_lead_cards_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'exhibition-lead-cards'
    and owner_id = auth.uid()::text
    and not exists (select 1 from public.exhibition_leads l where l.card_photo_path = name)
  );

-- ═══ Attaching them ═════════════════════════════════════════════════════════
-- p_changes may carry 'email' (a string, or null / '' to clear) and
-- 'card_photo_path' (a path this caller uploaded, or null to detach). Keys not
-- present are left alone. Idempotent: sending the same thing twice changes
-- nothing the second time, so the outbox may retry it freely.
create or replace function public.set_exhibition_lead_contact(
  p_lead_id uuid, p_changes jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid     uuid;
  v_admin   boolean;
  v_key     text;
  v_old     public.exhibition_leads;
  v_email   text;
  v_path    text;
  v_fields  text[] := '{}';
  v_events  integer;
begin
  select a.p_uid, a.p_is_admin into v_uid, v_admin from public.exhibition_leads_actor() a;
  p_changes := coalesce(p_changes, '{}'::jsonb);
  if jsonb_typeof(p_changes) <> 'object' then
    raise exception 'EXHIBITION_LEADS_INVALID: Changes must be an object' using errcode = '22023';
  end if;
  for v_key in select jsonb_object_keys(p_changes) loop
    if v_key not in ('email', 'card_photo_path') then
      raise exception 'EXHIBITION_LEADS_INVALID: Unknown field' using errcode = '22023';
    end if;
  end loop;

  select * into v_old from public.exhibition_leads l where l.id = p_lead_id for update;
  if not found or not (v_admin or v_old.owner_id = v_uid) then
    raise exception 'EXHIBITION_LEADS_NOT_FOUND: Lead not found' using errcode = 'P0002';
  end if;
  if v_old.archived_at is not null then
    raise exception 'EXHIBITION_LEADS_ARCHIVED: An archived lead cannot be changed' using errcode = '55000';
  end if;

  v_email := v_old.email;
  v_path  := v_old.card_photo_path;

  if p_changes ? 'email' then
    v_email := lower(nullif(btrim(coalesce(p_changes ->> 'email', '')), ''));
    if v_email is not null
       and (length(v_email) > 120 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then
      raise exception 'EXHIBITION_LEADS_INVALID: Enter a valid email address' using errcode = '22023';
    end if;
  end if;

  if p_changes ? 'card_photo_path' then
    v_path := nullif(btrim(coalesce(p_changes ->> 'card_photo_path', '')), '');
    if v_path is not null and v_path is distinct from v_old.card_photo_path then
      -- It must be a file this caller really uploaded, in their own folder.
      if split_part(v_path, '/', 1) <> v_uid::text and not v_admin then
        raise exception 'EXHIBITION_LEADS_INVALID: That photo is not yours to attach' using errcode = '22023';
      end if;
      if not exists (
        select 1 from storage.objects o
         where o.bucket_id = 'exhibition-lead-cards' and o.name = v_path
           and (o.owner_id = v_uid::text or v_admin)
      ) then
        raise exception 'EXHIBITION_LEADS_INVALID: The photo has not finished uploading' using errcode = '22023';
      end if;
      if exists (select 1 from public.exhibition_leads l where l.card_photo_path = v_path and l.id <> v_old.id) then
        raise exception 'EXHIBITION_LEADS_INVALID: That photo already belongs to another lead' using errcode = '22023';
      end if;
    end if;
  end if;

  if v_email is distinct from v_old.email then v_fields := array_append(v_fields, 'email'::text); end if;
  if v_path  is distinct from v_old.card_photo_path then v_fields := array_append(v_fields, 'card_photo'::text); end if;

  if cardinality(v_fields) = 0 then
    return jsonb_build_object('outcome', 'unchanged', 'lead_id', v_old.id);
  end if;

  update public.exhibition_leads l set email = v_email, card_photo_path = v_path where l.id = v_old.id;

  -- Filling these in for the first time, by the collector, right after the lead was created is
  -- part of creating it, not an edit worth a line in the history. Anything later is logged.
  select count(*) into v_events from public.exhibition_lead_events e where e.lead_id = v_old.id;
  if not (v_events = 1 and v_uid = v_old.collected_by
          and v_old.email is null and v_old.card_photo_path is null) then
    insert into public.exhibition_lead_events (lead_id, event_type, actor_id, detail)
    values (v_old.id, 'details_edited', v_uid, jsonb_build_object('fields', to_jsonb(v_fields)));
  end if;

  return jsonb_build_object('outcome', 'updated', 'lead_id', v_old.id);
end;
$$;

revoke all on function public.set_exhibition_lead_contact(uuid, jsonb) from public, anon;
grant execute on function public.set_exhibition_lead_contact(uuid, jsonb) to authenticated;

-- ═══ Executed self-check ════════════════════════════════════════════════════
do $$
begin
  if (select public from storage.buckets where id = 'exhibition-lead-cards') is distinct from false then
    raise exception 'EXHIBITION_LEAD_CARD_ACL: the exhibition-lead-cards bucket must be private';
  end if;
  if has_function_privilege('anon', 'public.set_exhibition_lead_contact(uuid,jsonb)'::regprocedure, 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.set_exhibition_lead_contact(uuid,jsonb)'::regprocedure, 'EXECUTE') then
    raise exception 'EXHIBITION_LEAD_CARD_ACL: wrong execute grants on set_exhibition_lead_contact';
  end if;
  if has_function_privilege('authenticated', 'public.exhibition_lead_json(uuid)'::regprocedure, 'EXECUTE')
     or has_function_privilege('anon', 'public.exhibition_lead_json(uuid)'::regprocedure, 'EXECUTE') then
    raise exception 'EXHIBITION_LEAD_CARD_ACL: exhibition_lead_json became callable by clients';
  end if;
end $$;
