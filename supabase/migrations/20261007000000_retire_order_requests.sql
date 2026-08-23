-- ═════════════════════════════════════════════════════════════════════════════
-- Retiring the Order Request workflow
-- ═════════════════════════════════════════════════════════════════════════════
--
-- NOT APPLIED. Requires explicit approval before `supabase db push`.
-- Apply AFTER 20261006000000. Forward-only; no earlier migration is edited.
--
-- ── WHAT CHANGED IN THE BUSINESS ─────────────────────────────────────────────
--
-- There is now ONE pre-approval Order workflow, and it is the PI:
--
--     PI upload/import → PI Draft → submit for review → finance/payment
--     conditions → management approval → Confirmed Order
--
-- Anything not finally approved stays a PI Draft. Only an approved PI becomes a
-- Confirmed Order. The Order Request — the older path where somebody raised a
-- request that an admin later CONVERTED into an Order — is retired.
--
-- ── WHAT THIS FILE DOES, AND WHAT IT REFUSES TO DO ───────────────────────────
--
-- IT CLOSES THE WRITE PATHS. Four triggers and one dropped policy, so that no
-- caller — client, service role, direct SQL, or an old RPC somebody still holds
-- a reference to — can create an Order Request, convert one into an Order, stamp
-- request provenance onto a NEW Order, or attach a NEW payment to a request.
-- Hiding a screen is not retirement: a route that is gone from the sidebar is
-- still a POST away, and the database is the only place a rule cannot be routed
-- around.
--
-- IT DELETES NOTHING. Not one table, column, foreign key, index, row, storage
-- object or audit entry. `public.order_requests`, `order_request_activity`,
-- `order_request_attachments`, `orders.source_order_request_id`,
-- `orders.source_request_number`, `finance_payment_requests.order_request_id`
-- and `order_request_number` all stay exactly as they are, and every SELECT
-- policy on them is untouched:
--
--   * confirmed Orders created by conversion carry their provenance, and
--     20260701000000's immutability trigger already refuses to change it. An
--     Order that opens today must still open tomorrow.
--   * `finance_payment_requests.order_request_id` is a historical fact about
--     where money was parked. Nulling it would rewrite the payment trail, and
--     the canonical attribution rule (PR #49) already treats it as attributing
--     NOTHING — only `order_id` is a fallback — so such a payment reads as
--     available money that now needs a real home, which is the truth.
--   * the activity rows are audit history. Audit history is not editable by a
--     migration whose subject is a product decision.
--
-- IF THE REMAINING ORDER REQUEST DATA IS ALL TEST DATA, it is removed through
-- the existing controlled test-data cleanup protocol (20260706000000), not
-- here, and not as part of applying this file. `admin_delete_order_request` is
-- therefore left executable on purpose.
--
-- ── FINANCE PAYMENT REQUESTS ARE NOT ORDER REQUESTS ──────────────────────────
--
-- Nothing in this file touches the Finance Payment Request workflow. That is a
-- different record on a different table (`finance_payment_requests`) with a
-- different lifecycle, and it remains fully active: raising one, verifying one,
-- correcting one, allocating one and reversing an allocation all behave exactly
-- as they did. The ONE Finance thing this file constrains is naming a retired
-- Order Request as a NEW payment's target, which is a doorway into the retired
-- workflow rather than part of the Payment Request workflow itself.
--
-- ── THE SHAPE OF EVERY REFUSAL ───────────────────────────────────────────────
--
-- Each guard raises `ORDER_REQUESTS_RETIRED` with errcode P0001 and names the
-- replacement, so a caller that somehow reaches one is told what to do instead
-- rather than shown a constraint violation. No guard reads auth.uid() and none
-- exempts a role: a retirement that an admin or the service role could step
-- around would not be a retirement.

begin;

-- ═══ 1. No new Order Request may be created ═════════════════════════════════
--
-- TWO LAYERS, because they fail differently and both are wanted.
--
-- The POLICY is the PostgREST-facing layer: with the INSERT policy gone and no
-- other INSERT policy on the table, an insert from `authenticated` is refused by
-- RLS before a row is ever built. That is the layer that stops the retired
-- screen's own POST, and any hand-made copy of it.
--
-- The TRIGGER is the layer beneath it: RLS does not apply to the table owner, to
-- `service_role`, or inside a SECURITY DEFINER function — and
-- `finalize_order_request` is exactly such a function. A trigger applies to all
-- of them.

drop policy if exists "order_requests_requester_insert" on public.order_requests;

create or replace function public.order_requests_refuse_new()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception
    'ORDER_REQUESTS_RETIRED: the Order Request workflow is retired. Upload the PI and submit it as a PI Draft instead.'
    using errcode = 'P0001';
end;
$$;

comment on function public.order_requests_refuse_new() is
  'Refuses every INSERT into public.order_requests. The Order Request workflow is retired; PI Drafts are the only pre-approval Order workflow. Reads no actor and exempts no role — including the service role and any SECURITY DEFINER caller — because a retirement a privileged path could step around is not one. Existing rows are untouched and remain readable for audit.';

revoke execute on function public.order_requests_refuse_new() from public, anon, authenticated;

drop trigger if exists order_requests_refuse_new on public.order_requests;

create trigger order_requests_refuse_new
  before insert on public.order_requests
  for each row execute function public.order_requests_refuse_new();

-- ═══ 2. No Order Request may be converted into an Order ═════════════════════
--
-- The conversion is TWO writes — the request moves to `converted` and an Order
-- row is created carrying the request's id — and both are refused, in the two
-- places they happen, because either one alone would leave the other reachable.
--
-- 2a. THE REQUEST SIDE. `converted` is the only status transition blocked. Every
-- other UPDATE still applies, so `admin_delete_order_request`'s bookkeeping, the
-- test-data cleanup protocol and any future correction of a historical row keep
-- working. A row that is ALREADY converted may still be updated, unchanged: this
-- refuses the TRANSITION, never the record.

create or replace function public.order_requests_refuse_conversion()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.status = 'converted' and old.status is distinct from 'converted' then
    raise exception
      'ORDER_REQUESTS_RETIRED: an Order Request can no longer be converted into an Order. Approve the PI Draft instead.'
      using errcode = 'P0001';
  end if;

  -- The CHECK constraint on this table already ties converted_order_id to the
  -- status, so this branch is unreachable through it. It is stated anyway: the
  -- constraint could be relaxed, and a conversion that arrived by setting the
  -- id alone would otherwise pass.
  if new.converted_order_id is not null and old.converted_order_id is null then
    raise exception
      'ORDER_REQUESTS_RETIRED: an Order Request can no longer be attached to a new Order. Approve the PI Draft instead.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.order_requests_refuse_conversion() is
  'Refuses the transition of an Order Request into the converted state, and the attachment of a converted_order_id where there was none. Already-converted rows are fully editable as before: this blocks the transition, never the record, so historical provenance stays readable and correctable through its existing controlled paths.';

revoke execute on function public.order_requests_refuse_conversion() from public, anon, authenticated;

drop trigger if exists order_requests_refuse_conversion on public.order_requests;

create trigger order_requests_refuse_conversion
  before update on public.order_requests
  for each row execute function public.order_requests_refuse_conversion();

-- 2b. THE ORDER SIDE. A NEW Order may not be stamped with request provenance.
--
-- INSERT ONLY, and that is the whole point. `orders.source_order_request_id` is
-- how an existing confirmed Order records where it came from, and
-- 20260701000000's `prevent_order_source_request_change` already makes it
-- immutable once set. Every historical Order keeps its provenance and keeps
-- opening; what is refused is a NEW Order claiming to have come from a request.

create or replace function public.orders_refuse_request_provenance()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.source_order_request_id is not null or new.source_request_number is not null then
    raise exception
      'ORDER_REQUESTS_RETIRED: a new Order cannot be created from an Order Request. Approve the PI Draft instead.'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

comment on function public.orders_refuse_request_provenance() is
  'Refuses a NEW Order that carries Order Request provenance. Existing Orders are untouched — their source_order_request_id stays, stays immutable, and stays readable — so a historical confirmed Order still opens and still shows where it came from.';

revoke execute on function public.orders_refuse_request_provenance() from public, anon, authenticated;

drop trigger if exists orders_refuse_request_provenance on public.orders;

create trigger orders_refuse_request_provenance
  before insert on public.orders
  for each row execute function public.orders_refuse_request_provenance();

-- ═══ 3. No NEW payment may name an Order Request ════════════════════════════
--
-- The Finance Payment Request workflow is NOT retired and nothing here changes
-- it. What is refused is one target: attaching money to an Order Request, which
-- is a doorway into the retired workflow rather than part of Finance's own.
--
-- ESTABLISHING THE LINK IS WHAT IS REFUSED, NOT HOLDING IT. An UPDATE that
-- leaves `order_request_id` exactly as it was passes untouched, so every
-- correction, verification, allocation and status change on a historical
-- request-linked payment keeps working — including
-- `unlink_finance_payment_from_order_request`, which sets the column to NULL and
-- is deliberately left executable so that historical money can be freed and
-- allocated to a real Order or PI.

create or replace function public.finance_payment_requests_refuse_request_target()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.order_request_id is not null
     and (tg_op = 'INSERT' or new.order_request_id is distinct from old.order_request_id)
  then
    raise exception
      'ORDER_REQUESTS_RETIRED: a payment can no longer be attached to an Order Request. Attach it to a Confirmed Order or allocate it to a PI Draft.'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

comment on function public.finance_payment_requests_refuse_request_target() is
  'Refuses a payment that newly names an Order Request. Holding an existing link is untouched, so historical request-linked payments stay readable, correctable and unlinkable; only establishing a NEW one is refused. Nothing else about the Finance Payment Request workflow changes.';

revoke execute on function public.finance_payment_requests_refuse_request_target() from public, anon, authenticated;

drop trigger if exists finance_payment_requests_refuse_request_target
  on public.finance_payment_requests;

-- Named to sort AFTER finance_payment_requests_derive_target, which runs first
-- and is what would otherwise classify the row as `order_request`. PostgreSQL
-- fires BEFORE triggers in name order, and `zz_` guarantees this one sees the
-- derived value rather than only the payload.
create trigger zz_finance_payment_requests_refuse_request_target
  before insert or update on public.finance_payment_requests
  for each row execute function public.finance_payment_requests_refuse_request_target();

-- ═══ 4. The retired RPCs are no longer executable by any client ═════════════
--
-- BY NAME, ACROSS EVERY OVERLOAD. Several of these were replaced in place over
-- the phases and more than one signature survives in the catalog
-- (`convert_order_request_to_order` has two, `reject_order_request` has two).
-- Enumerating signatures here would revoke one and leave the other, which is the
-- exact gap this section exists to close — so the loop revokes every overload of
-- every named function.
--
-- REVOKE, NOT DROP. Dropping a SECURITY DEFINER function that historical
-- activity rows and comments reference gains nothing and would make a rollback a
-- restore rather than a grant. With EXECUTE revoked from `authenticated` and
-- `anon`, PostgREST refuses the call outright — and even if one were somehow
-- invoked, the triggers in sections 1–3 refuse the writes it would attempt.
--
-- WHAT IS DELIBERATELY LEFT EXECUTABLE, and why:
--
--   admin_delete_order_request                  the controlled cleanup path
--   cleanup_unfinalized_order_request           removes an abandoned draft
--   remove_unfinalized_order_request_attachment the same, one file at a time
--   admin_list_stale_order_request_drafts       a read
--   unlink_finance_payment_from_order_request   frees historical money so it can
--                                               be allocated to a real target
--
-- None of the five creates an Order Request, advances one, or converts one.
-- Removing them would strand data and money rather than retire a workflow.

do $$
declare
  v_name  text;
  v_proc  record;
  v_count int := 0;
begin
  foreach v_name in array array[
    'finalize_order_request',
    'resubmit_order_request',
    'reapply_order_request',
    'respond_to_clarification',
    'edit_order_request',
    'edit_order_request_attachments',
    'request_order_request_clarification',
    'reject_order_request',
    'convert_order_request_to_order',
    'link_finance_payment_to_order_request'
  ] loop
    for v_proc in
      select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_name
    loop
      execute format('revoke execute on function %s from public, anon, authenticated', v_proc.sig);
      v_count := v_count + 1;
    end loop;
  end loop;

  -- Not an error if a name is absent: a function this project never deployed
  -- cannot be a way in. But zero matches across ALL TEN names would mean the
  -- loop matched nothing at all, which is a typo rather than a clean schema.
  if v_count = 0 then
    raise exception
      'retirement revoked nothing: none of the ten Order Request RPCs was found in public';
  end if;
end $$;

-- ═══ 5. Apply-time assertions ═══════════════════════════════════════════════
--
-- The migration refuses itself rather than reporting a retirement it did not
-- actually perform. Every check below reads the committed catalog, not the
-- statements above.

do $$
declare
  v_missing text;
  v_count   int;
begin
  -- 5a. The four guards are attached, and each is enabled. A trigger created and
  -- then disabled is the failure mode a `create trigger` alone cannot catch.
  foreach v_missing in array array[
    'order_requests_refuse_new',
    'order_requests_refuse_conversion',
    'orders_refuse_request_provenance',
    'zz_finance_payment_requests_refuse_request_target'
  ] loop
    if not exists (
      select 1 from pg_trigger t
      where t.tgname = v_missing
        and not t.tgisinternal
        and t.tgenabled <> 'D'
    ) then
      raise exception 'the retirement guard "%" is missing or disabled', v_missing;
    end if;
  end loop;

  -- 5b. No INSERT policy remains on order_requests, for any role. With RLS on
  -- and no INSERT policy, PostgREST refuses the command outright.
  select count(*) into v_count
  from pg_policies
  where schemaname = 'public'
    and tablename = 'order_requests'
    and cmd in ('INSERT', 'ALL');

  if v_count <> 0 then
    raise exception
      'order_requests still has % INSERT-capable polic(ies); the retired workflow would remain creatable',
      v_count;
  end if;

  -- 5c. RLS is still ON. If it were off, the absence of a policy would mean the
  -- opposite of what 5b just asserted.
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'order_requests' and c.relrowsecurity
  ) then
    raise exception 'row level security must remain enabled on public.order_requests';
  end if;

  -- 5d. HISTORY IS STILL READABLE. The retirement must not have cost anybody
  -- sight of an existing record: at least one SELECT policy has to remain on
  -- each of the three Order Request tables, and on the two provenance columns'
  -- own tables.
  foreach v_missing in array array[
    'order_requests', 'order_request_activity', 'order_request_attachments'
  ] loop
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = v_missing and cmd in ('SELECT', 'ALL')
    ) then
      raise exception 'public.% lost its SELECT policies; historical records must stay readable', v_missing;
    end if;
  end loop;

  -- 5e. NOTHING WAS DELETED. Every column the historical records depend on is
  -- still there, still named the same.
  foreach v_missing in array array[
    'orders.source_order_request_id',
    'orders.source_request_number',
    'finance_payment_requests.order_request_id',
    'finance_payment_requests.order_request_number',
    'order_requests.converted_order_id',
    'order_requests.request_number'
  ] loop
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public'
        and table_name = split_part(v_missing, '.', 1)
        and column_name = split_part(v_missing, '.', 2)
    ) then
      raise exception 'public.% must not be dropped: confirmed Orders depend on it', v_missing;
    end if;
  end loop;

  -- 5f. The five cleanup and unlink paths are still executable. Revoking them
  -- would strand abandoned drafts and, worse, strand money on a retired record
  -- with no way to move it to a real one.
  foreach v_missing in array array[
    'admin_delete_order_request',
    'cleanup_unfinalized_order_request',
    'remove_unfinalized_order_request_attachment',
    'unlink_finance_payment_from_order_request'
  ] loop
    select count(*) into v_count
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = v_missing
      and has_function_privilege('authenticated', p.oid, 'execute');

    if v_count = 0 then
      raise exception
        '% must remain executable by authenticated: retiring a workflow must not strand its data', v_missing;
    end if;
  end loop;

  -- 5g. The ten retired RPCs are executable by no client role, in any overload.
  foreach v_missing in array array[
    'finalize_order_request',
    'resubmit_order_request',
    'reapply_order_request',
    'respond_to_clarification',
    'edit_order_request',
    'edit_order_request_attachments',
    'request_order_request_clarification',
    'reject_order_request',
    'convert_order_request_to_order',
    'link_finance_payment_to_order_request'
  ] loop
    select count(*) into v_count
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = v_missing
      and (has_function_privilege('authenticated', p.oid, 'execute')
           or has_function_privilege('anon', p.oid, 'execute'));

    if v_count <> 0 then
      raise exception
        '% is still executable by a client role in % overload(s); the retired workflow remains reachable',
        v_missing, v_count;
    end if;
  end loop;

  -- 5h. FINANCE PAYMENT REQUESTS ARE UNCHANGED. The four doors that make that
  -- workflow work must all still be open — this file must not have retired the
  -- wrong thing.
  foreach v_missing in array array[
    'approve_finance_payment_request',
    'allocate_payment_to_target',
    'reverse_payment_allocation',
    'link_finance_payment_to_order'
  ] loop
    select count(*) into v_count
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = v_missing
      and has_function_privilege('authenticated', p.oid, 'execute');

    if v_count = 0 then
      raise exception
        'Finance Payment Requests must remain active: % is no longer executable', v_missing;
    end if;
  end loop;
end $$;

commit;

-- ═════════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ═════════════════════════════════════════════════════════════════════════════
--
--   drop trigger if exists order_requests_refuse_new                        on public.order_requests;
--   drop trigger if exists order_requests_refuse_conversion                 on public.order_requests;
--   drop trigger if exists orders_refuse_request_provenance                 on public.orders;
--   drop trigger if exists zz_finance_payment_requests_refuse_request_target on public.finance_payment_requests;
--   drop function if exists public.order_requests_refuse_new();
--   drop function if exists public.order_requests_refuse_conversion();
--   drop function if exists public.orders_refuse_request_provenance();
--   drop function if exists public.finance_payment_requests_refuse_request_target();
--
-- then re-create `order_requests_requester_insert` from 20260710000000 §2
-- verbatim, and re-grant EXECUTE on the ten RPCs to `authenticated`.
--
-- NO DATA CHANGE NEEDS UNDOING. This file inserts, updates and deletes nothing.
