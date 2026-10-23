-- Cash handover: typed cash amounts and a tracked "cash in hand" balance.
--
-- 20270410000100 let a handover carry only PNB/Paytm PAYMENTS the giver holds.
-- Owner decision 2026-10-23: a handover may also carry ONE typed cash line (or
-- only that), and typed cash is tracked as a per-person CASH IN HAND balance,
-- so whoever accepts it holds it and can hand it on later.
--
-- THE BALANCE IS A LEDGER, NOT A COLUMN. finance_cash_balance_entries is
-- append-only; a person's balance is the sum of their entries. "Available" is
-- the balance minus the typed cash they have already offered in OPEN handovers
-- (cash_from_hand of their pending/disputed handovers), so the same rupee can
-- never be offered twice, and no balance can ever go below zero.
--
-- THE TYPED LINE HAS TWO PARTS, so new money is always explained:
--   cash_from_hand  up to the giver's AVAILABLE amount (checked under a lock);
--   cash_new        cash not yet recorded anywhere, with a required source note.
-- Nothing moves until the recipient ACCEPTS: then giver -cash_from_hand,
-- recipient +cash_from_hand (+cash_new). Dispute and cancel move nothing.
--
-- Money leaves people's hands through record_cash_out (the holder: bank
-- deposit / paid out / other) or adjust_cash_balance (an admin, with a reason).
--
-- STILL NOT FINANCIAL: no payment, total, allocation or classification reads or
-- writes any of this.
--
-- ROLLOUT: apply BEFORE the code that calls create_cash_handover with the new
-- arguments deploys. The old 5-argument call keeps working (new args default).

-- ─── 1. The typed cash line on a handover ────────────────────────────────────

alter table public.finance_cash_handovers
  add column if not exists cash_from_hand  numeric not null default 0,
  add column if not exists cash_new        numeric not null default 0,
  add column if not exists cash_new_source text;

alter table public.finance_cash_handovers
  drop constraint if exists finance_cash_handovers_cash_amounts;
alter table public.finance_cash_handovers
  add constraint finance_cash_handovers_cash_amounts check (
    cash_from_hand >= 0 and cash_from_hand = round(cash_from_hand, 2) and cash_from_hand <> 'NaN'::numeric
    and cash_new >= 0 and cash_new = round(cash_new, 2) and cash_new <> 'NaN'::numeric
  );

alter table public.finance_cash_handovers
  drop constraint if exists finance_cash_handovers_cash_new_source;
alter table public.finance_cash_handovers
  add constraint finance_cash_handovers_cash_new_source check (
    (cash_new = 0 and cash_new_source is null)
    or (cash_new > 0 and char_length(btrim(coalesce(cash_new_source, ''))) between 3 and 200)
  );

-- The guard, restated with the three new columns frozen like the others.
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
      (old.status = 'pending'  and new.status in ('accepted', 'disputed', 'cancelled'))
      or (old.status = 'disputed' and new.status in ('accepted', 'cancelled'))
    ) then
      raise exception 'HANDOVER_TRANSITION_INVALID: a % handover cannot become %.', old.status, new.status
        using errcode = 'P0001';
    end if;
  elsif old.status in ('accepted', 'cancelled') then
    raise exception 'HANDOVER_CLOSED: this handover is already %.', old.status
      using errcode = 'P0001';
  end if;

  return new;
end $$;

-- ─── 2. The cash-in-hand ledger ──────────────────────────────────────────────

create table if not exists public.finance_cash_balance_entries (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.users(id),
  delta           numeric not null
                    check (delta <> 0 and delta = round(delta, 2) and delta <> 'NaN'::numeric),
  kind            text not null
                    check (kind in ('handover_in', 'handover_out', 'new_cash', 'cash_out', 'adjustment')),
  handover_id     uuid references public.finance_cash_handovers(id),
  cash_out_kind   text check (cash_out_kind in ('bank_deposit', 'paid_out', 'other')),
  note            text check (note is null or char_length(note) <= 500),
  created_by      uuid not null references public.users(id),
  created_at      timestamptz not null default now(),
  idempotency_key text,
  is_test_data    boolean not null default false,

  constraint finance_cash_balance_entries_shape check (
    (kind in ('handover_in', 'handover_out', 'new_cash') and handover_id is not null and cash_out_kind is null)
    or (kind = 'cash_out' and handover_id is null and cash_out_kind is not null and delta < 0)
    or (kind = 'adjustment' and handover_id is null and cash_out_kind is null
        and char_length(btrim(coalesce(note, ''))) >= 3)
  )
);

