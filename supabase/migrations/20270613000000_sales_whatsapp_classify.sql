-- 20270613000000_sales_whatsapp_classify.sql
--
-- Sales: not every chat on the business WhatsApp number is a lead (owner, 2026-11-11). Job seekers, suppliers, transport
-- companies and sellers of services write to it too. The route now has each NEW number's words judged (Claude, in the
-- route: src/lib/salesLeads/classify.ts) and sends the verdict with the row. This file is what the database does with it.
--
--   * A lead (or a chat opened from an ad) becomes a lead exactly as before, now with a tag: wa_tag 'detected' and a short
--     reason ("Asks for 20 chairs for a hotel").
--   * Not a lead: the words are kept in sales_whatsapp_held (the last 5 messages, 30 days), NOT in the Lead Master. People
--     who allot see them in "Filtered chats" with the reason, and can press "This is a lead" (wa_tag 'hand') or Clear.
--     A held number's next message is judged again with the earlier ones, so "Hi" and then "need 20 chairs" is a lead.
--   * Unclear ("Hi", a picture with no words) or the judging failing (no key, timeout): a lead tagged 'check', NOT given
--     automatically: the allotters hear "WhatsApp chat to check". A real lead is never lost because the judge failed. While
--     a 'check' lead is nobody's, its next messages are added to its requirement and judged again; a lead verdict turns it
--     into 'detected' and gives it by the usual rule.
--   * A known lead's number is not judged at all (no words leave BOE One for it) and behaves exactly as in 20270609000000.
--
-- Replaces capture_sales_chats(jsonb) (same signature; rows may now carry verdict {kind, category, reason, via} and
-- keys[] - the other messages merged into the row; a row without a verdict behaves as before, tag null).
-- Re-issues sales_lead_row with wa_tag and wa_reason (20270602000000 + the two).
-- New, service role only: sales_chat_context(jsonb). New, for people with Sales `assign`: list_whatsapp_held_chats(),
-- make_whatsapp_chat_a_lead(uuid), clear_whatsapp_held_chat(uuid).
--
-- ROLLBACK: restore capture_sales_chats and sales_lead_row from 20270609000000 / 20270602000000, then
--   drop function public.sales_chat_context(jsonb), public.list_whatsapp_held_chats(), public.make_whatsapp_chat_a_lead(uuid),
--   public.clear_whatsapp_held_chat(uuid); drop table public.sales_whatsapp_held;
--   alter table public.sales_leads drop column wa_tag, drop column wa_reason;
--   Leads it created stay.

-- ═══ 1. The tag on a lead ═══════════════════════════════════════════════════════════════════════════════════════

alter table public.sales_leads
  add column wa_tag text check (wa_tag in ('detected', 'check', 'hand')),
  add column wa_reason text check (wa_reason is null or length(wa_reason) <= 200);

comment on column public.sales_leads.wa_tag is
  'WhatsApp chats only: detected = read as a lead, check = could not tell (nobody gets it automatically), hand = chosen by a person from Filtered chats.';

-- ═══ 2. Chats that are not leads ════════════════════════════════════════════════════════════════════════════════

-- One row per number. messages: the last 5, [{key, at, text}], each text cut to 600. status: held = in the list,
-- cleared = a person looked and said it is nothing (it stays out of the list but is still judged if it writes again).
-- A row goes when its number becomes a lead, and 30 days after its last message.
create table public.sales_whatsapp_held (
  id uuid primary key default gen_random_uuid(),
  phone_e164 text not null unique check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  name text check (name is null or length(name) between 1 and 120),
  category text not null check (category in ('job_seeker', 'supplier', 'transport', 'service_seller', 'existing_customer', 'personal', 'other')),
  reason text check (reason is null or length(reason) <= 200),
  messages jsonb not null default '[]'::jsonb check (jsonb_typeof(messages) = 'array'),
  status text not null default 'held' check (status in ('held', 'cleared')),
  first_at timestamptz not null default now(),
  last_at timestamptz not null default now()
);
create index sales_whatsapp_held_list_idx on public.sales_whatsapp_held (status, last_at desc);

