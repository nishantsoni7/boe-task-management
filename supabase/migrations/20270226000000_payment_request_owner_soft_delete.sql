-- A salesperson may remove their OWN payment request, as long as it was never
-- approved.
--
-- THE RULE
-- --------
-- The submitter of a payment request in Pending, Needs Clarification or Rejected
-- (which includes the Archive tab: archive is a derived view of old rejected
-- rows, not a status) may delete it, PROVIDED the payment has never been
-- approved/confirmed. Approved or confirmed money is never deletable through
-- this path, archived or not. Nobody can delete another person's request through
-- it. The admin-only claim protocol (begin/finalize_finance_payment_deletion,
-- 20261011000000) is a different, harder action and is not touched.
--
-- WHY A SOFT DELETE
-- -----------------
-- The hard delete cascades the activity log away
-- (finance_payment_request_activity_log.payment_request_id ... ON DELETE
-- CASCADE) and releases the payment's allocations. A removal the owner does by
-- choice should leave the history intact, so this stamps deleted_at/deleted_by
-- and keeps the row, its activity log, its allocations (reversed, not erased),
-- its proofs and its ids. human_payment_id and request_number are never reused,
-- so nothing about numbering changes.
--
-- WHERE IT IS ENFORCED (all in the database; the hidden button is a courtesy)
-- ---------------------------------------------------------------------------
--   1. delete_own_payment_request(uuid) — SECURITY DEFINER. Locks the row FOR
--      UPDATE, then re-checks owner, status and approval history under the lock.
--      An approval that committed first leaves the row approved_*, so the delete
--      is refused; a delete that committed first leaves the row frozen (2).
--   2. finance_payment_requests_freeze_deleted — BEFORE UPDATE. A deleted row
--      accepts NO update from anyone (approve, reject, clarify, edit, admin
--      correction, direct PATCH). approve_finance_payment_request takes its own
--      FOR UPDATE and then writes the row, so a request deleted while the
--      approver's dialog was open fails inside the approval transaction and
--      rolls it back, allocations and all. The trigger also refuses to let a
--      deleted_at be written by anything but the RPC, so a submitter's own
--      UPDATE policy cannot be used to PATCH it in.
--   3. A RESTRICTIVE SELECT policy hides deleted rows from every reader, which
--      removes them from the list, the tab counts, search, the action queue and
--      the finance_received_payments view (security_invoker) in one place.
--   4. Allocations and intents cannot be created against a deleted payment.
--   5. The submitter's own DELETE policy is dropped (see "The bypass" below), so
--      the RPC is the ONLY way a submitter can remove a request. Without this a
--      salesperson could DELETE their own unapproved row straight through the
--      database API, which cascades the activity log away.

-- ── Columns ──────────────────────────────────────────────────────────────────

alter table public.finance_payment_requests
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references public.users(id);

alter table public.finance_payment_requests
  drop constraint if exists finance_payment_requests_deleted_pair;
alter table public.finance_payment_requests
  add constraint finance_payment_requests_deleted_pair
  check ((deleted_at is null) = (deleted_by is null));

-- ── The trail learns one event ───────────────────────────────────────────────
-- Restated as the FULL current set (20260921000000) plus the new value.

alter table public.finance_payment_request_activity_log
  drop constraint if exists finance_payment_request_activity_log_event_type_check;

alter table public.finance_payment_request_activity_log
  add constraint finance_payment_request_activity_log_event_type_check
  check (event_type in (
    'request_submitted',
    'order_linked',
    'order_unlinked',
    'order_link_changed',
    'order_request_linked',
    'order_request_unlinked',
    'target_changed',
    'status_changed',
    'collection_details_updated',
    'cash_handover_recorded',
    'allocation_created',
    'allocation_reversed',
    'allocation_moved',
    'request_deleted'
  ));

