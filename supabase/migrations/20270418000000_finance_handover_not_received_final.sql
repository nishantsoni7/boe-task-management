-- ═══════════════════════════════════════════════════════════════════════════
-- 20270418000000 — "Not received" is final; whole payments only
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE OWNER'S DECISION (2026-10-24, Phase 2 of the cash handover
-- simplification): accept the whole handover, or say it was not received, with
-- a reason. No partial receipt.
--
-- BEFORE. A recipient who disputed a handover left it OPEN: it stayed on both
-- people's banner, the giver had to Cancel it before handing the cash to anyone
-- else, the recipient could still Accept it later, and its payments stayed
-- locked (20270415000000). Separately, create_cash_handover still accepted a
-- typed cash amount (20270412000000), money not tied to any payment, although
-- no screen has offered it since 20270413000000.
--
-- NOW.
--   * "Not received" (stored status 'disputed', unchanged) is FINAL, like
--     accepted and cancelled: the guard allows nothing after it. Custody never
--     moved, so the payment is simply back with the giver, who can hand it over
--     again at once. The reason stays on the handover and in its history.
--   * Every "is this handover still open?" test means PENDING only (eleven
--     function bodies, restated below with that one edit). accept_cash_handover
--     is restated from 20270417000000: it records custody only and never
--     approves a payment (owner decision 2026-10-24); that stays true here.
--   * create_cash_handover refuses a typed cash amount: a handover carries
--     whole payments and nothing else.
--
-- UNCHANGED. Table, columns, constraints, statuses, events, notification types,
-- RLS, grants (CREATE OR REPLACE keeps them), custody history, the cash-balance
-- tables and record_cash_out / adjust_cash_balance (no row exists), Finance
-- verification, order approval and its cash exceptions.
--
-- EXISTING ROWS (production census 2026-10-24): 0 disputed, 0 pending,
-- 0 handovers with typed cash, 0 cash-balance entries. No row changes at apply.
--
-- Function bodies are extracted from their latest migrations by script, never
-- retyped; each section names its source.
--
-- ROLLOUT: apply BEFORE the code deploys. Old screens keep working: a
-- not-received handover simply stops appearing as open.
-- ROLLBACK (a new, later migration): re-emit the listed bodies from their
-- source migrations.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
begin
  if to_regprocedure('public.finance_payment_cash_lock(uuid)') is null then
    raise exception 'DEPENDENCY MISSING: 20270415000000 must be applied before this migration';
  end if;
  if position('approve_finance_payment_request' in pg_get_functiondef('public.accept_cash_handover(uuid)'::regprocedure)) > 0 then
    raise exception 'DEPENDENCY MISSING: 20270417000000 (acceptance never approves) must be applied before this migration';
  end if;
  if to_regprocedure('public.create_cash_handover(uuid, uuid[], timestamptz, text, text, numeric, numeric, text)') is null then
    raise exception 'DEPENDENCY MISSING: 20270412000000 (create_cash_handover, 8 arguments)';
  end if;
end $$;

-- ── 1. Guard: a disputed ("not received") handover is closed ──
-- Restated from 20270412000000; edit: see the section title.

create or replace function public.finance_cash_handovers_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'HANDOVER_IMMUTABLE: a handover is never deleted; cancel it instead.'
      using errcode = 'P0001';
  end if;

  if new.id is distinct from old.id
     or new.human_id is distinct from old.human_id
     or new.giver_user_id is distinct from old.giver_user_id
     or new.recipient_user_id is distinct from old.recipient_user_id
     or new.total_amount is distinct from old.total_amount
     or new.cash_from_hand is distinct from old.cash_from_hand
     or new.cash_new is distinct from old.cash_new
     or new.cash_new_source is distinct from old.cash_new_source
     or new.handed_at is distinct from old.handed_at
     or new.note is distinct from old.note
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at
     or new.idempotency_key is distinct from old.idempotency_key then
    raise exception 'HANDOVER_IMMUTABLE: who, how much and when cannot be edited; cancel and create a new handover.'
      using errcode = 'P0001';
  end if;

  if new.status is distinct from old.status then
    if not (
      (old.status = 'pending' and new.status in ('accepted', 'disputed', 'cancelled'))
    ) then
      raise exception 'HANDOVER_TRANSITION_INVALID: a % handover cannot become %.', old.status, new.status
        using errcode = 'P0001';
    end if;
  elsif old.status in ('accepted', 'disputed', 'cancelled') then
    raise exception 'HANDOVER_CLOSED: this handover is already %.', old.status
      using errcode = 'P0001';
  end if;

  return new;
