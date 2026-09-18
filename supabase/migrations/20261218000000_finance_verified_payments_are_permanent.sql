-- ═══════════════════════════════════════════════════════════════════════════
-- 20261218000000 — A verified payment is permanent (test data excepted)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE OWNER'S DECISION (2026-09-18, go-live): once Finance has verified a
-- payment, nobody may permanently delete it — not even an admin. The only
-- exception is TEST data. A wrong verified payment will be corrected through
-- Void / Refund / Correction (a later phase), which keeps the record visible.
--
-- WHAT WAS POSSIBLE. 20261011000000 §3 made ANY payment, verified or not,
-- deletable by an active admin through the claim protocol
-- (begin_finance_payment_deletion → /api/finance/payments/delete →
-- finalize). The guard trigger admitted a verified row's DELETE whenever that
-- protocol was finalizing it.
--
-- WHAT CHANGES — two function bodies, one rule, both layers:
--
--   §1 finance_payment_deletable_by(payment, actor)
--      still: an active, non-deleted admin — and now, for a VERIFIED payment
--      (finance_payment_status_is_verified), only when that payment carries
--      is_test_data. begin_finance_payment_deletion() asks this function, so a
--      claim can no longer be opened on a real verified payment.
--
--   §2 finance_payment_requests_guard_approved_delete()
--      the BEFORE DELETE trigger that binds EVERY caller, including the
--      service role. The finalization exemption for a verified row now also
--      requires is_test_data. So even a claim opened before this migration, or
--      a direct service-role DELETE, cannot remove a real verified payment.
--
-- WHAT IS UNCHANGED
--   * Unverified payments (pending_approval, needs_clarification, rejected)
--     stay deletable by an admin exactly as before.
--   * The Test Data Cleanup path (in_test_data_cleanup()) is untouched: while
--     cleanup is enabled it can still remove test records; once it is
--     permanently disabled that path is inert, and nothing can delete a
--     verified payment at all.
--   * is_test_data is stamped at INSERT while cleanup is enabled and is
--     immutable afterwards (20260706000000), so it cannot be switched on to
--     make a real payment deletable.
--   * No table, column, policy, grant or permission changes. No row changes.
--
-- Bodies are the 20261011000000 bodies (compared with the live functions,
-- identical) plus the one condition each; nothing else moves.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
begin
  if to_regprocedure('public.finance_payment_deletable_by(uuid, uuid)') is null then
    raise exception 'DEPENDENCY MISSING: 20261011000000 must be applied before this migration';
  end if;
  if to_regprocedure('public.finance_payment_status_is_verified(text)') is null then
    raise exception 'DEPENDENCY MISSING: 20260918000000 must be applied before this migration';
  end if;
  if to_regprocedure('public.in_test_data_cleanup()') is null then
    raise exception 'DEPENDENCY MISSING: 20260706000000 must be applied before this migration';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'finance_payment_requests'
                    and column_name = 'is_test_data') then
    raise exception 'DEPENDENCY MISSING: finance_payment_requests.is_test_data must exist';
  end if;
end $$;


-- ── §1. Who may open a deletion claim ───────────────────────────────────────

create or replace function public.finance_payment_deletable_by(
  p_payment_id uuid,
  p_actor_id   uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.finance_payment_requests f
    join public.users u on u.id = p_actor_id
    where f.id = p_payment_id
      and u.role = 'admin'
      and u.is_active
      and coalesce(u.is_deleted, false) = false
      -- 20261218000000: a VERIFIED payment is permanent unless it is test data.
      and (not public.finance_payment_status_is_verified(f.status)
           or coalesce(f.is_test_data, false))
  )
$$;


-- ── §2. The trigger every DELETE meets ──────────────────────────────────────

create or replace function public.finance_payment_requests_guard_approved_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.in_test_data_cleanup() then
    return old;
  end if;

  -- 20261218000000: the claim protocol may remove a verified payment only when
  -- it is test data. A real verified payment is permanent history.
  if old.status in ('approved_unlinked', 'approved_linked')
     and coalesce(old.is_test_data, false)
     and public.in_finance_payment_deletion_finalization(old.id)
  then
    return old;
  end if;

  if old.status in ('approved_unlinked', 'approved_linked') then
    raise exception
      'PAYMENT_APPROVED_PERMANENT: Payment % has been approved and is permanent bank payment history',
      old.request_number
      using errcode = '42501';
  end if;

  return old;
end;
$$;


-- ── §3. Apply-time assertions — the migration refuses itself otherwise ──────

do $$
declare
  v_a text := pg_get_functiondef('public.finance_payment_deletable_by(uuid, uuid)'::regprocedure);
  v_g text := pg_get_functiondef('public.finance_payment_requests_guard_approved_delete()'::regprocedure);
begin
  if v_a not like '%finance_payment_status_is_verified(f.status)%'
     or v_a not like '%coalesce(f.is_test_data, false)%'
     or v_a not like '%u.role = ''admin''%' then
    raise exception 'ASSERTION FAILED: finance_payment_deletable_by lost a rule';
  end if;
  if v_g not like '%in_test_data_cleanup()%'
     or v_g not like '%coalesce(old.is_test_data, false)%'
     or v_g not like '%in_finance_payment_deletion_finalization(old.id)%'
     or v_g not like '%PAYMENT_APPROVED_PERMANENT%' then
    raise exception 'ASSERTION FAILED: the delete guard lost a rule';
  end if;
  -- The test-data condition must sit INSIDE the finalization exemption.
  if position('coalesce(old.is_test_data, false)' in v_g)
     > position('in_finance_payment_deletion_finalization(old.id)' in v_g) then
    raise exception 'ASSERTION FAILED: the finalization exemption does not require test data';
  end if;
  -- The guard is still bound.
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.finance_payment_requests'::regclass
                    and tgname = 'finance_payment_requests_guard_approved_delete'
                    and not tgisinternal and tgenabled <> 'D') then
    raise exception 'ASSERTION FAILED: finance_payment_requests_guard_approved_delete is not bound';
  end if;
  raise notice '20261218000000: verified payments are permanent unless test data; unverified deletion and test cleanup unchanged';
end $$;
