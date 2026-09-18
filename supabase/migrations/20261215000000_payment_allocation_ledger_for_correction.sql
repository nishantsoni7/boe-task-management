-- ═════════════════════════════════════════════════════════════════════════════
-- 20261215000000 — The complete allocation ledger of ONE payment, for the
--                  person authorized to correct it
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WHY THIS EXISTS
-- ---------------
-- Correct Allocation (PR #165) read public.finance_payment_allocations directly,
-- under the caller's RLS. The allocation SELECT policies (20260918000000) are
-- PER ROW: an admin or a finance.view_all holder sees every allocation, the
-- payment's submitter sees every allocation of their payment, but a PI or Order
-- PARTICIPANT sees only the allocations whose target they can open.
--
-- finance.allocate_correct does not imply finance.view_all. So a person holding
--   finance.view + finance.allocate_correct, and no view_all,
-- who can read a payment because they participate in ONE of its PIs or Orders,
-- received part of that payment's ledger — and the correction screen computed
-- the allocated total, the unallocated balance, the reversal history and the
-- customer list from that part. reverse_payment_allocation() meanwhile acts on
-- ANY allocation for an allocate_correct holder. The read boundary and the
-- write boundary did not match.
--
-- WHAT THIS DOES
-- --------------
-- One read-only RPC, payment_allocation_ledger_for_correction(uuid), returning
-- EVERY allocation of ONE payment — active and reversed — with the few fields
-- the correction screen needs, and only to a caller who:
--
--   1. is authenticated                                    (auth.uid())
--   2. has Finance module entry                            (module_entry_open)
--   3. holds finance.allocate_correct (active admin bypass) (actor_has_module_permission)
--   4. may already READ that payment under the existing payment SELECT policies
--
-- Rule 4 is the same visibility the six permissive SELECT policies on
-- public.finance_payment_requests grant (own, admin, view_all, participant, and
-- the two retired-but-readable Order Request policies). The RESTRICTIVE module
-- gate is satisfied by rule 2. An invisible payment and a missing one are
-- refused with the SAME error, so the RPC does not reveal which ids exist.
-- src/lib/finance/allocationLedgerRpc.test.ts pins the policy list, so a new
-- SELECT policy cannot be added without this function being revisited.
--
-- WHAT THIS DOES NOT DO
-- ---------------------
-- * No table, column, policy, grant on a table, permission action or data row
--   is created, altered or written. The §3 assertions prove the policies of
--   both tables are byte-identical before and after.
-- * It does not give allocate_correct holders view_all, and it does not widen
--   what anybody can list: it answers for ONE payment the caller can already
--   read, and only to a holder of the authority that can already reverse any
--   of those allocations.
-- * It is STABLE: PostgreSQL refuses INSERT/UPDATE/DELETE inside it.
--
-- SECURITY DEFINER is required: the whole point is to return allocations the
-- caller's own RLS would hide. It therefore performs its own actor, permission
-- and visibility checks, pins search_path, and is executable by authenticated
-- only — Supabase's default privileges would otherwise also grant anon and
-- service_role, so all three are revoked explicitly.
-- ═════════════════════════════════════════════════════════════════════════════


-- ── §0. Snapshot the policies this migration must not touch ─────────────────

create temporary table ledger_policy_snapshot as
select tablename, policyname, permissive, roles::text as roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in ('finance_payment_requests', 'finance_payment_allocations');


-- ── §1. The read ─────────────────────────────────────────────────────────────

create or replace function public.payment_allocation_ledger_for_correction(
  p_payment_request_id uuid
)
returns table (
  allocation_id       uuid,
  status              text,
  allocated_amount    numeric,
  order_id            uuid,
  order_submission_id uuid,
  target_reference    text,
  client_name         text,
  created_at          timestamptz,
  reversed_at         timestamptz,
  reversal_reason     text,
  reversed_by_name    text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor   uuid := auth.uid();
  v_pay     public.finance_payment_requests%rowtype;
  v_visible boolean := false;
begin
  -- 1. Authenticated.
  if v_actor is null then
    raise exception 'ALLOCATION_LEDGER_AUTH_REQUIRED: sign in to read a payment''s allocations.'
      using errcode = '28000';
  end if;

  -- 2. Finance module entry. The payment table's own RESTRICTIVE gate asks the
  --    same question; a participant without Finance entry never reaches here.
  if not coalesce(public.module_entry_open('finance'), false) then
    raise exception 'ALLOCATION_LEDGER_NOT_PERMITTED: Finance access is required to correct allocations.'
      using errcode = '42501';
  end if;

  -- 3. The correction authority itself — the same check reverse_payment_allocation()
  --    makes. finance.allocate is NOT an alternative.
  if not coalesce(public.actor_has_module_permission('finance', 'allocate_correct'), false) then
    raise exception 'ALLOCATION_LEDGER_NOT_PERMITTED: you do not have permission to correct payment allocations.'
      using errcode = '42501';
  end if;

  -- 4. The payment, and whether this caller may already read it. Mirrors the
  --    permissive SELECT policies on public.finance_payment_requests; see the
  --    header. Missing and invisible are one answer.
  select * into v_pay
  from public.finance_payment_requests f
  where f.id = p_payment_request_id;

  if found then
    v_visible :=
      -- finance_payment_requests_own_select
      v_pay.submitted_by = v_actor
      -- finance_payment_requests_admin_select
      or exists (
        select 1 from public.users u
        where u.id = v_actor and u.role = 'admin'
      )
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
              and r.assigned_to = v_actor));
  end if;

  -- v_visible stays false for a missing payment, so one test covers both.
  if not coalesce(v_visible, false) then
    raise exception 'ALLOCATION_LEDGER_PAYMENT_NOT_FOUND: payment % was not found or is not visible to you.',
      p_payment_request_id
      using errcode = 'P0002';
  end if;

  -- 5. Every allocation of THIS payment and no other. Read-only.
  return query
  select
    a.id,
    a.status,
    a.allocated_amount,
    a.order_id,
    a.order_submission_id,
    case
      when a.order_id is not null then o.display_number
      else coalesce(nullif(btrim(s.source_order_number), ''),
                    nullif(btrim(s.source_workbook_name), ''),
                    'Draft')
    end,
    coalesce(o.client_name, s.client_name),
    a.created_at,
    a.reversed_at,
    a.reversal_reason,
    ru.full_name
  from public.finance_payment_allocations a
  left join public.orders            o  on o.id  = a.order_id
  left join public.order_submissions s  on s.id  = a.order_submission_id
  left join public.users             ru on ru.id = a.reversed_by
  where a.payment_request_id = p_payment_request_id
  order by a.created_at, a.id;
