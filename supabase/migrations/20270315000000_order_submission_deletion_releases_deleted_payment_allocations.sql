-- A PI whose only payment allocations are leftovers of a payment its owner
-- deleted can be deleted.
--
-- THE DEFECT
-- ----------
-- Deleting a PI Draft said "A payment is allocated to this PI" while Payment
-- Requests and Confirmed Payments were both empty. Production showed why: one
-- allocation, status 'reversed' ("payment request deleted by submitter"), whose
-- payment is pending_approval, never approved, and soft-deleted.
--
-- delete_own_payment_request (20270226000000) soft-deletes a never-approved
-- payment and REVERSES its allocations rather than erasing them. The row is
-- hidden from every reader by a restrictive SELECT policy, so the person sees no
-- payment anywhere. But the allocation still names the PI through a NO ACTION
-- foreign key, and finalize_order_submission_deletion() refuses to remove it
-- (finance_payment_allocations_guard_delete: ALLOCATION_PERMANENT). The PI could
-- never be deleted and the dialog pointed at a payment nobody could see.
--
-- THE RULE THIS ADDS, AND ITS LIMIT
-- ---------------------------------
-- An allocation that records money which was never confirmed describes nothing
-- that happened (the reasoning of 20260918000000 §8a). So while a PI is being
-- permanently deleted, and only then, its allocations that are ALL of:
--   * reversed,
--   * of a payment that is soft-deleted,
--   * of a payment that was never approved (status, approved_at/approved_by and
--     the activity trail all agree, the three tests delete_own_payment_request
--     uses),
--   * not referenced by an applied allocation intent,
-- are deleted with it. Everything else still refuses the deletion exactly as
-- before: active allocations, reversed allocations of verified payments (an
-- admin correction), correction requests, Confirmed Orders.
--
-- WHERE IT IS ENFORCED
-- --------------------
--   1. allocation_released_by_payment_deletion(uuid) is the ONE predicate. The
--      delete guard and the blocker count both call it, so what the dialog says
--      blocks and what the database refuses cannot disagree.
--   2. finance_payment_allocations_guard_delete gains one exemption: a
--      transaction-local marker PINNED TO ONE SUBMISSION ID, and only for rows
--      that satisfy the predicate. Nothing else about the guard changes; it is
--      restated here whole, with its two existing exemptions.
--   3. finalize_order_submission_deletion sets the marker, deletes exactly the
--      releasable allocations of that submission, clears it, and carries on
--      unchanged. It is restated whole from 20260914000000.
--   4. order_submission_blocking_allocations(uuid) counts what still blocks, for
--      the service role only.
--
-- A SECOND BLOCKER, FOUND BY EXECUTING THE ABOVE (rehearsal, rolled back)
-- ----------------------------------------------------------------------
-- With the allocation released, deleting the PI still failed:
-- order_pi_document_absences is ON DELETE CASCADE from order_submissions but is
-- append-only (order_document_append_only_guard), so the cascade was refused with
-- ORDER_DOCUMENT_HISTORY_IMMUTABLE. A row is written whenever a PI is sent for
-- review without a supporting document category, so every PI that was sent that
-- way and then rejected could not be deleted, though a rejected PI is a
-- deletable state. The row records a confirmation about a PI that is being
-- erased together with its workbook, items and activity; it carries no file and
-- no money. It is now erased with its PI, and only inside the purge of that PI
-- (the existing order_submission_purge_in_progress marker). The same guard
-- function serves two other tables, which stay fully immutable.
--
-- Also: a CANCELLED payment intent of a payment deleted before approval names
-- the PI through a NO ACTION foreign key and is released the same way. Anything
-- else naming the PI (pending intents, intents of rejected-but-kept payments)
-- is counted as a blocker, so the refusal comes before the storage sweep.
--
-- NOT CHANGED: order_document_submissions (and its events/files) are still
-- never deleted with a PI. They carry uploaded files whose storage objects this
-- purge does not sweep, so erasing the rows would orphan the files. A PI that
-- has them still refuses.
--
-- It creates no payment, approves nothing, and moves no money.

