-- PENDENCY APPROVALS: a pendency is closed by an ERP screenshot and "Approved",
-- not by a bare "Mark cleared"; and every approval lands in the Order's Activity.
--
-- WHY (owner, 2026-10-27)
-- -----------------------
-- Sales must go to the ERP, upload the pendency, share the screenshot on the
-- Order and select Approved, so the approvals can be analysed. All approvals
-- (Fabric, Finish, each pendency) are one category in Activity, separate from
-- PI edits and Payments.
--
-- WHAT IT ADDS
--   1. order_pendencies.evidence_path   the ERP screenshot behind an approval.
--      cleared_at / cleared_by are the approval's when / who (renaming applied
--      columns is not worth the risk); a cleared row with no evidence is a
--      pendency cleared BEFORE screenshots were required, and stays valid.
--   2. approve_order_pendency(uuid, text)   the one way to approve. Requires a
--      screenshot that exists under orders/<order>/pendency/ and is claimed
--      once. clear_order_pendency() is no longer callable by clients.
--   3. Storage: the evidence bucket accepts a third folder, `pendency`, with the
--      same write authority as pendencies (can_manage_order_pendencies), and a
--      filed pendency proof cannot be deleted as an orphan.
--   4. Activity: order_activity_log rows for add / approve / reopen / remove of
--      a pendency, and for every Fabric / Finish approval event (trigger, so
--      record_order_approval_event() is not restated).
--   5. order_approval_current view: the newest Fabric / Finish status per Order,
--      for the Confirmed Orders list's Pendencies column in one read.
--
-- Applied migrations are immutable: this restates the functions it changes.

do $$
begin
  if to_regclass('public.order_pendencies') is null then
    raise exception 'order_pendencies is missing; 20270325000000 must run first';
  end if;
  if to_regclass('public.order_approval_events') is null then
    raise exception 'order_approval_events is missing; 20261227000000 must run first';
  end if;
  if to_regprocedure('public.can_manage_order_pendencies(uuid)') is null then
    raise exception 'can_manage_order_pendencies(uuid) is missing';
  end if;
  if to_regprocedure('public.order_approval_evidence_order_id(text)') is null then
    raise exception 'order_approval_evidence_order_id(text) is missing';
  end if;
end;
$$;


-- ═══ 1. The proof column ═════════════════════════════════════════════════════

alter table public.order_pendencies
  add column if not exists evidence_path text;

alter table public.order_pendencies
  drop constraint if exists order_pendencies_evidence_shape;
alter table public.order_pendencies
  add constraint order_pendencies_evidence_shape
  check (
    evidence_path is null
    or (cleared_at is not null
        and evidence_path ~ '^orders/[0-9a-f-]{36}/pendency/[A-Za-z0-9._-]{1,120}$')
  );

comment on column public.order_pendencies.evidence_path is
  'Object key in the private order-approval-evidence bucket: the ERP screenshot the approval stood on. NULL on an open pendency, and on one cleared before screenshots were required (20270421000000). Never a URL.';


-- ═══ 2. Storage: the pendency folder ═════════════════════════════════════════

create or replace function public.order_approval_evidence_order_id(p_name text)
returns uuid
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_name is null then null
    when split_part(p_name, '/', 1) <> 'orders' then null
    when split_part(p_name, '/', 3) not in ('fabric', 'finish', 'pendency') then null
    when split_part(p_name, '/', 2) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then split_part(p_name, '/', 2)::uuid
    else null
  end;
$$;

drop policy if exists "order_approval_evidence_insert" on storage.objects;
create policy "order_approval_evidence_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'order-approval-evidence'
    and public.module_entry_open('orders')
    and (
      (split_part(name, '/', 3) in ('fabric', 'finish')
        and public.can_record_order_approval(public.order_approval_evidence_order_id(name)))
      or
      (split_part(name, '/', 3) = 'pendency'
        and public.can_manage_order_pendencies(public.order_approval_evidence_order_id(name)))
    )
  );

-- An orphan is a file no approval stands on. A pendency proof is claimed by the
-- pendency row while it is approved, and by its Activity row for good (a
-- reopened pendency drops its evidence_path but the history keeps the proof).
drop policy if exists "order_approval_evidence_delete" on storage.objects;
create policy "order_approval_evidence_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'order-approval-evidence'
    and public.module_entry_open('orders')
    and (
      (split_part(name, '/', 3) in ('fabric', 'finish')
        and public.can_record_order_approval(public.order_approval_evidence_order_id(name)))
      or
      (split_part(name, '/', 3) = 'pendency'
        and public.can_manage_order_pendencies(public.order_approval_evidence_order_id(name)))
    )
    and not exists (select 1 from public.order_approval_events e where e.evidence_path = storage.objects.name)
    and not exists (select 1 from public.order_pendencies p where p.evidence_path = storage.objects.name)
    and not exists (
      select 1 from public.order_activity_log l
      where l.order_id = public.order_approval_evidence_order_id(storage.objects.name)
        and l.payload ->> 'evidence_path' = storage.objects.name
    )
  );


