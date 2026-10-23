-- ═══════════════════════════════════════════════════════════════════════════
-- 20270415000000 — A payment in a cash handover can no longer be edited or deleted
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE OWNER'S DECISION (2026-10-24, Phase 1 of the cash handover
-- simplification). P-AA-0044 (Paytm, ₹2,000) was handed to Nishant in H-0001
-- and accepted, yet its submitter could still change the amount or delete it:
-- the edit and delete doors read only the payment's own status, never its cash
-- journey. A handover item also stores the amount at the moment it was offered,
-- so an edit while a handover is open leaves the handover total wrong.
--
-- THE RULE. A payment is LOCKED while
--   * it is in a handover that is still open (pending, or disputed — a
--     disputed handover can still be accepted today, so its frozen amount
--     must stay true until it is cancelled), or
--   * any handover carrying it was ever ACCEPTED, or the company cash
--     custodian ever recorded receiving it directly (receive_cash_directly,
--     custody key 'receive:…').
-- A cancelled handover releases a pending lock only when no accepted transfer
-- exists. Older one-sided "handed over" activities (recorded on the form before
-- 20270413000000, with nobody accepting) do NOT lock: they were never accepted.
--
-- WHAT A LOCK REFUSES — the whole record, for every caller (admins, finance.manage
-- and direct SQL included):
--   * an UPDATE that changes any column other than the decision and system
--     columns listed in §2 (status, Finance note, approver stamps, status
--     timestamps, the two derived target columns, and — only inside
--     approve_finance_payment_request or a link/unlink between the two
--     approved states — order_id / order_number);
--   * soft deletion (deleted_at), which is a column change;
--   * DELETE.
--
-- WHAT IT DOES NOT REFUSE
--   * Verification, rejection, sending back, the admin status correction:
--     those only change decision columns, which the existing guards already
--     police (20261211000000 and friends).
--   * Allocation, reversal and custody/handover activity: they write other
--     tables, not the payment row.
--   * THE AUDITED ADMIN DELETION: begin_finance_payment_deletion →
--     finalize_finance_payment_deletion (active admin, written reason, the exact
--     Payment ID typed back, a permanent tombstone in
--     finance_payment_deletion_claims). Its transaction-local marker
--     (in_finance_payment_deletion_finalization) is honoured, exactly as the
--     approved-payment delete guard honours it.
--   * Test Data Cleanup (boe.cleanup_context = 'test_data_cleanup').
--
-- THERE IS NO ADMIN EDIT DOOR, on purpose. The existing admin edit paths
-- (edit_payment_request for an admin, the direct "Edit Received Payment" write)
-- take no reason and leave no audit row, so they are not a safe correction
-- path for money someone has accepted. A wrong locked payment is corrected by
-- the audited deletion above and recorded again.
--
-- READ DOOR: finance_payment_cash_locks(uuid[]) tells the screens which of the
-- given payments are locked and why, so Edit and Delete can be shown as
-- unavailable with the reason. It answers only for payments the caller may
-- already look at.
--
-- NOT FINANCIAL. No row changes at apply time. No historical migration, table,
-- column, policy or grant on finance_payment_requests is changed.
-- At apply time (2026-10-24 census) exactly one payment is locked: P-AA-0044.
--
-- ROLLOUT: apply BEFORE the code that calls finance_payment_cash_locks deploys
-- (the screens treat a missing function as "nothing locked", so the reverse
-- order degrades to today's behaviour with a clear refusal on save).
-- ROLLBACK (a new, later migration):
--   drop trigger if exists finance_payment_requests_lock_cash_custody on public.finance_payment_requests;
--   drop function if exists public.finance_payment_requests_lock_cash_custody();
--   drop function if exists public.finance_payment_cash_locks(uuid[]);
--   drop function if exists public.finance_payment_cash_lock(uuid);
-- ═══════════════════════════════════════════════════════════════════════════

do $$
begin
  if to_regclass('public.finance_cash_handover_items') is null
     or to_regclass('public.finance_cash_handovers') is null then
    raise exception 'DEPENDENCY MISSING: 20270410000100 (cash handovers) must be applied before this migration';
  end if;
  if to_regprocedure('public.finance_cash_payment_readable(uuid, uuid)') is null then
    raise exception 'DEPENDENCY MISSING: 20270413000000 (cash journeys) must be applied before this migration';
  end if;
  if to_regprocedure('public.in_finance_payment_deletion_finalization(uuid)') is null
     or to_regprocedure('public.in_finance_payment_verification(uuid)') is null
     or to_regprocedure('public.in_test_data_cleanup()') is null then
    raise exception 'DEPENDENCY MISSING: the payment verification, deletion and cleanup markers must exist';
  end if;
end $$;

-- ── §1. Why a payment is locked (null = it is not) ───────────────────────────
-- Internal: the trigger and the read door call it; no client role may.

create or replace function public.finance_payment_cash_lock(p_payment_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    -- An accepted transfer is permanent, so it wins over an open handover.
    (select jsonb_build_object('reason', 'accepted_transfer', 'handover', h.human_id)
       from public.finance_cash_handover_items i
       join public.finance_cash_handovers h on h.id = i.handover_id
      where i.payment_request_id = p_payment_id and h.status = 'accepted'
      order by h.accepted_at nulls last, h.created_at
      limit 1),
    (select jsonb_build_object('reason', 'accepted_transfer', 'handover', null)
       from public.finance_payment_custody_events e
      where e.payment_request_id = p_payment_id
        and e.activity_type = 'handed_over'
        and e.idempotency_key like 'receive:%'
      limit 1),
    (select jsonb_build_object('reason', 'open_handover', 'handover', h.human_id)
       from public.finance_cash_handover_items i
       join public.finance_cash_handovers h on h.id = i.handover_id
      where i.payment_request_id = p_payment_id and h.status in ('pending', 'disputed')
      order by h.created_at desc
      limit 1)
  )
$$;

revoke all on function public.finance_payment_cash_lock(uuid) from public, anon, authenticated;

comment on function public.finance_payment_cash_lock(uuid) is
  'Why a payment may no longer be edited or deleted, or null: {reason: accepted_transfer | open_handover, handover: H-NNNN | null}. Accepted = a handover carrying it was accepted, or a custodian received it directly (custody key receive:). Open = a pending or disputed handover. Cancelled handovers and one-sided legacy handed_over activities do not lock. 20270415000000.';

-- ── §2. The trigger every UPDATE and DELETE meets ────────────────────────────

create or replace function public.finance_payment_requests_lock_cash_custody()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lock    jsonb;
  v_allowed text[] := array[
    -- Finance decisions and their stamps (policed by the decision guards).
    'status', 'admin_note', 'approved_by', 'approved_at', 'updated_at',
    'rejected_at', 'clarification_requested_at',
    -- Always re-derived by finance_payment_requests_derive_target.
    'payment_target_type', 'payment_against'
  ];
  v_label   text;
begin
  v_lock := public.finance_payment_cash_lock(old.id);
  if v_lock is null then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  -- Test Data Cleanup removes test records whole, handovers included.
  if public.in_test_data_cleanup() then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  v_label := coalesce(old.human_payment_id, old.request_number, 'this payment');

  if tg_op = 'DELETE' then
    -- The audited admin deletion (reason + typed Payment ID + tombstone) only.
    if public.in_finance_payment_deletion_finalization(old.id) then
      return old;
    end if;
  else
    -- Verification may link the payment to its Order; a link/unlink between
    -- the two approved states moves the same two columns.
    if public.in_finance_payment_verification(old.id)
       or (old.status in ('approved_linked', 'approved_unlinked')
           and new.status in ('approved_linked', 'approved_unlinked')
           and new.status is distinct from old.status) then
      v_allowed := v_allowed || array['order_id', 'order_number'];
    end if;

    if (to_jsonb(new) - v_allowed) is not distinct from (to_jsonb(old) - v_allowed) then
      return new;
    end if;
  end if;

  if v_lock->>'reason' = 'accepted_transfer' then
    raise exception
      'PAYMENT_LOCKED_BY_CASH_HANDOVER: payment % was handed over and accepted%, so it can no longer be edited or deleted. If it was recorded by mistake, an administrator can delete it with a reason.',
      v_label, coalesce(' (' || (v_lock->>'handover') || ')', '')
      using errcode = '42501';
  end if;
  raise exception
    'PAYMENT_LOCKED_BY_CASH_HANDOVER: payment % is in cash handover %, which has not been accepted yet. It cannot be edited or deleted while that handover is open; the giver can cancel the handover first.',
    v_label, coalesce(v_lock->>'handover', '')
    using errcode = '42501';
end;
$$;

revoke all on function public.finance_payment_requests_lock_cash_custody() from public, anon, authenticated;

comment on function public.finance_payment_requests_lock_cash_custody() is
  'Refuses every UPDATE that changes a non-decision column, and every DELETE, of a payment locked by its cash journey (finance_payment_cash_lock), for every caller. Passes: decision/system columns; order_id/order_number inside verification or an approved link/unlink; DELETE inside finalize_finance_payment_deletion for this id; Test Data Cleanup. 20270415000000.';

-- Named to fire after finance_payment_requests_derive_target (BEFORE triggers
-- run in name order), so the derived target columns are already settled.
drop trigger if exists finance_payment_requests_lock_cash_custody on public.finance_payment_requests;
create trigger finance_payment_requests_lock_cash_custody
  before update or delete on public.finance_payment_requests
  for each row execute function public.finance_payment_requests_lock_cash_custody();

-- ── §3. The read door for the screens ────────────────────────────────────────
-- [{payment_id, reason, handover}] for the given payments that are locked and
-- that the caller may already look at; everything else is left out.

create or replace function public.finance_payment_cash_locks(p_payment_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then return '[]'::jsonb; end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object('payment_id', ids.x) || l.lock), '[]'::jsonb)
      from (select distinct x from unnest(coalesce(p_payment_ids, '{}'::uuid[])) as x
             where x is not null limit 500) ids
      cross join lateral (select public.finance_payment_cash_lock(ids.x) as lock) l
     where l.lock is not null
       and (public.finance_cash_payment_readable(ids.x, v_actor)
            or (public.module_entry_open('finance') and public.actor_has_module_permission('finance', 'manage')))
  );