end $$;

-- ── 2. dispute_cash_handover: "not received", final, in plain words ──
-- Restated from 20270410000100; edit: see the section title.

create or replace function public.dispute_cash_handover(p_handover_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  uuid := auth.uid();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_h      public.finance_cash_handovers%rowtype;
  v_name   text;
begin
  if v_actor is null or not exists (
    select 1 from public.users u where u.id = v_actor and u.is_active and coalesce(u.is_deleted, false) = false
  ) then
    raise exception 'HANDOVER_NOT_ALLOWED: sign in with an active account.' using errcode = '42501';
  end if;
  if v_reason is null or char_length(v_reason) < 3 or char_length(v_reason) > 500 then
    raise exception 'HANDOVER_REASON_REQUIRED: say why the cash was not received (3 to 500 characters).' using errcode = 'P0001';
  end if;

  select * into v_h from public.finance_cash_handovers where id = p_handover_id for update;
  if not found then
    raise exception 'HANDOVER_NOT_FOUND: that handover does not exist.' using errcode = 'P0002';
  end if;
  if v_h.recipient_user_id <> v_actor then
    raise exception 'HANDOVER_NOT_ALLOWED: only the person it was handed to can say it was not received.' using errcode = '42501';
  end if;
  if v_h.status <> 'pending' then
    raise exception 'HANDOVER_CLOSED: this handover is % and can no longer be marked not received.', v_h.status using errcode = 'P0001';
  end if;

  update public.finance_cash_handovers
     set status = 'disputed', disputed_at = now(), dispute_reason = v_reason
   where id = v_h.id;
  insert into public.finance_cash_handover_events (handover_id, event_type, actor_id, note)
  values (v_h.id, 'disputed', v_actor, v_reason);

  select u.full_name into v_name from public.users u where u.id = v_actor;
  perform public.order_notify_users(
    array[v_h.giver_user_id], v_actor, v_h.id, 'finance_handover_disputed'::notification_type,
    'Cash not received',
    coalesce(v_name, 'The recipient') || ' did not receive your handover of '
      || public.finance_handover_money(v_h.total_amount) || ' (' || v_h.human_id || '): ' || v_reason
      || '. The cash is still with you; hand it over again when you have given it.');
end $$;

-- ── 3. create_cash_handover: whole payments only; open = pending ──
-- Restated from 20270412000000; edit: see the section title.

create or replace function public.create_cash_handover(
  p_recipient       uuid,
  p_payment_ids     uuid[],
  p_handed_at       timestamptz default null,
  p_note            text default null,
  p_idempotency_key text default null,
  p_cash_from_hand  numeric default 0,
  p_cash_new        numeric default 0,
  p_cash_new_source text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor     uuid := auth.uid();
  v_key       text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_when      timestamptz := coalesce(p_handed_at, now());
  v_note      text := nullif(btrim(coalesce(p_note, '')), '');
  v_from_hand numeric := coalesce(p_cash_from_hand, 0);
  v_new       numeric := coalesce(p_cash_new, 0);
  v_source    text := nullif(btrim(coalesce(p_cash_new_source, '')), '');
  v_ids       uuid[];
  v_id        uuid;
  v_pay       record;
  v_total     numeric := 0;
  v_handover  uuid;
  v_giver     text;
  v_count     int;
  v_what      text;
begin
  if v_actor is null or not exists (
    select 1 from public.users u where u.id = v_actor and u.is_active and coalesce(u.is_deleted, false) = false
  ) then
    raise exception 'HANDOVER_NOT_ALLOWED: sign in with an active account.' using errcode = '42501';
  end if;
  if v_key is null then
    raise exception 'HANDOVER_KEY_REQUIRED: the request carries no idempotency key.' using errcode = 'P0001';
  end if;
  if p_recipient is null or p_recipient = v_actor then
    raise exception 'HANDOVER_RECIPIENT_INVALID: choose somebody other than yourself.' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.users u where u.id = p_recipient and u.is_active and coalesce(u.is_deleted, false) = false
  ) then
    raise exception 'HANDOVER_RECIPIENT_INVALID: that person is not an active employee.' using errcode = 'P0001';
  end if;
  if v_when > now() + interval '1 day' then
    raise exception 'HANDOVER_TIME_FUTURE: the handover cannot be in the future.' using errcode = 'P0001';
  end if;
  if v_note is not null and char_length(v_note) > 1000 then
    raise exception 'HANDOVER_NOTE_TOO_LONG: keep the note under 1000 characters.' using errcode = 'P0001';
  end if;

  -- 20270418000000: whole payments only. The typed cash line (20270412000000)
  -- had no UI since 20270413000000; it is now refused, so a handover always
  -- carries complete payments and nothing else.
  if coalesce(p_cash_from_hand, 0) <> 0 or coalesce(p_cash_new, 0) <> 0 then
    raise exception 'HANDOVER_FULL_PAYMENTS_ONLY: hand over whole payments only; a cash amount cannot be typed in.' using errcode = 'P0001';
  end if;

  -- The typed cash line.
  if v_from_hand < 0 or v_new < 0 or v_from_hand <> round(v_from_hand, 2) or v_new <> round(v_new, 2)
     or v_from_hand = 'NaN'::numeric or v_new = 'NaN'::numeric then
    raise exception 'HANDOVER_CASH_INVALID: enter cash amounts in rupees and paise.' using errcode = 'P0001';
  end if;
  if v_new > 0 and (v_source is null or char_length(v_source) < 3) then
    raise exception 'HANDOVER_CASH_SOURCE_REQUIRED: say where the new cash came from.' using errcode = 'P0001';
  end if;
  if v_source is not null and char_length(v_source) > 200 then
    raise exception 'HANDOVER_CASH_SOURCE_REQUIRED: keep where the cash came from under 200 characters.' using errcode = 'P0001';
  end if;
  if v_new = 0 then v_source := null; end if;

  select coalesce(array_agg(distinct x order by x), '{}') into v_ids
    from unnest(coalesce(p_payment_ids, '{}'::uuid[])) as x;
  v_count := coalesce(array_length(v_ids, 1), 0);
  if v_count = 0 and v_from_hand = 0 and v_new = 0 then
    raise exception 'HANDOVER_PAYMENTS_REQUIRED: choose at least one payment to hand over.' using errcode = 'P0001';
  end if;
  if v_count > 50 then
    raise exception 'HANDOVER_TOO_MANY: at most 50 payments in one handover.' using errcode = 'P0001';
  end if;

  -- Retry / double click: same giver + key returns the same handover.
  select h.id into v_handover from public.finance_cash_handovers h
   where h.giver_user_id = v_actor and h.idempotency_key = v_key;
  if found then return v_handover; end if;

  -- The giver's cash, under their lock: the same rupee cannot be offered twice.
  perform public.finance_cash_lock(v_actor);
  if v_from_hand > public.finance_cash_available(v_actor) then
    raise exception 'HANDOVER_CASH_NOT_AVAILABLE: you have only % available in cash in hand.',
      public.finance_handover_money(greatest(public.finance_cash_available(v_actor), 0))
      using errcode = 'P0001';
  end if;

  -- Lock payments in id order, then validate each under the lock.
  foreach v_id in array v_ids loop
    select f.id, f.amount, f.status, f.payment_mode, f.deleted_at, f.human_payment_id
      into v_pay
      from public.finance_payment_requests f
     where f.id = v_id
     for update;
    if not found then
      raise exception 'HANDOVER_PAYMENT_INVALID: a chosen payment no longer exists.' using errcode = 'P0002';
    end if;
    if v_pay.deleted_at is not null then
      raise exception 'HANDOVER_PAYMENT_INVALID: a chosen payment no longer exists.' using errcode = 'P0002';
    end if;
    if v_pay.status = 'rejected' then
      raise exception 'HANDOVER_PAYMENT_INVALID: payment % was rejected.', coalesce(v_pay.human_payment_id, '') using errcode = 'P0001';
    end if;
    if not public.payment_mode_requires_custody(v_pay.payment_mode) then
      raise exception 'HANDOVER_PAYMENT_INVALID: payment % is not a PNB or Paytm payment.', coalesce(v_pay.human_payment_id, '') using errcode = 'P0001';
    end if;
    if public.finance_payment_current_holder(v_id) is distinct from v_actor then
      raise exception 'HANDOVER_NOT_HOLDER: you are not holding the cash of payment %.', coalesce(v_pay.human_payment_id, '') using errcode = 'P0001';
    end if;
    if exists (
      select 1 from public.finance_cash_handover_items i
        join public.finance_cash_handovers h on h.id = i.handover_id
       where i.payment_request_id = v_id and h.status = 'pending'
    ) then
      raise exception 'HANDOVER_ALREADY_OPEN: payment % is already in an unconfirmed handover.', coalesce(v_pay.human_payment_id, '') using errcode = 'P0001';
    end if;
    v_total := v_total + v_pay.amount;
  end loop;

  -- Re-check the key now that the locks are held (a concurrent double click).
  select h.id into v_handover from public.finance_cash_handovers h
   where h.giver_user_id = v_actor and h.idempotency_key = v_key;
  if found then return v_handover; end if;

  v_total := v_total + v_from_hand + v_new;

  insert into public.finance_cash_handovers
    (giver_user_id, recipient_user_id, total_amount, cash_from_hand, cash_new, cash_new_source,
     handed_at, note, created_by, idempotency_key)
  values (v_actor, p_recipient, v_total, v_from_hand, v_new, v_source,
          v_when, v_note, v_actor, v_key)
  returning id into v_handover;

  if v_count > 0 then
    insert into public.finance_cash_handover_items (handover_id, payment_request_id, amount)
    select v_handover, f.id, f.amount from public.finance_payment_requests f where f.id = any (v_ids);
  end if;

  insert into public.finance_cash_handover_events (handover_id, event_type, actor_id, note)
  values (v_handover, 'created', v_actor, v_note);

  v_what := concat_ws(' + ',
    case when v_count > 0 then v_count || case when v_count = 1 then ' payment' else ' payments' end end,
    case when v_from_hand + v_new > 0 then public.finance_handover_money(v_from_hand + v_new) || ' cash' end);

  select u.full_name into v_giver from public.users u where u.id = v_actor;
  perform public.order_notify_users(
    array[p_recipient], v_actor, v_handover, 'finance_handover_requested'::notification_type,
    'Cash handed to you - please accept',
    coalesce(v_giver, 'Someone') || ' handed you ' || public.finance_handover_money(v_total)
      || ' (' || v_what || '). Accept it once you have the cash, or dispute it.');

  return v_handover;
end $$;

-- ── 4. accept_cash_handover: open = pending (a not-received handover can no longer be accepted) ──
-- Restated from 20270417000000; edit: see the section title.

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
  if v_h.status <> 'pending' then
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

-- ── 5. cancel_cash_handover: open = pending (nothing to cancel once it was not received) ──
-- Restated from 20270410000100; edit: see the section title.

create or replace function public.cancel_cash_handover(p_handover_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  uuid := auth.uid();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_h      public.finance_cash_handovers%rowtype;
  v_admin  boolean;
  v_name   text;
begin
  if v_actor is null or not exists (
    select 1 from public.users u where u.id = v_actor and u.is_active and coalesce(u.is_deleted, false) = false
  ) then
    raise exception 'HANDOVER_NOT_ALLOWED: sign in with an active account.' using errcode = '42501';
  end if;
  v_admin := exists (select 1 from public.users u where u.id = v_actor and u.role = 'admin');

  select * into v_h from public.finance_cash_handovers where id = p_handover_id for update;
  if not found then
    raise exception 'HANDOVER_NOT_FOUND: that handover does not exist.' using errcode = 'P0002';
  end if;
  if v_h.giver_user_id <> v_actor and not v_admin then
    raise exception 'HANDOVER_NOT_ALLOWED: only the giver (or an administrator) can cancel it.' using errcode = '42501';
  end if;
  if v_h.giver_user_id <> v_actor and (v_reason is null or char_length(v_reason) < 3) then
    raise exception 'HANDOVER_REASON_REQUIRED: an administrator must give a reason.' using errcode = 'P0001';
  end if;
  if v_h.status <> 'pending' then
    raise exception 'HANDOVER_CLOSED: this handover is already %.', v_h.status using errcode = 'P0001';
  end if;

  update public.finance_cash_handovers
     set status = 'cancelled', cancelled_at = now(), cancelled_by = v_actor, cancel_reason = v_reason
   where id = v_h.id;
  insert into public.finance_cash_handover_events (handover_id, event_type, actor_id, note)
  values (v_h.id, 'cancelled', v_actor, v_reason);

  select u.full_name into v_name from public.users u where u.id = v_actor;
  perform public.order_notify_users(
    array[v_h.giver_user_id, v_h.recipient_user_id], v_actor, v_h.id,
    'finance_handover_cancelled'::notification_type,
    'Cash handover cancelled',
    coalesce(v_name, 'Someone') || ' cancelled handover ' || v_h.human_id || ' of '
      || public.finance_handover_money(v_h.total_amount) || coalesce(': ' || v_reason, '.'));
end $$;

-- ── 6. remind_cash_handover: open = pending (no reminders for a closed handover) ──
-- Restated from 20270410000100; edit: see the section title.

create or replace function public.remind_cash_handover(p_handover_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_h     public.finance_cash_handovers%rowtype;
  v_name  text;
begin
  if v_actor is null then
    raise exception 'HANDOVER_NOT_ALLOWED: sign in with an active account.' using errcode = '42501';
  end if;
  select * into v_h from public.finance_cash_handovers where id = p_handover_id for update;
  if not found then
    raise exception 'HANDOVER_NOT_FOUND: that handover does not exist.' using errcode = 'P0002';
  end if;
  if v_h.giver_user_id <> v_actor then
    raise exception 'HANDOVER_NOT_ALLOWED: only the giver can send a reminder.' using errcode = '42501';
  end if;
  if v_h.status <> 'pending' then
    raise exception 'HANDOVER_CLOSED: this handover is already %.', v_h.status using errcode = 'P0001';
  end if;
  if v_h.last_reminded_at is not null and v_h.last_reminded_at > now() - interval '4 hours' then
    raise exception 'HANDOVER_REMIND_TOO_SOON: a reminder was sent less than 4 hours ago.' using errcode = 'P0001';
  end if;

  update public.finance_cash_handovers set last_reminded_at = now() where id = v_h.id;
  insert into public.finance_cash_handover_events (handover_id, event_type, actor_id)
  values (v_h.id, 'reminded', v_actor);

  select u.full_name into v_name from public.users u where u.id = v_actor;
  perform public.order_notify_users(
    array[v_h.recipient_user_id], v_actor, v_h.id, 'finance_handover_reminder'::notification_type,
    'Reminder: cash handover not accepted yet',
    coalesce(v_name, 'The giver') || ' is waiting for you to accept ' || public.finance_handover_money(v_h.total_amount)
      || ' (' || v_h.human_id || ').');
end $$;

-- ── 7. finance_handover_send_reminders: open = pending (the daily sweep skips closed handovers) ──
-- Restated from 20270410000100; edit: see the section title.

create or replace function public.finance_handover_send_reminders()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_h     record;
  v_count integer := 0;
  v_days  integer;
begin
  for v_h in
    select h.* from public.finance_cash_handovers h
     where h.status = 'pending'
       and coalesce(h.last_auto_reminded_at, h.created_at) < now() - interval '20 hours'
     order by h.created_at
  loop
    v_days := greatest(0, floor(extract(epoch from now() - v_h.created_at) / 86400)::int);
    perform public.order_notify_users(
      array[v_h.recipient_user_id], null, v_h.id, 'finance_handover_reminder'::notification_type,
      'Cash handover still waiting for you',
      public.finance_handover_money(v_h.total_amount) || ' (' || v_h.human_id || ') is '
        || case when v_h.status = 'disputed' then 'disputed and unresolved' else 'not accepted yet' end
        || ' - ' || v_days || ' day(s).');
    perform public.order_notify_users(
      array[v_h.giver_user_id], null, v_h.id, 'finance_handover_reminder'::notification_type,
      'Your cash handover is not confirmed',
      public.finance_handover_money(v_h.total_amount) || ' (' || v_h.human_id || ') has not been '
        || case when v_h.status = 'disputed' then 'resolved' else 'accepted' end
        || ' - ' || v_days || ' day(s).');
    update public.finance_cash_handovers set last_auto_reminded_at = now() where id = v_h.id;
    insert into public.finance_cash_handover_events (handover_id, event_type, note)
    values (v_h.id, 'reminded', 'Daily reminder');
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- ── 8. finance_handover_list: open = pending (flags and ordering treat it as closed) ──
-- Restated from 20270412000000; edit: see the section title.

create or replace function public.finance_handover_list(
  p_statuses  text[]  default null,
  p_only_mine boolean default true,
  p_limit     integer default 50,
  p_offset    integer default 0,
  p_id        uuid    default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_admin boolean;
  v_all   boolean;
  v_out   jsonb;
begin
  if v_actor is null or not exists (
    select 1 from public.users u where u.id = v_actor and u.is_active and coalesce(u.is_deleted, false) = false
  ) then
    return '[]'::jsonb;
  end if;
  v_admin := exists (select 1 from public.users u where u.id = v_actor and u.role = 'admin');
  v_all := not coalesce(p_only_mine, true)
    and (v_admin or (public.module_entry_open('finance') and public.actor_has_module_permission('finance', 'view_all')));

  select coalesce(jsonb_agg(r.j order by r.ord, r.created_at desc), '[]'::jsonb) into v_out
  from (
    select
      h.created_at,
      case when h.status = 'pending' then 0 else 1 end as ord,
      jsonb_build_object(
        'id', h.id,
        'human_id', h.human_id,
        'status', h.status,
        'giver_id', h.giver_user_id,
        'giver_name', gu.full_name,
        'recipient_id', h.recipient_user_id,
        'recipient_name', ru.full_name,
        'total_amount', h.total_amount,
        'cash_from_hand', h.cash_from_hand,
        'cash_new', h.cash_new,
        'cash_new_source', h.cash_new_source,
        'handed_at', h.handed_at,
        'note', h.note,
        'created_at', h.created_at,
        'accepted_at', h.accepted_at,
        'disputed_at', h.disputed_at,
        'dispute_reason', h.dispute_reason,
        'cancelled_at', h.cancelled_at,
        'cancel_reason', h.cancel_reason,
        'last_reminded_at', h.last_reminded_at,
        'age_hours', round((extract(epoch from now() - h.created_at) / 3600)::numeric, 1),
        'can_accept', (h.recipient_user_id = v_actor and h.status = 'pending'),
        'can_dispute', (h.recipient_user_id = v_actor and h.status = 'pending'),
        'can_cancel', ((h.giver_user_id = v_actor or v_admin) and h.status = 'pending'),
        'can_remind', (h.giver_user_id = v_actor and h.status = 'pending'
                       and (h.last_reminded_at is null or h.last_reminded_at < now() - interval '4 hours')),
        'items', (
          select coalesce(jsonb_agg(jsonb_build_object(
                   'payment_id', i.payment_request_id,
                   'human_payment_id', f.human_payment_id,
                   'client_name', f.client_name,
                   'amount', i.amount,
                   'payment_mode', f.payment_mode,
                   'payment_date', f.payment_date)
                 order by f.payment_date, f.human_payment_id), '[]'::jsonb)
            from public.finance_cash_handover_items i
            join public.finance_payment_requests f on f.id = i.payment_request_id
           where i.handover_id = h.id),
        'events', (
          select coalesce(jsonb_agg(jsonb_build_object(
                   'event_type', e.event_type,
                   'actor_id', e.actor_id,
                   'actor_name', eu.full_name,
                   'note', e.note,
                   'created_at', e.created_at)
                 order by e.created_at), '[]'::jsonb)
            from public.finance_cash_handover_events e
            left join public.users eu on eu.id = e.actor_id
           where e.handover_id = h.id)
      ) as j
    from public.finance_cash_handovers h
    join public.users gu on gu.id = h.giver_user_id
    join public.users ru on ru.id = h.recipient_user_id
    where (v_all or h.giver_user_id = v_actor or h.recipient_user_id = v_actor)
      and (p_statuses is null or h.status = any (p_statuses))
      and (p_id is null or h.id = p_id)
    order by case when h.status = 'pending' then 0 else 1 end, h.created_at desc
    limit least(greatest(coalesce(p_limit, 50), 1), 200)
    offset greatest(coalesce(p_offset, 0), 0)
  ) r;

  return v_out;
end $$;

-- ── 9. finance_my_handoverable_payments: open = pending (the payment can be handed over again at once) ──
-- Restated from 20270410000100; edit: see the section title.

create or replace function public.finance_my_handoverable_payments()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null or not exists (
    select 1 from public.users u where u.id = v_actor and u.is_active and coalesce(u.is_deleted, false) = false
  ) then
    return '[]'::jsonb;
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'payment_id', f.id,
             'human_payment_id', f.human_payment_id,
             'client_name', f.client_name,
             'amount', f.amount,
             'payment_mode', f.payment_mode,
             'payment_date', f.payment_date) order by f.payment_date desc, f.human_payment_id desc), '[]'::jsonb)
      from public.finance_payment_requests f
     where f.deleted_at is null
       and f.status <> 'rejected'
       and public.payment_mode_requires_custody(f.payment_mode)
       and public.finance_payment_current_holder(f.id) = v_actor
       and not exists (
         select 1 from public.finance_cash_handover_items i
           join public.finance_cash_handovers h on h.id = i.handover_id
          where i.payment_request_id = f.id and h.status = 'pending')
  );