-- ── The bypass: a submitter hard-deleting through the API ──────────────────────
-- finance_payment_requests_own_delete (20260700000000) let the submitter DELETE
-- their own unapproved row directly. The admin-only rule of 20261011000000 never
-- removed it (that migration changed the RPC protocol, not this policy). Dropped,
-- and so is its older 20260672 spelling. What remains, deliberately:
--   * finance_payment_requests_admin_delete_unapproved    (admins)
--   * finance_payment_requests_permitted_delete_unapproved (finance.delete holders)
--   * the admin claim protocol (begin/finalize_finance_payment_deletion), which is
--     SECURITY DEFINER and does not depend on any DELETE policy.
-- The finance_payment_requests_guard_approved_delete trigger still refuses every
-- caller deleting an approved payment, whatever policies exist.

drop policy if exists finance_payment_requests_own_delete on public.finance_payment_requests;
drop policy if exists finance_payment_requests_own_delete_pending on public.finance_payment_requests;

do $$
begin
  if exists (
    select 1 from pg_policy p
     where p.polrelid = 'public.finance_payment_requests'::regclass
       and p.polcmd in ('d', '*')
       and p.polname not in ('finance_payment_requests_admin_delete_unapproved',
                             'finance_payment_requests_permitted_delete_unapproved',
                             'finance_payment_requests_module_entry_gate')
  ) then
    raise exception 'A DELETE policy other than the admin and finance.delete ones exists on finance_payment_requests; a submitter could hard-delete through the API.';
  end if;
end $$;

-- ── 3. Deleted rows are invisible ────────────────────────────────────────────

drop policy if exists finance_payment_requests_hide_deleted on public.finance_payment_requests;
create policy finance_payment_requests_hide_deleted
  on public.finance_payment_requests
  as restrictive
  for select
  to public
  using (deleted_at is null);

-- ── 2. A deleted row is frozen ───────────────────────────────────────────────

create or replace function public.finance_payment_requests_freeze_deleted()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.deleted_at is not null then
    raise exception 'PAYMENT_REQUEST_DELETED: this payment request was deleted and can no longer be changed.'
      using errcode = '42501';
  end if;

  if new.deleted_at is not null then
    -- The one sanctioned way to set it: delete_own_payment_request, which sets
    -- this transaction-local marker to the payment's own id after it has locked
    -- and judged the row.
    if coalesce(current_setting('boe.payment_request_soft_delete', true), '') <> old.id::text then
      raise exception 'PAYMENT_DELETE_REFUSED: a payment request can only be deleted through delete_own_payment_request.'
        using errcode = '42501';
    end if;
    -- ...and it may change nothing else.
    if (to_jsonb(new) - 'deleted_at' - 'deleted_by' - 'updated_at')
       is distinct from
       (to_jsonb(old) - 'deleted_at' - 'deleted_by' - 'updated_at') then
      raise exception 'PAYMENT_DELETE_REFUSED: deleting a payment request may not change any other field.'
        using errcode = '42501';
    end if;
  elsif new.deleted_by is not null then
    raise exception 'PAYMENT_DELETE_REFUSED: deleted_by cannot be set on its own.'
      using errcode = '42501';
  end if;

  return new;
end $$;

drop trigger if exists finance_payment_requests_a_freeze_deleted on public.finance_payment_requests;
create trigger finance_payment_requests_a_freeze_deleted
  before update on public.finance_payment_requests
  for each row execute function public.finance_payment_requests_freeze_deleted();

-- ── 4. Nothing new may attach to a deleted payment ───────────────────────────
-- SECURITY DEFINER: the invoker cannot see a deleted row any more (3), so a
-- plain lookup would find nothing and let the insert through.

create or replace function public.finance_payment_children_refuse_deleted()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1 from public.finance_payment_requests p
     where p.id = new.payment_request_id and p.deleted_at is not null
  ) then
    raise exception 'PAYMENT_REQUEST_DELETED: this payment request was deleted and cannot take allocations.'
      using errcode = '42501';
  end if;
  return new;
end $$;

revoke all on function public.finance_payment_children_refuse_deleted() from public, anon, authenticated;

drop trigger if exists finance_payment_allocations_refuse_deleted on public.finance_payment_allocations;
create trigger finance_payment_allocations_refuse_deleted
  before insert on public.finance_payment_allocations
  for each row execute function public.finance_payment_children_refuse_deleted();