-- ═══ 3. The write paths ══════════════════════════════════════════════════════

-- Adds, as before, and now says so in Activity.
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
  v_id    uuid;
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
    insert into public.order_pendencies (order_id, label, created_by)
    values (p_order_id, v_label, v_actor)
    returning id into v_id;
    insert into public.order_activity_log (order_id, actor_id, event_type, payload)
    values (p_order_id, v_actor, 'order_pendency_added', jsonb_build_object('pendency_id', v_id, 'label', v_label));
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- THE ONE WAY TO APPROVE. The screenshot is the point: a pendency is approved
-- when somebody has updated the ERP and filed proof of it here.
create or replace function public.approve_order_pendency(p_pendency_id uuid, p_evidence_path text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_order uuid;
  v_label text;
  v_path  text := nullif(btrim(coalesce(p_evidence_path, '')), '');
begin
  if v_actor is null then
    raise exception 'ORDER_PENDENCY_NOT_AUTHENTICATED: sign in first' using errcode = 'P0001';
  end if;
  select order_id, label into v_order, v_label from public.order_pendencies where id = p_pendency_id;
  if v_order is null then
    raise exception 'ORDER_PENDENCY_NOT_FOUND: that pendency does not exist' using errcode = 'P0001';
  end if;
  perform 1 from public.orders where id = v_order for update;
  if not public.can_manage_order_pendencies(v_order) then
    raise exception 'ORDER_PENDENCY_FORBIDDEN: you cannot change pendencies on this Order' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.orders where id = v_order and status = 'cancelled') then
    raise exception 'ORDER_PENDENCY_ORDER_CANCELLED: this Order is cancelled' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.order_pendencies where id = p_pendency_id and cleared_at is null) then
    raise exception 'ORDER_PENDENCY_NOT_OPEN: that pendency is already approved' using errcode = 'P0001';
  end if;
  if v_path is null then
    raise exception 'ORDER_PENDENCY_EVIDENCE_REQUIRED: an ERP screenshot is required to approve' using errcode = 'P0001';
  end if;
  if v_path not like 'orders/' || v_order::text || '/pendency/%'
     or v_path !~ '^orders/[0-9a-f-]{36}/pendency/[A-Za-z0-9._-]{1,120}$' then
    raise exception 'ORDER_PENDENCY_EVIDENCE_PATH: that screenshot does not belong to this Order' using errcode = 'P0001';
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'order-approval-evidence' and o.name = v_path) then
    raise exception 'ORDER_PENDENCY_EVIDENCE_MISSING: that screenshot was not found in storage' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.order_pendencies p where p.evidence_path = v_path)
     or exists (select 1 from public.order_activity_log l where l.order_id = v_order and l.payload ->> 'evidence_path' = v_path) then
    raise exception 'ORDER_PENDENCY_EVIDENCE_REUSED: that screenshot is already filed against another approval' using errcode = 'P0001';
  end if;

  update public.order_pendencies
     set cleared_at = now(), cleared_by = v_actor, evidence_path = v_path
   where id = p_pendency_id and cleared_at is null;

  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (v_order, v_actor, 'order_pendency_approved',
          jsonb_build_object('pendency_id', p_pendency_id, 'label', v_label, 'evidence_path', v_path));
end;
$$;

-- Clients may no longer clear without proof.
revoke execute on function public.clear_order_pendency(uuid) from public, anon, authenticated;

