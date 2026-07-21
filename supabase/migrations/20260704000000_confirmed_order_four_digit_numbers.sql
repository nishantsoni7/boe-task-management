-- Confirmed Orders — mandatory four-digit Order numbers.
--
-- Business rule: a Confirmed Order number is always exactly four numeric
-- characters, 0001 through 9999. No prefix, no year, no spaces. Order Request
-- numbering (ORD-REQ-YYYY-NNNN) is a separate scheme and is not touched here.
--
-- This migration builds directly on 20260703000000, which is already applied and
-- is NOT edited. That migration established the admin-configured cycle, the
-- allocator, the stamping trigger and the immutability trigger; what it did not
-- do is fix the stored FORMAT — it wrote bare numerics ('17', '20', '21'). This
-- migration adds the format as a database guarantee and normalizes the one
-- existing row to match.
--
-- Live state this migration was written against (inspected on the deployed
-- database, 2026-07-21, not inferred from migration files):
--
--   public.orders                  1 row: display_number '17', status 'running',
--                                  source_order_request_id -> ORD-REQ-2026-0003
--   non-numeric display_numbers    0
--   display_numbers outside 1-9999 0
--   duplicates after zero-padding  0
--   highest numeric Order number   17
--   order_number_cycle             next_number 20 (configured 2026-07-21 15:51Z)
--   orders_display_number_seq      last_value 19, is_called true  -- retired, untouched
--   finance_payment_requests       0 rows  -> no denormalized order_number copy
--                                  anywhere refers to '17'
--   payment_proof_attachments      0 rows
--   notifications (order/finance)  1 row, entity_id -> an order_request uuid;
--                                  notifications key on entity_id (uuid), never
--                                  on Order number text
--
-- Why the normalization of '17' -> '0017' is safe, checked rather than assumed:
--
--   * It is a pure re-FORMATTING of the same numeric identity, not a renumber.
--     The Order keeps its uuid, its status, its provenance, and every link.
--   * No foreign key anywhere references orders.display_number — every relation
--     is by uuid (orders.id). The only textual copies of an Order number live in
--     finance_payment_requests.order_number, and that table is empty.
--   * Uniqueness cannot be broken: section 1 proves no two Orders collapse onto
--     the same padded value before anything is written.
--   * Search still works. Every Order-number search in the application is
--     `display_number ilike '%q%'`, so '17' continues to match '0017' and '0017'
--     matches too.
--   * Sorting improves. Every list orders by the text column; with fixed-width
--     zero-padded values, lexical order finally equals numeric order (today
--     '9' sorts after '17', which is wrong).
--
-- Scope discipline: this migration changes the FORMAT of Confirmed Order numbers
-- and nothing else. It does not renumber any Order, does not touch Order Request
-- numbering, does not reset/drop/restart/advance any sequence, does not change
-- Order statuses, does not alter a single RLS policy, and does not add or remove
-- any delete path.

-- ── 1. Preflight — refuse to run on data this migration cannot safely convert ─
--
-- The normalization below is only safe under conditions that were true at
-- inspection time. Asserting them here means that if the data has moved since,
-- the migration ABORTS with a precise reason instead of silently corrupting or
-- half-converting the numbering. Deliberately not wrapped in an exception
-- handler: an unexpected state must surface.

do $$
declare
  v_non_numeric  bigint;
  v_out_of_range bigint;
  v_collisions   bigint;
