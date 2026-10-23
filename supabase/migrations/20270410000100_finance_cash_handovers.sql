-- Finance: cash handover WITH ACCEPTANCE.
--
-- Until now a "Handed Over" custody activity was recorded instantly and
-- one-sidedly: nobody confirmed receiving the cash. This adds a handover that is
-- OFFERED by the giver and only becomes custody history when the recipient
-- ACCEPTS it. While it is open (pending or disputed) both people are shown it on
-- the Finance dashboard.
--
--   pending ──accept──> accepted
--   pending ──dispute─> disputed ──accept──> accepted
--   pending/disputed ──cancel (giver, or admin with a reason)──> cancelled
--
-- NOT FINANCIAL. A handover moves no rupees in any total, gate, allocation or
-- classification: it only decides who is CARRYING the cash of PNB/Paytm payments.
-- Accepting appends the existing per-payment custody events, so the "Collection
-- & Handover Activity" timeline stays the single custody record.
--
-- ROLLOUT: apply 20270410000000 (enum values) FIRST, then this file, then ship
-- the code. Rollback: the objects are additive; hide the UI and stop the cron.
--
-- Whole payments only: a handover carries every rupee of each payment it names
-- (amount is a snapshot). Who holds a payment is derived, never typed
-- (finance_payment_current_holder).

create sequence if not exists public.finance_cash_handover_seq;

-- ─── 1. Tables ───────────────────────────────────────────────────────────────

create table if not exists public.finance_cash_handovers (
  id                    uuid primary key default gen_random_uuid(),
  human_id              text not null unique
                          default ('H-' || lpad(nextval('public.finance_cash_handover_seq')::text, 4, '0')),
  giver_user_id         uuid not null references public.users(id),
  recipient_user_id     uuid not null references public.users(id),
  total_amount          numeric not null,
  handed_at             timestamptz not null,
  note                  text,
  status                text not null default 'pending'
                          check (status in ('pending', 'accepted', 'disputed', 'cancelled')),
  accepted_at           timestamptz,
  disputed_at           timestamptz,
  dispute_reason        text,
  cancelled_at          timestamptz,
  cancelled_by          uuid references public.users(id),
  cancel_reason         text,
  last_reminded_at      timestamptz,
  last_auto_reminded_at timestamptz,
  created_by            uuid not null references public.users(id),
  created_at            timestamptz not null default now(),
  idempotency_key       text not null check (btrim(idempotency_key) <> ''),
  is_test_data          boolean not null default false,

  constraint finance_cash_handovers_two_people check (giver_user_id <> recipient_user_id),
  constraint finance_cash_handovers_amount check (
    total_amount > 0 and total_amount = round(total_amount, 2)
    and total_amount <> 'NaN'::numeric),
  constraint finance_cash_handovers_note_len check (note is null or char_length(note) <= 1000),
  constraint finance_cash_handovers_state check (
    (status = 'accepted'  and accepted_at is not null)
    or (status = 'cancelled' and cancelled_at is not null and cancelled_by is not null)
    or (status = 'disputed'  and disputed_at is not null
          and btrim(coalesce(dispute_reason, '')) <> '')
    or (status = 'pending')
  )
);

create unique index if not exists finance_cash_handovers_giver_key_idx
  on public.finance_cash_handovers (giver_user_id, idempotency_key);
create index if not exists finance_cash_handovers_recipient_open_idx
  on public.finance_cash_handovers (recipient_user_id) where status in ('pending', 'disputed');
create index if not exists finance_cash_handovers_giver_open_idx
  on public.finance_cash_handovers (giver_user_id) where status in ('pending', 'disputed');

create table if not exists public.finance_cash_handover_items (
  id                 uuid primary key default gen_random_uuid(),
  handover_id        uuid not null references public.finance_cash_handovers(id),
  -- CASCADE, like finance_payment_custody_events: an admin may still delete a
  -- payment entered by mistake (its tombstone is the surviving record). The
  -- handover header keeps its total and history.
  payment_request_id uuid not null references public.finance_payment_requests(id) on delete cascade,
  amount             numeric not null
                       check (amount > 0 and amount = round(amount, 2) and amount <> 'NaN'::numeric),
  created_at         timestamptz not null default now(),
  unique (handover_id, payment_request_id)
);
create index if not exists finance_cash_handover_items_payment_idx
  on public.finance_cash_handover_items (payment_request_id);

create table if not exists public.finance_cash_handover_events (
  id          uuid primary key default gen_random_uuid(),
  handover_id uuid not null references public.finance_cash_handovers(id),
  event_type  text not null
                check (event_type in ('created', 'accepted', 'disputed', 'cancelled', 'reminded')),
  actor_id    uuid references public.users(id),
  note        text,
  created_at  timestamptz not null default now()
);
create index if not exists finance_cash_handover_events_handover_idx
  on public.finance_cash_handover_events (handover_id, created_at);

-- Test-data marker, stamped like every other Finance table.
do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'stamp_is_test_data'
  ) then
    execute 'drop trigger if exists finance_cash_handovers_stamp_test_data on public.finance_cash_handovers';
    execute 'create trigger finance_cash_handovers_stamp_test_data
               before insert on public.finance_cash_handovers
               for each row execute function public.stamp_is_test_data()';
  end if;
