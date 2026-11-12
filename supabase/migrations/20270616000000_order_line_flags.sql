-- ════════════════════════════════════════════════════════════════════════════
-- 20270616000000  OPERATIONS FLAGS PI LINES BEFORE AN ORDER IS ALIGNED
-- ════════════════════════════════════════════════════════════════════════════
--
-- Operations, 2026-11-12 (owner agreed the plan and its defaults the same day):
-- when they review a PI before aligning an Order they need to COMMENT on a line
-- (price very low, quantity small, design complicated) and to REJECT a line
-- they cannot make as quoted, early enough for Sales to cancel it, revise it or
-- pitch a stock design. Until now the reviewer could only accept the whole PI
-- or flag the whole PI with one reason.
--
-- WHAT THIS ADDS
--   * order_line_flags: one row per flagged line of ONE handoff (the review of
--     one PI version). kind 'comment' or 'cannot_make', one or more reasons, a
--     note (required) and an optional price Operations says the line should be.
--   * flag_order_lines(handoff, lines): validates the lines, composes a short
--     reason, then CALLS the existing decide_order_operations_handoff():
--       any 'cannot_make' -> 'clarification_needed' (the Order stays not aligned)
--       only comments     -> 'accepted' (the Order is aligned, as today)
--     and only then saves the flags. decide_order_operations_handoff() is NOT
--     re-emitted: its authority rule (the assigned reviewer, nobody in their
--     place), its lock order, the 40% advance rule, the Order history, the
--     approver's notice and the salesperson's notice (trigger
--     order_operations_handoff_notify) all stay exactly as they are. Calling it
--     FIRST means its row locks are taken in its own order before this function
--     writes anything that references the Order or the handoff.
--   * order_line_flags_for(order): the flags of the Order's live handoff, for
--     anyone who may read the Order's detail. The composed reason is what the
--     flagged-PI strip, Needs your decision and For you already show, so those
--     screens need no change.
--
-- WHAT IS NOT CHANGED: no permission, no policy on another table, no trigger,
-- no notification type, no existing function. Flags are internal: no client
-- document reads this table.
--
-- Roll-back:
--   drop function public.order_line_flags_for(uuid);
--   drop function public.flag_order_lines(uuid, jsonb);
--   drop function public.order_line_flags_reason(text[], text[]);
--   drop table public.order_line_flags;
-- The Order page then offers the older "Cannot accept" window again.

create table if not exists public.order_line_flags (
  id              uuid primary key default gen_random_uuid(),
  handoff_id      uuid not null references public.order_operations_handoffs(id) on delete cascade,
  order_id        uuid not null references public.orders(id) on delete cascade,
  -- SET NULL: a workbook re-parse replaces item rows; the flag stays on record
  -- with the name and code it was given.
  item_id         uuid references public.order_submission_items(id) on delete set null,
  line_code       text,
  line_title      text,
  kind            text not null check (kind in ('comment', 'cannot_make')),
  reasons         text[] not null check (
                    cardinality(reasons) >= 1
                    and reasons <@ array['price_low', 'quantity_low', 'complicated_design', 'size', 'material', 'other']::text[]),
  note            text not null check (char_length(btrim(note)) between 1 and 1000),
  suggested_price numeric(12,2) check (suggested_price is null or suggested_price > 0),
  flagged_by      uuid references public.users(id) on delete set null,
  flagged_at      timestamptz not null default now(),
  constraint order_line_flags_one_per_line unique (handoff_id, item_id)
);

comment on table public.order_line_flags is
  'Operations'' flag on one product line of one PI version under review (one handoff): a comment, or "cannot make as quoted", with reasons, a required note and an optional suggested price. Written only by flag_order_lines(); read only through order_line_flags_for(). Internal: never on a client document. 20270616000000.';

create index if not exists order_line_flags_order_idx on public.order_line_flags (order_id);

alter table public.order_line_flags enable row level security;
revoke all on table public.order_line_flags from public, anon, authenticated;


-- ═══ The reason the existing screens show ══════════════════════════════════
--
-- Pure. Entries arrive already written ("700-BE0002 Dining Chair (price too
-- low)"). The answer always fits the handoff's 1000-character limit: entries
-- that do not fit are counted ("and 3 more lines") instead of cut mid-word.

