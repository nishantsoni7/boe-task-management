-- ═══════════════════════════════════════════════════════════════════════════
-- 20270417000000 — Accepting a cash handover never approves a payment
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE OWNER'S DECISION (2026-10-24): accepting custody of cash must NEVER mark a
-- Finance payment Confirmed. 20270416000000 (PR #441) made accept_cash_handover
-- call approve_finance_payment_request for every Pending payment in the handover
-- whenever the person accepting held Finance approve. In production that meant
-- Nishant (admin) as well as Nitish (the company cash custodian): an
-- employee-to-employee acceptance could confirm a payment whose cash had not
-- reached the company, and Nitish's acceptance skipped Finance's own checks
-- (proof, client, order/PI).
--
-- WHAT THIS DOES. Restores accept_cash_handover to its 20270413000000 body,
-- extracted verbatim (never retyped): custody events through the acceptance
-- marker, the cash-balance moves, the handover closing, its history event and
-- the notification, exactly as before 20270416000000. The only behaviour that
-- goes away is the automatic approval. A Pending payment stays Pending after
-- any acceptance; Finance confirms it through Verify Payment as always.
--
-- UNCHANGED. approve_finance_payment_request and every Finance decision path,
-- the payment lock (20270415000000), handover tables, custody history, grants
-- (restated below, identical), all payment rows. 20270416000000 stays in the
-- history as what was briefly live; it is not edited.
--
-- EXISTING ROWS. None change. Census 2026-10-24: no handover was accepted while
-- 20270416000000 was live (0 pending handovers; P-AA-0044 still Pending).
--
-- FUTURE (owner, Phase 3, not built here): Nitish's acceptance will be shown to
-- Finance as "cash received by the company"; Finance still verifies.
--
-- ROLLOUT: apply, then merge (no client code depends on either behaviour).
-- ROLLBACK (a new, later migration): re-emit the 20270416000000 body.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── accept_cash_handover, as 20270413000000 left it ──────────────────────────

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

-- ── Apply-time assertions — the migration refuses itself otherwise ──────────

do $$
declare
  v_accept text := pg_get_functiondef('public.accept_cash_handover(uuid)'::regprocedure);
begin
  if position('approve_finance_payment_request' in v_accept) > 0 then
    raise exception 'ASSERTION FAILED: accept_cash_handover still approves payments';
  end if;
  if v_accept not like '%append_payment_custody_events_internal%'
     or v_accept not like '%boe.cash_handover_accept%'
     or v_accept not like '%finance_cash_balance_entries%'
     or v_accept not like '%finance_cash_handover_events%'
     or v_accept not like '%finance_handover_accepted%'
     or v_accept not like '%HANDOVER_NOT_ALLOWED%' then
    raise exception 'ASSERTION FAILED: accept_cash_handover lost a custody step';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon')
     and has_function_privilege('anon', 'public.accept_cash_handover(uuid)', 'execute') then
    raise exception 'ASSERTION FAILED: anon may execute accept_cash_handover';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated')
     and not has_function_privilege('authenticated', 'public.accept_cash_handover(uuid)', 'execute') then
    raise exception 'ASSERTION FAILED: signed-in users can no longer accept a handover';
  end if;
  raise notice '20270417000000: accepting a cash handover records custody only; it never approves a payment';
end $$;