end $$;

-- ─── 2. Guards ───────────────────────────────────────────────────────────────

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

drop trigger if exists finance_cash_handovers_guard_trg on public.finance_cash_handovers;
create trigger finance_cash_handovers_guard_trg
  before update or delete on public.finance_cash_handovers
  for each row execute function public.finance_cash_handovers_guard();

create or replace function public.finance_cash_handover_rows_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- Items may still go by CASCADE when their payment is deleted (clients hold
  -- no DELETE privilege); history rows never go.
  raise exception 'HANDOVER_IMMUTABLE: handover items and history are append-only.'
    using errcode = 'P0001';
end $$;

drop trigger if exists finance_cash_handover_items_immutable_trg on public.finance_cash_handover_items;
create trigger finance_cash_handover_items_immutable_trg
  before update on public.finance_cash_handover_items
  for each row execute function public.finance_cash_handover_rows_immutable();

drop trigger if exists finance_cash_handover_events_immutable_trg on public.finance_cash_handover_events;
create trigger finance_cash_handover_events_immutable_trg
  before update or delete on public.finance_cash_handover_events
  for each row execute function public.finance_cash_handover_rows_immutable();

-- ─── 3. RLS: read by participants and Finance-wide readers; writes by RPC only ─

alter table public.finance_cash_handovers       enable row level security;
alter table public.finance_cash_handover_items  enable row level security;
alter table public.finance_cash_handover_events enable row level security;

drop policy if exists finance_cash_handovers_select on public.finance_cash_handovers;
create policy finance_cash_handovers_select on public.finance_cash_handovers
  for select to authenticated
  using (
    giver_user_id = auth.uid()
    or recipient_user_id = auth.uid()
    or (public.module_entry_open('finance') and public.actor_has_module_permission('finance', 'view_all'))
    or public.actor_has_module_permission('finance', 'manage')
  );

drop policy if exists finance_cash_handover_items_select on public.finance_cash_handover_items;
create policy finance_cash_handover_items_select on public.finance_cash_handover_items
  for select to authenticated
  using (exists (select 1 from public.finance_cash_handovers h where h.id = handover_id));

drop policy if exists finance_cash_handover_events_select on public.finance_cash_handover_events;
create policy finance_cash_handover_events_select on public.finance_cash_handover_events
  for select to authenticated
  using (exists (select 1 from public.finance_cash_handovers h where h.id = handover_id));

-- Supabase's default privileges give anon/authenticated every write; revoke by name.
revoke all on public.finance_cash_handovers       from public, anon, authenticated;
revoke all on public.finance_cash_handover_items  from public, anon, authenticated;
revoke all on public.finance_cash_handover_events from public, anon, authenticated;
grant select on public.finance_cash_handovers       to authenticated;
grant select on public.finance_cash_handover_items  to authenticated;
grant select on public.finance_cash_handover_events to authenticated;
revoke usage, select, update on sequence public.finance_cash_handover_seq from public, anon, authenticated;

-- ─── 4. Who is carrying a payment's cash right now ───────────────────────────
-- Latest custody event wins (handed_over -> its recipient, collected -> its
-- collector); with none, the legacy columns; with none, the person who recorded it.

create or replace function public.finance_payment_current_holder(p_payment_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select case e.activity_type
              when 'handed_over' then e.handed_to_user_id
              else e.collected_by_user_id
            end
       from public.finance_payment_custody_events e
      where e.payment_request_id = p_payment_id
      order by e.occurred_at desc, e.created_at desc, e.id desc
      limit 1),
    (select coalesce(f.handed_over_to_user_id, f.collected_by_user_id, f.submitted_by)
       from public.finance_payment_requests f
      where f.id = p_payment_id)
  );
$$;
revoke all on function public.finance_payment_current_holder(uuid) from public, anon, authenticated;

-- ─── 5. RPCs ─────────────────────────────────────────────────────────────────

create or replace function public.finance_handover_money(p_amount numeric)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$ select 'Rs ' || trim(to_char(p_amount, 'FM99,99,99,990.00')) $$;
revoke all on function public.finance_handover_money(numeric) from public, anon, authenticated;