drop trigger if exists finance_payment_allocation_intents_refuse_deleted on public.finance_payment_allocation_intents;
create trigger finance_payment_allocation_intents_refuse_deleted
  before insert on public.finance_payment_allocation_intents
  for each row execute function public.finance_payment_children_refuse_deleted();

-- ── 1. The deletion ──────────────────────────────────────────────────────────

create or replace function public.delete_own_payment_request(p_payment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_pay   public.finance_payment_requests%rowtype;
  v_now   timestamptz;
  v_alloc record;
  v_released integer := 0;
begin
  if v_actor is null then
    raise exception 'PAYMENT_UNAUTHENTICATED: sign in to delete a payment request.' using errcode = '28000';
  end if;

  -- The lock that orders this against an approval. approve_finance_payment_request
  -- takes the same row lock before it writes, so exactly one of the two commits
  -- first and the other then sees the result.
  select * into v_pay
    from public.finance_payment_requests
   where id = p_payment_id
   for update;

  if not found then
    raise exception 'PAYMENT_NOT_FOUND: payment request not found.' using errcode = 'P0002';
  end if;

  if v_pay.submitted_by is distinct from v_actor then
    raise exception 'PAYMENT_NOT_OWNER: only the person who raised a payment request can delete it.'
      using errcode = '42501';
  end if;

  if v_pay.deleted_at is not null then
    return jsonb_build_object('payment_request_id', v_pay.id, 'deleted_at', v_pay.deleted_at, 'already_deleted', true);
  end if;

  -- Eligibility, judged on the committed row under the lock. Three independent
  -- tests so that none of them is the only thing standing between an approved
  -- payment and deletion: the status, the approval stamp, and the trail.
  if v_pay.status not in ('pending_approval', 'needs_clarification', 'rejected') then
    raise exception 'PAYMENT_APPROVED: an approved or confirmed payment cannot be deleted.'
      using errcode = '23514';
  end if;
  if v_pay.approved_at is not null or v_pay.approved_by is not null
     or exists (
       select 1 from public.finance_payment_request_activity_log l
        where l.payment_request_id = v_pay.id
          and l.event_type = 'status_changed'
          and l.payload ->> 'to_status' like 'approved%'
     ) then
    raise exception 'PAYMENT_APPROVED: a payment that was ever approved cannot be deleted.'
      using errcode = '23514';
  end if;

  -- The pending money claims go with it, kept as history: intents are cancelled,
  -- allocations are reversed (never deleted), so no PI or Order keeps counting a
  -- request that no longer exists.
  update public.finance_payment_allocation_intents
     set status = 'cancelled', cancelled_at = now(), cancelled_reason = 'payment request deleted by submitter'
   where payment_request_id = v_pay.id and status = 'pending';

  for v_alloc in
    select id from public.finance_payment_allocations
     where payment_request_id = v_pay.id and status = 'active'
     order by id
     for update
  loop
    update public.finance_payment_allocations
       set status = 'reversed', reversal_reason = 'payment request deleted by submitter'
     where id = v_alloc.id;
    v_released := v_released + 1;
  end loop;

  insert into public.finance_payment_request_activity_log (payment_request_id, actor_id, event_type, payload)
  values (v_pay.id, v_actor, 'request_deleted',
          jsonb_build_object('status_at_delete', v_pay.status, 'amount', v_pay.amount,
                             'allocations_reversed', v_released));

  perform set_config('boe.payment_request_soft_delete', v_pay.id::text, true);
  v_now := now();
  update public.finance_payment_requests
     set deleted_at = v_now, deleted_by = v_actor
   where id = v_pay.id;
  perform set_config('boe.payment_request_soft_delete', '', true);

  return jsonb_build_object('payment_request_id', v_pay.id, 'deleted_at', v_now,
                            'allocations_reversed', v_released, 'already_deleted', false);
end $$;

revoke all on function public.delete_own_payment_request(uuid) from public, anon;
grant execute on function public.delete_own_payment_request(uuid) to authenticated;
