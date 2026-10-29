-- ═════════════════════════════════════════════════════════════════════════════
-- Payments counted once, Step 1: a closed PI gives its money back, and a new PI
-- or Order can use money already received instead of recording it again
-- ═════════════════════════════════════════════════════════════════════════════
--
-- THE DEFECT (owner, 2026-10-29). A rejected PI is final and its payments stayed
-- allocated to it. Sales then made a new PI for the same client, and the only
-- control there was Add payment, which always inserts a NEW payment. The same
-- transfer was recorded twice and could be verified twice.
--
-- THE OWNER'S DECISIONS (plan "Payments counted once", v3, approved 2026-10-29):
--   * The approver's two choices are "Return to Sales" (needs_changes, unchanged
--     here) and "Close: deal lost" (rejected, final). Closing hands the PI's money
--     back to the client: every ACTIVE allocation on the PI is reversed with the
--     reason, and every PENDING allocation intent on it is cancelled. The payment
--     rows themselves are not touched, so a verified payment stays verified.
--   * Add payment first shows money already received from the same client that
--     is free to use, and "Use this money" moves it onto the PI or Order in one
--     transaction. Money from the client's closed PI needs no second Finance check.
--
-- WHAT THIS MIGRATION ADDS
--   client_name_key(text)                       letters and digits only, lower case
--   payment_amount_free_for_reuse(uuid)         amount minus active allocations,
--                                               not counting allocations on a
--                                               rejected PI (PIs closed before this
--                                               migration still hold theirs)
--   reject_order_submission(uuid, text)         restated: same checks and result,
--                                               plus the release described above
--   client_available_payments(uuid, uuid, numeric, date)
--                                               read: at most 3 payments of the
--                                               target's client, same amount, within
--                                               30 days, with money free to use
--   use_available_payment(uuid, uuid, uuid)     write: releases the payment from any
--                                               closed PI and allocates what is free
--                                               to the target
--
-- WHO MAY. The two new functions open with the SAME doors the payment forms use:
-- assert_finance_payment_door('record_pi_submission_payment', pi) for a PI (Finance
-- allocate, or the PI's submitter / creator / reviewer) and
-- assert_finance_payment_door('record_payment_with_allocations') for an Order
-- (Finance entry + allocate). The search needs an amount and a date, returns at
-- most three rows and only for the target's own client: nobody can browse.
--
-- LOCK ORDER (project-wide): target first, then the payment, then its allocations.
--
-- ROLLBACK
--   drop function public.use_available_payment(uuid, uuid, uuid);
--   drop function public.client_available_payments(uuid, uuid, numeric, date);
--   drop function public.payment_amount_free_for_reuse(uuid);
--   drop function public.client_name_key(text);
--   then re-run the reject_order_submission definition from
--   20261224000000_order_submission_approval_permanent_grant_and_auto_approval.sql.
--   Allocations already reversed stay reversed (a reversal is final by design);
--   the money they freed is ordinary unallocated money Finance can allocate.
-- ═════════════════════════════════════════════════════════════════════════════

do $$
begin
  if to_regprocedure('public.allocate_payment_to_target_internal(uuid, uuid, uuid, numeric)') is null
     or to_regprocedure('public.assert_finance_payment_door(text, uuid)') is null
     or to_regprocedure('public.assert_order_submission_actor()') is null
     or to_regprocedure('public.actor_can_approve_order()') is null
     or to_regprocedure('public.log_order_submission_activity(uuid, uuid, text, text, text, text, jsonb)') is null
     or to_regprocedure('public.finance_payment_status_is_verified(text)') is null
     or to_regclass('public.finance_payment_allocation_intents') is null then
    raise exception 'DEPENDENCY MISSING: 20261219000000, 20261224000000 and 20261013000000 must be applied before this migration';
  end if;
end $$;


-- ═══ 1. How two client names are compared ════════════════════════════════════
--
-- "Sharma Interiors", "SHARMA  INTERIORS" and "Sharma Interiors." are one client.
-- Letters and digits only, lower case. A blank name has no key and matches nothing.

create or replace function public.client_name_key(p_name text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select nullif(regexp_replace(lower(coalesce(p_name, '')), '[^[:alnum:]]+', '', 'g'), '')
$$;

revoke execute on function public.client_name_key(text) from public, anon, authenticated;


-- ═══ 2. How much of a payment is free to use ═════════════════════════════════
--
-- The payment amount minus its ACTIVE allocations and its PENDING intents (money
-- an unverified payment is already meant for: approval turns each intent into an
-- allocation, so it must stay reserved), where neither counts when it sits on a
-- rejected (closed) PI: that money is the client's again. PIs closed after this
-- migration release theirs at once (section 3); this rule covers the PIs
-- rejected before it, without rewriting their history.

create or replace function public.payment_amount_free_for_reuse(p_payment_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.amount
         - coalesce((
             select sum(a.allocated_amount)
               from public.finance_payment_allocations a
               left join public.order_submissions s on s.id = a.order_submission_id
              where a.payment_request_id = p.id
                and a.status = 'active'
                and coalesce(s.status, '') <> 'rejected'
           ), 0)
         - coalesce((
             select sum(i.intended_amount)
               from public.finance_payment_allocation_intents i
               left join public.order_submissions s on s.id = i.order_submission_id
              where i.payment_request_id = p.id
                and i.status = 'pending'
                and coalesce(s.status, '') <> 'rejected'
           ), 0)
    from public.finance_payment_requests p
   where p.id = p_payment_id
$$;

revoke execute on function public.payment_amount_free_for_reuse(uuid) from public, anon, authenticated;


-- ═══ 3. Closing a PI gives its money back ════════════════════════════════════
--
-- 20261224000000 verbatim (authority, reason, lock, state check, the one-statement
-- update, the activity row, the result shape), plus the release: every active
-- allocation on the PI is reversed with the reason, every pending intent on it is
-- cancelled. Payment rows are never written here, so a verified payment stays
-- verified and the cash-handover lock has nothing to refuse.

create or replace function public.reject_order_submission(
  p_submission_id uuid,
  p_reason        text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    uuid := public.assert_order_submission_actor();
  v_status   text;
  v_ref      text;
  v_reason   text := nullif(btrim(coalesce(p_reason, '')), '');
  v_release  text;
  v_alloc    record;
  v_released integer := 0;
  v_amount   numeric := 0;
begin
  if not public.actor_can_approve_order() then
    raise exception 'You do not have permission to review order submissions'
      using errcode = '42501';
  end if;

  if v_reason is null then
    raise exception 'ORDER_SUBMISSION_REASON_REQUIRED: say why this is being rejected'
      using errcode = 'P0001';
  end if;

  select s.status, s.draft_reference into v_status, v_ref
  from public.order_submissions s
  where s.id = p_submission_id
  for update;

  if not found then
    raise exception 'Order submission % not found', p_submission_id using errcode = 'P0002';
  end if;

  if v_status <> 'submitted' then
    raise exception
      'ORDER_SUBMISSION_NOT_UNDER_REVIEW: only a submitted record can be rejected (this one is %)', v_status
      using errcode = 'P0001';
  end if;

  update public.order_submissions
     set status      = 'rejected',
         rejected_by = v_actor,
         rejected_at = now(),
         review_note = v_reason
   where id = p_submission_id;

  -- THE MONEY GOES BACK TO THE CLIENT. Target (locked above), then each payment,
  -- then its allocation: the project-wide order.
  v_release := left(format('%s was closed (deal lost): %s', coalesce(v_ref, 'The PI'), v_reason), 500);

  for v_alloc in
    select a.id, a.payment_request_id, a.allocated_amount
      from public.finance_payment_allocations a
     where a.order_submission_id = p_submission_id
       and a.status = 'active'
     order by a.created_at, a.id
  loop
    perform 1 from public.finance_payment_requests where id = v_alloc.payment_request_id for update;
    perform 1 from public.finance_payment_allocations where id = v_alloc.id for update;

    update public.finance_payment_allocations
       set status          = 'reversed',
           reversal_reason = v_release
     where id = v_alloc.id
       and status = 'active';

    if found then
      v_released := v_released + 1;
      v_amount   := v_amount + v_alloc.allocated_amount;
    end if;
  end loop;

  update public.finance_payment_allocation_intents
     set status           = 'cancelled',
         cancelled_at     = now(),
         cancelled_reason = v_release
   where order_submission_id = p_submission_id
     and status = 'pending';

  perform public.log_order_submission_activity(
    p_submission_id, v_actor, 'rejected', 'submitted', 'rejected', v_reason,
    jsonb_build_object('payments_released', v_released, 'amount_released', v_amount)
  );

  return jsonb_build_object('id', p_submission_id, 'status', 'rejected', 'payments_released', v_released);
end;
$$;

revoke execute on function public.reject_order_submission(uuid, text) from public, anon;
grant  execute on function public.reject_order_submission(uuid, text) to authenticated;

comment on function public.reject_order_submission(uuid, text) is
  'Closes a submitted PI ("Close: deal lost"), for a caller who may approve orders. The reason is mandatory and recorded on the PI and in its history. Final: a closed PI has no transition out. Its active payment allocations are reversed with the reason and its pending allocation intents cancelled, so the money is free for the client''s next PI or Order; payment rows are not changed. 20270506000000.';


-- ═══ 4. Money already received from this client ══════════════════════════════
--
-- Exactly one target. The caller passes the door the payment forms use for that
-- target. A blank amount or date, a closed target or a target with no client
-- returns an empty list: the form simply shows no matches.

create or replace function public.client_available_payments(
  p_submission_id uuid,
  p_order_id      uuid,
  p_amount        numeric,
  p_payment_date  date
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_key    text;
  v_result jsonb;
begin
  if num_nonnulls(p_submission_id, p_order_id) <> 1 then
    raise exception 'ALLOCATION_TARGET_REQUIRED: name exactly one target — a PI or a Confirmed Order.'
      using errcode = 'P0001';
  end if;

  if p_submission_id is not null then
    perform public.assert_finance_payment_door('record_pi_submission_payment', p_submission_id);
    select public.client_name_key(s.client_name) into v_key
      from public.order_submissions s
     where s.id = p_submission_id
       and s.status in ('draft', 'submitted', 'needs_changes')
       and s.order_id is null
       and s.deletion_claim_token is null;
  else
    perform public.assert_finance_payment_door('record_payment_with_allocations');
    select public.client_name_key(o.client_name) into v_key
      from public.orders o
     where o.id = p_order_id
       and o.status <> 'cancelled';
  end if;

  if v_key is null
     or p_payment_date is null
     or p_amount is null or p_amount = 'NaN'::numeric or p_amount <= 0 then
    return '[]'::jsonb;
  end if;

  select coalesce(jsonb_agg(to_jsonb(x) - 'distance' order by x.distance, x.payment_date desc), '[]'::jsonb)
    into v_result
    from (
      select p.id                                            as payment_id,
             coalesce(p.human_payment_id, p.request_number)  as payment_number,
             p.amount,
             f.free                                          as available,
             p.payment_date,
             p.payment_mode,
             p.status,
             public.finance_payment_status_is_verified(p.status) as verified,
             (select s.draft_reference
                from public.finance_payment_allocations a
                join public.order_submissions s on s.id = a.order_submission_id
               where a.payment_request_id = p.id
                 and s.status = 'rejected'
               order by a.created_at desc
               limit 1)                                      as closed_pi_reference,
             abs(p.payment_date - p_payment_date)            as distance
        from public.finance_payment_requests p
        cross join lateral (select public.payment_amount_free_for_reuse(p.id) as free) f
       where p.deleted_at is null
         and p.status <> 'rejected'
         and public.client_name_key(p.client_name) = v_key
         and p.payment_date between p_payment_date - 30 and p_payment_date + 30
         and f.free > 0
         and (p.amount = p_amount or f.free = p_amount)
         and not exists (
           select 1 from public.finance_payment_allocations a
            where a.payment_request_id = p.id
              and a.status = 'active'
              and (a.order_submission_id = p_submission_id or a.order_id = p_order_id)
         )
       order by abs(p.payment_date - p_payment_date), p.payment_date desc
       limit 3
    ) x;

  return v_result;
end;
$$;

revoke execute on function public.client_available_payments(uuid, uuid, numeric, date) from public, anon;
grant  execute on function public.client_available_payments(uuid, uuid, numeric, date) to authenticated;

comment on function public.client_available_payments(uuid, uuid, numeric, date) is
  'Add payment, before anything is recorded: at most three payments of the target''s own client (client_name_key), same amount, payment date within 30 days, with money free to use (payment_amount_free_for_reuse > 0) and not already on this target. Same doors as the payment forms. Needs an amount and a date; returns [] otherwise. 20270506000000.';


-- ═══ 5. Use this money ═══════════════════════════════════════════════════════
--
-- Moves one payment's free money onto the target. An allocation on a closed PI
-- is reversed first ("Moved to PID-…: PID-… was closed"); then everything free is
-- allocated through allocate_payment_to_target_internal, the single place that
-- decides eligibility and capacity. The payment keeps its ID and its status.

create or replace function public.use_available_payment(
  p_payment_id    uuid,
  p_submission_id uuid,
  p_order_id      uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  uuid := public.assert_order_submission_actor();
  v_sub    public.order_submissions%rowtype;
  v_ord    public.orders%rowtype;
  v_pay    public.finance_payment_requests%rowtype;
  v_key    text;
  v_ref    text;
  v_old    record;
  v_moved  integer := 0;
  v_free   numeric;
  v_alloc  jsonb;
begin
  if num_nonnulls(p_submission_id, p_order_id) <> 1 then
    raise exception 'ALLOCATION_TARGET_REQUIRED: name exactly one target — a PI or a Confirmed Order.'
      using errcode = 'P0001';
  end if;

  -- The target first.
  if p_submission_id is not null then
    perform public.assert_finance_payment_door('record_pi_submission_payment', p_submission_id);
    select * into v_sub from public.order_submissions where id = p_submission_id for update;
    if not found then
      raise exception 'ORDER_SUBMISSION_NOT_FOUND: that PI no longer exists' using errcode = 'P0002';
    end if;
    if v_sub.deletion_claim_token is not null then
      raise exception 'ORDER_SUBMISSION_DELETION_CLAIMED: this PI is reserved for deletion and cannot receive a payment'
        using errcode = '55P03';
    end if;
    if v_sub.status = 'approved' or v_sub.order_id is not null then
      raise exception 'ORDER_SUBMISSION_CONVERTED: this PI has been approved and is now an Order. Use the money on the Order instead.'
        using errcode = 'P0001';
    end if;
    if v_sub.status = 'rejected' then
      raise exception 'ORDER_SUBMISSION_REJECTED: a closed PI cannot receive a payment.'
        using errcode = 'P0001';
    end if;
    v_key := public.client_name_key(v_sub.client_name);
    v_ref := v_sub.draft_reference;
  else
    perform public.assert_finance_payment_door('record_payment_with_allocations');
    select * into v_ord from public.orders where id = p_order_id for update;
    if not found then
      raise exception 'ORDER_NOT_FOUND: that Order no longer exists' using errcode = 'P0002';
    end if;
    if v_ord.status = 'cancelled' then
      raise exception 'ALLOCATION_TARGET_NOT_ACTIVE: Order % is cancelled and cannot receive an allocation.', v_ord.display_number
        using errcode = 'P0001';
    end if;
    v_key := public.client_name_key(v_ord.client_name);
    v_ref := 'Order ' || coalesce(ltrim(v_ord.display_number, '0'), '');
  end if;

  if v_key is null then
    raise exception 'ORDER_SUBMISSION_NO_CLIENT: this record has no client name on file, so money cannot be matched to it.'
      using errcode = 'P0001';
  end if;

  -- Then the payment.
  select * into v_pay from public.finance_payment_requests where id = p_payment_id for update;
  if not found or v_pay.deleted_at is not null then
    raise exception 'PAYMENT_NOT_FOUND: that payment no longer exists' using errcode = 'P0002';
  end if;
  if v_pay.status = 'rejected' then
    raise exception 'PAYMENT_REJECTED: payment % was rejected and cannot be used.', coalesce(v_pay.human_payment_id, v_pay.request_number)
      using errcode = 'P0001';
  end if;
  if public.client_name_key(v_pay.client_name) is distinct from v_key then
    raise exception 'PAYMENT_CLIENT_MISMATCH: payment % belongs to another client.', coalesce(v_pay.human_payment_id, v_pay.request_number)
      using errcode = '42501';
  end if;
  if exists (
    select 1 from public.finance_payment_allocations a
     where a.payment_request_id = p_payment_id
       and a.status = 'active'
       and (a.order_submission_id = p_submission_id or a.order_id = p_order_id)
  ) then
    raise exception 'ALLOCATION_DUPLICATE: payment % is already on this record.', coalesce(v_pay.human_payment_id, v_pay.request_number)
      using errcode = 'P0001';
  end if;

  -- Then its allocations: anything still on a closed PI comes off it.
  for v_old in
    select a.id, s.draft_reference
      from public.finance_payment_allocations a
      join public.order_submissions s on s.id = a.order_submission_id
     where a.payment_request_id = p_payment_id
       and a.status = 'active'
       and s.status = 'rejected'
     order by a.created_at, a.id
       for update of a
  loop
    update public.finance_payment_allocations
       set status          = 'reversed',
           reversal_reason = left(format('Moved to %s: %s was closed', v_ref, coalesce(v_old.draft_reference, 'the PI')), 500)
     where id = v_old.id
       and status = 'active';
    v_moved := v_moved + 1;
  end loop;

  update public.finance_payment_allocation_intents i
     set status           = 'cancelled',
         cancelled_at     = now(),
         cancelled_reason = left(format('Moved to %s: the PI it was meant for was closed', v_ref), 500)
    from public.order_submissions s
   where s.id = i.order_submission_id
     and s.status = 'rejected'
     and i.payment_request_id = p_payment_id
     and i.status = 'pending';

  -- What is left after the releases, still reserving any pending intent on an
  -- open target (approval will turn it into an allocation).
  v_free := public.payment_amount_free_for_reuse(p_payment_id);

  if v_free is null or v_free <= 0 then
    raise exception 'PAYMENT_NOTHING_AVAILABLE: payment % has no money left to use.', coalesce(v_pay.human_payment_id, v_pay.request_number)
      using errcode = 'P0001';
  end if;

  v_alloc := public.allocate_payment_to_target_internal(
    p_payment_request_id  => p_payment_id,
    p_order_submission_id => p_submission_id,
    p_order_id            => p_order_id,
    p_allocated_amount    => v_free
  );

  if p_submission_id is not null then
    perform public.log_order_submission_activity(
      p_submission_id, v_actor, 'payment_recorded', v_sub.status, v_sub.status, null,
      jsonb_build_object(
        'payment_request_id', p_payment_id,
        'request_number',     v_pay.request_number,
        'amount',             v_free,
        'payment_mode',       v_pay.payment_mode,
        'payment_status',     v_pay.status,
        'allocation_id',      v_alloc->>'allocation_id',
        'source',             'available_money',
        'released_from_closed_pis', v_moved
      )
    );
  end if;

  return jsonb_build_object(
    'payment_request_id', p_payment_id,
    'request_number',     v_pay.request_number,
    'payment_number',     coalesce(v_pay.human_payment_id, v_pay.request_number),
    'allocation_id',      v_alloc->>'allocation_id',
    'allocated_amount',   v_free,
    'status',             v_pay.status,
    'released_from_closed_pis', v_moved
  );
end;
$$;

revoke execute on function public.use_available_payment(uuid, uuid, uuid) from public, anon;
grant  execute on function public.use_available_payment(uuid, uuid, uuid) to authenticated;

comment on function public.use_available_payment(uuid, uuid, uuid) is
  'Use this money: moves one payment''s free money onto a PI or a Confirmed Order of the SAME client, through the same doors as the payment forms. Releases any allocation the payment still has on a closed PI (reason recorded), then allocates everything free via allocate_payment_to_target_internal. The payment keeps its ID and status (a verified payment stays verified). 20270506000000.';


-- ═══ 6. Assertions ═══════════════════════════════════════════════════════════

do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.reject_order_submission(uuid, text)',
    'public.client_available_payments(uuid, uuid, numeric, date)',
    'public.use_available_payment(uuid, uuid, uuid)',
    'public.payment_amount_free_for_reuse(uuid)'
  ] loop
    if not exists (
      select 1 from pg_proc p
       where p.oid = to_regprocedure(v_fn)
         and p.prosecdef
         and array_to_string(p.proconfig, ',') like '%search_path=public, pg_temp%'
    ) then
      raise exception '% must be SECURITY DEFINER with search_path = public, pg_temp', v_fn;
    end if;
    if has_function_privilege('anon', v_fn, 'execute') then
      raise exception '% must not be executable by anon', v_fn;
    end if;
  end loop;

  foreach v_fn in array array[
    'public.client_available_payments(uuid, uuid, numeric, date)',
    'public.use_available_payment(uuid, uuid, uuid)',
    'public.reject_order_submission(uuid, text)'
  ] loop
    if not has_function_privilege('authenticated', v_fn, 'execute') then
      raise exception '% must be executable by authenticated', v_fn;
    end if;
  end loop;

  foreach v_fn in array array[
    'public.payment_amount_free_for_reuse(uuid)',
    'public.client_name_key(text)'
  ] loop
    if has_function_privilege('authenticated', v_fn, 'execute') then
      raise exception '% is internal and must not be executable by authenticated', v_fn;
    end if;
  end loop;

  if public.client_name_key('  Sharma  Interiors. ') is distinct from 'sharmainteriors'
     or public.client_name_key('   ') is not null then
    raise exception 'client_name_key must keep letters and digits only, lower case, and give no key for a blank name';
  end if;

  if position('finance_payment_allocation_intents' in pg_get_functiondef(to_regprocedure('public.reject_order_submission(uuid, text)'))) = 0
     or position('reversal_reason' in pg_get_functiondef(to_regprocedure('public.reject_order_submission(uuid, text)'))) = 0 then
    raise exception 'reject_order_submission must release the PI''s allocations and cancel its pending intents';
  end if;
end $$;
