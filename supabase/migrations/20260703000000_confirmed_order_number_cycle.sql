-- Confirmed Orders — admin-controlled Order number cycle.
--
-- Business context: the next Confirmed Order number must become an admin
-- decision instead of an opaque database counter. An admin sets "the next Order
-- number to issue"; every future Confirmed Order takes its number from that
-- setting; existing Orders are never renumbered.
--
-- Live state this migration was written against (inspected on the deployed
-- database, 2026-07-21, not inferred from migration files):
--
--   public.orders                  1 row: display_number '17', status 'running'
--   orders.display_number          text NOT NULL, NO column default
--   orders_display_number_key      UNIQUE (display_number)          -- already present
--   orders_display_number_idx      plain btree on the same column   -- redundant, left alone
--   non-numeric display_numbers    0
--   highest numeric display_number 17
--   orders_display_number_seq      last_value 19, is_called true -> next nextval would be 20
--   pg_depend on that sequence     ONLY deptype 'n' to the schema; it is a
--                                  free-standing sequence, owned by no column,
--                                  and no column default references it
--   triggers on orders             orders_set_updated_at, orders_protect_source_request
--                                  (nothing protects display_number)
--   functions inserting into orders
--                                  convert_order_request_to_order(uuid,uuid[]) ONLY.
--                                  approve_finance_payment_request stopped creating
--                                  Orders in 20260690000000.
--   next_order_display_number()    ACL '=X/postgres' -> PUBLIC and anon hold EXECUTE
--
-- Two bypasses were found during that inspection and both are closed here:
--
--   1. RLS orders_sales_insert (WITH CHECK requested_by = auth.uid()) and
--      orders_admin_insert allow a direct PostgREST insert into public.orders.
--      Because display_number has no default, such an insert must supply the
--      number itself — i.e. any sales user could hand-pick an Order number.
--      The application never uses this path, but leaving it open would mean the
--      numbering cycle is a convention rather than a guarantee.
--
--   2. next_order_display_number() is executable by PUBLIC and anon, so anyone
--      at all could burn values off the old sequence.
--
-- The chosen shape follows this project's own numbering idiom, proven by
-- 20260673 (finance_payment_requests.request_number): a small counter table, an
-- allocation function that is not client-callable, a BEFORE INSERT trigger that
-- ALWAYS stamps the number so a caller can never seed one, and an immutability
-- trigger. Stamping in a trigger — rather than in the conversion RPC body — is
-- what closes bypass 1 without touching a single RLS policy.
--
-- Scope discipline: this migration changes Confirmed Order numbering only. It
-- does not renumber any existing Order, does not reset/drop/restart/advance the
-- old sequence, does not touch Order Request numbering, does not change Order
-- statuses or RLS, does not alter Payment Request logic, and introduces no
-- prefix, padding, financial-year cycle, or bulk renumbering.

-- ── 1. The cycle table ────────────────────────────────────────────────────────
--
-- Singleton by construction: a boolean primary key that the CHECK constrains to
-- true. Exactly one row can ever exist, so "the cycle" is never ambiguous and no
-- application code has to pick which row is the live one.
--
-- next_number is bigint, not text: it is arithmetic state, and the bare-numeric
-- display format is produced at the point of use (::text) rather than stored.
-- That keeps ordering, comparison, and the "> highest existing" rule honest.
--
-- configured_at / configured_by record the last ADMIN decision only. The
-- allocator deliberately does not touch them — automatic advancement is not a
-- configuration change, and conflating the two would destroy the audit meaning
-- of both columns.

create table if not exists public.order_number_cycle (
  id             boolean     primary key default true,
  next_number    bigint      not null,
  configured_at  timestamptz,
  configured_by  uuid        references public.users(id) on delete set null,
  constraint order_number_cycle_singleton   check (id),
  constraint order_number_cycle_positive    check (next_number > 0)
);

