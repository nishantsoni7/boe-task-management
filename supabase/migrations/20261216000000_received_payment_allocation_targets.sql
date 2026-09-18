-- ═════════════════════════════════════════════════════════════════════════════
-- 20261216000000 — Where each Confirmed Payment on ONE LIST PAGE is allocated,
--                  complete, for a person who can already see those payments
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WHY THIS EXISTS
-- ---------------
-- The Confirmed Payments list is gaining an "Allocated Against" column: which
-- Orders and PI Drafts each payment's money has been allocated to, and how much
-- went to each. The list used to read public.finance_payment_allocations
-- directly, under the caller's RLS. Those SELECT policies (20260918000000) are
-- PER ROW: admin, finance.view_all and the payment's own submitter see every
-- allocation of a payment, but an Order or PI PARTICIPANT sees only the
-- allocations whose target they can open. For such a reader the list showed a
-- PARTIAL target list — the same defect 20261215000000 closed for Correct
-- Allocation, and the one the Phase 1 notes recorded for this list.
--
-- THE BUSINESS DECISION (owner, 2026-09-18): a signed-in user who is
-- authorized to see a confirmed payment on the Finance list may see the ACTIVE
-- allocation targets and allocated amounts of that payment. It does not grant
-- access to open the Order or the PI Draft itself.
--
-- WHAT THIS DOES
-- --------------
-- One read-only RPC, received_payment_allocation_targets(uuid[]), returning the
-- ACTIVE allocations of at most FIFTY payments (one list page) in one call —
-- never one call per row — with only the fields the list cell draws:
--
--   payment_request_id, allocation_id, target_type ('order' | 'pi_draft'),
--   target_id, target_reference, reserved_order_number, allocated_amount
--
-- and only to a caller who:
--
--   1. is authenticated                                     (auth.uid())
--   2. has Finance module entry                             (module_entry_open)
--   3. holds finance.view as an ACTIVE user (admin bypass)  (actor_has_module_permission)
--
-- and only for payments that:
--
--   4. are CONFIRMED (finance_payment_status_is_verified) — the list's own scope
--   5. the caller may already READ under the permissive SELECT policies of
--      public.finance_payment_requests (own, admin, view_all, participant, and
--      the two retired-but-readable Order Request policies). The same predicate
--      20261215000000 uses; src/lib/finance/receivedPaymentAllocationTargets
--      .test.ts pins the policy list, so a new SELECT policy cannot be added
--      without this function being revisited.
--
-- A payment that fails 4 or 5, or does not exist, simply returns no rows: the
-- list only ever asks about ids it was just shown, so silence reveals nothing,
-- and one unexpected id cannot fail the whole page.
--
-- SAFE REFERENCES ONLY
-- --------------------
--   Order     target_reference = orders.display_number (e.g. '0425').
--   PI Draft  reserved_order_number = the genuine number reserved for it, when
--             one exists; target_reference = the workbook's file name (path
--             stripped), or NULL.
--             source_order_number is NEVER returned: it is normally the number
--             of whatever older PI the workbook was copied from, and printing it
--             beside this PI would present another document's number as this
--             one's.
-- No client name, amount, status or any other Order / PI field is returned.
--
-- WHAT THIS DOES NOT DO
-- ---------------------
-- * No table, column, policy, table grant, permission action or data row is
--   created, altered or written. §3 proves the policies of both tables are
--   byte-identical before and after.
-- * It does not widen what anybody can LIST: it answers only for payments the
--   caller can already read, and never opens an Order or PI — the list decides
--   whether to draw a link by reading those records under the caller's own RLS.
-- * It is STABLE: PostgreSQL refuses INSERT/UPDATE/DELETE inside it.
--
-- SECURITY DEFINER is required: the point is to return allocations the
-- caller's own RLS would hide. It therefore performs its own actor, permission
-- and visibility checks, pins search_path, and is executable by authenticated
-- only — Supabase's default privileges would otherwise also grant anon and
-- service_role, so all three are revoked explicitly.
-- ═════════════════════════════════════════════════════════════════════════════


-- ── §0. Snapshot the policies this migration must not touch ─────────────────

create temporary table targets_policy_snapshot as
select tablename, policyname, permissive, roles::text as roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in ('finance_payment_requests', 'finance_payment_allocations');


-- ── §1. The read ─────────────────────────────────────────────────────────────

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
  v_actor    uuid := auth.uid();
  v_is_admin boolean;
  v_view_all boolean;
