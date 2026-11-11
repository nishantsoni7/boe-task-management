-- ═══════════════════════════════════════════════════════════════════════════
-- 20270612000000 — PNB, Paytm and Canara payments are Confirmed only when
-- their cash is WITH THE COMPANY
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE OWNER'S DECISION (2026-11-11): a payment that did not land in an HDFC
-- account must not go straight to Confirmed Payments. Its payer says who it was
-- handed to; when the company's cash custodian (Nitish today) accepts it, the
-- payment is Confirmed in that same action. This REVERSES the owner's rule of
-- 2026-10-24 ("accepting custody never approves a payment", 20270417000000)
-- for the company cash custodian only. Anybody else accepting still only moves
-- custody.
--
-- BEFORE. A PNB / Paytm / Canara payment could be verified by Finance (or by a
-- self-verifier on entry) whether or not its cash had reached the company; the
-- cash journey ran beside the verification and never gated it.
--
-- NOW.
--   1. A trigger refuses to turn a PNB / Paytm / Canara payment verified unless
--      its cash is with a company cash custodian (finance_payment_is_closed),
--      from ANY door and for ANY actor - the same shape as the HDFC bank-proof
--      rule (20270516000000). It also refuses switching an already-verified
--      payment to one of these modes while its cash is elsewhere. Test data is
--      exempt.
--   2. accept_cash_handover and receive_cash_directly, once they have put a
--      payment with the company, verify it through the ONE verification door
--      (approve_finance_payment_request, unchanged - it needs the custodian to
--      hold finance.approve, and it attaches the payment's allocations). Each
--      payment runs in its own sub-transaction: a refusal leaves that payment
--      Pending with a WARNING and never blocks the acceptance or its custody
--      events. The payment's submitter is told it is confirmed.
--   3. complete_payment_entry (a self-verifier's own entry) leaves these modes
--      Pending until the cash is with the company. A custodian recording a
--      payment they hold is already there, so theirs is verified on entry.
--
-- UNCHANGED. Tables, columns, grants (CREATE OR REPLACE keeps them),
-- approve_finance_payment_request, the payment lock (20270415000000), the HDFC
-- bank rule, custody history, handover statuses, "Not received" (final), the
-- order cash exception (20270414000000), notification types.
--
-- EXISTING ROWS. NONE CHANGES AT APPLY. A PNB / Paytm / Canara payment that is
-- already Confirmed stays Confirmed; one already Pending whose cash has already
-- reached the company stays Pending until Finance verifies it (it may be now).
-- Pulling already-Confirmed payments back to waiting is a SEPARATE change that
-- needs the owner's sign-off on the list first.
--
-- ROLLOUT: apply BEFORE or together with the code. Old screens keep working: a
-- Verify press on an unclosed PNB / Paytm / Canara payment is refused with
-- PAYMENT_NEEDS_COMPANY_CASH.
-- ROLLBACK (a new, later migration): drop trigger
-- finance_payment_requests_require_company_cash; re-emit accept_cash_handover and
-- receive_cash_directly from 20270418000000 and complete_payment_entry from
-- 20270516000000; the two helpers can stay.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
begin
  if to_regprocedure('public.approve_finance_payment_request(uuid, text)') is null
     or to_regprocedure('public.finance_payment_is_closed(uuid)') is null
     or to_regprocedure('public.payment_mode_requires_custody(text)') is null
     or to_regprocedure('public.finance_payment_status_is_verified(text)') is null
     or to_regprocedure('public.order_notify_users(uuid[], uuid, uuid, notification_type, text, text)') is null then
    raise exception 'DEPENDENCY MISSING: the verification door or the cash journey functions (20270413000000)';
  end if;
  if to_regprocedure('public.finance_payment_awaits_bank_match(uuid, text, numeric, boolean)') is null then
    raise exception 'DEPENDENCY MISSING: 20270516000000 (verified only against the bank) must be applied first';
  end if;
  if position('approve_finance_payment_request' in pg_get_functiondef('public.accept_cash_handover(uuid)'::regprocedure)) > 0 then
    raise exception 'UNEXPECTED: accept_cash_handover already approves payments; this migration restates it from 20270418000000';
  end if;
end $$;


-- ═══ §1. The rule ═══════════════════════════════════════════════════════════

-- True when this payment still has to reach the company: a PNB / Paytm / Canara
-- payment (real data) whose cash is not held by a company cash custodian.
create or replace function public.finance_payment_awaits_company_cash(
  p_payment_id uuid,
  p_mode       text,
  p_is_test    boolean
) returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select public.payment_mode_requires_custody(p_mode)
     and not coalesce(p_is_test, false)
     and not public.finance_payment_is_closed(p_payment_id)
$fn$;

comment on function public.finance_payment_awaits_company_cash(uuid, text, boolean) is
  'Whether a PNB / Paytm / Canara payment (real data) still has its cash with somebody who is not a company cash custodian. Internal. 20270612000000.';

revoke all on function public.finance_payment_awaits_company_cash(uuid, text, boolean) from public, anon, authenticated;

create or replace function public.finance_payment_requests_require_company_cash()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_was_verified boolean := public.finance_payment_status_is_verified(old.status);
  v_is_verified  boolean := public.finance_payment_status_is_verified(new.status);
begin
  if not v_is_verified then
    return new;
  end if;

  if not v_was_verified then
    if public.finance_payment_awaits_company_cash(new.id, new.payment_mode, new.is_test_data) then
      raise exception 'PAYMENT_NEEDS_COMPANY_CASH: payment % is not with the company yet', old.request_number
        using errcode = 'P0001';
    end if;
    return new;
  end if;

  -- Already verified: it may not be moved into one of these modes while its cash
  -- is elsewhere, unless it was already waiting before.
  if new.payment_mode is distinct from old.payment_mode
     and public.finance_payment_awaits_company_cash(new.id, new.payment_mode, new.is_test_data)
     and not public.finance_payment_awaits_company_cash(old.id, old.payment_mode, old.is_test_data) then
    raise exception 'PAYMENT_EDIT_NEEDS_COMPANY_CASH: this change would leave payment % verified with its cash not at the company', old.request_number
      using errcode = 'P0001';
  end if;
  return new;
end;
$fn$;

comment on function public.finance_payment_requests_require_company_cash() is
  'Refuses turning a PNB / Paytm / Canara payment verified while its cash is not with a company cash custodian, from any door and for any actor, and refuses moving a verified payment into those modes. 20270612000000.';

revoke all on function public.finance_payment_requests_require_company_cash() from public, anon, authenticated;

drop trigger if exists finance_payment_requests_require_company_cash on public.finance_payment_requests;
create trigger finance_payment_requests_require_company_cash
  before update of status, payment_mode on public.finance_payment_requests
  for each row
  when (new.status is distinct from old.status
        or new.payment_mode is distinct from old.payment_mode)
  execute function public.finance_payment_requests_require_company_cash();


-- ═══ §2. Confirming a payment the moment its cash reaches the company ═══════

-- Internal. Returns true when it confirmed the payment. Anything that stops it
-- (the actor lacks finance.approve, a converted order request, ...) leaves the
-- payment Pending with a WARNING and returns false, so the custody change that
-- called it always stands.
create or replace function public.finance_confirm_payment_on_company_receipt(
  p_payment_id uuid,
  p_note       text
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor  uuid := auth.uid();
  v_pay    record;
  v_result jsonb;
  v_status text;
begin
  select f.id, f.status, f.deleted_at, f.payment_mode, f.submitted_by, f.request_number,
         f.amount, f.client_name
    into v_pay from public.finance_payment_requests f where f.id = p_payment_id;
  if not found or v_pay.deleted_at is not null or v_pay.status <> 'pending_approval' then
    return false;
  end if;
  if not public.payment_mode_requires_custody(v_pay.payment_mode)
     or not public.finance_payment_is_closed(p_payment_id) then
    return false;
  end if;

  begin
    v_result := public.approve_finance_payment_request(p_payment_id, p_note);
  exception when others then
    raise warning 'payment % stays Pending after its cash reached the company (%): %',
      coalesce(v_pay.request_number, p_payment_id::text), sqlstate, sqlerrm;
    return false;
  end;

  v_status := v_result ->> 'status';
  perform public.order_notify_users(
    array[v_pay.submitted_by], v_actor, p_payment_id,
    (case when v_status = 'approved_linked' then 'finance_approved_linked'
          else 'finance_approved_suspense' end)::notification_type,
    format('Payment %s (₹%s) is confirmed: its cash reached the company.',
           v_pay.request_number, to_char(v_pay.amount, 'FM999999999990.00')),
    v_pay.client_name);
  return true;
end;
$fn$;

comment on function public.finance_confirm_payment_on_company_receipt(uuid, text) is
  'Verifies a Pending PNB / Paytm / Canara payment whose cash is now with a company cash custodian, through approve_finance_payment_request, and tells its submitter. Never raises. Internal. 20270612000000.';

revoke all on function public.finance_confirm_payment_on_company_receipt(uuid, text) from public, anon, authenticated;

-- ═══ §4. accept_cash_handover: the custodian's acceptance confirms ═══════════
-- Restated from 20270418000000 (extracted by script) with ONE insertion, marked NEW.

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
  if v_h.status <> 'pending' then
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

  -- NEW (20270612000000): a payment this acceptance puts WITH THE COMPANY (the
  -- recipient is a company cash custodian) is CONFIRMED in this same action,
  -- through the one verification door. Anybody else accepting only moves custody.
  for v_item in
    select i.payment_request_id from public.finance_cash_handover_items i
     where i.handover_id = v_h.id order by i.payment_request_id
  loop
    perform public.finance_confirm_payment_on_company_receipt(
      v_item.payment_request_id,
      'Confirmed when handover ' || v_h.human_id || ' was accepted by the company');
  end loop;


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

-- ═══ §5. receive_cash_directly: the custodian's receipt confirms ═════════════
-- Restated from 20270418000000 (extracted by script) with ONE insertion, marked NEW.

create or replace function public.receive_cash_directly(p_payment_ids uuid[], p_note text default null)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  uuid := auth.uid();
  v_note   text := nullif(btrim(coalesce(p_note, '')), '');
  v_ids    uuid[];
  v_id     uuid;
  v_pay    record;
  v_holder uuid;
  v_h      record;
  v_name   text;
  v_count  integer := 0;
begin
  if v_actor is null or not exists (
    select 1 from public.users u where u.id = v_actor and u.is_active and coalesce(u.is_deleted, false) = false
  ) or not public.finance_is_cash_custodian(v_actor) then
    raise exception 'HANDOVER_NOT_ALLOWED: only the person who receives cash for the company can do this.'
      using errcode = '42501';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'HANDOVER_NOTE_TOO_LONG: keep the note under 500 characters.' using errcode = 'P0001';
  end if;

  select coalesce(array_agg(distinct x order by x), '{}') into v_ids
    from unnest(coalesce(p_payment_ids, '{}'::uuid[])) as x;
  if coalesce(array_length(v_ids, 1), 0) = 0 then
    raise exception 'HANDOVER_PAYMENTS_REQUIRED: choose at least one payment.' using errcode = 'P0001';
  end if;
  if array_length(v_ids, 1) > 50 then
    raise exception 'HANDOVER_TOO_MANY: at most 50 payments at once.' using errcode = 'P0001';
  end if;

  select u.full_name into v_name from public.users u where u.id = v_actor;

  foreach v_id in array v_ids loop
    select f.id, f.status, f.payment_mode, f.deleted_at, f.human_payment_id
      into v_pay from public.finance_payment_requests f where f.id = v_id for update;
    if not found then
      raise exception 'HANDOVER_PAYMENT_INVALID: a chosen payment no longer exists.' using errcode = 'P0002';
    end if;
    if v_pay.deleted_at is not null or v_pay.status = 'rejected' then
      raise exception 'HANDOVER_PAYMENT_INVALID: payment % is deleted or rejected.', coalesce(v_pay.human_payment_id, '') using errcode = 'P0001';
    end if;
    if not public.payment_mode_requires_custody(v_pay.payment_mode) then
      raise exception 'HANDOVER_PAYMENT_INVALID: payment % went to an HDFC account; there is no cash to receive.', coalesce(v_pay.human_payment_id, '') using errcode = 'P0001';
    end if;
    if public.finance_payment_is_closed(v_id) then
      raise exception 'HANDOVER_ALREADY_CLOSED: payment % is already with the company.', coalesce(v_pay.human_payment_id, '') using errcode = 'P0001';
    end if;

    -- Any open handover carrying this payment is superseded: the cash is here.
    for v_h in
      select h.* from public.finance_cash_handovers h
        join public.finance_cash_handover_items i on i.handover_id = h.id
       where i.payment_request_id = v_id and h.status = 'pending'
       for update of h
    loop
      update public.finance_cash_handovers
         set status = 'cancelled', cancelled_at = now(), cancelled_by = v_actor,
             cancel_reason = 'Received directly by ' || coalesce(v_name, 'the company')
       where id = v_h.id;
      insert into public.finance_cash_handover_events (handover_id, event_type, actor_id, note)
      values (v_h.id, 'cancelled', v_actor, 'Received directly by ' || coalesce(v_name, 'the company'));
      perform public.order_notify_users(
        array[v_h.giver_user_id, v_h.recipient_user_id], v_actor, v_h.id,
        'finance_handover_cancelled'::notification_type,
        'Cash handover closed',
        coalesce(v_name, 'The company') || ' received the cash directly, so handover ' || v_h.human_id || ' is closed.');
    end loop;

    v_holder := public.finance_payment_current_holder(v_id);

    perform set_config('boe.cash_handover_accept', 'on', true);
    perform public.append_payment_custody_events_internal(
      v_id,
      jsonb_build_array(jsonb_build_object(
        'key',           'receive:' || v_id::text || ':' || coalesce(v_holder::text, 'none'),
        'activity_type', 'handed_over',
        'occurred_at',   to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'handed_by',     v_holder::text,
        'handed_to',     v_actor::text,
        'remark',        'Received directly by ' || coalesce(v_name, 'the company') || coalesce(' - ' || v_note, ''))),
      v_actor);
    perform set_config('boe.cash_handover_accept', 'off', true);

    -- NEW (20270612000000): the cash is with the company now, so the payment is confirmed.
    perform public.finance_confirm_payment_on_company_receipt(
      v_id, 'Confirmed when ' || coalesce(v_name, 'the company') || ' received the cash');


    if v_holder is not null and v_holder <> v_actor then
      perform public.order_notify_users(
        array[v_holder], v_actor, null, 'finance_handover_accepted'::notification_type,
        'Cash received by the company',
        coalesce(v_name, 'The company') || ' recorded receiving payment ' || coalesce(v_pay.human_payment_id, '') || ' from you.');
    end if;
    v_count := v_count + 1;
  end loop;

  return v_count;
end $$;

-- ═══ §6. A self-verifier's entry waits for the cash like everybody else's ═════
-- Restated from 20270516000000 (extracted by script) with ONE insertion, marked NEW.
-- Grants are unchanged (CREATE OR REPLACE keeps them).

create or replace function public.complete_payment_entry(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor    uuid := auth.uid();
  v_id       uuid := p_request_id;
  v_req      public.finance_payment_requests%rowtype;
  v_decision jsonb;
  v_status   text;
  v_name     text;
begin
  if v_actor is null then
    raise exception 'Authentication required to complete a payment entry' using errcode = '28000';
  end if;

  -- Only the caller's own payment; anything else is not theirs to ask about.
  select * into v_req from public.finance_payment_requests where id = v_id;
  if not found or v_req.submitted_by is distinct from v_actor then
    raise exception 'Payment request % not found', v_id using errcode = 'P0002';
  end if;

  -- Not a holder, or no longer pending: nothing to do, and no error.
  if v_req.status <> 'pending_approval'
     or not public.user_has_module_permission(v_actor, 'finance', 'verify_own_payment') then
    return jsonb_build_object('payment_request_id', v_id, 'request_number', v_req.request_number,
                              'status', v_req.status, 'verified_on_entry', false);
  end if;

  -- An HDFC payment waits for its bank credit, whoever recorded it.
  if public.finance_payment_awaits_bank_match(v_id, v_req.payment_mode, v_req.amount, v_req.is_test_data) then
    return jsonb_build_object('payment_request_id', v_id, 'request_number', v_req.request_number,
                              'status', v_req.status, 'verified_on_entry', false, 'waiting_for_bank', true);
  end if;

  -- A PNB, Paytm or Canara payment waits until its cash is with the company
  -- (20270612000000), whoever recorded it. A custodian's own entry is already there.
  if public.finance_payment_awaits_company_cash(v_id, v_req.payment_mode, v_req.is_test_data) then
    return jsonb_build_object('payment_request_id', v_id, 'request_number', v_req.request_number,
                              'status', v_req.status, 'verified_on_entry', false, 'waiting_for_cash', true);
  end if;

  -- THE ONE VERIFICATION DOOR, unchanged: finance.approve, the row lock,
  -- pending only, the Order link, the allocation intents, approved_by and
  -- approved_at, and the activity entry under this person's own id. Anything
  -- it refuses rolls the whole entry back with it.
  v_decision := public.approve_finance_payment_request(v_id, null);
  v_status   := v_decision ->> 'status';

  -- The other Admins hear about it, for information only. The payment is
  -- already verified, so the record it opens offers no decision.
  select nullif(btrim(u.full_name), '') into v_name from public.users u where u.id = v_actor;

  insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
  select a.id, null, v_id,
         (case when v_status = 'approved_linked' then 'finance_approved_linked'
               else 'finance_approved_suspense' end)::notification_type,
         format('For your information: %s recorded and verified payment %s (₹%s). No action is needed.',
                coalesce(v_name, 'An Admin'), v_req.request_number,
                to_char(v_req.amount, 'FM999999999990.00')),
         v_req.client_name,
         true
    from public.users a
   where a.id <> v_actor
     and public.user_has_module_permission(a.id, 'finance', 'verify_own_payment');

  return jsonb_build_object(
    'payment_request_id', v_id,
    'request_number',     v_req.request_number,
    'status',             v_status,
    'verified_on_entry',  true,
    'verified_by',        v_actor,
    'verified_at',        v_decision -> 'approved_at');
end;
$fn$;

-- ═══ Apply-time assertions - the migration refuses itself otherwise ═════════

do $assert$
declare
  v_def text;
  f     text;
begin
  foreach f in array array[
    'public.finance_payment_awaits_company_cash(uuid, text, boolean)',
    'public.finance_payment_requests_require_company_cash()',
    'public.finance_confirm_payment_on_company_receipt(uuid, text)'
  ] loop
    if exists (select 1 from pg_roles where rolname = 'anon')
       and has_function_privilege('anon', f, 'execute') then
      raise exception '% must not be executable by anon', f;
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated')
       and has_function_privilege('authenticated', f, 'execute') then
      raise exception '% is an internal helper and must not be client-callable', f;
    end if;
  end loop;

  foreach f in array array[
    'public.accept_cash_handover(uuid)',
    'public.receive_cash_directly(uuid[], text)',
    'public.complete_payment_entry(uuid)'
  ] loop
    if exists (select 1 from pg_roles where rolname = 'anon')
       and has_function_privilege('anon', f, 'execute') then
      raise exception '% must not be executable by anon', f;
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated')
       and not has_function_privilege('authenticated', f, 'execute') then
      raise exception '% must stay executable by authenticated', f;
    end if;
  end loop;

  foreach f in array array['public.accept_cash_handover(uuid)', 'public.receive_cash_directly(uuid[], text)'] loop
    v_def := pg_get_functiondef(f::regprocedure);
    if position('finance_confirm_payment_on_company_receipt' in v_def) = 0 then
      raise exception '% does not confirm the payment', f;
    end if;
    if position('''pending'', ''disputed''' in v_def) > 0 then
      raise exception '% treats a not-received handover as open again', f;
    end if;
  end loop;

  v_def := pg_get_functiondef('public.complete_payment_entry(uuid)'::regprocedure);
  if position('waiting_for_cash' in v_def) = 0 or position('finance_payment_awaits_bank_match' in v_def) = 0 then
    raise exception 'complete_payment_entry lost the cash wait or the bank wait';
  end if;

  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.finance_payment_requests'::regclass
                    and tgname = 'finance_payment_requests_require_company_cash'
                    and not tgisinternal) then
    raise exception 'the company cash trigger is missing';
  end if;
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.finance_payment_requests'::regclass
                    and tgname = 'finance_payment_requests_require_bank_proof'
                    and not tgisinternal) then
    raise exception 'the bank proof trigger went missing';
  end if;

  raise notice '20270612000000: PNB, Paytm and Canara payments are Confirmed when their cash is with the company';
end
$assert$;
