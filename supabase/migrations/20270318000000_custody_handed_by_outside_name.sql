-- Handed Over: the person handing the money over may be an OUTSIDE courier.
--
-- Money is often sent through factory staff who are not BOE users. A handover's
-- "handed by" may therefore be EITHER a BOE user (handed_by_user_id) OR a typed
-- name (handed_by_name) — exactly one. "Handed to" and "Collected by" stay BOE
-- users. The table stays append-only; existing rows are untouched.

alter table public.finance_payment_custody_events
  add column if not exists handed_by_name text;

comment on column public.finance_payment_custody_events.handed_by_name is
  'Typed name of an outside person (e.g. factory staff, not a BOE user) who handed the money over. Exclusive with handed_by_user_id. 20270318000000.';

alter table public.finance_payment_custody_events
  drop constraint if exists finance_payment_custody_events_people;
alter table public.finance_payment_custody_events
  add constraint finance_payment_custody_events_people check (
    (activity_type = 'collected'
       and collected_by_user_id is not null
       and handed_by_user_id is null and handed_by_name is null
       and handed_to_user_id is null)
    or
    (activity_type = 'handed_over'
       and handed_to_user_id is not null
       and collected_by_user_id is null
       and ((handed_by_user_id is not null and handed_by_name is null)
         or (handed_by_user_id is null
             and handed_by_name is not null
             and btrim(handed_by_name) <> ''
             and char_length(handed_by_name) <= 120)))
  );