create or replace function public.order_line_flags_reason(p_cannot text[], p_comments text[])
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_cannot   int := coalesce(cardinality(p_cannot), 0);
  v_comments int := coalesce(cardinality(p_comments), 0);
  v_tail     constant text := ' The notes are on the Order''s product lines.';
  v_budget   constant int := 1000 - 60;  -- room for the tail and an "and N more" clause
  v_out      text := '';
  v_left     int := 0;
  v_entry    text;
  v_first    boolean;
begin
  if v_cannot + v_comments = 0 then
    return null;
  end if;

  if v_cannot > 0 then
    v_out := format('%s %s cannot be made as quoted: ', v_cannot, case when v_cannot = 1 then 'line' else 'lines' end);
    v_first := true;
    foreach v_entry in array p_cannot loop
      if v_left > 0 or char_length(v_out) + char_length(v_entry) + 2 > v_budget then
        v_left := v_left + 1;
      else
        v_out := v_out || case when v_first then '' else '; ' end || v_entry;
        v_first := false;
      end if;
    end loop;
    v_out := v_out || '.';
  end if;

  if v_comments > 0 then
    v_out := v_out
      || case when v_cannot > 0 then ' ' else 'Accepted with ' end
      || format('%s %s: ', v_comments, case when v_comments = 1 then 'comment' else 'comments' end);
    v_first := true;
    foreach v_entry in array p_comments loop
      if v_left > 0 or char_length(v_out) + char_length(v_entry) + 2 > v_budget then
        v_left := v_left + 1;
      else
        v_out := v_out || case when v_first then '' else '; ' end || v_entry;
        v_first := false;
      end if;
    end loop;
    v_out := v_out || '.';
  end if;

  if v_left > 0 then
    v_out := v_out || format(' And %s more %s.', v_left, case when v_left = 1 then 'line' else 'lines' end);
  end if;
  return v_out || v_tail;
end;
$$;

revoke all on function public.order_line_flags_reason(text[], text[]) from public, anon, authenticated;


-- ═══ Operations flags the lines ════════════════════════════════════════════
--
-- p_lines: [{ "item_id": uuid, "kind": "comment" | "cannot_make",
--             "reasons": ["price_low", ...], "note": "...",
--             "suggested_price": 7000 | null }]
-- Only the lines that need attention are sent; a line not sent is OK. At least
-- one line. Every item must belong to the PI version this handoff reviews.
-- Flagging again (after Sales answered and the handoff waits again) replaces
-- that handoff's earlier flags.