create or replace function public.reopen_order_pendency(p_pendency_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_order uuid;
  v_label text;
begin
  if v_actor is null then
    raise exception 'ORDER_PENDENCY_NOT_AUTHENTICATED: sign in first' using errcode = 'P0001';
  end if;
  select order_id, label into v_order, v_label from public.order_pendencies where id = p_pendency_id;
  if v_order is null then
    raise exception 'ORDER_PENDENCY_NOT_FOUND: that pendency does not exist' using errcode = 'P0001';
  end if;
  perform 1 from public.orders where id = v_order for update;
  if not public.can_manage_order_pendencies(v_order) then
    raise exception 'ORDER_PENDENCY_FORBIDDEN: you cannot change pendencies on this Order' using errcode = 'P0001';
  end if;
  update public.order_pendencies
     set cleared_at = null, cleared_by = null, evidence_path = null
   where id = p_pendency_id and cleared_at is not null;
  if found then
    insert into public.order_activity_log (order_id, actor_id, event_type, payload)
    values (v_order, v_actor, 'order_pendency_reopened', jsonb_build_object('pendency_id', p_pendency_id, 'label', v_label));
  end if;
end;
$$;

create or replace function public.remove_order_pendency(p_pendency_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_order uuid;
  v_label text;
begin
  if v_actor is null then
    raise exception 'ORDER_PENDENCY_NOT_AUTHENTICATED: sign in first' using errcode = 'P0001';
  end if;
  select order_id, label into v_order, v_label from public.order_pendencies where id = p_pendency_id;
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
  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (v_order, v_actor, 'order_pendency_removed', jsonb_build_object('pendency_id', p_pendency_id, 'label', v_label));
end;
$$;

revoke execute on function public.add_order_pendencies(uuid, text[])  from public, anon;
revoke execute on function public.approve_order_pendency(uuid, text)  from public, anon;
revoke execute on function public.reopen_order_pendency(uuid)         from public, anon;
revoke execute on function public.remove_order_pendency(uuid)         from public, anon;
grant  execute on function public.add_order_pendencies(uuid, text[])  to authenticated;
grant  execute on function public.approve_order_pendency(uuid, text)  to authenticated;
grant  execute on function public.reopen_order_pendency(uuid)         to authenticated;
grant  execute on function public.remove_order_pendency(uuid)         to authenticated;

comment on function public.approve_order_pendency(uuid, text) is
  'Approves ONE open pendency with its ERP screenshot (must exist under orders/<order>/pendency/ and be unclaimed). Authority: can_manage_order_pendencies, re-derived under a row lock. Writes an order_pendency_approved Activity row. 20270421000000.';


-- ═══ 4. Fabric / Finish approvals reach Activity ═════════════════════════════
--
-- A trigger, not a restatement of record_order_approval_event(): whichever path
-- appends an event, Activity records it in the same transaction.

create or replace function public.log_order_approval_event_activity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.order_activity_log (order_id, actor_id, event_type, payload, created_at)
  values (new.order_id, new.actor_id, 'order_approval_recorded',
          jsonb_build_object('kind', new.approval_kind, 'status', new.status, 'evidence_path', new.evidence_path),
          new.created_at);
  return new;
end;
$$;

revoke execute on function public.log_order_approval_event_activity() from public, anon, authenticated;

drop trigger if exists order_approval_events_activity on public.order_approval_events;
create trigger order_approval_events_activity
  after insert on public.order_approval_events
  for each row execute function public.log_order_approval_event_activity();


-- ═══ 5. The list column's one read ═══════════════════════════════════════════

create or replace view public.order_approval_current
with (security_invoker = true) as
  select distinct on (e.order_id, e.approval_kind)
         e.order_id, e.approval_kind, e.status
    from public.order_approval_events e
   order by e.order_id, e.approval_kind, e.created_at desc, e.id desc;

revoke all on public.order_approval_current from public, anon;
grant select on public.order_approval_current to authenticated;

comment on view public.order_approval_current is
  'Newest Fabric / Finish approval status per Order (security_invoker: the reader''s own RLS applies). An Order with no event for a kind is implicitly not_approved. 20270421000000.';


-- ═══ 6. Self-assertion (executed at apply time) ══════════════════════════════

do $$
begin
  if to_regprocedure('public.approve_order_pendency(uuid, text)') is null then
    raise exception 'ASSERTION FAILED: approve_order_pendency was not created';
  end if;
  if has_function_privilege('authenticated', 'public.clear_order_pendency(uuid)', 'execute') then
    raise exception 'ASSERTION FAILED: clients must not clear a pendency without proof';
  end if;
  if has_function_privilege('anon', 'public.approve_order_pendency(uuid, text)', 'execute') then
    raise exception 'ASSERTION FAILED: anon may not approve';
  end if;
  if public.order_approval_evidence_order_id('orders/00000000-0000-0000-0000-000000000001/pendency/x.png') is null then
    raise exception 'ASSERTION FAILED: pendency evidence keys must decode';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'order_approval_events_activity') then
    raise exception 'ASSERTION FAILED: approval activity trigger missing';
  end if;
end;
$$;