begin
  select count(*) into v_non_numeric
  from public.orders
  where display_number !~ '^[0-9]+$';

  if v_non_numeric > 0 then
    raise exception
      'Cannot enforce four-digit Order numbers: % Order(s) have a non-numeric display_number. Resolve them before applying this migration.',
      v_non_numeric;
  end if;

  select count(*) into v_out_of_range
  from public.orders
  where display_number::bigint < 1
     or display_number::bigint > 9999;

  if v_out_of_range > 0 then
    raise exception
      'Cannot enforce four-digit Order numbers: % Order(s) fall outside the 1-9999 range.',
      v_out_of_range;
  end if;

  -- Two different stored values can collapse onto one padded value (e.g. '17'
  -- and '017'). That would violate orders_display_number_key mid-UPDATE, so it
  -- is caught here with an explanation rather than as a raw unique violation.
  select count(*) into v_collisions
  from (
    select lpad(display_number, 4, '0') as padded
    from public.orders
    group by 1
    having count(*) > 1
  ) t;

  if v_collisions > 0 then
    raise exception
      'Cannot enforce four-digit Order numbers: % padded value(s) would collide across existing Orders.',
      v_collisions;
  end if;
end $$;

-- ── 2. Shared formatter ───────────────────────────────────────────────────────
--
-- One definition of "what a Confirmed Order number looks like", so the
-- allocator, the admin setter and the admin reader cannot drift apart. immutable
-- so it is usable in expressions and index-safe if that is ever wanted.
--
-- Returns null outside 1-9999 rather than producing a malformed string: callers
-- treat null as "not representable", which is exactly the exhausted-cycle case.

create or replace function public.format_confirmed_order_number(p_number bigint)
returns text
language sql
immutable
set search_path = public
as $$
  select case
           when p_number is null or p_number < 1 or p_number > 9999 then null
           else lpad(p_number::text, 4, '0')
         end;
$$;

comment on function public.format_confirmed_order_number(bigint) is
  'The canonical Confirmed Order number format: exactly four digits, 0001-9999. Returns null for values that cannot be represented.';

-- ── 3. Normalize the existing Order numbers ───────────────────────────────────
--
-- '17' -> '0017'. One row on this database; written as a set-based statement so
-- it is correct for any number of rows.
--
-- Two triggers have to stand down for exactly this one statement:
--
--   orders_protect_display_number  (20260703 section 8) forbids ANY change to
--     display_number. That guarantee is the point of the trigger and is restored
--     immediately below — this is the single sanctioned normalization, performed
--     by the migration as the table owner, not a renumbering path handed to
--     anyone. Disabling it here is preferable to teaching it an exception,
--     because an exception would live on forever in the trigger body.
--
--   orders_set_updated_at would stamp updated_at = now(). The Order's business
--     content is NOT changing, so bumping it would misreport this row as edited
--     today and would reorder every "recently updated" view. updated_at is
--     preserved deliberately.
--
-- orders_protect_source_request stays ENABLED: provenance is not being touched,
-- so it should still be enforcing during this statement.
--
-- DDL is transactional in PostgreSQL, so if anything below fails, the triggers
-- are re-enabled by the rollback along with everything else.

alter table public.orders disable trigger orders_protect_display_number;
alter table public.orders disable trigger orders_set_updated_at;

update public.orders
   set display_number = lpad(display_number, 4, '0')
 where display_number ~ '^[0-9]+$'
   and length(display_number) < 4;

alter table public.orders enable trigger orders_set_updated_at;
alter table public.orders enable trigger orders_protect_display_number;

-- ── 4. The format becomes a database guarantee ────────────────────────────────
--
-- '^[0-9]{4}$' already pins the value to exactly four digits with no sign, no
-- decimal point, no whitespace and no prefix — so 1, 17, 10000, -1, 1.5, ' 17',
-- 'ORD-0017' and '' are all rejected by the regex alone, and the upper bound
-- 9999 is implied by the width. The only four-digit string that is not a valid
-- Order number is '0000', excluded explicitly to complete the 1-9999 rule.
--
-- Validated against existing rows on creation (section 3 has already converted
-- them), so this is a real guarantee from the moment it lands, not a NOT VALID
-- promise.

alter table public.orders
  add constraint orders_display_number_four_digit
  check (display_number ~ '^[0-9]{4}$' and display_number <> '0000');

comment on constraint orders_display_number_four_digit on public.orders is
  'A Confirmed Order number is exactly four digits, 0001-9999. Leading zeros are part of the identifier, which is why the column stays text.';

