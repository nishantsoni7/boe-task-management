-- ═══════════════════════════════════════════════════════════════════════════
-- Accepting a cash handover CONFIRMS the payments in it
-- ═══════════════════════════════════════════════════════════════════════════
--
-- OWNER REQUEST, 2026-10-24 (P-AA-0044, handover H-0001): after the recipient
-- accepted the cash, the payment page still asked for the payment to be verified
-- again. Receiving the cash IS the verification, so accepting now confirms it.
--
-- WHAT CHANGES. accept_cash_handover (restated from 20270413000000) also calls
-- approve_finance_payment_request - the one door Finance uses, with all its
-- checks and allocation intents - for every payment in the handover that is
-- still Pending, in the same transaction, when and ONLY when the person
-- accepting holds the Finance approve permission. Each payment runs in its own
-- sub-transaction: a refusal (the recipient recorded the payment themselves,
-- a converted order request, ...) leaves that payment Pending with a WARNING
-- and never blocks the acceptance or the custody events.
--
-- A recipient WITHOUT Finance approve still records custody; the payment stays
-- Pending for a verifier, exactly as before.
--
-- NOT TOUCHED: the lock (20270415000000), approve_finance_payment_request,
-- handover tables, custody events, cash balance, notifications. Payments that
-- were accepted BEFORE this migration and are still Pending (P-AA-0044) are NOT
-- bulk-confirmed - nobody confirmed them; a verifier does it once from the page.
-- The lock already lets the verification through (decision columns only).

do $$
begin
  if to_regprocedure('public.approve_finance_payment_request(uuid, text)') is null then
    raise exception 'DEPENDENCY MISSING: approve_finance_payment_request(uuid, text)';
  end if;
  if to_regprocedure('public.actor_has_module_permission(text, text)') is null then
    raise exception 'DEPENDENCY MISSING: actor_has_module_permission(text, text)';
  end if;
  if to_regprocedure('public.finance_payment_cash_locks(uuid[])') is null then
    raise exception 'DEPENDENCY MISSING: 20270415000000 (the cash handover lock) must be applied first';
  end if;
end $$;

-- ─── 1. accept_cash_handover: confirmation ──────────────────────────────────
-- Restated from 20270413000000 with ONE addition, marked NEW.