alter table public.sales_whatsapp_held enable row level security;
revoke all on table public.sales_whatsapp_held from public, anon, authenticated;
grant all on table public.sales_whatsapp_held to service_role;

-- ═══ 3. Re-issued: the lead as the screens see it, with the tag (20270602000000 + wa_tag, wa_reason) ═════════════

create or replace function public.sales_lead_row(l public.sales_leads)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', l.id,
    'lead_no', l.lead_no,
    'received_on', l.received_on,
    'phone', l.phone_e164,
    'source', l.source,
    'name', l.name,
    'email', l.email,
    'location', l.location,
    'requirement', l.requirement,
    'assigned_to', l.assigned_to,
    'holder_name', (select u.full_name from public.users u where u.id = l.assigned_to),
    'assigned_at', l.assigned_at,
    'updated_at', l.updated_at,
    'stage', l.stage,
    'temperature', l.temperature,
    'segment', l.segment,
    'client_type', l.client_type,
    'market', l.market,
    'quantity', l.quantity,
    'timeline', l.timeline,
    'expected_value_paise', l.expected_value_paise,
    'next_step', l.next_step,
    'next_due_on', l.next_due_on,
    'first_attempt_at', l.first_attempt_at,
    'first_contact_at', l.first_contact_at,
    'last_activity_at', l.last_activity_at,
    'last_kind', l.last_kind,
    'no_answer_streak', l.no_answer_streak,
    'enquired_again_at', l.enquired_again_at,
    'dead_reason', l.dead_reason,
    'dead_note', l.dead_note,
    'closed_at', l.closed_at,
    'is_history', l.is_history,
    'stuck', public.sales_lead_stuck(l),
    'premium', public.sales_lead_premium(l),
    'wa_tag', l.wa_tag,
    'wa_reason', l.wa_reason
  );
$$;

-- ═══ 4. What the route needs to know before it judges ═══════════════════════════════════════════════════════════