create or replace function public.create_cash_handover(
  p_recipient       uuid,
  p_payment_ids     uuid[],
  p_handed_at       timestamptz default null,
  p_note            text default null,
  p_idempotency_key text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    uuid := auth.uid();
  v_key      text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_when     timestamptz := coalesce(p_handed_at, now());
  v_note     text := nullif(btrim(coalesce(p_note, '')), '');
  v_ids      uuid[];
  v_id       uuid;
  v_pay      record;
  v_total    numeric := 0;
  v_handover uuid;
  v_giver    text;
  v_count    int;
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

  select coalesce(array_agg(distinct x order by x), '{}') into v_ids
    from unnest(coalesce(p_payment_ids, '{}'::uuid[])) as x;
  v_count := coalesce(array_length(v_ids, 1), 0);
  if v_count = 0 then
    raise exception 'HANDOVER_PAYMENTS_REQUIRED: choose at least one payment to hand over.' using errcode = 'P0001';
  end if;
  if v_count > 50 then
    raise exception 'HANDOVER_TOO_MANY: at most 50 payments in one handover.' using errcode = 'P0001';
  end if;

  -- Retry / double click: same giver + key returns the same handover.
  select h.id into v_handover from public.finance_cash_handovers h
   where h.giver_user_id = v_actor and h.idempotency_key = v_key;
  if found then return v_handover; end if;

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

  insert into public.finance_cash_handovers
    (giver_user_id, recipient_user_id, total_amount, handed_at, note, created_by, idempotency_key)
  values (v_actor, p_recipient, v_total, v_when, v_note, v_actor, v_key)
  returning id into v_handover;

  insert into public.finance_cash_handover_items (handover_id, payment_request_id, amount)
  select v_handover, f.id, f.amount from public.finance_payment_requests f where f.id = any (v_ids);

  insert into public.finance_cash_handover_events (handover_id, event_type, actor_id, note)
  values (v_handover, 'created', v_actor, v_note);

  select u.full_name into v_giver from public.users u where u.id = v_actor;
  perform public.order_notify_users(
    array[p_recipient], v_actor, v_handover, 'finance_handover_requested'::notification_type,
    'Cash handed to you - please accept',
    coalesce(v_giver, 'Someone') || ' handed you ' || public.finance_handover_money(v_total)
      || ' (' || v_count || case when v_count = 1 then ' payment' else ' payments' end
      || '). Accept it once you have the cash, or dispute it.');

  return v_handover;
end $$;
revoke all on function public.create_cash_handover(uuid, uuid[], timestamptz, text, text) from public, anon;
grant execute on function public.create_cash_handover(uuid, uuid[], timestamptz, text, text) to authenticated;

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
    raise exception 'HANDOVER_REASON_REQUIRED: say what is wrong (3 to 500 characters).' using errcode = 'P0001';
  end if;

  select * into v_h from public.finance_cash_handovers where id = p_handover_id for update;
  if not found then
    raise exception 'HANDOVER_NOT_FOUND: that handover does not exist.' using errcode = 'P0002';
  end if;
  if v_h.recipient_user_id <> v_actor then
    raise exception 'HANDOVER_NOT_ALLOWED: only the person it was handed to can dispute it.' using errcode = '42501';
  end if;
  if v_h.status <> 'pending' then
    raise exception 'HANDOVER_CLOSED: this handover is % and cannot be disputed.', v_h.status using errcode = 'P0001';
  end if;

  update public.finance_cash_handovers
     set status = 'disputed', disputed_at = now(), dispute_reason = v_reason
   where id = v_h.id;
  insert into public.finance_cash_handover_events (handover_id, event_type, actor_id, note)
  values (v_h.id, 'disputed', v_actor, v_reason);

  select u.full_name into v_name from public.users u where u.id = v_actor;
  perform public.order_notify_users(
    array[v_h.giver_user_id], v_actor, v_h.id, 'finance_handover_disputed'::notification_type,
    'Cash handover disputed',
    coalesce(v_name, 'The recipient') || ' disputed your handover of '
      || public.finance_handover_money(v_h.total_amount) || ' (' || v_h.human_id || '): ' || v_reason);
end $$;
revoke all on function public.dispute_cash_handover(uuid, text) from public, anon;
grant execute on function public.dispute_cash_handover(uuid, text) to authenticated;

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
  if v_h.status not in ('pending', 'disputed') then
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
revoke all on function public.cancel_cash_handover(uuid, text) from public, anon;
grant execute on function public.cancel_cash_handover(uuid, text) to authenticated;

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
  if v_h.status not in ('pending', 'disputed') then
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
revoke all on function public.remind_cash_handover(uuid) from public, anon;
grant execute on function public.remind_cash_handover(uuid) to authenticated;

-- The daily sweep: callable only by the service role (the cron route).
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
     where h.status in ('pending', 'disputed')
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
revoke all on function public.finance_handover_send_reminders() from public, anon, authenticated;
grant execute on function public.finance_handover_send_reminders() to service_role;

-- ─── 6. The one read door ────────────────────────────────────────────────────
-- Participants see their own handovers (including payment details they could not
-- read through the payment table's RLS); admins and Finance-wide readers may see
-- everyone's when p_only_mine is false.

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

-- The payments the caller is holding and may hand over (for the picker).
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
          where i.payment_request_id = f.id and h.status in ('pending', 'disputed'))
  );
end $$;
revoke all on function public.finance_my_handoverable_payments() from public, anon;
grant execute on function public.finance_my_handoverable_payments() to authenticated;

-- The people a handover can go to: every active employee but the caller.
create or replace function public.finance_handover_recipients()
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
    select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'full_name', u.full_name) order by u.full_name), '[]'::jsonb)
      from public.users u
     where u.is_active and coalesce(u.is_deleted, false) = false and u.id <> v_actor
  );
end $$;
revoke all on function public.finance_handover_recipients() from public, anon;
grant execute on function public.finance_handover_recipients() to authenticated;
