-- Exhibition Leads — a duplicate names the salesperson who already holds the lead.
--
-- When a mobile number is already an active lead of someone else, create_exhibition_lead
-- answered only "duplicate, not yours". The person at the stand had nothing to
-- re-verify with. The answer now also carries the holder's name (owner_name):
-- the name only — still no lead id, contact detail or notes. Re-issued verbatim
-- from 20270310 apart from that last return.

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
  -- Someone else's lead: who holds it (so the person at the stand can check with
  -- them), and nothing more. No lead id, no contact detail.
  return jsonb_build_object('outcome', 'duplicate', 'mine', false,
    'owner_name', (select nullif(btrim(u.full_name), '') from public.users u where u.id = v_existing.owner_id));
end;
$$;

revoke all on function public.create_exhibition_lead(uuid, uuid, text, text, text, text[], text, text, text, text, text, text) from public, anon;
grant execute on function public.create_exhibition_lead(uuid, uuid, text, text, text, text[], text, text, text, text, text, text) to authenticated;
