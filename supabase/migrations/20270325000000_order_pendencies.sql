-- ORDER PENDENCIES: what is still outstanding from the client, per Confirmed Order.
--
-- WHY
-- ---
-- When a PI becomes an Order, Sales often still waits on the client for things
-- (fabric, finish, a signed drawing...). Those used to live in a remark. The
-- approver who converts the PI can now list any number of free-text
-- pendencies; the Order page shows the open ones inside Fabric & Finish as a
-- standing reminder until somebody marks each one cleared.
--
-- WHAT IT ADDS
--   1. public.order_pendencies             one row per pendency, RLS on
--   2. public.can_manage_order_pendencies  the one write authority
--   3. add_order_pendencies / clear_ / reopen_ / remove_order_pendency
--
-- WHAT IT DOES NOT TOUCH. approve_order_submission() is NOT restated: the
-- convert dialog calls add_order_pendencies() with the new Order's id straight
-- after the Order exists. A failure there never undoes the Order; the page
-- says so and the pendencies can be added from the Order page.
--
-- IDEMPOTENT: tables/functions are created if absent or replaced, policies are
-- dropped before they are created.

do $$
begin
  if to_regclass('public.orders') is null then
    raise exception 'public.orders is missing';
  end if;
  if to_regprocedure('public.can_record_order_approval(uuid)') is null then
    raise exception 'can_record_order_approval(uuid) is missing; 20261227000000 must run first';
  end if;
  if to_regprocedure('public.actor_can_approve_order()') is null then
    raise exception 'actor_can_approve_order() is missing; 20261224000000 must run first';
  end if;
  if to_regprocedure('public.module_entry_open(text)') is null then
    raise exception 'module_entry_open(text) is missing';
  end if;
  if to_regprocedure('public.can_read_order_detail(uuid)') is null then
    raise exception 'can_read_order_detail(uuid) is missing; 20270221000000 must run first';
  end if;
end;
$$;


-- ═══ 1. The table ════════════════════════════════════════════════════════════

create table if not exists public.order_pendencies (
  id          uuid        primary key default gen_random_uuid(),
  -- CASCADE for the same reason order_approval_events cascades: the only thing
  -- that deletes an Order is the audited admin delete / Test Data Cleanup.
  order_id    uuid        not null references public.orders(id) on delete cascade,
  label       text        not null,
  created_by  uuid        not null references public.users(id) on delete restrict,
  created_at  timestamptz not null default now(),
  cleared_at  timestamptz,
  cleared_by  uuid        references public.users(id) on delete restrict,

  constraint order_pendencies_label_shape
    check (label = btrim(label) and char_length(label) between 1 and 200),
  -- Cleared means both who and when, open means neither.
  constraint order_pendencies_cleared_pair
    check ((cleared_at is null) = (cleared_by is null))
);

comment on table public.order_pendencies is
  'Things still pending from the client on a Confirmed Order (fabric, finish, ...), as free-text reminders shown in the Order''s Fabric & Finish card. Written only through add_order_pendencies / clear_order_pendency / reopen_order_pendency / remove_order_pendency. 20270325000000.';

create index if not exists order_pendencies_order_idx
  on public.order_pendencies (order_id, created_at, id);