create or replace function public.accept_cash_handover(p_handover_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_h     public.finance_cash_handovers%rowtype;
  v_item  record;
  v_name  text;
begin
  if v_actor is null or not exists (
    select 1 from public.users u where u.id = v_actor and u.is_active and coalesce(u.is_deleted, false) = false
  ) then
    raise exception 'HANDOVER_NOT_ALLOWED: sign in with an active account.' using errcode = '42501';
  end if;

  select * into v_h from public.finance_cash_handovers where id = p_handover_id for update;
  if not found then
    raise exception 'HANDOVER_NOT_FOUND: that handover does not exist.' using errcode = 'P0002';
  end if;
  if v_h.recipient_user_id <> v_actor then
    raise exception 'HANDOVER_NOT_ALLOWED: only the person it was handed to can accept it.' using errcode = '42501';
  end if;
  if v_h.status not in ('pending', 'disputed') then
    raise exception 'HANDOVER_CLOSED: this handover is already %.', v_h.status using errcode = 'P0001';
  end if;

  -- Custody history: one idempotent "handed over" per payment, keyed by the item.
  -- The marker lets append_payment_custody_events_internal accept handed_over.
  perform set_config('boe.cash_handover_accept', 'on', true);
  for v_item in
    select i.id as item_id, i.payment_request_id from public.finance_cash_handover_items i
     where i.handover_id = v_h.id order by i.payment_request_id
  loop
    perform public.append_payment_custody_events_internal(
      v_item.payment_request_id,
      jsonb_build_array(jsonb_build_object(
        'key',           'handover:' || v_item.item_id::text,
        'activity_type', 'handed_over',
        'occurred_at',   to_char(least(v_h.handed_at, now()) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'handed_by',     v_h.giver_user_id::text,
        'handed_to',     v_h.recipient_user_id::text,
        'remark',        'Handover ' || v_h.human_id || ' (accepted)' || coalesce(' - ' || v_h.note, ''))),
      v_actor);
  end loop;

  perform set_config('boe.cash_handover_accept', 'off', true);

  -- NEW: acceptance confirms the payments, by the same door Finance uses, when
  -- the person accepting holds the approve permission. Each payment in its own
  -- sub-transaction: a refusal (own payment, converted order request, ...) leaves
  -- that payment Pending and never blocks the acceptance.
  if public.actor_has_module_permission('finance', 'approve') then
    for v_item in
      select i.payment_request_id
        from public.finance_cash_handover_items i
        join public.finance_payment_requests p on p.id = i.payment_request_id
       where i.handover_id = v_h.id
         and p.status = 'pending_approval'
         and p.deleted_at is null
       order by i.payment_request_id
    loop
      begin
        perform public.approve_finance_payment_request(
          v_item.payment_request_id,
          'Confirmed when handover ' || v_h.human_id || ' was accepted');
      exception when others then
        raise warning 'accept_cash_handover %: payment % stays Pending (%)',
          v_h.human_id, v_item.payment_request_id, sqlerrm;
      end;
    end loop;
  end if;

  -- Cash in hand. Both people's locks, lower id first, so two accepts between
  -- the same pair can never deadlock. The giver's amount was reserved at create.
  if v_h.cash_from_hand > 0 or v_h.cash_new > 0 then
    perform public.finance_cash_lock(least(v_h.giver_user_id, v_h.recipient_user_id));
    perform public.finance_cash_lock(greatest(v_h.giver_user_id, v_h.recipient_user_id));

    if v_h.cash_from_hand > 0 then
      insert into public.finance_cash_balance_entries (user_id, delta, kind, handover_id, created_by)
      values (v_h.giver_user_id, -v_h.cash_from_hand, 'handover_out', v_h.id, v_actor)
      on conflict do nothing;
      insert into public.finance_cash_balance_entries (user_id, delta, kind, handover_id, created_by)
      values (v_h.recipient_user_id, v_h.cash_from_hand, 'handover_in', v_h.id, v_actor)
      on conflict do nothing;
    end if;
    if v_h.cash_new > 0 then
      insert into public.finance_cash_balance_entries (user_id, delta, kind, handover_id, note, created_by)
      values (v_h.recipient_user_id, v_h.cash_new, 'new_cash', v_h.id, v_h.cash_new_source, v_actor)
      on conflict do nothing;
    end if;
  end if;

  update public.finance_cash_handovers
     set status = 'accepted', accepted_at = now()
   where id = v_h.id;

  insert into public.finance_cash_handover_events (handover_id, event_type, actor_id)
  values (v_h.id, 'accepted', v_actor);

  select u.full_name into v_name from public.users u where u.id = v_actor;
  perform public.order_notify_users(
    array[v_h.giver_user_id], v_actor, v_h.id, 'finance_handover_accepted'::notification_type,
    'Cash handover accepted',
    coalesce(v_name, 'The recipient') || ' accepted your handover of '
      || public.finance_handover_money(v_h.total_amount) || ' (' || v_h.human_id || ').');
end $$;

revoke all on function public.accept_cash_handover(uuid) from public, anon;
grant execute on function public.accept_cash_handover(uuid) to authenticated;

revoke all on function public.accept_cash_handover(uuid) from public, anon;
grant execute on function public.accept_cash_handover(uuid) to authenticated;

-- ─── 2. Assertions ───────────────────────────────────────────────────────────

do $$
declare
  v_accept text := pg_get_functiondef('public.accept_cash_handover(uuid)'::regprocedure);
begin
  if v_accept not like '%approve_finance_payment_request%'
     or v_accept not like '%actor_has_module_permission%'
     or v_accept not like '%boe.cash_handover_accept%'
     or v_accept not like '%finance_cash_balance_entries%'
     or v_accept not like '%finance_handover_accepted%' then
    raise exception 'ASSERTION FAILED: accept_cash_handover lost a step or does not confirm';
  end if;
  if has_function_privilege('anon', 'public.accept_cash_handover(uuid)', 'execute') then
    raise exception 'ASSERTION FAILED: anon may execute accept_cash_handover';
  end if;
  raise notice '20270416000000 applied: accepting a handover confirms its payments.';
end $$;