begin
  -- 1. Authenticated.
  if v_actor is null then
    raise exception 'ALLOCATION_TARGETS_AUTH_REQUIRED: sign in to read payment allocations.'
      using errcode = '28000';
  end if;

  -- 2. Finance module entry — the same gate the payment table's RESTRICTIVE
  --    policy applies to a Finance reader.
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

  v_is_admin := exists (select 1 from public.users u where u.id = v_actor and u.role = 'admin');
  v_view_all := coalesce(public.resolve_permission(v_actor, 'finance', 'view_all'), false);

  -- 4 + 5, set-based: the requested, confirmed payments this caller may read.
  -- Mirrors the permissive SELECT policies on public.finance_payment_requests;
  -- see the header.
  return query
  with visible as (
    select f.id
    from public.finance_payment_requests f
    where f.id = any (p_payment_request_ids)
      and public.finance_payment_status_is_verified(f.status)
      and (
        -- finance_payment_requests_own_select
        f.submitted_by = v_actor
        -- finance_payment_requests_admin_select
        or v_is_admin
        -- finance_payment_requests_view_all_select
        or v_view_all
        -- finance_payment_requests_participant_select
        or coalesce(public.can_read_payment_as_participant(f.id), false)
        -- finance_payment_requests_order_request_owner_select
        or (f.order_request_id is not null and exists (
              select 1 from public.order_requests r
              where r.id = f.order_request_id
                and (r.created_by = v_actor or r.requested_by = v_actor)))
        or (f.order_id is not null and exists (
              select 1 from public.order_requests r
              where r.converted_order_id = f.order_id
                and (r.created_by = v_actor or r.requested_by = v_actor)))
        -- finance_payment_requests_order_request_assignee_select
        or (f.order_request_id is not null and exists (
              select 1 from public.order_requests r
              where r.id = f.order_request_id
                and r.assigned_to = v_actor))
        or (f.order_id is not null and exists (
              select 1 from public.order_requests r
              where r.converted_order_id = f.order_id
                and r.assigned_to = v_actor))
      )
  )
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
  from visible v
  join public.finance_payment_allocations a on a.payment_request_id = v.id
  left join public.orders            o on o.id = a.order_id
  left join public.order_submissions s on s.id = a.order_submission_id
  where a.status = 'active'
    and (a.order_id is not null or a.order_submission_id is not null)
  order by a.payment_request_id, a.created_at, a.id;
end;
$$;

comment on function public.received_payment_allocation_targets(uuid[]) is
  'The ACTIVE allocation targets (type, id, safe reference, reserved Order number, amount) of at most 50 CONFIRMED payments, for the Confirmed Payments list''s Allocated Against column. Returns rows only to an authenticated caller with Finance module entry who holds finance.view as an active user (admin bypass), and only for payments that caller may already read under the permissive SELECT policies of finance_payment_requests; any other id returns nothing. Never returns source_order_number, client or other Order/PI fields, and grants no access to open a target. SECURITY DEFINER because a participant''s own RLS returns only part of a payment''s allocations; STABLE, so it cannot write. Changes no row, policy or permission. 20261216000000.';

revoke all on function public.received_payment_allocation_targets(uuid[]) from public;
revoke all on function public.received_payment_allocation_targets(uuid[]) from anon;
revoke all on function public.received_payment_allocation_targets(uuid[]) from service_role;
grant execute on function public.received_payment_allocation_targets(uuid[]) to authenticated;


-- ── §2. (nothing else) ──────────────────────────────────────────────────────


-- ── §3. Apply-time assertions — the migration refuses itself otherwise ──────

do $$
declare
  v_fn   oid := 'public.received_payment_allocation_targets(uuid[])'::regprocedure;
  v_proc pg_proc%rowtype;
  v_diff integer;
begin
  select * into v_proc from pg_proc where oid = v_fn;

  if not v_proc.prosecdef then
    raise exception '20261216000000: the targets read must be SECURITY DEFINER';
  end if;
  if v_proc.provolatile <> 's' then
    raise exception '20261216000000: the targets read must be STABLE so it cannot write';
  end if;
  if v_proc.proconfig is null
     or not ('search_path=public, pg_temp' = any (v_proc.proconfig)) then
    raise exception '20261216000000: the targets read must pin search_path (got %)', v_proc.proconfig;
  end if;

  -- The shape the list cell reads, and nothing more.
  if pg_get_function_result(v_fn) <>
     'TABLE(payment_request_id uuid, allocation_id uuid, target_type text, target_id uuid, target_reference text, reserved_order_number text, allocated_amount numeric)' then
    raise exception '20261216000000: unexpected result shape: %', pg_get_function_result(v_fn);
  end if;

  -- EXECUTE: authenticated only.
  if not has_function_privilege('authenticated', v_fn, 'execute') then
    raise exception '20261216000000: authenticated must be able to execute the targets read';
  end if;
  if has_function_privilege('anon', v_fn, 'execute') then
    raise exception '20261216000000: anon must NOT be able to execute the targets read';
  end if;
  if has_function_privilege('service_role', v_fn, 'execute') then
    raise exception '20261216000000: service_role must NOT be able to execute the targets read';
  end if;
  if exists (
    select 1 from aclexplode(coalesce(v_proc.proacl, acldefault('f', v_proc.proowner))) acl
    where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
  ) then
    raise exception '20261216000000: PUBLIC must NOT hold EXECUTE on the targets read';
  end if;

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

  raise notice '20261216000000: targets read installed; definer, stable, search_path pinned, EXECUTE authenticated only; RLS unchanged';
end $$;
