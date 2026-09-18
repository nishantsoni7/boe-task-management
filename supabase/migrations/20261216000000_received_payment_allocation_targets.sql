-- ═════════════════════════════════════════════════════════════════════════════
-- 20261216000000 — Where each Confirmed Payment's money has gone, and how much
--                  of it is allocated, COMPLETE, for a person who can already
--                  see that payment
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WHY THIS EXISTS
-- ---------------
-- The Confirmed Payments list shows, per payment, an "Allocated Against" cell
-- (which Orders and PI Drafts the money went to, and how much to each) and an
-- Allocation Status badge (Zero / Partial / Full / Over), and it filters, pages
-- and counts by that status.
--
-- Both used to come from the caller's own RLS. The allocation SELECT policies
-- (20260918000000) are PER ROW: admin, finance.view_all and the payment's own
-- submitter see every allocation of a payment, but an Order or PI PARTICIPANT
-- sees only the allocations whose target they can open. The security_invoker
-- projection finance_received_payments sums allocations under that same RLS,
-- so for such a reader:
--   * the list showed part of a split payment's destinations, and
--   * confirmed_allocation_status — the badge AND the server-side filter — was
--     computed from part of the ledger (e.g. "Partial" for a payment that is
--     fully allocated, or "Zero" for one allocated to records they cannot open).
-- The same defect 20261215000000 closed for Correct Allocation, and the one the
-- Phase 1 notes recorded for this list.
--
-- THE BUSINESS DECISION (owner, 2026-09-18): a signed-in user who is
-- authorized to see a confirmed payment on the Finance list may see the ACTIVE
-- allocation targets and allocated amounts of that payment, and therefore its
-- true allocation status. It does not grant access to open the Order or PI.
--
-- WHAT THIS ADDS
-- --------------
-- §1  received_payment_visible_to_actor(uuid) — INTERNAL. Whether the signed-in
--     caller may read one payment under the permissive SELECT policies of
--     public.finance_payment_requests. The ONE copy of that rule used by §3 and
--     §4. Executable by its owner only: no client role can call it.
--
-- §2  received_payment_allocation_status(numeric, numeric) — INTERNAL. The ONE
--     definition of the status, from a payment amount and its active total:
--       zero    total = 0          partial  0 < total < amount
--       full    total = amount     over     total > amount
--     Numeric, so exact. Owner-only.
--
-- §3  received_payment_allocation_targets(uuid[]) — the Allocated Against read.
--     The ACTIVE allocations of at most FIFTY payments (one list page) in one
--     call, with only: payment_request_id, allocation_id, target_type
--     ('order' | 'pi_draft'), target_id, target_reference,
--     reserved_order_number, allocated_amount. The list derives the cell AND
--     the badge from these rows, with the rule of §2 restated in exact decimals.
--
-- §4  complete_allocation_status(finance_received_payments) — a PostgREST
--     COMPUTED FIELD on the projection's row. The list selects it, and filters,
--     pages and counts by it (count: exact) in the same one query as before, so
--     the allocation-status tabs describe the complete ledger with server-side
--     paging. It reads the payment's amount and status from the BASE table by
--     id — never from the row it is handed, which a direct call could forge —
--     and returns NULL for a payment the caller may not read or that is not
--     confirmed.
--
-- §3 and §4 refuse unless the caller:
--   1. is authenticated                                     (auth.uid(), 28000)
--   2. has Finance module entry                             (module_entry_open, 42501)
--   3. holds finance.view as an ACTIVE user (admin bypass)  (actor_has_module_permission, 42501)
-- and they answer only for payments that:
--   4. are CONFIRMED (finance_payment_status_is_verified), and
--   5. the caller may already READ (§1).
--
-- SAFE REFERENCES ONLY (§3)
-- -------------------------
--   Order     target_reference = orders.display_number (e.g. '0425').
--   PI Draft  reserved_order_number = the genuine number reserved for it, when
--             one exists; target_reference = the workbook's file name (path
--             stripped), or NULL. source_order_number is NEVER returned: it is
--             normally the number of an older PI the workbook was copied from.
-- No client name, and no other Order or PI field, is returned by either.
--
-- WHAT THIS DOES NOT DO
-- ---------------------
-- * No table, column, policy, table grant, permission action or data row is
--   created, altered or written; finance_received_payments is not redefined.
--   §5 proves the policies of both tables are byte-identical before and after.
-- * It does not widen what anybody can LIST: every answer is about a payment the
--   caller can already read, and nothing opens an Order or PI.
-- * Every function is STABLE or IMMUTABLE: PostgreSQL refuses writes in them.
--
-- SECURITY DEFINER is required for §1, §3 and §4: the point is to count
-- allocations the caller's own RLS hides. Each pins search_path. §3 and §4 are
-- executable by authenticated only; §1 and §2 by nobody but their owner.
-- Supabase's default privileges would otherwise also grant anon and
-- service_role, so every role is revoked explicitly.
--
-- A NOTE FOR LATER MIGRATIONS. §4 takes the view's row type, so the view now
-- has a dependent function. `create or replace view` (how every forward
-- migration has changed it) is unaffected — the suite proves appending a column
-- still works. A `drop view` must drop §4 first and recreate it after.
--
-- ROLLBACK (not applied; for reference):
--   drop function public.complete_allocation_status(public.finance_received_payments);
--   drop function public.received_payment_allocation_targets(uuid[]);
--   drop function public.received_payment_allocation_status(numeric, numeric);
--   drop function public.received_payment_visible_to_actor(uuid);
-- ═════════════════════════════════════════════════════════════════════════════


