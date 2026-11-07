-- Merge a duplicate Sales payment request into the payment already in Confirmed Payments.
--
-- WHY
-- ---
-- A payment is often recorded by the owner (or arrives from the bank) and then sent
-- again as a request by Sales. The only way out was three steps across two pages:
-- unlink the old payment from its bank credit, delete it in Confirmed Payments, then
-- verify the request. This adds the one step people mean: MERGE the request into the
-- payment that is already there.
--
-- WHAT merge_payment_request(request, into_payment, note) DOES, in ONE transaction
-- -------------------------------------------------------------------------------
--   * The old payment stays exactly as it is: same id, same amount, same status, same
--     bank link. Nothing about its money changes.
--   * What Sales asked for is applied to it, as verifying the request would have done:
--     the request's pending intents and its active allocations (a payment recorded from
--     the PI page carries an allocation, not an intent) are put on the old payment with
--     the canonical allocators, so every target is re-validated. Only when the old
--     payment has NO active allocation. When it has, the request's targets must already
--     be among them, otherwise the merge is refused (MERGE_ALLOCATED_ELSEWHERE): the same
--     money is never placed on two orders.
--   * The request's own claims are cancelled / reversed (kept as history), its active
--     bank links are undone, and its proof files move to the old payment.
--   * The request is CLOSED, not rejected: it is soft-removed with the same mechanism
--     as delete_own_payment_request (20270226000000), so it leaves every list, count and
--     view in one place, its ids are never reused, and its history stays. It is not a
--     new status, so no status set, label or total changes anywhere.
--   * Two activity events: 'request_merged' on the request and 'request_merged_in' on
--     the old payment (who sent it, who merged it, the note).
--
-- WHO AND WHEN (re-derived here under row locks; the screen only decides what to draw)
--   * finance.reconcile (the bank door) AND finance.approve: merging is a decision on
--     the request, and the comparison lives in the bank panel.
--   * Not the person who recorded the request, unless they may verify their own
--     (PAYMENT_SELF_DECISION_FORBIDDEN, as approve / reject).
--   * The request is waiting for Finance (pending_approval) and not deleted.
--   * The old payment is verified, not deleted, in the SAME HDFC account, and has the
--     EXACT same amount (to the paisa). Cash modes carry a handover trail and are not
--     merged here.
--
-- ROLLBACK: drop function public.merge_payment_request(uuid, uuid, text); and restore
-- the 14-value event_type check of 20270226000000 (only if no merge event exists yet).
-- A merge itself is not undone by SQL here: the request stays as history.

-- ── 0. What this relies on must exist ───────────────────────────────────────
do $$
begin
  if to_regprocedure('public.assert_bank_reconcile_door()') is null
     or to_regprocedure('public.unlink_bank_line_payment(uuid, text)') is null
     or to_regprocedure('public.allocate_payment_to_target_internal(uuid, uuid, uuid, numeric)') is null
     or to_regprocedure('public.allocate_payment_to_legacy_order_internal(uuid, text, text, numeric)') is null
     or to_regprocedure('public.normalize_legacy_order_no(text)') is null
     or to_regprocedure('public.finance_payment_status_is_verified(text)') is null
     or to_regprocedure('public.user_has_module_permission(uuid, text, text)') is null then
    raise exception 'this migration needs the bank door, the allocators and the payment doors to exist first';
  end if;
end $$;

-- ── 1. The trail learns two events ──────────────────────────────────────────
-- The FULL current set (20270226000000) plus the two new values.
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
    'request_deleted',
    'request_merged',
    'request_merged_in'
  ));