-- p_phones: an array of numbers as the route has them ("+919811100050"), up to 100. For each: { known: true } for a number
-- that is already a lead (nothing about it is judged or sent anywhere), or - when the lead is a 'check' one nobody holds -
-- { known: true, check: true, words: <what it holds so far> }; otherwise { known: false, held: [<earlier words>] }.
create function public.sales_chat_context(p_phones jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  p text;
  v_phone text;
  v_row public.sales_leads;
  v_held public.sales_whatsapp_held;
  v_check boolean;
  v_out jsonb := '{}'::jsonb;
begin
  if jsonb_typeof(p_phones) is distinct from 'array' or jsonb_array_length(p_phones) > 100 then
    raise exception 'SALES_INVALID: Send up to 100 numbers at a time.';
  end if;
  for p in select jsonb_array_elements_text(p_phones) loop
    v_phone := public.normalize_lead_phone(p);
    if v_phone is null then continue; end if;
    select * into v_row from public.sales_leads l where l.phone_e164 = v_phone;
    if v_row.id is not null then
      v_check := v_row.source = 'whatsapp' and v_row.wa_tag = 'check' and v_row.assigned_to is null
                 and v_row.stage not in ('converted', 'dead');
      v_out := v_out || jsonb_build_object(p, case when v_check
        then jsonb_build_object('known', true, 'check', true, 'words', left(coalesce(v_row.requirement, ''), 1500))
        else jsonb_build_object('known', true) end);
    else
      select * into v_held from public.sales_whatsapp_held h where h.phone_e164 = v_phone;
      v_out := v_out || jsonb_build_object(p, jsonb_build_object('known', false, 'held', coalesce((
        select jsonb_agg(t.x ->> 'text' order by t.ord)
        from jsonb_array_elements(coalesce(v_held.messages, '[]'::jsonb)) with ordinality as t(x, ord)
      ), '[]'::jsonb)));
    end if;
  end loop;
  return v_out;
end;
$$;

-- ═══ 5. The capture (20270609000000 + the verdict) ══════════════════════════════════════════════════════════════

-- Rows, up to 100 at a time:
--   { key, phone, name, message, ad_id, ad_headline, ad_url, ctwa_clid,
--     keys?: [<the other message ids merged into this row>],
--     verdict?: { kind: 'lead' | 'other' | 'unclear', category?, reason?, via? } }
create or replace function public.capture_sales_chats(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r jsonb;
  v_verdict jsonb;
  v_kind text;
  v_cat text;
  v_reason text;
  v_tag text;
  v_phone text;
  v_ref text;
  v_extra text;
  v_row public.sales_leads;
  v_held public.sales_whatsapp_held;
  v_items jsonb;
  v_lead uuid;
  v_msg text;
  v_all text;
  v_name text;
  v_who text;
  v_ad text;
  v_headline text;
  v_how text;
  v_quiet boolean;
  v_check boolean;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_closed boolean;
  v_created integer := 0;
  v_repeat integer := 0;
  v_ignored integer := 0;
  v_already integer := 0;
  v_allotted integer := 0;
  v_held_n integer := 0;
  v_promoted integer := 0;
  v_failed jsonb := '[]'::jsonb;
  -- Given at once in working hours; otherwise the allotters hear what happens next (as for a website lead).
  v_open boolean := public.sales_auto_allot_open(false);
  v_note text := case
    when v_open then 'Nobody is free to take it now: allot it in Lead Master.'
    when (select s.is_on from public.sales_auto_allot s) then 'It will be allotted automatically next working morning.'
    else 'Allot it in Lead Master.'
  end;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) > 100 then
    raise exception 'SALES_INVALID: Send up to 100 rows at a time.';
  end if;

  -- The words of a chat that is not a lead are not kept longer than 30 days after its last message.
  delete from public.sales_whatsapp_held h where h.last_at < now() - interval '30 days';

  for r in select value from jsonb_array_elements(p_rows) loop
    v_phone := public.normalize_lead_phone(r ->> 'phone');
    if v_phone is null then
      v_failed := v_failed || jsonb_build_object('key', left(r ->> 'key', 80), 'why', 'no valid number');
      continue;
    end if;
    v_ref := 'wa:' || coalesce(left(nullif(btrim(r ->> 'key'), ''), 200), md5(r::text));
    if exists (select 1 from public.sales_lead_import_refs x where x.ref = v_ref)
       or (nullif(btrim(r ->> 'key'), '') is not null and exists (
         select 1 from public.sales_whatsapp_held h
         where h.phone_e164 = v_phone
           and h.messages @> jsonb_build_array(jsonb_build_object('key', left(btrim(r ->> 'key'), 200)))
       )) then
      v_already := v_already + 1;
      continue;
    end if;

    begin
      v_msg := left(nullif(btrim(r ->> 'message'), ''), 4000);
      v_name := left(nullif(btrim(r ->> 'name'), ''), 120);
      v_ad := left(nullif(btrim(r ->> 'ad_id'), ''), 100);
      v_headline := left(nullif(btrim(r ->> 'ad_headline'), ''), 200);
      -- How the history says it came in: "Came in from the WhatsApp ad: Hotel furniture".
      v_how := case when v_ad is null then 'WhatsApp chat' else left('WhatsApp ad: ' || coalesce(v_headline, v_ad), 200) end;
      v_who := coalesce(v_name, v_phone);

      -- The verdict. None at all = the old behaviour: a lead, no tag. A chat from an ad is a lead whatever the verdict says.
      v_verdict := case when jsonb_typeof(r -> 'verdict') = 'object' then r -> 'verdict' else null end;
      v_kind := case when v_verdict ->> 'kind' in ('lead', 'other', 'unclear') then v_verdict ->> 'kind' else 'lead' end;
      if v_ad is not null then v_kind := 'lead'; end if;
      v_cat := case when v_verdict ->> 'category' in ('job_seeker', 'supplier', 'transport', 'service_seller', 'existing_customer', 'personal', 'other')
        then v_verdict ->> 'category' else 'other' end;
      v_reason := left(nullif(btrim(v_verdict ->> 'reason'), ''), 200);
      v_tag := case when v_verdict is null then null when v_kind = 'lead' then 'detected' else 'check' end;

      select * into v_row from public.sales_leads l where l.phone_e164 = v_phone for update;

      if v_row.id is null then
        select * into v_held from public.sales_whatsapp_held h where h.phone_e164 = v_phone for update;

        if v_kind = 'other' then
          -- Not a lead: kept apart, with the last 5 messages, for the Filtered chats list.
          v_items := coalesce(v_held.messages, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
            'key', left(btrim(coalesce(r ->> 'key', '')), 200), 'at', now(), 'text', left(coalesce(v_msg, ''), 600)));
          select coalesce(jsonb_agg(e.x order by e.ord), '[]'::jsonb) into v_items
          from (select t.x, t.ord from jsonb_array_elements(v_items) with ordinality as t(x, ord) order by t.ord desc limit 5) e;
          insert into public.sales_whatsapp_held as h (phone_e164, name, category, reason, messages)
          values (v_phone, v_name, v_cat, v_reason, v_items)
          on conflict (phone_e164) do update
            set name = coalesce(h.name, excluded.name), category = excluded.category, reason = excluded.reason,
                messages = excluded.messages, last_at = now();
          v_held_n := v_held_n + 1;
          continue;
        end if;

        -- A lead, or not sure: the words held so far come with it.
        v_all := v_msg;
        if v_held.id is not null then
          v_all := left(nullif(concat_ws(E'\n',
            (select string_agg(t.x ->> 'text', E'\n' order by t.ord)
             from jsonb_array_elements(v_held.messages) with ordinality as t(x, ord) where nullif(t.x ->> 'text', '') is not null),
            v_msg), ''), 4000);
          v_name := coalesce(v_name, v_held.name);
        end if;

        insert into public.sales_leads (phone_e164, source, name, requirement, wa_tag, wa_reason)
        values (v_phone, 'whatsapp', v_name, v_all, v_tag, v_reason)
        returning id into v_lead;
        delete from public.sales_whatsapp_held h where h.phone_e164 = v_phone;
        insert into public.sales_lead_events (lead_id, kind, detail) values (v_lead, 'added', v_how);
        if v_ad is not null then
          insert into public.sales_lead_ad_clicks (lead_id, ad_id, headline, source_url, ctwa_clid)
          values (v_lead, v_ad, v_headline, left(nullif(btrim(r ->> 'ad_url'), ''), 500), left(nullif(btrim(r ->> 'ctwa_clid'), ''), 500));
        end if;
        if v_kind = 'unclear' then
          -- Not given automatically: a person looks at the chat first.
          perform public.sales_lead_tell_allotters(v_lead, 'sales_lead_waiting', 'WhatsApp chat to check',
            left(v_who || '. Could not tell if this is a lead: check the chat and allot it if it is.' || coalesce(' ' || v_msg, ''), 300));
        elsif v_open and public.sales_lead_auto_allot(v_lead) is not null then
          v_allotted := v_allotted + 1;
        else
          perform public.sales_lead_tell_allotters(v_lead, 'sales_lead_waiting', 'New lead from WhatsApp',
            left(v_who || '. ' || v_note || coalesce(' ' || v_msg, ''), 300));
        end if;
        v_created := v_created + 1;
      else
        v_lead := v_row.id;
        delete from public.sales_whatsapp_held h where h.phone_e164 = v_phone;
        v_check := v_row.source = 'whatsapp' and v_row.wa_tag = 'check' and v_row.assigned_to is null
                   and v_row.stage not in ('converted', 'dead') and v_verdict is not null;

        if v_check then
          -- A chat nobody has picked up yet and could not be judged: it keeps listening. The words are added, and a lead
          -- verdict turns it into a lead that is given by the usual rule.
          update public.sales_leads l
          set requirement = case
                when v_msg is null then l.requirement
                when l.requirement is null then v_msg
                when position(left(v_msg, 200) in l.requirement) > 0 then l.requirement
                else left(l.requirement || E'\n\n' || v_msg, 4000)
              end,
              name = coalesce(l.name, v_name),
              wa_tag = case when v_kind = 'lead' then 'detected' else l.wa_tag end,
              wa_reason = coalesce(v_reason, l.wa_reason),
              updated_at = now()
          where l.id = v_lead;
          if v_ad is not null then
            insert into public.sales_lead_ad_clicks (lead_id, ad_id, headline, source_url, ctwa_clid)
            values (v_lead, v_ad, v_headline, left(nullif(btrim(r ->> 'ad_url'), ''), 500), left(nullif(btrim(r ->> 'ctwa_clid'), ''), 500));
          end if;
          if v_kind = 'lead' then
            if v_open and public.sales_lead_auto_allot(v_lead) is not null then
              v_allotted := v_allotted + 1;
            else
              perform public.sales_lead_tell_allotters(v_lead, 'sales_lead_waiting', 'New lead from WhatsApp',
                left(v_who || '. ' || v_note || coalesce(' ' || v_msg, ''), 300));
            end if;
            v_promoted := v_promoted + 1;
          else
            v_ignored := v_ignored + 1;
          end if;
        else
          -- Quiet = nothing from this client for 3 days: not a chat (any message remembered below counts), not a form, and
          -- the lead itself is older than that. Greatest ignores the nulls.
          v_quiet := greatest(
            v_row.created_at,
            v_row.enquired_again_at,
            (select max(x.at) from public.sales_lead_import_refs x where x.lead_id = v_lead and x.ref like 'wa:%')
          ) < now() - interval '3 days';

          if v_ad is null and not v_quiet then
            -- The conversation goes on in WhatsApp; the holder already has this client.
            v_ignored := v_ignored + 1;
          else
            v_closed := v_row.stage in ('converted', 'dead');
            update public.sales_leads l
            set stage = case when v_closed then 'new' else l.stage end,
                stage_changed_at = case when v_closed then now() else l.stage_changed_at end,
                dead_reason = case when v_closed then null else l.dead_reason end,
                dead_note = case when v_closed then null else l.dead_note end,
                closed_at = case when v_closed then null else l.closed_at end,
                next_step = case when l.assigned_to is null then l.next_step when v_closed then 'Call back' else l.next_step end,
                next_due_on = case when l.assigned_to is null then l.next_due_on when v_closed then v_today else least(l.next_due_on, v_today) end,
                is_history = false,
                name = coalesce(l.name, v_name),
                requirement = case
                  when v_msg is null then l.requirement
                  when l.requirement is null then v_msg
                  when position(left(v_msg, 200) in l.requirement) > 0 then l.requirement
                  else left(l.requirement || E'\n\n' || v_msg, 4000)
                end,
                enquired_again_at = now(),
                updated_at = now()
            where l.id = v_lead
            returning * into v_row;
            insert into public.sales_lead_events (lead_id, kind, detail) values (v_lead, 'enquired_again', v_how);
            if v_ad is not null then
              insert into public.sales_lead_ad_clicks (lead_id, ad_id, headline, source_url, ctwa_clid)
              values (v_lead, v_ad, v_headline, left(nullif(btrim(r ->> 'ad_url'), ''), 500), left(nullif(btrim(r ->> 'ctwa_clid'), ''), 500));
            end if;
            if v_row.assigned_to is not null and public.sales_lead_can_hold(v_row.assigned_to) then
              perform public.sales_lead_notify(v_row.assigned_to, v_lead, 'sales_lead_enquired_again', 'A lead enquired again',
                left(v_who || ' wrote on WhatsApp again. Call today.', 300));
            elsif v_open and public.sales_lead_auto_allot(v_lead) is not null then
              v_allotted := v_allotted + 1;
            else
              perform public.sales_lead_tell_allotters(v_lead, 'sales_lead_waiting', 'A lead came back on WhatsApp',
                left(v_who || '. ' || v_note || coalesce(' ' || v_msg, ''), 300));
            end if;
            v_repeat := v_repeat + 1;
          end if;
        end if;
      end if;

      -- Every message is remembered, the ignored ones too: it is how the next one knows the client is still talking.
      insert into public.sales_lead_import_refs (ref, lead_id, at) values (v_ref, v_lead, now());
      -- The other messages merged into this row by the route are remembered too, so a resend of any of them counts once.
      if jsonb_typeof(r -> 'keys') = 'array' then
        for v_extra in select jsonb_array_elements_text(r -> 'keys') loop
          insert into public.sales_lead_import_refs (ref, lead_id, at)
          values ('wa:' || left(v_extra, 200), v_lead, now())
          on conflict (ref) do nothing;
        end loop;
      end if;
    exception
      when check_violation or not_null_violation or invalid_text_representation or string_data_right_truncation then
        v_failed := v_failed || jsonb_build_object('key', left(r ->> 'key', 80), 'why', 'details the database refused');
    end;
  end loop;

  return jsonb_build_object('created', v_created, 'repeat', v_repeat, 'ignored', v_ignored, 'already', v_already,
    'allotted', v_allotted, 'held', v_held_n, 'promoted', v_promoted, 'failed', v_failed);