-- ── 5. Allocator — same concurrency contract, four-digit output ───────────────
--
-- Replaces the 20260703 section 6 body. The serialization mechanism is
-- UNCHANGED and is the whole reason this is concurrency-safe: SELECT ... FOR
-- UPDATE on the singleton cycle row means the second of two concurrent
-- conversions blocks until the first COMMITs or ROLLs BACK, then re-reads. Two
-- conversions can never take the same number, and a conversion that fails at any
-- later step returns its number to the pool because the cycle is an ordinary
-- table row bound to the caller's transaction.
--
-- Three changes, all about format:
--
--   * the returned value is now format_confirmed_order_number(v_next)
--   * a new ORDER_NUMBER_CYCLE_EXHAUSTED failure above 9999, so exhaustion is a
--     clear, distinct error instead of a check-constraint violation
--   * the collision probe compares the PADDED value, which is what actually goes
--     into the column
--
-- Still not client-callable: EXECUTE stays revoked from every client role and it
-- is reached only through the orders_assign_display_number trigger.

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
  -- 1. Serialize on the cycle row. Transaction-scoped.
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

  -- 2. Exhaustion is its own failure, not a constraint violation. Reaching 9999
  --    is a business event that needs a human decision about the numbering
  --    scheme, so it must not surface as a cryptic check-constraint error.
  if v_next > 9999 then
    raise exception
      'ORDER_NUMBER_CYCLE_EXHAUSTED: Confirmed Order numbers are limited to 9999 and that limit has been reached'
      using errcode = 'P0001';
  end if;

  -- 3. Re-verify the business rule at allocation time, not only at save time.
  --    The regex guard keeps the cast safe even though section 4 now makes a
  --    non-numeric value impossible.
  select coalesce(max(o.display_number::bigint), 0) into v_highest
  from public.orders o
  where o.display_number ~ '^[0-9]+$';

  if v_next <= v_highest then
    raise exception
      'ORDER_NUMBER_CYCLE_BEHIND: The configured next Order number (%) is not above the highest existing Order number (%)',
      public.format_confirmed_order_number(v_next),
      public.format_confirmed_order_number(v_highest)
      using errcode = 'P0001';
  end if;

  v_number := public.format_confirmed_order_number(v_next);

  -- 4. Explicit collision check on the padded value, so the failure is a clear
  --    message rather than a raw unique violation on orders_display_number_key.
  if exists (
    select 1 from public.orders o where o.display_number = v_number
  ) then
    raise exception 'ORDER_NUMBER_IN_USE: Order number % is already in use', v_number
      using errcode = 'P0001';
  end if;

  -- 5. Advance. Rolls back with the caller's transaction, so a failed conversion
  --    never burns a number.
  update public.order_number_cycle
     set next_number = v_next + 1
   where id = true;

  return v_number;
end;
$$;

revoke execute on function public.allocate_confirmed_order_number() from public, anon, authenticated;

comment on function public.allocate_confirmed_order_number() is
  'Internal. Allocates the next Confirmed Order number as four-digit text under a FOR UPDATE lock on the singleton cycle row and advances it, within the caller transaction. Not client-callable — reached only via the orders_assign_display_number trigger.';

