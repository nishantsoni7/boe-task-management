-- 20270609000000_sales_whatsapp_capture.sql
--
-- Sales: a chat on WhatsApp becomes a lead (owner's plan, approved 2026-11-10, "Yes, build PR 1").
--
-- What the owner asked, and what this file does about it:
--   * The Meta ads send people to WhatsApp chats. The business number's WhatsApp webhook posts each message to
--     /api/sales/capture/whatsapp, which checks Meta's signature and calls capture_sales_chats with the service role.
--   * A new number becomes a lead in the Lead Master with the source WhatsApp and the first words the client wrote, and goes
--     through the same automatic allotment as a website lead: at once in working hours, otherwise it waits and the allotters
--     hear. A chat that came from an ad also keeps the ad (its id, headline, link) in sales_lead_ad_clicks.
--   * A number already in BOE One is NOT a new enquiry every time it writes. Its message is remembered and ignored, unless
--     the lead has been quiet for 3 days (no chat, no form, nothing since it was added) or the message is a fresh ad click.
--     Then it is a repeat enquiry exactly like a second website form: the message is added, the holder is told and calls
--     today, a closed or old lead comes back as New, and one nobody holds goes back to the Not allotted queue.
--   * Each message is remembered by its id (sales_lead_import_refs, 'wa:'), so a message Meta sends twice counts once.
--
-- The website capture (capture_sales_leads, 20270602000000) is NOT touched.
--
-- WRITE: capture_sales_chats only, service role only. sales_lead_ad_clicks has no policy and no grant for a browser.
--
-- ROLLBACK: drop function public.capture_sales_chats(jsonb); drop table public.sales_lead_ad_clicks;
--   Leads it created stay (source whatsapp), and so do their import_refs ('wa:').

-- ═══ 1. The ads a chat came from ════════════════════════════════════════════════════════════════════════════════

-- One row per ad click that opened a chat. A client who clicks again later adds a row. Marketing can join on ad_id later;
-- it never needs the name or the number.
create table public.sales_lead_ad_clicks (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.sales_leads (id),
  ad_id text not null check (length(ad_id) between 1 and 100),
  headline text check (headline is null or length(headline) <= 200),
  source_url text check (source_url is null or length(source_url) <= 500),
  ctwa_clid text check (ctwa_clid is null or length(ctwa_clid) <= 500),
  at timestamptz not null default now()
);
create index sales_lead_ad_clicks_lead_idx on public.sales_lead_ad_clicks (lead_id, at desc);
create index sales_lead_ad_clicks_ad_idx on public.sales_lead_ad_clicks (ad_id);

alter table public.sales_lead_ad_clicks enable row level security;
revoke all on table public.sales_lead_ad_clicks from public, anon, authenticated;
grant all on table public.sales_lead_ad_clicks to service_role;

-- ═══ 2. The capture ═════════════════════════════════════════════════════════════════════════════════════════════

-- Rows as the WhatsApp route sends them, up to 100 at a time:
--   { key, phone, name, message, ad_id, ad_headline, ad_url, ctwa_clid }
-- key is WhatsApp's id for the message; phone has the country code ("+919811100050"); name is the client's WhatsApp profile
-- name; message is the text (or the caption); the ad_* fields are there only when the chat was opened from an ad.
create function public.capture_sales_chats(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r jsonb;
  v_phone text;
  v_ref text;
  v_row public.sales_leads;
  v_lead uuid;
  v_msg text;
  v_name text;
  v_who text;
  v_ad text;
  v_headline text;
  v_how text;
  v_quiet boolean;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_closed boolean;
  v_created integer := 0;
  v_repeat integer := 0;
  v_ignored integer := 0;
  v_already integer := 0;
  v_allotted integer := 0;
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

  for r in select value from jsonb_array_elements(p_rows) loop
    v_phone := public.normalize_lead_phone(r ->> 'phone');
    if v_phone is null then
      v_failed := v_failed || jsonb_build_object('key', left(r ->> 'key', 80), 'why', 'no valid number');
      continue;
    end if;
    v_ref := 'wa:' || coalesce(left(nullif(btrim(r ->> 'key'), ''), 200), md5(r::text));
    if exists (select 1 from public.sales_lead_import_refs x where x.ref = v_ref) then
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

      select * into v_row from public.sales_leads l where l.phone_e164 = v_phone for update;

      if v_row.id is null then
        insert into public.sales_leads (phone_e164, source, name, requirement)
        values (v_phone, 'whatsapp', v_name, v_msg)
        returning id into v_lead;
        insert into public.sales_lead_events (lead_id, kind, detail) values (v_lead, 'added', v_how);
        if v_ad is not null then
          insert into public.sales_lead_ad_clicks (lead_id, ad_id, headline, source_url, ctwa_clid)
          values (v_lead, v_ad, v_headline, left(nullif(btrim(r ->> 'ad_url'), ''), 500), left(nullif(btrim(r ->> 'ctwa_clid'), ''), 500));
        end if;
        if v_open and public.sales_lead_auto_allot(v_lead) is not null then
          v_allotted := v_allotted + 1;
        else
          perform public.sales_lead_tell_allotters(v_lead, 'sales_lead_waiting', 'New lead from WhatsApp',
            left(v_who || '. ' || v_note || coalesce(' ' || v_msg, ''), 300));
        end if;
        v_created := v_created + 1;
      else
        v_lead := v_row.id;
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

      -- Every message is remembered, the ignored ones too: it is how the next one knows the client is still talking.
      insert into public.sales_lead_import_refs (ref, lead_id, at) values (v_ref, v_lead, now());
    exception
      when check_violation or not_null_violation or invalid_text_representation or string_data_right_truncation then
        v_failed := v_failed || jsonb_build_object('key', left(r ->> 'key', 80), 'why', 'details the database refused');
    end;
  end loop;

  return jsonb_build_object('created', v_created, 'repeat', v_repeat, 'ignored', v_ignored, 'already', v_already,
    'allotted', v_allotted, 'failed', v_failed);
end;
$$;

-- ═══ 3. Who may call what ═══════════════════════════════════════════════════════════════════════════════════════

revoke all on function public.capture_sales_chats(jsonb) from public, anon, authenticated;
grant execute on function public.capture_sales_chats(jsonb) to service_role;

-- ═══ 4. Self-checks ═════════════════════════════════════════════════════════════════════════════════════════════

do $$
begin
  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.sales_lead_ad_clicks'::regclass) then
    raise exception 'SALES_WHATSAPP: row level security must be on for sales_lead_ad_clicks';
  end if;
  if has_table_privilege('authenticated', 'public.sales_lead_ad_clicks', 'SELECT')
     or has_table_privilege('anon', 'public.sales_lead_ad_clicks', 'SELECT') then
    raise exception 'SALES_WHATSAPP: a browser must not reach the ad clicks';
  end if;
  if has_function_privilege('authenticated', 'public.capture_sales_chats(jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.capture_sales_chats(jsonb)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.capture_sales_chats(jsonb)', 'EXECUTE') then
    raise exception 'SALES_WHATSAPP: the chat capture is for the service role only';
  end if;
  -- The website capture is the one 20270602000000 made: this file must not have replaced it.
  if not has_function_privilege('service_role', 'public.capture_sales_leads(jsonb)', 'EXECUTE') then
    raise exception 'SALES_WHATSAPP: the website capture went missing';
  end if;
end $$;