end;
$$;

comment on function public.payment_allocation_ledger_for_correction(uuid) is
  'Every allocation (active and reversed) of ONE payment, for the Correct Allocation screen. Returns only to an authenticated caller with Finance module entry who holds finance.allocate_correct (active admin bypass) AND may already read that payment under the permissive SELECT policies of finance_payment_requests; a missing and an invisible payment are refused identically (P0002). SECURITY DEFINER because a participant''s own RLS returns only part of the ledger; STABLE, so it cannot write. Changes no row, policy or permission. 20261215000000.';

revoke all on function public.payment_allocation_ledger_for_correction(uuid) from public;
revoke all on function public.payment_allocation_ledger_for_correction(uuid) from anon;
revoke all on function public.payment_allocation_ledger_for_correction(uuid) from service_role;
grant execute on function public.payment_allocation_ledger_for_correction(uuid) to authenticated;


-- ── §2. (nothing else) ──────────────────────────────────────────────────────


-- ── §3. Apply-time assertions — the migration refuses itself otherwise ──────

do $$
declare
  v_fn   oid := 'public.payment_allocation_ledger_for_correction(uuid)'::regprocedure;
  v_proc pg_proc%rowtype;
  v_diff integer;
begin
  select * into v_proc from pg_proc where oid = v_fn;

  if not v_proc.prosecdef then
    raise exception '20261215000000: the ledger read must be SECURITY DEFINER';
  end if;
  if v_proc.provolatile <> 's' then
    raise exception '20261215000000: the ledger read must be STABLE so it cannot write';
  end if;
  if v_proc.proconfig is null
     or not ('search_path=public, pg_temp' = any (v_proc.proconfig)) then
    raise exception '20261215000000: the ledger read must pin search_path (got %)', v_proc.proconfig;
  end if;

  -- EXECUTE: authenticated only.
  if not has_function_privilege('authenticated', v_fn, 'execute') then
    raise exception '20261215000000: authenticated must be able to execute the ledger read';
  end if;
  if has_function_privilege('anon', v_fn, 'execute') then
    raise exception '20261215000000: anon must NOT be able to execute the ledger read';
  end if;
  if has_function_privilege('service_role', v_fn, 'execute') then
    raise exception '20261215000000: service_role must NOT be able to execute the ledger read';
  end if;
  if exists (
    select 1 from aclexplode(coalesce(v_proc.proacl, acldefault('f', v_proc.proowner))) acl
    where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
  ) then
    raise exception '20261215000000: PUBLIC must NOT hold EXECUTE on the ledger read';
  end if;

  -- The policies of both tables are exactly what they were.
  select count(*) into v_diff from (
    (select tablename, policyname, permissive, roles::text, cmd, qual, with_check
       from pg_policies
      where schemaname = 'public'
        and tablename in ('finance_payment_requests', 'finance_payment_allocations')
     except
     select * from ledger_policy_snapshot)
    union all
    (select * from ledger_policy_snapshot
     except
     select tablename, policyname, permissive, roles::text, cmd, qual, with_check
       from pg_policies
      where schemaname = 'public'
        and tablename in ('finance_payment_requests', 'finance_payment_allocations'))
  ) d;
  if v_diff <> 0 then
    raise exception '20261215000000: a payment or allocation RLS policy changed (% differences)', v_diff;
  end if;

  drop table pg_temp.ledger_policy_snapshot;

  raise notice '20261215000000: ledger read installed; definer, stable, search_path pinned, EXECUTE authenticated only; RLS unchanged';
end $$;
