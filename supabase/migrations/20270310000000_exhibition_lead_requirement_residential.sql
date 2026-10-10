-- Exhibition Leads — a third Requirement option: Residential.
--
-- Requirement was a closed pair (restaurant_cafe, hotel) held in three places:
-- the CHECK on exhibition_leads.requirements, and the validation inside
-- create_exhibition_lead() and update_exhibition_lead(). All three are widened
-- to include 'residential' (up to three picks). Nothing else changes: existing
-- rows already satisfy the wider rule, and both functions are re-issued
-- verbatim from 20270305000000 apart from the allowed list.

alter table public.exhibition_leads
  drop constraint if exists exhibition_leads_requirements_check;

alter table public.exhibition_leads
  add constraint exhibition_leads_requirements_check check (
    cardinality(requirements) between 1 and 3
    and requirements <@ array['restaurant_cafe','hotel','residential']::text[]);

create or replace function public.create_exhibition_lead(
  p_submission_id   uuid,
  p_exhibition_id   uuid,
  p_contact_name    text,
  p_phone           text,
  p_client_type     text,
  p_requirements    text[],
  p_company_name    text default null,
  p_project_city    text default null,
  p_buying_timeline text default null,
  p_lead_type       text default null,
  p_note            text default null,
  p_client_type_other text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid     uuid;
  v_admin   boolean;
  v_phone   text;
  v_name    text := btrim(coalesce(p_contact_name, ''));
  v_company text := nullif(btrim(coalesce(p_company_name, '')), '');
  v_city    text := nullif(btrim(coalesce(p_project_city, '')), '');
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
  v_lead    text := nullif(btrim(coalesce(p_lead_type, '')), '');
  v_other   text := nullif(btrim(coalesce(p_client_type_other, '')), '');
  v_id      uuid;
  v_fp      text;
  v_existing public.exhibition_leads;
begin
  select a.p_uid, a.p_is_admin into v_uid, v_admin from public.exhibition_leads_actor() a;

  if p_submission_id is null then
    raise exception 'EXHIBITION_LEADS_INVALID: A submission id is required' using errcode = '22023';
  end if;
  if v_name = '' then
    raise exception 'EXHIBITION_LEADS_INVALID: Enter the contact name' using errcode = '22023';
  end if;
  v_phone := public.normalize_lead_phone(p_phone);
  if v_phone is null then
    raise exception 'EXHIBITION_LEADS_INVALID: Enter a valid mobile number' using errcode = '22023';
  end if;
  if p_client_type is null or p_client_type not in
     ('architect_designer','property_owner','consultant','other') then
    raise exception 'EXHIBITION_LEADS_INVALID: Choose a client type' using errcode = '22023';
  end if;
  if p_client_type = 'other' then
    if v_other is null then
      raise exception 'EXHIBITION_LEADS_INVALID: Say what kind of client this is' using errcode = '22023';
    end if;
  else
    v_other := null;
  end if;
  if length(coalesce(v_other, '')) > 200 then
    raise exception 'EXHIBITION_LEADS_INVALID: The client description is too long' using errcode = '22023';
  end if;
  if p_requirements is null or cardinality(p_requirements) = 0 then
    raise exception 'EXHIBITION_LEADS_INVALID: Choose at least one requirement' using errcode = '22023';
  end if;
  if not (p_requirements <@ array['restaurant_cafe','hotel','residential']::text[]) then
    raise exception 'EXHIBITION_LEADS_INVALID: Unknown requirement' using errcode = '22023';
  end if;
  if length(v_name) > 120 or length(coalesce(v_company, '')) > 160
     or length(coalesce(v_city, '')) > 80 or length(coalesce(v_note, '')) > 2000 then
    raise exception 'EXHIBITION_LEADS_INVALID: A field is too long' using errcode = '22023';
  end if;
  if p_buying_timeline is not null and p_buying_timeline not in
     ('within_1_month','1_3_months','3_6_months','later','not_sure') then
    raise exception 'EXHIBITION_LEADS_INVALID: Unknown buying timeline' using errcode = '22023';
  end if;
  if v_lead is null then
    raise exception 'EXHIBITION_LEADS_INVALID: Choose a lead type' using errcode = '22023';
  end if;
  if v_lead not in ('hot','warm','long_term','mismatched_retail') then
    raise exception 'EXHIBITION_LEADS_INVALID: Unknown lead type' using errcode = '22023';
  end if;
  if not exists (select 1 from public.exhibitions e where e.id = p_exhibition_id and e.is_active) then
    raise exception 'EXHIBITION_LEADS_INVALID: Unknown exhibition' using errcode = '22023';
  end if;

  v_fp := md5(concat_ws('|', p_exhibition_id, v_name, v_phone, p_client_type,
                        array_to_string(array(select r from unnest(p_requirements) r order by r), ','),
                        coalesce(v_company, ''), coalesce(v_city, ''), coalesce(p_buying_timeline, ''),
                        coalesce(v_lead, ''), coalesce(v_other, ''), coalesce(v_note, '')));

  -- Retry of an entry we already stored: answer with it, change nothing — and
  -- only when it really is the same entry.
  select * into v_existing from public.exhibition_leads l where l.submission_id = p_submission_id;
  if found then
    if v_existing.collected_by <> v_uid then
      raise exception 'EXHIBITION_LEADS_INVALID: Submission id already used' using errcode = '22023';
    end if;
    if v_existing.submission_fingerprint <> v_fp then
      raise exception 'EXHIBITION_LEADS_SUBMISSION_CONFLICT: This submission id was already saved with different details'
        using errcode = '22023';
    end if;
    return jsonb_build_object('outcome', 'replayed', 'lead_id', v_existing.id);
  end if;

  -- DO NOTHING covers both unique indexes; whichever fired is told apart below.
  insert into public.exhibition_leads
    (exhibition_id, submission_id, submission_fingerprint, contact_name, phone_e164, client_type, client_type_other,
     requirements, company_name, project_city, buying_timeline, lead_type, initial_note, collected_by, owner_id)
  values
    (p_exhibition_id, p_submission_id, v_fp, v_name, v_phone, p_client_type, v_other,
     p_requirements, v_company, v_city, p_buying_timeline, v_lead, v_note, v_uid, v_uid)
  on conflict do nothing
  returning id into v_id;

  if v_id is not null then
    insert into public.exhibition_lead_events (lead_id, event_type, actor_id)
    values (v_id, 'created', v_uid);
    return jsonb_build_object('outcome', 'created', 'lead_id', v_id);
  end if;

  -- Same submission won a race against us.
  select * into v_existing from public.exhibition_leads l where l.submission_id = p_submission_id;
  if found then
    if v_existing.collected_by <> v_uid or v_existing.submission_fingerprint <> v_fp then
      raise exception 'EXHIBITION_LEADS_SUBMISSION_CONFLICT: This submission id was already saved with different details'
        using errcode = '22023';
    end if;
    return jsonb_build_object('outcome', 'replayed', 'lead_id', v_existing.id);
  end if;

  -- The number is already held by an active lead.
  select * into v_existing from public.exhibition_leads l
   where l.exhibition_id = p_exhibition_id and l.phone_e164 = v_phone and l.archived_at is null;
  if found and (v_admin or v_existing.owner_id = v_uid) then
    return jsonb_build_object('outcome', 'duplicate', 'lead_id', v_existing.id, 'mine', true);
  end if;
  -- Someone else's lead: the fact only. No id, no name, no detail.
  return jsonb_build_object('outcome', 'duplicate', 'mine', false);
end;
$$;

revoke all on function public.create_exhibition_lead(uuid, uuid, text, text, text, text[], text, text, text, text, text, text) from public, anon;
grant execute on function public.create_exhibition_lead(uuid, uuid, text, text, text, text[], text, text, text, text, text, text) to authenticated;

create or replace function public.update_exhibition_lead(
  p_lead_id uuid, p_changes jsonb default '{}'::jsonb, p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid     uuid;
  v_admin   boolean;
  v_today   date := (now() at time zone 'Asia/Kolkata')::date;
  v_old     public.exhibition_leads;
  v_new     public.exhibition_leads;
  v_key     text;
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
  v_fields  text[] := '{}';
  v_terminal boolean;
  v_changed boolean := false;
begin
  select a.p_uid, a.p_is_admin into v_uid, v_admin from public.exhibition_leads_actor() a;
  p_changes := coalesce(p_changes, '{}'::jsonb);
  if jsonb_typeof(p_changes) <> 'object' then
    raise exception 'EXHIBITION_LEADS_INVALID: Changes must be an object' using errcode = '22023';
  end if;

  for v_key in select jsonb_object_keys(p_changes) loop
    if v_key not in ('contact_name','phone','client_type','client_type_other','requirements','company_name',
                     'project_city','buying_timeline','lead_type','status','next_follow_up_on') then
      raise exception 'EXHIBITION_LEADS_INVALID: Unknown field' using errcode = '22023';
    end if;
  end loop;
  if length(coalesce(v_note, '')) > 2000 then
    raise exception 'EXHIBITION_LEADS_INVALID: The note is too long' using errcode = '22023';
  end if;

  select * into v_old from public.exhibition_leads l where l.id = p_lead_id for update;
  if not found or not (v_admin or v_old.owner_id = v_uid) then
    raise exception 'EXHIBITION_LEADS_NOT_FOUND: Lead not found' using errcode = 'P0002';
  end if;
  if v_old.archived_at is not null then
    raise exception 'EXHIBITION_LEADS_ARCHIVED: An archived lead cannot be changed' using errcode = '55000';
  end if;

  v_new := v_old;

  if p_changes ? 'contact_name' then
    v_new.contact_name := btrim(coalesce(p_changes ->> 'contact_name', ''));
    if v_new.contact_name = '' or length(v_new.contact_name) > 120 then
      raise exception 'EXHIBITION_LEADS_INVALID: Enter the contact name' using errcode = '22023';
    end if;
  end if;
  if p_changes ? 'phone' then
    v_new.phone_e164 := public.normalize_lead_phone(p_changes ->> 'phone');
    if v_new.phone_e164 is null then
      raise exception 'EXHIBITION_LEADS_INVALID: Enter a valid mobile number' using errcode = '22023';
    end if;
  end if;
  if p_changes ? 'client_type' then
    v_new.client_type := p_changes ->> 'client_type';
    if v_new.client_type is null or v_new.client_type not in
       ('architect_designer','property_owner','consultant','other') then
      raise exception 'EXHIBITION_LEADS_INVALID: Choose a client type' using errcode = '22023';
    end if;
  end if;
  if p_changes ? 'client_type_other' then
    v_new.client_type_other := nullif(btrim(coalesce(p_changes ->> 'client_type_other', '')), '');
  end if;
  -- The message exists exactly when the type is Other, and is then required.
  if v_new.client_type = 'other' then
    if v_new.client_type_other is null then
      raise exception 'EXHIBITION_LEADS_INVALID: Say what kind of client this is' using errcode = '22023';
    end if;
    if length(v_new.client_type_other) > 200 then
      raise exception 'EXHIBITION_LEADS_INVALID: The client description is too long' using errcode = '22023';
    end if;
  else
    v_new.client_type_other := null;
  end if;
  if p_changes ? 'requirements' then
    if jsonb_typeof(p_changes -> 'requirements') <> 'array' then
      raise exception 'EXHIBITION_LEADS_INVALID: Choose at least one requirement' using errcode = '22023';
    end if;
    v_new.requirements := array(select jsonb_array_elements_text(p_changes -> 'requirements'));
    if cardinality(v_new.requirements) = 0 then
      raise exception 'EXHIBITION_LEADS_INVALID: Choose at least one requirement' using errcode = '22023';
    end if;
    if not (v_new.requirements <@ array['restaurant_cafe','hotel','residential']::text[]) then
      raise exception 'EXHIBITION_LEADS_INVALID: Unknown requirement' using errcode = '22023';
    end if;
  end if;
  if p_changes ? 'company_name' then
    v_new.company_name := nullif(btrim(coalesce(p_changes ->> 'company_name', '')), '');
    if length(coalesce(v_new.company_name, '')) > 160 then
      raise exception 'EXHIBITION_LEADS_INVALID: The company name is too long' using errcode = '22023';
    end if;
  end if;
  if p_changes ? 'project_city' then
    v_new.project_city := nullif(btrim(coalesce(p_changes ->> 'project_city', '')), '');
    if length(coalesce(v_new.project_city, '')) > 80 then
      raise exception 'EXHIBITION_LEADS_INVALID: The city is too long' using errcode = '22023';
    end if;
  end if;
  if p_changes ? 'buying_timeline' then
    v_new.buying_timeline := nullif(p_changes ->> 'buying_timeline', '');
    if v_new.buying_timeline is not null and v_new.buying_timeline not in
       ('within_1_month','1_3_months','3_6_months','later','not_sure') then
      raise exception 'EXHIBITION_LEADS_INVALID: Unknown buying timeline' using errcode = '22023';
    end if;
  end if;
  if p_changes ? 'lead_type' then
    v_new.lead_type := nullif(btrim(coalesce(p_changes ->> 'lead_type', '')), '');
    if v_new.lead_type is null then
      raise exception 'EXHIBITION_LEADS_INVALID: Choose a lead type' using errcode = '22023';
    end if;
    if v_new.lead_type not in ('hot','warm','long_term','mismatched_retail') then
      raise exception 'EXHIBITION_LEADS_INVALID: Unknown lead type' using errcode = '22023';
    end if;
  end if;
  if p_changes ? 'status' then
    v_new.status := p_changes ->> 'status';
    if v_new.status is null or v_new.status not in
       ('new','contacted','quotation_sent','follow_up','converted','not_proceeding') then
      raise exception 'EXHIBITION_LEADS_INVALID: Unknown status' using errcode = '22023';
    end if;
  end if;
  if p_changes ? 'next_follow_up_on' then
    begin
      v_new.next_follow_up_on := nullif(p_changes ->> 'next_follow_up_on', '')::date;
    exception when others then
      raise exception 'EXHIBITION_LEADS_INVALID: Enter a valid follow-up date' using errcode = '22023';
    end;
  end if;

  v_terminal := v_new.status in ('converted', 'not_proceeding');
  if v_terminal then
    -- Closing a lead retires its schedule; the change stays in the history.
    v_new.next_follow_up_on := null;
  end if;
  if v_new.status = 'follow_up' and v_new.next_follow_up_on is null then
    raise exception 'EXHIBITION_LEADS_FOLLOW_UP_DATE_REQUIRED: Choose the next follow-up date for a Follow-up lead'
      using errcode = '22023';
  end if;
  if v_new.next_follow_up_on is distinct from v_old.next_follow_up_on
     and v_new.next_follow_up_on is not null and v_new.next_follow_up_on < v_today then
    raise exception 'EXHIBITION_LEADS_INVALID: The follow-up date cannot be in the past' using errcode = '22023';
  end if;
  if v_old.status in ('converted', 'not_proceeding') and v_new.status = v_old.status
     and p_changes ? 'next_follow_up_on' and nullif(p_changes ->> 'next_follow_up_on', '') is not null then
    raise exception 'EXHIBITION_LEADS_INVALID: A closed lead has no follow-up date; change its status first'
      using errcode = '22023';
  end if;

  if v_new.contact_name is distinct from v_old.contact_name then v_fields := array_append(v_fields, 'contact_name'::text); end if;
  if v_new.phone_e164   is distinct from v_old.phone_e164   then v_fields := array_append(v_fields, 'phone'::text); end if;
  if v_new.client_type  is distinct from v_old.client_type  then v_fields := array_append(v_fields, 'client_type'::text); end if;
  if v_new.client_type_other is distinct from v_old.client_type_other then v_fields := array_append(v_fields, 'client_type_other'::text); end if;
  if v_new.requirements is distinct from v_old.requirements then v_fields := array_append(v_fields, 'requirements'::text); end if;
  if v_new.company_name is distinct from v_old.company_name then v_fields := array_append(v_fields, 'company_name'::text); end if;
  if v_new.project_city is distinct from v_old.project_city then v_fields := array_append(v_fields, 'project_city'::text); end if;
  if v_new.buying_timeline is distinct from v_old.buying_timeline then v_fields := array_append(v_fields, 'buying_timeline'::text); end if;
  if v_new.lead_type    is distinct from v_old.lead_type    then v_fields := array_append(v_fields, 'lead_type'::text); end if;

  v_changed := cardinality(v_fields) > 0
    or v_new.status is distinct from v_old.status
    or v_new.next_follow_up_on is distinct from v_old.next_follow_up_on;

  if v_changed then
    begin
      update public.exhibition_leads l
         set contact_name = v_new.contact_name, phone_e164 = v_new.phone_e164,
             client_type = v_new.client_type, client_type_other = v_new.client_type_other, requirements = v_new.requirements,
             company_name = v_new.company_name, project_city = v_new.project_city,
             buying_timeline = v_new.buying_timeline, lead_type = v_new.lead_type,
             status = v_new.status, next_follow_up_on = v_new.next_follow_up_on
       where l.id = v_old.id;
    exception when unique_violation then
      raise exception 'EXHIBITION_LEADS_DUPLICATE_PHONE: Another active lead already has this number'
        using errcode = '23505';
    end;

    if cardinality(v_fields) > 0 then
      insert into public.exhibition_lead_events (lead_id, event_type, actor_id, detail)
      values (v_old.id, 'details_edited', v_uid, jsonb_build_object('fields', to_jsonb(v_fields)));
    end if;
    if v_new.status is distinct from v_old.status then
      insert into public.exhibition_lead_events (lead_id, event_type, actor_id, detail)
      values (v_old.id, 'status_changed', v_uid, jsonb_build_object('from', v_old.status, 'to', v_new.status));
    end if;
    if v_new.next_follow_up_on is distinct from v_old.next_follow_up_on then
      insert into public.exhibition_lead_events (lead_id, event_type, actor_id, detail)
      values (v_old.id, 'follow_up_changed', v_uid,
              jsonb_build_object('from', v_old.next_follow_up_on, 'to', v_new.next_follow_up_on));
    end if;
  end if;

  if v_note is not null then
    insert into public.exhibition_lead_events (lead_id, event_type, actor_id, note)
    values (v_old.id, 'note', v_uid, v_note);
    -- Touch the row so the list's "latest note" ordering and updated_at move.
    update public.exhibition_leads l set updated_at = now() where l.id = v_old.id;
  end if;

  return jsonb_build_object('outcome', case when v_changed or v_note is not null then 'updated' else 'unchanged' end,
                            'lead_id', v_old.id);
end;
$$;

revoke all on function public.update_exhibition_lead(uuid, jsonb, text) from public, anon;
grant execute on function public.update_exhibition_lead(uuid, jsonb, text) to authenticated;