end $$;

-- ── 10. finance_cash_reserved: open = pending (a closed handover reserves nothing) ──
-- Restated from 20270412000000; edit: see the section title.

create or replace function public.finance_cash_reserved(p_user uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(h.cash_from_hand), 0) from public.finance_cash_handovers h
   where h.giver_user_id = p_user and h.status = 'pending'
$$;

-- ── 11. finance_cash_balances: open = pending (a closed handover reserves nothing) ──
-- Restated from 20270412000000; edit: see the section title.

create or replace function public.finance_cash_balances()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_admin boolean;
begin
  if v_actor is null or not exists (
    select 1 from public.users u where u.id = v_actor and u.is_active and coalesce(u.is_deleted, false) = false
  ) then
    return jsonb_build_object('allowed', false, 'can_adjust', false, 'rows', '[]'::jsonb);
  end if;
  v_admin := exists (select 1 from public.users u where u.id = v_actor and u.role = 'admin');
  if not (v_admin or (public.module_entry_open('finance') and public.actor_has_module_permission('finance', 'view_all'))) then
    return jsonb_build_object('allowed', false, 'can_adjust', false, 'rows', '[]'::jsonb);
  end if;
  return jsonb_build_object(
    'allowed', true,
    'can_adjust', v_admin,
    'rows', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'user_id', s.id,
               'full_name', s.full_name,
               'balance', s.balance,
               'reserved', s.reserved,
               'available', s.balance - s.reserved) order by s.balance desc, s.full_name), '[]'::jsonb)
        from (
          select u.id, u.full_name,
                 public.finance_cash_balance(u.id) as balance,
                 public.finance_cash_reserved(u.id) as reserved
            from public.users u
           where exists (select 1 from public.finance_cash_balance_entries e where e.user_id = u.id)
              or exists (select 1 from public.finance_cash_handovers h
                          where h.giver_user_id = u.id and h.status = 'pending' and h.cash_from_hand > 0)
        ) s
       where s.balance <> 0 or s.reserved <> 0)
  );