-- ═══ 2. Who may change them ══════════════════════════════════════════════════
--
-- The people who may already record a fabric/finish approval on the Order (its
-- assigned salesperson, an active admin or manager) PLUS the holder of
-- orders.approve_order, who is the person converting the PI and need not be
-- any of those. Definer because it reads public.users; every condition is
-- explicit, the search path is pinned and EXECUTE goes to authenticated only.
create or replace function public.can_manage_order_pendencies(p_order_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.can_record_order_approval(p_order_id)
      or (exists (select 1 from public.orders o where o.id = p_order_id)
          and public.actor_can_approve_order());
$$;

comment on function public.can_manage_order_pendencies(uuid) is
  'True when the CALLER may add, clear, reopen or remove pendencies on this Order: whoever may record a fabric/finish approval on it (assigned salesperson, active admin or manager) or a holder of orders.approve_order. 20270325000000.';

revoke execute on function public.can_manage_order_pendencies(uuid) from public, anon;
grant  execute on function public.can_manage_order_pendencies(uuid) to authenticated;


-- ═══ 3. Row security: read only; every write is an RPC ═══════════════════════

alter table public.order_pendencies enable row level security;
alter table public.order_pendencies force row level security;

revoke all on table public.order_pendencies from public, anon, authenticated;
grant select on table public.order_pendencies to authenticated;

drop policy if exists "order_pendencies_select" on public.order_pendencies;
create policy "order_pendencies_select" on public.order_pendencies
  for select to authenticated
  using (public.can_read_order_detail(order_id));

drop policy if exists "order_pendencies_module_entry_gate" on public.order_pendencies;
create policy "order_pendencies_module_entry_gate" on public.order_pendencies
  as restrictive for all to authenticated
  using (public.module_entry_open('orders'))
  with check (public.module_entry_open('orders'));


-- ═══ 4. The write paths ══════════════════════════════════════════════════════

-- Adds one pendency per non-blank label (trimmed, whitespace collapsed,
-- case-insensitive duplicates within the call and among the OPEN ones skipped).
-- Returns how many rows it wrote.
create or replace function public.add_order_pendencies(p_order_id uuid, p_labels text[])
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_label text;
  v_seen  text[] := '{}';
  v_count integer := 0;
begin
  if v_actor is null then
    raise exception 'ORDER_PENDENCY_NOT_AUTHENTICATED: sign in first' using errcode = 'P0001';
  end if;

  perform 1 from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'ORDER_PENDENCY_NO_ORDER: that Order does not exist' using errcode = 'P0001';
  end if;
  if not public.can_manage_order_pendencies(p_order_id) then
    raise exception 'ORDER_PENDENCY_FORBIDDEN: you cannot change pendencies on this Order' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.orders where id = p_order_id and status = 'cancelled') then
    raise exception 'ORDER_PENDENCY_ORDER_CANCELLED: this Order is cancelled' using errcode = 'P0001';
  end if;
  if p_labels is null or coalesce(array_length(p_labels, 1), 0) > 20 then
    raise exception 'ORDER_PENDENCY_TOO_MANY: add at most 20 at a time' using errcode = 'P0001';
  end if;

  foreach v_label in array p_labels loop
    v_label := btrim(regexp_replace(coalesce(v_label, ''), '\s+', ' ', 'g'));
    if v_label = '' then continue; end if;
    if char_length(v_label) > 200 then
      raise exception 'ORDER_PENDENCY_TOO_LONG: a pendency is at most 200 characters' using errcode = 'P0001';
    end if;
    if lower(v_label) = any (v_seen) then continue; end if;
    v_seen := v_seen || lower(v_label);
    if exists (select 1 from public.order_pendencies p
                where p.order_id = p_order_id and p.cleared_at is null and lower(p.label) = lower(v_label)) then
      continue;
    end if;
    insert into public.order_pendencies (order_id, label, created_by) values (p_order_id, v_label, v_actor);
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

