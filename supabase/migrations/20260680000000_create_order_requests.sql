-- Order Requests — separate request-submission entity (Phase 1)
--
-- An Order Request is a PRE-order artifact. Sales (and any authenticated user
-- with Order Management access) submit a request; an admin later reviews it and,
-- in a future phase, converts an approved request into a real public.orders row.
--
-- Submitting a request must NEVER:
--   * insert a public.orders row,
--   * call public.next_order_display_number(), or
--   * advance public.orders_display_number_seq.
-- Order-request numbering is completely independent of official Order numbering.
--
-- Statuses (Phase 1):
--   submitted           → freshly submitted, awaiting admin review
--   needs_clarification → admin asked the requester for more detail
--   rejected            → admin declined the request
--   converted           → RESERVED for the later admin-conversion phase; a
--                         converted request points at exactly one official Order
--
-- Numbering, activity logging, and the trigger/RLS hardening here deliberately
-- mirror the proven Finance Payment Request implementation
-- (20260673 / 20260674 / 20260675). Nothing in this migration touches
-- public.orders, order_activity_log, orders_display_number_seq,
-- next_order_display_number(), finance_payment_requests, or the permission engine.

-- ── 1. Table ──────────────────────────────────────────────────────────────────

create table public.order_requests (
  id                 uuid          primary key default gen_random_uuid(),

  -- DB-assigned, immutable identifier (ORD-REQ-YYYY-NNNN). Any client-supplied
  -- value is overwritten by the BEFORE INSERT trigger below.
  request_number     text          not null unique,

  -- Core request info (reuses public.orders field shapes)
  client_name        text          not null,
  requested_by       uuid          not null references public.users(id),
  created_by         uuid          not null references public.users(id),
  assigned_to        uuid          references public.users(id) on delete set null,
  confirm_date       date,
  due_date           date,
  total_value        numeric(12,2),
  lead_source        text
                       check (lead_source is null or lead_source in (
                         'reference', 'repeat_customer', 'whatsapp', 'instagram', 'website'
                       )),
  notes              text,

  -- Workflow
  status             text          not null default 'submitted'
                       check (status in (
                         'submitted',
                         'needs_clarification',
                         'rejected',
                         'converted'
                       )),
  clarification_note text,
  rejection_reason   text,

  -- Conversion linkage (populated only in the later conversion phase)
  converted_order_id uuid          references public.orders(id),
  converted_at       timestamptz,

  created_at         timestamptz   not null default now(),
  updated_at         timestamptz   not null default now(),

  -- converted_order_id / converted_at are set together, and ONLY when the
  -- request is 'converted'. A non-converted request must carry neither.
  constraint order_requests_converted_consistency check (
    (status =  'converted' and converted_order_id is not null and converted_at is not null)
    or
    (status <> 'converted' and converted_order_id is null and converted_at is null)
  )
);

-- ── 2. Indexes ────────────────────────────────────────────────────────────────

create index order_requests_status_idx        on public.order_requests (status);
create index order_requests_requested_by_idx   on public.order_requests (requested_by);
create index order_requests_created_by_idx      on public.order_requests (created_by);
create index order_requests_assigned_to_idx     on public.order_requests (assigned_to);
create index order_requests_created_at_idx       on public.order_requests (created_at desc);
create index order_requests_converted_order_idx  on public.order_requests (converted_order_id);

-- ── 3. updated_at trigger ─────────────────────────────────────────────────────
-- set_updated_at() was defined in 20260609_create_attendance_records.sql

drop trigger if exists order_requests_set_updated_at on public.order_requests;

create trigger order_requests_set_updated_at
  before update on public.order_requests
  for each row execute function public.set_updated_at();

-- ── 4. Request numbering — ORD-REQ-YYYY-NNNN ──────────────────────────────────
-- Dedicated per-year counter, independent of orders_display_number_seq. Same
-- row-lock idiom as next_finance_payment_request_number(): the ON CONFLICT ...
-- DO UPDATE ... RETURNING locks that year's counter row, so concurrent inserts
-- serialize on it and a number is never duplicated (a failed txn can skip a
-- number, never reuse one).

create table public.order_request_seq (
  year     integer primary key,
  last_seq integer not null default 0
);

alter table public.order_request_seq enable row level security;
-- No policies: reachable only via the SECURITY DEFINER generator below, whose
-- owner (the migration role) is exempt from RLS on tables it owns.

create or replace function public.next_order_request_number(p_year integer)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seq integer;
begin
  insert into public.order_request_seq (year, last_seq)
  values (p_year, 1)
  on conflict (year) do update
    set last_seq = order_request_seq.last_seq + 1
  returning last_seq into v_seq;

  return 'ORD-REQ-' || p_year || '-' || lpad(v_seq::text, 4, '0');
end;
$$;

-- Only the assign-on-insert trigger (running as the function owner) calls this.
revoke execute on function public.next_order_request_number(integer) from public, anon, authenticated;

-- Auto-assign on creation. Always overwrites request_number, so a client can
-- never seed their own number by including request_number in an insert.
create or replace function public.assign_order_request_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.request_number := public.next_order_request_number(extract(year from new.created_at)::integer);
  return new;
end;
$$;

revoke execute on function public.assign_order_request_number() from public, anon, authenticated;

drop trigger if exists order_requests_assign_number on public.order_requests;

create trigger order_requests_assign_number
  before insert on public.order_requests
  for each row execute function public.assign_order_request_number();

-- Immutability guard: reject any change to request_number once assigned, for
-- every role including admin. This is a database-level guarantee.
create or replace function public.prevent_order_request_number_change()
returns trigger
language plpgsql
as $$
begin
  if old.request_number is not null and new.request_number is distinct from old.request_number then
    raise exception 'request_number is immutable and cannot be changed once assigned';
  end if;
  return new;