comment on table public.order_number_cycle is
  'Single-row admin-configured cycle for Confirmed Order numbers (public.orders.display_number). Never written directly by clients: RLS is enabled with no policies, and all writes go through set_next_confirmed_order_number() or allocate_confirmed_order_number().';

comment on column public.order_number_cycle.next_number is
  'The next Confirmed Order number to allocate — not the last one issued. Allocation returns this value and then advances it by one, inside the allocating transaction.';

comment on column public.order_number_cycle.configured_at is
  'When an admin last set the cycle. Not touched by automatic allocation.';

-- ── 2. Bootstrap ──────────────────────────────────────────────────────────────
--
-- The initial value is derived from the live database, never assumed.
--
--   greatest( highest existing numeric Order number + 1,
--             the old sequence's next generated value )
--
-- The first term is the business rule's floor: the cycle must sit strictly
-- above every Order that already exists.
--
-- The second term exists so production behaviour cannot silently move
-- BACKWARDS at deploy time. The old sequence has already handed out values up
-- to 19 (a rolled-back conversion test consumed some; sequences are
-- non-transactional, so those values are gone and are not coming back). If this
-- migration bootstrapped to 18, the very next Order would be numbered lower
-- than numbers the system had already issued and skipped, which is a surprise
-- nobody asked for. Starting at the sequence's next value is the continuous,
-- non-surprising choice.
--
-- On this database that evaluates to greatest(17 + 1, 20) = 20.
--
-- This is a floor, not a lock-in: section 4 lets an admin set ANY value above
-- the highest existing Order number afterwards — including 18 or 19, which the
-- old sequence burned but no Order actually owns. Burned-but-unowned numbers are
-- explicitly reclaimable, exactly as the business rule requires.
--
-- ON CONFLICT DO NOTHING makes the migration re-runnable and, critically, makes
-- it non-destructive on re-run: it will never stomp a value an admin has since
-- configured.
--
-- coalesce(..., 0) covers the empty-orders case; the ~ '^[0-9]+$' guard means a
-- hypothetical non-numeric legacy number can never crash the cast (there are
-- none today, and this migration does not create the possibility of one).

insert into public.order_number_cycle (id, next_number, configured_at, configured_by)
select
  true,
  greatest(
    coalesce(
      (select max(o.display_number::bigint)
         from public.orders o
        where o.display_number ~ '^[0-9]+$'),
      0
    ) + 1,
    (select s.last_value + (case when s.is_called then 1 else 0 end)
       from public.orders_display_number_seq s)
  ),
  now(),
  null
on conflict (id) do nothing;

-- ── 3. RLS: the table is not client-writable, and not client-readable ─────────
--
-- RLS is enabled with NO policies at all, which under Postgres means every
-- client role is denied every operation on the table. The admin UI does not read
-- the table directly — it calls the reader function in section 5 — so there is
-- no reason to open even a SELECT policy. The two SECURITY DEFINER functions
-- below run as the table owner and are unaffected by RLS.
--
-- The explicit REVOKE is belt-and-braces against Supabase's default privileges
-- for the public schema, which grant table DML to anon/authenticated on
-- creation. RLS alone would already block them; removing the grant as well means
-- a future accidental "create a permissive policy" cannot silently open a write
-- path.

alter table public.order_number_cycle enable row level security;

revoke all on table public.order_number_cycle from public, anon, authenticated;

-- ── 4. Admin setter ───────────────────────────────────────────────────────────
--
-- SECURITY DEFINER because the table is closed to every client role (section 3);
-- this function is the only sanctioned write path. Admin authorization is
-- enforced in the body against public.users.role = 'admin' — this project has no
-- admin database role, and every Finance/Orders RPC already uses exactly this
-- check. search_path is pinned to public.
--
-- Validation is layered deliberately:
--   * bigint parameter type      rejects non-integers before the body runs
--   * null / <= 0 guard          rejects the degenerate values explicitly
--   * order_number_cycle_positive keeps the stored value sane even if some
--                                future code path reaches the table another way
--   * > highest existing         the actual business rule
--
-- The rule is "> highest existing numeric Order number", and NOT "> anything the
-- old sequence ever handed out". A number the sequence burned during a
-- rolled-back test belongs to no Order and is free to reuse; refusing it would
-- punish the admin for an implementation detail of Postgres sequences.
--
-- FOR UPDATE before the read: an admin save and a concurrent conversion cannot
-- interleave into a lost update, and two admins saving at once serialize.
--
-- This function reads public.orders but writes only the cycle row. No existing
-- Order is touched, here or anywhere else in this migration.

create or replace function public.set_next_confirmed_order_number(p_next_number bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor   uuid := auth.uid();
  v_highest bigint;
  v_prev    bigint;
begin
  -- 1. Authentication
  if v_actor is null then
    raise exception 'Authentication required to set the Confirmed Order number cycle'
      using errcode = '28000';
  end if;

  -- 2. Trusted admin authorization (server-side; never trust the frontend)
  if not exists (
    select 1 from public.users u
    where u.id = v_actor and u.role = 'admin'
  ) then
    raise exception 'Only an admin may set the Confirmed Order number cycle'
      using errcode = '42501';
  end if;

  -- 3. Reject the degenerate inputs the bigint type cannot catch on its own.
  if p_next_number is null then
    raise exception 'ORDER_NUMBER_INVALID: A next Order number is required'
      using errcode = 'P0001';
  end if;

  if p_next_number <= 0 then
    raise exception 'ORDER_NUMBER_INVALID: The next Order number must be a positive whole number'
      using errcode = 'P0001';
  end if;

  -- 4. Lock the cycle row before reading it.
  select c.next_number into v_prev
  from public.order_number_cycle c
  where c.id = true
  for update;

  if not found then
    raise exception 'ORDER_NUMBER_CYCLE_MISSING: Confirmed Order numbering is not configured'
      using errcode = 'P0001';
  end if;

  -- 5. The business rule, computed from real Order data under the held lock.
  select coalesce(max(o.display_number::bigint), 0) into v_highest
  from public.orders o
  where o.display_number ~ '^[0-9]+$';

  if p_next_number <= v_highest then
    raise exception
      'ORDER_NUMBER_TOO_LOW: The next Order number must be greater than the highest existing Order number (%)',
      v_highest
      using errcode = 'P0001';
  end if;

  -- 6. Defence in depth. Unreachable while every Order number is numeric (the
  --    check above already dominates), but it keeps the guarantee true if a
  --    non-numeric legacy number ever appears, which max()::bigint would skip.
  if exists (
    select 1 from public.orders o where o.display_number = p_next_number::text
  ) then
    raise exception 'ORDER_NUMBER_IN_USE: Order number % is already in use', p_next_number
      using errcode = 'P0001';
  end if;

  update public.order_number_cycle
     set next_number   = p_next_number,
         configured_at = now(),
         configured_by = v_actor
   where id = true;

  return jsonb_build_object(
    'next_number',             p_next_number,
    'previous_next_number',    v_prev,
    'highest_existing_number', v_highest
  );
end;
$$;

revoke execute on function public.set_next_confirmed_order_number(bigint) from public, anon;
grant  execute on function public.set_next_confirmed_order_number(bigint) to authenticated;

comment on function public.set_next_confirmed_order_number(bigint) is
  'Admin-only. Sets the next Confirmed Order number. Requires the value to exceed the highest existing numeric Order number. Never modifies an existing Order.';

-- ── 5. Admin reader ───────────────────────────────────────────────────────────
--
-- Exists so the cycle table itself can stay completely closed (section 3) while
-- the admin UI still gets both numbers it must display, in one round trip and
-- from one consistent snapshot. Computing "highest existing" client-side would
-- otherwise mean shipping every Order row to the browser just to take a max.
--
-- Read-only, admin-gated with the same check as the setter.

create or replace function public.get_confirmed_order_number_cycle()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_actor   uuid := auth.uid();
  v_next    bigint;
  v_highest bigint;
begin
  if v_actor is null then
    raise exception 'Authentication required to read the Confirmed Order number cycle'
      using errcode = '28000';
  end if;

  if not exists (
    select 1 from public.users u
    where u.id = v_actor and u.role = 'admin'
  ) then
    raise exception 'Only an admin may read the Confirmed Order number cycle'
      using errcode = '42501';
  end if;

  select c.next_number into v_next
  from public.order_number_cycle c
  where c.id = true;

  select coalesce(max(o.display_number::bigint), 0) into v_highest
  from public.orders o
  where o.display_number ~ '^[0-9]+$';

  return jsonb_build_object(
    'next_number',             v_next,             -- null if the cycle row is missing
    'highest_existing_number', v_highest,
    'configured',              v_next is not null
  );
end;
$$;

revoke execute on function public.get_confirmed_order_number_cycle() from public, anon;
grant  execute on function public.get_confirmed_order_number_cycle() to authenticated;

-- ── 6. The allocator ──────────────────────────────────────────────────────────
--
-- The single mechanism that issues a Confirmed Order number, and the reason the
-- whole feature is concurrency-safe.
--
-- SELECT ... FOR UPDATE on the singleton cycle row is the serialization point.
-- Two concurrent conversions cannot both read the same next_number: the second
-- blocks on the row lock until the first COMMITS or ROLLS BACK, and only then
-- re-reads. On commit it sees the already-advanced value and takes the next
-- number; on rollback it sees the original value and takes that one. Distinct
-- numbers either way, with no gap on failure.
--
-- This is precisely what the old sequence could not do. nextval() is
-- non-transactional by design: a rolled-back transaction keeps the number it
-- consumed, which is exactly how the live sequence drifted to 19 while the
-- highest real Order is 17. Because the cycle lives in an ordinary table row,
-- its advancement is bound to the surrounding transaction — so a conversion that
-- fails at ANY later step (stale payments, a constraint violation, an
-- application error) leaves next_number exactly as it was.
--
-- It is deliberately NOT callable by clients. EXECUTE is revoked from public,
-- anon and authenticated; it is reached only from the section 7 trigger
-- function, which is itself SECURITY DEFINER and therefore runs as the owner.
-- There is no broadly callable public allocator.
--
-- Every failure mode raises a distinct, greppable code prefix so the UI can map
-- it to plain language instead of leaking Postgres internals.

create or replace function public.allocate_confirmed_order_number()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next    bigint;
  v_highest bigint;
  v_number  text;
begin
  -- 1. Serialize on the cycle row. Transaction-scoped: released at COMMIT or
  --    ROLLBACK, never held across statements outside this transaction.
  select c.next_number into v_next
  from public.order_number_cycle c
  where c.id = true
  for update;

  if not found then
    raise exception 'ORDER_NUMBER_CYCLE_MISSING: Confirmed Order numbering is not configured'
      using errcode = 'P0001';
  end if;

  if v_next is null or v_next <= 0 then
    raise exception 'ORDER_NUMBER_CYCLE_INVALID: The configured next Order number is not a valid positive number'
      using errcode = 'P0001';
  end if;

  -- 2. Re-verify the business rule at allocation time, not just at save time.
  --    The cycle could have been configured before an Order was created by some
  --    future path, and issuing a number at or below the highest existing Order
  --    must fail loudly rather than collide.
  select coalesce(max(o.display_number::bigint), 0) into v_highest
  from public.orders o
  where o.display_number ~ '^[0-9]+$';

  if v_next <= v_highest then
    raise exception
      'ORDER_NUMBER_CYCLE_BEHIND: The configured next Order number (%) is not above the highest existing Order number (%)',
      v_next, v_highest
      using errcode = 'P0001';
  end if;

  v_number := v_next::text;

  -- 3. Explicit collision check, so the failure is a clear message rather than
  --    a raw unique-violation on orders_display_number_key.
  if exists (
    select 1 from public.orders o where o.display_number = v_number
  ) then
    raise exception 'ORDER_NUMBER_IN_USE: Order number % is already in use', v_number
      using errcode = 'P0001';
  end if;

  -- 4. Advance. Rolls back with the caller's transaction if anything later
  --    fails, so a failed conversion never burns a number.
  update public.order_number_cycle
     set next_number = v_next + 1
   where id = true;

  return v_number;
end;
$$;

revoke execute on function public.allocate_confirmed_order_number() from public, anon, authenticated;

comment on function public.allocate_confirmed_order_number() is
  'Internal. Allocates the next Confirmed Order number under a FOR UPDATE lock on the singleton cycle row and advances it, within the caller transaction. Not client-callable — reached only via the orders_assign_display_number trigger.';

-- ── 7. Stamping trigger — the only way a number gets onto an Order ────────────
--
-- This is what makes numbering a database guarantee instead of an application
-- convention, and it is why allocation lives in a trigger rather than only in
-- the conversion RPC body.
--
-- RLS policies orders_sales_insert and orders_admin_insert permit a direct
-- PostgREST insert into public.orders. Since display_number has no column
-- default, such an insert must supply the number itself — so without this
-- trigger, any sales user could POST an Order carrying a hand-picked number and
-- walk straight past the cycle. Putting allocation in the conversion RPC alone
-- would leave that door open.
--
-- The assignment is UNCONDITIONAL: whatever display_number a caller supplies is
-- discarded and replaced. That is the same rule 20260673 already applies to
-- finance_payment_requests.request_number ("a caller can never seed their own
-- number"), and it is the only version of this trigger that actually closes the
-- hole — a "only fill it in when NULL" variant would still let a caller choose.
--
-- BEFORE INSERT, so it runs ahead of the NOT NULL and UNIQUE checks on the
-- column; a caller may therefore omit display_number entirely.
--
-- SECURITY DEFINER on the trigger function, so it can reach the allocator that
-- section 6 revoked from every client role. Postgres does not check EXECUTE on a
-- trigger function when the trigger fires, so this does not re-open anything:
-- the allocator remains unreachable except through an actual INSERT on
-- public.orders.

create or replace function public.assign_order_display_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.display_number := public.allocate_confirmed_order_number();
  return new;
end;
$$;

revoke execute on function public.assign_order_display_number() from public, anon, authenticated;

drop trigger if exists orders_assign_display_number on public.orders;

create trigger orders_assign_display_number
  before insert on public.orders
  for each row execute function public.assign_order_display_number();

-- ── 8. Existing Order numbers are immutable ───────────────────────────────────
--
-- orders_admin_update and orders_operations_update grant UPDATE over the whole
-- row, so without this an admin — or any operations user — could renumber a
-- historical Order, which rule 3 forbids outright.
--
-- Same idiom, and deliberately the same shape, as the immutability guards
-- already on this project: prevent_order_source_request_change (20260701),
-- prevent_order_request_number_change (20260680), and
-- prevent_finance_payment_request_number_change (20260673). A separate trigger
-- from orders_protect_source_request rather than an edit to it: the two concerns
-- are independent, and 20260701 is already applied and must not be rewritten.
--
-- Scoped narrowly so it never interferes with ordinary Order updates: it fires
-- only when display_number actually differs, so status changes, note edits,
-- assignment changes and every other update pass straight through. A no-op write
-- of the same value is allowed. Initial insertion is unaffected — this is an
-- UPDATE trigger only.

create or replace function public.prevent_order_display_number_change()
returns trigger
language plpgsql
as $$
begin
  if old.display_number is not null
     and new.display_number is distinct from old.display_number then
    raise exception 'ORDER_NUMBER_IMMUTABLE: An Order number cannot be changed once the Order exists'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke execute on function public.prevent_order_display_number_change() from public, anon, authenticated;

drop trigger if exists orders_protect_display_number on public.orders;

create trigger orders_protect_display_number
  before update on public.orders
  for each row execute function public.prevent_order_display_number_change();

-- ── 9. Uniqueness — verified, not duplicated ──────────────────────────────────
--
-- orders_display_number_key (UNIQUE on display_number) already exists from
-- 20260655 and is the correct constraint for the actual text data type. Adding a
-- second unique index would be pure duplication, so this migration adds nothing
-- here and instead asserts the guarantee is really present. If it is ever
-- missing, this migration fails loudly rather than proceeding on an assumption —
-- the whole numbering contract depends on it.
--
-- Deliberately NOT wrapped in a broad exception handler: an unexpected schema
-- conflict must surface, not be swallowed.

do $$
begin
  if not exists (
    select 1
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'orders'
      and con.contype = 'u'
      and pg_get_constraintdef(con.oid) = 'UNIQUE (display_number)'
  ) then
    raise exception
      'Expected a UNIQUE constraint on public.orders(display_number); the Confirmed Order number cycle cannot guarantee uniqueness without it';
  end if;
end $$;

-- ── 10. The old sequence ──────────────────────────────────────────────────────
--
-- public.orders_display_number_seq is left ENTIRELY UNTOUCHED. It is not reset,
-- dropped, restarted, advanced, or re-owned. last_value stays 19, is_called
-- stays true. Inspection confirmed it is free-standing — pg_depend shows only a
-- schema dependency, no column owns it and no column default references it — so
-- nothing breaks by simply ceasing to use it, and there is no dependency that
-- would require altering it.
--
-- What DOES change is that nothing calls it any more. next_order_display_number()
-- was its only reader, and after section 7 the conversion RPC no longer calls
-- that function (section 11). The one remaining risk was its ACL: inspection
-- found '=X/postgres', meaning PUBLIC and anon held EXECUTE and could burn
-- sequence values at will. Those grants are removed.
--
-- The function and the sequence are both retained rather than dropped: retaining
-- them is the non-destructive choice, keeps the historical numbering trail
-- readable, and leaves a trivial rollback path. Revoking EXECUTE is safe and
-- reversible — verified that no database function and no application file calls
-- next_order_display_number() once section 11 lands, and the owner (postgres)
-- keeps EXECUTE regardless.

revoke execute on function public.next_order_display_number() from public, anon, authenticated;

comment on function public.next_order_display_number() is
  'RETIRED 20260703000000. Superseded by the admin-configured cycle (order_number_cycle / allocate_confirmed_order_number). No longer called by anything; EXECUTE revoked from all client roles. Retained, along with orders_display_number_seq, for history and rollback only — do not reuse.';

-- ── 11. Conversion RPC — take the number the trigger assigned ─────────────────
--
-- The deployed 20260702000000 body, reproduced from pg_get_functiondef on the
-- live database (single overload, verified), with exactly two changes:
--
--   * step 11 no longer calls next_order_display_number(). Allocation now
--     happens inside the INSERT, via orders_assign_display_number.
--   * step 12's RETURNING now also returns display_number, so v_number carries
--     the number the trigger actually assigned — read back from the row rather
--     than assumed.
--
-- Moving allocation into the trigger does not weaken the "a rejected attempt
-- never burns a number" property that step 11 was protecting; it strengthens it.
-- The INSERT still happens only after every check has passed, and unlike
-- nextval() the cycle now rolls back with the transaction, so even a failure
-- AFTER allocation returns the number to the pool.
--
-- Everything else is untouched, and deliberately so: the admin authorization
-- recheck, the request row lock, the conversion-eligibility rechecks, the
-- deterministic payment lock ordering, the all-or-nothing STALE_PAYMENTS
-- revalidation under held locks, the explicit 'running' status (20260702), the
-- provenance columns (20260701), the pure linkage transfer, the request
-- close-out, the order_activity_log row, and the returned jsonb shape.
--
-- CREATE OR REPLACE with the signature unchanged, so the live ACL
-- (postgres=X, service_role=X, authenticated=X; anon and public revoked)
-- survives. The revoke/grant at the end re-asserts exactly that state.

create or replace function public.convert_order_request_to_order(
  p_order_request_id    uuid,
  p_payment_request_ids uuid[] default '{}'::uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_actor    uuid := auth.uid();
  v_req      public.order_requests%rowtype;
  v_number   text;
  v_order_id uuid;
  v_now      timestamptz := now();
  v_manual   uuid[];
  v_ids      uuid[];
  v_count    integer;
  v_eligible integer;
begin
  -- 1. Authentication
  if v_actor is null then
    raise exception 'Authentication required to convert an order request'
      using errcode = '28000';
  end if;

  -- 2. Trusted admin authorization (server-side; never trust the frontend)
  if not exists (
    select 1 from public.users u
    where u.id = v_actor and u.role = 'admin'
  ) then
    raise exception 'Only an admin may convert an order request'
      using errcode = '42501';
  end if;

  -- 3. Normalize the manual selection: null array -> empty, null elements
  --    dropped, duplicates collapsed.
  select coalesce(array_agg(distinct x order by x), '{}'::uuid[])
    into v_manual
  from unnest(coalesce(p_payment_request_ids, '{}'::uuid[])) as t(x)
  where x is not null;

  -- 4. Lock the request row: serializes double-clicks, replays, two admins
  --    racing on the same request, AND any concurrent
  --    link_finance_payment_to_order_request on this request (it takes the
  --    request lock first too, so no NEW payment can be parked on this
  --    request for the rest of this transaction).
  select * into v_req
  from public.order_requests
  where id = p_order_request_id
  for update;

  if not found then
    raise exception 'Order request % not found', p_order_request_id
      using errcode = 'P0002';
  end if;

  -- 5. Recheck every Phase 2A conversion rule.
  if v_req.converted_order_id is not null or v_req.converted_at is not null then
    raise exception 'Order request % has already been converted', v_req.request_number
      using errcode = 'P0001';
  end if;

  if v_req.status <> 'submitted' then
    raise exception 'Only a submitted order request can be converted (% is %)',
      v_req.request_number, v_req.status
      using errcode = 'P0001';
  end if;

  -- 6. Build the lock set: the admin's manual selection UNION every payment
  --    currently parked on this request, sorted so the lock acquisition below
  --    is deterministic (deadlock-free with any concurrent conversion locking
  --    an overlapping set).
  select coalesce(array_agg(distinct x order by x), '{}'::uuid[])
    into v_ids
  from (
    select unnest(v_manual) as x
    union
    select f.id
    from public.finance_payment_requests f
    where f.order_request_id = p_order_request_id
  ) as t
  where x is not null;

  if coalesce(array_length(v_ids, 1), 0) > 0 then
    -- 7. Lock every payment in ascending uuid order.
    perform 1
    from public.finance_payment_requests
    where id = any(v_ids)
    order by id
    for update;

    -- 8. Rebuild the link set UNDER the held locks: the manual selection plus
    --    the payments STILL parked on this request. A payment unparked by a
    --    concurrent unlink between step 6 and the locks is thereby dropped
    --    (left locked but untouched) instead of being silently swept into the
    --    new Order against that admin's action.
    select coalesce(array_agg(distinct x order by x), '{}'::uuid[])
      into v_ids
    from (
      select unnest(v_manual) as x
      union
      select f.id
      from public.finance_payment_requests f
      where f.id = any(v_ids)
        and f.order_request_id = p_order_request_id
    ) as t
    where x is not null;
  end if;

  v_count := coalesce(array_length(v_ids, 1), 0);

  if v_count > 0 then
    -- 9. Revalidate AFTER the locks are held — never trust the list the client
    --    was shown. Eligible = approved_unlinked, no order, and either no
    --    request linkage or parked on THIS request. A payment parked on a
    --    DIFFERENT request, or linked/consumed meanwhile, fails the count
    --    (a missing id, a wrong status, or a populated order_id each make the
    --    eligible count fall short).
    select count(*) into v_eligible
    from public.finance_payment_requests
    where id = any(v_ids)
      and status   = 'approved_unlinked'
      and order_id is null
      and (order_request_id is null or order_request_id = p_order_request_id);

    -- 10. All-or-nothing: one bad payment aborts the entire conversion, so no
    --     Order is created and the request stays submitted.
    if v_eligible <> v_count then
      raise exception 'STALE_PAYMENTS: one or more selected payment requests are no longer eligible for linking'
        using errcode = 'P0001';
    end if;
  end if;

  -- 11. The Order number is no longer fetched here. It is allocated by
  --     orders_assign_display_number (20260703000000) as part of the INSERT
  --     below, from the admin-configured cycle, under a FOR UPDATE lock on the
  --     cycle row — and it advances only if this transaction commits. The
  --     insert still happens only after every check above has passed, so a
  --     rejected attempt consumes nothing.

  -- 12. Exactly one official Order, starting at 'running' (20260702000000).
  --     Stated explicitly rather than left to the column default: conversion
  --     IS the approval, so the Order it produces is confirmed and its work is
  --     open from its first moment. There is no pre-approval Order state.
  --     source_order_request_id / source_request_number are written here, in
  --     the creating INSERT, so provenance exists from the Order's first
  --     moment and is covered by this transaction's rollback like everything
  --     else. Both are frozen immediately afterwards by
  --     orders_protect_source_request.
  --
  --     display_number is deliberately NOT listed: the BEFORE INSERT trigger
  --     assigns it unconditionally, and RETURNING reads back the value it
  --     actually assigned rather than trusting a separately fetched one.
  insert into public.orders (
    client_name, requested_by, assigned_to,
    confirm_date, due_date, total_value, total_product_value, lead_source, notes, created_by,
    status,
    source_order_request_id, source_request_number
  )
  values (
    v_req.client_name, v_req.requested_by, v_req.assigned_to,
    v_req.confirm_date, v_req.due_date, v_req.total_value, v_req.total_product_value,
    v_req.lead_source, v_req.notes, v_actor,
    'running',
    v_req.id, v_req.request_number
  )
  returning id, display_number into v_order_id, v_number;

  -- 13. Link every payment in the set to the Order just created, clearing any
  --     request parking in the same statement. Amount, dates, mode, proof,
  --     submitter, and prior activity rows are untouched — this is a pure
  --     linkage transfer, never a copy.
  if v_count > 0 then
    update public.finance_payment_requests
       set status               = 'approved_linked',
           order_id             = v_order_id,
           order_number         = v_number,
           order_request_id     = null,
           order_request_number = null,
           updated_at           = v_now
     where id = any(v_ids);
  end if;

  -- 14. Close out the request. Runs after linking so the request_converted
  --     activity row can record linked_payment_count from real state.
  update public.order_requests
     set status             = 'converted',
         converted_order_id = v_order_id,
         converted_at       = v_now,
         updated_at         = v_now
   where id = p_order_request_id;

  -- 15. Order-side provenance (no amounts or payment details in the payload).
  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (
    v_order_id, v_actor, 'order_created_from_request',
    jsonb_build_object(
      'order_request_id',     v_req.id,
      'request_number',       v_req.request_number,
      'linked_payment_count', v_count
    )
  );

  -- 16. Structured result — identifiers and counts only, no private payment data.
  return jsonb_build_object(
    'order_request_id',           v_req.id,
    'request_number',             v_req.request_number,
    'order_id',                   v_order_id,
    'order_display_number',       v_number,
    'converted_at',               v_now,
    'linked_payment_count',       v_count,
    'linked_payment_request_ids', to_jsonb(v_ids)
  );
end;
$function$;

revoke execute on function public.convert_order_request_to_order(uuid, uuid[]) from public, anon;
grant  execute on function public.convert_order_request_to_order(uuid, uuid[]) to authenticated;