-- One entry per (handover, person, kind): a retried accept writes nothing twice.
create unique index if not exists finance_cash_balance_entries_handover_idx
  on public.finance_cash_balance_entries (handover_id, user_id, kind) where handover_id is not null;
-- Retried cash-out / adjustment requests.
create unique index if not exists finance_cash_balance_entries_key_idx
  on public.finance_cash_balance_entries (created_by, idempotency_key) where idempotency_key is not null;
create index if not exists finance_cash_balance_entries_user_idx
  on public.finance_cash_balance_entries (user_id, created_at desc);

do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'stamp_is_test_data'
  ) then
    execute 'drop trigger if exists finance_cash_balance_entries_stamp_test_data on public.finance_cash_balance_entries';
    execute 'create trigger finance_cash_balance_entries_stamp_test_data
               before insert on public.finance_cash_balance_entries
               for each row execute function public.stamp_is_test_data()';
  end if;
end $$;

drop trigger if exists finance_cash_balance_entries_immutable_trg on public.finance_cash_balance_entries;
create trigger finance_cash_balance_entries_immutable_trg
  before update or delete on public.finance_cash_balance_entries
  for each row execute function public.finance_cash_handover_rows_immutable();

alter table public.finance_cash_balance_entries enable row level security;

drop policy if exists finance_cash_balance_entries_select on public.finance_cash_balance_entries;
create policy finance_cash_balance_entries_select on public.finance_cash_balance_entries
  for select to authenticated
  using (
    user_id = auth.uid()
    or (public.module_entry_open('finance') and public.actor_has_module_permission('finance', 'view_all'))
    or exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin' and u.is_active)
  );

revoke all on public.finance_cash_balance_entries from public, anon, authenticated;
grant select on public.finance_cash_balance_entries to authenticated;

-- ─── 3. Balance helpers (no client role may call them) ───────────────────────

create or replace function public.finance_cash_balance(p_user uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(e.delta), 0) from public.finance_cash_balance_entries e where e.user_id = p_user
$$;
revoke all on function public.finance_cash_balance(uuid) from public, anon, authenticated;

create or replace function public.finance_cash_reserved(p_user uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(h.cash_from_hand), 0) from public.finance_cash_handovers h
   where h.giver_user_id = p_user and h.status in ('pending', 'disputed')
$$;
revoke all on function public.finance_cash_reserved(uuid) from public, anon, authenticated;