drop index if exists public.finance_payment_custody_events_natural_idx;
create unique index if not exists finance_payment_custody_events_natural_idx
  on public.finance_payment_custody_events (
    payment_request_id, activity_type, occurred_at,
    -- A NULL here would make every outside-name handover "different" from every
    -- other (unique indexes treat NULLs as distinct), defeating double-click
    -- protection — so the user id falls back to a zero uuid like handed_to does.
    coalesce(collected_by_user_id, handed_by_user_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(lower(btrim(handed_by_name)), ''),
    coalesce(handed_to_user_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

create or replace function public.append_payment_custody_events_internal(
  p_payment_request_id uuid,
  p_events             jsonb,
  p_actor              uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_mode     text;
  v_count    int;
  v_index    int := 0;
  v_row      jsonb;
  v_type     text;
  v_when     timestamptz;
  v_key      text;
  v_by       uuid;
  v_from     uuid;
  v_to       uuid;
  v_from_name text;
  v_inserted int := 0;
  v_id       uuid;
begin
  if p_events is null or jsonb_typeof(p_events) = 'null' then
    return jsonb_build_object('appended', 0, 'requested', 0);
  end if;

  if jsonb_typeof(p_events) <> 'array' then
    raise exception 'CUSTODY_EVENTS_INVALID: the custody activity list must be an array.'
      using errcode = 'P0001';
  end if;

  v_count := jsonb_array_length(p_events);
  if v_count = 0 then
    return jsonb_build_object('appended', 0, 'requested', 0);
  end if;

  -- A BOUND, so one call cannot take an unbounded number of row locks. Fifty
  -- hand-offs on one payment is far beyond any real trail.
  if v_count > 50 then
    raise exception
      'CUSTODY_EVENTS_TOO_MANY: at most 50 custody activities may be added in one save.'
      using errcode = 'P0001';
  end if;

  -- ── The payment, and the mode that decides whether a trail applies ──
  select f.payment_mode into v_mode
  from public.finance_payment_requests f
  where f.id = p_payment_request_id;

  if not found then
    raise exception 'PAYMENT_NOT_FOUND: that payment no longer exists.'
      using errcode = 'P0002';
  end if;

  if not public.payment_mode_requires_custody(v_mode) then
    raise exception
      'CUSTODY_MODE_NOT_APPLICABLE: a collection and handover trail is recorded only for PNB and Paytm payments.'
      using errcode = 'P0001';
  end if;

  for v_row in select jsonb_array_elements(p_events) loop
    v_index := v_index + 1;

    if jsonb_typeof(v_row) <> 'object' then
      raise exception 'CUSTODY_EVENT_ROW_INVALID: activity % is not an activity.', v_index
        using errcode = 'P0001';
    end if;

    v_key := nullif(btrim(coalesce(v_row->>'key', '')), '');
    if v_key is null then
      raise exception
        'CUSTODY_EVENT_KEY_REQUIRED: activity % carries no idempotency key.', v_index
        using errcode = 'P0001';
    end if;

    v_type := btrim(lower(coalesce(v_row->>'activity_type', '')));
    if v_type not in ('collected', 'handed_over') then
      raise exception
        'CUSTODY_EVENT_TYPE_INVALID: activity % must be Collected or Handed Over.', v_index
        using errcode = 'P0001';
    end if;

    -- A malformed timestamp is a malformed REQUEST, said in its own words so it
    -- is never mistaken for a missing one.
    begin
      v_when := (v_row->>'occurred_at')::timestamptz;
    exception when others then
      v_when := null;
    end;

    if v_when is null then
      raise exception
        'CUSTODY_EVENT_TIME_REQUIRED: activity % needs the date and time it happened.', v_index
        using errcode = 'P0001';
    end if;

    -- Bounded rather than exact, for the same reason every other date rule in
    -- this module is bounded: the browser's clock and the server's need not
    -- agree to the second.
    if v_when > now() + interval '1 day' then
      raise exception
        'CUSTODY_EVENT_TIME_FUTURE: activity % cannot have happened in the future.', v_index
        using errcode = 'P0001';
    end if;

    v_by   := null;
    v_from := null;
    v_to   := null;
    v_from_name := null;

    begin
      if v_type = 'collected' then
        v_by := nullif(btrim(coalesce(v_row->>'collected_by', '')), '')::uuid;
      else
        v_from := nullif(btrim(coalesce(v_row->>'handed_by', '')), '')::uuid;
        -- An outside courier (factory staff) is not a BOE user: a typed name.
        v_from_name := nullif(btrim(coalesce(v_row->>'handed_by_name', '')), '');
        v_to   := nullif(btrim(coalesce(v_row->>'handed_to', '')), '')::uuid;
      end if;
    exception when others then
      raise exception
        'CUSTODY_EVENT_PERSON_INVALID: activity % does not name a person.', v_index
        using errcode = 'P0001';
    end;

    if v_type = 'collected' and v_by is null then
      raise exception
        'CUSTODY_EVENT_COLLECTOR_REQUIRED: activity % must say who collected the money.', v_index
        using errcode = 'P0001';
    end if;

    -- BOTH ENDS, OR NEITHER. A handover with one end named is a record nobody
    -- can act on, which is the rule finance_payment_requests_handover_pair has
    -- stated for the legacy columns since 20260716000000.
    if v_type = 'handed_over' and (v_to is null or (v_from is null and v_from_name is null)) then
      raise exception
        'CUSTODY_EVENT_HANDOVER_INCOMPLETE: activity % must say who handed the money over and who received it.',
        v_index
        using errcode = 'P0001';
    end if;

    if v_from is not null and v_from_name is not null then
      raise exception
        'CUSTODY_EVENT_PERSON_INVALID: activity % names the person who handed the money over twice.', v_index
        using errcode = 'P0001';
    end if;

    if v_from_name is not null and char_length(v_from_name) > 120 then
      raise exception
        'CUSTODY_EVENT_PERSON_INVALID: activity % has a name that is too long.', v_index
        using errcode = 'P0001';
    end if;

    -- The people must be real. A uuid that names nobody would render as a blank
    -- in the trail, which is worse than a refusal here.
    foreach v_id in array array_remove(array[v_by, v_from, v_to], null) loop
      if not exists (select 1 from public.users u where u.id = v_id) then
        raise exception
          'CUSTODY_EVENT_PERSON_UNKNOWN: activity % names somebody who is not a BOE user.', v_index
          using errcode = 'P0001';
      end if;
    end loop;

    -- ── The insert, and the only statement in this function ──
    --
    -- NO ARBITER IS NAMED, deliberately: `do nothing` then covers the caller's
    -- key AND the natural key, so both kinds of duplicate collapse to a no-op
    -- rather than one of them raising.
    insert into public.finance_payment_custody_events
      (payment_request_id, activity_type, occurred_at,
       collected_by_user_id, handed_by_user_id, handed_by_name, handed_to_user_id,
       remark, payment_mode_at_event, created_by, idempotency_key)
    values
      (p_payment_request_id, v_type, v_when,
       v_by, v_from, v_from_name, v_to,
       nullif(btrim(coalesce(v_row->>'remark', '')), ''),
       btrim(lower(v_mode)), p_actor, v_key)
    on conflict do nothing;

    if found then
      v_inserted := v_inserted + 1;
    end if;
  end loop;

  return jsonb_build_object('appended', v_inserted, 'requested', v_count);
end $$;

comment on function public.append_payment_custody_events_internal(uuid, jsonb, uuid) is
  'Appends validated custody activities to one payment, stamping each with the payment''s CURRENT mode. Refuses outright for a mode nobody carries. Idempotent: ON CONFLICT DO NOTHING with no named arbiter, so a retried key and a re-minted duplicate both collapse to a no-op. Never updates or deletes. Executable by no role — the entry RPCs and append_payment_custody_events call it.';

revoke execute on function public.append_payment_custody_events_internal(uuid, jsonb, uuid)
  from public, anon, authenticated, service_role;