end $$;

-- ── 12. receive_cash_directly: open = pending (only pending handovers are superseded) ──
-- Restated from 20270413000000; edit: see the section title.

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
       where i.payment_request_id = v_id and h.status = 'pending'
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

-- ── 13. finance_cash_payment_state: open = pending (the payment is back with its holder) ──
-- Restated from 20270414000000; edit: see the section title.

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
   where i.payment_request_id = p_payment_id and h.status = 'pending'
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
    'order_exception', (
      select jsonb_build_object('reason', x.reason, 'by_name', u.full_name, 'at', x.created_at)
        from public.order_submission_cash_exceptions x
        left join public.users u on u.id = x.created_by
       where p_payment_id = any (x.payment_ids)
       order by x.created_at desc limit 1),
    'can_accept', v_h.id is not null and v_h.recipient_user_id = p_actor,
    'can_hand_over', not v_closed and v_h.id is null and v_holder = p_actor,
    'can_receive', not v_closed and public.finance_is_cash_custodian(p_actor)
  );
end $$;

-- ── 14. finance_payment_cash_lock: open = pending (the payment lock is released (unless a transfer was accepted)) ──
-- Restated from 20270415000000; edit: see the section title.

create or replace function public.finance_payment_cash_lock(p_payment_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    -- An accepted transfer is permanent, so it wins over an open handover.
    (select jsonb_build_object('reason', 'accepted_transfer', 'handover', h.human_id)
       from public.finance_cash_handover_items i
       join public.finance_cash_handovers h on h.id = i.handover_id
      where i.payment_request_id = p_payment_id and h.status = 'accepted'
      order by h.accepted_at nulls last, h.created_at
      limit 1),
    (select jsonb_build_object('reason', 'accepted_transfer', 'handover', null)
       from public.finance_payment_custody_events e
      where e.payment_request_id = p_payment_id
        and e.activity_type = 'handed_over'
        and e.idempotency_key like 'receive:%'
      limit 1),
    (select jsonb_build_object('reason', 'open_handover', 'handover', h.human_id)
       from public.finance_cash_handover_items i
       join public.finance_cash_handovers h on h.id = i.handover_id
      where i.payment_request_id = p_payment_id and h.status = 'pending'
      order by h.created_at desc
      limit 1)
  )
