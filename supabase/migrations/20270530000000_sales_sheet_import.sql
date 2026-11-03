-- 20270530000000_sales_sheet_import.sql
--
-- Sales: the two old Google Sheets come into the Lead Master (owner's plan, Phase 1, approved 2026-11-03).
--
-- What the owner asked, and what this file does about it:
--   * "Leads Master - 2026" (every lead, the day it came, its source and who it was given to, 2024 to 2026) and
--     "Website Leads" (what the website form captured, with the customer's message) are read in the browser and sent here.
--   * A number already in BOE One (from ClickUp) keeps its ClickUp stage and salesperson. The sheets only fill what is
--     missing (name, email, location), add the message to the requirement, and leave a dated line in its history:
--     "Leads Master 2025, given to Ashok".
--   * A number in the sheets only becomes an OLD LEAD (is_history): searchable in the Lead Master with who had it and when,
--     known when it calls again, but on nobody's board and not in the "Not allotted" queue. A repeat enquiry, or allotting
--     it by hand, brings it back as a live lead.
--   * The sheets go in after the ClickUp import, never before: a number must get ClickUp's stage first.
--   * Two sources the sheets use, and the owner's plan adds, join the list: BNI and Walk-in.
--   * Each sheet row is remembered (sales_lead_import_refs, 'sheet:' and a hash of the row), so running it twice adds nothing.
--
-- WRITE: import_sales_lead_sheet only, `assign` right.
--
-- ROLLBACK: drop function public.import_sales_lead_sheet(jsonb); re-run the 20270525000000 definition of sales_lead_row,
--   the 20270526000100 definitions of sales_leads_page, sales_board and record_sales_lead_enquiry, and the 20270527000000
--   definition of allot_sales_lead; then drop column sales_leads.is_history (old leads become ordinary unallotted
--   leads; delete them first if they must go) and restore the source check without 'bni' and 'walk_in'.

-- ═══ 1. New values ══════════════════════════════════════════════════════════════════════════════════════════════

alter table public.sales_leads drop constraint sales_leads_source_check;
alter table public.sales_leads add constraint sales_leads_source_check check (source in (
  'website', 'whatsapp', 'instagram', 'insta_promo', 'facebook_promo',
  'google_ads', 'campaign', 'reference', 'repeat_customer', 'bni', 'walk_in', 'others'
));

-- ═══ 2. Old leads ═══════════════════════════════════════════════════════════════════════════════════════════════

-- A lead kept for the record from the old sheets: who had it and when is in its history. Not worked, not queued.
alter table public.sales_leads add column is_history boolean not null default false;
create index sales_leads_history_idx on public.sales_leads (is_history) where is_history;

-- ═══ 3. An old lead stays out of the "Not allotted" queue, and comes back when it enquires again or is allotted ═════

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
    'stuck', public.sales_lead_stuck(l)
  );
$$;

create or replace function public.sales_leads_page(
  p_period text default 'today',
  p_holder text default 'all',
  p_source text default null,
  p_q text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid;
  v_all boolean;
  v_juniors uuid[];
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_from date;
  v_q text := btrim(coalesce(p_q, ''));
  v_digits text := regexp_replace(btrim(coalesce(p_q, '')), '[^0-9]', '', 'g');
  v_like text := '%' || replace(replace(replace(btrim(coalesce(p_q, '')), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  -- A number typed in any of its forms ("098765 43210", "+91 98765 43210") finds the one stored number.
  v_norm text := public.normalize_lead_phone(btrim(coalesce(p_q, '')));
  v_holder uuid := case when p_holder ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_holder::uuid end;
  v_lim integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_off integer := greatest(coalesce(p_offset, 0), 0);
  v_periods jsonb;
  v_everyone integer;
  v_unallotted integer;
  v_holders jsonb;
  v_total integer;
  v_rows jsonb;
begin
  v_uid := public.sales_leads_require(null);
  v_all := public.sales_lead_sees_all(v_uid);
  select coalesce(array_agg(a.subject_id), '{}') into v_juniors from public.sales_lead_access a where a.viewer_id = v_uid;
  v_from := case p_period when 'today' then v_today when 'week' then v_today - 6 when 'month' then v_today - 29 else null end;

  with mine as (
    select l.* from public.sales_leads l
    where v_all or l.assigned_to = v_uid or l.assigned_to = any (v_juniors) or (l.assigned_to is null and l.created_by = v_uid)
  ),
  periods as (
    select jsonb_build_object(
      'today', count(*) filter (where received_on = v_today),
      'week',  count(*) filter (where received_on >= v_today - 6),
      'month', count(*) filter (where received_on >= v_today - 29),
      'all',   count(*)
    ) as j from mine
  ),
  base as (
    select l.id, l.lead_no, l.received_on, l.assigned_to, (l.stage in ('converted', 'dead') or l.is_history) as closed
    from mine l
    where (v_from is null or l.received_on >= v_from)
      and (coalesce(p_source, '') = '' or l.source = p_source)
      and (v_q = ''
        or (length(v_digits) >= 3 and l.phone_e164 like '%' || v_digits || '%')
        or (v_norm is not null and l.phone_e164 = v_norm)
        or l.name ilike v_like or l.email ilike v_like or l.location ilike v_like or l.requirement ilike v_like)
  ),
  held as (
    select assigned_to, count(*)::integer as n from base where assigned_to is not null group by assigned_to
  ),
  shown as (
    select b.id, b.lead_no, b.received_on
    from base b
    where coalesce(p_holder, 'all') in ('all', '')
       or (p_holder = 'none' and b.assigned_to is null and not b.closed)
       or (v_holder is not null and b.assigned_to = v_holder)
  )
  select
    (select j from periods),
    (select count(*) from base),
    (select count(*) from base where assigned_to is null and not closed),
    (select coalesce(jsonb_agg(jsonb_build_object('id', h.assigned_to, 'name', u.full_name, 'n', h.n) order by u.full_name), '[]'::jsonb)
       from held h join public.users u on u.id = h.assigned_to),
    (select count(*) from shown),
    (select coalesce(jsonb_agg(public.sales_lead_row(s) order by s.received_on desc, s.lead_no desc), '[]'::jsonb)
       from public.sales_leads s
       where s.id in (select x.id from shown x order by x.received_on desc, x.lead_no desc limit v_lim offset v_off))
  into v_periods, v_everyone, v_unallotted, v_holders, v_total, v_rows;

  return jsonb_build_object(
    'periods', v_periods,
    'everyone', v_everyone,
    'unallotted', v_unallotted,
    'holders', v_holders,
    'total', v_total,
    'rows', v_rows
  );
end;
$$;

create or replace function public.sales_board(
  p_holder text default 'all',
  p_market text default null,
  p_segment text default null,
  p_temperature text default null,
  p_source text default null,
  p_q text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public.sales_leads_require(null);
  v_all boolean := public.sales_lead_sees_all(v_uid);
  v_juniors uuid[];
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_q text := btrim(coalesce(p_q, ''));
  v_digits text := regexp_replace(btrim(coalesce(p_q, '')), '[^0-9]', '', 'g');
  v_like text := '%' || replace(replace(replace(btrim(coalesce(p_q, '')), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  v_holder uuid := case when p_holder ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_holder::uuid end;
  v_result jsonb;
begin
  select coalesce(array_agg(a.subject_id), '{}') into v_juniors from public.sales_lead_access a where a.viewer_id = v_uid;

  with mine as (
    select l.*, public.sales_lead_stuck(l) as is_stuck from public.sales_leads l
    where l.assigned_to is not null and (v_all or l.assigned_to = v_uid or l.assigned_to = any (v_juniors))
  ),
  filtered as (
    select l.* from mine l
    where (v_holder is null or l.assigned_to = v_holder)
      and (coalesce(p_market, '') = '' or l.market = p_market)
      and (coalesce(p_segment, '') = '' or l.segment = p_segment)
      and (coalesce(p_temperature, '') = '' or l.temperature = p_temperature)
      and (coalesce(p_source, '') = '' or l.source = p_source)
      and (v_q = ''
        or (length(v_digits) >= 3 and l.phone_e164 like '%' || v_digits || '%')
        or l.name ilike v_like or l.location ilike v_like or l.requirement ilike v_like)
  ),
  shown as (
    select l.*, row_number() over (
      partition by l.stage
      order by
        case when l.stage in ('converted', 'dead') then 0 else 1 end,
        l.closed_at desc nulls last,
        case when l.stage = 'follow_up_later' then 3 when l.next_due_on < v_today then 0 when l.next_due_on = v_today then 1 else 2 end,
        case l.temperature when 'hot' then 0 when 'warm' then 1 else 2 end,
        l.expected_value_paise desc nulls last,
        l.next_due_on, l.lead_no
    ) as rn
    from filtered l
    where l.stage not in ('converted', 'dead') or l.closed_at >= now() - interval '30 days'
  ),
  open_leads as (
    select l.* from filtered l where l.stage not in ('converted', 'dead')
  )
  select jsonb_build_object(
    'stats', (
      select jsonb_build_object(
        'open', count(*),
        'value_paise', coalesce(sum(l.expected_value_paise), 0),
        'overdue', count(*) filter (where l.stage <> 'follow_up_later' and l.next_due_on < v_today),
        'due_today', count(*) filter (where l.stage <> 'follow_up_later' and l.next_due_on = v_today),
        'stuck', count(*) filter (where l.is_stuck)
      ) from open_leads l
    ),
    'stages', (
      select coalesce(jsonb_object_agg(g.stage, jsonb_build_object('n', g.n, 'value_paise', g.v)), '{}'::jsonb)
      from (select stage, count(*) as n, coalesce(sum(expected_value_paise), 0) as v from shown group by stage) g
    ),
    'rows', (
      select coalesce(jsonb_agg(public.sales_lead_row(
        (select x from public.sales_leads x where x.id = s.id)
      ) order by s.stage, s.rn), '[]'::jsonb)
      from shown s where s.rn <= 60
    ),
    'holders', (
      select coalesce(jsonb_agg(jsonb_build_object('id', h.assigned_to, 'name', u.full_name, 'n', h.n) order by u.full_name), '[]'::jsonb)
      from (select assigned_to, count(*)::integer as n from mine where stage not in ('converted', 'dead') group by assigned_to) h
      join public.users u on u.id = h.assigned_to
    ),
    -- Only somebody who can do something about the queue is told its size.
    'waiting_allotment', case when v_all then (
      select count(*) from public.sales_leads l where l.assigned_to is null and l.stage not in ('converted', 'dead') and not l.is_history
    ) end
  ) into v_result;

  return v_result;
end;
$$;

create or replace function public.record_sales_lead_enquiry(p_id uuid, p_source text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public.sales_leads_require('create');
  v_row public.sales_leads;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_closed boolean;
begin
  select * into v_row from public.sales_leads where id = p_id for update;
  if v_row.id is null then raise exception 'SALES_NOT_FOUND'; end if;
  v_closed := v_row.stage in ('converted', 'dead');

  update public.sales_leads
  set stage = case when v_closed then 'new' else stage end,
      stage_changed_at = case when v_closed then now() else stage_changed_at end,
      dead_reason = case when v_closed then null else dead_reason end,
      dead_note = case when v_closed then null else dead_note end,
      closed_at = case when v_closed then null else closed_at end,
      next_step = case when assigned_to is null then next_step when v_closed then 'Call back' else next_step end,
      next_due_on = case when assigned_to is null then next_due_on when v_closed then v_today else least(next_due_on, v_today) end,
      enquired_again_at = now(),
      is_history = false,
      updated_at = now()
  where id = p_id
  returning * into v_row;

  insert into public.sales_lead_events (lead_id, kind, detail, actor)
  values (p_id, 'enquired_again', left(concat_ws(': ', p_source, nullif(btrim(p_note), '')), 200), v_uid);

  if v_row.assigned_to is not null and v_row.assigned_to <> v_uid then
    perform public.sales_lead_notify(v_row.assigned_to, p_id, 'sales_lead_enquired_again', 'A lead enquired again',
      coalesce(v_row.name, v_row.phone_e164) || ' came back. Call today.');
  end if;
  return jsonb_build_object('status', 'saved', 'lead', public.sales_lead_json(v_row));
end;
$$;

create or replace function public.allot_sales_lead(p_id uuid, p_to uuid, p_expected_from uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public.sales_leads_require('assign');
  v_row public.sales_leads;
begin
  if p_to is null or not public.sales_lead_can_hold(p_to) then
    raise exception 'SALES_INVALID: Choose somebody with a Sales job.';
  end if;
  select * into v_row from public.sales_leads where id = p_id for update;
  if v_row.id is null then raise exception 'SALES_NOT_FOUND'; end if;
  if v_row.assigned_to is distinct from p_expected_from then
    raise exception 'SALES_CHANGED: Somebody changed who holds this lead. The list has been refreshed.';
  end if;
  if v_row.assigned_to = p_to then
    return jsonb_build_object('status', 'unchanged', 'lead', public.sales_lead_json(v_row));
  end if;

  update public.sales_leads
  set assigned_to = p_to, assigned_at = now(), assigned_by = v_uid, updated_at = now(), is_history = false,
      next_step = coalesce(next_step, case when stage in ('converted', 'dead') then null else 'First call' end),
      next_due_on = coalesce(next_due_on, case when stage in ('converted', 'dead') then null else (now() at time zone 'Asia/Kolkata')::date end)
  where id = p_id
  returning * into v_row;

  insert into public.sales_lead_events (lead_id, kind, from_user, to_user, actor)
  values (p_id, case when p_expected_from is null then 'allotted' else 'reassigned' end, p_expected_from, p_to, v_uid);

  if p_to <> v_uid and v_row.stage not in ('converted', 'dead') then
    perform public.sales_lead_notify(p_to, p_id, 'sales_lead_allotted', 'New lead for you',
      coalesce(v_row.name, v_row.phone_e164) || '. Call today.');
  end if;
  return jsonb_build_object('status', 'saved', 'lead', public.sales_lead_json(v_row));
end;
$$;

-- ═══ 4. The import ══════════════════════════════════════════════════════════════════════════════════════════════

-- Rows arrive already read and cleaned by the browser (src/lib/salesLeads/sheets.ts), up to 500 at a time:
--   { phone, received_on (yyyy-mm-dd or null), source, name, email, location, requirement, detail }
-- detail is the history line, e.g. "Leads Master 2025, given to Ashok". Nobody is notified.
create function public.import_sales_lead_sheet(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := public.sales_leads_require('assign');
  r jsonb;
  v_phone text;
  v_ref text;
  v_lead uuid;
  v_on date;
  v_at timestamptz;
  v_req text;
  v_email text;
  v_history integer := 0;
  v_filled integer := 0;
  v_already integer := 0;
  v_failed jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) > 500 then
    raise exception 'SALES_INVALID: Send up to 500 rows at a time.';
  end if;
  if not exists (select 1 from public.sales_lead_imports) then
    raise exception 'SALES_INVALID: Import the ClickUp files first, so every lead keeps its ClickUp stage and salesperson.';
  end if;

  for r in select value from jsonb_array_elements(p_rows) loop
    v_phone := public.normalize_lead_phone(r ->> 'phone');
    if v_phone is null then
      v_failed := v_failed || jsonb_build_object('phone', left(r ->> 'phone', 40), 'why', 'no valid number');
      continue;
    end if;
    v_ref := 'sheet:' || md5(r::text);
    if exists (select 1 from public.sales_lead_import_refs x where x.ref = v_ref) then
      v_already := v_already + 1;
      continue;
    end if;

    begin
      v_on := nullif(r ->> 'received_on', '')::date;
      v_at := case when v_on is null then now() else (v_on + time '10:00') at time zone 'Asia/Kolkata' end;
      v_req := left(nullif(btrim(r ->> 'requirement'), ''), 4000);
      v_email := lower(nullif(btrim(r ->> 'email'), ''));
      if v_email is not null and (length(v_email) > 120 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then v_email := null; end if;
      v_lead := null;
      select l.id into v_lead from public.sales_leads l where l.phone_e164 = v_phone for update;

      if v_lead is not null then
        update public.sales_leads l
        set name = coalesce(l.name, left(nullif(btrim(r ->> 'name'), ''), 120)),
            email = coalesce(l.email, v_email),
            location = coalesce(l.location, left(nullif(btrim(r ->> 'location'), ''), 120)),
            requirement = case
              when v_req is null then l.requirement
              when l.requirement is null then v_req
              when position(left(v_req, 200) in l.requirement) > 0 then l.requirement
              else left(l.requirement || E'\n\n' || v_req, 4000)
            end,
            updated_at = now()
        where l.id = v_lead;
        v_filled := v_filled + 1;
      elsif v_on is null then
        v_failed := v_failed || jsonb_build_object('phone', v_phone, 'why', 'no date');
        continue;
      else
        insert into public.sales_leads (received_on, phone_e164, source, name, email, location, requirement,
          created_by, created_at, imported_at, is_history)
        values (v_on, v_phone, coalesce(nullif(r ->> 'source', ''), 'others'), left(nullif(btrim(r ->> 'name'), ''), 120), v_email,
          left(nullif(btrim(r ->> 'location'), ''), 120), v_req, v_uid, v_at, now(), true)
        returning id into v_lead;
        v_history := v_history + 1;
      end if;

      insert into public.sales_lead_events (lead_id, kind, detail, actor, at)
      values (v_lead, 'imported', left(nullif(btrim(r ->> 'detail'), ''), 200), v_uid, v_at);
      insert into public.sales_lead_import_refs (ref, lead_id, at) values (v_ref, v_lead, v_at);
    exception
      when check_violation or not_null_violation or invalid_text_representation or datetime_field_overflow
        or invalid_datetime_format or string_data_right_truncation then
        v_failed := v_failed || jsonb_build_object('phone', v_phone, 'why', 'details the database refused');
    end;
  end loop;

  return jsonb_build_object('history', v_history, 'filled', v_filled, 'already', v_already, 'failed', v_failed);
end;
$$;

-- ═══ 5. Who may call what ════════════════════════════════════════════════════════════════════════════════════════

revoke all on function public.import_sales_lead_sheet(jsonb) from public, anon;
grant execute on function public.import_sales_lead_sheet(jsonb) to authenticated;

-- ═══ 6. Self-checks ══════════════════════════════════════════════════════════════════════════════════════════════

do $$
declare v_fn text;
begin
  foreach v_fn in array array[
    'public.import_sales_lead_sheet(jsonb)', 'public.sales_leads_page(text, text, text, text, integer, integer)',
    'public.sales_board(text, text, text, text, text, text)', 'public.record_sales_lead_enquiry(uuid, text, text)',
    'public.allot_sales_lead(uuid, uuid, uuid)'
  ] loop
    if has_function_privilege('anon', v_fn, 'EXECUTE') then raise exception 'SALES_SHEETS: % is open to anon', v_fn; end if;
    if not has_function_privilege('authenticated', v_fn, 'EXECUTE') then raise exception 'SALES_SHEETS: % lost its grant', v_fn; end if;
  end loop;
  if has_function_privilege('authenticated', 'public.sales_lead_row(public.sales_leads)', 'EXECUTE') then
    raise exception 'SALES_SHEETS: sales_lead_row is internal';
  end if;
end $$;