do $$
begin
  if to_regprocedure('public.finalize_order_submission_deletion(uuid,uuid)') is null then
    raise exception 'DEPENDENCY MISSING: 20260914000000 must be applied first';
  end if;
  if to_regprocedure('public.delete_own_payment_request(uuid)') is null then
    raise exception 'DEPENDENCY MISSING: 20270226000000 must be applied first';
  end if;
  if to_regprocedure('public.in_test_data_cleanup()') is null then
    raise exception 'DEPENDENCY MISSING: 20260705000000 must be applied first';
  end if;
end $$;

-- ── 1. The one predicate ─────────────────────────────────────────────────────
-- SECURITY DEFINER: a deleted payment is invisible to every invoker (restrictive
-- SELECT policy), so a plain lookup would find nothing.

create or replace function public.payment_deleted_before_approval(p_payment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.finance_payment_requests p
     where p.id = p_payment_id
       and p.deleted_at is not null
       and p.approved_at is null
       and p.approved_by is null
       and p.status in ('pending_approval', 'needs_clarification', 'rejected')
       and not exists (
         select 1 from public.finance_payment_request_activity_log l
          where l.payment_request_id = p.id
            and l.event_type = 'status_changed'
            and l.payload ->> 'to_status' like 'approved%'
       )
  )
$$;

comment on function public.payment_deleted_before_approval(uuid) is
  'True only for a soft-deleted payment request that was never approved: the same three tests delete_own_payment_request applies, read back.';

revoke all on function public.payment_deleted_before_approval(uuid)
  from public, anon, authenticated;

create or replace function public.allocation_released_by_payment_deletion(p_allocation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.finance_payment_allocations a
     where a.id = p_allocation_id
       and a.status = 'reversed'
       and public.payment_deleted_before_approval(a.payment_request_id)
       and not exists (
         select 1 from public.finance_payment_allocation_intents i
          where i.applied_allocation_id = a.id
       )
  )
$$;

comment on function public.allocation_released_by_payment_deletion(uuid) is
  'True only for a REVERSED allocation of a soft-deleted payment that was never approved and was never applied from an intent. The single definition of what may be erased with its PI.';

revoke all on function public.allocation_released_by_payment_deletion(uuid)
  from public, anon, authenticated;

-- ── 2. The marker, pinned to one submission ──────────────────────────────────

create or replace function public.in_pi_allocation_release(p_submission_id uuid)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select p_submission_id is not null
     and coalesce(nullif(current_setting('boe.pi_allocation_release', true), ''), '')
         = p_submission_id::text
$$;

comment on function public.in_pi_allocation_release(uuid) is
  'True only inside finalize_order_submission_deletion() for THIS submission. Transaction-local, pinned to one submission id, not settable by any client.';

revoke all on function public.in_pi_allocation_release(uuid)
  from public, anon, authenticated;

-- The shared append-only guard, with one narrow exemption: the acknowledged
-- absence of a PI that is being purged. Other tables on this function (document
-- files, document events) and every UPDATE stay refused for everyone.
create or replace function public.order_document_append_only_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' and public.in_test_data_cleanup() then return old; end if;
  if tg_op = 'DELETE'
     and tg_table_name = 'order_pi_document_absences'
     and public.order_submission_purge_in_progress((to_jsonb(old) ->> 'pi_submission_id')::uuid) then
    return old;
  end if;
  raise exception 'ORDER_DOCUMENT_HISTORY_IMMUTABLE: % rows cannot be changed or deleted', tg_table_name
    using errcode = '42501';
end;
$$;

create or replace function public.finance_payment_allocations_guard_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.in_test_data_cleanup() then
    return old;
  end if;

  if public.in_payment_allocation_release(old.payment_request_id) then
    return old;
  end if;

  -- The PI this allocation names is being permanently deleted, and the allocation
  -- is a leftover of a payment that was deleted before it was ever approved.
  if public.in_pi_allocation_release(old.order_submission_id)
     and public.allocation_released_by_payment_deletion(old.id) then
    return old;
  end if;

  raise exception
    'ALLOCATION_PERMANENT: allocation % is a financial record and cannot be deleted. Reverse it instead.',
    old.id
    using errcode = '42501';
end;
$$;