end;
$$;

revoke execute on function public.prevent_order_request_number_change() from public, anon, authenticated;

drop trigger if exists order_requests_protect_number on public.order_requests;

create trigger order_requests_protect_number
  before update on public.order_requests
  for each row execute function public.prevent_order_request_number_change();

-- ── 5. Activity foundation ────────────────────────────────────────────────────
-- Append-only ledger. Phase 1 records only:
--   request_submitted → on creation      (to_status = the new status)
--   status_changed    → on real status change (from_status/to_status set)
-- Rows are written exclusively by the SECURITY DEFINER trigger below, in the
-- same transaction as the business mutation. No client role can insert, spoof
-- an actor, or forge an event.

create table public.order_request_activity (
  id                uuid        primary key default gen_random_uuid(),
  order_request_id  uuid        not null references public.order_requests(id) on delete cascade,
  event_type        text        not null
                      check (event_type in ('request_submitted', 'status_changed')),
  actor_id          uuid        references public.users(id) on delete set null,
  from_status       text,
  to_status         text,
  details           jsonb       not null default '{}'::jsonb,
  created_at        timestamptz not null default now()
);

create index order_request_activity_request_created_idx
  on public.order_request_activity (order_request_id, created_at);

create or replace function public.log_order_request_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
begin
  if (tg_op = 'INSERT') then
    insert into public.order_request_activity
      (order_request_id, event_type, actor_id, from_status, to_status)
    values (new.id, 'request_submitted', v_actor, null, new.status);

  elsif (new.status is distinct from old.status) then
    insert into public.order_request_activity
      (order_request_id, event_type, actor_id, from_status, to_status)
    values (new.id, 'status_changed', v_actor, old.status, new.status);

  -- else: a plain field edit / updated_at touch — nothing to record.
  end if;

  return null;  -- AFTER trigger; return value is ignored.
end;
$$;

-- Only ever fired by the trigger.
revoke execute on function public.log_order_request_activity() from public, anon, authenticated;

drop trigger if exists order_requests_log_activity on public.order_requests;

create trigger order_requests_log_activity
  after insert or update on public.order_requests
  for each row execute function public.log_order_request_activity();

-- ── 6. RLS — order_requests ───────────────────────────────────────────────────
-- Mirrors the Order Management access model, scoped like finance_payment_requests
-- (requester + admin, no operations/team widening). Order-level visibility is by
-- requested_by / created_by; admin sees everything. No unauthenticated access.

alter table public.order_requests enable row level security;

-- Requester: see requests they submitted (created_by) or are named on (requested_by)
create policy "order_requests_requester_select" on public.order_requests
  for select to authenticated
  using (requested_by = auth.uid() or created_by = auth.uid());

-- Admin: see all
create policy "order_requests_admin_select" on public.order_requests
  for select to authenticated
  using (
    exists (select 1 from public.users where users.id = auth.uid() and users.role = 'admin')
  );

-- Submit: any authenticated user may create their OWN request, which must start
-- as 'submitted' with no conversion fields. created_by is pinned to the caller,
-- so a request can never be attributed to someone else on insert.
create policy "order_requests_requester_insert" on public.order_requests
  for insert to authenticated
  with check (
    created_by = auth.uid()
    and status = 'submitted'
    and converted_order_id is null
    and converted_at is null
  );

-- Requester: may edit only their own requests while still in an editable status,
-- and may never move them into an administrative status (rejected/converted) or
-- populate conversion fields. The status whitelist in WITH CHECK enforces that.
create policy "order_requests_requester_update" on public.order_requests
  for update to authenticated
  using (
    (created_by = auth.uid() or requested_by = auth.uid())
    and status in ('submitted', 'needs_clarification')
  )
  with check (
    (created_by = auth.uid() or requested_by = auth.uid())
    and status in ('submitted', 'needs_clarification')
    and converted_order_id is null
    and converted_at is null
  );

-- Admin: full update (review, clarification, rejection, and later conversion)
create policy "order_requests_admin_update" on public.order_requests
  for update to authenticated
  using (
    exists (select 1 from public.users where users.id = auth.uid() and users.role = 'admin')
  )
  with check (
    exists (select 1 from public.users where users.id = auth.uid() and users.role = 'admin')
  );

-- Admin: hard-delete (consistent with orders_admin_delete and the finance
-- request admin delete). Cascades to order_request_activity.
create policy "order_requests_admin_delete" on public.order_requests
  for delete to authenticated
  using (
    exists (select 1 from public.users where users.id = auth.uid() and users.role = 'admin')
  );

-- ── 7. RLS — order_request_activity ───────────────────────────────────────────
-- Read-only for clients: they may SELECT activity for requests they can see;
-- all writes go through the SECURITY DEFINER trigger. INSERT/UPDATE/DELETE (and
-- the non-DML Supabase defaults) are revoked so the table is strictly read-only
-- for authenticated and anon, and no INSERT/UPDATE/DELETE policy exists.

alter table public.order_request_activity enable row level security;

create policy "order_request_activity_requester_select" on public.order_request_activity
  for select to authenticated
  using (
    exists (
      select 1 from public.order_requests r
      where r.id = order_request_activity.order_request_id
        and (r.requested_by = auth.uid() or r.created_by = auth.uid())
    )
  );

create policy "order_request_activity_admin_select" on public.order_request_activity
  for select to authenticated
  using (
    exists (select 1 from public.users where users.id = auth.uid() and users.role = 'admin')
  );

revoke insert, update, delete, truncate, references, trigger
  on public.order_request_activity from authenticated, anon;
