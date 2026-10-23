-- Cash journeys: every non-HDFC payment travels until it reaches the company.
--
-- Owner decision 2026-10-23. Cash and money that does not land in the company's
-- HDFC accounts (PNB, Paytm, Canara — Canara also stands for money received in
-- somebody's savings account) is carried by people: the junior who collected
-- it, a senior, Nishant, and finally Nitish, who manages company cash. A
-- payment's journey CLOSES when its holder is a company cash custodian.
--
--   * Tracked modes widen from (pnb, paytm) to (pnb, paytm, canara).
--   * A "handed over" custody event can no longer be written instantly by a
--     form: it is written only when the receiver ACCEPTS a handover, or when a
--     custodian records receiving the cash directly (marker below). The old
--     path let anyone record "handed over to Nitish" with nobody accepting.
--   * finance_cash_custodians: the admin-managed setting that says who "the
--     company" is for cash. Seeded with Nitish Bansal.
--   * receive_cash_directly: a custodian records cash they physically got.
--   * Reads: finance_unclosed_funds, finance_payment_journey,
--     finance_payment_custody_status.
--
-- NOT FINANCIAL. Nothing here touches a payment's amount, status, verification,
-- totals or allocations.
--
-- ROLLOUT: apply BEFORE the code deploys. Between the two, an old form that
-- still sends a "Handed Over" activity with a new payment is refused with a
-- readable message (CUSTODY_HANDOVER_NEEDS_ACCEPTANCE); "Collected" still works.

-- ─── 1. Tracked modes: everything except the two HDFC accounts ───────────────

create or replace function public.payment_mode_requires_custody(p_mode text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select btrim(lower(coalesce(p_mode, ''))) in ('pnb', 'paytm', 'canara');
$$;

comment on function public.payment_mode_requires_custody(text) is
  'True for the payment modes whose money is carried by people until it reaches the company: PNB, Paytm and Canara (also used for money received in somebody''s savings account). The two HDFC accounts are company bank accounts and are not tracked. 20270413000000 (was PNB and Paytm only, 20261014000000).';

do $$
declare
  v_name text;
begin
  for v_name in
    select c.conname from pg_constraint c
     where c.conrelid = 'public.finance_payment_custody_events'::regclass
       and c.contype = 'c'
       and pg_get_constraintdef(c.oid) ilike '%payment_mode_at_event%'
  loop
    execute format('alter table public.finance_payment_custody_events drop constraint %I', v_name);
  end loop;
end $$;

alter table public.finance_payment_custody_events
  add constraint finance_payment_custody_events_mode_at_event
  check (payment_mode_at_event in ('pnb', 'paytm', 'canara'));

-- ─── 2. append_payment_custody_events_internal: handed_over only on acceptance
-- Restated from 20270318000000 with two changes: the not-applicable message
-- names the three modes, and a handed_over activity needs the acceptance marker
-- (set only by accept_cash_handover and receive_cash_directly, transaction-local).

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
      'CUSTODY_MODE_NOT_APPLICABLE: a collection and handover trail is recorded only for PNB, Paytm and Canara payments.'
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

    -- A HANDOVER IS RECORDED ONLY WHEN IT IS ACCEPTED (20270413000000). The
    -- marker is transaction-local and set only by accept_cash_handover and
    -- receive_cash_directly; a form can no longer write "handed over to X" alone.
    if v_type = 'handed_over'
       and coalesce(current_setting('boe.cash_handover_accept', true), '') <> 'on' then
      raise exception
        'CUSTODY_HANDOVER_NEEDS_ACCEPTANCE: a handover is recorded when the receiver accepts it. Choose "Handed to" and the receiver will be asked to accept.'
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

-- ─── 3. accept_cash_handover sets the acceptance marker ──────────────────────
-- Restated from 20270412000000 with one added statement: the marker, set before
-- the custody events are appended.

create or replace function public.accept_cash_handover(p_handover_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_h     public.finance_cash_handovers%rowtype;
  v_item  record;
  v_name  text;
begin
  if v_actor is null or not exists (
    select 1 from public.users u where u.id = v_actor and u.is_active and coalesce(u.is_deleted, false) = false
  ) then
    raise exception 'HANDOVER_NOT_ALLOWED: sign in with an active account.' using errcode = '42501';
  end if;

  select * into v_h from public.finance_cash_handovers where id = p_handover_id for update;
  if not found then
    raise exception 'HANDOVER_NOT_FOUND: that handover does not exist.' using errcode = 'P0002';
  end if;
  if v_h.recipient_user_id <> v_actor then
    raise exception 'HANDOVER_NOT_ALLOWED: only the person it was handed to can accept it.' using errcode = '42501';
  end if;
  if v_h.status not in ('pending', 'disputed') then
    raise exception 'HANDOVER_CLOSED: this handover is already %.', v_h.status using errcode = 'P0001';
  end if;

  -- Custody history: one idempotent "handed over" per payment, keyed by the item.
  -- The marker lets append_payment_custody_events_internal accept handed_over.
  perform set_config('boe.cash_handover_accept', 'on', true);
  for v_item in
    select i.id as item_id, i.payment_request_id from public.finance_cash_handover_items i
     where i.handover_id = v_h.id order by i.payment_request_id
  loop
    perform public.append_payment_custody_events_internal(
      v_item.payment_request_id,
      jsonb_build_array(jsonb_build_object(
        'key',           'handover:' || v_item.item_id::text,
        'activity_type', 'handed_over',
        'occurred_at',   to_char(least(v_h.handed_at, now()) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'handed_by',     v_h.giver_user_id::text,
        'handed_to',     v_h.recipient_user_id::text,
        'remark',        'Handover ' || v_h.human_id || ' (accepted)' || coalesce(' - ' || v_h.note, ''))),
      v_actor);
  end loop;
  perform set_config('boe.cash_handover_accept', 'off', true);

  -- Cash in hand. Both people's locks, lower id first, so two accepts between
  -- the same pair can never deadlock. The giver's amount was reserved at create.
  if v_h.cash_from_hand > 0 or v_h.cash_new > 0 then
    perform public.finance_cash_lock(least(v_h.giver_user_id, v_h.recipient_user_id));
    perform public.finance_cash_lock(greatest(v_h.giver_user_id, v_h.recipient_user_id));

    if v_h.cash_from_hand > 0 then
      insert into public.finance_cash_balance_entries (user_id, delta, kind, handover_id, created_by)
      values (v_h.giver_user_id, -v_h.cash_from_hand, 'handover_out', v_h.id, v_actor)
      on conflict do nothing;
      insert into public.finance_cash_balance_entries (user_id, delta, kind, handover_id, created_by)
      values (v_h.recipient_user_id, v_h.cash_from_hand, 'handover_in', v_h.id, v_actor)
      on conflict do nothing;
    end if;
    if v_h.cash_new > 0 then
      insert into public.finance_cash_balance_entries (user_id, delta, kind, handover_id, note, created_by)
      values (v_h.recipient_user_id, v_h.cash_new, 'new_cash', v_h.id, v_h.cash_new_source, v_actor)
      on conflict do nothing;
    end if;
  end if;

  update public.finance_cash_handovers
     set status = 'accepted', accepted_at = now()
   where id = v_h.id;

  insert into public.finance_cash_handover_events (handover_id, event_type, actor_id)
  values (v_h.id, 'accepted', v_actor);

  select u.full_name into v_name from public.users u where u.id = v_actor;
  perform public.order_notify_users(
    array[v_h.giver_user_id], v_actor, v_h.id, 'finance_handover_accepted'::notification_type,
    'Cash handover accepted',
    coalesce(v_name, 'The recipient') || ' accepted your handover of '
      || public.finance_handover_money(v_h.total_amount) || ' (' || v_h.human_id || ').');
end $$;

-- ─── 4. Company cash custodians ──────────────────────────────────────────────

create table if not exists public.finance_cash_custodians (
  user_id  uuid primary key references public.users(id),
  added_by uuid references public.users(id),
  added_at timestamptz not null default now()
);

alter table public.finance_cash_custodians enable row level security;

drop policy if exists finance_cash_custodians_select on public.finance_cash_custodians;
create policy finance_cash_custodians_select on public.finance_cash_custodians
  for select to authenticated using (true);

revoke all on public.finance_cash_custodians from public, anon, authenticated;
grant select on public.finance_cash_custodians to authenticated;

-- Seed: Nitish Bansal, who manages company cash. Exactly one active match, or stop.
do $$
declare
  v_count int;
begin
  if exists (select 1 from public.finance_cash_custodians) then
    return;
  end if;
  select count(*) into v_count from public.users u
   where u.full_name = 'Nitish Bansal' and u.is_active and coalesce(u.is_deleted, false) = false;
  if v_count <> 1 then
    raise exception 'CUSTODIAN_SEED: expected exactly one active user named Nitish Bansal, found %', v_count;
  end if;
  insert into public.finance_cash_custodians (user_id)
  select u.id from public.users u
   where u.full_name = 'Nitish Bansal' and u.is_active and coalesce(u.is_deleted, false) = false;
end $$;

create or replace function public.finance_is_cash_custodian(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.finance_cash_custodians c where c.user_id = p_user)
$$;
revoke all on function public.finance_is_cash_custodian(uuid) from public, anon, authenticated;

create or replace function public.finance_payment_is_closed(p_payment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.finance_is_cash_custodian(public.finance_payment_current_holder(p_payment_id))
$$;
revoke all on function public.finance_payment_is_closed(uuid) from public, anon, authenticated;

-- Admin only; the list is replaced whole and may never be empty.
create or replace function public.set_finance_cash_custodians(p_user_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_ids   uuid[];
begin
  if v_actor is null or not exists (
    select 1 from public.users u
     where u.id = v_actor and u.role = 'admin' and u.is_active and coalesce(u.is_deleted, false) = false
  ) then
    raise exception 'HANDOVER_NOT_ALLOWED: only an administrator can change who receives cash for the company.'
      using errcode = '42501';
  end if;
  select coalesce(array_agg(distinct x), '{}') into v_ids from unnest(coalesce(p_user_ids, '{}'::uuid[])) as x;
  if coalesce(array_length(v_ids, 1), 0) = 0 then
    raise exception 'CUSTODIAN_REQUIRED: at least one person must receive cash for the company.' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from unnest(v_ids) as x
     where not exists (select 1 from public.users u where u.id = x and u.is_active and coalesce(u.is_deleted, false) = false)
  ) then
    raise exception 'CUSTODIAN_INVALID: everyone chosen must be an active employee.' using errcode = 'P0001';
  end if;
  delete from public.finance_cash_custodians where user_id <> all (v_ids);
  insert into public.finance_cash_custodians (user_id, added_by)
  select x, v_actor from unnest(v_ids) as x
  on conflict (user_id) do nothing;
end $$;
revoke all on function public.set_finance_cash_custodians(uuid[]) from public, anon;
grant execute on function public.set_finance_cash_custodians(uuid[]) to authenticated;

-- ─── 5. Who may look at one payment's cash journey ───────────────────────────

create or replace function public.finance_cash_sees_all(p_actor uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.users u where u.id = p_actor and u.role = 'admin' and u.is_active)
      or public.finance_is_cash_custodian(p_actor)
      or (public.module_entry_open('finance') and public.actor_has_module_permission('finance', 'view_all'))
$$;
revoke all on function public.finance_cash_sees_all(uuid) from public, anon, authenticated;

create or replace function public.finance_cash_payment_readable(p_payment_id uuid, p_actor uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.finance_cash_sees_all(p_actor)
      or exists (select 1 from public.finance_payment_requests f where f.id = p_payment_id and f.submitted_by = p_actor)
      or public.finance_payment_current_holder(p_payment_id) = p_actor
      or exists (
           select 1 from public.finance_cash_handover_items i
             join public.finance_cash_handovers h on h.id = i.handover_id
            where i.payment_request_id = p_payment_id
              and (h.giver_user_id = p_actor or h.recipient_user_id = p_actor))
      or exists (
           select 1 from public.finance_payment_custody_events e
            where e.payment_request_id = p_payment_id
              and p_actor in (e.collected_by_user_id, e.handed_by_user_id, e.handed_to_user_id))
      or public.can_read_payment_as_participant(p_payment_id)
      or (public.module_entry_open('finance') and public.actor_has_module_permission('finance', 'approve'))
$$;
revoke all on function public.finance_cash_payment_readable(uuid, uuid) from public, anon, authenticated;

-- ─── 6. A custodian records cash they received directly ──────────────────────

create or replace function public.receive_cash_directly(p_payment_ids uuid[], p_note text default null)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  uuid := auth.uid();
  v_note   text := nullif(btrim(coalesce(p_note, '')), '');
  v_ids    uuid[];
  v_id     uuid;
  v_pay    record;
  v_holder uuid;
  v_h      record;
  v_name   text;
  v_count  integer := 0;
begin
  if v_actor is null or not exists (
    select 1 from public.users u where u.id = v_actor and u.is_active and coalesce(u.is_deleted, false) = false
  ) or not public.finance_is_cash_custodian(v_actor) then
    raise exception 'HANDOVER_NOT_ALLOWED: only the person who receives cash for the company can do this.'
      using errcode = '42501';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'HANDOVER_NOTE_TOO_LONG: keep the note under 500 characters.' using errcode = 'P0001';
  end if;

  select coalesce(array_agg(distinct x order by x), '{}') into v_ids
    from unnest(coalesce(p_payment_ids, '{}'::uuid[])) as x;
  if coalesce(array_length(v_ids, 1), 0) = 0 then
    raise exception 'HANDOVER_PAYMENTS_REQUIRED: choose at least one payment.' using errcode = 'P0001';
  end if;
  if array_length(v_ids, 1) > 50 then
    raise exception 'HANDOVER_TOO_MANY: at most 50 payments at once.' using errcode = 'P0001';
  end if;

  select u.full_name into v_name from public.users u where u.id = v_actor;

  foreach v_id in array v_ids loop
    select f.id, f.status, f.payment_mode, f.deleted_at, f.human_payment_id
      into v_pay from public.finance_payment_requests f where f.id = v_id for update;
    if not found then
      raise exception 'HANDOVER_PAYMENT_INVALID: a chosen payment no longer exists.' using errcode = 'P0002';
    end if;
    if v_pay.deleted_at is not null or v_pay.status = 'rejected' then
      raise exception 'HANDOVER_PAYMENT_INVALID: payment % is deleted or rejected.', coalesce(v_pay.human_payment_id, '') using errcode = 'P0001';
    end if;
    if not public.payment_mode_requires_custody(v_pay.payment_mode) then
      raise exception 'HANDOVER_PAYMENT_INVALID: payment % went to an HDFC account; there is no cash to receive.', coalesce(v_pay.human_payment_id, '') using errcode = 'P0001';
    end if;
    if public.finance_payment_is_closed(v_id) then
      raise exception 'HANDOVER_ALREADY_CLOSED: payment % is already with the company.', coalesce(v_pay.human_payment_id, '') using errcode = 'P0001';
    end if;

    -- Any open handover carrying this payment is superseded: the cash is here.
    for v_h in
      select h.* from public.finance_cash_handovers h
        join public.finance_cash_handover_items i on i.handover_id = h.id
       where i.payment_request_id = v_id and h.status in ('pending', 'disputed')
       for update of h
    loop
      update public.finance_cash_handovers
         set status = 'cancelled', cancelled_at = now(), cancelled_by = v_actor,
             cancel_reason = 'Received directly by ' || coalesce(v_name, 'the company')
       where id = v_h.id;
      insert into public.finance_cash_handover_events (handover_id, event_type, actor_id, note)
      values (v_h.id, 'cancelled', v_actor, 'Received directly by ' || coalesce(v_name, 'the company'));
      perform public.order_notify_users(
        array[v_h.giver_user_id, v_h.recipient_user_id], v_actor, v_h.id,
        'finance_handover_cancelled'::notification_type,
        'Cash handover closed',
        coalesce(v_name, 'The company') || ' received the cash directly, so handover ' || v_h.human_id || ' is closed.');
    end loop;

    v_holder := public.finance_payment_current_holder(v_id);

    perform set_config('boe.cash_handover_accept', 'on', true);
    perform public.append_payment_custody_events_internal(
      v_id,
      jsonb_build_array(jsonb_build_object(
        'key',           'receive:' || v_id::text || ':' || coalesce(v_holder::text, 'none'),
        'activity_type', 'handed_over',
        'occurred_at',   to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'handed_by',     v_holder::text,
        'handed_to',     v_actor::text,
        'remark',        'Received directly by ' || coalesce(v_name, 'the company') || coalesce(' - ' || v_note, ''))),
      v_actor);
    perform set_config('boe.cash_handover_accept', 'off', true);

    if v_holder is not null and v_holder <> v_actor then
      perform public.order_notify_users(
        array[v_holder], v_actor, null, 'finance_handover_accepted'::notification_type,
        'Cash received by the company',
        coalesce(v_name, 'The company') || ' recorded receiving payment ' || coalesce(v_pay.human_payment_id, '') || ' from you.');
    end if;
    v_count := v_count + 1;
  end loop;

  return v_count;
end $$;
revoke all on function public.receive_cash_directly(uuid[], text) from public, anon;
grant execute on function public.receive_cash_directly(uuid[], text) to authenticated;

-- ─── 7. Reads ────────────────────────────────────────────────────────────────

-- One row of a payment's cash state, as JSON. Internal: callers check access.
create or replace function public.finance_cash_payment_state(p_payment_id uuid, p_actor uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_pay    record;
  v_holder uuid;
  v_since  timestamptz;
  v_h      record;
  v_closed boolean;
  v_state  text;
begin
  select f.id, f.human_payment_id, f.client_name, f.amount, f.payment_mode, f.payment_date,
         f.created_at, f.submitted_by, f.status
    into v_pay from public.finance_payment_requests f where f.id = p_payment_id;
  if not found then return null; end if;

  v_holder := public.finance_payment_current_holder(p_payment_id);
  v_closed := public.finance_is_cash_custodian(v_holder);

  select e.occurred_at into v_since
    from public.finance_payment_custody_events e
   where e.payment_request_id = p_payment_id
   order by e.occurred_at desc, e.created_at desc limit 1;
  v_since := coalesce(v_since, v_pay.created_at);

  select h.id, h.human_id, h.status, h.giver_user_id, h.recipient_user_id, h.created_at,
         ru.full_name as recipient_name, gu.full_name as giver_name
    into v_h
    from public.finance_cash_handover_items i
    join public.finance_cash_handovers h on h.id = i.handover_id
    join public.users ru on ru.id = h.recipient_user_id
    join public.users gu on gu.id = h.giver_user_id
   where i.payment_request_id = p_payment_id and h.status in ('pending', 'disputed')
   order by h.created_at desc limit 1;

  v_state := case
    when v_closed then 'with_company'
    when v_h.id is not null and v_h.status = 'disputed' then 'disputed'
    when v_h.id is not null then 'waiting'
    else 'with_holder' end;

  return jsonb_build_object(
    'payment_id', v_pay.id,
    'human_payment_id', v_pay.human_payment_id,
    'client_name', v_pay.client_name,
    'amount', v_pay.amount,
    'payment_mode', v_pay.payment_mode,
    'payment_date', v_pay.payment_date,
    'recorded_at', v_pay.created_at,
    'tracked', public.payment_mode_requires_custody(v_pay.payment_mode)
                 and v_pay.status <> 'rejected',
    'state', v_state,
    'holder_id', v_holder,
    'holder_name', (select u.full_name from public.users u where u.id = v_holder),
    'holder_since', v_since,
    'age_hours', round((extract(epoch from now() - v_since) / 3600)::numeric, 1),
    'open_handover', case when v_h.id is null then null else jsonb_build_object(
        'id', v_h.id, 'human_id', v_h.human_id, 'status', v_h.status,
        'giver_id', v_h.giver_user_id, 'giver_name', v_h.giver_name,
        'recipient_id', v_h.recipient_user_id, 'recipient_name', v_h.recipient_name,
        'created_at', v_h.created_at) end,
    'can_accept', v_h.id is not null and v_h.recipient_user_id = p_actor,
    'can_hand_over', not v_closed and v_h.id is null and v_holder = p_actor,
    'can_receive', not v_closed and public.finance_is_cash_custodian(p_actor)
  );
end $$;
revoke all on function public.finance_cash_payment_state(uuid, uuid) from public, anon, authenticated;

-- Every tracked payment not yet with the company. Admins, custodians and
-- finance.view_all holders see all; everyone else sees the money they hold or
-- are being asked to accept.
create or replace function public.finance_unclosed_funds()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_all   boolean;
  v_rows  jsonb;
begin
  if v_actor is null or not exists (
    select 1 from public.users u where u.id = v_actor and u.is_active and coalesce(u.is_deleted, false) = false
  ) then
    return jsonb_build_object('scope', 'none', 'payments', '[]'::jsonb, 'custodians', '[]'::jsonb);
  end if;
  v_all := public.finance_cash_sees_all(v_actor);

  select coalesce(jsonb_agg(s.j order by (s.j->>'holder_since') asc), '[]'::jsonb) into v_rows
    from (
      select public.finance_cash_payment_state(f.id, v_actor) as j
        from public.finance_payment_requests f
       where f.deleted_at is null
         and f.status <> 'rejected'
         and public.payment_mode_requires_custody(f.payment_mode)
         and not public.finance_payment_is_closed(f.id)
    ) s
   where v_all
      or (s.j->>'holder_id')::uuid = v_actor
      or (s.j->'open_handover'->>'recipient_id')::uuid = v_actor;

  return jsonb_build_object(
    'scope', case when v_all then 'all' else 'mine' end,
    'viewer_is_custodian', public.finance_is_cash_custodian(v_actor),
    'custodians', (select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'full_name', u.full_name) order by u.full_name), '[]'::jsonb)
                     from public.finance_cash_custodians c join public.users u on u.id = c.user_id),
    'payments', v_rows
  );
end $$;
revoke all on function public.finance_unclosed_funds() from public, anon;
grant execute on function public.finance_unclosed_funds() to authenticated;

-- Cash state of specific payments (order and PI pages). Payments the caller may
-- not look at are left out, not refused.
create or replace function public.finance_payment_custody_status(p_payment_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then return '[]'::jsonb; end if;
  return (
    select coalesce(jsonb_agg(public.finance_cash_payment_state(x, v_actor)), '[]'::jsonb)
      from (select distinct x from unnest(coalesce(p_payment_ids, '{}'::uuid[])) as x limit 200) ids
     where exists (select 1 from public.finance_payment_requests f
                    where f.id = ids.x and f.deleted_at is null
                      and public.payment_mode_requires_custody(f.payment_mode))
       and public.finance_cash_payment_readable(ids.x, v_actor)
  );
end $$;
revoke all on function public.finance_payment_custody_status(uuid[]) from public, anon;
grant execute on function public.finance_payment_custody_status(uuid[]) to authenticated;

-- One payment's whole journey, oldest first.
create or replace function public.finance_payment_journey(p_payment_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_pay   record;
  v_steps jsonb;
begin
  if v_actor is null or not public.finance_cash_payment_readable(p_payment_id, v_actor) then
    return null;
  end if;
  select f.id, f.created_at, f.submitted_by, f.amount, f.payment_mode
    into v_pay from public.finance_payment_requests f where f.id = p_payment_id;
  if not found then return null; end if;

  select coalesce(jsonb_agg(s.j order by s.at, s.ord), '[]'::jsonb) into v_steps from (
    select v_pay.created_at as at, 0 as ord, jsonb_build_object(
             'kind', 'recorded', 'at', v_pay.created_at,
             'actor_name', (select u.full_name from public.users u where u.id = v_pay.submitted_by),
             'to_name', null, 'note', null) as j
    union all
    select e.occurred_at, 1, jsonb_build_object(
             'kind', case
                       when e.activity_type = 'collected' then 'collected'
                       when e.idempotency_key like 'receive:%' then 'received_directly'
                       else 'handed_over' end,
             'at', e.occurred_at,
             'actor_name', coalesce(e.handed_by_name, bu.full_name, cu.full_name),
             'to_name', tu.full_name,
             'note', e.remark)
      from public.finance_payment_custody_events e
      left join public.users cu on cu.id = e.collected_by_user_id
      left join public.users bu on bu.id = e.handed_by_user_id
      left join public.users tu on tu.id = e.handed_to_user_id
     where e.payment_request_id = p_payment_id
       and e.idempotency_key not like 'handover:%'
    union all
    select ev.created_at, 2, jsonb_build_object(
             'kind', 'handover_' || ev.event_type,
             'at', ev.created_at,
             'actor_name', au.full_name,
             'to_name', case when ev.event_type = 'created' then ru.full_name else gu.full_name end,
             'note', ev.note,
             'handover_human_id', h.human_id)
      from public.finance_cash_handover_items i
      join public.finance_cash_handovers h on h.id = i.handover_id
      join public.finance_cash_handover_events ev on ev.handover_id = h.id
      left join public.users au on au.id = ev.actor_id
      left join public.users ru on ru.id = h.recipient_user_id
      left join public.users gu on gu.id = h.giver_user_id
     where i.payment_request_id = p_payment_id
       and ev.event_type <> 'reminded'
  ) s;

  return jsonb_build_object(
    'payment', public.finance_cash_payment_state(p_payment_id, v_actor),
    'steps', v_steps
  );
end $$;
revoke all on function public.finance_payment_journey(uuid) from public, anon;
grant execute on function public.finance_payment_journey(uuid) to authenticated;

-- ─── 8. Messages that named only PNB and Paytm ───────────────────────────────

comment on table public.finance_payment_custody_events is
  'Who physically carried a PNB, Paytm or Canara payment. Append-only. A handed_over row is written only when the receiver accepts a handover or a custodian records receiving the cash directly (20270413000000). Not financial: no total, balance, classification or gate reads this table.';