create or replace function public.finance_cash_available(p_user uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.finance_cash_balance(p_user) - public.finance_cash_reserved(p_user)
$$;
revoke all on function public.finance_cash_available(uuid) from public, anon, authenticated;

-- Every change to a person's cash takes this lock first, so two requests for the
-- same person cannot both spend the same available amount.
create or replace function public.finance_cash_lock(p_user uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$ select pg_advisory_xact_lock(hashtext('finance_cash:' || p_user::text)) $$;
revoke all on function public.finance_cash_lock(uuid) from public, anon, authenticated;

-- ─── 4. create_cash_handover: payments, typed cash, or both ──────────────────
-- ONE signature only: the old 5-argument function is dropped, so PostgREST never
-- has two candidates for the same named call (PGRST203).

drop function if exists public.create_cash_handover(uuid, uuid[], timestamptz, text, text);

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
    raise exception 'HANDOVER_PAYMENTS_REQUIRED: choose a payment or enter a cash amount to hand over.' using errcode = 'P0001';
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
       where i.payment_request_id = v_id and h.status in ('pending', 'disputed')
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
revoke all on function public.create_cash_handover(uuid, uuid[], timestamptz, text, text, numeric, numeric, text) from public, anon;
grant execute on function public.create_cash_handover(uuid, uuid[], timestamptz, text, text, numeric, numeric, text) to authenticated;

-- ─── 5. accept_cash_handover: custody events AND the cash-in-hand entries ────

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
revoke all on function public.accept_cash_handover(uuid) from public, anon;
grant execute on function public.accept_cash_handover(uuid) to authenticated;

-- ─── 6. Cash leaving people's hands ──────────────────────────────────────────

create or replace function public.record_cash_out(
  p_amount          numeric,
  p_kind            text,
  p_note            text,
  p_idempotency_key text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_note  text := nullif(btrim(coalesce(p_note, '')), '');
  v_key   text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_id    uuid;
begin
  if v_actor is null or not exists (
    select 1 from public.users u where u.id = v_actor and u.is_active and coalesce(u.is_deleted, false) = false
  ) then
    raise exception 'HANDOVER_NOT_ALLOWED: sign in with an active account.' using errcode = '42501';
  end if;
  if v_key is null then
    raise exception 'HANDOVER_KEY_REQUIRED: the request carries no idempotency key.' using errcode = 'P0001';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) or p_amount = 'NaN'::numeric then
    raise exception 'HANDOVER_CASH_INVALID: enter an amount in rupees and paise.' using errcode = 'P0001';
  end if;
  if p_kind is null or p_kind not in ('bank_deposit', 'paid_out', 'other') then
    raise exception 'HANDOVER_CASH_INVALID: choose what happened to the cash.' using errcode = 'P0001';
  end if;
  if v_note is null or char_length(v_note) < 3 or char_length(v_note) > 500 then
    raise exception 'HANDOVER_REASON_REQUIRED: add a short note (3 to 500 characters).' using errcode = 'P0001';
  end if;

  select e.id into v_id from public.finance_cash_balance_entries e
   where e.created_by = v_actor and e.idempotency_key = v_key;
  if found then return v_id; end if;

  perform public.finance_cash_lock(v_actor);
  if p_amount > public.finance_cash_available(v_actor) then
    raise exception 'HANDOVER_CASH_NOT_AVAILABLE: you have only % available in cash in hand.',
      public.finance_handover_money(greatest(public.finance_cash_available(v_actor), 0))
      using errcode = 'P0001';
  end if;

  insert into public.finance_cash_balance_entries
    (user_id, delta, kind, cash_out_kind, note, created_by, idempotency_key)
  values (v_actor, -p_amount, 'cash_out', p_kind, v_note, v_actor, v_key)
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.record_cash_out(numeric, text, text, text) from public, anon;
grant execute on function public.record_cash_out(numeric, text, text, text) to authenticated;

create or replace function public.adjust_cash_balance(
  p_user            uuid,
  p_delta           numeric,
  p_reason          text,
  p_idempotency_key text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  uuid := auth.uid();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_key    text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_id     uuid;
begin
  if v_actor is null or not exists (
    select 1 from public.users u
     where u.id = v_actor and u.role = 'admin' and u.is_active and coalesce(u.is_deleted, false) = false
  ) then
    raise exception 'HANDOVER_NOT_ALLOWED: only an administrator can adjust cash in hand.' using errcode = '42501';
  end if;
  if v_key is null then
    raise exception 'HANDOVER_KEY_REQUIRED: the request carries no idempotency key.' using errcode = 'P0001';
  end if;
  if p_user is null or not exists (select 1 from public.users u where u.id = p_user) then
    raise exception 'HANDOVER_RECIPIENT_INVALID: that person does not exist.' using errcode = 'P0001';
  end if;
  if p_delta is null or p_delta = 0 or p_delta <> round(p_delta, 2) or p_delta = 'NaN'::numeric then
    raise exception 'HANDOVER_CASH_INVALID: enter an amount in rupees and paise.' using errcode = 'P0001';
  end if;
  if v_reason is null or char_length(v_reason) < 3 or char_length(v_reason) > 500 then
    raise exception 'HANDOVER_REASON_REQUIRED: give a reason (3 to 500 characters).' using errcode = 'P0001';
  end if;

  select e.id into v_id from public.finance_cash_balance_entries e
   where e.created_by = v_actor and e.idempotency_key = v_key;
  if found then return v_id; end if;

  perform public.finance_cash_lock(p_user);
  if public.finance_cash_available(p_user) + p_delta < 0 then
    raise exception 'HANDOVER_CASH_NOT_AVAILABLE: that would take the balance below what is available (%).',
      public.finance_handover_money(greatest(public.finance_cash_available(p_user), 0))
      using errcode = 'P0001';
  end if;

  insert into public.finance_cash_balance_entries
    (user_id, delta, kind, note, created_by, idempotency_key)
  values (p_user, p_delta, 'adjustment', v_reason, v_actor, v_key)
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.adjust_cash_balance(uuid, numeric, text, text) from public, anon;
grant execute on function public.adjust_cash_balance(uuid, numeric, text, text) to authenticated;

-- ─── 7. Reading balances ─────────────────────────────────────────────────────

create or replace function public.finance_my_cash_balance()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    return null;
  end if;
  return jsonb_build_object(
    'balance',   public.finance_cash_balance(v_actor),
    'reserved',  public.finance_cash_reserved(v_actor),
    'available', public.finance_cash_available(v_actor),
    'entries', (
      select coalesce(jsonb_agg(x.j order by x.created_at desc), '[]'::jsonb)
        from (
          select e.created_at, jsonb_build_object(
                   'id', e.id,
                   'delta', e.delta,
                   'kind', e.kind,
                   'cash_out_kind', e.cash_out_kind,
                   'note', e.note,
                   'handover_id', e.handover_id,
                   'handover_human_id', h.human_id,
                   'counterpart_name', case e.kind
                                         when 'handover_out' then ru.full_name
                                         when 'handover_in'  then gu.full_name
                                         when 'new_cash'     then gu.full_name
                                         when 'adjustment'   then cu.full_name
                                       end,
                   'created_at', e.created_at) as j
            from public.finance_cash_balance_entries e
            left join public.finance_cash_handovers h on h.id = e.handover_id
            left join public.users gu on gu.id = h.giver_user_id
            left join public.users ru on ru.id = h.recipient_user_id
            left join public.users cu on cu.id = e.created_by
           where e.user_id = v_actor
           order by e.created_at desc
           limit 50
        ) x)
  );
end $$;
revoke all on function public.finance_my_cash_balance() from public, anon;
grant execute on function public.finance_my_cash_balance() to authenticated;

-- Everybody's cash in hand, for administrators and finance.view_all holders.
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
                          where h.giver_user_id = u.id and h.status in ('pending', 'disputed') and h.cash_from_hand > 0)
        ) s
       where s.balance <> 0 or s.reserved <> 0)
  );
end $$;
revoke all on function public.finance_cash_balances() from public, anon;
grant execute on function public.finance_cash_balances() to authenticated;

-- ─── 8. The read door also returns the typed cash line ───────────────────────

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
      case when h.status in ('pending', 'disputed') then 0 else 1 end as ord,
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
        'can_accept', (h.recipient_user_id = v_actor and h.status in ('pending', 'disputed')),
        'can_dispute', (h.recipient_user_id = v_actor and h.status = 'pending'),
        'can_cancel', ((h.giver_user_id = v_actor or v_admin) and h.status in ('pending', 'disputed')),
        'can_remind', (h.giver_user_id = v_actor and h.status in ('pending', 'disputed')
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
    order by case when h.status in ('pending', 'disputed') then 0 else 1 end, h.created_at desc
    limit least(greatest(coalesce(p_limit, 50), 1), 200)
    offset greatest(coalesce(p_offset, 0), 0)
  ) r;

  return v_out;
end $$;
revoke all on function public.finance_handover_list(text[], boolean, integer, integer, uuid) from public, anon;
grant execute on function public.finance_handover_list(text[], boolean, integer, integer, uuid) to authenticated;