create or replace function public.flag_order_lines(p_handoff_id uuid, p_lines jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    uuid := public.assert_order_submission_actor();
  h          public.order_operations_handoffs%rowtype;
  v_num      text;
  v_line     jsonb;
  v_item     uuid;
  v_kind     text;
  v_reasons  text[];
  v_note     text;
  v_price    numeric(12,2);
  v_title    text;
  v_code     text;
  v_words    text;
  v_entry    text;
  v_seen     uuid[] := array[]::uuid[];
  v_rows     jsonb := '[]'::jsonb;
  v_cannot   text[] := array[]::text[];
  v_comments text[] := array[]::text[];
  v_decision text;
  v_result   jsonb;
  c_reasons  constant text[] := array['price_low', 'quantity_low', 'complicated_design', 'size', 'material', 'other'];
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'ORDER_LINE_FLAGS_NONE: flag at least one line, or accept the PI as it is' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_lines) > 200 then
    raise exception 'ORDER_LINE_FLAGS_INVALID: too many lines' using errcode = 'P0001';
  end if;

  select * into h from public.order_operations_handoffs where id = p_handoff_id;
  if not found then
    raise exception 'ORDER_OPERATIONS_HANDOFF_NOT_FOUND: that handoff no longer exists' using errcode = 'P0002';
  end if;
  -- Asked here too, before any line name is read back to the caller in an
  -- error; decide_order_operations_handoff() asks it again under its locks.
  if h.assigned_to is null then
    raise exception 'ORDER_OPERATIONS_HANDOFF_UNASSIGNED: no operations reviewer is assigned; an administrator must assign one in Control Center'
      using errcode = 'P0001';
  end if;
  if h.assigned_to <> v_actor then
    raise exception 'Only the assigned operations reviewer can flag lines on this PI' using errcode = '42501';
  end if;

  select o.display_number into v_num from public.orders o where o.id = h.order_id;
  v_num := case when v_num ~ '^0+[0-9]+$' then regexp_replace(v_num, '^0+(?=[0-9])', '') else v_num end;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(v_line) <> 'object' then
      raise exception 'ORDER_LINE_FLAGS_INVALID: each line must be an object' using errcode = 'P0001';
    end if;
    begin
      v_item := (v_line ->> 'item_id')::uuid;
    exception when others then
      raise exception 'ORDER_LINE_FLAGS_INVALID: a line has no valid item_id' using errcode = 'P0001';
    end;
    if v_item is null then
      raise exception 'ORDER_LINE_FLAGS_INVALID: a line has no item_id' using errcode = 'P0001';
    end if;
    if v_item = any (v_seen) then
      raise exception 'ORDER_LINE_FLAGS_INVALID: a line is flagged twice' using errcode = 'P0001';
    end if;
    v_seen := array_append(v_seen, v_item);

    -- One line: a workbook name can hold line breaks ("Chairs For Cafeteria\nL-corner Sofa"), seen in rehearsal.
    select left(regexp_replace(nullif(btrim(i.product_name), ''), '\s+', ' ', 'g'), 80) into v_title
      from public.order_submission_items i
     where i.id = v_item and i.submission_id = h.submission_id;
    if not found then
      raise exception 'ORDER_LINE_FLAGS_UNKNOWN_LINE: a flagged line is not on PI V% of this Order; refresh the page', h.version_number
        using errcode = 'P0001';
    end if;

    v_kind := v_line ->> 'kind';
    if v_kind is null or v_kind not in ('comment', 'cannot_make') then
      raise exception 'ORDER_LINE_FLAGS_KIND_UNKNOWN: choose Comment or Cannot make for "%"', coalesce(v_title, 'a line')
        using errcode = 'P0001';
    end if;

    if jsonb_typeof(v_line -> 'reasons') is distinct from 'array' then
      raise exception 'ORDER_LINE_FLAGS_REASON_REQUIRED: pick at least one reason for "%"', coalesce(v_title, 'a line')
        using errcode = 'P0001';
    end if;
    select array_agg(distinct r) into v_reasons from jsonb_array_elements_text(v_line -> 'reasons') r;
    if v_reasons is null then
      raise exception 'ORDER_LINE_FLAGS_REASON_REQUIRED: pick at least one reason for "%"', coalesce(v_title, 'a line')
        using errcode = 'P0001';
    end if;
    if not (v_reasons <@ c_reasons) then
      raise exception 'ORDER_LINE_FLAGS_INVALID: unknown reason for "%"', coalesce(v_title, 'a line') using errcode = 'P0001';
    end if;

    v_note := nullif(btrim(coalesce(v_line ->> 'note', '')), '');
    if v_note is null then
      raise exception 'ORDER_LINE_FLAGS_NOTE_REQUIRED: write a note for Sales on "%"', coalesce(v_title, 'a line')
        using errcode = 'P0001';
    end if;
    if char_length(v_note) > 1000 then
      raise exception 'ORDER_LINE_FLAGS_NOTE_TOO_LONG: a note may be at most 1000 characters' using errcode = 'P0001';
    end if;

    v_price := null;
    if jsonb_typeof(v_line -> 'suggested_price') = 'number' then
      begin
        v_price := (v_line ->> 'suggested_price')::numeric(12,2);
      exception when others then
        raise exception 'ORDER_LINE_FLAGS_PRICE_INVALID: the suggested price is not a usable amount' using errcode = 'P0001';
      end;
      if v_price <= 0 then
        raise exception 'ORDER_LINE_FLAGS_PRICE_INVALID: the suggested price must be more than zero' using errcode = 'P0001';
      end if;
    elsif v_line ? 'suggested_price' and jsonb_typeof(v_line -> 'suggested_price') <> 'null' then
      raise exception 'ORDER_LINE_FLAGS_PRICE_INVALID: the suggested price must be a number' using errcode = 'P0001';
    end if;

    v_code := null;
    select v_num || '-BE' || lpad(c.boe_sequence::text, 4, '0') into v_code
      from public.order_product_codes c
     where c.order_id = h.order_id and c.submission_item_id = v_item;

    select string_agg(case r
             when 'price_low' then 'price too low'
             when 'quantity_low' then 'quantity too low'
             when 'complicated_design' then 'complicated design'
             when 'size' then 'size or dimension'
             when 'material' then 'material or finish'
             else 'other' end, ', ' order by array_position(c_reasons, r))
      into v_words
      from unnest(v_reasons) r;
    v_entry := concat_ws(' ', v_code, coalesce(v_title, 'Product'))
      || ' (' || v_words
      || case when v_price is null then ''
              else ', should be ₹' || case when v_price = trunc(v_price) then trunc(v_price)::bigint::text else v_price::text end
         end
      || ')';

    if v_kind = 'cannot_make' then
      v_cannot := array_append(v_cannot, v_entry);
    else
      v_comments := array_append(v_comments, v_entry);
    end if;

    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'item_id', v_item, 'line_code', v_code, 'line_title', v_title, 'kind', v_kind,
      'reasons', to_jsonb(v_reasons), 'note', v_note, 'suggested_price', v_price));
  end loop;

  v_decision := case when cardinality(v_cannot) > 0 then 'clarification_needed' else 'accepted' end;

  -- THE EXISTING DECISION, unchanged. It re-checks authority and state under
  -- its own row locks, aligns or un-aligns the Order, writes the history and
  -- tells the approver and the salesperson. If it refuses, nothing below runs
  -- and the whole call rolls back.
  v_result := public.decide_order_operations_handoff(p_handoff_id, v_decision, public.order_line_flags_reason(v_cannot, v_comments));

  delete from public.order_line_flags where handoff_id = p_handoff_id;
  insert into public.order_line_flags
    (handoff_id, order_id, item_id, line_code, line_title, kind, reasons, note, suggested_price, flagged_by)
  select p_handoff_id, h.order_id, (x ->> 'item_id')::uuid, x ->> 'line_code', x ->> 'line_title', x ->> 'kind',
         array(select jsonb_array_elements_text(x -> 'reasons')), x ->> 'note',
         (x ->> 'suggested_price')::numeric(12,2), v_actor
    from jsonb_array_elements(v_rows) x;

  return v_result || jsonb_build_object('cannot_make', cardinality(v_cannot), 'comments', cardinality(v_comments));