create or replace function public.clear_order_pendency(p_pendency_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_order uuid;
begin
  if v_actor is null then
    raise exception 'ORDER_PENDENCY_NOT_AUTHENTICATED: sign in first' using errcode = 'P0001';
  end if;
  select order_id into v_order from public.order_pendencies where id = p_pendency_id;
  if v_order is null then
    raise exception 'ORDER_PENDENCY_NOT_FOUND: that pendency does not exist' using errcode = 'P0001';
  end if;
  perform 1 from public.orders where id = v_order for update;
  if not public.can_manage_order_pendencies(v_order) then
    raise exception 'ORDER_PENDENCY_FORBIDDEN: you cannot change pendencies on this Order' using errcode = 'P0001';
  end if;
  update public.order_pendencies
     set cleared_at = now(), cleared_by = v_actor
   where id = p_pendency_id and cleared_at is null;
end;
$$;

create or replace function public.reopen_order_pendency(p_pendency_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_order uuid;
begin
  if v_actor is null then
    raise exception 'ORDER_PENDENCY_NOT_AUTHENTICATED: sign in first' using errcode = 'P0001';
  end if;
  select order_id into v_order from public.order_pendencies where id = p_pendency_id;
  if v_order is null then
    raise exception 'ORDER_PENDENCY_NOT_FOUND: that pendency does not exist' using errcode = 'P0001';
  end if;
  perform 1 from public.orders where id = v_order for update;
  if not public.can_manage_order_pendencies(v_order) then
    raise exception 'ORDER_PENDENCY_FORBIDDEN: you cannot change pendencies on this Order' using errcode = 'P0001';
  end if;
  update public.order_pendencies
     set cleared_at = null, cleared_by = null
   where id = p_pendency_id and cleared_at is not null;
end;
$$;

-- Removing is for a typo or a duplicate, so it takes an OPEN pendency only; a
-- cleared one is history and stays.
create or replace function public.remove_order_pendency(p_pendency_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_order uuid;
begin
  if v_actor is null then
    raise exception 'ORDER_PENDENCY_NOT_AUTHENTICATED: sign in first' using errcode = 'P0001';
  end if;
  select order_id into v_order from public.order_pendencies where id = p_pendency_id;
  if v_order is null then
    raise exception 'ORDER_PENDENCY_NOT_FOUND: that pendency does not exist' using errcode = 'P0001';
  end if;
  perform 1 from public.orders where id = v_order for update;
  if not public.can_manage_order_pendencies(v_order) then
    raise exception 'ORDER_PENDENCY_FORBIDDEN: you cannot change pendencies on this Order' using errcode = 'P0001';
  end if;
  delete from public.order_pendencies where id = p_pendency_id and cleared_at is null;
  if not found then
    raise exception 'ORDER_PENDENCY_NOT_OPEN: only an open pendency can be removed' using errcode = 'P0001';
  end if;
end;
$$;

comment on function public.add_order_pendencies(uuid, text[]) is
  'Adds one open pendency per non-blank label to a Confirmed Order (max 20 per call, 200 characters each, duplicates of an open one skipped). Authority re-derived here under a row lock on the Order: can_manage_order_pendencies. Returns how many were written. 20270325000000.';
comment on function public.clear_order_pendency(uuid) is
  'Marks one pendency cleared, recording who and when. 20270325000000.';
comment on function public.reopen_order_pendency(uuid) is
  'Reopens a cleared pendency. 20270325000000.';
comment on function public.remove_order_pendency(uuid) is
  'Deletes an OPEN pendency (typo or duplicate); a cleared one is history and is refused. 20270325000000.';

revoke execute on function public.add_order_pendencies(uuid, text[]) from public, anon;
revoke execute on function public.clear_order_pendency(uuid)          from public, anon;
revoke execute on function public.reopen_order_pendency(uuid)         from public, anon;
revoke execute on function public.remove_order_pendency(uuid)         from public, anon;
grant  execute on function public.add_order_pendencies(uuid, text[]) to authenticated;
grant  execute on function public.clear_order_pendency(uuid)          to authenticated;
grant  execute on function public.reopen_order_pendency(uuid)         to authenticated;
grant  execute on function public.remove_order_pendency(uuid)         to authenticated;


-- ═══ 5. Self-assertion (executed at apply time) ══════════════════════════════

do $$
begin
  if to_regclass('public.order_pendencies') is null then
    raise exception 'ASSERTION FAILED: order_pendencies was not created';
  end if;
  if not (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.order_pendencies'::regclass) then
    raise exception 'ASSERTION FAILED: order_pendencies must have forced RLS';
  end if;
  if has_table_privilege('authenticated', 'public.order_pendencies', 'insert')
     or has_table_privilege('authenticated', 'public.order_pendencies', 'update')
     or has_table_privilege('authenticated', 'public.order_pendencies', 'delete') then
    raise exception 'ASSERTION FAILED: clients may only SELECT order_pendencies';
  end if;
  if has_function_privilege('anon', 'public.add_order_pendencies(uuid, text[])', 'execute') then
    raise exception 'ASSERTION FAILED: anon may not call add_order_pendencies';
  end if;
end;
$$;