$$;

-- ── Apply-time assertions — the migration refuses itself otherwise ──────────

do $$
declare
  v_fn   text;
  v_def  text;
begin
  foreach v_fn in array array[
    'public.create_cash_handover(uuid, uuid[], timestamptz, text, text, numeric, numeric, text)',
    'public.accept_cash_handover(uuid)', 'public.cancel_cash_handover(uuid, text)',
    'public.remind_cash_handover(uuid)', 'public.finance_handover_send_reminders()',
    'public.finance_handover_list(text[], boolean, integer, integer, uuid)',
    'public.finance_my_handoverable_payments()', 'public.finance_cash_reserved(uuid)',
    'public.finance_cash_balances()', 'public.receive_cash_directly(uuid[], text)',
    'public.finance_cash_payment_state(uuid, uuid)', 'public.finance_payment_cash_lock(uuid)'
  ] loop
    v_def := pg_get_functiondef(v_fn::regprocedure);
    if position('''pending'', ''disputed''' in v_def) > 0 then
      raise exception 'ASSERTION FAILED: % still treats a disputed handover as open', v_fn;
    end if;
  end loop;

  if position('approve_finance_payment_request' in pg_get_functiondef('public.accept_cash_handover(uuid)'::regprocedure)) > 0 then
    raise exception 'ASSERTION FAILED: accepting a handover approves a payment again';
  end if;

  v_def := pg_get_functiondef('public.finance_cash_handovers_guard()'::regprocedure);
  if position('old.status = ''disputed''' in v_def) > 0
     or position('elsif old.status in (''accepted'', ''disputed'', ''cancelled'')' in v_def) = 0 then
    raise exception 'ASSERTION FAILED: the guard still lets a disputed handover move';
  end if;

  v_def := pg_get_functiondef('public.create_cash_handover(uuid, uuid[], timestamptz, text, text, numeric, numeric, text)'::regprocedure);
  if position('HANDOVER_FULL_PAYMENTS_ONLY' in v_def) = 0 then
    raise exception 'ASSERTION FAILED: create_cash_handover still accepts typed cash';
  end if;

  if exists (select 1 from pg_roles where rolname = 'anon')
     and (has_function_privilege('anon', 'public.dispute_cash_handover(uuid, text)', 'execute')
       or has_function_privilege('anon', 'public.create_cash_handover(uuid, uuid[], timestamptz, text, text, numeric, numeric, text)', 'execute')) then
    raise exception 'ASSERTION FAILED: anon may call a handover write';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated')
     and (has_function_privilege('authenticated', 'public.finance_payment_cash_lock(uuid)', 'execute')
       or has_function_privilege('authenticated', 'public.finance_cash_payment_state(uuid, uuid)', 'execute')) then
    raise exception 'ASSERTION FAILED: an internal helper became client-callable';
  end if;
  raise notice '20270418000000: "not received" is final; handovers carry whole payments only';
end $$;