-- ── 2. The door ─────────────────────────────────────────────────────────────
create or replace function public.merge_payment_request(
  p_request_id      uuid,
  p_into_payment_id uuid,
  p_note            text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor    uuid;
  v_note     text := nullif(btrim(coalesce(p_note, '')), '');
  v_req      public.finance_payment_requests%rowtype;
  v_old      public.finance_payment_requests%rowtype;
  v_pi_ids   uuid[];
  v_claims   jsonb;
  v_claim    record;
  v_row      record;
  v_old_live integer;
  v_why      text;
  v_applied  integer := 0;
  v_links    integer := 0;
  v_files    integer := 0;
  v_order_id uuid;
  v_sender   text;
  v_merger   text;
  v_now      timestamptz := now();
begin
  -- 1. Who. The bank door answers for sign-in, Finance entry and finance.reconcile.
  v_actor := public.assert_bank_reconcile_door();

  if not public.actor_has_module_permission('finance', 'approve') then
    raise exception 'MERGE_FORBIDDEN: only a payment verifier may merge a payment request' using errcode = '42501';
  end if;

  if p_request_id is null or p_into_payment_id is null or p_request_id = p_into_payment_id then
    raise exception 'MERGE_SAME_PAYMENT: name two different payments' using errcode = '22023';
  end if;
  if v_note is not null and length(v_note) > 200 then
    raise exception 'MERGE_NOTE_TOO_LONG: keep the note under 200 characters' using errcode = '22023';
  end if;

  -- 2. Locks, in the project-wide order: the PI drafts the request names first (the
  --    allocators lock the PI before the payment), then both payments by id.
  select coalesce(array_agg(distinct x.sub order by x.sub), '{}'::uuid[]) into v_pi_ids
    from (
      select a.order_submission_id as sub from public.finance_payment_allocations a
       where a.payment_request_id = p_request_id and a.status = 'active' and a.order_submission_id is not null
      union
      select i.order_submission_id from public.finance_payment_allocation_intents i
       where i.payment_request_id = p_request_id and i.status = 'pending' and i.order_submission_id is not null
    ) x;
  perform 1 from public.order_submissions s where s.id = any (v_pi_ids) order by s.id for update;
  perform 1 from public.finance_payment_requests p where p.id in (p_request_id, p_into_payment_id) order by p.id for update;

  select * into v_req from public.finance_payment_requests where id = p_request_id;
  if not found or v_req.deleted_at is not null then
    raise exception 'MERGE_NOT_FOUND: the payment request was not found' using errcode = 'P0002';
  end if;
  select * into v_old from public.finance_payment_requests where id = p_into_payment_id;
  if not found or v_old.deleted_at is not null then
    raise exception 'MERGE_NOT_FOUND: the payment to merge into was not found' using errcode = 'P0002';
  end if;

  -- 3. The rules, judged on the committed rows under the locks.
  if v_req.submitted_by = v_actor
     and not public.user_has_module_permission(v_actor, 'finance', 'verify_own_payment') then
    raise exception 'PAYMENT_SELF_DECISION_FORBIDDEN: payment % was recorded by you; another payment verifier must decide it',
      v_req.request_number using errcode = '42501';
  end if;
  if v_req.status <> 'pending_approval' then
    raise exception 'MERGE_REQUEST_NOT_PENDING: only a request waiting for Finance can be merged (% is %)',
      v_req.request_number, v_req.status using errcode = 'P0001';
  end if;
  if v_req.payment_mode not in ('hdfc', 'hdfc_sec') then
    raise exception 'MERGE_NOT_BANK_ACCOUNT: only a payment received in an HDFC account is merged here' using errcode = '22023';
  end if;
  if v_old.payment_mode <> v_req.payment_mode then
    raise exception 'MERGE_ACCOUNT_DIFFERS: the two payments are in different accounts' using errcode = '22023';
  end if;
  if not public.finance_payment_status_is_verified(v_old.status) then
    raise exception 'MERGE_TARGET_NOT_VERIFIED: the payment to merge into is not verified' using errcode = 'P0001';
  end if;
  if v_old.amount <> v_req.amount then
    raise exception 'MERGE_AMOUNT_DIFFERS: the amounts differ (% and %); correct one of them first', v_req.amount, v_old.amount
      using errcode = '22023';
  end if;
  if v_old.is_test_data is distinct from v_req.is_test_data then
    raise exception 'MERGE_TEST_DATA_MISMATCH: a test payment and a real payment are never merged' using errcode = '22023';
  end if;

  v_why := 'merged into ' || coalesce(v_old.human_payment_id, v_old.request_number);

  -- 4. What Sales asked for: the request's claims, read once under the locks.
  select coalesce(jsonb_agg(to_jsonb(c) order by c.src, c.id), '[]'::jsonb) into v_claims
    from (
      select 'allocation'::text as src, a.id, a.order_submission_id, a.order_id, a.legacy_order_no,
             a.legacy_client_name, a.allocated_amount as amount
        from public.finance_payment_allocations a
       where a.payment_request_id = v_req.id and a.status = 'active'
      union all
      select 'intent'::text, i.id, i.order_submission_id, i.order_id, i.legacy_order_no,
             i.legacy_client_name, i.intended_amount
        from public.finance_payment_allocation_intents i
       where i.payment_request_id = v_req.id and i.status = 'pending'
    ) c;

  select count(*) into v_old_live from public.finance_payment_allocations a
   where a.payment_request_id = v_old.id and a.status = 'active';

  for v_claim in
    select * from jsonb_to_recordset(v_claims)
      as x(src text, id uuid, order_submission_id uuid, order_id uuid, legacy_order_no text, legacy_client_name text, amount numeric)
  loop
    if v_claim.order_submission_id is not null and not (v_claim.order_submission_id = any (v_pi_ids)) then
      raise exception 'MERGE_TRY_AGAIN: the request changed while it was being merged. Open it again.' using errcode = 'P0001';
    end if;
    if v_old_live > 0 and not exists (
         select 1 from public.finance_payment_allocations a
          where a.payment_request_id = v_old.id and a.status = 'active'
            and ((v_claim.order_submission_id is not null and a.order_submission_id = v_claim.order_submission_id)
              or (v_claim.order_id is not null and a.order_id = v_claim.order_id)
              or (v_claim.legacy_order_no is not null
                  and a.legacy_order_no = public.normalize_legacy_order_no(v_claim.legacy_order_no)))) then
      raise exception 'MERGE_ALLOCATED_ELSEWHERE: % is already allocated somewhere else than where the request asked. Correct that allocation first.',
        coalesce(v_old.human_payment_id, v_old.request_number) using errcode = 'P0001';
    end if;
  end loop;

  -- 5. The request's own claims end, as history (the shape delete_own_payment_request uses).
  update public.finance_payment_allocation_intents
     set status = 'cancelled', cancelled_at = v_now, cancelled_reason = v_why
   where payment_request_id = v_req.id and status = 'pending';

  for v_row in
    select id from public.finance_payment_allocations
     where payment_request_id = v_req.id and status = 'active'
     order by id for update
  loop
    update public.finance_payment_allocations
       set status = 'reversed', reversal_reason = v_why
     where id = v_row.id;
  end loop;

  -- 6. ...and the same claims go onto the old payment, when it has none of its own.
  if v_old_live = 0 then
    for v_claim in
      select * from jsonb_to_recordset(v_claims)
        as x(src text, id uuid, order_submission_id uuid, order_id uuid, legacy_order_no text, legacy_client_name text, amount numeric)
    loop
      if v_claim.legacy_order_no is not null then
        perform public.allocate_payment_to_legacy_order_internal(v_old.id, v_claim.legacy_order_no, v_claim.legacy_client_name, v_claim.amount);
      else
        perform public.allocate_payment_to_target_internal(v_old.id, v_claim.order_submission_id, v_claim.order_id, v_claim.amount);
        v_order_id := coalesce(v_order_id, v_claim.order_id);
      end if;
      v_applied := v_applied + 1;
    end loop;
  end if;

  -- 7. A closed request must not keep holding a bank credit, and its files go with the money.
  for v_row in
    select k.id from public.bank_line_payment_links k
     where k.payment_id = v_req.id and k.unlinked_at is null
     order by k.id
  loop
    perform public.unlink_bank_line_payment(v_row.id, 'Merged into ' || coalesce(v_old.human_payment_id, v_old.request_number));
    v_links := v_links + 1;
  end loop;

  update public.payment_proof_attachments set payment_request_id = v_old.id where payment_request_id = v_req.id;
  get diagnostics v_files = row_count;

  -- 8. Close the request: removed, not rejected. The marker is the one the freeze trigger
  --    accepts for a soft delete, set for this one row and cleared straight after.
  perform set_config('boe.payment_request_soft_delete', v_req.id::text, true);
  update public.finance_payment_requests
     set deleted_at = v_now, deleted_by = v_actor
   where id = v_req.id;
  perform set_config('boe.payment_request_soft_delete', '', true);

  -- 9. The trail, on both payments.
  select nullif(btrim(u.full_name), '') into v_sender from public.users u where u.id = v_req.submitted_by;
  select nullif(btrim(u.full_name), '') into v_merger from public.users u where u.id = v_actor;

  insert into public.finance_payment_request_activity_log (payment_request_id, actor_id, event_type, payload)
  values (v_req.id, v_actor, 'request_merged',
          jsonb_build_object('into_payment_id', v_old.id, 'into_human_id', v_old.human_payment_id,
                             'amount', v_req.amount, 'note', v_note));

  insert into public.finance_payment_request_activity_log (payment_request_id, actor_id, event_type, payload)
  values (v_old.id, v_actor, 'request_merged_in',
          jsonb_build_object('request_id', v_req.id, 'request_human_id', v_req.human_payment_id,
                             'request_number', v_req.request_number,
                             'submitted_by', v_req.submitted_by, 'submitted_by_name', v_sender,
                             'submitted_at', v_req.created_at, 'amount', v_req.amount,
                             'merged_by_name', v_merger, 'note', v_note,
                             'allocations_applied', v_applied, 'proof_files_moved', v_files,
                             'bank_links_released', v_links));

  return jsonb_build_object(
    'merged_request_id',   v_req.id,
    'request_number',      v_req.request_number,
    'request_human_id',    v_req.human_payment_id,
    'submitted_by',        v_req.submitted_by,
    'client_name',         v_req.client_name,
    'into_payment_id',     v_old.id,
    'into_human_id',       v_old.human_payment_id,
    'into_request_number', v_old.request_number,
    'allocations_applied', v_applied,
    'order_id',            v_order_id,
    'proof_files_moved',   v_files,
    'bank_links_released', v_links);
end;
$fn$;

comment on function public.merge_payment_request(uuid, uuid, text) is
  'Merges a pending HDFC payment request into the verified payment of the same account and exact amount that is already recorded: Sales'' destination is applied to the old payment (when it has none), the request''s files move across, it is closed as removed (not rejected) and both payments get an activity entry. Needs finance.reconcile and finance.approve, never on your own request. 20270608000000.';

revoke all on function public.merge_payment_request(uuid, uuid, text) from public, anon;
grant execute on function public.merge_payment_request(uuid, uuid, text) to authenticated;

-- ── 3. Self-check (executed when the migration is applied) ──────────────────
do $$
declare
  v_def text;
begin
  select pg_get_functiondef('public.merge_payment_request(uuid, uuid, text)'::regprocedure) into v_def;
  if v_def not ilike '%security definer%' or v_def not ilike '%search_path%' then
    raise exception 'merge_payment_request must be SECURITY DEFINER with a fixed search_path';
  end if;
  if has_function_privilege('anon', 'public.merge_payment_request(uuid, uuid, text)', 'execute') then
    raise exception 'merge_payment_request must not be executable by anon';
  end if;
  if not has_function_privilege('authenticated', 'public.merge_payment_request(uuid, uuid, text)', 'execute') then
    raise exception 'merge_payment_request must be executable by authenticated';
  end if;
  if position('assert_bank_reconcile_door' in v_def) = 0
     or position('PAYMENT_SELF_DECISION_FORBIDDEN' in v_def) = 0
     or position('MERGE_AMOUNT_DIFFERS' in v_def) = 0 then
    raise exception 'merge_payment_request lost one of its guards';
  end if;
  if not exists (
    select 1 from pg_constraint c
     where c.conrelid = 'public.finance_payment_request_activity_log'::regclass
       and c.conname = 'finance_payment_request_activity_log_event_type_check'
       and pg_get_constraintdef(c.oid) like '%request_merged_in%'
       and pg_get_constraintdef(c.oid) like '%request_deleted%'
  ) then
    raise exception 'the activity event check does not hold the merge events';
  end if;
end $$;