comment on function public.finance_payment_allocations_guard_delete() is
  'Refuses every deletion of an allocation, for every role including the service role. Exempt only inside an authorized Test Data Cleanup transaction, while its own eligible parent payment is being deleted, or while the PI it names is being permanently deleted and it is a reversed leftover of a never-approved deleted payment.';

-- ── 3. finalize_order_submission_deletion, restated whole ────────────────────
-- Identical to 20260914000000 except for the marked block.

create or replace function public.finalize_order_submission_deletion(
  p_submission_id uuid,
  p_claim_token   uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    uuid := public.assert_order_submission_actor();
  v_sub      public.order_submissions%rowtype;
  v_n_images int;
  v_n_items  int;
  v_n_events int;
  v_n_allocs int;
begin
  if p_claim_token is null then
    raise exception 'ORDER_SUBMISSION_DELETION_CLAIM_INVALID: a deletion claim is required'
      using errcode = 'P0001';
  end if;

  select * into v_sub
  from public.order_submissions
  where id = p_submission_id
  for update;

  if not found then
    raise exception 'ORDER_SUBMISSION_DELETE_MISSING: this PI no longer exists'
      using errcode = 'P0002';
  end if;

  if v_sub.deletion_claim_token is null
     or v_sub.deletion_claim_token <> p_claim_token then
    raise exception
      'ORDER_SUBMISSION_DELETION_CLAIM_INVALID: this deletion claim is not valid for this PI'
      using errcode = '42501';
  end if;

  if v_sub.deletion_claimed_by <> v_actor
     and not public.order_submission_deletable_by(p_submission_id, v_actor) then
    raise exception
      'ORDER_SUBMISSION_DELETE_DENIED: only the owner of this PI or an administrator can delete it'
      using errcode = '42501';
  end if;

  if not (v_sub.status = any (public.order_submission_deletable_statuses())) then
    raise exception
      'ORDER_SUBMISSION_DELETE_STATUS: a PI in this state cannot be deleted (this one is %)',
      v_sub.status
      using errcode = 'P0001';
  end if;

  perform set_config('boe.order_submission_purge_id', p_submission_id::text, true);

  -- NEW. Release the leftovers of payments that were deleted before approval.
  -- The predicate is evaluated per row by the delete guard, so a reversed
  -- allocation of a verified payment, or any active one, is neither selected
  -- nor deletable here and still refuses the final DELETE below.
  delete from public.finance_payment_allocation_intents i
   where i.order_submission_id = p_submission_id
     and i.status = 'cancelled'
     and public.payment_deleted_before_approval(i.payment_request_id);

  perform set_config('boe.pi_allocation_release', p_submission_id::text, true);
  delete from public.finance_payment_allocations a
   where a.order_submission_id = p_submission_id
     and public.allocation_released_by_payment_deletion(a.id);
  get diagnostics v_n_allocs = row_count;
  perform set_config('boe.pi_allocation_release', '', true);

  delete from public.order_submission_item_images where submission_id = p_submission_id;
  get diagnostics v_n_images = row_count;

  delete from public.order_submission_items where submission_id = p_submission_id;
  get diagnostics v_n_items = row_count;

  delete from public.order_submission_activity where submission_id = p_submission_id;
  get diagnostics v_n_events = row_count;

  delete from public.order_submissions where id = p_submission_id;

  perform set_config('boe.order_submission_purge_id', '', true);

  return jsonb_build_object(
    'deleted',       true,
    'submission_id', p_submission_id,
    'client_name',   v_sub.client_name,
    'status',        v_sub.status,
    'items',         v_n_items,
    'images',        v_n_images,
    'activity',      v_n_events,
    'allocations_released', v_n_allocs
  );
end;
$$;

-- ── 4. What still blocks, counted ────────────────────────────────────────────
-- Service role only: the route reads it before the reservation, and the answer
-- must not depend on what the person deleting the PI may see.

create or replace function public.order_submission_blocking_allocations(p_submission_id uuid)
returns table (active_count integer, reversed_count integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- active_count: money still attached (an active allocation, or a pending intent
  -- of a payment awaiting approval). reversed_count: attached once and since
  -- reversed or cancelled, but kept (a verified payment's reversal, an intent of a
  -- rejected payment that was not deleted).
  select
    ((select count(*) from public.finance_payment_allocations a
       where a.order_submission_id = p_submission_id and a.status = 'active')
     + (select count(*) from public.finance_payment_allocation_intents i
         where i.order_submission_id = p_submission_id and i.status = 'pending'))::integer,
    ((select count(*) from public.finance_payment_allocations a
       where a.order_submission_id = p_submission_id and a.status <> 'active'
         and not public.allocation_released_by_payment_deletion(a.id))
     + (select count(*) from public.finance_payment_allocation_intents i
         where i.order_submission_id = p_submission_id and i.status <> 'pending'
           and not (i.status = 'cancelled'
                    and public.payment_deleted_before_approval(i.payment_request_id))))::integer
$$;

comment on function public.order_submission_blocking_allocations(uuid) is
  'How many allocations still keep this PI from being deleted: active ones, and reversed ones that are not leftovers of a never-approved deleted payment. Counts only.';

revoke all on function public.order_submission_blocking_allocations(uuid)
  from public, anon, authenticated;
grant execute on function public.order_submission_blocking_allocations(uuid) to service_role;

-- ── Self-assertions (executed when this file is applied) ─────────────────────

do $$
declare
  v_def text;
begin
  v_def := pg_get_functiondef('public.finance_payment_allocations_guard_delete()'::regprocedure);
  if v_def not like '%in_pi_allocation_release%'
     or v_def not like '%in_payment_allocation_release%'
     or v_def not like '%in_test_data_cleanup%' then
    raise exception 'the allocation delete guard must keep both existing exemptions and add the PI one';
  end if;

  v_def := pg_get_functiondef('public.finalize_order_submission_deletion(uuid,uuid)'::regprocedure);
  if v_def not like '%allocation_released_by_payment_deletion%'
     or v_def not like '%order_submission_deletable_statuses%'
     or v_def not like '%deletion_claim_token%' then
    raise exception 'finalize_order_submission_deletion must release only predicate-approved allocations and keep its claim checks';
  end if;

  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.finance_payment_allocations'::regclass
                    and tgname = 'finance_payment_allocations_guard_delete' and tgenabled <> 'D') then
    raise exception 'the allocation delete guard trigger must stay armed';
  end if;

  v_def := pg_get_functiondef('public.order_document_append_only_guard()'::regprocedure);
  if v_def not like '%order_pi_document_absences%' or v_def not like '%order_submission_purge_in_progress%' then
    raise exception 'the append-only guard must exempt only the absences of a purged PI';
  end if;

  if has_function_privilege('authenticated', 'public.order_submission_blocking_allocations(uuid)', 'execute')
     or has_function_privilege('anon', 'public.allocation_released_by_payment_deletion(uuid)', 'execute') then
    raise exception 'the new functions must not be callable by clients';
  end if;

  -- The predicate refuses what it must, executed, not just worded: an unknown id
  -- is not releasable, and no allocation that is still active ever is.
  if public.allocation_released_by_payment_deletion('00000000-0000-0000-0000-000000000000') then
    raise exception 'an unknown allocation must not be releasable';
  end if;
  if exists (select 1 from public.finance_payment_allocations a
              where a.status = 'active'
                and public.allocation_released_by_payment_deletion(a.id)) then
    raise exception 'an active allocation must never be releasable';
  end if;
  if exists (select 1 from public.finance_payment_allocations a
              join public.finance_payment_requests p on p.id = a.payment_request_id
             where p.approved_at is not null
               and public.allocation_released_by_payment_deletion(a.id)) then
    raise exception 'an allocation of an approved payment must never be releasable';
  end if;
end $$;

-- ROLLBACK (manual): restate order_document_append_only_guard from 20270112000000,
-- drop payment_deleted_before_approval(uuid), restate finance_payment_allocations_guard_delete from
-- 20260918000000 and finalize_order_submission_deletion from 20260914000000,
-- then drop order_submission_blocking_allocations(uuid),
-- in_pi_allocation_release(uuid) and allocation_released_by_payment_deletion(uuid).