end $$;

revoke all on function public.finance_payment_cash_locks(uuid[]) from public, anon;
grant execute on function public.finance_payment_cash_locks(uuid[]) to authenticated;

comment on function public.finance_payment_cash_locks(uuid[]) is
  'For the screens: which of these payments are locked by their cash journey and why ({payment_id, reason, handover}), limited to payments the caller may look at. Deciding is the trigger''s job, never this. 20270415000000.';

-- ── Apply-time assertions — the migration refuses itself otherwise ──────────

do $$
begin
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.finance_payment_requests'::regclass
                    and tgname = 'finance_payment_requests_lock_cash_custody'
                    and not tgisinternal and tgenabled <> 'D') then
    raise exception 'ASSERTION FAILED: finance_payment_requests_lock_cash_custody is not bound';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated')
     and has_function_privilege('authenticated', 'public.finance_payment_cash_lock(uuid)', 'execute') then
    raise exception 'ASSERTION FAILED: a client role may call finance_payment_cash_lock';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon')
     and has_function_privilege('anon', 'public.finance_payment_cash_locks(uuid[])', 'execute') then
    raise exception 'ASSERTION FAILED: anon may call finance_payment_cash_locks';
  end if;
  raise notice '20270415000000: payments in an open or accepted cash handover are locked against edit and delete';
end $$;