end;
$$;

comment on function public.flag_order_lines(uuid, jsonb) is
  'The assigned operations reviewer flags lines of the PI version under review: comment or cannot_make, reasons, a required note, an optional suggested price. Any cannot_make flags the version (decide_order_operations_handoff clarification_needed: the Order stays not aligned); comments only accept it (aligned). The decision is made by decide_order_operations_handoff() unchanged; the flags are saved after it, replacing this handoff''s earlier flags. 20270616000000.';

revoke execute on function public.flag_order_lines(uuid, jsonb) from public, anon;
grant  execute on function public.flag_order_lines(uuid, jsonb) to authenticated;


-- ═══ Reading the flags ═════════════════════════════════════════════════════
--
-- The flags of the Order's LIVE handoff (the version in force), oldest first,
-- with the handoff's status so a screen can tell a flag still waiting from one
-- Operations has since accepted. Anyone who may read the Order's detail; [] for
-- anyone else (nothing about the Order is revealed). Never raises for an
-- ordinary signed-in reader.

create or replace function public.order_line_flags_for(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or p_order_id is null or not public.can_read_order_detail(p_order_id) then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'item_id', f.item_id,
             'line_code', f.line_code,
             'line_title', f.line_title,
             'kind', f.kind,
             'reasons', to_jsonb(f.reasons),
             'note', f.note,
             'suggested_price', f.suggested_price,
             'flagged_at', f.flagged_at,
             'by_name', nullif(btrim(u.full_name), ''),
             'handoff_id', h.id,
             'version_number', h.version_number,
             'handoff_status', h.status)
           order by f.flagged_at, f.id)
      from public.order_line_flags f
      join public.order_operations_handoffs h on h.id = f.handoff_id and h.superseded_at is null
      left join public.users u on u.id = f.flagged_by
     where f.order_id = p_order_id), '[]'::jsonb);
end;
$$;

comment on function public.order_line_flags_for(uuid) is
  'The line flags of the Order''s live handoff, for anyone who may read the Order''s detail (can_read_order_detail); [] otherwise. Read-only. 20270616000000.';

revoke execute on function public.order_line_flags_for(uuid) from public, anon;
grant  execute on function public.order_line_flags_for(uuid) to authenticated;