-- ── §0. Snapshot the policies this migration must not touch ─────────────────

create temporary table targets_policy_snapshot as
select tablename, policyname, permissive, roles::text as roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in ('finance_payment_requests', 'finance_payment_allocations');


-- ── §1. Visibility: the one copy of the payment SELECT rule ─────────────────

create or replace function public.received_payment_visible_to_actor(
  p_payment_request_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_pay   public.finance_payment_requests%rowtype;
begin
  if v_actor is null or p_payment_request_id is null then
    return false;
  end if;

  select * into v_pay from public.finance_payment_requests f where f.id = p_payment_request_id;
  if not found then
    return false;
  end if;

  return coalesce(
    -- finance_payment_requests_own_select
    v_pay.submitted_by = v_actor
    -- finance_payment_requests_admin_select
    or exists (select 1 from public.users u where u.id = v_actor and u.role = 'admin')
    -- finance_payment_requests_view_all_select
    or coalesce(public.resolve_permission(v_actor, 'finance', 'view_all'), false)
    -- finance_payment_requests_participant_select
    or coalesce(public.can_read_payment_as_participant(v_pay.id), false)
    -- finance_payment_requests_order_request_owner_select
    or (v_pay.order_request_id is not null and exists (
          select 1 from public.order_requests r
          where r.id = v_pay.order_request_id
            and (r.created_by = v_actor or r.requested_by = v_actor)))
    or (v_pay.order_id is not null and exists (
          select 1 from public.order_requests r
          where r.converted_order_id = v_pay.order_id
            and (r.created_by = v_actor or r.requested_by = v_actor)))
    -- finance_payment_requests_order_request_assignee_select
    or (v_pay.order_request_id is not null and exists (
          select 1 from public.order_requests r
          where r.id = v_pay.order_request_id
            and r.assigned_to = v_actor))
    or (v_pay.order_id is not null and exists (
          select 1 from public.order_requests r
          where r.converted_order_id = v_pay.order_id
            and r.assigned_to = v_actor)),
    false);
end;
$$;

comment on function public.received_payment_visible_to_actor(uuid) is
  'INTERNAL. Whether the signed-in caller may read this payment under the permissive SELECT policies of finance_payment_requests. The one copy of that rule used by received_payment_allocation_targets and complete_allocation_status. Executable by its owner only. 20261216000000.';

revoke all on function public.received_payment_visible_to_actor(uuid) from public;
revoke all on function public.received_payment_visible_to_actor(uuid) from anon;
revoke all on function public.received_payment_visible_to_actor(uuid) from authenticated;
revoke all on function public.received_payment_visible_to_actor(uuid) from service_role;


-- ── §2. The status rule, once ───────────────────────────────────────────────

create or replace function public.received_payment_allocation_status(
  p_amount       numeric,
  p_active_total numeric
)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_amount is null                          then null
    when coalesce(p_active_total, 0) <= 0          then 'zero'
    when coalesce(p_active_total, 0) > p_amount    then 'over'
    when coalesce(p_active_total, 0) = p_amount    then 'full'
    else 'partial'
  end
$$;

comment on function public.received_payment_allocation_status(numeric, numeric) is
  'INTERNAL. zero / partial / full / over from a payment amount and its ACTIVE allocation total, in exact numeric. The one definition used by complete_allocation_status; the Confirmed Payments list restates it in exact decimals for its badge. Owner-only. 20261216000000.';

revoke all on function public.received_payment_allocation_status(numeric, numeric) from public;
revoke all on function public.received_payment_allocation_status(numeric, numeric) from anon;
revoke all on function public.received_payment_allocation_status(numeric, numeric) from authenticated;
revoke all on function public.received_payment_allocation_status(numeric, numeric) from service_role;


-- ── §3. The Allocated Against read ──────────────────────────────────────────

create or replace function public.received_payment_allocation_targets(
  p_payment_request_ids uuid[]
)
returns table (
  payment_request_id    uuid,
  allocation_id         uuid,
  target_type           text,
  target_id             uuid,
  target_reference      text,
  reserved_order_number text,
  allocated_amount      numeric
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor uuid := auth.uid();
begin
  -- 1. Authenticated.
  if v_actor is null then
    raise exception 'ALLOCATION_TARGETS_AUTH_REQUIRED: sign in to read payment allocations.'
      using errcode = '28000';
  end if;

  -- 2. Finance module entry.
  if not coalesce(public.module_entry_open('finance'), false) then
    raise exception 'ALLOCATION_TARGETS_NOT_PERMITTED: Finance access is required.'
      using errcode = '42501';
  end if;

  -- 3. finance.view, held by an ACTIVE, non-deleted user (admin bypass).
  if not coalesce(public.actor_has_module_permission('finance', 'view'), false) then
    raise exception 'ALLOCATION_TARGETS_NOT_PERMITTED: you do not have permission to view Finance payments.'
      using errcode = '42501';
  end if;

  -- One list page, and never more.
  if coalesce(cardinality(p_payment_request_ids), 0) > 50 then
    raise exception 'ALLOCATION_TARGETS_TOO_MANY: at most 50 payments may be read at once (got %).',
      cardinality(p_payment_request_ids)
      using errcode = '22023';
  end if;

  if coalesce(cardinality(p_payment_request_ids), 0) = 0 then
    return;
  end if;

  -- 4 + 5: the requested, confirmed payments this caller may read.
  return query
  select
    a.payment_request_id,
    a.id,
    case when a.order_id is not null then 'order' else 'pi_draft' end,
    coalesce(a.order_id, a.order_submission_id),
    case
      when a.order_id is not null then nullif(btrim(o.display_number), '')
      -- The workbook's FILE NAME, with any path a browser may have sent
      -- stripped. Never source_order_number; see the header.
      else nullif(btrim(regexp_replace(coalesce(s.source_workbook_name, ''), '^.*[\\/]', '')), '')
    end,
    case when a.order_id is null then nullif(btrim(s.reserved_order_number), '') end,
    a.allocated_amount
  from public.finance_payment_requests f
  join public.finance_payment_allocations a on a.payment_request_id = f.id
  left join public.orders            o on o.id = a.order_id
  left join public.order_submissions s on s.id = a.order_submission_id
  where f.id = any (p_payment_request_ids)
    and public.finance_payment_status_is_verified(f.status)
    and public.received_payment_visible_to_actor(f.id)
    and a.status = 'active'
    and (a.order_id is not null or a.order_submission_id is not null)
  order by a.payment_request_id, a.created_at, a.id;
end;
$$;

comment on function public.received_payment_allocation_targets(uuid[]) is
  'The ACTIVE allocation targets (type, id, safe reference, reserved Order number, amount) of at most 50 CONFIRMED payments, for the Confirmed Payments list''s Allocated Against cell and Allocation Status badge. Returns rows only to an authenticated caller with Finance module entry who holds finance.view as an active user (admin bypass), and only for payments that caller may already read (received_payment_visible_to_actor); any other id returns nothing. Never returns source_order_number, client or other Order/PI fields, and grants no access to open a target. SECURITY DEFINER because a participant''s own RLS returns only part of a payment''s allocations; STABLE, so it cannot write. 20261216000000.';

revoke all on function public.received_payment_allocation_targets(uuid[]) from public;
revoke all on function public.received_payment_allocation_targets(uuid[]) from anon;
revoke all on function public.received_payment_allocation_targets(uuid[]) from service_role;
grant execute on function public.received_payment_allocation_targets(uuid[]) to authenticated;


-- ── §4. The complete status, as a computed field the list filters by ────────

create or replace function public.complete_allocation_status(
  p_row public.finance_received_payments
)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_amount numeric;
  v_status text;
  v_total  numeric;
begin
  if auth.uid() is null then
    raise exception 'ALLOCATION_TARGETS_AUTH_REQUIRED: sign in to read payment allocations.'
      using errcode = '28000';
  end if;
  if not coalesce(public.module_entry_open('finance'), false) then
    raise exception 'ALLOCATION_TARGETS_NOT_PERMITTED: Finance access is required.'
      using errcode = '42501';
  end if;
  if not coalesce(public.actor_has_module_permission('finance', 'view'), false) then
    raise exception 'ALLOCATION_TARGETS_NOT_PERMITTED: you do not have permission to view Finance payments.'
      using errcode = '42501';
  end if;

  -- From the BASE table, by id. Only the id of the row handed in is trusted.
  select f.amount, f.status into v_amount, v_status
  from public.finance_payment_requests f
  where f.id = p_row.id;

  if not found
     or not public.finance_payment_status_is_verified(v_status)
     or not public.received_payment_visible_to_actor(p_row.id) then
    return null;
  end if;

  select sum(a.allocated_amount) into v_total
  from public.finance_payment_allocations a
  where a.payment_request_id = p_row.id
    and a.status = 'active';

  return public.received_payment_allocation_status(v_amount, v_total);
end;
$$;

comment on function public.complete_allocation_status(public.finance_received_payments) is
  'PostgREST computed field on finance_received_payments: zero / partial / full / over from the COMPLETE active allocation ledger of a confirmed payment the caller may already read (NULL otherwise). The Confirmed Payments list selects, filters, pages and counts by it. Same access checks as received_payment_allocation_targets; reads amount and status from finance_payment_requests by id, never from the row passed in. SECURITY DEFINER, STABLE. 20261216000000.';

revoke all on function public.complete_allocation_status(public.finance_received_payments) from public;
revoke all on function public.complete_allocation_status(public.finance_received_payments) from anon;
revoke all on function public.complete_allocation_status(public.finance_received_payments) from service_role;
grant execute on function public.complete_allocation_status(public.finance_received_payments) to authenticated;


-- ── §5. Apply-time assertions — the migration refuses itself otherwise ──────

do $$
declare
  v_fn   oid;
  v_proc pg_proc%rowtype;
  v_diff integer;
  v_name text;
begin
  -- Definer + STABLE + pinned search_path: §1, §3, §4.
  foreach v_name in array array[
    'public.received_payment_visible_to_actor(uuid)',
    'public.received_payment_allocation_targets(uuid[])',
    'public.complete_allocation_status(public.finance_received_payments)'
  ] loop
    v_fn := v_name::regprocedure;
    select * into v_proc from pg_proc where oid = v_fn;
    if not v_proc.prosecdef then
      raise exception '20261216000000: % must be SECURITY DEFINER', v_name;
    end if;
    if v_proc.provolatile <> 's' then
      raise exception '20261216000000: % must be STABLE so it cannot write', v_name;
    end if;
    if v_proc.proconfig is null
       or not ('search_path=public, pg_temp' = any (v_proc.proconfig)) then
      raise exception '20261216000000: % must pin search_path (got %)', v_name, v_proc.proconfig;
    end if;
  end loop;

  -- §2: IMMUTABLE, not definer, pinned.
  select * into v_proc from pg_proc
  where oid = 'public.received_payment_allocation_status(numeric, numeric)'::regprocedure;
  if v_proc.prosecdef or v_proc.provolatile <> 'i'
     or not ('search_path=public, pg_temp' = any (coalesce(v_proc.proconfig, '{}'))) then
    raise exception '20261216000000: the status rule must be IMMUTABLE, invoker, with a pinned search_path';
  end if;

  -- The rule itself.
  if public.received_payment_allocation_status(100, null) <> 'zero'
     or public.received_payment_allocation_status(100, 0) <> 'zero'
     or public.received_payment_allocation_status(100, 0.01) <> 'partial'
     or public.received_payment_allocation_status(750000.55, 725000.55) <> 'partial'
     or public.received_payment_allocation_status(750000.55, 750000.55) <> 'full'
     or public.received_payment_allocation_status(750000.55, 750000.56) <> 'over'
     or public.received_payment_allocation_status(null, 5) is not null then
    raise exception '20261216000000: the status rule is wrong';
  end if;

  -- The Allocated Against read returns the display fields and nothing more.
  if pg_get_function_result('public.received_payment_allocation_targets(uuid[])'::regprocedure) <>
     'TABLE(payment_request_id uuid, allocation_id uuid, target_type text, target_id uuid, target_reference text, reserved_order_number text, allocated_amount numeric)' then
    raise exception '20261216000000: unexpected result shape: %',
      pg_get_function_result('public.received_payment_allocation_targets(uuid[])'::regprocedure);
  end if;

  -- EXECUTE: §3 and §4 authenticated only; §1 and §2 nobody but the owner.
  foreach v_name in array array[
    'public.received_payment_allocation_targets(uuid[])',
    'public.complete_allocation_status(public.finance_received_payments)'
  ] loop
    v_fn := v_name::regprocedure;
    if not has_function_privilege('authenticated', v_fn, 'execute') then
      raise exception '20261216000000: authenticated must be able to execute %', v_name;
    end if;
    if has_function_privilege('anon', v_fn, 'execute') then
      raise exception '20261216000000: anon must NOT be able to execute %', v_name;
    end if;
    if has_function_privilege('service_role', v_fn, 'execute') then
      raise exception '20261216000000: service_role must NOT be able to execute %', v_name;
    end if;
  end loop;

  foreach v_name in array array[
    'public.received_payment_visible_to_actor(uuid)',
    'public.received_payment_allocation_status(numeric, numeric)'
  ] loop
    v_fn := v_name::regprocedure;
    if has_function_privilege('authenticated', v_fn, 'execute')
       or has_function_privilege('anon', v_fn, 'execute')
       or has_function_privilege('service_role', v_fn, 'execute') then
      raise exception '20261216000000: % must be executable by its owner only', v_name;
    end if;
  end loop;

  foreach v_name in array array[
    'public.received_payment_visible_to_actor(uuid)',
    'public.received_payment_allocation_status(numeric, numeric)',
    'public.received_payment_allocation_targets(uuid[])',
    'public.complete_allocation_status(public.finance_received_payments)'
  ] loop
    select * into v_proc from pg_proc where oid = v_name::regprocedure;
    if exists (
      select 1 from aclexplode(coalesce(v_proc.proacl, acldefault('f', v_proc.proowner))) acl
      where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
    ) then
      raise exception '20261216000000: PUBLIC must NOT hold EXECUTE on %', v_name;
    end if;
  end loop;

  -- The policies of both tables are exactly what they were.
  select count(*) into v_diff from (
    (select tablename, policyname, permissive, roles::text, cmd, qual, with_check
       from pg_policies
      where schemaname = 'public'
        and tablename in ('finance_payment_requests', 'finance_payment_allocations')
     except
     select * from targets_policy_snapshot)
    union all
    (select * from targets_policy_snapshot
     except
     select tablename, policyname, permissive, roles::text, cmd, qual, with_check
       from pg_policies
      where schemaname = 'public'
        and tablename in ('finance_payment_requests', 'finance_payment_allocations'))
  ) d;
  if v_diff <> 0 then
    raise exception '20261216000000: a payment or allocation RLS policy changed (% differences)', v_diff;
  end if;

  drop table pg_temp.targets_policy_snapshot;

  raise notice '20261216000000: targets read + complete status installed; definer/stable/search_path pinned; EXECUTE authenticated only (helpers owner-only); RLS unchanged';
end $$;
