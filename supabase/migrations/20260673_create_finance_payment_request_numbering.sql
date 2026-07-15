-- Finance - Payment Request numbering (Phase 2A).
--
-- Format: PAY-REQ-YYYY-NNNN (e.g. PAY-REQ-2026-0001), permanent and immutable
-- once assigned. This is a dedicated numbering mechanism for
-- finance_payment_requests - it does NOT reuse orders_display_number_seq or
-- next_order_display_number(), which remain exclusively for public.orders.
--
-- Concurrency: finance_payment_request_seq holds one row per year. Assigning
-- a number does an INSERT ... ON CONFLICT (year) DO UPDATE ... RETURNING,
-- which takes a row lock on that year's counter - concurrent inserts in the
-- same year serialize on that lock instead of racing, so numbers are never
-- duplicated or skipped-then-reused. Same idiom as
-- get_or_create_quotation_no() in 20260650_add_showroom_quotation_numbering.sql.
--
-- Assignment is automatic: a BEFORE INSERT trigger stamps request_number
-- using the row's created_at year, so callers never need to reserve a number
-- explicitly (unlike orders, which needs a client-side RPC call before insert).
-- The trigger always overwrites request_number, so a caller can never supply
-- their own value on insert.
--
-- Immutability: a BEFORE UPDATE trigger rejects any attempt to change a
-- request_number once it has been set (backfill's null -> value transition is
-- still allowed, since that's the one-time assignment, not a change).
--
-- Access: the generator function and both trigger functions have EXECUTE
-- revoked from public/anon/authenticated. They are only reachable via the
-- triggers (which run with the function owner's privileges) or the migration
-- role itself (for backfill) - no client role can call them directly.
--
-- Nothing here touches orders, order_activity_log, payment_proof_attachments,
-- or the Requests module.

-- --- 1. Column ---

alter table public.finance_payment_requests
  add column if not exists request_number text;

-- --- 2. Per-year sequence counter table ---

create table if not exists public.finance_payment_request_seq (
  year     integer primary key,
  last_seq integer not null default 0
);

alter table public.finance_payment_request_seq enable row level security;
-- No policies: only reachable via the SECURITY DEFINER function below, whose
-- owner (the migration role) is exempt from RLS on tables it owns.

-- --- 3. Atomic number generator ---

create or replace function public.next_finance_payment_request_number(p_year integer)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seq integer;
begin
  insert into public.finance_payment_request_seq (year, last_seq)
  values (p_year, 1)
  on conflict (year) do update
    set last_seq = finance_payment_request_seq.last_seq + 1
  returning last_seq into v_seq;

  return 'PAY-REQ-' || p_year || '-' || lpad(v_seq::text, 4, '0');
end;
$$;

-- Not exposed to any client role - only the assign-on-insert trigger and the
-- backfill block below (both running as the function owner) call this.
revoke execute on function public.next_finance_payment_request_number(integer) from public, anon, authenticated;

-- --- 4. Backfill existing rows - oldest first, no duplicates ---
-- Runs before the assign-on-insert trigger exists, so it is the only writer
-- touching request_number at this point. Ordering by created_at (then id as a
-- stable tie-breaker) guarantees oldest requests receive the lowest numbers
-- within their creation year. The partial unique index added in step 7 is the
-- actual guarantee against duplicates, independent of this loop's correctness.

do $$
declare
  r record;
  v_number text;
begin
  for r in
    select id, created_at
    from public.finance_payment_requests
    where request_number is null
    order by created_at asc, id asc
  loop
    v_number := public.next_finance_payment_request_number(extract(year from r.created_at)::integer);

    update public.finance_payment_requests
      set request_number = v_number
      where id = r.id;
  end loop;
end $$;

-- --- 5. Auto-assign on creation ---
-- Always overwrites request_number with the generated value - a caller can
-- never seed their own number by including request_number in an insert.

create or replace function public.assign_finance_payment_request_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.request_number := public.next_finance_payment_request_number(extract(year from new.created_at)::integer);
  return new;
end;
$$;

revoke execute on function public.assign_finance_payment_request_number() from public, anon, authenticated;

drop trigger if exists finance_payment_requests_assign_number on public.finance_payment_requests;

create trigger finance_payment_requests_assign_number
  before insert on public.finance_payment_requests
  for each row execute function public.assign_finance_payment_request_number();

-- --- 6. Immutability guard ---
-- Allows the one-time null -> value assignment (insert trigger, backfill) but
-- rejects any subsequent change, for every role including admin - this is a
-- database-level guarantee, not just an absence of UI to change it.

create or replace function public.prevent_finance_payment_request_number_change()
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

revoke execute on function public.prevent_finance_payment_request_number_change() from public, anon, authenticated;

drop trigger if exists finance_payment_requests_protect_number on public.finance_payment_requests;

create trigger finance_payment_requests_protect_number
  before update on public.finance_payment_requests
  for each row execute function public.prevent_finance_payment_request_number_change();

-- --- 7. Uniqueness + NOT NULL ---

create unique index if not exists finance_payment_requests_request_number_uidx
  on public.finance_payment_requests (request_number)
  where request_number is not null;

alter table public.finance_payment_requests
  alter column request_number set not null;