-- ── 6. Admin setter — same authorization, four-digit bounds ───────────────────
--
-- Replaces the 20260703 section 4 body. Authorization, locking and the
-- "> highest existing" rule are unchanged and still enforced in the database;
-- the frontend is never trusted. What is added is the 9999 ceiling and a
-- four-digit collision probe, plus display strings in the result so the UI does
-- not have to re-derive the format it just saved.
--
-- The rule remains "> highest existing numeric Order number" and NOT "> anything
-- the retired sequence ever handed out": a number that sequence burned during a
-- rolled-back test belongs to no Order and is free to use.

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
  v_number  text;
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

  -- 3. Degenerate inputs the bigint parameter type cannot catch on its own.
  --    Non-integers (25.5) and non-numerics never reach the body at all: the
  --    bigint cast rejects them at call time.
  if p_next_number is null then
    raise exception 'ORDER_NUMBER_INVALID: A next Order number is required'
      using errcode = 'P0001';
  end if;

  if p_next_number <= 0 then
    raise exception 'ORDER_NUMBER_INVALID: The next Order number must be a positive whole number'
      using errcode = 'P0001';
  end if;

  if p_next_number > 9999 then
    raise exception
      'ORDER_NUMBER_TOO_HIGH: Confirmed Order numbers are four digits, so the next Order number cannot be above 9999'
      using errcode = 'P0001';
  end if;

  -- 4. Lock the cycle row before reading it, so an admin save and a concurrent
  --    conversion cannot interleave into a lost update.
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
      public.format_confirmed_order_number(v_highest)
      using errcode = 'P0001';
  end if;

  v_number := public.format_confirmed_order_number(p_next_number);

  -- 6. Defence in depth. Unreachable while the check above dominates, but it
  --    keeps the guarantee true if a future path ever creates an Order outside
  --    the numeric range that max()::bigint would skip.
  if exists (
    select 1 from public.orders o where o.display_number = v_number
  ) then
    raise exception 'ORDER_NUMBER_IN_USE: Order number % is already in use', v_number
      using errcode = 'P0001';
  end if;

  update public.order_number_cycle
     set next_number   = p_next_number,
         configured_at = now(),
         configured_by = v_actor
   where id = true;

  return jsonb_build_object(
    'next_number',              p_next_number,
    'next_number_display',      v_number,
    'previous_next_number',     v_prev,
    'highest_existing_number',  v_highest,
    'highest_existing_display', public.format_confirmed_order_number(v_highest)
  );
end;
$$;

revoke execute on function public.set_next_confirmed_order_number(bigint) from public, anon;
grant  execute on function public.set_next_confirmed_order_number(bigint) to authenticated;

comment on function public.set_next_confirmed_order_number(bigint) is
  'Admin-only. Sets the next Confirmed Order number (1-9999). Requires the value to exceed the highest existing numeric Order number. Never modifies an existing Order.';

-- ── 7. Admin reader — carries the formatted values ────────────────────────────
--
-- Replaces the 20260703 section 5 body. Same admin gate, same single round trip,
-- same consistent snapshot; it now also returns the four-digit renderings and an
-- explicit exhausted flag, so the admin control never has to reimplement the
-- format or infer exhaustion from a bare number.
--
-- max_number is returned rather than hard-coded in the client, so the ceiling has
-- exactly one authoritative definition.

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
    'next_number',              v_next,            -- null if the cycle row is missing
    'next_number_display',      public.format_confirmed_order_number(v_next),
    'highest_existing_number',  v_highest,
    'highest_existing_display', public.format_confirmed_order_number(v_highest),
    'configured',               v_next is not null,
    'exhausted',                v_next is not null and v_next > 9999,
    'max_number',               9999
  );
end;
$$;

revoke execute on function public.get_confirmed_order_number_cycle() from public, anon;
grant  execute on function public.get_confirmed_order_number_cycle() to authenticated;

-- ── 8. What this migration deliberately does NOT do ───────────────────────────
--
--   * public.orders_display_number_seq is left entirely untouched — not reset,
--     restarted, dropped, advanced or re-owned. It stays at last_value 19,
--     is_called true. It has had no callers since 20260703 and remains retained
--     for history and rollback only.
--   * public.order_request_seq and the ORD-REQ-YYYY-NNNN scheme are untouched.
--   * public.finance_payment_request_seq is untouched.
--   * order_number_cycle.next_number keeps its bigint type and its
--     order_number_cycle_positive check. It is arithmetic state; the four-digit
--     form is produced at the point of use. Advancing past the last Order (to
--     10000) remains representable and is refused at allocation time by
--     ORDER_NUMBER_CYCLE_EXHAUSTED rather than by a constraint.
--   * No RLS policy is created, altered or dropped.
--   * No row is deleted.