end;
$$;

-- ═══ 6. Filtered chats: what people who allot can do ════════════════════════════════════════════════════════════

-- The chats that were judged not to be leads, newest first (at most 200, the last 30 days).
create function public.list_whatsapp_held_chats()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.sales_leads_require('assign');
  return jsonb_build_object('rows', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', q.id, 'phone', q.phone_e164, 'name', q.name, 'category', q.category, 'reason', q.reason,
      'first_at', q.first_at, 'last_at', q.last_at,
      'messages', (
        select coalesce(jsonb_agg(t.x ->> 'text' order by t.ord), '[]'::jsonb)
        from jsonb_array_elements(q.messages) with ordinality as t(x, ord)
      )
    ) order by q.last_at desc)
    from (
      select h.* from public.sales_whatsapp_held h
      where h.status = 'held' and h.last_at >= now() - interval '30 days'
      order by h.last_at desc limit 200
    ) q
  ), '[]'::jsonb));
end;
$$;

-- "This is a lead": it becomes a lead tagged 'hand', NOT allotted (the person pressing is one who allots, and does it from
-- the Lead Master). Returns {status: 'created' | 'duplicate', lead}.
create function public.make_whatsapp_chat_a_lead(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public.sales_leads_require('assign');
  v_held public.sales_whatsapp_held;
  v_row public.sales_leads;
  v_all text;
begin
  select * into v_held from public.sales_whatsapp_held h where h.id = p_id for update;
  if v_held.id is null then raise exception 'SALES_NOT_FOUND'; end if;

  select * into v_row from public.sales_leads l where l.phone_e164 = v_held.phone_e164;
  if v_row.id is not null then
    delete from public.sales_whatsapp_held h where h.id = v_held.id;
    return jsonb_build_object('status', 'duplicate', 'lead', public.sales_lead_json(v_row));
  end if;

  v_all := left((
    select string_agg(t.x ->> 'text', E'\n' order by t.ord)
    from jsonb_array_elements(v_held.messages) with ordinality as t(x, ord) where nullif(t.x ->> 'text', '') is not null
  ), 4000);

  insert into public.sales_leads (phone_e164, source, name, requirement, wa_tag, wa_reason, created_by)
  values (v_held.phone_e164, 'whatsapp', v_held.name, v_all, 'hand', 'Chosen as a lead by hand from Filtered chats', v_uid)
  on conflict (phone_e164) do nothing
  returning * into v_row;
  if v_row.id is null then
    select * into v_row from public.sales_leads l where l.phone_e164 = v_held.phone_e164;
    delete from public.sales_whatsapp_held h where h.id = v_held.id;
    return jsonb_build_object('status', 'duplicate', 'lead', public.sales_lead_json(v_row));
  end if;

  insert into public.sales_lead_events (lead_id, kind, detail, actor) values (v_row.id, 'added', 'WhatsApp chat', v_uid);
  delete from public.sales_whatsapp_held h where h.id = v_held.id;
  return jsonb_build_object('status', 'created', 'lead', public.sales_lead_json(v_row));
end;
$$;

-- "Clear": somebody looked, and it is nothing. It leaves the list; if the number writes again it is still judged.
create function public.clear_whatsapp_held_chat(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.sales_leads_require('assign');
  update public.sales_whatsapp_held h set status = 'cleared' where h.id = p_id and h.status = 'held';
end;
$$;

-- ═══ 7. Who may call what ═══════════════════════════════════════════════════════════════════════════════════════

revoke all on function public.sales_chat_context(jsonb) from public, anon, authenticated;
grant execute on function public.sales_chat_context(jsonb) to service_role;

revoke all on function public.capture_sales_chats(jsonb) from public, anon, authenticated;
grant execute on function public.capture_sales_chats(jsonb) to service_role;

revoke all on function public.list_whatsapp_held_chats() from public, anon;
revoke all on function public.make_whatsapp_chat_a_lead(uuid) from public, anon;
revoke all on function public.clear_whatsapp_held_chat(uuid) from public, anon;
grant execute on function public.list_whatsapp_held_chats() to authenticated;
grant execute on function public.make_whatsapp_chat_a_lead(uuid) to authenticated;
grant execute on function public.clear_whatsapp_held_chat(uuid) to authenticated;

-- ═══ 8. Self-checks ═════════════════════════════════════════════════════════════════════════════════════════════

do $$
begin
  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.sales_whatsapp_held'::regclass) then
    raise exception 'SALES_WHATSAPP_CLASSIFY: row level security must be on for sales_whatsapp_held';
  end if;
  if has_table_privilege('authenticated', 'public.sales_whatsapp_held', 'SELECT')
     or has_table_privilege('anon', 'public.sales_whatsapp_held', 'SELECT') then
    raise exception 'SALES_WHATSAPP_CLASSIFY: a browser must not read the held chats directly';
  end if;
  if has_function_privilege('authenticated', 'public.capture_sales_chats(jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.capture_sales_chats(jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.sales_chat_context(jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.sales_chat_context(jsonb)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.capture_sales_chats(jsonb)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.sales_chat_context(jsonb)', 'EXECUTE') then
    raise exception 'SALES_WHATSAPP_CLASSIFY: the capture and its context are for the service role only';
  end if;
  if has_function_privilege('anon', 'public.list_whatsapp_held_chats()', 'EXECUTE')
     or has_function_privilege('anon', 'public.make_whatsapp_chat_a_lead(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.clear_whatsapp_held_chat(uuid)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.list_whatsapp_held_chats()', 'EXECUTE') then
    raise exception 'SALES_WHATSAPP_CLASSIFY: the Filtered chats functions are for signed-in people only';
  end if;
  -- The lead's row still shows what it showed, and now the tag.
  if position('wa_tag' in pg_get_functiondef('public.sales_lead_row(public.sales_leads)'::regprocedure)) = 0
     or position('premium' in pg_get_functiondef('public.sales_lead_row(public.sales_leads)'::regprocedure)) = 0 then
    raise exception 'SALES_WHATSAPP_CLASSIFY: sales_lead_row lost a field';
  end if;
  if not has_function_privilege('service_role', 'public.capture_sales_leads(jsonb)', 'EXECUTE') then
    raise exception 'SALES_WHATSAPP_CLASSIFY: the website capture went missing';
  end if;
end $$;
